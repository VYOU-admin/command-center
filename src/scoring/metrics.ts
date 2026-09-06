/**
 * Wallet scoring: seven metrics, weighted, normalised across the cohort.
 *
 * MIN-MAX, NOT RANK, AND DELIBERATELY SO. A rank transform would compress the
 * distance between the best wallet and the second-best to the same step as
 * every other adjacent pair. The point of this score is to let outliers
 * dominate: a wallet that made fifty times what the next one made should look
 * fifty times better on that metric, not one place better.
 *
 * THE POPULATION FOR EVERY MIN-MAX IS THE COHORT. Not all wallets in the token,
 * not all wallets everywhere -- the cohort selected by the window.
 *
 * THE WINDOW SELECTS WHO IS SCORED. EVERY METRIC THEN RUNS OVER THE WALLET'S
 * FULL HISTORY IN THE TOKEN, except metric 3, which is explicitly about the
 * first buy inside the window.
 *
 * A NULL IS NEVER A ZERO. A wallet with no priced rows has no PnL -- that is
 * not a PnL of nothing. Nulls drop out of the weighted sum and the remaining
 * weights are renormalised, so a wallet is never punished for a metric that
 * could not be computed, and the count of nulls per metric is reported.
 */

export const WEIGHTS = {
  pnlUsd: 0.30,
  pnlPct: 0.20,
  buyCount: 0.05,
  earliness: 0.125,
  holdTime: 0.125,
  prePumpShare: 0.05,
  buySizeTrend: 0.05,
  totalUsdIn: 0.10,
} as const;

export type MetricName = keyof typeof WEIGHTS;

export const METRIC_ORDER: MetricName[] = [
  'pnlUsd',
  'pnlPct',
  'buyCount',
  'earliness',
  'holdTime',
  'prePumpShare',
  'buySizeTrend',
  'totalUsdIn',
];

/** Metrics that are min-max normalised across the cohort. */
const MINMAX: ReadonlySet<MetricName> = new Set<MetricName>([
  'pnlUsd',
  'pnlPct',
  'buyCount',
  'holdTime',
  'totalUsdIn',
]);
/*
 * The other three arrive already on 0..1 by construction -- earliness is a
 * position within the window, and the two pump metrics are shares -- so
 * min-maxing them again would stretch whatever range this particular cohort
 * happens to occupy and make the number mean something different per token.
 */

export interface Trade {
  wallet: string;
  side: 'buy' | 'sell' | 'transfer_in' | 'transfer_out';
  /** Seconds since the epoch. */
  ts: number;
  tokenAmount: number;
  /** Null when the trade could not be priced. Never substituted with zero. */
  usd: number | null;
}

export interface ScoringInputs {
  trades: Trade[];
  cohort: string[];
  /** Window the cohort was selected by, in seconds. */
  windowStart: number;
  windowEnd: number;
  /** Pump points, in seconds. */
  pumps: number[];
  /** The token's first observed trade, the "inception" metric 6 weights from. */
  inception: number;
  /** Latest USD price, for valuing what a wallet still holds. Null if unknown. */
  currentPrice: number | null;
  /** Evaluation time in seconds, for a wallet that has never sold. */
  now: number;
}

export interface RawMetrics {
  pnlUsd: number | null;
  pnlPct: number | null;
  buyCount: number | null;
  earliness: number | null;
  holdTime: number | null;
  prePumpShare: number | null;
  buySizeTrend: number | null;
  totalUsdIn: number | null;
}

export interface WalletFacts {
  wallet: string;
  buys: number;
  sells: number;
  usdIn: number | null;
  usdOut: number | null;
  tokensIn: number;
  tokensOut: number;
  position: number;
  unpricedRows: number;
  pricedRows: number;
  /** Share of tokens acquired by transfer rather than by buying. */
  transferInShare: number;
  firstBuyTs: number | null;
  firstBuyInWindowTs: number | null;
  lastSellTs: number | null;
  raw: RawMetrics;
}

const PRE_PUMP_SECONDS = 48 * 3600;

/** Per-wallet facts and unnormalised metrics. Pure; no database, no clock. */
export function computeFacts(input: ScoringInputs): Map<string, WalletFacts> {
  const byWallet = new Map<string, Trade[]>();
  for (const t of input.trades) {
    const list = byWallet.get(t.wallet);
    if (list) list.push(t);
    else byWallet.set(t.wallet, [t]);
  }

  const out = new Map<string, WalletFacts>();
  for (const wallet of input.cohort) {
    const trades = (byWallet.get(wallet) ?? []).slice().sort((a, b) => a.ts - b.ts);
    const buys = trades.filter((t) => t.side === 'buy');
    const sells = trades.filter((t) => t.side === 'sell');
    const transfersIn = trades.filter((t) => t.side === 'transfer_in');
    const transfersOut = trades.filter((t) => t.side === 'transfer_out');

    const pricedBuys = buys.filter((t) => t.usd !== null);
    const pricedSells = sells.filter((t) => t.usd !== null);
    const unpricedRows = trades.filter((t) => t.usd === null).length;
    const pricedRows = trades.length - unpricedRows;

    /*
     * Unpriced rows leave BOTH sides of every ratio. Keeping their tokens in a
     * denominator while their dollars are absent understates exactly the
     * wallets whose data is weakest.
     */
    const usdIn = pricedBuys.length ? pricedBuys.reduce((s, t) => s + (t.usd ?? 0), 0) : null;
    const usdOut = pricedSells.length ? pricedSells.reduce((s, t) => s + (t.usd ?? 0), 0) : null;

    const tokensIn =
      buys.reduce((s, t) => s + t.tokenAmount, 0) +
      transfersIn.reduce((s, t) => s + t.tokenAmount, 0);
    const tokensOut =
      sells.reduce((s, t) => s + t.tokenAmount, 0) +
      transfersOut.reduce((s, t) => s + t.tokenAmount, 0);
    const position = tokensIn - tokensOut;

    const transferInTokens = transfersIn.reduce((s, t) => s + t.tokenAmount, 0);
    const transferInShare = tokensIn > 0 ? transferInTokens / tokensIn : 0;

    const firstBuyTs = buys.length ? buys[0]!.ts : null;
    const inWindow = buys.filter((t) => t.ts >= input.windowStart && t.ts <= input.windowEnd);
    const firstBuyInWindowTs = inWindow.length ? inWindow[0]!.ts : null;
    const lastSellTs = sells.length ? sells[sells.length - 1]!.ts : null;

    /* --- 1a. PnL in dollars -------------------------------------------- */
    let pnlUsd: number | null = null;
    if (usdIn !== null) {
      // Realised plus what is still held. A wallet that has not sold has not
      // lost; a wallet holding a position has a value even without a sale.
      const held = position > 0 && input.currentPrice !== null ? position * input.currentPrice : 0;
      const realised = usdOut ?? 0;
      if (position > 0 && input.currentPrice === null) {
        // The position cannot be valued, so the PnL cannot be stated. Reporting
        // the realised part alone would understate a holder as a loss.
        pnlUsd = null;
      } else {
        pnlUsd = realised + held - usdIn;
      }
    }

    /* --- 1b. PnL as a fraction of dollars put in ------------------------ */
    const pnlPct = pnlUsd !== null && usdIn !== null && usdIn > 0 ? pnlUsd / usdIn : null;

    /* --- 2. how many times they bought --------------------------------- */
    const buyCount = buys.length > 0 ? buys.length : null;

    /* --- 3. how early in the window the first buy landed ---------------- */
    let earliness: number | null = null;
    if (firstBuyInWindowTs !== null && input.windowEnd > input.windowStart) {
      // 1.0 at the window's first instant, 0.0 at its last. Linear.
      earliness =
        (input.windowEnd - firstBuyInWindowTs) / (input.windowEnd - input.windowStart);
    }

    /* --- 4. how long they held ------------------------------------------ */
    let holdTime: number | null = null;
    if (firstBuyTs !== null) {
      const end = lastSellTs ?? input.now;
      holdTime = Math.max(0, end - firstBuyTs);
    }

    /* --- 5. how much they bought in the 48h before each pump ------------ */
    let prePumpShare: number | null = null;
    if (usdIn !== null && usdIn > 0 && input.pumps.length > 0) {
      const shares = input.pumps.map((pump) => {
        const inWindowUsd = pricedBuys
          .filter((t) => t.ts >= pump - PRE_PUMP_SECONDS && t.ts < pump)
          .reduce((s, t) => s + (t.usd ?? 0), 0);
        return inWindowUsd / usdIn;
      });
      prePumpShare = shares.reduce((s, x) => s + x, 0) / shares.length;
    }

    /* --- 6. whether the buying grew as each pump approached ------------- */
    let buySizeTrend: number | null = null;
    if (pricedBuys.length > 0 && input.pumps.length > 0) {
      const perPump: number[] = [];
      for (const pump of input.pumps) {
        /*
         * THE DENOMINATOR SHIFTS PER PUMP. For the second pump this weighs
         * every buy from inception to that pump, including buys made after the
         * first pump -- so the same buy contributes a different amount to each
         * pump's figure.
         */
        const span = pump - input.inception;
        if (span <= 0) continue;
        const upTo = pricedBuys.filter((t) => t.ts <= pump && t.ts >= input.inception);
        const total = upTo.reduce((s, t) => s + (t.usd ?? 0), 0);
        if (total <= 0) continue;
        let sum = 0;
        for (const t of upTo) {
          const closeness = (t.ts - input.inception) / span; // 0 at inception, 1 at the pump
          sum += ((t.usd ?? 0) / total) * closeness;
        }
        perPump.push(sum);
      }
      buySizeTrend = perPump.length
        ? perPump.reduce((s, x) => s + x, 0) / perPump.length
        : null;
    }

    /* --- 7. total dollars in -------------------------------------------- */
    const totalUsdIn = usdIn;

    out.set(wallet, {
      wallet,
      buys: buys.length,
      sells: sells.length,
      usdIn,
      usdOut,
      tokensIn,
      tokensOut,
      position,
      unpricedRows,
      pricedRows,
      transferInShare,
      firstBuyTs,
      firstBuyInWindowTs,
      lastSellTs,
      raw: {
        pnlUsd,
        pnlPct,
        buyCount,
        earliness,
        holdTime,
        prePumpShare,
        buySizeTrend,
        totalUsdIn,
      },
    });
  }
  return out;
}

export interface MetricSummary {
  metric: MetricName;
  weight: number;
  normalised: 'min-max' | 'already 0..1';
  present: number;
  nullCount: number;
  min: number | null;
  max: number | null;
  degenerate: boolean;
}

export interface ScoredWallet {
  wallet: string;
  /** Null when every metric was null for this wallet. */
  score: number | null;
  normalised: Record<MetricName, number | null>;
  raw: RawMetrics;
  /** Sum of the weights that actually contributed. */
  weightUsed: number;
}

export interface ScoringResult {
  wallets: ScoredWallet[];
  summaries: MetricSummary[];
  /** Wallets in the cohort with no rows at all. */
  walletsWithNoRows: number;
}

/**
 * Normalise and combine.
 *
 * A metric that is null for a wallet is DROPPED from that wallet's weighted
 * sum, and the divisor is the weight that actually contributed. Scoring a null
 * as zero would rank a wallet whose data is missing below one that genuinely
 * did nothing, which is a different claim and a false one.
 *
 * A metric whose range is degenerate across the cohort -- every wallet equal --
 * distinguishes nothing, so it is dropped for everyone and reported, rather
 * than dividing by a zero range.
 */
export function score(
  facts: Map<string, WalletFacts>,
  cohort: string[],
): ScoringResult {
  const summaries: MetricSummary[] = [];
  const ranges = new Map<MetricName, { min: number; max: number } | null>();

  for (const metric of METRIC_ORDER) {
    const values = cohort
      .map((w) => facts.get(w)?.raw[metric])
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    const min = values.length ? Math.min(...values) : null;
    const max = values.length ? Math.max(...values) : null;
    const degenerate = min === null || max === null || max === min;
    ranges.set(metric, degenerate || min === null || max === null ? null : { min, max });
    summaries.push({
      metric,
      weight: WEIGHTS[metric],
      normalised: MINMAX.has(metric) ? 'min-max' : 'already 0..1',
      present: values.length,
      nullCount: cohort.length - values.length,
      min,
      max,
      degenerate,
    });
  }

  const wallets: ScoredWallet[] = [];
  let walletsWithNoRows = 0;

  for (const wallet of cohort) {
    const f = facts.get(wallet);
    if (!f) {
      walletsWithNoRows += 1;
      wallets.push({
        wallet,
        score: null,
        normalised: blankNormalised(),
        raw: blankRaw(),
        weightUsed: 0,
      });
      continue;
    }
    if (f.buys === 0 && f.sells === 0) walletsWithNoRows += 1;

    const normalised = blankNormalised();
    let weighted = 0;
    let weightUsed = 0;

    for (const metric of METRIC_ORDER) {
      const value = f.raw[metric];
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;

      let n: number;
      if (MINMAX.has(metric)) {
        const range = ranges.get(metric);
        if (!range) continue; // degenerate across the cohort: carries no signal
        n = (value - range.min) / (range.max - range.min);
      } else {
        n = Math.min(1, Math.max(0, value));
      }
      normalised[metric] = n;
      weighted += WEIGHTS[metric] * n;
      weightUsed += WEIGHTS[metric];
    }

    wallets.push({
      wallet,
      score: weightUsed > 0 ? weighted / weightUsed : null,
      normalised,
      raw: f.raw,
      weightUsed,
    });
  }

  return { wallets, summaries, walletsWithNoRows };
}

function blankNormalised(): Record<MetricName, number | null> {
  return Object.fromEntries(METRIC_ORDER.map((m) => [m, null])) as Record<
    MetricName,
    number | null
  >;
}

function blankRaw(): RawMetrics {
  return {
    pnlUsd: null,
    pnlPct: null,
    buyCount: null,
    earliness: null,
    holdTime: null,
    prePumpShare: null,
    buySizeTrend: null,
    totalUsdIn: null,
  };
}

/** Percentiles for a reported distribution. Null-safe and explicit. */
export function distribution(values: number[]): Record<string, number | null> {
  if (values.length === 0) {
    return { n: 0, min: null, p10: null, p25: null, median: null, p75: null, p90: null, p99: null, max: null };
  }
  const s = [...values].sort((a, b) => a - b);
  const at = (q: number): number => s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
  return {
    n: s.length,
    min: s[0]!,
    p10: at(0.1),
    p25: at(0.25),
    median: at(0.5),
    p75: at(0.75),
    p90: at(0.9),
    p99: at(0.99),
    max: s[s.length - 1]!,
  };
}

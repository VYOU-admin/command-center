/**
 * The launch alert: buys only, filtered by TOKEN AGE.
 *
 * A SECOND MESSAGE TO THE SAME CHANNEL ON THE SAME RUN, not a replacement. The first
 * alert ranks whatever the watchlist touched; this one asks a different question of
 * the same slice: WHICH TOKENS THAT LAUNCHED IN THE LAST HOUR DID THEY BUY?
 *
 * IT REPLACED A MARKET-CAP FILTER, AND THE REASON IS THE POINT OF THE FILE. Market
 * cap was built, deployed and measured before being dropped. Both of its terms are
 * approximations -- total supply is not circulating supply, and the slice-implied
 * price is a volume-weighted average over one wallet set's trades in ~10,000 blocks
 * that docs/ROBINHOOD.md forbids comparing against a stored price bucket. The product
 * of two approximations is not a quantity to threshold on, and the measurements
 * agreed: the derivable market caps sat between $16.7M and $571M with no boundary in
 * them, $200,000 and $150,000 selected the same three tokens, and 439 of 693 tokens
 * had no USD route for the filter to see at all.
 *
 * DEPLOYMENT TIME HAS NEITHER PROBLEM. `eth_getCode` at a block either returns
 * bytecode or does not. No median, no fence, no bucket, no supply assumption. It is
 * the one property of a token this system can state without an approximation in it.
 *
 * MARKET CAP SURVIVES AS A DISPLAYED FIELD AND DECIDES NOTHING. The supply read is
 * already paid for and size is worth seeing beside an age.
 *
 * AGE IS MINUTES SINCE THE DEPLOYMENT BLOCK'S TIMESTAMP, NEVER SINCE THE WATCHER
 * FIRST SAW THE TOKEN. The watcher saw 751 tokens on its first day and not one of
 * them launched that day -- they were the first slice's backlog. A first-seen clock
 * would have called all 751 new and been wrong 751 times. Nothing here reads
 * `seen_at` or `block_time`.
 */
import {
  BODY_MARGIN, chartUrl, fitBody, mcapFigure, n0, px, short, tokenLabel, usdFigure,
} from './alert-format.js';

export interface AgeRow {
  token: string;
  wallet: string;
  side: 'buy' | 'sell';
  tokenAmount: number;
  usdAmount: number | null;
  tokenName: string | null;
  tokenSymbol: string | null;
}

export interface AgeAlertInput {
  rows: AgeRow[];
  /**
   * Age facts per token, from `loadAges`. Absent, or present with neither fact,
   * means UNKNOWN -- which is neither old nor new. `existedAtBlock` is what makes
   * "proven older than the window" distinguishable from "never established".
   */
  ages: Map<string, {
    deploymentBlock: number | null; deploymentTime: Date | null;
    existedAtBlock: number | null;
  }>;
  /** Whole-token supply per token, from `loadSupplies`. Display only. */
  supplies: Map<string, { units: number | null }>;
  /** The window's first block: a token qualifies when it deployed at or after it. */
  windowStartBlock: number;
  launchWindowMinutes: number;
  /** The moment ages are measured against. Passed in so the report is reproducible. */
  now: Date;
  fromBlock: number;
  toBlock: number;
  /** Reads that failed or were left unresolved by the bisect cap: unknown age. */
  unknownAge: number;
  publicUrl?: string | null;
  cap?: number;
  margin?: number;
}

interface Agg {
  token: string;
  name: string | null;
  symbol: string | null;
  buyers: Set<string>;
  buyTrades: number;
  buyUsd: number;
  buyUnpriced: number;
  buyTokens: number;
  /* Both terms over PRICED rows only, both sides. Only the DISPLAY is buys-only. */
  pricedUsd: number;
  pricedTokens: number;
}

export interface AgeAlertReport {
  /** Tokens bought this slice whose deployment falls inside the window. */
  launched: number;
  /** Bought, and proven to predate the window. */
  older: number;
  /** Bought, and their age could not be established. Never counted either way. */
  unknown: number;
  tokensWithBuys: number;
  buyRows: number;
  buyWallets: number;
  shown: number;
  dropped: number;
  characters: number;
  overran: boolean;
  /** Null when there is nothing to send, which is most runs. */
  body: string | null;
  title: string | null;
}

/**
 * Build the alert body, or return `body: null` when nothing launched this slice.
 *
 * NOTHING IS SENT ON AN EMPTY PERIOD AND MOST RUNS WILL SEND NOTHING. A token
 * launching and being bought by a watchlist wallet inside one hour is a rare event; a
 * quiet run is the alert working. `monitor_runs` already distinguishes silence from a
 * dead monitor, and the counts below are logged whether or not anything is sent.
 */
export function buildAgeAlert(input: AgeAlertInput): AgeAlertReport {
  const CAP = input.cap ?? 12;
  const MARGIN = input.margin ?? BODY_MARGIN;

  const byToken = new Map<string, Agg>();
  for (const r of input.rows) {
    const key = r.token.toLowerCase();
    const e = byToken.get(key) ?? {
      token: key, name: r.tokenName, symbol: r.tokenSymbol,
      buyers: new Set<string>(), buyTrades: 0, buyUsd: 0, buyUnpriced: 0,
      buyTokens: 0, pricedUsd: 0, pricedTokens: 0,
    };
    const amt = Math.abs(Number(r.tokenAmount));
    if (r.side === 'buy') {
      e.buyers.add(r.wallet);
      e.buyTrades += 1;
      e.buyTokens += amt;
      if (r.usdAmount === null) e.buyUnpriced += 1; else e.buyUsd += r.usdAmount;
    }
    if (r.usdAmount !== null) { e.pricedUsd += r.usdAmount; e.pricedTokens += amt; }
    byToken.set(key, e);
  }

  /* BUYS ONLY: a token the slice only sold has no line here at all. */
  const bought = [...byToken.values()].filter((e) => e.buyTrades > 0);

  interface Launched { e: Agg; block: number; ageMin: number }
  const launched: Launched[] = [];
  let older = 0; let unknown = 0;

  /*
   * THREE OUTCOMES, AND UNKNOWN IS NEITHER OF THE OTHER TWO. A deployment block
   * settles it by arithmetic. Failing that, a proven `existed_at_block` at or before
   * the window start settles it the other way -- permanently, since every later
   * window starts later still. Anything else is UNKNOWN: the read failed, or the
   * bisect cap bound, or the token has not been asked yet. Recording an unknown as
   * "old" would silently drop a real launch and recording it as "new" would
   * manufacture one, so it is counted and left out of both.
   */
  for (const e of bought) {
    const a = input.ages.get(e.token);
    if (a?.deploymentBlock != null && a.deploymentTime != null) {
      if (a.deploymentBlock < input.windowStartBlock) { older += 1; continue; }
      /*
       * AGE FROM THE DEPLOYMENT BLOCK'S TIMESTAMP. Clamped at zero rather than
       * allowed negative: a block timestamp marginally ahead of `now` is a clock
       * difference, not a token from the future, and "-1 min" reads as a defect.
       */
      const ageMin = Math.max(
        0, (input.now.getTime() - a.deploymentTime.getTime()) / 60000,
      );
      launched.push({ e, block: a.deploymentBlock, ageMin });
      continue;
    }
    if (a?.existedAtBlock != null && a.existedAtBlock <= input.windowStartBlock) {
      older += 1;
      continue;
    }
    unknown += 1;
  }

  /*
   * ORDERED BY DISTINCT BUYING WALLETS, THEN USD BOUGHT -- the same ordering and the
   * same reason as the first alert. Two wallets buying the same token is the
   * coordination signal this system exists to find, and a USD-first order sorts every
   * unpriceable token off the end by construction.
   */
  launched.sort((a, b) =>
    (b.e.buyers.size - a.e.buyers.size) || (b.e.buyUsd - a.e.buyUsd));

  const buyRows = input.rows.filter((r) => r.side === 'buy').length;
  const buyWallets = new Set(
    input.rows.filter((r) => r.side === 'buy').map((r) => r.wallet),
  ).size;

  const empty: AgeAlertReport = {
    launched: 0, older, unknown,
    tokensWithBuys: bought.length, buyRows, buyWallets,
    shown: 0, dropped: 0, characters: 0, overran: false, body: null, title: null,
  };
  if (launched.length === 0) return empty;

  const wallets = (n: number): string => `${n} wallet${n === 1 ? '' : 's'}`;
  const age = (m: number): string => (m < 1 ? '<1 min' : `${Math.round(m)} min`);

  const block = (v: Launched): string => {
    const e = v.e;
    const price = e.pricedTokens > 0 && e.pricedUsd > 0 ? e.pricedUsd / e.pricedTokens : null;
    const supply = input.supplies.get(e.token)?.units ?? null;
    /*
     * MARKET CAP IS DISPLAYED AND FILTERS NOTHING, and the two ways it can be absent
     * are named rather than blended. A null supply is not a zero supply: zero would
     * render `$0`, a measurement, and the wrong one.
     */
    const cap = price === null ? 'unpriced'
      : supply === null || !(supply > 0) ? 'no supply'
        : `${mcapFigure(supply * price)} (total supply)`;
    return `[${tokenLabel(e.token, e.symbol, e.name)}](${chartUrl(e.token)})`
      + `  \`${short(e.token)}\`\n`
      + `　age      ${age(v.ageMin)}  ·  deployed at block ${v.block}\n`
      + `　bought   ${wallets(e.buyers.size)}  `
      + `${usdFigure(e.buyUsd, e.buyUnpriced, e.buyTrades)}\n`
      + `　mcap     ${cap}`;
  };

  const render = (counts: number[]): string => {
    const n = counts[0]!;
    const shown = launched.slice(0, n);
    const dropped = launched.length - shown.length;
    let s = `Launched in the last ${input.launchWindowMinutes} min and bought`
      + `  ·  blocks ${input.fromBlock}–${input.toBlock}\n`
      + `_Age is measured from the deployment block's timestamp, not from when this `
      + `watcher first saw the token. Market cap is shown where derivable and filters `
      + `nothing._`
      + `\n\n${shown.map(block).join('\n\n')}`;
    if (dropped > 0) {
      s += `\n\n_…and ${dropped} more launched this window._`;
    }
    /*
     * A FAILED OR CAPPED READ IS STATED IN THE BODY WHEN THERE IS A BODY. It means
     * this list may be short by that many, which a reader cannot infer from a list
     * that looks complete. On a silent run the count is in the log only, and that
     * limitation is recorded in step 17 rather than left to be discovered.
     */
    if (input.unknownAge > 0) {
      s += `\n\n_${input.unknownAge} token${input.unknownAge === 1 ? '' : 's'} bought `
        + `this slice could not have their age established; they are not listed either `
        + `way._`;
    }
    s += input.publicUrl
      ? `\n\n**[Every trade on the watchlist tab →](${input.publicUrl}/watchlist)**`
      : `\n\nAll buys are in \`watchlist_activity\`; the watchlist tab has no `
        + 'public URL configured.';
    return s;
  };

  /*
   * ONE SECTION, SO ONE COUNT, and its floor is 1: a body that dropped to zero blocks
   * would be a header and a footer saying nothing was shown, which is worse than the
   * silence an empty period already gets.
   */
  const fit = fitBody(render, [Math.min(CAP, launched.length)], [1], [0], MARGIN);

  return {
    launched: launched.length,
    older,
    unknown,
    tokensWithBuys: bought.length,
    buyRows,
    buyWallets,
    shown: fit.counts[0]!,
    dropped: launched.length - fit.counts[0]!,
    characters: fit.characters,
    overran: fit.overran,
    body: fit.body,
    title: `${launched.length} token${launched.length === 1 ? '' : 's'} launched in the `
      + `last ${input.launchWindowMinutes} min and bought by `
      + `${new Set(launched.flatMap((v) => [...v.e.buyers])).size} wallet`
      + `${new Set(launched.flatMap((v) => [...v.e.buyers])).size === 1 ? '' : 's'}`,
  };
}

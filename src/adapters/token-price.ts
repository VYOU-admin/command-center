/**
 * Current price for every token in `tokens`, from DexScreener.
 *
 * ONE MONITOR, NOT ONE PER TOKEN. It reads the `tokens` table each cycle, so
 * adding a token to the dashboard needs no monitor and no config change.
 *
 * WHY DEXSCREENER. It is free, it needs no key, and it answers in ~150ms from
 * the Railway host. FAILURE_MODES records DexScreener returning 403, which is
 * true of curl -- the block is on the User-Agent, and Node's fetch is not
 * affected. Pricing from recent swaps on the pool was the alternative and would
 * have cost Helius credits on every cycle forever, to produce a worse number.
 *
 * ONE REQUEST PER TOKEN, AND WE PICK THE POOL OURSELVES. `/latest/dex/tokens`
 * accepts several mints comma-separated, but it caps its response at 30 pairs
 * total: one token with many pools silently pushes another token's pools out of
 * the answer. So each token is asked for on its own, and the highest-liquidity
 * pool is chosen here by sorting. The response is NOT ordered by liquidity --
 * measured, not assumed -- so taking the first pair would be wrong.
 *
 * `/tokens/v1` returns exactly one pair per token and did return the top pool
 * in testing, which would be one request for every token at once. It is not
 * used, because nothing documents that the pair it picks is the most liquid,
 * and a thinner pool's price is a different number: this token's pools ranged
 * 0.2351 to 0.2494 at the same instant.
 *
 * PRICE IS PER POOL. Not per token. Choosing the pool is choosing the price.
 *
 * NOTHING HERE EVER WRITES A ZERO. A token that cannot be priced this cycle
 * gets no row, and its previous row stands with its own timestamp. A plausible
 * wrong price is worse than a visibly old one.
 */

import type { AdapterContext, SourceAdapter } from './types.js';
import { configNumber, section } from './types.js';
import { SCHEMA } from './token-price/schema.js';

/**
 * Counter-side assets whose own USD price is sound enough to price ours
 * against. A pool quoted in some other memecoin has a `priceUsd` derived from
 * that coin's price and inherits its error, so it is not eligible however deep
 * it is. Same rule the intake procedure applies when choosing pools to collect.
 */
const PRICING_QUOTES = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'So11111111111111111111111111111111111111112', // wSOL
]);

const ENDPOINT = 'https://api.dexscreener.com/latest/dex/tokens/';
const SOURCE = 'dexscreener';

interface PriceConfig {
  requestTimeoutMs: number;
  /** Ignore pools thinner than this; a near-empty pool prints a noisy price. */
  minLiquidityUsd: number;
  /** Consecutive per-token failures before the system channel hears about it. */
  alertAfterFailures: number;
}

interface PriceRow {
  mint: string;
  ticker: string;
  priceUsd: number;
  pool: string;
  poolDex: string;
  poolQuote: string;
  liquidityUsd: number;
  candidates: number;
}

interface DexPair {
  pairAddress?: unknown;
  dexId?: unknown;
  priceUsd?: unknown;
  baseToken?: { address?: unknown };
  quoteToken?: { address?: unknown; symbol?: unknown };
  liquidity?: { usd?: unknown };
}

function parseConfig(options: Record<string, unknown>, monitorId: string): PriceConfig {
  const s = section(options, 'pricing');
  return {
    requestTimeoutMs: configNumber(s, 'request_timeout_ms', monitorId, 15_000),
    minLiquidityUsd: configNumber(s, 'min_liquidity_usd', monitorId, 500),
    alertAfterFailures: configNumber(s, 'alert_after_failures', monitorId, 3),
  };
}

/**
 * Consecutive failures per mint, so a token that keeps failing is reported even
 * though the run itself succeeded for the others -- the same shape oil-prices
 * uses for independent sources. In memory deliberately: it is alert
 * de-duplication, not data, and starting again after a deploy is harmless.
 */
const consecutiveFailures = new Map<string, number>();

const adapter: SourceAdapter<PriceRow> = {
  type: 'token-price',

  validate(options, monitorId) {
    parseConfig(options, monitorId);
  },

  async migrate(client) {
    await client.query(SCHEMA);
  },

  async fetch(ctx: AdapterContext) {
    const cfg = parseConfig(ctx.options, ctx.monitorId);

    const tokens = await ctx.db.query<{ mint: string; ticker: string }>(
      `select mint, ticker from tokens order by ticker`,
    );
    if (tokens.rowCount === 0) {
      // Not a failure: there is genuinely nothing to price yet.
      ctx.log.info('no tokens to price');
      return [];
    }

    const rows: PriceRow[] = [];
    const failures: string[] = [];

    for (const { mint, ticker } of tokens.rows) {
      if (ctx.signal.aborted) throw new Error('aborted before pricing finished');
      try {
        rows.push(await priceOne(ctx, cfg, mint, ticker));
        consecutiveFailures.delete(mint);
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        failures.push(`${ticker}: ${why}`);
        const n = (consecutiveFailures.get(mint) ?? 0) + 1;
        consecutiveFailures.set(mint, n);
        ctx.log.warn('token could not be priced', { ticker, mint, consecutive: n, error: why });
        if (n === cfg.alertAfterFailures) {
          ctx.queueAlert(
            {
              title: `${ticker} has failed to price ${n} times running`,
              description:
                `No price row has been written for ${ticker} in ${n} consecutive cycles.\n` +
                `Last error: ${why}\n\n` +
                'The dashboard is showing its previous price with the age it was ' +
                'observed at. Nothing has been written as zero.',
              level: 'warning',
            },
            'system',
          );
        }
      }
    }

    // Every token failing is the monitor failing. One of several failing is not:
    // the rest still stored, and the failure was alerted on its own above.
    if (rows.length === 0) {
      throw new Error(
        `no token could be priced (${tokens.rowCount} attempted): ${failures.join('; ')}`,
      );
    }
    if (failures.length > 0) {
      ctx.log.warn('some tokens unpriced this cycle', {
        priced: rows.length,
        failed: failures.length,
        detail: failures.join('; '),
      });
    }
    return rows;
  },

  async persist(_ctx, client, rows) {
    let stored = 0;
    for (const r of rows) {
      // The NOT NULL on price_usd is the last line of defence; this is the
      // first. A non-finite or non-positive price is a failed read wearing a
      // number, and must never reach storage.
      if (!Number.isFinite(r.priceUsd) || r.priceUsd <= 0) {
        throw new Error(`refusing to store price ${r.priceUsd} for ${r.ticker}`);
      }
      const res = await client.query(
        `insert into token_prices (mint, price_usd, pool, source)
         values ($1, $2, $3, $4)`,
        [r.mint, r.priceUsd, r.pool, SOURCE],
      );
      stored += res.rowCount ?? 0;
    }
    return stored;
  },
};

async function priceOne(
  ctx: AdapterContext,
  cfg: PriceConfig,
  mint: string,
  ticker: string,
): Promise<PriceRow> {
  const res = await fetch(ENDPOINT + mint, {
    signal: AbortSignal.timeout(cfg.requestTimeoutMs),
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from dexscreener`);

  const body = (await res.json()) as { pairs?: DexPair[] | null };
  const pairs = Array.isArray(body.pairs) ? body.pairs : [];
  if (pairs.length === 0) throw new Error('dexscreener returned no pairs');

  /*
   * Only pools where OUR mint is the base asset. A pair that holds this token
   * as its counter-side prices something else against us, and its priceUsd is
   * that other token's price -- the intake procedure records this exact trap.
   */
  const eligible = pairs
    .filter((p) => str(p.baseToken?.address) === mint)
    .filter((p) => PRICING_QUOTES.has(str(p.quoteToken?.address) ?? ''))
    .map((p) => ({
      pool: str(p.pairAddress),
      dex: str(p.dexId) ?? 'unknown',
      quote: str(p.quoteToken?.symbol) ?? '?',
      price: num(p.priceUsd),
      liquidity: num(p.liquidity?.usd) ?? 0,
    }))
    .filter((p) => p.pool !== null && p.price !== null && p.price > 0)
    .filter((p) => p.liquidity >= cfg.minLiquidityUsd);

  if (eligible.length === 0) {
    throw new Error(
      `no pool with a recognised pricing quote and >= $${cfg.minLiquidityUsd} liquidity ` +
        `(${pairs.length} pair(s) returned)`,
    );
  }

  // SORTED HERE. The response is not ordered by liquidity, so the first pair is
  // not the deepest one -- verified against a token whose pools came back
  // 169176, 103178, 170295 in that order.
  eligible.sort((a, b) => b.liquidity - a.liquidity);
  const top = eligible[0]!;

  ctx.log.debug('priced', {
    ticker,
    price: top.price,
    pool: top.pool,
    dex: top.dex,
    liquidity: top.liquidity,
    consideredPools: eligible.length,
  });

  return {
    mint,
    ticker,
    priceUsd: top.price!,
    pool: top.pool!,
    poolDex: top.dex,
    poolQuote: top.quote,
    liquidityUsd: top.liquidity,
    candidates: eligible.length,
  };
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/** DexScreener sends priceUsd and liquidity.usd as strings. */
function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export default adapter;

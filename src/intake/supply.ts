/**
 * `totalSupply()` for an arbitrary token, cached with an expiry.
 *
 * SUPPLY IS CACHED LIKE DECIMALS AND EXPIRES UNLIKE DECIMALS. `token_decimals_cache`
 * is permanent because decimals are immutable and a pool is a pool for good. Total
 * supply is neither -- a mint or a burn changes it -- so a permanent cache would go
 * stale silently, which is the failure shape docs/ROBINHOOD.md records most often.
 * Read once on first sight, re-read after `ttlDays`, and carry the read timestamp so
 * staleness is VISIBLE rather than assumed.
 *
 * `supply_read_at` DOES THE WORK OF TWO FLAGS, deliberately. It is set on every read
 * ATTEMPT, successful or not:
 *
 *   supply_read_at is null                  never read        -> work
 *   supply_read_at older than the TTL       stale             -> work again
 *   supply_read_at set and total_supply null  read, and the contract did not answer
 *
 * The third row is why no separate settled-negative boolean is needed: a token that
 * genuinely does not answer is not re-asked until its TTL expires, which is what
 * `meta_read` buys for name and symbol, without a second column that could disagree
 * with the first.
 *
 * A `0x` RETURN IS UNKNOWN, NEVER ZERO (step 1), and here that decides whether a
 * token appears in an alert at all: a supply of zero computes a market cap of $0,
 * which clears any ceiling and would put every unreadable token at the top of the
 * filtered list. It stores NULL and the token falls to the no-supply section.
 */
import type { PoolClient } from '../store/db.js';
import type { RpcClient } from '../adapters/token-updates/rpc.js';
import { SELECTORS } from '../adapters/token-updates/decode.js';

export const SUPPLY_SCHEMA = `
alter table token_decimals_cache add column if not exists total_supply   numeric;
alter table token_decimals_cache add column if not exists supply_read_at timestamptz;
`;

/** Default expiry. Weekly: supply moves on mints and burns, not on trades. */
export const SUPPLY_TTL_DAYS = 7;

export interface SupplyWorkSet {
  /** Tokens needing a read: never read, or read longer ago than the TTL. */
  tokens: string[];
  neverRead: number;
  stale: number;
  /** Tokens already fresh, reported so the work set is auditable against the total. */
  fresh: number;
  total: number;
}

/**
 * THE WORK SET, derived ONCE and used by both the estimate and the fetch (step 9).
 *
 * Scoped to tokens the watcher has actually seen, which is the set any alert can
 * ever need -- deriving it from the rows that will be written rather than from the
 * superset that contains them.
 */
export async function supplyWorkSet(
  client: PoolClient, chain: string, ttlDays: number, limit: number | null,
): Promise<SupplyWorkSet> {
  const counts = await client.query<{ never_read: string; stale: string; fresh: string;
    total: string; }>(
    `with seen as (select distinct lower(token) t from watchlist_activity where chain = $1)
     select count(*) filter (where c.supply_read_at is null)::text as never_read,
            count(*) filter (where c.supply_read_at is not null
                               and c.supply_read_at < now() - ($2 || ' days')::interval
                            )::text as stale,
            count(*) filter (where c.supply_read_at is not null
                               and c.supply_read_at >= now() - ($2 || ' days')::interval
                            )::text as fresh,
            count(*)::text as total
       from seen s
       left join token_decimals_cache c on c.chain = $1 and lower(c.token) = s.t`,
    [chain, String(ttlDays)],
  );
  const rows = await client.query<{ t: string }>(
    `with seen as (select distinct lower(token) t from watchlist_activity where chain = $1)
     select s.t
       from seen s
       left join token_decimals_cache c on c.chain = $1 and lower(c.token) = s.t
      where c.supply_read_at is null
         or c.supply_read_at < now() - ($2 || ' days')::interval
      order by c.supply_read_at asc nulls first, s.t
      ${limit === null ? '' : 'limit $3'}`,
    limit === null ? [chain, String(ttlDays)] : [chain, String(ttlDays), limit],
  );
  const c = counts.rows[0]!;
  return {
    tokens: rows.rows.map((r) => r.t),
    neverRead: Number(c.never_read),
    stale: Number(c.stale),
    fresh: Number(c.fresh),
    total: Number(c.total),
  };
}

export interface SupplyReadResult {
  attempted: number;
  resolved: number;
  /** Attempted, and the contract did not give a usable answer. Stored as null. */
  unresolved: number;
  /** Of the unresolved, how many returned `0x` rather than erroring. */
  emptyReturn: number;
  /** Of the unresolved, how many raised -- per-item errors included. */
  errored: number;
  cuSpent: number;
}

/**
 * Read `totalSupply()` for each token and store the result, ATTEMPT INCLUDED.
 *
 * A BATCHED CALL RETURNS PER-ITEM ERRORS INSIDE AN HTTP 200 (step 5), so each call is
 * inspected on its own and a token that errors is recorded as attempted-and-
 * unresolved rather than skipped. Skipping would leave `supply_read_at` null, which
 * reads as "never tried" and re-asks the same failing contract every cycle -- the
 * trap step 3 records, where a classifier spent five rounds re-asking 1,664 settled
 * questions.
 *
 * The caller's RpcClient carries the CU ceiling, so a job whose scope went wrong
 * stops inside this loop rather than after it.
 */
export async function readSupplies(
  client: PoolClient, rpc: RpcClient, chain: string, tokens: string[],
): Promise<SupplyReadResult> {
  const before = rpc.cuSpent;
  let resolved = 0; let emptyReturn = 0; let errored = 0;

  for (const token of tokens) {
    let supply: bigint | null = null;
    let empty = false;
    try {
      const r = await rpc.ethCall(token, SELECTORS.totalSupply);
      /*
       * `0x` IS UNKNOWN, NOT ZERO. A short return is the same thing: the contract
       * answered with no uint256, so there is no value to store.
       */
      if (typeof r === 'string' && r.length >= 66) {
        const v = BigInt(r.length > 66 ? r.slice(0, 66) : r);
        supply = v;
      } else {
        empty = true;
      }
    } catch (err) {
      /*
       * THE CEILING IS NOT A PER-TOKEN FAILURE -- it means the job must stop, so it
       * propagates rather than being recorded as "this token has no supply".
       */
      if (err instanceof Error && err.message.includes('compute-unit ceiling')) throw err;
      errored += 1;
    }
    if (supply !== null) resolved += 1;
    else if (empty) emptyReturn += 1;

    await client.query(
      `insert into token_decimals_cache (chain, token, total_supply, supply_read_at)
       values ($1, $2, $3, now())
       on conflict (chain, token) do update
         set total_supply   = excluded.total_supply,
             supply_read_at = excluded.supply_read_at`,
      [chain, token, supply === null ? null : supply.toString()],
    );
  }

  return {
    attempted: tokens.length,
    resolved,
    unresolved: tokens.length - resolved,
    emptyReturn,
    errored,
    cuSpent: rpc.cuSpent - before,
  };
}

export interface TokenSupply {
  /** Supply in WHOLE tokens: raw / 10^decimals. Null when either term is unknown. */
  units: number | null;
  readAt: Date | null;
}

/**
 * Load the stored supply for a set of tokens, already divided by decimals.
 *
 * THE DIVISION HAPPENS HERE, ONCE. `totalSupply()` returns RAW units and every
 * consumer wants whole tokens; doing it per caller is how a factor of 10^12 gets in,
 * which steps 1 and 4 both name. A token whose decimals are unknown yields null
 * rather than an undivided raw figure that would read as an enormous supply.
 */
export async function loadSupplies(
  client: PoolClient, chain: string, tokens: string[],
): Promise<Map<string, TokenSupply>> {
  const out = new Map<string, TokenSupply>();
  if (tokens.length === 0) return out;
  const r = await client.query<{
    token: string; total_supply: string | null; decimals: number | null;
    supply_read_at: Date | null;
  }>(
    `select lower(token) as token, total_supply::text, decimals, supply_read_at
       from token_decimals_cache
      where chain = $1 and lower(token) = any($2::text[])`,
    [chain, tokens.map((t) => t.toLowerCase())],
  );
  for (const row of r.rows) {
    let units: number | null = null;
    if (row.total_supply !== null && row.decimals !== null) {
      const raw = Number(row.total_supply);
      if (Number.isFinite(raw) && raw > 0) units = raw / 10 ** row.decimals;
    }
    out.set(row.token, { units, readAt: row.supply_read_at });
  }
  return out;
}

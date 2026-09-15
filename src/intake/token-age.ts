/**
 * When a token was deployed, cached, with an asymmetry between the two answers.
 *
 * docs/ROBINHOOD.md step 17, "THE SECOND ALERT BECAME AN AGE FILTER". The second
 * watchlist alert asks which tokens that launched inside a window the watchlist
 * wallets bought, and this answers the age half of that question.
 *
 * AGE IS ONE CALL, NOT A BISECT. To settle "was this deployed inside the window",
 * one `eth_getCode` at the window's FIRST block is enough: empty there and existing
 * now means the contract appeared inside the window. 26 CU, against the ~676 CU of
 * step 1's full-range bisect -- 26x -- and that is what makes this affordable at 48
 * runs a day. ONLY THE POSITIVES ARE BISECTED, and only inside that range: 16 calls
 * over an hour of blocks rather than 26 over the chain's life.
 *
 * THE CACHE IS ASYMMETRIC AND BOTH DIRECTIONS ARE PERMANENT, FOR DIFFERENT REASONS:
 *
 *   NEGATIVE  code present at block B   -> existed_at_block = B. A token that
 *             existed an hour ago will never have launched in the last hour, and
 *             every later window starts after B, so the answer only gets more true.
 *   POSITIVE  deployed at block D       -> deployment_block = D. The FACT is
 *             permanent; the QUALIFICATION expires within the hour. Caching the
 *             boolean "is new" would be wrong 60 minutes later and would cost 26 CU
 *             per token per run forever. Caching the BLOCK makes each later run
 *             arithmetic -- D >= windowStart -- with no request at all.
 *
 * So every token is asked at most once, ever, in either direction.
 *
 * `existed_at_block` ONLY EVER MOVES DOWN. A check anchored at an earlier block --
 * which the backfill does, anchoring at each token's first buy rather than at the
 * head -- proves a strictly stronger negative, and overwriting it with a later one
 * would throw that proof away and re-ask a settled question.
 *
 * A FAILED READ IS NOT AN ANSWER. It writes `age_checked_at` and nothing else, and
 * the token is UNKNOWN AGE: never "old", never "new". Both of those are plausible
 * values, and section 5's standing rule is that an error path emitting a plausible
 * value is the worst defect shape on this project. "Old" would silently drop a real
 * launch; "new" would manufacture one.
 *
 * NOTHING HERE READS `seen_at` OR `block_time`. Age is minutes since the deployment
 * block's timestamp. The watcher saw 751 tokens on its first day and not one of them
 * launched that day; a first-seen clock would have called all 751 new.
 */
import type { PoolClient } from '../store/db.js';
import type { RpcClient } from '../adapters/token-updates/rpc.js';

export const AGE_SCHEMA = `
alter table token_decimals_cache add column if not exists existed_at_block bigint;
alter table token_decimals_cache add column if not exists deployment_block bigint;
alter table token_decimals_cache add column if not exists deployment_time  timestamptz;
alter table token_decimals_cache add column if not exists age_checked_at   timestamptz;
`;

/**
 * MEASURED, over 935,564 blocks and 94,548 seconds. docs/ROBINHOOD.md section 3.
 * The window is configured in MINUTES and converted here; a block count written
 * directly into config would silently stop meaning an hour if block time moved.
 */
export const BLOCKS_PER_HOUR = 35622;

export function windowBlocks(minutes: number): number {
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error(`launch_window_minutes must be a positive number, got ${minutes}`);
  }
  return Math.round((BLOCKS_PER_HOUR * minutes) / 60);
}

export interface TokenAge {
  /** The deployment block, once known. Null until a positive has been bisected. */
  deploymentBlock: number | null;
  deploymentTime: Date | null;
  /** The EARLIEST block at which code was proven present. A permanent negative. */
  existedAtBlock: number | null;
  /** Set on every ATTEMPT, so a failed read is distinguishable from never asked. */
  checkedAt: Date | null;
}

export async function loadAges(
  client: PoolClient, chain: string, tokens: string[],
): Promise<Map<string, TokenAge>> {
  const out = new Map<string, TokenAge>();
  if (tokens.length === 0) return out;
  const r = await client.query<{
    token: string; existed_at_block: string | null; deployment_block: string | null;
    deployment_time: Date | null; age_checked_at: Date | null;
  }>(
    `select lower(token) as token, existed_at_block::text, deployment_block::text,
            deployment_time, age_checked_at
       from token_decimals_cache
      where chain = $1 and lower(token) = any($2::text[])`,
    [chain, tokens.map((t) => t.toLowerCase())],
  );
  for (const row of r.rows) {
    out.set(row.token, {
      deploymentBlock: row.deployment_block === null ? null : Number(row.deployment_block),
      deploymentTime: row.deployment_time,
      existedAtBlock: row.existed_at_block === null ? null : Number(row.existed_at_block),
      checkedAt: row.age_checked_at,
    });
  }
  return out;
}

/** One token to resolve, with the range its answer is sought in. */
export interface AgeAnchor {
  token: string;
  /** The window's first block. The single `eth_getCode` lands here. */
  lo: number;
  /** A block at which the token is known to exist, because it traded at or before it. */
  hi: number;
}

export interface AgeWorkSet {
  /** Anchors that actually need a request. */
  anchors: AgeAnchor[];
  total: number;
  /** Settled by a stored `deployment_block` -- pure arithmetic, no request. */
  knownDeployment: number;
  /** Settled by a stored `existed_at_block` at or before `lo` -- permanent negative. */
  knownOld: number;
  /** The single-call estimate for `anchors`, before any bisect. */
  estimatedBaseCu: number;
}

export const CODE_CU = 26;
export const BLOCK_CU = 20;

/**
 * THE WORK SET, DERIVED ONCE AND SERVING BOTH THE ESTIMATE AND THE FETCH (step 9).
 *
 * A stored answer of either kind removes a token from the work set, which is the
 * whole economics of this alert: the population it asks about is the NOVEL tokens,
 * not every token the watcher has ever seen.
 */
export function ageWorkSet(
  anchors: AgeAnchor[], cached: Map<string, TokenAge>,
): AgeWorkSet {
  const need: AgeAnchor[] = [];
  let knownDeployment = 0; let knownOld = 0;
  for (const a of anchors) {
    const c = cached.get(a.token.toLowerCase());
    if (c?.deploymentBlock != null) { knownDeployment += 1; continue; }
    if (c?.existedAtBlock != null && c.existedAtBlock <= a.lo) { knownOld += 1; continue; }
    need.push(a);
  }
  return {
    anchors: need,
    total: anchors.length,
    knownDeployment,
    knownOld,
    estimatedBaseCu: need.length * CODE_CU,
  };
}

export interface AgeResolveResult {
  attempted: number;
  /** Code already present at `lo`: the token predates the window. */
  old: number;
  /** Code absent at `lo` and the deployment block found by bisect. */
  deployed: number;
  /** Positives left unbisected because `bisectCap` bound. Reported, never silent. */
  bisectsSkipped: number;
  /** Reads that raised. Recorded as UNKNOWN age, never as old and never as new. */
  failed: number;
  /**
   * Absent at `lo` AND absent at `hi`, which contradicts the trade that put the
   * token here. Recorded as unknown and logged, not silently turned into a
   * deployment block the bisect would otherwise have invented.
   */
  anomalous: number;
  cuSpent: number;
  /** Whether `bisectCap` actually bound on this run. */
  bisectCapBound: boolean;
}

function hasCode(code: string): boolean {
  return code !== '0x' && code.length > 2;
}

/**
 * Resolve each anchor with ONE `eth_getCode`, bisecting only the positives.
 *
 * The bisect verifies the upper end before searching. `hi` is believed non-empty
 * because the token traded at or before it, but a binary search whose invariant is
 * assumed rather than checked returns `hi` itself when the assumption fails -- a
 * fabricated deployment block, indistinguishable from a real one. 26 CU buys the
 * difference between a measurement and a plausible value.
 */
export async function resolveAges(
  client: PoolClient, rpc: RpcClient, chain: string,
  anchors: AgeAnchor[], bisectCap: number,
): Promise<AgeResolveResult> {
  const before = rpc.cuSpent;
  let old = 0; let deployed = 0; let failed = 0; let anomalous = 0;
  let bisectsSkipped = 0; let bisectsUsed = 0;

  for (const a of anchors) {
    try {
      const atLo = await rpc.getCode(a.token, a.lo);
      if (hasCode(atLo)) {
        /*
         * THE PERMANENT NEGATIVE. `least` keeps the earliest proven block: a later
         * anchor must never overwrite an earlier proof with a weaker one.
         */
        old += 1;
        await client.query(
          `insert into token_decimals_cache (chain, token, existed_at_block, age_checked_at)
           values ($1, $2, $3, now())
           on conflict (chain, token) do update
             set existed_at_block = least(
                   coalesce(token_decimals_cache.existed_at_block, excluded.existed_at_block),
                   excluded.existed_at_block),
                 age_checked_at   = excluded.age_checked_at`,
          [chain, a.token.toLowerCase(), a.lo],
        );
        continue;
      }

      if (bisectsUsed >= bisectCap) {
        /*
         * THE CAP BINDS AND THE TOKEN IS LEFT UNRESOLVED RATHER THAN GUESSED. No
         * column is written -- not even `existed_at_block`, which would be false --
         * so the next run re-asks it. The count is returned and logged.
         */
        bisectsSkipped += 1;
        continue;
      }
      bisectsUsed += 1;

      const atHi = await rpc.getCode(a.token, a.hi);
      if (!hasCode(atHi)) { anomalous += 1; continue; }

      /* Smallest block in (lo, hi] carrying code. lo is empty, hi is not. */
      let loB = a.lo; let hiB = a.hi;
      while (loB + 1 < hiB) {
        const mid = Math.floor((loB + hiB) / 2);
        if (hasCode(await rpc.getCode(a.token, mid))) hiB = mid; else loB = mid;
      }
      const ts = await rpc.getBlockTimestamp(hiB);
      deployed += 1;
      await client.query(
        `insert into token_decimals_cache
           (chain, token, deployment_block, deployment_time, age_checked_at)
         values ($1, $2, $3, to_timestamp($4), now())
         on conflict (chain, token) do update
           set deployment_block = excluded.deployment_block,
               deployment_time  = excluded.deployment_time,
               age_checked_at   = excluded.age_checked_at`,
        [chain, a.token.toLowerCase(), hiB, ts],
      );
    } catch (err) {
      /* The ceiling stops the job; it is not this token's failure. */
      if (err instanceof Error && err.message.includes('compute-unit ceiling')) throw err;
      failed += 1;
      await client.query(
        `insert into token_decimals_cache (chain, token, age_checked_at)
         values ($1, $2, now())
         on conflict (chain, token) do update set age_checked_at = excluded.age_checked_at`,
        [chain, a.token.toLowerCase()],
      );
    }
  }

  return {
    attempted: anchors.length,
    old, deployed, bisectsSkipped, failed, anomalous,
    cuSpent: rpc.cuSpent - before,
    bisectCapBound: bisectsSkipped > 0,
  };
}

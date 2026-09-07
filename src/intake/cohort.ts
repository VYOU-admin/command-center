/**
 * Phase 7: the cohort.
 *
 * A wallet is in a window's cohort when it BOUGHT the token inside that
 * window's blocks and was an ordinary wallet at the time.
 *
 * THE COHORT MUST COME FROM BOTH VENUES. The first PONS cohort was built from
 * v3 pools alone, because v4 pools are not transfer counterparties -- the
 * PoolManager is -- and it missed 3,067 wallets, 23.5% of the final cohort, who
 * bought exclusively on v4. When a venue's pools are invisible to the obvious
 * query, that is not evidence they were inactive.
 *
 * A DELEGATED ACCOUNT IS A WALLET, NOT A CONTRACT. Exactly 23 bytes of
 * 0xef0100 + a delegate address is an EIP-7702 user account. Only other
 * non-empty code is a deployed contract. See docs/ROBINHOOD.md, step 7.
 *
 * THE CONTRACT CHECK RUNS AT THE WINDOW'S END BLOCK, NOT AT `latest`. An
 * address that was an ordinary wallet when it bought is a buyer whatever it
 * became afterwards. Checking at `latest` cost 581 wallets on PONS -- 4.6% of
 * the cohort -- to EIP-7702 delegations adopted later, and wrongly INCLUDED six
 * wallets that held a delegation during the window and revoked it after. It was
 * wrong in both directions.
 */

import type { IntakeConfig, IntakeWindow } from './plan.js';
import { classifyCode } from '../adapters/token-updates/decode.js';
import type { RpcClient } from '../adapters/token-updates/rpc.js';
import type { PoolRow } from '../adapters/token-updates/pools.js';
import { tradeLegs, type PaymentIndex } from '../adapters/token-updates/rows.js';
import { loadLegsInput } from './write.js';
import type { PoolClient } from '../store/db.js';

export interface TagReport {
  /** Genuinely new tag rows. */
  tagsStored: number;
  /** Existing `auto` tags re-asserted by this run. */
  tagsRefreshed: number;
  /** Tags a human set to `manual`, which a re-run must never overwrite. */
  manualLeftAlone: number;
  windowRow: boolean;
}

export interface CohortReport {
  window: string;
  startBlock: number;
  endBlock: number;
  /** Addresses that received the token from a pool inside the window. */
  rawBuyers: number;
  excludedByInfrastructure: number;
  excludedAsRoundTrippers: number;
  excludedAsPools: number;
  codeChecked: number;
  excludedAsContracts: number;
  /** Delegated accounts KEPT in the cohort, reported for visibility. */
  delegatedEip7702: number;
  cohort: string[];
  /** Exclusion-list entries that matched nothing, reported rather than dropped. */
  unusedExclusions: string[];
}

export async function buildCohort(
  client: PoolClient,
  rpc: RpcClient,
  cfg: IntakeConfig,
  window: IntakeWindow,
  pools: Map<string, PoolRow>,
  /** The effective exclusions: the configured list union the detected routers. */
  excludedSet: Set<string>,
  /** (tx, wallet) pairs where the wallet paid a pool. See ROBINHOOD.md step 7. */
  payments: PaymentIndex,
): Promise<CohortReport> {
  const startBlock = window.startBlock!;
  const endBlock = window.endBlock!;

  /*
   * ONE IMPLEMENTATION OF WHO TRADED. The cohort is exactly the set of wallets
   * `tradeLegs` produces buy legs for inside the window -- the same function the
   * row writer uses. It therefore requires a Swap on an in-scope pool, applies
   * the infrastructure list, and detects round-tripping per transaction, all
   * because the row writer does, not because this file repeats the rules.
   */
  const knownPools = new Set([...pools.values()].map((p) => p.pool));
  knownPools.add(cfg.v4PoolManager.toLowerCase());

  /*
   * SLICED, never loaded whole. A cohort window on a busy token is millions of
   * transfers, and a transaction lives in exactly one block, so a block-range
   * slice can never split one apart.
   */
  const buyers = new Set<string>();
  const usedExclusions = new Set<string>();
  let excludedByInfrastructure = 0;
  let excludedAsRoundTrippers = 0;
  let excludedAsPools = 0;
  let candidateWallets = 0;

  for (let from = startBlock; from <= endBlock; from += cfg.sliceBlocks) {
    const to = Math.min(from + cfg.sliceBlocks - 1, endBlock);
    const slice = await loadLegsInput(client, cfg, pools, from, to);
    const { legs, stats } = tradeLegs(
      // The cohort does not need prices: membership is who traded, not for how
      // much. A resolver that always returns null keeps every leg's USD null.
      slice.swaps, slice.transfers, cfg, () => null, excludedSet, knownPools,
      payments,
    );
    for (const leg of legs) if (leg.side === 'buy') buyers.add(leg.wallet);
    for (const t of slice.transfers) {
      if (excludedSet.has(t.from)) usedExclusions.add(t.from);
      if (excludedSet.has(t.to)) usedExclusions.add(t.to);
    }
    excludedByInfrastructure += stats.walletsExcludedInfrastructure;
    excludedAsRoundTrippers += stats.roundTrippers;
    excludedAsPools += stats.walletsExcludedIsPool;
    candidateWallets += stats.candidateWallets;
  }
  const survivors = [...buyers].sort();

  /*
   * The code check, at the window's END block. This needs an archival endpoint:
   * the public RPC answers "metadata is not found" for any historical block, and
   * reading that error as "no contract" turns every pool and router into a
   * wallet. rpc.getCode throws rather than returning a default.
   */
  const cohort: string[] = [];
  let excludedAsContracts = 0;
  let delegatedEip7702 = 0;
  for (const wallet of survivors) {
    const code = await rpc.getCode(wallet, endBlock);
    const kind = classifyCode(code);
    if (kind === 'contract') {
      excludedAsContracts += 1;
      continue;
    }
    // A DELEGATED ACCOUNT IS A WALLET. It stays in the cohort, and is counted
    // separately so the composition is visible rather than assumed.
    if (kind === 'delegated') delegatedEip7702 += 1;
    cohort.push(wallet);
  }

  return {
    window: window.label,
    startBlock,
    endBlock,
    rawBuyers: candidateWallets,
    excludedByInfrastructure,
    excludedAsRoundTrippers,
    excludedAsPools,
    codeChecked: survivors.length,
    excludedAsContracts,
    delegatedEip7702,
    cohort,
    unusedExclusions: [...excludedSet].filter((a) => !usedExclusions.has(a)),
  };
}

/**
 * Write the tags AND the window record. ROBINHOOD.md step 8.
 *
 * `wallet_tags.source` is `auto` for a run and `manual` for a human edit, and it
 * is NOT NULL with no default -- omitting it threw on the first tag, which is
 * why the runner never got past this step. A re-run re-asserts `auto` tags by
 * upsert and never touches a `manual` one, because tags live in their own table
 * so operator edits survive a re-run.
 *
 * EVERY RUN WRITES ITS token_windows ROW. A cohort with rows and no window row
 * is a defect: the cohort's definition was never written down and the only
 * remaining description of it is the rows themselves. The dashboard legend and
 * the scorer both read it, and a token with no window row cannot be scored at
 * all.
 *
 * The window row is written ONLY when the window is complete across every pool
 * in scope -- `complete` is the caller's assertion that the sweep and the cohort
 * both finished. A window with tags and no window row is the signal that it was
 * interrupted, and it renders with no legend entry, which is correct: a
 * half-collected cohort must not look complete.
 */
export async function writeTags(
  client: PoolClient,
  cfg: IntakeConfig,
  window: IntakeWindow,
  cohort: string[],
  complete: boolean,
): Promise<TagReport> {
  let tagsStored = 0;
  let tagsRefreshed = 0;
  for (const wallet of cohort) {
    // `xmax = 0` is true only for a genuine insert, so a re-run reports how many
    // tags are new rather than counting every upsert as one.
    const res = await client.query<{ inserted: boolean }>(
      `insert into wallet_tags (wallet, mint, tag, source)
       values ($1, $2, $3, 'auto')
       on conflict (wallet, mint, tag) do update
         set updated_at = now()
       where wallet_tags.source = 'auto'
       returning (xmax = 0) as inserted`,
      [wallet, cfg.token, window.label],
    );
    if (res.rows[0]?.inserted) tagsStored += 1;
    else if (res.rowCount) tagsRefreshed += 1;
  }

  const manualLeftAlone = cohort.length - tagsStored - tagsRefreshed;
  if (!complete) {
    return { tagsStored, tagsRefreshed, manualLeftAlone, windowRow: false };
  }
  await client.query(
    `insert into token_windows (mint, tag, window_start, window_end, label)
     values ($1, $2, $3::timestamptz, $4::timestamptz, $5)
     on conflict (mint, tag) do update
       set window_start = excluded.window_start,
           window_end   = excluded.window_end,
           label        = excluded.label`,
    [cfg.token, window.label, window.start, window.end, window.label],
  );
  return { tagsStored, tagsRefreshed, manualLeftAlone, windowRow: true };
}

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
import type { ExclusionEntry } from '../adapters/token-updates/exclusions.js';
import type { PoolRow } from '../adapters/token-updates/pools.js';
import { tradeLegs } from '../adapters/token-updates/rows.js';
import { loadLegsInput } from './write.js';
import type { PoolClient } from '../store/db.js';

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
  exclusions: ExclusionEntry[],
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
  const slice = await loadLegsInput(client, cfg, pools, startBlock, endBlock);
  const excludedSet = new Set(exclusions.map((e) => e.address));
  const knownPools = new Set([...pools.values()].map((p) => p.pool));
  knownPools.add(cfg.v4PoolManager.toLowerCase());

  const { legs, stats } = tradeLegs(
    // The cohort does not need prices: membership is who traded, not for how
    // much. A resolver that always returns null keeps every leg's USD null.
    slice.swaps, slice.transfers, cfg, () => null, excludedSet, knownPools,
  );

  const buyers = new Set<string>();
  for (const leg of legs) if (leg.side === 'buy') buyers.add(leg.wallet);
  const survivors = [...buyers].sort();

  const usedExclusions = new Set<string>();
  for (const t of slice.transfers) {
    if (excludedSet.has(t.from)) usedExclusions.add(t.from);
    if (excludedSet.has(t.to)) usedExclusions.add(t.to);
  }
  const excludedByInfrastructure = stats.walletsExcludedInfrastructure;
  const excludedAsRoundTrippers = stats.roundTrippers;
  const excludedAsPools = stats.walletsExcludedIsPool;

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
    rawBuyers: stats.candidateWallets,
    excludedByInfrastructure,
    excludedAsRoundTrippers,
    excludedAsPools,
    codeChecked: survivors.length,
    excludedAsContracts,
    delegatedEip7702,
    cohort,
    unusedExclusions: exclusions
      .filter((e) => !usedExclusions.has(e.address))
      .map((e) => `${e.label} (${e.address})`),
  };
}

/**
 * Write the tags. Called only after the cohort STOP has been cleared.
 * Returns how many rows were newly stored, which will be less than the cohort
 * size on a re-run and equal to it on a first run.
 */
export async function writeTags(
  client: PoolClient,
  cfg: IntakeConfig,
  window: IntakeWindow,
  cohort: string[],
): Promise<number> {
  let stored = 0;
  for (const wallet of cohort) {
    const res = await client.query(
      `insert into wallet_tags (wallet, mint, tag)
       values ($1, $2, $3)
       on conflict (wallet, mint, tag) do nothing`,
      [wallet, cfg.token, window.label],
    );
    stored += res.rowCount ?? 0;
  }
  return stored;
}

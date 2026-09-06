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
 * non-empty code is a deployed contract. See docs/DEFINITIONS.md section 5.
 *
 * THE CONTRACT CHECK RUNS AT THE WINDOW'S END BLOCK, NOT AT `latest`. An
 * address that was an ordinary wallet when it bought is a buyer whatever it
 * became afterwards. Checking at `latest` cost 581 wallets on PONS -- 4.6% of
 * the cohort -- to EIP-7702 delegations adopted later, and wrongly INCLUDED six
 * wallets that held a delegation during the window and revoked it after. It was
 * wrong in both directions.
 */

import type { IntakeConfig, IntakeWindow } from './plan.js';
import { classifyCode, normalizeAddress } from '../adapters/token-updates/decode.js';
import type { RpcClient } from '../adapters/token-updates/rpc.js';
import type { ExclusionEntry } from '../adapters/token-updates/exclusions.js';
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

/**
 * Candidate buyers for one window, straight from the stored transfer and swap
 * logs. Both venues at once: the counterparty is the v3 pool address or the v4
 * PoolManager, and both are in `counterparties`.
 */
async function candidateBuyers(
  client: PoolClient,
  cfg: IntakeConfig,
  counterparties: string[],
  startBlock: number,
  endBlock: number,
): Promise<{ wallet: string; roundTripper: boolean }[]> {
  const res = await client.query<{ wallet: string; got: string; round_tripper: boolean }>(
    `with moves as (
       select t.tx_hash,
              t.to_addr   as wallet,
              t.amount    as amount,
              true        as received
         from token_transfer_logs t
        where t.chain = $1 and t.token = $2
          and t.block_number between $3 and $4
          and t.from_addr = any($5::text[])
          and t.to_addr <> all($5::text[])
       union all
       select t.tx_hash, t.from_addr, t.amount, false
         from token_transfer_logs t
        where t.chain = $1 and t.token = $2
          and t.block_number between $3 and $4
          and t.to_addr = any($5::text[])
          and t.from_addr <> all($5::text[])
     ),
     /*
      * ROUND-TRIPPING IS DECIDED PER TRANSACTION, NOT PER WINDOW.
      *
      * A wallet that both receives from and sends to a pool INSIDE ONE
      * TRANSACTION is a fee recipient or an arbitrage hop. A wallet that buys
      * in March and sells in May is a trader, and aggregating across the whole
      * window cannot tell them apart. Measured on PONS: the window-level test
      * flags 10,389 wallets and would drop 8,220 of the 13,095 genuine cohort
      * members; the per-transaction test flags 512 and drops 3.
      */
     per_tx as (
       select tx_hash, wallet,
              bool_or(received) and bool_or(not received) as both_ways,
              sum(case when received then amount else 0 end) as got
         from moves
        group by tx_hash, wallet
     )
     select wallet,
            sum(got)::text        as got,
            bool_or(both_ways)    as round_tripper
       from per_tx
      group by wallet`,
    [cfg.chain, cfg.token, startBlock, endBlock, counterparties],
  );

  return res.rows
    .filter((r) => BigInt(r.got) > 0n)
    .map((r) => ({
      wallet: normalizeAddress(r.wallet),
      roundTripper: r.round_tripper,
    }));
}

export async function buildCohort(
  client: PoolClient,
  rpc: RpcClient,
  cfg: IntakeConfig,
  window: IntakeWindow,
  poolAddresses: string[],
  exclusions: ExclusionEntry[],
  roundTripperPolicy: 'exclude' | 'keep' = 'exclude',
): Promise<CohortReport> {
  const startBlock = window.startBlock!;
  const endBlock = window.endBlock!;

  // The v4 PoolManager is a counterparty even when the pool being tracked is
  // v3, because routers hop through it. It is in the exclusion list as a
  // wallet and in the counterparty list as a venue -- those are different roles.
  const counterparties = [...new Set([...poolAddresses, cfg.v4PoolManager.toLowerCase()])];

  const candidates = await candidateBuyers(
    client,
    cfg,
    counterparties,
    startBlock,
    endBlock,
  );

  const excluded = new Map(exclusions.map((e) => [e.address, e.label]));
  const usedExclusions = new Set<string>();
  const poolSet = new Set(counterparties);

  let excludedByInfrastructure = 0;
  let excludedAsRoundTrippers = 0;
  let excludedAsPools = 0;
  const survivors: string[] = [];

  for (const c of candidates) {
    // APPLIED AT THE CANDIDATE STAGE, before the code check and before cohort
    // selection, so an excluded address never becomes a row at all.
    if (excluded.has(c.wallet)) {
      excludedByInfrastructure += 1;
      usedExclusions.add(c.wallet);
      continue;
    }
    if (poolSet.has(c.wallet)) {
      excludedAsPools += 1;
      continue;
    }
    if (c.roundTripper && roundTripperPolicy === 'exclude') {
      excludedAsRoundTrippers += 1;
      continue;
    }
    survivors.push(c.wallet);
  }

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
    rawBuyers: candidates.length,
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

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
 * THE CONTRACT CHECK RUNS AT THE WINDOW'S END BLOCK, NOT AT `latest`. An
 * address that was an ordinary wallet when it bought is a buyer whatever it
 * became afterwards. Checking at `latest` cost 581 wallets on PONS -- 4.6% of
 * the cohort -- to EIP-7702 delegations adopted later, and wrongly INCLUDED six
 * wallets that held a delegation during the window and revoked it after. It was
 * wrong in both directions.
 */

import type { IntakeConfig, IntakeWindow } from './plan.js';
import { normalizeAddress } from '../adapters/token-updates/decode.js';
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
  const res = await client.query<{ wallet: string; got: string; gave: string }>(
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
     )
     select wallet,
            sum(case when received then amount else 0 end)::text as got,
            sum(case when not received then amount else 0 end)::text as gave
       from moves
      group by wallet`,
    [cfg.chain, cfg.token, startBlock, endBlock, counterparties],
  );

  return res.rows
    .filter((r) => BigInt(r.got) > 0n)
    .map((r) => ({
      wallet: normalizeAddress(r.wallet),
      /*
       * Both directions against a pool inside the window is the fee-recipient
       * and arbitrage-hop signature, not a buyer. These are token-specific and
       * so are detected per run rather than listed in configuration.
       */
      roundTripper: BigInt(r.gave) > 0n && BigInt(r.got) > 0n,
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
    if (code !== '0x') {
      excludedAsContracts += 1;
      // 23 bytes of 0xef0100 + address is an EIP-7702 delegation, not a
      // contract in the ordinary sense. Counted separately so the split is
      // visible rather than assumed.
      if (code.startsWith('0xef0100') && code.length === 2 + 23 * 2) {
        delegatedEip7702 += 1;
      }
      continue;
    }
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

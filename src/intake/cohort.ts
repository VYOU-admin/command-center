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
import { tradeLegs } from '../adapters/token-updates/rows.js';
import { fastPathPayers, provenBuyers } from './payment.js';
import { loadLegsInput } from './write.js';
import type { PoolClient } from '../store/db.js';

export interface TagReport {
  /** Genuinely new tag rows. */
  tagsStored: number;
  /** Existing `auto` tags re-asserted by this run. */
  tagsRefreshed: number;
  /** Tags a human set to `manual`, which a re-run must never overwrite. */
  manualLeftAlone: number;
  /**
   * `auto` tags deleted because the rebuilt cohort no longer contains the
   * wallet. Non-zero only when the membership rule has changed, so it is worth
   * reading: 733 on the PONS rebuild.
   */
  tagsRemoved: number;
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
  /** Wallets that received the token from a pool and so needed proving. */
  candidateWalletsForPayment: number;
  /** Proven at no cost from token_payment_logs. */
  walletsProvenFree: number;
  walletsProvenByRpc: number;
  /** Received the token but paid in none of their candidate transactions. */
  walletsWithNoPaymentInAnyTransaction: number;
  paymentTransactionsRead: number;
  paymentReceiptsRead: number;
  paymentCu: number;
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
  /**
   * Wallet -> a few of the transactions in which it received the token from a
   * pool. Capped at 8 per wallet: proving stops at the first success, and a
   * wallet with no payment in its first eight candidate transactions is not a
   * buyer that a ninth would rescue.
   */
  const candidateTxs = new Map<string, string[]>();

  for (let from = startBlock; from <= endBlock; from += cfg.sliceBlocks) {
    const to = Math.min(from + cfg.sliceBlocks - 1, endBlock);
    const slice = await loadLegsInput(client, cfg, pools, from, to);
    // The cohort does not need prices: membership is who traded, not for how
    // much. A resolver that always returns null keeps every leg's USD null.
    const { legs, stats } = tradeLegs(
      slice.swaps, slice.transfers, cfg, () => null, excludedSet, knownPools,
    );
    // Candidates accumulate across slices; payment is proven ONCE, after every
    // slice has been read, so a wallet buying in ten slices is proven once.
    for (const leg of legs) {
      if (leg.side !== 'buy') continue;
      const list = candidateTxs.get(leg.wallet);
      if (list) { if (list.length < 8) list.push(leg.txHash); }
      else candidateTxs.set(leg.wallet, [leg.txHash]);
    }
    for (const t of slice.transfers) {
      if (excludedSet.has(t.from)) usedExclusions.add(t.from);
      if (excludedSet.has(t.to)) usedExclusions.add(t.to);
    }
    excludedByInfrastructure += stats.walletsExcludedInfrastructure;
    excludedAsRoundTrippers += stats.roundTrippers;
    excludedAsPools += stats.walletsExcludedIsPool;
    candidateWallets += stats.candidateWallets;
  }
  /*
   * PAYMENT, ONCE PER WALLET. Every candidate slice has been read, so each
   * wallet is proven a single time across the whole window rather than once per
   * slice. See docs/ROBINHOOD.md step 7.
   */
  const fastPath = await fastPathPayers(client, cfg.chain, cfg.token);
  const proof = await provenBuyers(rpc, cfg.token, knownPools, candidateTxs, fastPath);
  for (const w of proof.buyers) buyers.add(w);

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
    candidateWalletsForPayment: candidateTxs.size,
    walletsProvenFree: proof.walletsProvenFree,
    walletsProvenByRpc: proof.walletsProvenByRpc,
    walletsWithNoPaymentInAnyTransaction: proof.walletsWithNoPaymentInAnyTransaction,
    paymentTransactionsRead: proof.transactionsRead,
    paymentReceiptsRead: proof.receiptsRead,
    paymentCu: proof.cuSpent,
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
 *
 * A COHORT THAT SHRINKS MUST SHRINK THE TAGS. This was upsert-only, so a
 * membership rule that removes a wallet could never take effect: the PONS
 * rebuild's cohort of 13,823 kept 12,362, added 1,461 and DROPPED 733, and
 * upserting alone would have left 14,556 tags -- the union of two different
 * definitions, describing no cohort that was ever computed. The cohort argument
 * is the complete membership for this window, so an `auto` tag for a wallet not
 * in it is removed.
 *
 * Only when `complete`. A partial cohort is not a membership claim, and deleting
 * against one would empty the table. Both callers pass the whole reviewed
 * cohort; the hourly adapter only reads `wallet_tags` and never calls this.
 *
 * `manual` is never touched, in either direction. An operator's edit outlives a
 * re-run, which is the entire reason tags live in their own table.
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
    return { tagsStored, tagsRefreshed, manualLeftAlone, windowRow: false, tagsRemoved: 0 };
  }

  /*
   * Remove `auto` tags for wallets the rebuilt cohort no longer contains.
   * Anti-joined against an unnested array so the planner hashes it; `<> all()`
   * over 13,823 addresses is a nested loop against every stored tag.
   */
  const removed = await client.query<{ wallet: string }>(
    `delete from wallet_tags t
      where t.mint = $1 and t.tag = $2 and t.source = 'auto'
        and not exists (
          select 1 from unnest($3::text[]) as c(wallet) where c.wallet = t.wallet
        )
      returning t.wallet`,
    [cfg.token, window.label, cohort],
  );
  const tagsRemoved = removed.rowCount ?? 0;

  /*
   * VERIFY, DO NOT ASSUME. The statements above having run without throwing is
   * not evidence the table now holds the cohort. Re-count and refuse to go on
   * if it does not, because the rows written next are derived from these tags.
   */
  const after = await client.query<{ auto: string; manual: string }>(
    `select count(*) filter (where source = 'auto')::text as auto,
            count(*) filter (where source = 'manual')::text as manual
       from wallet_tags where mint = $1 and tag = $2`,
    [cfg.token, window.label],
  );
  const auto = Number(after.rows[0]?.auto ?? 0);
  if (auto !== cohort.length) {
    throw new Error(
      `after writing tags for ${window.label} the table holds ${auto} auto tags but the `
        + `cohort has ${cohort.length}. Refusing to continue: the rows are derived from `
        + 'these tags.',
    );
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
  return { tagsStored, tagsRefreshed, manualLeftAlone, tagsRemoved, windowRow: true };
}

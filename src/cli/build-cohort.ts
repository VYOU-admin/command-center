/**
 * `npm run build-cohort -- <config.yaml> [--window LABEL] [--ceiling C]`
 *
 * The cohort step on its own. WRITES NOTHING -- step 7 stops before
 * `wallet_tags` precisely so the membership can be reviewed first.
 *
 * WHY NOT THROUGH THE RUNNER. Reaching the cohort phase means passing the sweep
 * phase, which would re-sweep logs already in the database. `buildCohort` here
 * is the same function the phase calls.
 *
 * IT VERIFIES SIGN CONVENTIONS FIRST, from stored swaps and transfers rather
 * than from a fresh 15-call sample. That is a deliberate difference and it cuts
 * the right way: AI's v4 swaps were copied from `v4_swaps_all`, collected by a
 * process nothing here controls, so they deserve more scrutiny than fifteen
 * calls and not less. The conventions in step 6 were measured on PONS; assuming
 * they hold for another token is exactly what step 6 says not to do.
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { loadIntakeConfig } from '../intake/plan.js';
import { RpcClient } from '../adapters/token-updates/rpc.js';
import { loadPools } from '../adapters/token-updates/pools.js';
import { loadExclusions } from '../adapters/token-updates/exclusions.js';
import { effectiveExclusions } from '../intake/routers.js';
import { buildCohort } from '../intake/cohort.js';

const INFRA = 'config/infrastructure.yaml';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const configPath = args.find((a) => !a.startsWith('--'));
  if (!configPath) throw new Error('usage: build-cohort <config.yaml>');
  const idx = args.indexOf('--window');
  const wantWindow = idx >= 0 ? args[idx + 1] : undefined;
  const ci = args.indexOf('--ceiling');
  const ceiling = ci >= 0 ? Number.parseInt(args[ci + 1] ?? '', 10) : 250000;

  const cfg = await loadIntakeConfig(configPath);
  const app = await bootstrap();
  const key = app.env.configVars.get(cfg.rpcKeyVar);
  if (!key) throw new Error(`${cfg.rpcKeyVar} is not set in this process`);
  const rpc = new RpcClient(cfg.rpcUrlTemplate.replace('{key}', key),
    cfg.requestTimeoutMs, ceiling);

  const c = await app.pool.connect();
  try {
    const stored = await c.query<{ detail: unknown }>(
      `select detail from token_intake_state
        where chain=$1 and token=$2 and phase='windows:resolved'`,
      [cfg.chain, cfg.token],
    );
    const resolved = (stored.rows[0]?.detail ?? []) as typeof cfg.windows;
    if (!resolved.length) throw new Error('no resolved windows stored; run the windows phase');
    const windows = wantWindow ? resolved.filter((w) => w.label === wantWindow) : resolved;
    if (!windows.length) throw new Error(`no window labelled ${String(wantWindow)}`);

    const pools = await loadPools(c, cfg.chain, cfg.token);
    if (pools.size === 0) throw new Error('no in-scope pools stored; run the scope phase');

    /* ---- sign conventions, from everything stored -------------------------- */
    /*
     * PAIR A SWAP WITH ITS OWN TRANSFER, OR PAIR NOTHING.
     *
     * A first attempt joined any transfer in the transaction whose sender was
     * the counterparty. On v4 EVERY pool shares the PoolManager as its
     * counterparty, so in a transaction holding two v4 swaps each swap joined
     * both transfers, and a buy on one pool paired with a sell on another
     * produced a false disagreement -- 5,426 of them, 8.3%.
     *
     * The pairing is only unambiguous where the transaction holds exactly one
     * swap and exactly one qualifying transfer. That is a smaller sample and a
     * sound one; the alternative is a large unsound one. Transactions with more
     * are counted and reported, never silently dropped.
     */
    /*
     * MATERIALISE, THEN JOIN -- the same lesson as router detection, which ran
     * 19 minutes as one statement and 5 seconds once its inputs were indexed
     * temp tables. Expressed as CTEs this ran 17 minutes and was cancelled.
     *
     * A ROUND TRIP IS NOT A TRADE, AND IT IS NOT A CONVENTION DIFFERENCE.
     * Counting only transfers OUT of the counterparty made an arbitrage hop
     * look unambiguous: the PoolManager sends the token to a bot and the
     * identical amount comes straight back in the same transaction, so there is
     * one outbound leg and the pairing looks clean while the swap being paired
     * is the other side of the round trip. tradeLegs already drops these; this
     * check missed them because it reimplemented "who traded" instead of
     * sharing the rule. Legs are counted in BOTH directions here.
     */
    /*
     * NOT "on commit drop": this client autocommits, so the table would be
     * created and dropped by the same statement. It dies with the session
     * instead. The router path can use that clause only because its phase runs
     * inside a transaction.
     */
    await c.query(`create temp table if not exists _tok (
      venue text, tx_hash text, block_number bigint, tok_amt numeric, counterparty text
    )`);
    await c.query('truncate _tok');
    await c.query(
      `insert into _tok
       select s.venue, s.tx_hash, s.block_number,
              case when m.pons_side = 0 then s.amount0 else s.amount1 end,
              case when s.venue = 'v3' then m.pool else $3 end
         from token_swap_logs s
         join pool_meta m on m.chain=s.chain and m.token=s.token
                         and m.venue=s.venue and m.pool=s.pool
        where s.chain=$1 and s.token=$2`,
      [cfg.chain, cfg.token, cfg.v4PoolManager.toLowerCase()],
    );
    await c.query('create index if not exists _tok_tx on _tok (tx_hash)');
    await c.query('analyze _tok');

    /*
     * THE "ONE SWAP" TEST MUST COUNT EVERY SWAP OF THE TOKEN, not only the
     * in-scope ones. A multi-hop router transaction can swap the token on an
     * in-scope pool AND on a rejected one; counting only the first makes the
     * transaction look unambiguous while the single transfer out of the
     * counterparty belongs to the other swap. That produced INDEX's two
     * remaining disagreements out of 96,459 -- both multi-hop, both on pool
     * 0x51d1a403..., both pairing a transfer that was never that swap's output.
     */
    await c.query(`create temp table if not exists _alltok (tx_hash text, n int)`);
    await c.query('truncate _alltok');
    await c.query(
      `insert into _alltok
       select tx_hash, count(*) from token_swap_logs
        where chain=$1 and token=$2 group by tx_hash`,
      [cfg.chain, cfg.token],
    );
    await c.query('create index if not exists _alltok_tx on _alltok (tx_hash)');
    await c.query('analyze _alltok');

    /*
     * AND EVERY v4 SWAP ON THE CHAIN, where `v4_swaps_all` covers the block.
     *
     * Counting only the token's OWN stored swaps still missed multi-hop
     * transactions in which the token is an INTERMEDIATE: the router buys it on
     * one pool and sells it on another, and the legs on pools whose swaps were
     * never collected are invisible. The single transfer out of the PoolManager
     * is then the route's final output, not that swap's, and pairing them reads
     * as a convention disagreement.
     *
     * PONS had three such cases in 120,721 pairs -- 0.0025% -- and decoding two
     * of them showed four v4 swaps across four pools in one transaction.
     * `v4_swaps_all` holds every v4 swap on the chain for the blocks it covers,
     * so it can see what the token's own table cannot. Outside that range the
     * test falls back to the token's own count and says so.
     */
    await c.query(`create temp table if not exists _allv4 (tx_hash text primary key, n int)`);
    await c.query('truncate _allv4');
    await c.query(
      `insert into _allv4
       select v.tx_hash, count(*) from v4_swaps_all v
        where v.chain = $1
          and v.tx_hash in (select tx_hash from _tok)
        group by v.tx_hash`,
      [cfg.chain],
    );
    await c.query('analyze _allv4');

    await c.query(`create temp table if not exists _legs (
      tx_hash text primary key, out_legs int, touching int
    )`);
    await c.query('truncate _legs');
    await c.query(
      `insert into _legs
       select t.tx_hash,
              count(*) filter (where m.from_addr = t.cp and m.to_addr <> t.cp),
              count(*) filter (where m.from_addr = t.cp or m.to_addr = t.cp)
         from (select distinct tx_hash, counterparty cp from _tok) t
         join token_transfer_logs m on m.chain=$1 and m.token=$2 and m.tx_hash=t.tx_hash
        group by t.tx_hash`,
      [cfg.chain, cfg.token],
    );
    await c.query('analyze _legs');

    await c.query('create temp table if not exists _wins (lo bigint, hi bigint)');
    await c.query('truncate _wins');
    for (const w of windows) {
      await c.query('insert into _wins values ($1,$2)', [w.startBlock, w.endBlock]);
    }
    await c.query('analyze _wins');

    const conv = await c.query<{
      venue: string; region: string; agree: string; disagree: string; ambiguous: string;
    }>(
      `with spt as (select tx_hash, n from _alltok)
       select k.venue,
              /*
               * Regions are labelled against EVERY window, not just the first.
               * With one window "before/in-window/after" is exact; with two it
               * was labelling P2's swaps "after" because it compared against
               * P1's bounds alone. Step 6 wants the check measured inside and
               * outside the windows, so a swap inside ANY window is in-window.
               */
              case when exists (select 1 from _wins w
                                 where k.block_number between w.lo and w.hi) then 'in-window'
                   when k.block_number < (select min(lo) from _wins) then 'before'
                   else 'outside-a-window' end as region,
              count(*) filter (where spt.n = 1 and l.touching = 1 and l.out_legs = 1
                and coalesce(av.n, 1) = 1 and (
                (k.venue='v3' and k.tok_amt < 0) or (k.venue='v4' and k.tok_amt > 0)))::text as agree,
              count(*) filter (where spt.n = 1 and l.touching = 1 and l.out_legs = 1
                and coalesce(av.n, 1) = 1 and (
                (k.venue='v3' and k.tok_amt > 0) or (k.venue='v4' and k.tok_amt < 0)))::text as disagree,
              count(*) filter (where spt.n > 1 or l.touching > 1
                or coalesce(av.n, 1) > 1)::text as ambiguous
         from _tok k
         join spt on spt.tx_hash = k.tx_hash
         join _legs l on l.tx_hash = k.tx_hash
         left join _allv4 av on av.tx_hash = k.tx_hash
        where l.out_legs >= 1
        group by 1,2 order by 1,2`,
      [],
    );
    log.info('sign conventions, measured on STORED data', {
      expectation: 'v3 = POOL perspective (pool sent the token => negative); '
        + 'v4 = SWAPPER perspective (swapper received => positive)',
      paired_only_where_unambiguous: 'one swap and one qualifying transfer in the transaction',
      rows: conv.rows,
    });
    const bad = conv.rows.filter((r) => Number(r.disagree) > 0);
    if (bad.length) {
      throw new Error(
        `sign convention disagrees on ${JSON.stringify(bad)}. Step 6: assuming one `
          + 'convention for both venues inverts every v4 buy into a sell. Stopping.',
      );
    }

    /* ---- the cohort -------------------------------------------------------- */
    const configured = (await loadExclusions(INFRA, cfg.chain)).map((e) => e.address);
    const eff = await effectiveExclusions(c, cfg.chain, cfg.token, configured);
    log.info('exclusions in force', {
      from_config: eff.fromConfig, from_behaviour: eff.fromBehaviour, total: eff.addresses.size,
    });

    for (const w of windows) {
      const before = rpc.cuSpent;
      const r = await buildCohort(c, rpc, cfg, w, pools, eff.addresses);
      log.info('COHORT', {
        window: r.window, blocks: `${r.startBlock}..${r.endBlock}`,
        raw_candidate_wallets: r.rawBuyers,
        excluded_infrastructure_or_router: r.excludedByInfrastructure,
        excluded_round_trippers: r.excludedAsRoundTrippers,
        excluded_is_a_pool: r.excludedAsPools,
        candidate_wallets_for_payment: r.candidateWalletsForPayment,
        proven_free_from_payment_logs: r.walletsProvenFree,
        proven_by_rpc: r.walletsProvenByRpc,
        no_payment_in_any_transaction: r.walletsWithNoPaymentInAnyTransaction,
        code_checked: r.codeChecked,
        excluded_as_contracts: r.excludedAsContracts,
        delegated_eip7702_KEPT: r.delegatedEip7702,
        COHORT_SIZE: r.cohort.length,
        exclusion_entries_that_matched_nothing: r.unusedExclusions,
        payment_transactions_read: r.paymentTransactionsRead,
        payment_receipts_read: r.paymentReceiptsRead,
        payment_cu: r.paymentCu,
        window_cu: rpc.cuSpent - before,
      });
      await c.query(
        `insert into token_intake_state (chain, token, phase, status, detail)
         values ($1,$2,$3,'complete',$4::jsonb)
         on conflict (chain, token, phase) do update set detail = excluded.detail`,
        [cfg.chain, cfg.token, `cohort:${r.window}`, JSON.stringify(r.cohort)],
      );
    }
    log.info('cost', {
      cu_spent: rpc.cuSpent, dollars: ((rpc.cuSpent * 0.45) / 1e6).toFixed(4), ceiling,
      note: 'wallet_tags NOT written -- step 7 stops here for review',
    });
  } finally {
    c.release();
  }
  await app.pool.end();
  process.exit(0);
}

main().catch((err) => { log.error('build-cohort failed', errorFields(err)); process.exit(1); });

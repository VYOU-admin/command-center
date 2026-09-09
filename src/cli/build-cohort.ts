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
    const conv = await c.query<{
      venue: string; region: string; agree: string; disagree: string;
    }>(
      `with tok as (
         select s.venue, s.tx_hash, s.block_number,
                -- pons_side, not token_side: named for the first token loaded,
                -- like pons_usd in the price tables. Renaming either is a
                -- migration, not a config change.
                case when m.pons_side = 0 then s.amount0 else s.amount1 end as tok_amt,
                case when s.venue = 'v3' then m.pool else $3 end as counterparty
           from token_swap_logs s
           join pool_meta m on m.chain=s.chain and m.token=s.token
                           and m.venue=s.venue and m.pool=s.pool
          where s.chain=$1 and s.token=$2),
       moved as (
         select t.tx_hash, t.from_addr, t.to_addr
           from token_transfer_logs t where t.chain=$1 and t.token=$2)
       select tok.venue,
              case when tok.block_number between $4 and $5 then 'in-window'
                   when tok.block_number < $4 then 'before' else 'after' end as region,
              count(*) filter (where
                (tok.venue='v3' and tok.tok_amt < 0) or (tok.venue='v4' and tok.tok_amt > 0)
              )::text as agree,
              count(*) filter (where
                (tok.venue='v3' and tok.tok_amt > 0) or (tok.venue='v4' and tok.tok_amt < 0)
              )::text as disagree
         from tok
         join moved on moved.tx_hash = tok.tx_hash
                   and moved.from_addr = tok.counterparty
                   and moved.to_addr <> tok.counterparty
        group by 1, 2 order by 1, 2`,
      [cfg.chain, cfg.token, cfg.v4PoolManager.toLowerCase(),
        windows[0]!.startBlock, windows[0]!.endBlock],
    );
    log.info('sign conventions, measured on STORED data', {
      expectation: 'v3 = POOL perspective (pool sent the token => negative); '
        + 'v4 = SWAPPER perspective (swapper received => positive)',
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

/**
 * `npm run write-rows -- <config.yaml> [--window LABEL] [--commit] [--reinsert]`
 *
 * Tags the reviewed cohort and writes its rows. Steps 8, 9, 11 and 12 in one
 * tool, because the runner reaches them only past the sweep phase, which would
 * re-sweep logs already stored.
 *
 * DRY RUN BY DEFAULT: the plan is built and reported and nothing is written,
 * which is step 11. `--commit` turns the same pass into the write, so the two
 * cannot drift apart.
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { loadIntakeConfig } from '../intake/plan.js';
import { RpcClient } from '../adapters/token-updates/rpc.js';
import { loadPools } from '../adapters/token-updates/pools.js';
import { loadExclusions } from '../adapters/token-updates/exclusions.js';
import { effectiveExclusions } from '../intake/routers.js';
import { writeTags } from '../intake/cohort.js';
import { loadBridgeUsd, planOrWrite } from '../intake/write.js';

const INFRA = 'config/infrastructure.yaml';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const configPath = args.find((a) => !a.startsWith('--'));
  if (!configPath) throw new Error('usage: write-rows <config.yaml> [--commit]');
  const commit = args.includes('--commit');
  const reinsert = args.includes('--reinsert');
  const wi = args.indexOf('--window');
  const only = wi >= 0 ? args[wi + 1] : undefined;

  const cfg = await loadIntakeConfig(configPath);
  const app = await bootstrap();
  const key = app.env.configVars.get(cfg.rpcKeyVar);
  if (!key) throw new Error(`${cfg.rpcKeyVar} is not set in this process`);
  const rpc = new RpcClient(cfg.rpcUrlTemplate.replace('{key}', key), cfg.requestTimeoutMs, 0);

  const c = await app.pool.connect();
  try {
    const wres = await c.query<{ detail: unknown }>(
      `select detail from token_intake_state
        where chain=$1 and token=$2 and phase='windows:resolved'`, [cfg.chain, cfg.token]);
    const resolved = (wres.rows[0]?.detail ?? []) as typeof cfg.windows;
    const windows = only ? resolved.filter((w) => w.label === only) : resolved;
    if (!windows.length) throw new Error('no resolved windows stored');

    const decimals = (await c.query<{ decimals: number }>(
      `select decimals from tokens where mint=$1`, [cfg.token])).rows[0]?.decimals;
    if (typeof decimals !== 'number') throw new Error('token decimals unknown');
    const pools = await loadPools(c, cfg.chain, cfg.token);

    /* ---- step 8: tags ------------------------------------------------------ */
    for (const w of windows) {
      const cres = await c.query<{ detail: unknown }>(
        `select detail from token_intake_state
          where chain=$1 and token=$2 and phase=$3`,
        [cfg.chain, cfg.token, `cohort:${w.label}`]);
      const cohort = (cres.rows[0]?.detail ?? []) as string[];
      if (!cohort.length) throw new Error(`no reviewed cohort stored for ${w.label}`);
      log.info('cohort loaded from review', { window: w.label, wallets: cohort.length });
      if (commit) {
        const t = await writeTags(c, cfg, w, cohort, true);
        log.info('tags written', { window: w.label, ...t });
      } else {
        log.info('tags NOT written (dry run)', { window: w.label, would_tag: cohort.length });
      }
    }

    /* ---- steps 11 and 12: the rows ----------------------------------------- */
    const cohortRows = await c.query<{ wallet: string }>(
      `select distinct wallet from wallet_tags where mint=$1`, [cfg.token]);
    const cohortSet = new Set(cohortRows.rows.map((r) => r.wallet.toLowerCase()));
    log.info('cohort as stored in wallet_tags', { wallets: cohortSet.size });

    const first = Math.min(...windows.map((w) => w.startBlock!));
    const last = await c.query<{ hi: string }>(
      `select max(block_number)::text hi from token_swap_logs where chain=$1 and token=$2`,
      [cfg.chain, cfg.token]);
    const head = Number(last.rows[0]!.hi);
    const bridgeUsd = await loadBridgeUsd(c, cfg);
    const configured = (await loadExclusions(INFRA, cfg.chain)).map((e) => e.address);
    const eff = await effectiveExclusions(c, cfg.chain, cfg.token, configured);

    const { plan, stored, deleted } = await planOrWrite(
      c, cfg, pools, decimals, cohortSet, eff.addresses,
      first, head, commit, bridgeUsd, reinsert,
    );
    log.info(commit ? 'WRITTEN' : 'DRY RUN', {
      blocks: `${first}..${head}`, ...plan, stored, deleted,
      bridge_series_loaded: bridgeUsd.size,
    });
    if (!commit) log.info('nothing written; pass --commit', {});
  } finally {
    c.release();
  }
  await app.pool.end();
  process.exit(0);
}

main().catch((err) => { log.error('write-rows failed', errorFields(err)); process.exit(1); });

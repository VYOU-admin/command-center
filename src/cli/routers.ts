/**
 * `npm run routers -- <config.yaml> [--window N]`
 *
 * Reports which addresses behave like routers for a token, and compares that
 * against the hand-typed list in config/infrastructure.yaml. READ ONLY: it
 * writes nothing, and its only RPC is one eth_getCode per address that clears
 * the recipient bar.
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { loadIntakeConfig } from '../intake/plan.js';
import { RpcClient } from '../adapters/token-updates/rpc.js';
import { loadPools } from '../adapters/token-updates/pools.js';
import { loadExclusions } from '../adapters/token-updates/exclusions.js';
import { compareToList, detectRouters } from '../intake/routers.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const configPath = args.find((a) => !a.startsWith('--'));
  if (!configPath) throw new Error('usage: routers <config.yaml> [--window N]');
  const wIdx = args.indexOf('--window');
  const windowIndex = wIdx >= 0 ? Number.parseInt(args[wIdx + 1] ?? '0', 10) : 0;

  const cfg = await loadIntakeConfig(configPath);
  const app = await bootstrap();
  const key = app.env.configVars.get(cfg.rpcKeyVar);
  if (!key) throw new Error(`${cfg.rpcKeyVar} is not set in this process`);
  const rpc = new RpcClient(
    cfg.rpcUrlTemplate.replace('{key}', key), cfg.requestTimeoutMs, cfg.ceilings.scope,
  );

  const client = await app.pool.connect();
  try {
    const pools = await loadPools(client, cfg.chain, cfg.token);
    const v3 = [...pools.values()].filter((p) => p.venue === 'v3').map((p) => p.pool);
    const exclusions = await loadExclusions('config/infrastructure.yaml', cfg.chain);

    const w = cfg.windows[windowIndex];
    if (!w) throw new Error(`no window at index ${windowIndex}`);
    const bounds = await client.query<{ lo: number; hi: number }>(
      `select min(block_number) lo, max(block_number) hi from block_times
        where chain = $1 and block_time between $2::timestamptz and $3::timestamptz`,
      [cfg.chain, w.start, w.end],
    );
    const lo = Number(bounds.rows[0]?.lo);
    const hi = Number(bounds.rows[0]?.hi);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      throw new Error('no stored block_times cover this window; cannot bound the scan');
    }
    const head = await rpc.blockNumber();

    log.info('router detection', {
      token: cfg.token, window: w.label, blocks: `${lo}..${hi}`,
      v3_pools: v3.length, configured_list: exclusions.length,
      min_recipients: cfg.routerMinRecipients, min_swap_share: cfg.routerMinSwapShare,
    });

    const { candidates, probed } = await detectRouters(
      client, rpc, cfg, v3, lo, hi, head,
    );
    for (const c of candidates.slice(0, 25)) {
      log.info(c.isRouter ? 'ROUTER' : 'not a router', {
        address: c.address, recipients: c.recipients, sends: c.sends,
        in_swap_tx: c.sendsInSwapTx, swap_share_pct: Number((100 * c.swapShare).toFixed(1)),
        kind: c.kind, reason: c.reason,
      });
    }
    const versus = compareToList(candidates, exclusions.map((e) => e.address));
    log.info('behaviour versus the configured list', {
      addresses_examined: candidates.length,
      eth_getCode_calls: probed,
      identified_as_routers: candidates.filter((c) => c.isRouter).length,
      in_behaviour_not_in_config: versus.onlyBehavioural,
      in_config_not_in_behaviour: versus.onlyConfigured,
      in_both: versus.both,
      cu_spent: rpc.cuSpent,
    });
  } finally {
    client.release();
  }
  await app.pool.end();
  process.exit(0);
}

main().catch((err) => {
  log.error('routers failed', errorFields(err));
  process.exit(1);
});

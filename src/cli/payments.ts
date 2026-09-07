/**
 * `npm run payments -- <config.yaml> [--window N] [--estimate]`
 *
 * Sweeps who paid a pool, into `token_payment_logs`. See docs/ROBINHOOD.md
 * step 7: a buy has two halves, and the token's own transfers prove only the
 * first. This collects the second.
 *
 * One `eth_getLogs` per pricing asset with every pool counterparty as a topic
 * array, so the cost is per asset rather than per pool. `--estimate` reports the
 * call count and CU and writes nothing.
 *
 * Native ETH moves without a Transfer log and cannot be collected this way.
 * That limitation is recorded in ROBINHOOD.md section 9 and the affected pools
 * are counted here rather than silently omitted.
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { loadIntakeConfig } from '../intake/plan.js';
import { RpcClient } from '../adapters/token-updates/rpc.js';
import { loadPools } from '../adapters/token-updates/pools.js';
import { TOPICS, addressTopic, decodeTransfer } from '../adapters/token-updates/decode.js';
import { adaptiveSweep } from '../intake/sweep.js';
import { SCHEMA } from '../adapters/token-updates/schema.js';
import { withTransaction } from '../store/db.js';

const ZERO = '0x0000000000000000000000000000000000000000';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const configPath = args.find((a) => !a.startsWith('--'));
  if (!configPath) throw new Error('usage: payments <config.yaml> [--window N] [--estimate]');
  const wIdx = args.indexOf('--window');
  const windowIndex = wIdx >= 0 ? Number.parseInt(args[wIdx + 1] ?? '0', 10) : 0;
  const estimateOnly = args.includes('--estimate');

  const cfg = await loadIntakeConfig(configPath);
  const app = await bootstrap();
  await withTransaction(app.pool, (c) => c.query(SCHEMA).then(() => undefined));
  const key = app.env.configVars.get(cfg.rpcKeyVar);
  if (!key) throw new Error(`${cfg.rpcKeyVar} is not set in this process`);
  const rpc = new RpcClient(
    cfg.rpcUrlTemplate.replace('{key}', key), cfg.requestTimeoutMs, cfg.ceilings.sweep,
  );

  const client = await app.pool.connect();
  try {
    const pools = await loadPools(client, cfg.chain, cfg.token);
    if (pools.size === 0) throw new Error('no pools stored for this token');
    const counterparties = [...new Set([
      ...[...pools.values()].filter((p) => p.venue === 'v3').map((p) => p.pool),
      cfg.v4PoolManager.toLowerCase(),
    ])];
    const assets = [...new Set([...pools.values()].map((p) => p.counter))];
    const payable = assets.filter((a) => a !== ZERO);
    const nativePools = [...pools.values()].filter((p) => p.counter === ZERO).length;

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
      throw new Error('no stored block_times cover this window');
    }

    const spans = Math.ceil((hi - lo + 1) / cfg.maxLogSpanBlocks);
    log.info('payment sweep plan', {
      window: w.label, blocks: `${lo}..${hi}`, block_count: hi - lo + 1,
      counterparties: counterparties.length,
      assets_with_transfer_logs: payable.length,
      pools_quoted_in_native_eth: nativePools,
      note_native: 'native ETH moves with no Transfer log; those pools cannot be covered',
      minimum_calls: spans * payable.length,
      minimum_cu: spans * payable.length * 60,
      estimate_only: estimateOnly,
    });
    if (estimateOnly) { client.release(); await app.pool.end(); process.exit(0); }

    let total = 0;
    for (const asset of payable) {
      const st = await adaptiveSweep(
        rpc, cfg,
        { address: asset, topics: [TOPICS.transfer, null, counterparties.map(addressTopic)] },
        lo, hi,
        async (logs) => {
          for (const l of logs) {
            const d = decodeTransfer(l);
            await client.query(
              `insert into token_payment_logs
                 (chain, token, tx_hash, payer, asset, amount, block_number)
               values ($1,$2,$3,$4,$5,$6,$7) on conflict do nothing`,
              [cfg.chain, cfg.token, d.txHash, d.from, asset, d.amount.toString(), d.block],
            );
          }
        },
      );
      total += st.logs;
      log.info('asset swept', {
        asset, logs: st.logs, requests: st.requests,
        size_refusals: st.sizeRefusals, rate_refusals: st.rateRefusals,
        cu_so_far: rpc.cuSpent,
      });
    }
    log.info('payment sweep complete', {
      payment_legs: total, cu_spent: rpc.cuSpent, calls: rpc.callCounts(),
    });
  } finally {
    client.release();
  }
  await app.pool.end();
  process.exit(0);
}

main().catch((err) => { log.error('payments failed', errorFields(err)); process.exit(1); });

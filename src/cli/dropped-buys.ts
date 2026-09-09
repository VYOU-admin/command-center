/**
 * `npm run dropped-buys -- <config.yaml> --from N --to M [--ceiling C]`
 *
 * How many buys did the rejected payment rule drop?
 *
 * The hourly job ran 47 cycles applying a rule that was later measured to
 * reject 39 of 40 real buyers. Its rows are incomplete rather than wrong. This
 * measures the size of what was lost, exactly, rather than inferring it from a
 * sample: it re-reads the logs for the range the job covered, builds the legs
 * the CURRENT rule produces -- rows carry no payment test, see
 * docs/ROBINHOOD.md step 7 -- and compares them against the rows actually in
 * `wallet_transactions`.
 *
 * READ ONLY. It fetches logs, writes nothing, and moves no cursor. The raw logs
 * are deliberately not stored either: the hourly job never stored them, and
 * storing them here would change what a later reader thinks was collected.
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { loadIntakeConfig } from '../intake/plan.js';
import { RpcClient, type LogEntry } from '../adapters/token-updates/rpc.js';
import { loadPools } from '../adapters/token-updates/pools.js';
import { adaptiveSweep } from '../intake/sweep.js';
import { tradeLegs } from '../adapters/token-updates/rows.js';
import { loadExclusions } from '../adapters/token-updates/exclusions.js';
import {
  TOPICS, addressTopic, blockOf, decodeSwap, decodeTransfer,
  type SwapLog, type TransferLog,
} from '../adapters/token-updates/decode.js';
import type { PoolRow } from '../adapters/token-updates/pools.js';

const INFRA = 'config/infrastructure.yaml';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const configPath = args.find((a) => !a.startsWith('--'));
  if (!configPath) throw new Error('usage: dropped-buys <config.yaml> --from N --to M');
  const num = (flag: string, d: number): number => {
    const i = args.indexOf(flag);
    return i >= 0 ? Number.parseInt(args[i + 1] ?? String(d), 10) : d;
  };
  const from = num('--from', 0);
  const to = num('--to', 0);
  const ceiling = num('--ceiling', 60000);
  if (!from || !to || to <= from) throw new Error('--from and --to are required');

  const cfg = await loadIntakeConfig(configPath);
  const app = await bootstrap();
  const key = app.env.configVars.get(cfg.rpcKeyVar);
  if (!key) throw new Error(`${cfg.rpcKeyVar} is not set in this process`);
  const rpc = new RpcClient(cfg.rpcUrlTemplate.replace('{key}', key),
    cfg.requestTimeoutMs, ceiling);

  const c = await app.pool.connect();
  try {
    const pools = await loadPools(c, cfg.chain, cfg.token);
    const byPool = new Map<string, PoolRow>();
    for (const p of pools.values()) byPool.set(p.pool.toLowerCase(), p);
    const v3 = [...new Set([...pools.values()].filter((p) => p.venue === 'v3')
      .map((p) => p.pool.toLowerCase()))];
    const v4Ids = [...new Set([...pools.values()].filter((p) => p.venue === 'v4')
      .map((p) => p.pool.toLowerCase()))];
    const pm = cfg.v4PoolManager.toLowerCase();
    const knownPools = new Set([...byPool.keys(), pm]);

    const exclusions = new Set(
      (await loadExclusions(INFRA, cfg.chain)).map((e) => e.address),
    );
    const cohort = new Set(
      (await c.query<{ wallet: string }>(
        `select wallet from wallet_tags where mint = $1`, [cfg.token],
      )).rows.map((r) => r.wallet.toLowerCase()),
    );

    log.info('measuring', {
      blocks: `${from}..${to}`, span: to - from + 1,
      v3_pools: v3.length, v4_pools: v4Ids.length, cohort: cohort.size, ceiling,
    });

    const swaps: { swap: SwapLog; pool: PoolRow }[] = [];
    const transfers: TransferLog[] = [];
    let requests = 0;

    const takeSwaps = (venue: 'v3' | 'v4') => async (logs: LogEntry[]): Promise<void> => {
      for (const l of logs) {
        const s = decodeSwap(l, venue);
        const p = byPool.get(venue === 'v3' ? s.pool.toLowerCase() : s.pool.toLowerCase());
        if (p) swaps.push({ swap: s, pool: p });
      }
    };

    if (v3.length) {
      const st = await adaptiveSweep(rpc, cfg,
        { address: v3, topics: [TOPICS.swapV3] }, from, to, takeSwaps('v3'));
      requests += st.requests;
    }
    if (v4Ids.length) {
      const st = await adaptiveSweep(rpc, cfg,
        { address: pm, topics: [TOPICS.swapV4, v4Ids] }, from, to, takeSwaps('v4'));
      requests += st.requests;
    }
    const st = await adaptiveSweep(rpc, cfg,
      { address: cfg.token, topics: [TOPICS.transfer] }, from, to,
      async (logs) => { for (const l of logs) transfers.push(decodeTransfer(l)); },
      cfg.maxLogSpanBlocks);
    requests += st.requests;

    log.info('logs read', {
      swaps: swaps.length, transfers: transfers.length, requests,
      cu_spent: rpc.cuSpent,
    });

    const { legs, stats } = tradeLegs(
      swaps, transfers, cfg, () => null, exclusions, knownPools,
    );
    const buys = legs.filter((l) => l.side === 'buy' && cohort.has(l.wallet));
    const sells = legs.filter((l) => l.side === 'sell' && cohort.has(l.wallet));
    const key2 = (l: { txHash: string; wallet: string }): string => `${l.txHash}:${l.wallet}`;

    const stored = await c.query<{ side: string; tx_hash: string; wallet: string }>(
      `select side, tx_hash, wallet from wallet_transactions
        where chain=$1 and token=$2 and block_number between $3 and $4`,
      [cfg.chain, cfg.token, from, to],
    );
    const storedBuys = new Set(stored.rows.filter((r) => r.side === 'buy').map(key2 as never));
    const storedSells = new Set(stored.rows.filter((r) => r.side === 'sell').map(key2 as never));

    const missingBuys = buys.filter((l) => !storedBuys.has(key2(l)));
    const missingSells = sells.filter((l) => !storedSells.has(key2(l)));

    log.info('WHAT THE 47 CYCLES DROPPED', {
      blocks: `${from}..${to}`,
      buy_legs_the_correct_rule_produces: buys.length,
      buy_rows_actually_written: storedBuys.size,
      BUYS_DROPPED: missingBuys.length,
      dropped_share: buys.length
        ? `${((100 * missingBuys.length) / buys.length).toFixed(1)}%` : 'NO BUY LEGS FOUND',
      distinct_wallets_affected: new Set(missingBuys.map((l) => l.wallet)).size,
      sell_legs_the_correct_rule_produces: sells.length,
      sell_rows_actually_written: storedSells.size,
      SELLS_DROPPED: missingSells.length,
      note: 'sells were never payment-tested, so a non-zero sell figure means '
          + 'something other than the payment rule is also dropping rows',
    });
    log.info('leg stats', { ...stats });
    log.info('cost', {
      requests, cu_spent: rpc.cuSpent,
      dollars: ((rpc.cuSpent * 0.45) / 1e6).toFixed(4), ceiling,
    });
  } finally {
    c.release();
  }
  await app.pool.end();
  process.exit(0);
}

main().catch((err) => { log.error('dropped-buys failed', errorFields(err)); process.exit(1); });

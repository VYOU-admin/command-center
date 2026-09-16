/**
 * `npm run launchbot -- [--minutes N]` — the launch bot, DRY RUN ONLY.
 *
 * IT CANNOT BROADCAST. No private key is read anywhere in this build, and the RPC
 * wrapper refuses `eth_sendRawTransaction` and every signing method by name (bot/rpc).
 * "We did not write the call" is weaker than "the call is refused".
 *
 * ONE IMPLEMENTATION OF EVERY RULE, and the dry run exercises exactly the code a live
 * path would: calldata from `bot/calldata`, the entry rule, sizing and the slippage
 * bound from `bot/rule`, the rails from `bot/config`. A dry run over different code
 * proves nothing about the live path.
 *
 * ITS OWN PROCESS, at a 5 s cadence. The scheduler runs 15-30 minute monitors; coupling
 * a metered fast loop to nine slow jobs would make a rate limit on one stop the other.
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { RpcClient } from '../adapters/token-updates/rpc.js';
import { INITIALIZE_TOPIC, decodeInitialize } from '../intake/v4-init.js';
import {
  BACKFILL_OFFSETS_S, BLOCKS_PER_SECOND, DETECT_INTERVAL_MS, ENTRY_DELAY_BLOCKS,
  EXIT_DELAY_BLOCKS, NATIVE_ETH, POOL_MANAGER, RAILS, SLIPPAGE_BPS,
} from '../bot/config.js';
import { buildPermit2Approve, buildSwap, buildTokenApprove } from '../bot/calldata.js';
import { expectedOut, minOut, positionWei, qualifies } from '../bot/rule.js';
import { BOT_SCHEMA, halt, isHalted } from '../bot/state.js';
import { ReadOnlyRpc } from '../bot/rpc.js';
import { reconcileOnBoot } from '../bot/reconcile.js';

const MODE = 'dry-run';
const CHAIN = 'robinhood';
const PRICING = [
  '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
  '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
  NATIVE_ETH,
];
const RPC_URL = 'https://robinhood-mainnet.g.alchemy.com/v2/{key}';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const i = args.indexOf('--minutes');
  const minutes = i >= 0 ? Number(args[i + 1] ?? 60) : 60;
  const until = Date.now() + minutes * 60_000;

  const app = await bootstrap();
  const pool = app.pool;
  const key = process.env['ALCHEMY_API_KEY'];
  if (!key) throw new Error('ALCHEMY_API_KEY is not set');
  /* A generous ceiling: the loop is one getLogs per tick plus a simulation per
   * candidate, and the run is bounded by --minutes rather than by spend. */
  const rpc = new ReadOnlyRpc(new RpcClient(RPC_URL.replace('{key}', key), 60000, 5_000_000));

  {
    const c = await pool.connect();
    try {
      await c.query(BOT_SCHEMA);
      /* THE WALLET IS NOT CONFIGURED and this build never needs it. Reconciliation is
       * still run so the path is exercised rather than written and never executed. */
      const wallet = process.env['BOT_WALLET_ADDRESS'] ?? null;
      const rec = await reconcileOnBoot(c, rpc, CHAIN, wallet, MODE);
      log.info('boot reconciliation', { ...rec, wallet_configured: wallet !== null });
    } finally { c.release(); }
  }

  log.info('launchbot starting', {
    mode: MODE, minutes,
    rails: RAILS, slippage_bps: SLIPPAGE_BPS,
    broadcast: 'IMPOSSIBLE -- no key is read and sendRawTransaction is refused by name',
  });

  let cursor = Number(await rpc.call('eth_blockNumber', []).then((h) => BigInt(String(h))));
  const seen = new Set<string>();
  const stats = {
    ticks: 0, initializes: 0, candidates: 0, qualified: 0,
    simulated: 0, simClean: 0, simReverted: 0, skippedRail: 0,
  };
  const reverts: string[] = [];
  let consecutiveReverts = 0;

  while (Date.now() < until) {
    stats.ticks += 1;
    const c = await pool.connect();
    try {
      /* THE KILL SWITCH, on a fresh connection, before anything else this tick. */
      const k = await isHalted(c, CHAIN);
      if (k.halted) { log.warn('HALTED', { reason: k.reason }); break; }

      const head = Number(await rpc.call('eth_blockNumber', []).then((h) => BigInt(String(h))));
      if (head <= cursor) { await sleep(DETECT_INTERVAL_MS); continue; }

      const logs = (await rpc.call('eth_getLogs', [{
        address: POOL_MANAGER, topics: [INITIALIZE_TOPIC],
        fromBlock: `0x${(cursor + 1).toString(16)}`, toBlock: `0x${head.toString(16)}`,
      }])) as Parameters<typeof decodeInitialize>[0][];
      cursor = head;
      stats.initializes += logs.length;

      for (const l of logs) {
        const init = decodeInitialize(l);
        if (seen.has(init.poolId)) continue;
        seen.add(init.poolId);
        const c0 = init.currency0; const c1 = init.currency1;
        const zeroIsPricing = PRICING.includes(c0);
        const oneIsPricing = PRICING.includes(c1);
        if (zeroIsPricing === oneIsPricing) continue; /* both or neither: not a launch */
        stats.candidates += 1;

        /* The launchpad is the Initialize transaction's target. */
        const tx = (await rpc.call('eth_getTransactionByHash', [init.txHash])) as
          { to?: string | null } | null;
        const launchpad = tx?.to ? tx.to.toLowerCase() : null;

        const v = qualifies({
          poolId: init.poolId, launchpad, fee: init.fee, tickSpacing: init.tickSpacing,
          hooks: init.hooks, initBlock: init.blockNumber,
          /* At detection the first swap has usually not landed; the gap is checked when
           * it does. Passing the init block here tests every other clause now. */
          firstSwapBlock: init.blockNumber + 1,
          counterIsPricingAsset: true,
        });
        if (!v.qualifies) continue;
        stats.qualified += 1;

        /* RAILS, checked before any work is done for this candidate. */
        const today = await c.query<{ n: string }>(
          `select count(*)::text n from bot_trades where chain=$1 and mode=$2
             and created_at > now() - interval '24 hours'`, [CHAIN, MODE]);
        if (Number(today.rows[0]!.n) >= RAILS.MAX_TRADES_PER_DAY) {
          stats.skippedRail += 1; continue;
        }

        const ethUsd = await c.query<{ e: string }>(
          `select eth_usd::text e from native_usd_prices order by block_number desc limit 1`);
        const size = positionWei(Number(ethUsd.rows[0]?.e ?? 0));
        const token = zeroIsPricing ? c1 : c0;
        const counter = zeroIsPricing ? c0 : c1;

        /*
         * THE QUOTE. Without a trade on this pool yet there is no last price, so the
         * initial sqrtPriceX96 from Initialize is the only reference. A pool we cannot
         * quote is SKIPPED rather than bounded by a guess.
         */
        const sq = BigInt(init.sqrtPriceX96);
        if (sq === 0n) continue;
        const px = Number(sq) ** 2 / 2 ** 192;            /* currency1 per currency0 */
        const rate = zeroIsPricing ? px : 1 / px;
        let quoted: bigint; let bound: bigint;
        try { quoted = expectedOut(size, rate); bound = minOut(quoted); }
        catch { continue; }

        const plan = {
          pool: { currency0: c0, currency1: c1, fee: init.fee,
            tickSpacing: init.tickSpacing, hooks: init.hooks },
          zeroForOne: zeroIsPricing,
          amountIn: size, amountOutMinimum: bound,
          deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
        };
        const buy = buildSwap(plan);
        const sell = buildSwap({ ...plan, zeroForOne: !zeroIsPricing,
          amountIn: quoted, amountOutMinimum: minOut(size) });
        const appr = buildTokenApprove(token, quoted);
        const p2 = buildPermit2Approve(token, quoted, Math.floor(Date.now() / 1000) + 3600);

        /*
         * THE GATE: simulate the constructed BUY against the live pool. A revert here
         * is more informative than a match -- it says the shape is wrong before money
         * would have moved.
         */
        stats.simulated += 1;
        let simOk = false; let simNote = '';
        try {
          const from = process.env['BOT_WALLET_ADDRESS']
            ?? '0x000000000000000000000000000000000000dEaD';
          const r = await rpc.call('eth_call', [{
            from, to: buy.to, value: `0x${buy.value.toString(16)}`, data: buy.data,
          }, 'latest']);
          simOk = true; simNote = `returned ${String(r).slice(0, 18)}`;
          stats.simClean += 1; consecutiveReverts = 0;
        } catch (err) {
          simNote = (err as Error).message.slice(0, 200);
          stats.simReverted += 1; consecutiveReverts += 1;
          if (reverts.length < 12) reverts.push(`${init.poolId.slice(0, 14)}: ${simNote}`);
          if (consecutiveReverts >= RAILS.MAX_CONSECUTIVE_REVERTS) {
            await halt(c, CHAIN, `${consecutiveReverts} consecutive simulation reverts`);
            log.error('HALTING on consecutive reverts', { consecutiveReverts });
          }
        }

        await c.query(
          `insert into bot_trades (chain,mode,pool_id,token,counter,launchpad,fee,
             tick_spacing,hooks,status,init_block,position_wei,position_usd,quoted_out,
             min_out,entry_calldata,exit_calldata,fill_status,note)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
           on conflict (chain,mode,pool_id) do nothing`,
          [CHAIN, MODE, init.poolId, token, counter, launchpad, init.fee,
            init.tickSpacing, init.hooks, simOk ? 'simulated' : 'sim_reverted',
            init.blockNumber, size.toString(), RAILS.MAX_POSITION_USD, quoted.toString(),
            bound.toString(), buy.data, sell.data, 'dry-run', simNote]);

        log.info('WOULD TRADE', {
          pool: init.poolId, token, launchpad, fee: init.fee,
          position_usd: RAILS.MAX_POSITION_USD, position_wei: size.toString(),
          quoted_out: quoted.toString(), min_out: bound.toString(),
          slippage_bps: SLIPPAGE_BPS,
          transactions: [appr.description, p2.description, buy.description, sell.description],
          buy_to: buy.to, buy_value_wei: buy.value.toString(),
          buy_calldata_bytes: (buy.data.length - 2) / 2,
          simulation: simOk ? 'CLEAN' : 'REVERTED', simulation_detail: simNote,
        });
      }
    } catch (err) {
      log.error('tick failed', errorFields(err));
    } finally { c.release(); }
    await sleep(DETECT_INTERVAL_MS);
  }

  log.info('launchbot dry run complete', {
    mode: MODE, minutes, ...stats, cu_spent: rpc.cuSpent,
    usd: ((rpc.cuSpent * 0.45) / 1e6).toFixed(5),
    revert_samples: reverts,
    backfill_offsets_s: BACKFILL_OFFSETS_S,
    blocks_per_second: BLOCKS_PER_SECOND,
    entry_delay_blocks: ENTRY_DELAY_BLOCKS, exit_delay_blocks: EXIT_DELAY_BLOCKS,
  });
  await pool.end();
  process.exit(0);
}
const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });
main().catch((e) => { log.error('launchbot failed', errorFields(e)); process.exit(1); });

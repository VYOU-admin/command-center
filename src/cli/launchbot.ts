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
import { TOPICS as EVENT_TOPICS } from '../adapters/token-updates/decode.js';
const TOPICS_SWAP = EVENT_TOPICS.swapV4;
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
  /*
   * PENDING POOLS. The rule needs the REAL creation-to-first-swap gap, which does not
   * exist at Initialize time -- the first swap has not happened yet. The first build
   * passed `initBlock + 1` here as a placeholder, which made the gap 1 on every
   * candidate, below the 11-block minimum, so NOTHING could ever qualify. The dry run
   * found that in its first seven minutes, which is what a dry run is for. A pool is
   * now held here until its first swap lands and is then judged on the real gap.
   */
  const pending = new Map<string, {
    init: ReturnType<typeof decodeInitialize>; launchpad: string | null;
    token: string; counter: string; zeroIsPricing: boolean;
  }>();
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
      const cursorSpan = head - cursor;

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
        pending.set(init.poolId, {
          init, launchpad,
          token: zeroIsPricing ? c1 : c0, counter: zeroIsPricing ? c0 : c1, zeroIsPricing,
        });
      }

      /*
       * THE FIRST SWAP is what completes a candidate. One sweep per tick over the same
       * blocks, matched against the pools still pending.
       */
      if (pending.size > 0) {
        const swaps = (await rpc.call('eth_getLogs', [{
          address: POOL_MANAGER, topics: [TOPICS_SWAP],
          fromBlock: `0x${(head - (cursorSpan || 1)).toString(16)}`,
          toBlock: `0x${head.toString(16)}`,
        }])) as Array<{ topics: string[]; blockNumber: string; data: string }>;
        for (const sw of swaps) {
          const pid = (sw.topics[1] ?? '').toLowerCase();
          const p = pending.get(pid);
          if (!p) continue;
          pending.delete(pid);
          const firstSwapBlock = Number(BigInt(sw.blockNumber));
          const v = qualifies({
            poolId: pid, launchpad: p.launchpad, fee: p.init.fee,
            tickSpacing: p.init.tickSpacing, hooks: p.init.hooks,
            initBlock: p.init.blockNumber, firstSwapBlock,
            counterIsPricingAsset: true,
          });
          if (!v.qualifies) {
            log.info('candidate rejected', { pool: pid.slice(0, 18), gap: firstSwapBlock - p.init.blockNumber, reasons: v.reasons });
            continue;
          }
          stats.qualified += 1;

          const today = await c.query<{ n: string }>(
            `select count(*)::text n from bot_trades where chain=$1 and mode=$2
               and created_at > now() - interval '24 hours'`, [CHAIN, MODE]);
          if (Number(today.rows[0]!.n) >= RAILS.MAX_TRADES_PER_DAY) {
            stats.skippedRail += 1; continue;
          }
          const ethUsd = await c.query<{ e: string }>(
            `select eth_usd::text e from native_usd_prices order by block_number desc limit 1`);
          const size = positionWei(Number(ethUsd.rows[0]?.e ?? 0));

          /* QUOTE from the pool's realised first-swap amounts -- a traded price, not a
           * curve guess. A pool we cannot quote is SKIPPED rather than bounded by one. */
          const d = sw.data.startsWith('0x') ? sw.data.slice(2) : sw.data;
          const sgn = (w: string): bigint => {
            const v2 = BigInt(`0x${w}`); return v2 >= (1n << 255n) ? v2 - (1n << 256n) : v2;
          };
          const a0 = sgn(d.slice(0, 64)); const a1 = sgn(d.slice(64, 128));
          const abs = (x: bigint): bigint => (x < 0n ? -x : x);
          if (a0 === 0n || a1 === 0n) continue;
          const rate = p.zeroIsPricing
            ? Number(abs(a1)) / Number(abs(a0))
            : Number(abs(a0)) / Number(abs(a1));
          let quoted: bigint; let bound: bigint;
          try { quoted = expectedOut(size, rate); bound = minOut(quoted); } catch { continue; }

          const plan = {
            pool: { currency0: p.init.currency0, currency1: p.init.currency1,
              fee: p.init.fee, tickSpacing: p.init.tickSpacing, hooks: p.init.hooks },
            zeroForOne: p.zeroIsPricing,
            amountIn: size, amountOutMinimum: bound,
            deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
          };
          const buy = buildSwap(plan);
          const sell = buildSwap({ ...plan, zeroForOne: !p.zeroIsPricing,
            amountIn: quoted, amountOutMinimum: minOut(size) });
          const appr = buildTokenApprove(p.token, quoted);
          const p2 = buildPermit2Approve(p.token, quoted, Math.floor(Date.now() / 1000) + 3600);

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
            if (reverts.length < 12) reverts.push(`${pid.slice(0, 14)}: ${simNote}`);
            if (consecutiveReverts >= RAILS.MAX_CONSECUTIVE_REVERTS) {
              await halt(c, CHAIN, `${consecutiveReverts} consecutive simulation reverts`);
              log.error('HALTING on consecutive reverts', { consecutiveReverts });
            }
          }

          await c.query(
            `insert into bot_trades (chain,mode,pool_id,token,counter,launchpad,fee,
               tick_spacing,hooks,status,init_block,first_swap_block,age_blocks_at_entry,
               age_seconds_at_entry,position_wei,position_usd,quoted_out,min_out,
               entry_price,entry_calldata,exit_calldata,fill_status,note)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
             on conflict (chain,mode,pool_id) do nothing`,
            [CHAIN, MODE, pid, p.token, p.counter, p.launchpad, p.init.fee,
              p.init.tickSpacing, p.init.hooks, simOk ? 'simulated' : 'sim_reverted',
              p.init.blockNumber, firstSwapBlock,
              firstSwapBlock - p.init.blockNumber,
              (firstSwapBlock - p.init.blockNumber) / BLOCKS_PER_SECOND,
              size.toString(), RAILS.MAX_POSITION_USD, quoted.toString(), bound.toString(),
              rate, buy.data, sell.data, 'dry-run', simNote]);

          log.info('WOULD TRADE', {
            pool: pid, token: p.token, launchpad: p.launchpad, fee: p.init.fee,
            gap_blocks: firstSwapBlock - p.init.blockNumber,
            gap_seconds: (firstSwapBlock - p.init.blockNumber) / BLOCKS_PER_SECOND,
            position_usd: RAILS.MAX_POSITION_USD, position_wei: size.toString(),
            quoted_out: quoted.toString(), min_out: bound.toString(), slippage_bps: SLIPPAGE_BPS,
            transactions: [appr.description, p2.description, buy.description, sell.description],
            buy_to: buy.to, buy_value_wei: buy.value.toString(),
            buy_calldata_bytes: (buy.data.length - 2) / 2,
            simulation: simOk ? 'CLEAN' : 'REVERTED', simulation_detail: simNote,
          });
        }
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

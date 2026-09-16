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
  EXIT_DELAY_BLOCKS, EXIT_RETRY, NATIVE_ETH, POOL_MANAGER, RAILS, SLIPPAGE_BPS,
} from '../bot/config.js';
import { buildPermit2Approve, buildSwap, buildTokenApprove } from '../bot/calldata.js';
import { minOut, positionWei, qualifies } from '../bot/rule.js';
import { quote } from '../bot/quote.js';
import type { PoolTick } from '../bot/quote.js';
import { BOT_SCHEMA, halt, isHalted } from '../bot/state.js';
import { checkRails } from '../bot/rails.js';
import { id } from 'ethers';
import { quoteRate, swapAmounts, tokenPrice } from '../bot/price.js';
import { ReadOnlyRpc } from '../bot/rpc.js';
import { clearNeedsExit, reconcileOnBoot } from '../bot/reconcile.js';
import { configuredWallet, readWalletState, requiredUsd } from '../bot/wallet.js';
import { executeExit } from '../bot/exit-exec.js';

/*
 * THE MODE IS ALWAYS A DRY-RUN MODE, AND A RUN LABEL ONLY SUFFIXES IT.
 *
 * `MAX_TRADES_PER_DAY` counts per (chain, mode) per calendar day, which is right for a
 * risk limit and wrong for a test harness: dry run 2 was truncated to 16 trades because
 * dry run 1 had already spent the day's budget, and LAUNCHBOT.md section 7 records the
 * remedy as "a drill mode that runs against a separate mode value". This is that.
 *
 * **THE LABEL CANNOT PRODUCE A NON-DRY-RUN MODE.** It is a SUFFIX on the literal
 * 'dry-run', not a replacement for it, so no argument can make this process write a row
 * that reads as live. The rail is not weakened — it is still enforced in full within
 * whatever mode is running; it simply gives a test run its own budget rather than
 * making two runs share one.
 *
 * `/trades` already groups totals per mode and never sums across them, so a labelled
 * run cannot be added to any other run's figures.
 */
const RUN_LABEL = ((): string => {
  const i = process.argv.indexOf('--run-label');
  if (i < 0) return '';
  const raw = String(process.argv[i + 1] ?? '');
  if (!/^[a-z0-9-]{1,24}$/.test(raw)) {
    throw new Error(`--run-label must match [a-z0-9-]{1,24}, got "${raw}"`);
  }
  return raw;
})();
const MODE = RUN_LABEL ? `dry-run-${RUN_LABEL}` : 'dry-run';
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

  /*
   * TEST CONTROL, DRY RUN ONLY. Inflates the exit re-quote so the first rungs of the
   * ladder are guaranteed to miss and it must climb. A retry path nobody has exercised
   * is not a retry path, and waiting for a natural revert to appear inside one run is
   * not a test. It cannot affect a live path because there is no live path.
   */
  const fi = args.indexOf('--force-exit-optimism');
  const forceOptimism = fi >= 0 ? Number(args[fi + 1] ?? 1) : 1;
  if (!Number.isFinite(forceOptimism) || forceOptimism < 1) {
    throw new Error(`--force-exit-optimism must be a finite number >= 1, got `
      + `"${String(args[fi + 1])}"`);
  }

  /*
   * THE BOOT SEQUENCE, IN THE ORDER LAUNCHBOT.md SECTION 2 REQUIRES:
   *   1. read the wallet and decide whether we may arm AT ALL
   *   2. reconcile every non-terminal row against the chain
   *   3. EXIT every stuck position, before arming
   * Any of the three failing stops the process rather than arming beside a problem.
   */
  let walletState = null as Awaited<ReturnType<typeof readWalletState>> | null;
  {
    const c = await pool.connect();
    try {
      await c.query(BOT_SCHEMA);

      /* ---- 1. THE WALLET GATE --------------------------------------------- */
      const wallet = configuredWallet();
      if (wallet === null) {
        log.warn('NO WALLET CONFIGURED', {
          required_usd: requiredUsd(),
          note: 'BOT_WALLET_ADDRESS is unset. A dry run may proceed without one because '
            + 'it holds nothing and broadcasts nothing; a live mode must not, and none '
            + 'exists. The balance is UNREAD rather than assumed.',
        });
      } else {
        walletState = await readWalletState(rpc, c, wallet);
        log.info('WALLET BALANCE, READ FROM THE CHAIN', {
          address: walletState.address,
          balance_wei: walletState.balanceWei.toString(),
          balance_eth: walletState.balanceEth,
          eth_usd: walletState.ethUsd,
          balance_usd: Number(walletState.balanceUsd.toFixed(2)),
          required_usd: walletState.requiredUsd,
          can_arm: walletState.canArm,
          reason: walletState.reason,
        });
        if (!walletState.canArm) {
          /*
           * REFUSE TO ARM. Not a warning that the loop then ignores: arming with less
           * than MAX_CONCURRENT x MAX_POSITION_USD means a rail meant to bound exposure
           * would instead be bounded by running out of money, and that surfaces as a
           * reverting broadcast rather than as a refusal.
           */
          log.error('REFUSING TO ARM — BALANCE BELOW WHAT THE RAILS CAN PUT AT RISK', {
            balance_usd: Number(walletState.balanceUsd.toFixed(2)),
            required_usd: walletState.requiredUsd, reason: walletState.reason,
          });
          c.release(); await pool.end();
          process.exit(3);
        }
      }

      /* ---- 2. RECONCILE ---------------------------------------------------- */
      const rec = await reconcileOnBoot(c, rpc, CHAIN, wallet, MODE);
      log.info('boot reconciliation', { ...rec, wallet_configured: wallet !== null });

      /* ---- 3. EXIT EVERY STUCK POSITION, BEFORE ARMING --------------------- */
      const cleared = await clearNeedsExit(c, rpc, CHAIN, MODE, { forceOptimism });
      log.info('boot needs_exit sweep', { ...cleared });
    } finally { c.release(); }
  }

  log.info('launchbot starting', {
    mode: MODE, minutes,
    rails: RAILS, slippage_bps: SLIPPAGE_BPS,
    wallet: walletState === null ? 'NOT CONFIGURED' : walletState.address,
    wallet_balance_usd: walletState === null ? null
      : Number(walletState.balanceUsd.toFixed(2)),
    force_exit_optimism: forceOptimism,
    exit_delay_blocks: EXIT_DELAY_BLOCKS,
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
  /* Computed, never typed from memory -- a hand-copied selector is a fabricated constant. */
  const BALANCE_OF_SEL = id('balanceOf(address)').slice(0, 10);

  const stats = {
    ticks: 0, initializes: 0, candidates: 0, qualified: 0,
    simulated: 0, simClean: 0, simReverted: 0, skippedRail: 0,
    exitClean: 0, exitReverted: 0, exitNotAttempted: 0,
    quoteRefused: 0, quoteReadFailed: 0,
    quoteBasis: {} as Record<string, number>,
    exitsDue: 0, ladderFired: 0, ladderExhausted: 0,
    ladderRungs: {} as Record<string, number>,
  };
  const exitFails: string[] = [];
  const refusals: string[] = [];
  const reverts: string[] = [];
  let consecutiveReverts = 0;
  const railBlocks: string[] = [];

  while (Date.now() < until) {
    stats.ticks += 1;
    const c = await pool.connect();
    try {
      /* THE KILL SWITCH, on a fresh connection, before anything else this tick. */
      const k = await isHalted(c, CHAIN);
      if (k.halted) { log.warn('HALTED', { reason: k.reason }); break; }

      const head = Number(await rpc.call('eth_blockNumber', []).then((h) => BigInt(String(h))));

      /*
       * ---- THE EXIT SWEEP, BEFORE ANYTHING ELSE THIS TICK ----------------------
       *
       * Positions whose horizon has arrived are closed FIRST, ahead of looking for new
       * launches. An open position is money at risk; a launch we have not seen yet is
       * not. Doing this after detection would let a busy tick delay every exit behind
       * work that can wait.
       *
       * Every exit re-quotes from the pool's state NOW and climbs the measured ladder.
       */
      const due = await c.query<{
        id: string; pool_id: string; token: string; counter: string; fee: number;
        tick_spacing: number; hooks: string; first_swap_block: string;
        exit_sim_from: string | null; quoted_out: string | null;
      }>(
        `select id::text, pool_id, token, counter, fee, tick_spacing, hooks,
                first_swap_block::text, exit_sim_from, quoted_out::text
           from bot_trades
          where chain = $1 and mode = $2 and status = 'holding'
            and exit_due_block is not null and exit_due_block <= $3
          order by exit_due_block limit 5`, [CHAIN, MODE, head]);

      for (const d of due.rows) {
        stats.exitsDue += 1;
        if (!d.exit_sim_from) {
          /* No borrowed holder means the sell cannot be simulated at all in dry run.
           * Counted as its own outcome, never folded into "reverted". */
          stats.exitNotAttempted += 1;
          await c.query(
            `update bot_trades set status='closed_unsimulatable',
                    exit_sim_status='no_holder_found', updated_at=now() where id=$1`,
            [d.id]);
          continue;
        }
        /* The amount is what the borrowed holder actually holds, read from the chain. */
        let sellAmt: bigint;
        try {
          const balData = BALANCE_OF_SEL + '0'.repeat(24) + d.exit_sim_from.slice(2);
          const bal = BigInt(String(await rpc.call('eth_call',
            [{ to: d.token, data: balData }, 'latest'])));
          const wanted = BigInt(d.quoted_out ?? '0');
          sellAmt = bal === 0n ? 0n : (wanted > 0n && wanted < bal ? wanted : bal);
        } catch (e) {
          stats.exitNotAttempted += 1;
          await c.query(
            `update bot_trades set status='closed_unsimulatable',
                    exit_sim_status='probe_failed', exit_sim_note=$2, updated_at=now()
              where id=$1`, [d.id, (e as Error).message.slice(0, 160)]);
          continue;
        }
        if (sellAmt === 0n) {
          stats.exitNotAttempted += 1;
          await c.query(
            `update bot_trades set status='closed_unsimulatable',
                    exit_sim_status='holder_zero_balance', updated_at=now() where id=$1`,
            [d.id]);
          continue;
        }

        try {
          const outcome = await executeExit(
            { rpc, client: c, forceOptimism, wait: async (): Promise<void> => {} },
            {
              tradeId: d.id, poolId: d.pool_id, token: d.token, counter: d.counter,
              fee: d.fee, tickSpacing: d.tick_spacing, hooks: d.hooks,
              amountIn: sellAmt, firstSwapBlock: Number(d.first_swap_block),
              sellFrom: d.exit_sim_from,
            },
          );
          stats.exitClean += 1;
          if (outcome.attempts.length > 1) stats.ladderFired += 1;
          if (outcome.filledOn !== null) {
            stats.ladderRungs[String(outcome.filledOn)] =
              (stats.ladderRungs[String(outcome.filledOn)] ?? 0) + 1;
          }
          await c.query(
            `update bot_trades set status='closed', exit_sim_status='clean',
                    exit_attempts=$2, exit_filled_on=$3, exit_bound_bps=$4,
                    exit_block=$5, updated_at=now() where id=$1`,
            [d.id, outcome.attempts.length, outcome.filledOn,
              outcome.filledOn ? EXIT_RETRY.BOUND_BPS[outcome.filledOn - 1] : null, head]);
        } catch (e) {
          /*
           * THE LADDER EXHAUSTED IN THE LOOP. In dry run the position is hypothetical,
           * so this is recorded and the loop continues rather than halting — but it is
           * recorded as EXHAUSTED, which is a different thing from a single revert, and
           * it is counted separately.
           */
          stats.exitReverted += 1; stats.ladderFired += 1; stats.ladderExhausted += 1;
          if (exitFails.length < 8) exitFails.push((e as Error).message.slice(0, 140));
          await c.query(
            `update bot_trades set status='exit_exhausted', exit_sim_status='reverted',
                    exit_sim_note=$2, exit_attempts=$3, exit_block=$4, updated_at=now()
              where id=$1`,
            [d.id, (e as Error).message.slice(0, 200), EXIT_RETRY.MAX_ATTEMPTS, head]);
        }
      }

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
        }])) as Array<{ topics: string[]; blockNumber: string; data: string;
          transactionHash: string }>;
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

          /*
           * EVERY RAIL, IN ONE PLACE, IMMEDIATELY BEFORE COMMITTING TO THE TRADE.
           * This used to check MAX_TRADES_PER_DAY alone, inline; MAX_CONCURRENT and
           * MAX_DAILY_LOSS_USD were documented in config.ts and enforced nowhere, so
           * they were not rails at all. bot/rails.ts is now the only thing that
           * decides, and it reads its figures from Postgres so a container
           * replacement cannot reset the day.
           */
          const rail = await checkRails(c, CHAIN, MODE);
          if (!rail.allowed) {
            stats.skippedRail += 1;
            if (railBlocks.length < 12) railBlocks.push(rail.blocked.join('; '));
            log.warn('RAIL BLOCKED A TRADE', { pool: pid, blocked: rail.blocked, state: rail.state });
            /*
             * TWO RAILS STOP THE DAY RATHER THAN SKIP ONE LAUNCH. A run of reverts and
             * a breached daily loss are both statements that something is wrong with
             * the strategy or the chain, not with this particular pool -- continuing to
             * the next launch would re-run the same mistake within seconds. The
             * remaining rails (concurrency, daily count) are ordinary capacity limits
             * and correctly skip.
             */
            const fatal = rail.blocked.find((b) => b.startsWith('MAX_CONSECUTIVE_REVERTS')
              || b.startsWith('MAX_DAILY_LOSS_USD'));
            if (fatal) {
              await halt(c, CHAIN, fatal);
              log.error('HALTING', { reason: fatal, state: rail.state });
              break;
            }
            continue;
          }
          const ethUsd = await c.query<{ e: string }>(
            `select eth_usd::text e from native_usd_prices order by block_number desc limit 1`);
          const size = positionWei(Number(ethUsd.rows[0]?.e ?? 0));

          /* QUOTE from the pool's realised first-swap amounts -- a traded price, not a
           * curve guess. A pool we cannot quote is SKIPPED rather than bounded by one. */
          /*
           * BOTH CONVENTIONS COME FROM bot/price.ts AND NEITHER IS COMPUTED HERE.
           * `rate` sizes the buy (tokens per pricing unit); `px` is the price that
           * rises when the token rises, and is the only one comparable with the
           * backfill columns and with every figure in the chain documents.
           */
          const amts = swapAmounts(sw.data);
          if (!amts) continue;
          const tokenIsCurrency0 = !p.zeroIsPricing;
          const rate = quoteRate(amts, tokenIsCurrency0);
          const px = tokenPrice(amts, tokenIsCurrency0);

          /*
           * THE QUOTE COMES FROM bot/quote.ts, WHICH NEEDS THE POOL'S OWN SWAPS.
           * One filtered eth_getLogs per qualifying candidate, 60 CU: the v4 Swap event
           * indexes the pool id as topic 1, so this returns exactly this pool's trades
           * and nothing else. It is everything the bot can observe at the instant it
           * must decide — nothing after the entry block is read.
           */
          let ticks: PoolTick[] = [];
          try {
            const pl = (await rpc.call('eth_getLogs', [{
              address: POOL_MANAGER, topics: [EVENT_TOPICS.swapV4, pid],
              fromBlock: `0x${firstSwapBlock.toString(16)}`,
              toBlock: `0x${head.toString(16)}`,
            }])) as Array<{ blockNumber: string; logIndex: string; data: string }>;
            ticks = pl.map((l) => {
              const a = swapAmounts(l.data);
              if (!a) return null;
              const tp = tokenPrice(a, tokenIsCurrency0);
              /* NOTIONAL IS THE PRICING-ASSET SIDE, both directions. */
              const abs = (x: bigint): bigint => (x < 0n ? -x : x);
              const notional = Number(tokenIsCurrency0 ? abs(a.amount1) : abs(a.amount0));
              if (!(tp > 0) || !(notional > 0)) return null;
              return {
                block: Number(BigInt(l.blockNumber)),
                logIndex: Number(BigInt(l.logIndex)), price: tp, notional,
              };
            }).filter((x): x is PoolTick => x !== null);
          } catch (e) {
            /* A failed read is NOT an empty tick list — that would silently become a
             * fee-only quote. Counted and skipped. */
            stats.quoteReadFailed += 1;
            log.warn('pool tick read failed; SKIPPING rather than quoting blind', {
              pool: pid, error: (e as Error).message.slice(0, 120),
            });
            continue;
          }

          let quoted: bigint; let bound: bigint;
          let quoteBasis = 'unknown'; let impactPct = 0; let feePct = 0;
          try {
            const q = quote({
              amountIn: size, rateOutPerIn: rate, side: 'buy',
              fee: p.init.fee, ticks,
            });
            quoted = q.expectedOut; bound = minOut(quoted);
            quoteBasis = q.basis; impactPct = q.impactFraction * 100;
            feePct = q.feeFraction * 100;
            stats.quoteBasis[q.basis] = (stats.quoteBasis[q.basis] ?? 0) + 1;
          } catch (e) {
            stats.quoteRefused += 1;
            if (refusals.length < 8) refusals.push((e as Error).message.slice(0, 110));
            continue;
          }

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
          }

          /*
           * THE EXIT IS NO LONGER SIMULATED AT ENTRY TIME. The position is OPENED here
           * and closed later, when its horizon actually arrives, by the same
           * `executeExit` the boot path uses.
           *
           * WHY THIS CHANGED. The old block simulated the sell immediately, with a bound
           * derived from the ENTRY quote. On a pool whose median move over the horizon
           * is +37%, that bound is computed for a price that will not exist by the time
           * we sell — so it reverts for a reason that has nothing to do with the pool.
           * Selling at +90 s against a +0 s bound is not a measurement of the exit.
           *
           * THE HOLDER IS STILL BORROWED, and that confound is unchanged: in dry run we
           * hold nothing, so the sell is simulated as the pool's first-swap sender. What
           * is new is WHEN it happens and WHAT bound it carries.
           */
          let exitFrom: string | null = null;
          try {
            const txr = (await rpc.call('eth_getTransactionByHash', [sw.transactionHash])) as
              { from?: string } | null;
            exitFrom = txr?.from ? txr.from.toLowerCase() : null;
          } catch { exitFrom = null; }

          const exitDue = firstSwapBlock + ENTRY_DELAY_BLOCKS + EXIT_DELAY_BLOCKS;

          void quoteBasis; void impactPct; void feePct;

          log.info('WOULD TRADE', {
            quote_basis: quoteBasis, fee_pct: feePct.toFixed(4),
            impact_pct: impactPct.toFixed(3), ticks_observed: ticks.length,
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
    rail_blocks: railBlocks,
    quote_refusals: refusals,
    exit_failures: exitFails,
    backfill_offsets_s: BACKFILL_OFFSETS_S,
    blocks_per_second: BLOCKS_PER_SECOND,
    entry_delay_blocks: ENTRY_DELAY_BLOCKS, exit_delay_blocks: EXIT_DELAY_BLOCKS,
  });
  await pool.end();
  process.exit(0);
}
const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });
main().catch((e) => { log.error('launchbot failed', errorFields(e)); process.exit(1); });

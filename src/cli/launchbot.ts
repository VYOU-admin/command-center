/**
 * `npm run launchbot -- [--minutes N] [--run-label x] [--live]` — the launch bot.
 *
 * **DRY RUN UNLESS `--live` IS PASSED. SINCE 2026-09-16 `--live` CAN ARM AND TRADES REAL
 * MONEY.** The prerequisites list in `bot/live-preflight.ts` is EMPTY — four entries closed
 * with evidence and `fill-not-modelled` accepted by the operator — and `BOT_PRIVATE_KEY`
 * exists and is confirmed to control `BOT_WALLET_ADDRESS` on chain 4663. **There is no
 * second flag and nothing will ask.**
 *
 * What still gates it: the flag must be typed explicitly (an env var that looks like an
 * attempt to enable live RAISES rather than being ignored), the key must derive the
 * configured address, the balance must cover `MAX_CONCURRENT x MAX_POSITION_USD`, and the
 * boot sweep must be clean. **What BOUNDS a mistake is the six rails, not the preflight.**
 *
 * The read transport stays a `ReadOnlyRpc`, which refuses every signing and broadcast
 * method BY NAME in every mode including live; only the signer gets a `BroadcastRpc`, and
 * only at the one call site below. `scripts/check-live-gate.mjs` fails the BUILD if any
 * file but `bot/signer.ts` reads a key or constructs a signer.
 *
 * ONE IMPLEMENTATION OF EVERY RULE, AND NOTHING FORKS FOR LIVE. The mode decides whether
 * a broadcaster exists and nothing else: the quote (`bot/quote`), the rails
 * (`bot/rails`), the entry rule and sizing (`bot/rule`), the calldata (`bot/calldata`),
 * the exit executor (`bot/exit-exec`) and the reconciliation (`bot/reconcile`) are the
 * same objects on both paths. A dry run over different code proves nothing about the live
 * path, which is why there is no second code path to run.
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
  EXIT_DELAY_BLOCKS, EXIT_RETRY, NATIVE_ETH, POOL_MANAGER, RAILS, RECEIPT_POLL_MS,
  RECEIPT_TIMEOUT_MS, ROUND_TRIP_GAS_USD, SLIPPAGE_BPS,
} from '../bot/config.js';
import { buildSwap } from '../bot/calldata.js';
import { checkSellable, simulateSellAt } from '../bot/sellability.js';
import { ensureSellReadiness, plannedSends } from '../bot/approvals.js';
import { readTokenBalance } from '../bot/allowance.js';
import { awaitReceipt } from '../bot/receipt.js';
import { minOut, positionWei, qualifies } from '../bot/rule.js';
import { quote } from '../bot/quote.js';
import type { PoolTick } from '../bot/quote.js';
import { BOT_SCHEMA, halt, isHalted } from '../bot/state.js';
import { checkRails, deployedCapIsTerminal, deployedUsd, loserDeadlineFires,
  priceStopFires, runCapReached } from '../bot/rails.js';
import { poolIdOf, readPoolLiquidity } from '../bot/pool-state.js';
import { id } from 'ethers';
import { quoteRate, swapAmounts, tokenPrice } from '../bot/price.js';
import { BroadcastRpc, ReadOnlyRpc } from '../bot/rpc.js';
import { clearNeedsExit, reconcileOnBoot } from '../bot/reconcile.js';
import { configuredWallet, readWalletState, requiredUsd } from '../bot/wallet.js';
import { resolveMode } from '../bot/mode.js';
import { assertLiveReady } from '../bot/live-preflight.js';
import { createBroadcaster } from '../bot/signer.js';
import { executeExit } from '../bot/exit-exec.js';

/*
 * THE MODE COMES FROM `bot/mode.ts` AND IS NOT DECIDED HERE.
 *
 * This file used to parse `--run-label` and build the mode string itself. When live mode
 * was added that would have become a SECOND place deciding whether the bot is about to
 * spend real money, which is the two-implementations trap with money attached — the
 * failure this project has recorded seven times, most recently a price convention
 * implemented twice as reciprocals that reported a median return of -1.0000.
 *
 * `resolveMode` owns all of it: live requires the explicit flag, an env var that looks
 * like an attempt to enable live RAISES rather than being ignored, a label can only
 * SUFFIX 'dry-run' so no argument can produce a live label, and `--live` cannot be
 * combined with a label because a label grants its own MAX_TRADES_PER_DAY budget.
 */
const BOT_MODE = resolveMode(process.argv.slice(2), process.env);
const MODE = BOT_MODE.label;
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
  const inner = new RpcClient(RPC_URL.replace('{key}', key), 60000, 5_000_000);
  const rpc = new ReadOnlyRpc(inner);

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
  /*
   * ---- 0. THE LIVE GATE, BEFORE ANYTHING ELSE -----------------------------
   *
   * Ordered first deliberately. A live run that is going to be refused must be refused
   * before it reads a balance, reconciles rows or spends a compute unit, and certainly
   * before it arms.
   *
   *   assertLiveReady   -> the prerequisites list. **EMPTY as of 2026-09-16, so this now
   *                        PASSES.** It stays first so that any entry added later refuses
   *                        at the cheapest possible moment.
   *   createBroadcaster -> the key, its chain id, and that it derives the configured
   *                        address. **A key exists, so this now SUCCEEDS** and returns a
   *                        signer over a broadcast-capable transport.
   *
   * **SO REACHING THE LINE AFTER THIS BLOCK IN LIVE MODE MEANS THE BOT CAN SPEND MONEY.**
   * Both of these used to refuse unconditionally and the comment said they MUST fire; that
   * stopped being true when the key arrived and again when the list emptied.
   *
   * In dry-run both are no-ops: `assertLiveReady` returns immediately and
   * `createBroadcaster` is never called, so the key is not so much as looked for.
   */
  let broadcaster: Awaited<ReturnType<typeof createBroadcaster>> | null = null;
  if (BOT_MODE.live) {
    log.warn('LIVE MODE REQUESTED', {
      mode: BOT_MODE.label,
      note: 'the explicit flag was passed. Every gate below must clear before anything '
        + 'can be signed, and no key exists in this build.',
    });
    assertLiveReady(BOT_MODE);
    /*
     * THE SIGNER GETS THE BROADCAST-CAPABLE TRANSPORT, AND THIS LINE WAS WRONG HERE UNTIL
     * 2026-09-16 — THE SAME DEFECT THE FIRST REAL TRANSACTION HIT IN `approve-setup`.
     *
     * It read `createBroadcaster(BOT_MODE, rpc)`, handing the signer the `ReadOnlyRpc` the
     * loop reads through — which refuses `eth_sendRawTransaction` BY NAME in every mode
     * including live. Every send this bot made would have been refused by its own
     * deny-list. `approve-setup` was fixed when it hit this and **the same line was left
     * standing here**, which is what "fix it at the call site that failed" costs: the
     * other call sites keep the defect and nothing reports it.
     *
     * The layered defence would have caught it again — loudly, with nothing signed — but
     * it would have caught it on the first live trade rather than here.
     */
    const sender = new BroadcastRpc(inner, BOT_MODE);
    broadcaster = await createBroadcaster(BOT_MODE, sender);
    log.warn('LIVE BROADCASTER CONSTRUCTED', {
      address: broadcaster.address,
      transport: 'BroadcastRpc — the read path stays ReadOnlyRpc, which still refuses the '
        + 'broadcast by name, so broadcasting is opt-in at this one call site',
    });
  }

  let walletState = null as Awaited<ReturnType<typeof readWalletState>> | null;
  {
    const c = await pool.connect();
    try {
      await c.query(BOT_SCHEMA);

      /* ---- 1. THE WALLET GATE --------------------------------------------- */
      const wallet = configuredWallet();
      if (wallet === null) {
        /*
         * A LIVE RUN WITHOUT A CONFIGURED WALLET NOW RAISES, AND THIS USED TO BE A NOTE
         * THAT PROMISED IT WOULD.
         *
         * The text here said "a dry run may proceed without one ... a live mode must not,
         * and none exists" — written when live mode did not exist, so the second clause
         * was a description of the world rather than a guarantee. Live mode exists as of
         * 2026-09-16 and NOTHING ENFORCED IT: the branch warned and carried on, so a live
         * run would have armed with **no balance check at all**, and the capital rails
         * would have been bounded by running out of money rather than by the rails.
         *
         * That is ROBINHOOD.md rule 3 exactly — a documented guarantee the code does not
         * implement is a defect in the code, always in that direction. It was masked only
         * because `assertLiveReady` refuses first; it would have surfaced the moment the
         * prerequisites list emptied, which is the worst possible time to find it.
         *
         * **THAT MOMENT ARRIVED ON 2026-09-16 AND THE PREDICTION HELD.** The list is now
         * empty, so `assertLiveReady` no longer masks anything — and the list emptied onto
         * this raise rather than onto a live run with no balance check, because the defect
         * had been fixed two passes earlier. A comment that names WHEN a latent defect will
         * surface is worth more than one that only names the defect.
         *
         * A dry run may still proceed: it holds nothing and broadcasts nothing, and the
         * balance is UNREAD rather than assumed.
         */
        if (BOT_MODE.live) {
          throw new Error('REFUSING TO ARM IN LIVE MODE WITH NO BOT_WALLET_ADDRESS. The '
            + 'arming gate exists to confirm the wallet covers what the rails can put at '
            + `risk (${requiredUsd()} USD); with no address there is nothing to read a `
            + 'balance for, so the bot would arm without checking its funds and the '
            + 'capital rails would be bounded by running out of money instead. It is also '
            + 'what createBroadcaster compares the key\'s derived address against, so '
            + 'without it the guard against signing for the wrong account is inert.');
        }
        log.warn('NO WALLET CONFIGURED', {
          required_usd: requiredUsd(),
          note: 'BOT_WALLET_ADDRESS is unset. A dry run may proceed without one because '
            + 'it holds nothing and broadcasts nothing. A LIVE run raises above rather '
            + 'than arming without a balance check. The balance is UNREAD, not assumed.',
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
          /* The cap is reported beside the gate and decides nothing here. */
          max_deployed_usd: walletState.capUsd,
          covers_cap: walletState.coversCap,
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
      const cleared = await clearNeedsExit(c, rpc, CHAIN, MODE,
        { forceOptimism: broadcaster === null ? forceOptimism : 1, broadcaster });
      log.info('boot needs_exit sweep', { ...cleared });
    } finally { c.release(); }
  }

  log.info('launchbot starting', {
    mode: MODE, live: BOT_MODE.live, minutes,
    broadcaster: broadcaster === null
      ? 'NONE — no signer exists in this process and no key was read'
      : broadcaster.address,
    rails: RAILS, slippage_bps: SLIPPAGE_BPS,
    wallet: walletState === null ? 'NOT CONFIGURED' : walletState.address,
    wallet_balance_usd: walletState === null ? null
      : Number(walletState.balanceUsd.toFixed(2)),
    force_exit_optimism: forceOptimism,
    exit_delay_blocks: EXIT_DELAY_BLOCKS,
    broadcast: broadcaster === null
      ? 'IMPOSSIBLE in this mode -- ReadOnlyRpc refuses sendRawTransaction by name and '
        + 'BroadcastRpc cannot be constructed outside live mode'
      : 'POSSIBLE -- a live broadcaster exists',
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
    sellChecked: 0, sellOk: 0, sellDisqualified: 0, sellNotRun: 0,
    exitClean: 0, exitReverted: 0, exitNotAttempted: 0,
    quoteRefused: 0, quoteReadFailed: 0,
    quoteBasis: {} as Record<string, number>,
    exitsDue: 0, ladderFired: 0, ladderExhausted: 0, rowsNotStored: 0,
    ladderRungs: {} as Record<string, number>,
    /* THE LIVE ENTRY LEGS, counted separately because they are different facts. */
    buysBroadcast: 0, buysFilled: 0, entryReverted: 0, entryUnresolved: 0,
    approvalsGranted: 0, approvalsSkipped: 0,
    /* The DRY-RUN plan: reached and built, or not buildable and why. */
    approvalPlanBuilt: 0, approvalPlanFailed: 0, approvalPlanSkipped: 0,
    /* PART 2 RAILS AND STOPS -- every one counted so a zero is visible. */
    tradesThisRun: 0, blockedByRunCap: 0, blockedByTemplate: 0,
    sellStopFired: 0, priceStopFired: 0, loserDeadlineFired: 0,
    sellPolls: 0, sellPollStillOk: 0, sellPollFailed: 0,
  };

  /*
   * ===================================================================
   * THE PER-RUN TRADE CAP -- 2A, AND IT IS COUNTED HERE ON PURPOSE
   * ===================================================================
   *
   * `RAILS.MAX_TRADES_PER_RUN` is enforced by this in-process counter rather than by a
   * query in `checkRails`, and that is the entire reason it exists as a separate rail.
   * The live run's cost was not an absent limit -- MAX_DEPLOYED_USD, MAX_CONCURRENT and
   * MAX_DAILY_LOSS_USD were all set. It was that a single status defect
   * (`closed_unsimulatable`) made every position invisible to the queries all three read
   * from, so all three reported a clean slate while $120 went out. **A counter in the
   * process cannot be routed around by a wrong status.** It is a deliberate second kind
   * of limit, not a duplicate of the first.
   *
   * It counts BROADCASTS, not fills: a buy that reverts still spent gas and still
   * consumed an attempt.
   */
  const templatesSeen = new Map<string, string>();
  const blockedTemplates = new Set<string>();

  /*
   * ===================================================================
   * THE TEMPLATE BLOCKLIST -- 2D's "stop opening positions on similar candidates"
   * ===================================================================
   *
   * MEASURED on the twelve live positions: six carried the symbol `Fly`, five shared an
   * IDENTICAL T0 sell price, and seven shared an IDENTICAL pool liquidity value. They
   * were one actor deploying one template repeatedly, and five of the six `Fly` buys
   * were made AFTER the first one had already failed to sell. Nothing in the bot
   * connected them.
   *
   * A template is keyed on two facts readable BEFORE the buy -- the token symbol and the
   * pool's liquidity at the first swap. When any position on a template fails, every
   * later candidate matching it is skipped for the rest of the run. The key is
   * deliberately coarse: a false skip costs one $1 trade, a false pass cost $10.
   */
  const templateKey = (symbol: string | null, liquidity: string | null): string =>
    `${(symbol ?? '?').toLowerCase()}|${liquidity ?? '?'}`;
  const exitFails: string[] = [];
  const refusals: string[] = [];
  const reverts: string[] = [];
  /** Reason -> count, so a disqualification rate is auditable rather than a total. */
  const sellReasons = new Map<string, number>();
  let consecutiveReverts = 0;
  const railBlocks: string[] = [];

  while (Date.now() < until) {
    stats.ticks += 1;
    const c = await pool.connect();
    try {
      /* THE KILL SWITCH, on a fresh connection, before anything else this tick. */
      const k = await isHalted(c, CHAIN, MODE);
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
        entry_block: string | null; exit_due_block: string | null;
        position_wei: string | null;
      }>(
        /*
         * ===============================================================
         * EVERY OPEN POSITION, EVERY TICK -- NOT ONLY THE ONES PAST THE HORIZON
         * ===============================================================
         *
         * This query used to carry `and exit_due_block <= $3`, so a position was looked
         * at exactly once: 90 seconds after the buy, and never before. **MEASURED: 11 of
         * the 12 live positions were already unsellable within 20 SECONDS.** By the time
         * this loop looked at them the outcome had been settled for over a minute and
         * the only thing left to do was record it.
         *
         * The filter now selects every `holding` row and the decision about whether to
         * exit is made below, per row, per tick. The horizon is one of four triggers
         * rather than the only one.
         */
        `select id::text, pool_id, token, counter, fee, tick_spacing, hooks,
                first_swap_block::text, exit_sim_from, quoted_out::text,
                entry_block::text, exit_due_block::text, position_wei::text
           from bot_trades
          where chain = $1 and mode = $2 and status = 'holding'
          order by exit_due_block nulls first limit 8`, [CHAIN, MODE]);

      for (const d of due.rows) {
        /*
         * WHO SELLS, AND THEREFORE WHOSE BALANCE IS READ. **THIS IS COMPUTED FIRST, AND
         * THAT ORDERING IS THE WHOLE FIX.**
         *
         * In dry run the seller is the BORROWED holder — the pool's first-swap sender —
         * because we hold nothing. **With a broadcaster it is OUR OWN address**, or the
         * simulation would be about a different wallet's ability to sell while the
         * broadcast was signed by ours.
         *
         * ---------------------------------------------------------------------
         * THE DEFECT THIS REPLACES ABANDONED FIVE REAL POSITIONS
         * ---------------------------------------------------------------------
         *
         * The NULL check used to run BEFORE this line and unconditionally: a row with no
         * `exit_sim_from` was closed `closed_unsimulatable / no_holder_found` and the
         * loop moved on. **Live rows carry `exit_sim_from = NULL` BY DESIGN** — section
         * 2D writes it null precisely so boot reconciliation reads OUR balance rather
         * than a borrowed holder's — so **every live position reached that branch and was
         * written off as closed without a single exit attempt.**
         *
         * Trades 798-802 are what that cost: five filled buys, $50 of basis, marked
         * terminal while the wallet still held every token. And `closed_unsimulatable` is
         * in neither `NON_TERMINAL` nor `HELD`, so the positions left boot
         * reconciliation, the needs_exit sweep, `MAX_CONCURRENT` and the capital cap all
         * at once — the same "stranded in a status nothing sweeps" shape this document
         * already records for `exit_exhausted`, arriving on live money.
         *
         * The seller is now resolved first, so a missing holder is only reachable where
         * it is a real condition: a DRY RUN with nothing to borrow.
         */
        const seller = broadcaster !== null ? broadcaster.address : d.exit_sim_from;
        if (!seller) {
          /* Dry run only: no borrowed holder means the sell cannot be simulated at all.
           * Counted as its own outcome, never folded into "reverted". */
          stats.exitNotAttempted += 1;
          await c.query(
            `update bot_trades set status='closed_unsimulatable',
                    exit_sim_status='no_holder_found', updated_at=now() where id=$1`,
            [d.id]);
          continue;
        }

        /* The amount is what the SELLER actually holds, read from the chain. */
        let sellAmt: bigint;
        try {
          const balData = BALANCE_OF_SEL + '0'.repeat(24) + seller.slice(2);
          const bal = BigInt(String(await rpc.call('eth_call',
            [{ to: d.token, data: balData }, 'latest'])));
          const wanted = BigInt(d.quoted_out ?? '0');
          /*
           * DRY RUN caps at the position we expected, because a borrowed holder may hold
           * far more than our size and simulating theirs would measure the wrong trade.
           * LIVE sells the WHOLE BALANCE — the documented rule is that the amount sold is
           * the balance read from the chain and never the stored quote, because a quote is
           * what we expected and a balance is what is there.
           */
          sellAmt = broadcaster !== null
            ? bal
            : (bal === 0n ? 0n : (wanted > 0n && wanted < bal ? wanted : bal));
        } catch (e) {
          /*
           * A LIVE POSITION IS NEVER CLOSED TERMINAL ON A FAILED READ. We hold the
           * tokens; a balance we could not read says nothing about whether they are
           * there, and `closed_unsimulatable` would strand them outside every sweep.
           * `needs_exit` is the state the boot sweep exists for.
           */
          stats.exitNotAttempted += 1;
          await c.query(
            `update bot_trades set status=$3,
                    exit_sim_status='probe_failed', exit_sim_note=$2, updated_at=now()
              where id=$1`,
            [d.id, (e as Error).message.slice(0, 160),
              broadcaster !== null ? 'needs_exit' : 'closed_unsimulatable']);
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

        /*
         * =====================================================================
         * WHY WE ARE EXITING, OR WHETHER WE ARE -- 2B AND 2D, THE FOUR TRIGGERS
         * =====================================================================
         *
         * Four things can call a position, checked in the order of how fast the
         * measurement says they matter:
         *
         *   1. SELLABILITY STOP -- our own sell no longer executes. **This is the only
         *      one the measurement supports as the primary instrument.** 11 of 12 live
         *      positions died this way, as a step change from "sells fine" to "reverts",
         *      with no price decline in between.
         *   2. PRICE STOP -- the mark is `STOP_LOSS_BPS` below the fill. **MEASURED: it
         *      would have fired on 0 of 12**, because the worst decline seen while a
         *      position was still sellable was -2.0%, which IS the LP fee. It is a
         *      backstop against a shape nobody has observed, not a mechanism against the
         *      one that was.
         *   3. HORIZON -- `exit_due_block`, the ordinary planned exit.
         *   4. LOSER DEADLINE -- `LOSER_DEADLINE_BLOCKS` past the entry with the position
         *      still open. The operator's 2-minute value, kept as a backstop; 11 of 12
         *      were already dead six to twenty-four times sooner.
         *
         * A tick where none of the four fires LEAVES THE POSITION ALONE, which is the
         * behaviour the old `exit_due_block <= head` filter had for every tick but one.
         */
        let trigger: string | null = null;
        let triggerDetail = '';
        const entryBlk = d.entry_block === null ? null : Number(d.entry_block);
        const dueBlk = d.exit_due_block === null ? null : Number(d.exit_due_block);

        if (RAILS.SELLABILITY_STOP) {
          /*
           * THE POLL. A REACHABLE bound, for the reason in section 6A.3: a bound of
           * 2^127 short-circuits inside the swap action before `SETTLE_ALL` pulls the
           * token, so it reports a healthy price on a token that refuses transfers. The
           * whole point of this poll is the part the unreachable bound never reached.
           */
          /*
           * THE POOL KEY IS RECONSTRUCTED WITH THE EXIT PATH'S OWN ORDERING RULE and
           * then CHECKED AGAINST THE STORED POOL ID. `exit-exec.ts` uses
           * `token.toLowerCase() < counter.toLowerCase()`; using anything else here
           * would mean the poll measured a different swap from the one the exit sends.
           *
           * **AND A WRONG KEY FAILS IN THE DANGEROUS DIRECTION.** It addresses a pool
           * that does not exist, the call reverts, and this poll reads that revert as
           * "the token refuses to transfer" -- a honeypot verdict indistinguishable from
           * a real one, which would sell every position instantly and blocklist every
           * template. So the derived id is compared with `pool_id` from the `Initialize`
           * log, and a mismatch VOIDS THE POLL rather than being reported as a finding.
           */
          const tokenIsCurrency0 = d.token.toLowerCase() < d.counter.toLowerCase();
          const probePool = {
            currency0: tokenIsCurrency0 ? d.token : d.counter,
            currency1: tokenIsCurrency0 ? d.counter : d.token,
            fee: d.fee, tickSpacing: d.tick_spacing, hooks: d.hooks,
          };
          const derivedPid = poolIdOf(probePool).toLowerCase();
          if (derivedPid !== d.pool_id.toLowerCase()) {
            log.error('POOL KEY RECONSTRUCTION DISAGREES WITH THE Initialize LOG', {
              trade: d.id, stored: d.pool_id, derived: derivedPid,
              note: 'the sellability poll is VOID for this row; a revert here would be '
                + 'the wrong pool, not a honeypot',
            });
          } else {
          stats.sellPolls += 1;
          const probe = await simulateSellAt(rpc, {
            pool: probePool,
            token: d.token, owner: seller, amount: sellAmt,
            zeroForOneBuy: !tokenIsCurrency0,
            block: `0x${head.toString(16)}`,
          });
          if (probe.executes === false) {
            stats.sellPollFailed += 1; stats.sellStopFired += 1;
            trigger = 'sellability_stop';
            triggerDetail = probe.executeReason;
          } else if (probe.executes === true) {
            stats.sellPollStillOk += 1;
            /*
             * THE PRICE STOP, EVALUATED ONLY WHERE THERE IS A PRICE TO EVALUATE. It is
             * measured against `position_wei` -- what we actually paid -- and not against
             * the quote, because a quote is what we expected.
             */
            const paid = d.position_wei === null ? 0n : BigInt(d.position_wei);
            const ps = priceStopFires(paid, probe.ethOut);
            if (ps.fires) {
              stats.priceStopFired += 1;
              trigger = 'price_stop';
              triggerDetail = `mark ${String(ps.declineBps)} bps below fill, `
                + `limit ${RAILS.STOP_LOSS_BPS}`;
            }
          }
          /* `probe.executes === null` is UNKNOWN and triggers nothing: an unreadable
           * probe is not evidence the position is fine and not evidence it is dead. */
          }
        }

        if (trigger === null && dueBlk !== null && dueBlk <= head) {
          trigger = 'horizon';
          triggerDetail = `exit_due_block ${dueBlk} <= head ${head}`;
        }

        const ld = loserDeadlineFires(entryBlk, head);
        if (trigger === null && ld.fires) {
          stats.loserDeadlineFired += 1;
          trigger = 'loser_deadline';
          triggerDetail = `${String(ld.blocksHeld)} blocks since entry, `
            + `limit ${RAILS.LOSER_DEADLINE_BLOCKS}`;
        }

        if (trigger === null) continue;   /* nothing calls it this tick */

        stats.exitsDue += 1;
        log.info('POSITION CALLED', {
          trade: d.id, trigger, detail: triggerDetail.slice(0, 160),
          blocks_held: entryBlk === null ? null : head - entryBlk,
        });

        /*
         * A CALLED POSITION BLOCKS ITS TEMPLATE FOR THE REST OF THE RUN -- 2D's "stop
         * opening positions on similar candidates". Registered BEFORE the exit is
         * attempted, because the exit can take several ticks and the next candidate on
         * the same template can arrive inside that window. That is exactly what happened
         * live: five of the six `Fly` buys landed while the first was still unresolved.
         */
        if (trigger !== 'horizon') {
          const tk = templatesSeen.get(d.pool_id);
          if (tk !== undefined && !blockedTemplates.has(tk)) {
            blockedTemplates.add(tk);
            log.warn('TEMPLATE BLOCKED FOR THE REST OF THE RUN', {
              template: tk, because: `trade ${d.id} ${trigger}`,
            });
          }
        }

        try {
          const outcome = await executeExit(
            {
              rpc, client: c, chain: CHAIN, broadcaster,
              /*
               * `forceOptimism` is a dry-run test control and `executeExit` REFUSES it
               * alongside a broadcaster, so it is passed as 1 on a live path rather than
               * relying on the operator never combining the two.
               */
              forceOptimism: broadcaster === null ? forceOptimism : 1,
              /* The LADDER interval only. The receipt poll has its own wait. */
              wait: async (): Promise<void> => {},
            },
            {
              tradeId: d.id, poolId: d.pool_id, token: d.token, counter: d.counter,
              fee: d.fee, tickSpacing: d.tick_spacing, hooks: d.hooks,
              amountIn: sellAmt, firstSwapBlock: Number(d.first_swap_block),
              sellFrom: seller,
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
          /*
           * AN EXHAUSTED EXIT BECOMES `needs_exit`, NOT A TERMINAL STATUS.
           *
           * The first build set `exit_exhausted` here, which is not in `NON_TERMINAL` —
           * so the next boot would never look at it again and a position we failed to
           * sell would be quietly forgotten by the one routine written to find exactly
           * that. `needs_exit` is the state the boot sweep exists for, and a position
           * the ladder could not clear now is precisely one that should be retried when
           * the pool has moved.
           */
          await c.query(
            `update bot_trades set status='needs_exit', exit_sim_status='reverted',
                    exit_sim_note=$2, exit_attempts=$3, exit_block=$4, updated_at=now()
              where id=$1`,
            [d.id, `ladder exhausted in-loop: ${(e as Error).message.slice(0, 180)}`,
              EXIT_RETRY.MAX_ATTEMPTS, head]);
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
           * =============================================================
           * THE PER-RUN TRADE CAP -- 2A
           * =============================================================
           * Checked before anything is spent, and it STOPS THE RUN rather than skipping
           * the launch. Ten attempts is the whole budget for the run; having used it,
           * there is nothing left to do but shut down cleanly with the positions still
           * open so the exit path can work them.
           */
          if (runCapReached(stats.tradesThisRun)) {
            stats.blockedByRunCap += 1;
            log.warn('PER-RUN TRADE CAP REACHED -- ENDING THE RUN', {
              trades_this_run: stats.tradesThisRun,
              max_trades_per_run: RAILS.MAX_TRADES_PER_RUN,
              note: 'counted in-process; a wrong status cannot route around it',
            });
            break;
          }

          /*
           * =============================================================
           * THE ZERO-LIQUIDITY GATE -- 1B's "Fly had zero liquidity, that is readable"
           * =============================================================
           *
           * `readPoolLiquidity` is `extsload(keccak256(poolId ‖ 6) + 3)` on the
           * PoolManager: one `eth_call`, 26 CU, readable at any block including the one
           * before the buy. Three `Fly` buys went into pools whose liquidity was
           * literally `0` at the moment of purchase. **This is the exact call and the
           * exact threshold: liquidity must be STRICTLY GREATER THAN ZERO.**
           *
           * The threshold is zero and not a floor because the operator's instruction was
           * explicit -- do not disqualify launches that are merely thin -- and because
           * any non-zero floor would be a number I cannot derive from twelve positions.
           * Zero is the only value the measurement supports.
           *
           * **`null` IS NOT ZERO AND IS ALSO A REFUSAL.** An unreadable pool is one we
           * know nothing about; declining costs one $1 trade and proceeding cost $120.
           */
          const liq = await readPoolLiquidity(rpc, pid, `0x${head.toString(16)}`);
          if (liq === null || liq === 0n) {
            stats.blockedByTemplate += 1;
            log.warn('PRE-BUY LIQUIDITY GATE REFUSED THE POOL', {
              pool: pid, liquidity: liq === null ? 'UNREADABLE' : '0',
              threshold: 'strictly greater than zero',
              note: liq === null
                ? 'unreadable is a refusal, not a zero'
                : 'this is the Fly failure: three buys into an empty pool',
            });
            continue;
          }

          /*
           * =============================================================
           * THE TEMPLATE BLOCKLIST -- 2D
           * =============================================================
           * Keyed on the pool's liquidity, which is the fact that grouped 7 of the 12
           * live positions into one actor's template. Once any position on a template
           * has failed, no further candidate matching it is bought for the rest of the
           * run.
           */
          const tkey = templateKey(null, String(liq));
          if (blockedTemplates.has(tkey)) {
            stats.blockedByTemplate += 1;
            log.warn('TEMPLATE ALREADY FAILED THIS RUN -- SKIPPING', {
              pool: pid, template: tkey,
              note: 'five of the six Fly buys were made after the first had failed',
            });
            continue;
          }
          templatesSeen.set(pid, tkey);

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
            log.warn('RAIL BLOCKED A TRADE', {
              pool: pid, blocked: rail.blocked, state: rail.state,
              deployed_usd: Number(deployedUsd(rail.state).toFixed(2)),
              max_deployed_usd: RAILS.MAX_DEPLOYED_USD,
            });
            /*
             * TWO RAILS STOP THE DAY RATHER THAN SKIP ONE LAUNCH. A run of reverts and
             * a breached daily loss are both statements that something is wrong with
             * the strategy or the chain, not with this particular pool -- continuing to
             * the next launch would re-run the same mistake within seconds. The
             * remaining rails (concurrency, daily count) are ordinary capacity limits
             * and correctly skip.
             */
            const fatal = rail.blocked.find((b) => b.startsWith('MAX_CONSECUTIVE_REVERTS')
              || b.startsWith('MAX_DAILY_LOSS_USD')
              /*
               * THE CAPITAL CAP STOPS THE DAY ONLY WHEN IT CANNOT CLEAR. Open basis
               * falls as positions close, so that case is an ordinary capacity limit
               * and skips; realised losses never fall within a day, and an unknown
               * basis is a defect rather than a capacity condition, so both halt.
               * `deployedCapIsTerminal` is the one place that distinction lives.
               */
              || (b.startsWith('MAX_DEPLOYED_USD') && deployedCapIsTerminal(rail.state)));
            if (fatal) {
              await halt(c, CHAIN, MODE, fatal);
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
           * =====================================================================
           * THE PRE-BUY SELLABILITY CHECK — LAUNCHBOT.md section 2E
           * =====================================================================
           *
           * CME's buy succeeded and its sell could never have. Nothing in the entry rule
           * had ever asked the second question, and $10 is what that cost. This asks it
           * BEFORE the buy is broadcast, by simulating our own sell from our own address
           * at the full position size with the balance and both allowances supplied by
           * state override.
           *
           * **IT RUNS ONLY ON A CANDIDATE WHOSE BUY ALREADY SIMULATES CLEAN**, so it is
           * charged on the trades we would actually take rather than on every candidate.
           *
           * **IT RUNS IN DRY RUN TOO**, and blocks there as well, so the qualifying rate
           * a dry run reports is the rate live would get. A check exercised only on the
           * live path is a check nobody has run.
           */
          let sellOk = true;
          let sellNote = 'not-run';
          let sellDetail: string | null = null;
          if (simOk) {
            const owner = process.env['BOT_WALLET_ADDRESS']?.trim().toLowerCase();
            if (owner === undefined || owner === '') {
              /* REPORTED AS NOT RUN, NEVER AS A PASS. */
              stats.sellNotRun += 1;
              sellNote = 'NOT RUN — BOT_WALLET_ADDRESS is unset, so there is no address '
                + 'to simulate our sell from';
            } else {
              stats.sellChecked += 1;
              const v = await checkSellable(rpc, {
                pool: { currency0: p.init.currency0, currency1: p.init.currency1,
                  fee: p.init.fee, tickSpacing: p.init.tickSpacing, hooks: p.init.hooks },
                token: p.token, owner, amountInWei: size,
                zeroForOneBuy: p.zeroIsPricing,
              });
              sellOk = v.sellable;
              sellNote = v.reason;
              sellDetail = v.detail;
              if (v.sellable) stats.sellOk += 1;
              else {
                stats.sellDisqualified += 1;
                sellReasons.set(v.reason, (sellReasons.get(v.reason) ?? 0) + 1);
                log.warn('DISQUALIFIED — WE COULD NOT HAVE SOLD IT', {
                  pool: pid, token: p.token, reason: v.reason, detail: v.detail,
                  tokens_the_buy_would_give: v.tokensOut?.toString() ?? null,
                  code_bytes: v.codeBytes, calls: v.calls,
                });
              }
            }
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

          /*
           * THE HORIZON IS MEASURED FROM ENTRY, AND ON A LIVE PATH ENTRY IS THE BLOCK THE
           * BUY WAS MINED IN — not a block arithmetic said it would be.
           *
           * In dry run nothing is bought, so entry is the modelled `firstSwapBlock +
           * ENTRY_DELAY_BLOCKS` and this is the figure every stored dry-run row carries.
           * A live buy takes however long inclusion takes; using the modelled block there
           * would shorten or lengthen the hold by the difference and call it +90 s. The
           * live value is rewritten from the receipt below.
           */
          let exitDue = firstSwapBlock + ENTRY_DELAY_BLOCKS + EXIT_DELAY_BLOCKS;

          /*
           * THE ROW IS WRITTEN BEFORE ANYTHING IS REPORTED.
           *
           * This insert was DELETED by an edit that replaced the old exit-simulation
           * block, and the loop then ran for nine minutes logging `WOULD TRADE` over an
           * empty table — four trades reported, zero rows stored, and no error anywhere
           * because nothing threw. It is the same shape as the write that reported
           * "3,200 rows stored" over an empty table in ROBINHOOD.md step 12, and it was
           * caught the same way: by querying on a separate connection instead of
           * believing the log.
           *
           * A CLEAN BUY OPENS A POSITION. `holding` plus an `exit_due_block` is what the
           * per-tick exit sweep looks for; a reverted buy never opened one and is
           * terminal. `rowCount` is checked, because an insert that stores nothing is
           * indistinguishable from one that worked unless somebody looks.
           *
           * ---------------------------------------------------------------------------
           * ON A LIVE PATH IT IS WRITTEN AS `intent` AND COMMITTED **BEFORE** THE BUY
           * ---------------------------------------------------------------------------
           *
           * LAUNCHBOT.md section 2 rule 1, which existed as a rule and as nothing else
           * until this pass: *a row is inserted with status `intent` carrying the pool,
           * the calldata and the value, and committed, before `eth_sendRawTransaction` is
           * called.* A crash between the insert and the broadcast leaves a row the chain
           * can be asked about; a crash the other way round leaves a position nobody
           * knows exists, on a token nobody comes back for.
           *
           * `intent` is already in `NON_TERMINAL`, so boot reconciliation resolves it
           * against the wallet's balance without anything further being added.
           */
          const liveEntry = broadcaster !== null && simOk && sellOk;
          const ins = await c.query<{ id: string }>(
            `insert into bot_trades (chain,mode,pool_id,token,counter,launchpad,fee,
               tick_spacing,hooks,status,init_block,first_swap_block,age_blocks_at_entry,
               age_seconds_at_entry,position_wei,position_usd,quoted_out,min_out,
               entry_price,entry_calldata,exit_calldata,fill_status,note,
               exit_sim_status,exit_sim_from,px_entry,exit_due_block,quote_basis)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
                     $20,$21,$22,$23,$24,$25,$26,$27,$28)
             on conflict (chain,mode,pool_id) do nothing
             returning id::text`,
            [CHAIN, MODE, pid, p.token, p.counter, p.launchpad, p.init.fee,
              p.init.tickSpacing, p.init.hooks,
              !simOk ? 'sim_reverted'
                : !sellOk ? 'unsellable_prebuy'
                : (liveEntry ? 'intent' : 'holding'),
              p.init.blockNumber, firstSwapBlock,
              firstSwapBlock - p.init.blockNumber,
              (firstSwapBlock - p.init.blockNumber) / BLOCKS_PER_SECOND,
              size.toString(), RAILS.MAX_POSITION_USD, quoted.toString(), bound.toString(),
              rate, buy.data, sell.data, liveEntry ? 'live-pending' : 'dry-run',
              sellOk ? simNote : `PRE-BUY SELLABILITY: ${sellNote}`
                + `${sellDetail === null ? '' : ` — ${sellDetail}`}`,
              !simOk ? 'entry_reverted' : !sellOk ? 'prebuy_unsellable' : 'pending',
              /* A LIVE POSITION IS OURS AND CARRIES NO BORROWED HOLDER. `exit_sim_from`
               * is the dry-run fixture; writing one on a live row would tell boot
               * reconciliation to read somebody else's balance to decide whether WE hold
               * the token. */
              liveEntry ? null : exitFrom, px,
              simOk && sellOk ? exitDue : null, quoteBasis]);
          if ((ins.rowCount ?? 0) === 0) {
            stats.rowsNotStored += 1;
            log.warn('INSERT STORED NOTHING', {
              pool: pid, mode: MODE,
              note: 'on conflict fired or the row was rejected; reported rather than '
                + 'counted as a trade',
            });
          }
          const tradeId = ins.rows[0]?.id ?? null;

          /*
           * =========================================================================
           * THE TRADE, ON A LIVE PATH: BUY -> APPROVE -> PERMIT2 APPROVE
           * =========================================================================
           *
           * docs/LAUNCHBOT.md section 2D. Four transactions make a trade and the fourth,
           * the SELL, is sent later by the per-tick exit sweep when the horizon arrives.
           *
           * **ONE BROADCAST IN FLIGHT AT A TIME AND THE RECEIPT IS THE GATE.**
           * `signer.send` reads the nonce as `'pending'`, and on a node that does not
           * track the mempool that equals `'latest'` — so a second send before the first
           * is mined takes the SAME NONCE and replaces it. A buy that replaced its own
           * approval would be the failure `approve-setup` already found, one step worse.
           * So every send is followed by `awaitReceipt` and MINED is the only outcome
           * that continues.
           *
           * In dry run `liveEntry` is false and none of this runs; the approval PLAN is
           * still built and reported below, so the path is exercised without a key being
           * read — `createBroadcaster` is the only way to obtain a broadcaster and it
           * refuses outside live mode.
           */
          let entryTx: string | null = null;
          let heldRaw: bigint | null = null;
          let approvalPlan: Awaited<ReturnType<typeof ensureSellReadiness>> | null = null;
          let tradeFailed: string | null = null;

          if (liveEntry && tradeId !== null && broadcaster !== null) {
            const owner = broadcaster.address;
            try {
              /* ---- THE BUY ------------------------------------------------- */
              const hash = await broadcaster.send({
                to: buy.to, data: buy.data, value: buy.value,
                description: `BUY trade ${tradeId} ${p.token} minOut=${bound}`,
              });
              entryTx = hash; stats.buysBroadcast += 1;
              /*
               * THE PER-RUN CAP COUNTS BROADCASTS, NOT FILLS. A buy that reverts still
               * spent gas and still used one of the ten attempts this run is allowed.
               */
              stats.tradesThisRun += 1;
              log.warn('BUY BROADCAST', { trade: tradeId, hash, pool: pid,
                value_wei: buy.value.toString(), min_out: bound.toString() });
              await c.query(
                `update bot_trades set status='entry_sent', entry_tx=$2, updated_at=now()
                  where id=$1`, [tradeId, hash]);

              const rec = await awaitReceipt(rpc, hash,
                { timeoutMs: RECEIPT_TIMEOUT_MS, pollMs: RECEIPT_POLL_MS });
              log.info('BUY RECEIPT', { trade: tradeId, hash, outcome: rec.outcome,
                block: rec.blockNumber, receipt_wait_ms: rec.waitMs,
                receipt_polls: rec.polls });

              if (rec.outcome === 'reverted') {
                /*
                 * SETTLED, AND WE HOLD NOTHING. A mined revert is definitive: the buy did
                 * not happen, no tokens moved, and there is nothing to approve or to
                 * exit. Terminal, and NOT `needs_exit` — sweeping a position that does
                 * not exist would be the opposite error.
                 */
                throw new EntryReverted(`the buy MINED AND REVERTED (${hash}) — the pool `
                  + 'moved between the simulation and the send. Nothing was bought.');
              }
              if (rec.outcome === 'unknown') {
                /*
                 * NEITHER CONFIRMED NOR FAILED. The buy may still land, so the position
                 * is UNKNOWN and must be treated as possibly open: `needs_exit` and a
                 * halt. Boot reconciliation against the chain settles it.
                 */
                throw new Error(`NO RECEIPT for the buy ${hash} after ${rec.waitMs} ms `
                  + `(${rec.polls} polls). THE POSITION STATE IS UNKNOWN: the buy may `
                  + 'still land. Nothing further was sent and boot reconciliation against '
                  + 'the chain settles this.');
              }

              /* ---- THE EXACT AMOUNT, READ FROM THE CHAIN -------------------- */
              /*
               * THE FILL, NOT THE QUOTE. This is the whole reason the approvals are
               * granted AFTER the buy: the quote is measured to be wrong by 2-3% in
               * either direction, and an allowance below the balance leaves the tail of
               * the position unsellable. `readTokenBalance` raises on `0x` rather than
               * returning a plausible zero.
               */
              heldRaw = await readTokenBalance(rpc, p.token, owner);
              stats.buysFilled += 1;
              const entryBlock = rec.blockNumber ?? head;
              /* The horizon runs from the block the buy was MINED in. */
              exitDue = entryBlock + EXIT_DELAY_BLOCKS;
              log.info('BUY FILLED', {
                trade: tradeId, hash, block: entryBlock,
                held_raw: heldRaw.toString(), quoted_out: quoted.toString(),
                fill_vs_quote: quoted > 0n
                  ? Number((heldRaw * 10000n) / quoted) / 10000 : null,
                exit_due_block: exitDue,
              });

              /* ---- THE TWO APPROVALS, FOR EXACTLY WHAT WE HOLD -------------- */
              approvalPlan = await ensureSellReadiness(
                { rpc, broadcaster },
                { token: p.token, owner, amount: heldRaw },
              );

              /* ---- THE POSITION IS OPEN AND SELLABLE ------------------------ */
              await c.query(
                `update bot_trades set status='holding', fill_status='live-filled',
                        entry_block=$2, executed_out=$3, exit_due_block=$4,
                        exit_sim_status='pending', updated_at=now()
                  where id=$1`,
                [tradeId, entryBlock, heldRaw.toString(), exitDue]);
            } catch (err) {
              const msg = (err as Error).message.slice(0, 220);
              tradeFailed = msg;
              if (err instanceof EntryReverted) {
                /*
                 * THE BUY REVERTED ON CHAIN. Terminal, no halt: this is the same ordinary
                 * outcome a reverted simulation is, arriving one step later, and the pool
                 * moving between the call and the send is a race this design accepts.
                 */
                stats.entryReverted += 1;
                await c.query(
                  `update bot_trades set status='closed_unfilled', fill_status='live-reverted',
                          exit_sim_status='entry_reverted', exit_due_block=null,
                          note=$2, updated_at=now() where id=$1`, [tradeId, msg]);
                log.warn('LIVE BUY REVERTED — NOTHING BOUGHT', { trade: tradeId, detail: msg });
              } else {
                /*
                 * EVERYTHING ELSE LEAVES THE POSITION POSSIBLY OPEN, SO IT BECOMES
                 * `needs_exit` AND THE MODE HALTS. LAUNCHBOT.md section 2D.
                 *
                 * `needs_exit` rather than a terminal status because the tokens may be
                 * ours and it is the one state the boot sweep acts on — and that sweep
                 * now grants the missing approvals through the same `ensureSellReadiness`
                 * before selling, so a failed grant is retried rather than stranded. A
                 * terminal status here would repeat `exit_exhausted`: seven positions in
                 * a status no sweep contained.
                 *
                 * THE ROW IS WRITTEN BEFORE THE HALT, so the position is visible to the
                 * next boot whether or not anyone clears the switch — and `halt-control`
                 * refuses to clear a mode while it still has `needs_exit` rows, which
                 * points the operator at the position rather than at the switch.
                 *
                 * IT HALTS because an approval that reverts is a statement about the
                 * TOKEN — a blacklist, a transfer hook, a non-standard approve — and the
                 * next launch from the same launchpad arrives seconds later. That is the
                 * reasoning MAX_CONSECUTIVE_REVERTS already uses. Halts are mode-scoped,
                 * so a live halt stops live and nothing else.
                 */
                stats.entryUnresolved += 1;
                await c.query(
                  `update bot_trades set status='needs_exit', fill_status='live-unknown',
                          exit_sim_status='reverted', note=$2, updated_at=now()
                    where id=$1`,
                  [tradeId, `LIVE TRADE UNRESOLVED: ${msg}`]);
                await halt(c, CHAIN, MODE,
                  `live trade ${tradeId} left an unresolved position: ${msg}`);
                log.error('LIVE TRADE UNRESOLVED — POSITION MARKED needs_exit AND MODE HALTED', {
                  trade: tradeId, pool: pid, token: p.token, entry_tx: entryTx,
                  detail: msg,
                  note: 'the next boot of this mode sweeps the row before arming and the '
                    + 'exit path grants the approvals it needs; the halt stops NEW trades, '
                    + 'not the resolution of this one',
                });
                break;
              }
            }
          } else if (simOk) {
            /*
             * DRY RUN: THE APPROVAL PATH IS REACHED AND CONSTRUCTED, AND NOTHING IS SENT.
             *
             * The allowances are READ from the real contracts for our own configured
             * address, and both approvals are BUILT for the quoted output — which is the
             * honest amount here precisely because there is no balance: nothing was
             * bought. It is labelled hypothetical for that reason and must not be read as
             * what a live trade would approve, which is the FILL.
             *
             * With no wallet configured there is nobody to read an allowance for, and the
             * plan is reported as unavailable rather than as zero.
             */
            const owner = configuredWallet();
            if (owner !== null) {
              try {
                approvalPlan = await ensureSellReadiness(
                  { rpc, broadcaster: null }, { token: p.token, owner, amount: quoted });
              } catch (e) {
                stats.approvalPlanFailed += 1;
                log.warn('APPROVAL PLAN COULD NOT BE BUILT', {
                  pool: pid, token: p.token, error: (e as Error).message.slice(0, 160),
                });
              }
            } else {
              stats.approvalPlanSkipped += 1;
            }
          }

          if (approvalPlan !== null) {
            if (approvalPlan.hypothetical) stats.approvalPlanBuilt += 1;
            else {
              stats.approvalsGranted += approvalPlan.sent.length;
              stats.approvalsSkipped +=
                approvalPlan.steps.filter((st) => st.verdict === 'SKIP').length;
            }
          }

          /*
           * WHAT THE TRADE IS, IN FOUR TRANSACTIONS AND IN ORDER.
           *
           * The two approvals come from the PLAN rather than being rebuilt for this line,
           * so what is reported is what `ensureSellReadiness` decided rather than a second
           * construction of it that could differ. Where no plan exists the reason is
           * stated rather than the line being dropped.
           */
          const approvalLines = approvalPlan === null
            ? ['APPROVALS: no plan — ' + (tradeFailed !== null
                ? 'the live entry did not reach them'
                : 'BOT_WALLET_ADDRESS is unset, so there is nobody to read an allowance '
                  + 'for; reported rather than treated as zero')]
            : plannedSends(approvalPlan);

          log.info(liveEntry ? 'TRADE' : 'WOULD TRADE', {
            live: liveEntry,
            quote_basis: quoteBasis, fee_pct: feePct.toFixed(4),
            impact_pct: impactPct.toFixed(3), ticks_observed: ticks.length,
            pool: pid, token: p.token, launchpad: p.launchpad, fee: p.init.fee,
            gap_blocks: firstSwapBlock - p.init.blockNumber,
            gap_seconds: (firstSwapBlock - p.init.blockNumber) / BLOCKS_PER_SECOND,
            position_usd: RAILS.MAX_POSITION_USD, position_wei: size.toString(),
            quoted_out: quoted.toString(), min_out: bound.toString(), slippage_bps: SLIPPAGE_BPS,
            /* FOUR TRANSACTIONS PER TRADE. The sell is sent later, by the exit sweep. */
            transactions: [
              `1. ${buy.description}`,
              ...approvalLines.map((x, n) => `${n + 2}. ${x}`),
              `4. (at +90 s) ${sell.description}`,
            ],
            approvals_amount_from: approvalPlan === null ? null
              : (liveEntry ? 'the BALANCE read from the chain after the buy mined'
                : 'the QUOTED output — HYPOTHETICAL, nothing was bought'),
            approvals_amount_raw: approvalPlan === null ? null
              : approvalPlan.amount.toString(),
            approvals_already_in_place: approvalPlan === null ? null : approvalPlan.before.ready,
            entry_tx: entryTx, held_raw: heldRaw === null ? null : heldRaw.toString(),
            buy_to: buy.to, buy_value_wei: buy.value.toString(),
            buy_calldata_bytes: (buy.data.length - 2) / 2,
            simulation: simOk ? 'CLEAN' : 'REVERTED', simulation_detail: simNote,
            outcome: tradeFailed === null ? (liveEntry ? 'FILLED AND APPROVED' : 'not sent')
              : tradeFailed,
          });
        }
      }
    } catch (err) {
      log.error('tick failed', errorFields(err));
    } finally { c.release(); }
    await sleep(DETECT_INTERVAL_MS);
  }

  /*
   * THE RUN IS RECONCILED AGAINST THE DATABASE ON A FRESH CONNECTION BEFORE IT REPORTS.
   *
   * A previous build of this loop logged four `WOULD TRADE` lines over an EMPTY table
   * for nine minutes, because an edit had deleted the insert and nothing threw. The
   * log is not evidence; the rows are. ROBINHOOD.md's worst recorded failure is a write
   * that reported 3,200 rows stored against an empty table, and it was caught by exactly
   * this check and by nothing else.
   */
  {
    const fresh = await pool.connect();
    try {
      const v = await fresh.query<{ n: string }>(
        `select count(*)::text n from bot_trades where chain = $1 and mode = $2`,
        [CHAIN, MODE]);
      const stored = Number(v.rows[0]!.n);
      log.info('VERIFIED ON A FRESH CONNECTION', {
        simulated_this_run: stats.simulated, rows_in_this_mode: stored,
        rows_not_stored: stats.rowsNotStored,
      });
      if (stats.simulated > 0 && stored === 0) {
        throw new Error(`the run simulated ${stats.simulated} trades and the table holds `
          + `ZERO rows for mode ${MODE}. The log is not evidence; this run stored `
          + 'nothing and must not be reported as a dry run.');
      }
    } finally { fresh.release(); }
  }

  /*
   * THE FULL ROUND TRIP, PER LEG, WITH EACH FIGURE'S PROVENANCE.
   *
   * Reported because every leg is now known: the loop sends the buy and both approvals and
   * the exit sweep sends the sell, so a trade is four transactions and the cost of one is
   * no longer partly hypothetical. **ONE OF THE FOUR IS MEASURED ON OUR OWN RECEIPTS** —
   * the approval pair, at $0.0128 — and the other two gas figures are still other people's,
   * which is why they are listed separately rather than summed into a constant. `gas_usd`
   * remains NULL on every stored row: no buy or sell of ours has ever been mined.
   */
  const gasLow = ROUND_TRIP_GAS_USD.BUY_LOW + ROUND_TRIP_GAS_USD.APPROVALS
    + ROUND_TRIP_GAS_USD.SELL;
  const gasHigh = ROUND_TRIP_GAS_USD.BUY_HIGH + ROUND_TRIP_GAS_USD.APPROVALS
    + ROUND_TRIP_GAS_USD.SELL;
  const rpcPerTrade = stats.simulated > 0
    ? (rpc.cuSpent * 0.45) / 1e6 / stats.simulated : null;
  log.info('THE FULL ROUND TRIP ON A $10 POSITION, EVERY LEG', {
    gas_buy_usd: `${ROUND_TRIP_GAS_USD.BUY_LOW}–${ROUND_TRIP_GAS_USD.BUY_HIGH}`,
    gas_buy_from: 'ESTIMATED — 200 real receipts per era, other traders',
    gas_approvals_usd: ROUND_TRIP_GAS_USD.APPROVALS,
    gas_approvals_from: 'MEASURED ON OUR OWN TWO RECEIPTS, 2026-09-16 — 0x999fdb79… and '
      + '0x178977d3…, 57,892 + 47,554 gas. The external estimate it replaced was $0.015, '
      + 'so that figure was 17% high.',
    gas_sell_usd: ROUND_TRIP_GAS_USD.SELL,
    gas_sell_from: 'ESTIMATED — median of 40 sampled real sells',
    gas_total_usd: `${gasLow.toFixed(4)}–${gasHigh.toFixed(4)}`,
    lp_fee_usd: 0.0654, lp_fee_from: 'run 3 fee mix, weighted: 0.654% round trip',
    slippage_usd: 0.026, slippage_from: 'measured from realised impact at $10, SELLOFF',
    rpc_usd_per_trade: rpcPerTrade === null ? 'no trades this run' : rpcPerTrade.toFixed(5),
    total_usd: `${(gasLow + 0.0654 + 0.026 + (rpcPerTrade ?? 0)).toFixed(4)}–`
      + `${(gasHigh + 0.0654 + 0.026 + (rpcPerTrade ?? 0)).toFixed(4)}`,
    share_of_position: `${(((gasLow + 0.0654 + 0.026) / RAILS.MAX_POSITION_USD) * 100)
      .toFixed(2)}%–${(((gasHigh + 0.0654 + 0.026) / RAILS.MAX_POSITION_USD) * 100)
      .toFixed(2)}%`,
    note: 'COSTS ARE NOT THE BINDING CONSTRAINT against a measured median gross of +0.374 '
      + 'at +90 s. The binding constraints are the entry revert rate and exit availability.',
  });

  log.info(BOT_MODE.live ? 'launchbot LIVE run complete' : 'launchbot dry run complete', {
    mode: MODE, minutes, ...stats, cu_spent: rpc.cuSpent,
    usd: ((rpc.cuSpent * 0.45) / 1e6).toFixed(5),
    revert_samples: reverts,
    /* Reasons, not just a total: a disqualification for want of evidence and one
     * on evidence mean different things about the population. */
    sellability_disqualifications: Object.fromEntries(sellReasons),
    sellability_qualifying_rate: stats.sellChecked > 0
      ? `${((100 * stats.sellOk) / stats.sellChecked).toFixed(1)}%` : 'NOT RUN',
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
/**
 * A BUY THAT WAS MINED AND REVERTED, distinguished from every other live-entry failure.
 *
 * It is its own class because the two outcomes are opposite: a mined revert is SETTLED —
 * nothing moved, we hold nothing, and the row is terminal — while an absent receipt, a
 * rejected broadcast or a failed approval all leave the position POSSIBLY OPEN and must
 * become `needs_exit` with the mode halted. Collapsing them would either strand a position
 * that does not exist or abandon one that does.
 */
class EntryReverted extends Error {}

const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });
main().catch((e) => { log.error('launchbot failed', errorFields(e)); process.exit(1); });

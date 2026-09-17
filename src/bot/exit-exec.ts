/**
 * THE ONE EXIT EXECUTOR. Every exit in this system goes through `executeExit` —
 * the boot path that clears a `needs_exit` position, and the in-loop path that sells a
 * position when its horizon arrives. A second implementation of "how do we get out" is
 * the failure this project has recorded six times, and the exit is the leg where it
 * would cost the most.
 *
 * ---------------------------------------------------------------------------
 * IT RE-QUOTES AT EXIT TIME, FROM THE POOL'S STATE THEN
 * ---------------------------------------------------------------------------
 *
 * The exit's bound used to be derived from the ENTRY quote. On a pool whose median move
 * over the exit horizon is +37% (`nightly-check`, 71 trades), a bound computed 90
 * seconds earlier is a bound for a price that no longer exists — and the entry quote is
 * itself measured to over-quote by 2–3%. **Selling against a stale bound is how an exit
 * reverts for a reason that has nothing to do with the pool.**
 *
 * So every attempt re-reads the pool's swaps up to NOW and calls `bot/quote.ts` again.
 * That is not an optimisation, it is the ladder's own contract: `exitWithRetry` states
 * that a retry which resubmits the same calldata against the same bound is one attempt
 * logged four times.
 *
 * ---------------------------------------------------------------------------
 * WHAT "SIMULATED" MEANS HERE, STATED SO IT IS NOT MISREAD LATER
 * ---------------------------------------------------------------------------
 *
 * With no broadcaster nothing is broadcast: `send` is an `eth_call`, and `ReadOnlyRpc`
 * refuses every signing and broadcast method by name. The `from` address is supplied by
 * the caller because **the two callers borrow different addresses and for different
 * reasons**, and conflating them would make the result unreadable:
 *
 *   - the in-loop exit borrows the pool's first-swap sender, because we do not hold the
 *     token at all in dry run;
 *   - the boot exit uses whatever address the row's position is attributed to.
 *
 * Both are recorded per attempt. A clean simulation from a borrowed holder proves the
 * pool accepts the sell and the calldata is well formed; it does NOT prove our own
 * approval state, which section 2 measures separately.
 *
 * ---------------------------------------------------------------------------
 * THE LIVE PATH: SIMULATE FIRST, ALWAYS, THEN BROADCAST THE RUNG THAT PASSED
 * ---------------------------------------------------------------------------
 *
 * Added 2026-09-16, closing `sell-not-broadcast`. **Nothing forks.** The quote, the
 * ladder, the bound, the calldata and the recording are the same objects and the same
 * order on both paths; the ONLY difference is what happens after the simulation returns.
 *
 * **THE SIMULATION HAPPENS IN LIVE MODE TOO, AND THAT IS A DESIGN DECISION RATHER THAN
 * LEFTOVER DRY-RUN CODE.** Broadcasting each rung in turn would be the obvious shape and
 * it is worse in three ways:
 *
 *   - it pays gas for rungs that were always going to revert;
 *   - it loses the diagnosis. A mined failure gives `status: 0` and nothing else, while
 *     an `eth_call` gives the decoded `V4TooLittleReceived bound=… actual=…` that made
 *     these numbers readable in the first place;
 *   - it turns every rung into an in-flight transaction, which is the one failure mode
 *     the ladder cannot safely retry.
 *
 * So the ladder climbs on simulations — free, fast, diagnostic — and only the bound the
 * pool has just accepted is signed and sent. The price is a race: the pool can move
 * between the call and the broadcast, so a sent transaction can still revert. That is
 * inherent and it is handled rather than hidden — a mined revert is an ordinary attempt
 * failure and the ladder continues.
 *
 * **A BROADCAST WHOSE RECEIPT NEVER ARRIVES STOPS THE LADDER.** It raises
 * `ExitUnrecoverableError`, so no second sell is sent against a position that may already
 * have been sold. Boot reconciliation against the chain is what settles it.
 */
import { AbiCoder, id } from 'ethers';
import { buildSwap } from './calldata.js';
import { quote } from './quote.js';
import type { PoolTick } from './quote.js';
import { swapAmounts, tokenPrice } from './price.js';
import { ExitUnrecoverableError, boundForAttempt, boundedMinOut, exitWithRetry } from './exit.js';
import type { ExitAttempt, ExitOutcome, ExitQuote, SendResult } from './exit.js';
import { POOL_MANAGER, UNIVERSAL_ROUTER } from './config.js';
import { ensureSellReadiness } from './approvals.js';
import { awaitReceipt } from './receipt.js';
import type { Broadcaster } from './signer.js';
import { TOPICS } from '../adapters/token-updates/decode.js';
import { log } from '../logger.js';
import type { PoolClient } from '../store/db.js';

const abi = AbiCoder.defaultAbiCoder();
/** Computed, never typed from memory — a hand-copied selector is a fabricated constant. */
const V4_TOO_LITTLE = id('V4TooLittleReceived(uint256,uint256)').slice(0, 10);

/** Minimal RPC surface, so this module cannot reach a broadcast method at all. */
export interface ExitRpc { call(method: string, params: unknown[]): Promise<unknown> }

export interface ExitPosition {
  /** `bot_trades.id`, so every attempt is recorded against the right row. */
  tradeId: string;
  poolId: string;
  token: string;
  counter: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
  /** Tokens to sell, raw units. */
  amountIn: bigint;
  /** Where to start reading the pool's swaps from. */
  firstSwapBlock: number;
  /** The address the simulation runs AS. Recorded on every attempt. */
  sellFrom: string;
}

export interface ExitExecContext {
  rpc: ExitRpc;
  client: PoolClient;
  /**
   * THE CHAIN THE ATTEMPT ROWS BELONG TO. REQUIRED, and it used to be the literal
   * `'robinhood'` inside the insert.
   *
   * **THAT HARDCODING LET A DRILL WRITE INTO LIVE DATA**, and `exit-broadcast-drill`
   * caught it on its first run: the drill ran on `chain='drill'`, deleted
   * `chain='drill'` afterwards, and left THREE orphan rows under `chain='robinhood'`
   * carrying trade ids that do not exist there. `bot_exit_attempts` is what the ladder's
   * own effectiveness is measured from — run 4's rung table was read out of it — so
   * false rows there corrupt a future derivation rather than merely sitting around.
   *
   * It is REQUIRED rather than defaulted, because a default is what made this possible:
   * every caller already knows its chain, and one that does not should not be writing
   * attempt rows.
   */
  chain: string;
  /**
   * TEST CONTROL, DRY RUN ONLY. Multiplies the re-quote so the first rungs are
   * guaranteed to miss and the ladder must climb. Defaults to 1 (no effect). It exists
   * because a retry path nobody has exercised is not a retry path, and waiting for a
   * natural revert to appear in a 90-minute window is not a test.
   */
  forceOptimism?: number;
  /** Injected so a drill does not wait the real interval. */
  wait?: (ms: number) => Promise<void>;
  /**
   * PRESENT ONLY IN LIVE MODE. `createBroadcaster` is the sole way to obtain one and it
   * refuses outside live mode and refuses without a key, so `null` here is not a
   * configuration choice this module makes — it is the mode's decision arriving.
   *
   * When null, `send` simulates and nothing is broadcast. When present, `send` simulates
   * AND THEN broadcasts the bound the simulation accepted.
   */
  broadcaster?: Broadcaster | null;
  /**
   * How long to wait for a receipt before the outcome is UNKNOWN. A bound is required:
   * waiting for ever leaves a position open with a process attached to it, and treating a
   * slow receipt as a failure would send a second sell.
   */
  receiptTimeoutMs?: number;
  /** Injected so a drill can drive the receipt poll without real time. */
  now?: () => number;
  /**
   * The RECEIPT POLL's wait, separate from `wait` (the ladder interval) on purpose. The
   * in-loop caller passes a no-op ladder wait so a dry run does not sleep between rungs;
   * if the receipt poll shared it, a live broadcast would spin without delay.
   */
  pollWait?: (ms: number) => Promise<void>;
}

/**
 * THE RECEIPT WAIT. MEASURED AGAINST 2026-09-16, AND KEPT AT 60 s FOR A STATED REASON.
 *
 * `npm run receipt-timing` ran the same poll loop this module runs, against the same
 * endpoint, over 60 newly-mined blocks. The timeout has to cover two things and only one
 * of them could be measured:
 *
 *   B. RECEIPT AVAILABILITY -- MEASURED. 60 of 60 receipts served on the FIRST ask,
 *      median 20 ms, p90 24 ms, max 36 ms, nothing near the cap. There is effectively no
 *      indexing lag on this endpoint: once a block is at head its receipts are queryable.
 *   A. INCLUSION -- NOT MEASURED, AND IT IS THE DOMINANT TERM. Nothing in this repository
 *      can send, and another party's submission time is not in any available method.
 *      Bounded instead: the block interval measures 100.52 ms (6,936 ms over 69 blocks),
 *      which independently reproduces ROBINHOOD.md's ~101 ms from a different method, and
 *      blocks carry ~1.3 M gas used against a 2^50 nominal limit, so congestion is not a
 *      factor and a fee-paying transaction should land in the next block or two.
 *
 * **SO THE EXPECTED TOTAL IS ~250 ms AND THIS CONSTANT IS 240x IT.** That margin is
 * deliberate rather than lazy, for two reasons:
 *
 *   - **THE ASYMMETRY.** Firing early raises `ExitUnrecoverableError`, stops the ladder at
 *     one transaction and leaves a position for a human to reconcile against the chain.
 *     Firing late only makes the bot wait on a $10 position. The costs are nowhere near
 *     symmetric.
 *   - **THE DOMINANT TERM IS UNMEASURED.** Tightening a timeout towards a figure whose
 *     largest component has never been observed would be deriving precision from the half
 *     that happens to be measurable, which is the shape this project calls a bound of
 *     one's own presented as a fact.
 *
 * **IT IS NOW MEASURABLE AND STAYS PROVISIONAL.** `bot_exit_attempts.receipt_wait_ms` and
 * `receipt_polls` are written on every broadcast attempt, so the first real exits measure
 * the inclusion half that this could not, and the value is re-derived from our own
 * transactions rather than from other people's blocks. Every such column is NULL today.
 *
 * WHAT NO TIMEOUT COVERS: a transaction that is never included at all -- underpriced or
 * dropped. Nothing distinguishes that from a slow one, which is exactly why reaching this
 * bound raises UNRECOVERABLE rather than counting as a failed attempt.
 */
const RECEIPT_TIMEOUT_MS = 60_000;
/**
 * The poll interval. 1 s against a measured 100.52 ms block interval, so a receipt is
 * seen within a second of landing; `receipt-timing` polled at 100 ms and found the
 * receipt available on the first ask every time, so a finer interval buys nothing here.
 */
const RECEIPT_POLL_MS = 1_000;

/** The pool's observed swaps up to `toBlock`. One filtered eth_getLogs, 60 CU. */
export async function readPoolTicks(
  rpc: ExitRpc, poolId: string, tokenIsCurrency0: boolean,
  fromBlock: number, toBlock: number,
): Promise<PoolTick[]> {
  const logs = (await rpc.call('eth_getLogs', [{
    address: POOL_MANAGER, topics: [TOPICS.swapV4, poolId],
    fromBlock: `0x${fromBlock.toString(16)}`,
    toBlock: `0x${toBlock.toString(16)}`,
  }])) as Array<{ blockNumber: string; logIndex: string; data: string }>;
  const out: PoolTick[] = [];
  for (const l of logs) {
    const a = swapAmounts(l.data);
    if (!a) continue;
    const px = tokenPrice(a, tokenIsCurrency0);
    const abs = (x: bigint): bigint => (x < 0n ? -x : x);
    /* NOTIONAL IS THE PRICING-ASSET SIDE, both directions — bot/quote.ts's convention. */
    const notional = Number(tokenIsCurrency0 ? abs(a.amount1) : abs(a.amount0));
    if (!(px > 0) || !(notional > 0)) continue;
    out.push({
      block: Number(BigInt(l.blockNumber)), logIndex: Number(BigInt(l.logIndex)),
      price: px, notional,
    });
  }
  return out;
}

/**
 * Sell a position, re-quoting at exit time and climbing the measured ladder.
 * RAISES when every rung fails — the position is still open and a caller that ignored
 * a return value would leave it that way.
 */
export async function executeExit(
  ctx: ExitExecContext, pos: ExitPosition,
): Promise<ExitOutcome> {
  const tokenIsCurrency0 = pos.token.toLowerCase() < pos.counter.toLowerCase();
  const optimism = ctx.forceOptimism ?? 1;
  const bcast = ctx.broadcaster ?? null;
  const nowMs = ctx.now ?? ((): number => Date.now());
  /*
   * THE RECEIPT POLL HAS ITS OWN WAIT, AND SHARING `ctx.wait` WOULD HAVE BEEN A DEFECT.
   *
   * `ctx.wait` is the LADDER INTERVAL, and the in-loop caller passes a no-op for it
   * deliberately so a dry run does not sleep 5 s between rungs. Reusing it here would
   * make the receipt poll a busy loop hammering the endpoint the moment sends became
   * real — two different concerns behind one injection point, which is the shape that
   * makes a test control leak into a live path.
   */
  const pollWait = ctx.pollWait ?? ((ms: number): Promise<void> =>
    new Promise((r) => { setTimeout(r, ms); }));

  /*
   * THE SIMULATION MUST RUN AS THE ACCOUNT THAT WILL SEND.
   *
   * `sellFrom` is a BORROWED address on the dry-run path — the pool's first-swap sender,
   * because we hold nothing — and that is exactly what must never happen once sends are
   * real: it would simulate someone else's ability to sell and then broadcast ours, and
   * `amountIn` is derived from whoever `sellFrom` is. The guard makes a caller that
   * forgot to switch it fail here rather than at the router.
   */
  if (bcast !== null && pos.sellFrom.toLowerCase() !== bcast.address.toLowerCase()) {
    throw new ExitUnrecoverableError('LIVE EXIT MISCONFIGURED: the simulation would run '
      + `as ${pos.sellFrom} while the broadcast would be signed by ${bcast.address}. `
      + 'A live sell must simulate and send as the SAME account — otherwise the '
      + 'simulation is about a different wallet and amountIn is someone else\'s balance. '
      + 'Nothing was broadcast.');
  }

  /*
   * THE TEST CONTROL CANNOT REACH A LIVE PATH. `--force-exit-optimism` deliberately
   * inflates the re-quote so the early rungs must miss; on a broadcasting path that would
   * mean deliberately signing a bound we expect to fail.
   */
  if (bcast !== null && optimism !== 1) {
    throw new ExitUnrecoverableError(`forceOptimism ${optimism} is a DRY-RUN TEST CONTROL `
      + 'and cannot be combined with a live broadcaster: it exists to make rungs fail on '
      + 'purpose, which is not something to do with real money. Nothing was broadcast.');
  }

  const deps = {
    /* RE-QUOTED PER ATTEMPT, FROM THE POOL'S STATE NOW. */
    quote: async (_attempt: number, boundBps: number): Promise<ExitQuote> => {
      const head = Number(BigInt(String(await ctx.rpc.call('eth_blockNumber', []))));
      const ticks = await readPoolTicks(
        ctx.rpc, pos.poolId, tokenIsCurrency0, pos.firstSwapBlock, head,
      );
      const last = ticks[ticks.length - 1];
      if (!last) {
        throw new Error(`pool ${pos.poolId.slice(0, 18)} has no readable swap to quote `
          + 'against at exit time; refusing to sell blind');
      }
      /* SELLING: input is the token, output is the pricing asset, so the rate is the
       * price itself — the reciprocal of the buy's rate. bot/price.ts owns both. */
      const q = quote({
        amountIn: pos.amountIn, rateOutPerIn: last.price, side: 'sell',
        fee: pos.fee, ticks,
      });
      const expected = optimism === 1
        ? q.expectedOut
        : BigInt(Math.floor(Number(q.expectedOut) * optimism));
      return { expectedOut: expected, amountOutMinimum: boundedMinOut(expected, boundBps) };
    },

    send: async (q: ExitQuote): Promise<SendResult> => {
      const tx = buildSwap({
        pool: {
          currency0: tokenIsCurrency0 ? pos.token : pos.counter,
          currency1: tokenIsCurrency0 ? pos.counter : pos.token,
          fee: pos.fee, tickSpacing: pos.tickSpacing, hooks: pos.hooks,
        },
        zeroForOne: tokenIsCurrency0,
        amountIn: pos.amountIn, amountOutMinimum: q.amountOutMinimum,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
      });

      /* ---- STEP 1: SIMULATE. ON BOTH PATHS, ALWAYS. ----------------------- */
      try {
        const r = await ctx.rpc.call('eth_call', [{
          from: pos.sellFrom, to: UNIVERSAL_ROUTER, value: '0x0', data: tx.data,
        }, 'latest']);
        if (bcast === null) return `returned ${String(r).slice(0, 18)}`;
      } catch (err) {
        /*
         * DECODE THE REVERT RATHER THAN RECORDING "execution reverted".
         * A bare message is not a measurement — it is what made the first exit numbers
         * unreadable until `revert-decode` was written. This is also why the simulation
         * runs in live mode: a mined failure gives `status: 0` and nothing else.
         *
         * An ORDINARY rejection: nothing was sent, so the next rung is safe.
         */
        const e = err as Error & { data?: unknown };
        const d = (e as { data?: unknown }).data;
        if (typeof d === 'string' && d.startsWith(V4_TOO_LITTLE)) {
          const [mn, got] = abi.decode(['uint256', 'uint256'],
            `0x${d.slice(10)}`) as unknown as [bigint, bigint];
          throw new Error(`V4TooLittleReceived bound=${mn} actual=${got}`);
        }
        throw new Error(e.message.slice(0, 160));
      }

      /* ---- STEP 2: THE ALLOWANCES — GRANTED HERE IF THEY ARE SHORT -------- */
      /*
       * THIS USED TO REFUSE AND IT NOW GRANTS, WHICH IS WHAT MAKES A FAILED INLINE GRANT
       * RECOVERABLE. LAUNCHBOT.md section 2D.
       *
       * The loop grants both approvals immediately after a live buy confirms, so on the
       * ordinary path this is a free read that finds them already in place. It matters on
       * the path that is not ordinary: a position whose inline grant failed is marked
       * `needs_exit`, and the boot sweep re-enters through this same executor — so the
       * approval is attempted again, against a balance the chain has confirmed. Refusing
       * here instead would leave that position permanently unsellable, which is the
       * outcome every part of this file exists to prevent.
       *
       * **IT IS DELIBERATELY THE LAST POSSIBLE MOMENT.** The rung's simulation has already
       * returned, so the pool has just told us it will pay this bound — and gas is never
       * spent granting an allowance for a pool that was not going to pay anyway. It is
       * naturally at-most-once per exit: once the grant lands it covers every later rung,
       * and `ensureSellReadiness` skips what already covers.
       *
       * The simulation ran as `pos.sellFrom`, which the guard above has already proved is
       * the broadcaster's own address, so this grants for the account that will send.
       *
       * STILL UNRECOVERABLE WHEN IT CANNOT BE MADE READY: no bound fixes a missing
       * allowance, so climbing the ladder would waste the remaining attempts on a problem
       * that is not about the bound. Nothing of the SELL has been sent at this point — and
       * `ensureSellReadiness` raises rather than returning a status, so reaching the line
       * below means the allowances cover this position.
       */
      try {
        await ensureSellReadiness(
          {
            rpc: ctx.rpc, broadcaster: bcast,
            ...(ctx.now ? { now: ctx.now } : {}),
            wait: pollWait,
            ...(ctx.receiptTimeoutMs !== undefined
              ? { receiptTimeoutMs: ctx.receiptTimeoutMs } : {}),
          },
          { token: pos.token, owner: bcast.address, amount: pos.amountIn },
        );
      } catch (err) {
        throw new ExitUnrecoverableError('CANNOT SELL — the approvals do not cover this '
          + `position and could not be granted: ${(err as Error).message.slice(0, 220)} `
          + 'No SELL was broadcast.');
      }

      /* ---- STEP 3: BROADCAST THE BOUND THE POOL JUST ACCEPTED ------------- */
      let hash: string;
      try {
        hash = await bcast.send({
          to: UNIVERSAL_ROUTER, data: tx.data, value: 0n,
          description: `EXIT trade ${pos.tradeId} minOut=${q.amountOutMinimum}`,
        });
      } catch (err) {
        /*
         * A REJECTED BROADCAST IS UNRECOVERABLE, because "the send threw" does not
         * establish that nothing was sent. A transport error can arrive after the node
         * already accepted the transaction — `signer.send` says exactly this about an
         * unreadable result — and a second sell against a position that may be gone is
         * the outcome this class exists to prevent.
         */
        throw new ExitUnrecoverableError('BROADCAST FAILED AND THE OUTCOME IS NOT '
          + `ESTABLISHED: ${(err as Error).message.slice(0, 160)}. A transaction may or `
          + 'may not be in flight; reconcile against the chain before selling again.');
      }
      log.warn('EXIT BROADCAST', {
        trade: pos.tradeId, hash, min_out: q.amountOutMinimum.toString(),
      });

      /* ---- STEP 4: THE RECEIPT DECIDES, AND AN ABSENT ONE IS NOT A FAILURE - */
      /*
       * THE WAIT ITSELF LIVES IN `bot/receipt.ts`, shared with `approve-setup`. It returns
       * the outcome rather than throwing, because `mined`, `reverted` and `unknown` are
       * three different facts and each caller reacts differently — here a revert advances
       * the ladder and an absent receipt stops it.
       */
      const rec = await awaitReceipt(ctx.rpc, hash, {
        timeoutMs: ctx.receiptTimeoutMs ?? RECEIPT_TIMEOUT_MS,
        pollMs: RECEIPT_POLL_MS,
        wait: pollWait,
        ...(ctx.now ? { now: ctx.now } : {}),
      });

      if (rec.outcome === 'mined') {
        /*
         * THE TIMING IS RETURNED, NOT JUST LOGGED. `receipt-timing` could measure the
         * availability half of this wait and NOT the inclusion half, because nothing
         * here can send. These two figures are the first real measurement of it, and
         * they land in columns rather than in a text field because `bot_exit_attempts`
         * is a measurement table rather than a log.
         */
        return {
          detail: `BROADCAST FILLED ${hash} in block ${rec.blockNumber ?? '?'}`,
          receiptWaitMs: rec.waitMs,
          receiptPolls: rec.polls,
        };
      }
      if (rec.outcome === 'reverted') {
        /*
         * MINED AND REVERTED. This IS an ordinary failure: the transaction is settled,
         * nothing is in flight, and the next rung is safe to try. The price moved
         * between the call and the broadcast, which is the race this design accepts.
         */
        throw new Error(`broadcast ${hash} MINED AND REVERTED (status 0) — the pool `
          + 'moved between the simulation and the send');
      }
      /*
       * NO RECEIPT. The transaction is neither confirmed nor known to have failed, so
       * the position's state is UNKNOWN. This must not advance the ladder and must not
       * be recorded as a failure — both would be a plausible value on an error path,
       * and the second would send another sell.
       */
      throw new ExitUnrecoverableError(`NO RECEIPT for ${hash} after ${rec.waitMs} ms `
        + `(${rec.polls} polls). THE POSITION STATE IS UNKNOWN: the sell may still land. `
        + 'The ladder has STOPPED and no second transaction was sent. Boot reconciliation '
        + 'against the chain settles this.');
    },

    record: async (a: ExitAttempt): Promise<void> => {
      await ctx.client.query(
        `insert into bot_exit_attempts
           (chain, trade_id, attempt, bound_bps, expected_out, min_out, ok, detail,
            sell_from, receipt_wait_ms, receipt_polls)
         values ($9, $1, $2, $3, $4, $5, $6, $7, $8, $10, $11)
         on conflict (chain, trade_id, attempt) do update
           set bound_bps = excluded.bound_bps, expected_out = excluded.expected_out,
               min_out = excluded.min_out, ok = excluded.ok, detail = excluded.detail,
               sell_from = excluded.sell_from,
               receipt_wait_ms = excluded.receipt_wait_ms,
               receipt_polls = excluded.receipt_polls, recorded_at = now()`,
        [pos.tradeId, a.attempt, a.boundBps, a.expectedOut, a.amountOutMinimum,
          a.ok, a.detail, pos.sellFrom, ctx.chain,
          a.receiptWaitMs ?? null, a.receiptPolls ?? null]);
    },

    ...(ctx.wait ? { wait: ctx.wait } : {}),
  };

  const outcome = await exitWithRetry(deps, pos.poolId);
  log.info('EXIT COMPLETE', {
    trade: pos.tradeId, pool: pos.poolId.slice(0, 18),
    path: bcast === null ? 'SIMULATED — nothing broadcast' : `BROADCAST as ${bcast.address}`,
    filled_on_attempt: outcome.filledOn,
    bound_that_cleared: outcome.filledOn ? boundForAttempt(outcome.filledOn) : null,
    attempts: outcome.attempts.length,
  });
  return outcome;
}

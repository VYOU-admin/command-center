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
 * In dry run nothing is broadcast: `send` is an `eth_call`, and `ReadOnlyRpc` refuses
 * every signing and broadcast method by name. The `from` address is supplied by the
 * caller because **the two callers borrow different addresses and for different
 * reasons**, and conflating them would make the result unreadable:
 *
 *   - the in-loop exit borrows the pool's first-swap sender, because we do not hold the
 *     token at all in dry run;
 *   - the boot exit uses whatever address the row's position is attributed to.
 *
 * Both are recorded per attempt. A clean simulation from a borrowed holder proves the
 * pool accepts the sell and the calldata is well formed; it does NOT prove our own
 * approval state, which section 2 measures separately.
 */
import { AbiCoder, id } from 'ethers';
import { buildSwap } from './calldata.js';
import { quote } from './quote.js';
import type { PoolTick } from './quote.js';
import { swapAmounts, tokenPrice } from './price.js';
import { boundForAttempt, boundedMinOut, exitWithRetry } from './exit.js';
import type { ExitAttempt, ExitOutcome, ExitQuote } from './exit.js';
import { POOL_MANAGER, UNIVERSAL_ROUTER } from './config.js';
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
   * TEST CONTROL, DRY RUN ONLY. Multiplies the re-quote so the first rungs are
   * guaranteed to miss and the ladder must climb. Defaults to 1 (no effect). It exists
   * because a retry path nobody has exercised is not a retry path, and waiting for a
   * natural revert to appear in a 90-minute window is not a test.
   */
  forceOptimism?: number;
  /** Injected so a drill does not wait the real interval. */
  wait?: (ms: number) => Promise<void>;
}

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

    send: async (q: ExitQuote): Promise<string> => {
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
      try {
        const r = await ctx.rpc.call('eth_call', [{
          from: pos.sellFrom, to: UNIVERSAL_ROUTER, value: '0x0', data: tx.data,
        }, 'latest']);
        return `returned ${String(r).slice(0, 18)}`;
      } catch (err) {
        /*
         * DECODE THE REVERT RATHER THAN RECORDING "execution reverted".
         * A bare message is not a measurement — it is what made the first exit numbers
         * unreadable until `revert-decode` was written.
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
    },

    record: async (a: ExitAttempt): Promise<void> => {
      await ctx.client.query(
        `insert into bot_exit_attempts
           (chain, trade_id, attempt, bound_bps, expected_out, min_out, ok, detail, sell_from)
         values ('robinhood', $1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (chain, trade_id, attempt) do update
           set bound_bps = excluded.bound_bps, expected_out = excluded.expected_out,
               min_out = excluded.min_out, ok = excluded.ok, detail = excluded.detail,
               sell_from = excluded.sell_from, recorded_at = now()`,
        [pos.tradeId, a.attempt, a.boundBps, a.expectedOut, a.amountOutMinimum,
          a.ok, a.detail, pos.sellFrom]);
    },

    ...(ctx.wait ? { wait: ctx.wait } : {}),
  };

  const outcome = await exitWithRetry(deps, pos.poolId);
  log.info('EXIT COMPLETE', {
    trade: pos.tradeId, pool: pos.poolId.slice(0, 18),
    filled_on_attempt: outcome.filledOn,
    bound_that_cleared: outcome.filledOn ? boundForAttempt(outcome.filledOn) : null,
    attempts: outcome.attempts.length,
  });
  return outcome;
}

/**
 * `npm run revert-economics -- [--phase bot|historical|both] [--half search|holdout|all]`
 *
 * ARE THE REVERTED TRADES MISSED OPPORTUNITY OR AVOIDED LOSSES?
 *
 * The entry revert rate has run 29.2 / 31.3 / 32.4 / 40.6% across four dry runs and is
 * recorded as unexplained. Almost all of them are `V4TooLittleReceived` — OUR OWN
 * `amountOutMinimum`. The temptation is to widen the bound. **This asks first whether the
 * refused trades were winners**, because a bound that refuses losers is not a cost.
 *
 * ---------------------------------------------------------------------------
 * THE GROUND TRUTH, AND WHY IT IS EXACT
 * ---------------------------------------------------------------------------
 *
 * `V4TooLittleReceived(uint256,uint256)` carries `(minAmountOutReceived, amountReceived)`.
 * Setting `amountOutMinimum` to an unreachable value therefore turns the router into an
 * ORACLE FOR ITS OWN OUTPUT at our exact size and block, at 26 CU, with no assumption
 * anywhere — the mechanism `quote-check` established. **Every launch is probed the same
 * way, accepted and refused alike**, so there is no branch on the outcome we are trying
 * to measure: a uniform call gives `actualOut` for all of them.
 *
 * ---------------------------------------------------------------------------
 * REFUSAL IS MONOTONE IN THE BOUND, WHICH IS WHAT MAKES THE SWEEP POSSIBLE
 * ---------------------------------------------------------------------------
 *
 * `minOut = floor(quoted x (10000 - b) / 10000)` and a trade is refused when
 * `actualOut < minOut`. So for a given launch there is a single CRITICAL BOUND above
 * which it is accepted and below which it is refused, and every candidate bound is then
 * ARITHMETIC over one simulation rather than another simulation. The sweep is exact, not
 * sampled.
 *
 * **THE ACCEPT TEST USES `minOut`'S OWN INTEGER ARITHMETIC, not a float threshold**, and
 * the run asserts that at the configured 300 bps it agrees with the real `rule.minOut()`
 * on every launch. Re-deriving a policy in floating point beside the integer one it
 * shadows is the two-implementations trap this project has recorded six times.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE RETURN OF A REFUSED TRADE MEANS
 * ---------------------------------------------------------------------------
 *
 * Had the bound admitted it, we would have filled at what the pool actually pays — so the
 * entry price is `amountIn / actualOut`, which already contains the fee and our own
 * impact. The exit is the first trade STRICTLY AFTER the horizon mark, priced by
 * `bot/price.ts`, exactly as the published exit grid does. **No exit found scores ZERO
 * and is counted**, which is the stated convention.
 *
 * **THAT CONVENTION BIASES THIS WHOLE PASS TOWARD WIDENING AND IT IS SAID ONCE HERE.** A
 * position that cannot be sold is not a flat trade, it is a total loss; scoring it zero
 * makes taking a trade look free when it is not. Exit-availability is therefore reported
 * beside every median, as the exit-horizon grid requires, and any bound this derives is
 * an UPPER bound on what is justified.
 *
 * ---------------------------------------------------------------------------
 * THE HISTORICAL PHASE IS A MODEL, AND IT IS VALIDATED BEFORE IT IS BELIEVED
 * ---------------------------------------------------------------------------
 *
 * The bot's own launches are ~100. The swept windows hold tens of thousands, but there is
 * no oracle for a pool at a block nobody probed, so `actualOut` there is MODELLED as the
 * realised price of the first real trade after our entry mark — a genuine trade at a
 * genuine price, missing only our own marginal impact. **The model is scored against the
 * ground truth on the bot's launches first and the agreement is reported**, because an
 * aggregate is a hypothesis until individual records support it.
 *
 * Note that `b*` is very nearly SIZE-INDEPENDENT: `quoted = amountIn x rate x (1-fee) x
 * (1-impact)`, so `amountIn` cancels out of `quotedPrice` except inside the impact term,
 * which fires on 2 of 66 live trades. The historical reconstruction therefore barely
 * depends on the era's ETH/USD, and that is a property rather than an assumption.
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { AbiCoder, id } from 'ethers';
import { RpcClient, RpcError } from '../adapters/token-updates/rpc.js';
import { ReadOnlyRpc } from '../bot/rpc.js';
import { buildSwap } from '../bot/calldata.js';
import { quote } from '../bot/quote.js';
import type { PoolTick } from '../bot/quote.js';
import { swapAmounts, tokenPrice } from '../bot/price.js';
import { minOut as realMinOut } from '../bot/rule.js';
import {
  ALLOWED_FEES, ENTRY_DELAY_BLOCKS, GAP_MAX_BLOCKS, GAP_MIN_BLOCKS, POOL_MANAGER,
  SLIPPAGE_BPS, UNIVERSAL_ROUTER,
} from '../bot/config.js';
import { TOPICS } from '../adapters/token-updates/decode.js';
import { halfPredicate, isHalf } from '../bot/holdout.js';
import type { Half } from '../bot/holdout.js';
import type { PoolClient } from '../store/db.js';

const abi = AbiCoder.defaultAbiCoder();
const V4_TOO_LITTLE = id('V4TooLittleReceived(uint256,uint256)').slice(0, 10);
const RPC_URL = 'https://robinhood-mainnet.g.alchemy.com/v2/{key}';
const PRICING = [
  '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
  '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
  '0x0000000000000000000000000000000000000000',
];
const BLOCKS_PER_SECOND = 10;
const HORIZONS_S = [15, 30, 45, 60, 90, 120, 180, 300, 450, 600] as const;
const CONFIGURED_H = 90;
const MAX_HORIZON_BLOCKS = Math.max(...HORIZONS_S) * BLOCKS_PER_SECOND;
const FILL_SLACK_BLOCKS = 3000;
const TICK_HORIZON_BLOCKS = MAX_HORIZON_BLOCKS + FILL_SLACK_BLOCKS;

/** The candidate bounds the operator named, plus a fine grid for the derivation. */
const NAMED_BOUNDS = [300, 500, 1000, 2000] as const;
const SWEEP_BOUNDS = ((): number[] => {
  const out: number[] = [];
  for (let b = 0; b <= 500; b += 25) out.push(b);
  for (let b = 550; b <= 3000; b += 50) out.push(b);
  for (let b = 3200; b <= 9500; b += 200) out.push(b);
  return out;
})();

const WINDOWS: Array<[string, number, number]> = [
  ['HOLDOUT-ERA', 15115267, 42695454],
  ['MIDPOINT', 52200000, 53200000],
  ['CALM', 60700000, 61700000],
  ['SELLOFF', 63216393, 64216393],
];

/* ---------------------------------------------------------------- statistics */
/** Medians, never means. A single degenerate launch must not BE the answer. */
function quantile(xs: number[], q: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i); const hi = Math.ceil(i);
  return lo === hi ? s[lo]! : s[lo]! + (s[hi]! - s[lo]!) * (i - lo);
}
const med = (xs: number[]): number | null => quantile(xs, 0.5);
const r5 = (x: number | null): number | null => (x === null ? null : Number(x.toFixed(5)));

interface Launch {
  key: string;
  label: string;          /* mode, or window */
  poolId: string;
  fee: number;
  launchpad: string | null;
  amountIn: bigint;
  quoted: bigint;
  actualOut: bigint;
  /** raw pricing units per token, the price we would have filled at. */
  pxFill: number;
  /** first-swap notional in raw pricing units — a proxy for how thin the pool is. */
  depthNotional: number;
  /** null = no trade to exit into at that horizon. */
  ret: Record<number, number | null>;
  asRunReverted: boolean | null;
}

/** ACCEPTED under bound b, in minOut's own integer arithmetic. */
function acceptedAt(l: Launch, bps: number): boolean {
  const bound = (l.quoted * BigInt(10000 - bps)) / 10000n;
  return bound <= l.actualOut;
}

/** The shortfall the recorded reverts are banded by: our bound / what the pool pays. */
function shortfallRatio(l: Launch, bps: number): number {
  const bound = (l.quoted * BigInt(10000 - bps)) / 10000n;
  return Number(bound) / Number(l.actualOut);
}

/**
 * Return contributed to the objective.
 *
 * A REFUSED trade contributes exactly zero: we did not trade, so there is no gain and
 * no loss. That is not a convention, it is what happens.
 *
 * A TAKEN trade with NO EXIT is the one that needs a decision, and `noExitPenalty` is
 * it. The stated convention across both documents is ZERO, and zero is wrong in a
 * specific direction: a position nothing will buy is not a flat trade, it is a position
 * whose money is gone. Scoring it zero makes taking a trade look free, and since the
 * trades a wider bound admits are disproportionately the ones with no exit, the
 * convention systematically argues for widening.
 *
 * Both are therefore reported side by side and neither is presented as the answer.
 * -1 is the honest worst case: the tokens are unsellable and the position is a total
 * loss. The truth is between them and closer to -1 than to 0.
 */
/**
 * The return of a launch at a horizon, with no-exit mapped to the chosen penalty.
 *
 * A MISSING key is not a no-exit. Null means "looked, found no trade"; undefined means
 * the horizon was never evaluated, which is a defect and must not become a plausible
 * zero — the standing rule on this project.
 */
function retAt(l: Launch, h: number, noExitPenalty: number): number {
  const r = l.ret[h];
  if (r === undefined) {
    throw new Error(`launch ${l.key} has no computed return at +${h}s — the horizon was `
      + 'never evaluated, which is not the same as having no exit');
  }
  return r === null ? noExitPenalty : r;
}

/** What a launch contributes to the objective under bound `bps`. Refused = exactly 0. */
function contribution(l: Launch, bps: number, h: number, noExitPenalty: number): number {
  if (!acceptedAt(l, bps)) return 0;
  return retAt(l, h, noExitPenalty);
}

function describe(xs: number[], exitsFound: number, n: number): Record<string, unknown> {
  return {
    n,
    exit_found: exitsFound,
    exit_found_pct: n === 0 ? null : Number(((exitsFound / n) * 100).toFixed(1)),
    median: r5(med(xs)),
    p25: r5(quantile(xs, 0.25)),
    p75: r5(quantile(xs, 0.75)),
    pct_positive: xs.length === 0 ? null
      : Number(((xs.filter((x) => x > 0).length / xs.length) * 100).toFixed(1)),
    worst: r5(xs.length ? Math.min(...xs) : null),
    best: r5(xs.length ? Math.max(...xs) : null),
  };
}

/* ------------------------------------------------- PHASE 1: the bot's trades */

async function phaseBot(c: PoolClient, rpc: ReadOnlyRpc): Promise<Launch[]> {
  const rows = await c.query<{
    id: string; mode: string; status: string; pool_id: string; token: string;
    counter: string; fee: number; tick_spacing: number; hooks: string;
    first_swap_block: string; position_wei: string; launchpad: string | null;
  }>(
    `select id::text, mode, status, pool_id, token, counter, fee, tick_spacing, hooks,
            first_swap_block::text, position_wei::text, launchpad
       from bot_trades
      where chain = 'robinhood' and position_wei is not null
        and first_swap_block is not null
      order by id`);

  log.info('PHASE 1 WORK SET — the bot\'s own launches, ground truth by oracle', {
    launches: rows.rowCount,
    reverted_as_run: rows.rows.filter((r) => r.status === 'sim_reverted').length,
    accepted_as_run: rows.rows.filter((r) => r.status !== 'sim_reverted').length,
    cost: `${rows.rowCount} x (60 CU getLogs + 26 CU eth_call) = `
      + `${(rows.rowCount ?? 0) * 86} CU before the first call`,
  });
  if ((rows.rowCount ?? 0) === 0) {
    throw new Error('the bot launch set is EMPTY — a population matching nothing is a '
      + 'suspected defect, not a clean pass');
  }

  const out: Launch[] = [];
  let noTruth = 0; let noQuote = 0;
  const noTruthReasons: Record<string, number> = {};

  for (const r of rows.rows) {
    const firstSwap = Number(r.first_swap_block);
    const entryBlock = firstSwap + ENTRY_DELAY_BLOCKS;
    const tokenIsC0 = r.token.toLowerCase() < r.counter.toLowerCase();
    const zeroIsPricing = !tokenIsC0;
    const size = BigInt(r.position_wei);

    /* One request covers the pre-entry ticks AND every horizon. */
    let logs: Array<{ blockNumber: string; logIndex: string; data: string }> = [];
    try {
      logs = (await rpc.call('eth_getLogs', [{
        address: POOL_MANAGER, topics: [TOPICS.swapV4, r.pool_id],
        fromBlock: `0x${firstSwap.toString(16)}`,
        toBlock: `0x${(entryBlock + TICK_HORIZON_BLOCKS).toString(16)}`,
      }])) as typeof logs;
    } catch (e) {
      noTruth += 1;
      noTruthReasons['getLogs failed'] = (noTruthReasons['getLogs failed'] ?? 0) + 1;
      continue;
    }

    const pre: PoolTick[] = []; const post: Array<{ block: number; li: number; px: number }> = [];
    let depthNotional = 0;
    for (const l of logs) {
      const a = swapAmounts(l.data);
      if (!a) continue;
      const px = tokenPrice(a, tokenIsC0);
      const abs = (x: bigint): bigint => (x < 0n ? -x : x);
      const notional = Number(tokenIsC0 ? abs(a.amount1) : abs(a.amount0));
      if (!(px > 0) || !(notional > 0)) continue;
      const block = Number(BigInt(l.blockNumber));
      const li = Number(BigInt(l.logIndex));
      if (block <= entryBlock) {
        if (pre.length === 0) depthNotional = notional;
        pre.push({ block, logIndex: li, price: px, notional });
      } else post.push({ block, li, px });
    }

    const last = pre[pre.length - 1];
    if (!last) { noQuote += 1; continue; }
    /* tokens per pricing unit. bot/price.ts owns the convention; this is its reciprocal. */
    const rate = 1 / last.price;

    let quoted: bigint;
    try {
      quoted = quote({ amountIn: size, rateOutPerIn: rate, side: 'buy', fee: r.fee,
        ticks: pre }).expectedOut;
    } catch { noQuote += 1; continue; }

    /* THE ORACLE. An unreachable bound, so every launch reverts and reports its output. */
    let actual: bigint | null = null;
    const probe = buildSwap({
      pool: {
        currency0: tokenIsC0 ? r.token : r.counter,
        currency1: tokenIsC0 ? r.counter : r.token,
        fee: r.fee, tickSpacing: r.tick_spacing, hooks: r.hooks,
      },
      zeroForOne: zeroIsPricing,
      amountIn: size,
      amountOutMinimum: quoted * 1_000_000n,
      deadline: BigInt('0xffffffffff'),
    });
    try {
      await rpc.call('eth_call', [{
        from: '0x000000000000000000000000000000000000dEaD',
        to: UNIVERSAL_ROUTER, value: `0x${size.toString(16)}`, data: probe.data,
      }, `0x${entryBlock.toString(16)}`]);
      /* A SUCCESS here would mean an unreachable bound was reachable. */
      noTruth += 1;
      noTruthReasons['probe did not revert'] = (noTruthReasons['probe did not revert'] ?? 0) + 1;
      continue;
    } catch (e) {
      const d = e instanceof RpcError ? e.data : undefined;
      if (typeof d === 'string' && d.startsWith(V4_TOO_LITTLE)) {
        const [, got] = abi.decode(['uint256', 'uint256'],
          `0x${d.slice(10)}`) as unknown as [bigint, bigint];
        actual = got;
      } else {
        noTruth += 1;
        const why = (e as Error).message.slice(0, 40);
        noTruthReasons[why] = (noTruthReasons[why] ?? 0) + 1;
        continue;
      }
    }
    if (actual === null || actual === 0n) {
      /* A pool that pays NOTHING cannot price a trade either way. Counted, never folded. */
      noTruth += 1;
      noTruthReasons['pool pays zero'] = (noTruthReasons['pool pays zero'] ?? 0) + 1;
      continue;
    }

    const pxFill = Number(size) / Number(actual);
    const ret: Record<number, number | null> = {};
    for (const h of HORIZONS_S) {
      const mark = entryBlock + h * BLOCKS_PER_SECOND;
      const ex = post.find((p) => p.block > mark);
      ret[h] = ex ? ex.px / pxFill - 1 : null;
    }

    out.push({
      key: r.id, label: r.mode, poolId: r.pool_id, fee: r.fee,
      launchpad: r.launchpad, amountIn: size, quoted, actualOut: actual,
      pxFill, depthNotional, ret, asRunReverted: r.status === 'sim_reverted',
    });
  }

  log.info('PHASE 1 GROUND TRUTH ESTABLISHED', {
    launches_with_truth: out.length,
    no_ground_truth: noTruth,
    no_quote: noQuote,
    reasons: noTruthReasons,
    note: 'every count is reported including zeros; a launch without an oracle answer is '
      + 'excluded from every figure below rather than folded in at zero',
    cu_spent: rpc.cuSpent,
  });
  return out;
}

/* ------------------------------------------ PHASE 2: the historical windows */

async function phaseHistorical(c: PoolClient, half: Half): Promise<Launch[]> {
  await c.query('set statement_timeout = 0');
  /* Materialised into indexed temp tables — ROBINHOOD.md records three queries of this
   * shape hanging for 19, 17 and 10 minutes as CTEs. */
  await c.query(`create temp table h_launches (
    win text, pool_id text primary key, fee bigint, token_is_c0 boolean,
    first_swap bigint, entry_block bigint)`);

  const perWindow: Array<Record<string, unknown>> = [];
  for (const [label, from, to] of WINDOWS) {
    const usableTo = to - ENTRY_DELAY_BLOCKS - TICK_HORIZON_BLOCKS;
    const ins = await c.query(
      `insert into h_launches
       select $5, i.pool_id, i.fee, (i.currency1 = any($1)) as token_is_c0,
              f.fb, f.fb + ${ENTRY_DELAY_BLOCKS}
         from v4_pool_init i
         join lateral (select min(block_number) fb from v4_swaps_all s
                        where s.pool_id = i.pool_id
                          and s.block_number between $2 and $3) f on true
        where i.block_number between $2 and $3
          and i.fee = any($4)
          and ((i.currency0 = any($1)) <> (i.currency1 = any($1)))
          and f.fb is not null
          and (f.fb - i.block_number) between ${GAP_MIN_BLOCKS} and ${GAP_MAX_BLOCKS}
          and f.fb <= $6
          and ${halfPredicate(half, 'i.pool_id')}
        on conflict (pool_id) do nothing`,
      [PRICING, from, to, ALLOWED_FEES, label, usableTo]);
    perWindow.push({ window: label, launches_kept: ins.rowCount, usable_to: usableTo });
  }
  await c.query('analyze h_launches');

  const tot = await c.query<{ n: string }>('select count(*)::text n from h_launches');
  log.info('PHASE 2 POPULATION — the four swept windows, modelled', {
    half, per_window: perWindow, launches_total: Number(tot.rows[0]!.n),
    split: 'md5(pool_id) first hex char (bot/holdout.ts)',
  });
  if (Number(tot.rows[0]!.n) === 0) {
    throw new Error('the historical launch set is EMPTY — a suspected defect, not a pass');
  }

  /*
   * PRE-ENTRY ticks feed the quote; POST-ENTRY ticks feed the fill and the horizons.
   * Both are the same price convention exit-horizon uses, in RAW units, with absolute
   * values so the sign convention cannot enter.
   */
  await c.query(`create temp table h_pre as
    select l.pool_id, s.block_number blk, s.log_index,
           case when l.token_is_c0 then abs(s.amount1)::double precision / abs(s.amount0)
                else abs(s.amount0)::double precision / abs(s.amount1) end px,
           case when l.token_is_c0 then abs(s.amount1)::double precision
                else abs(s.amount0)::double precision end notional
      from h_launches l join v4_swaps_all s on s.pool_id = l.pool_id
     where s.block_number between l.first_swap and l.entry_block
       and s.amount0 <> 0 and s.amount1 <> 0`);
  await c.query('create index on h_pre (pool_id, blk, log_index); analyze h_pre');

  await c.query(`create temp table h_post as
    select l.pool_id, (s.block_number - l.entry_block)::bigint off, s.log_index,
           case when l.token_is_c0 then abs(s.amount1)::double precision / abs(s.amount0)
                else abs(s.amount0)::double precision / abs(s.amount1) end px
      from h_launches l join v4_swaps_all s on s.pool_id = l.pool_id
     where s.block_number > l.entry_block
       and s.block_number <= l.entry_block + ${TICK_HORIZON_BLOCKS}
       and s.amount0 <> 0 and s.amount1 <> 0`);
  await c.query('create index on h_post (pool_id, off, log_index); analyze h_post');

  /* The fill: the first trade STRICTLY AFTER the entry mark — a real trade at a real
   * price. This is the model's stand-in for the oracle, and its only gap is our own
   * marginal impact, which phase 3 measures rather than assumes. */
  const fills = await c.query<{ pool_id: string; px: string }>(
    `select distinct on (pool_id) pool_id, px::text from h_post
      order by pool_id, off asc, log_index asc`);
  const fillPx = new Map<string, number>();
  for (const f of fills.rows) fillPx.set(f.pool_id, Number(f.px));

  const meta = await c.query<{ pool_id: string; win: string; fee: string }>(
    'select pool_id, win, fee::text from h_launches');
  const info = new Map(meta.rows.map((m) => [m.pool_id, m]));

  /* Pre-entry ticks, grouped in one ordered pass. */
  const preRows = await c.query<{
    pool_id: string; blk: string; log_index: number; px: string; notional: string;
  }>('select pool_id, blk::text, log_index, px::text, notional::text from h_pre '
    + 'order by pool_id, blk, log_index');
  const preByPool = new Map<string, PoolTick[]>();
  for (const p of preRows.rows) {
    const arr = preByPool.get(p.pool_id) ?? [];
    arr.push({ block: Number(p.blk), logIndex: p.log_index, price: Number(p.px),
      notional: Number(p.notional) });
    preByPool.set(p.pool_id, arr);
  }

  const post = await c.query<{ pool_id: string; off: string; px: string }>(
    'select pool_id, off::text, px::text from h_post order by pool_id, off, log_index');
  const postByPool = new Map<string, Array<{ off: number; px: number }>>();
  for (const p of post.rows) {
    const arr = postByPool.get(p.pool_id) ?? [];
    arr.push({ off: Number(p.off), px: Number(p.px) });
    postByPool.set(p.pool_id, arr);
  }

  /*
   * SIZE. `b*` is nearly size-independent (amountIn cancels except inside impact), so a
   * single representative size is used rather than reconstructing each era's ETH/USD —
   * and the claim is checked in phase 3 against the ground-truth launches, which carry
   * their own real sizes.
   */
  const SIZE = 4_000_000_000_000_000n;   /* 0.004 ETH, ~$10 at the eras' ETH/USD */

  const out: Launch[] = [];
  let noQuote = 0; let noFill = 0;
  for (const [poolId, m] of info) {
    const pre = preByPool.get(poolId);
    const last = pre?.[pre.length - 1];
    const px = fillPx.get(poolId);
    if (!pre || !last) { noQuote += 1; continue; }
    if (px === undefined || !(px > 0)) {
      /*
       * NO TRADE AFTER ENTRY AT ALL. This is a genuine no-fill and it must stay in the
       * denominator — dropping it is the survivorship error that produced a +18.2%
       * median once. It is carried with every horizon null, so it scores zero.
       */
      noFill += 1;
      out.push({
        key: poolId, label: m.win, poolId, fee: Number(m.fee), launchpad: null,
        amountIn: SIZE, quoted: 1n, actualOut: 0n, pxFill: 0, depthNotional: 0,
        ret: Object.fromEntries(HORIZONS_S.map((h) => [h, null])) as Record<number, null>,
        asRunReverted: null,
      });
      continue;
    }
    let quoted: bigint;
    try {
      quoted = quote({ amountIn: SIZE, rateOutPerIn: 1 / last.price, side: 'buy',
        fee: Number(m.fee), ticks: pre }).expectedOut;
    } catch { noQuote += 1; continue; }

    /* MODELLED actualOut: what our size buys at the price a real trade just got. */
    const actual = BigInt(Math.floor(Number(SIZE) / px));
    if (actual <= 0n) { noQuote += 1; continue; }

    const ps = postByPool.get(poolId) ?? [];
    const ret: Record<number, number | null> = {};
    for (const h of HORIZONS_S) {
      const mark = h * BLOCKS_PER_SECOND;
      const ex = ps.find((p) => p.off > mark);
      ret[h] = ex ? ex.px / px - 1 : null;
    }
    out.push({
      key: poolId, label: m.win, poolId, fee: Number(m.fee), launchpad: null,
      amountIn: SIZE, quoted, actualOut: actual, pxFill: px,
      depthNotional: last.notional, ret, asRunReverted: null,
    });
  }

  log.info('PHASE 2 RECONSTRUCTED', {
    launches: out.length,
    no_trade_after_entry_kept_as_no_fill: noFill,
    excluded_no_quote: noQuote,
    note: 'a launch with no post-entry trade is KEPT with a null at every horizon so it '
      + 'scores zero; excluding it would be the survivorship error',
  });
  return out;
}

/* --------------------------------------------------------------- the report */

function reportSplit(title: string, ls: Launch[], bps: number, h: number,
  noExitPenalty = 0): void {
  const acc = ls.filter((l) => acceptedAt(l, bps));
  const ref = ls.filter((l) => !acceptedAt(l, bps));
  const vals = (xs: Launch[]): number[] => xs.map((l) => retAt(l, h, noExitPenalty));
  const exits = (xs: Launch[]): number => xs.filter((l) => l.ret[h] !== null).length;
  log.info(title, {
    bound_bps: bps, horizon_s: h,
    denominator: 'EVERY qualifying launch; no-exit scores zero and is counted',
    ACCEPTED: describe(vals(acc), exits(acc), acc.length),
    REFUSED: describe(vals(ref), exits(ref), ref.length),
    revert_rate_pct: ls.length === 0 ? null
      : Number(((ref.length / ls.length) * 100).toFixed(1)),
  });
}

function reportBands(ls: Launch[], bps: number, h: number): void {
  const ref = ls.filter((l) => !acceptedAt(l, bps));
  /* The bands are the RECORDED shortfall quantiles, not new numbers: section 6 gives
   * p25 3.90%, median 18.35%, p90 92.7% under the old quote. */
  const bands: Array<[string, (r: number) => boolean]> = [
    ['marginal        ratio < 1.04 (inside the p25)', (r) => r < 1.04],
    ['mid             1.04 <= ratio < 1.20', (r) => r >= 1.04 && r < 1.20],
    ['wide            1.20 <= ratio < 2.55', (r) => r >= 1.20 && r < 2.55],
    ['extreme         ratio >= 2.55 (past the p75)', (r) => r >= 2.55],
  ];
  const rows: Record<string, unknown> = {};
  for (const [name, pred] of bands) {
    const b = ref.filter((l) => pred(shortfallRatio(l, bps)));
    rows[name] = describe(b.map((l) => retAt(l, h, 0)),
      b.filter((l) => l.ret[h] !== null).length, b.length);
  }
  log.info('REFUSED TRADES BANDED BY HOW FAR THEY MISSED', {
    bound_bps: bps, horizon_s: h, refused_total: ref.length, bands: rows,
    note: 'ratio = our bound / what the pool would actually pay',
  });
}

function deriveBound(ls: Launch[], h: number, noExitPenalty: number): Record<string, unknown> {
  const rows = SWEEP_BOUNDS.map((b) => {
    const taken = ls.filter((l) => acceptedAt(l, b));
    const contribs = ls.map((l) => contribution(l, b, h, noExitPenalty));
    return {
      bps: b,
      median_all: med(contribs) ?? 0,
      taken: taken.length,
      revert_pct: ls.length === 0 ? 0 : (ls.length - taken.length) / ls.length * 100,
      median_taken: med(taken.map((l) => retAt(l, h, noExitPenalty))),
    };
  });
  let best = rows[0]!;
  for (const r of rows) if (r.median_all > best.median_all) best = r;
  const cur = rows.find((r) => r.bps === SLIPPAGE_BPS)!;
  /*
   * THE PLATEAU IS REPORTED, NOT JUST ITS LEFT EDGE. Where the objective is flat over a
   * wide range the argmax is an artefact of which end the loop happened to reach first,
   * and reporting a single "best" would present a tie as a finding.
   */
  const plateau = rows.filter((r) => Math.abs(r.median_all - best.median_all) < 1e-9);
  return {
    objective: `median return over EVERY qualifying launch; refused scores zero; `
      + `a TAKEN trade with no exit scores ${noExitPenalty}`,
    no_exit_penalty: noExitPenalty,
    horizon_s: h,
    plateau_bps: plateau.length > 1
      ? `${plateau[0]!.bps}..${plateau[plateau.length - 1]!.bps} all equal — the objective `
        + 'CANNOT distinguish inside this range'
      : 'none — the maximum is a single point',
    current: { bps: cur.bps, median_all: r5(cur.median_all),
      revert_pct: Number(cur.revert_pct.toFixed(1)), taken: cur.taken },
    best: { bps: best.bps, median_all: r5(best.median_all),
      revert_pct: Number(best.revert_pct.toFixed(1)), taken: best.taken },
    beats_current: best.median_all > cur.median_all,
    gain_over_current: r5(best.median_all - cur.median_all),
    named_bounds: NAMED_BOUNDS.map((b) => {
      const r = rows.find((x) => x.bps === b)!;
      return `${b}bps: median_all ${r5(r.median_all)}  revert ${r.revert_pct.toFixed(1)}%`
        + `  taken ${r.taken}  median_taken ${r5(r.median_taken)}`;
    }),
    curve: rows.filter((r) => r.bps % 100 === 0 || r.bps === SLIPPAGE_BPS)
      .map((r) => `${r.bps}: ${r5(r.median_all)} (revert ${r.revert_pct.toFixed(0)}%)`),
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const pi = args.indexOf('--phase');
  const phase = pi >= 0 ? String(args[pi + 1]) : 'both';
  const hi = args.indexOf('--half');
  const half = hi >= 0 ? String(args[hi + 1]) : 'all';
  if (!isHalf(half)) throw new Error(`--half must be search|holdout|all, got "${half}"`);
  if (!['bot', 'historical', 'both'].includes(phase)) {
    throw new Error(`--phase must be bot|historical|both, got "${phase}"`);
  }

  const app = await bootstrap();
  const c = await app.pool.connect();
  const key = process.env['ALCHEMY_API_KEY'];
  if (!key) throw new Error('ALCHEMY_API_KEY is not set');
  const rpc = new ReadOnlyRpc(new RpcClient(RPC_URL.replace('{key}', key), 60000, 400_000));

  try {
    let bot: Launch[] = [];
    if (phase === 'bot' || phase === 'both') {
      bot = await phaseBot(c, rpc);

      /*
       * THE ALGEBRA IS CHECKED AGAINST THE REAL `minOut` BEFORE ANYTHING IS CONCLUDED.
       * `acceptedAt` reproduces minOut's integer arithmetic; if the two ever disagree the
       * sweep is measuring a bound the bot does not apply.
       */
      let disagree = 0;
      for (const l of bot) {
        if (acceptedAt(l, SLIPPAGE_BPS) !== (realMinOut(l.quoted) <= l.actualOut)) {
          disagree += 1;
        }
      }
      log.info('SELF-CHECK: the sweep\'s accept test against the real rule.minOut()', {
        launches: bot.length, disagreements: disagree,
        note: 'must be 0 — otherwise the sweep is measuring a bound the bot does not apply',
      });
      if (disagree > 0) {
        throw new Error(`${disagree} launches disagree with rule.minOut(); refusing to `
          + 'report a bound derived from arithmetic that does not match the bot');
      }

      /* As-run reconciliation: does the re-quote reproduce what the runs did? */
      const asRun = bot.filter((l) => l.asRunReverted !== null);
      const agree = asRun.filter((l) =>
        l.asRunReverted === !acceptedAt(l, SLIPPAGE_BPS)).length;
      log.info('RE-QUOTED SPLIT AGAINST THE AS-RUN SPLIT', {
        launches: asRun.length,
        as_run_reverted: asRun.filter((l) => l.asRunReverted).length,
        requoted_refused: asRun.filter((l) => !acceptedAt(l, SLIPPAGE_BPS)).length,
        same_verdict: agree,
        differ: asRun.length - agree,
        note: 'runs 1-2 quoted linearly and runs 3-4 with the fee term, so a difference '
          + 'is expected; the re-quote is the bound we would ship and is primary here',
      });

      log.info('=== QUESTION 2: REFUSED AGAINST ACCEPTED, GROUND TRUTH ===', {});
      for (const h of [CONFIGURED_H]) reportSplit('AT THE CONFIGURED HORIZON', bot, SLIPPAGE_BPS, h);
      for (const h of HORIZONS_S) {
        const acc = bot.filter((l) => acceptedAt(l, SLIPPAGE_BPS));
        const ref = bot.filter((l) => !acceptedAt(l, SLIPPAGE_BPS));
        log.info(`horizon +${h}s`, {
          accepted_median: r5(med(acc.map((l) => retAt(l, h, 0)))),
          refused_median: r5(med(ref.map((l) => retAt(l, h, 0)))),
          accepted_exit_pct: Number(((acc.filter((l) => l.ret[h] !== null).length
            / Math.max(1, acc.length)) * 100).toFixed(1)),
          refused_exit_pct: Number(((ref.filter((l) => l.ret[h] !== null).length
            / Math.max(1, ref.length)) * 100).toFixed(1)),
        });
      }

      log.info('=== QUESTION 3: BANDED BY SHORTFALL ===', {});
      reportBands(bot, SLIPPAGE_BPS, CONFIGURED_H);

      /*
       * INDIVIDUAL RECORDS, BECAUSE A BOUND IS A DEFINITION.
       *
       * CLAUDE.md: any proposed change to what a term means must first be proven on
       * individual records, with identifiers the operator can open, counter-examples
       * included. "The refused trades are winners" is a population claim that would
       * justify the largest single change available to this bot, so the aggregate is a
       * hypothesis until these lines can be re-derived by hand.
       *
       * Every field needed to reproduce the arithmetic is printed: the pool, the block,
       * what we quoted, what the router said it would actually pay, and the two prices
       * the return is a ratio of. Counter-examples -- refused trades that LOST -- are
       * printed separately and are not omitted for being inconvenient.
       */
      const refused = bot.filter((l) => !acceptedAt(l, SLIPPAGE_BPS));
      const withExit = refused.filter((l) => l.ret[CONFIGURED_H] !== null);
      const sorted = [...withExit].sort((a, b) =>
        retAt(b, CONFIGURED_H, 0) - retAt(a, CONFIGURED_H, 0));
      const lines = (xs: Launch[]): string[] => xs.map((l) => {
        const pxExit = l.pxFill * (1 + retAt(l, CONFIGURED_H, 0));
        return `trade ${l.key} [${l.label}] pool ${l.poolId.slice(0, 18)}… fee ${l.fee}`
          + ` | quoted ${l.quoted} vs pool would pay ${l.actualOut}`
          + ` (shortfall x${shortfallRatio(l, SLIPPAGE_BPS).toFixed(4)})`
          + ` | px_fill ${l.pxFill.toExponential(6)} -> px_+90s ${pxExit.toExponential(6)}`
          + ` = ${(retAt(l, CONFIGURED_H, 0) * 100).toFixed(1)}%`;
      });
      log.info('INDIVIDUAL REFUSED LAUNCHES — the claim, re-derivable by hand', {
        refused_total: refused.length,
        refused_with_an_exit: withExit.length,
        refused_with_NO_exit: refused.length - withExit.length,
        best_five: lines(sorted.slice(0, 5)),
        worst_five_COUNTER_EXAMPLES: lines(sorted.slice(-5).reverse()),
        losers: lines(withExit.filter((l) => retAt(l, CONFIGURED_H, 0) < 0)),
        note: 'return = px at the first trade after +90s divided by the price our own '
          + 'fill would have got, which is amountIn / what the router said it would pay',
      });

      log.info('=== QUESTION 4: THE DERIVED BOUND, GROUND TRUTH, no-exit = 0 ===',
        deriveBound(bot, CONFIGURED_H, 0));
      log.info('=== QUESTION 4b: THE SAME DERIVATION, no-exit = -1 (a total loss) ===',
        deriveBound(bot, CONFIGURED_H, -1));
      log.info('REFUSED vs ACCEPTED UNDER THE -1 CONVENTION', {});
      reportSplit('AT THE CONFIGURED HORIZON, no-exit = -1', bot, SLIPPAGE_BPS,
        CONFIGURED_H, -1);

      /*
       * THE RETRY LADDER, RE-DERIVED AT WHATEVER BOUND IS CONFIGURED.
       *
       * The rungs are the quantiles of the shortfall over the launches the FIRST rung
       * still misses. That set is a function of the first rung, so a ladder calibrated
       * against 300 bps describes a different problem the moment the bound moves — it
       * would be answering "what clears the trades 300 bps missed" while the bot misses
       * a different, smaller set.
       *
       * The critical bound per launch comes from the oracle: `b* = 1 - actual/quoted`,
       * the exact bound at which that launch stops being refused. Reported in bps.
       */
      const critBps = (l: Launch): number =>
        Math.ceil(10000 * (1 - Number(l.actualOut) / Number(l.quoted)));
      const ladderFor = (rung1: number): Record<string, unknown> => {
        const missed = bot.filter((l) => !acceptedAt(l, rung1));
        const cb = missed.map(critBps);
        const q = (x: number): number | null => {
          const v = quantile(cb, x);
          return v === null ? null : Math.round(v);
        };
        return {
          rung_1_configured_bound: rung1,
          launches_still_missed: missed.length,
          share_of_all: bot.length === 0 ? null
            : Number(((missed.length / bot.length) * 100).toFixed(1)),
          shortfall_bps_quantiles: { p25: q(0.25), median: q(0.5), p75: q(0.75),
            p90: q(0.9), max: cb.length ? Math.max(...cb) : null },
          proposed_rungs: [rung1, q(0.25), q(0.5), q(0.75)],
          stops_at_the_p75_because: 'a rung past it accepts a haircut larger than the '
            + 'position\'s whole expected gain — the rule the 300 bps ladder already used',
          of_the_missed_how_many_have_an_exit: missed.filter(
            (l) => l.ret[CONFIGURED_H] !== null).length,
          /*
           * THE INDIVIDUAL LAUNCHES, because a rung decides money and an interpolated
           * quantile over n=7 is not something to calibrate against. At a wide bound the
           * quantiles collapse onto duplicates and a duplicate rung is "one attempt
           * logged twice", which `exitWithRetry`'s own contract forbids.
           */
          each_missed_launch: [...missed]
            .sort((a, b) => critBps(a) - critBps(b))
            .map((l) => `needs ${critBps(l)}bps  ${l.ret[CONFIGURED_H] === null
              ? 'NO EXIT AT ALL — a dead pool, no rung can rescue it'
              : `exit found, return ${(retAt(l, CONFIGURED_H, 0) * 100).toFixed(1)}%`}`
              + `  [${l.label} trade ${l.key}]`),
        };
      };
      log.info('=== THE RETRY LADDER, RE-DERIVED — at the CURRENT bound ===',
        ladderFor(SLIPPAGE_BPS));
      for (const b of [500, 1000, 1600]) {
        log.info(`=== THE RETRY LADDER if the bound were ${b} bps ===`, ladderFor(b));
      }

      /* QUESTION 5: the drift, per run. */
      const byMode = new Map<string, Launch[]>();
      for (const l of bot) {
        byMode.set(l.label, [...(byMode.get(l.label) ?? []), l]);
      }
      const drift: Record<string, unknown> = {};
      for (const [mode, ls] of [...byMode.entries()].sort()) {
        const ratios = ls.map((l) => Number(l.quoted) / Number(l.actualOut));
        const pads: Record<string, number> = {};
        for (const l of ls) {
          const k = l.launchpad ? l.launchpad.slice(0, 10) : 'unknown';
          pads[k] = (pads[k] ?? 0) + 1;
        }
        const fees: Record<string, number> = {};
        for (const l of ls) fees[String(l.fee)] = (fees[String(l.fee)] ?? 0) + 1;
        drift[mode] = {
          n: ls.length,
          refused_requoted: ls.filter((l) => !acceptedAt(l, SLIPPAGE_BPS)).length,
          revert_pct: Number(((ls.filter((l) => !acceptedAt(l, SLIPPAGE_BPS)).length
            / ls.length) * 100).toFixed(1)),
          overquote_median: r5(med(ratios)),
          overquote_p75: r5(quantile(ratios, 0.75)),
          overquote_p90: r5(quantile(ratios, 0.9)),
          depth_notional_median: r5(med(ls.map((l) => l.depthNotional))),
          size_over_depth_median: r5(med(ls.map((l) =>
            l.depthNotional > 0 ? Number(l.amountIn) / l.depthNotional : 0))),
          launchpads: pads, fees,
        };
      }
      log.info('=== QUESTION 5: THE DRIFT, PER RUN ===', {
        note: 'over-quote = quoted / what the pool would actually pay, from the oracle. '
          + 'If the revert rate rose because the over-quote grew, this median rises with it.',
        per_mode: drift,
      });
    }

    if (phase === 'historical' || phase === 'both') {
      const hist = await phaseHistorical(c, half);

      /* QUESTION 6, and the VALIDATION that has to come first. */
      if (bot.length > 0) {
        const botByPool = new Map(bot.map((l) => [l.poolId, l]));
        const pairs: Array<{ truth: number; model: number }> = [];
        for (const l of hist) {
          const b = botByPool.get(l.poolId);
          if (!b) continue;
          pairs.push({
            truth: 1 - Number(b.actualOut) / Number(b.quoted),
            model: 1 - Number(l.actualOut) / Number(l.quoted),
          });
        }
        log.info('VALIDATION: the model against the oracle, where both exist', {
          overlapping_pools: pairs.length,
          note: pairs.length === 0
            ? 'NO OVERLAP — the bot traded at head and the windows stop 25 days earlier, '
              + 'so the model cannot be scored on the same pools. Stated rather than '
              + 'quietly skipped; the model is validated only by its construction.'
            : 'median absolute difference in the critical bound',
          median_abs_diff: pairs.length
            ? r5(med(pairs.map((p) => Math.abs(p.truth - p.model)))) : null,
        });
      }

      log.info('=== QUESTION 6: THE HISTORICAL WINDOWS, MODELLED ===', {
        launches: hist.length,
        caveat: 'actualOut here is MODELLED as the price a real trade got at our entry '
          + 'mark, missing only our own marginal impact (measured at a 0.17% median). It '
          + 'is not the oracle and is not presented as one.',
      });
      for (const [label] of WINDOWS) {
        const ls = hist.filter((l) => l.label === label);
        if (ls.length === 0) { log.warn(`${label}: RETURNED NO ROWS`, {}); continue; }
        for (const b of NAMED_BOUNDS) reportSplit(`${label} @ ${b}bps`, ls, b, CONFIGURED_H);
        log.info(`${label}: THE DERIVED BOUND, no-exit = 0`, deriveBound(ls, CONFIGURED_H, 0));
        log.info(`${label}: THE DERIVED BOUND, no-exit = -1`, deriveBound(ls, CONFIGURED_H, -1));
      }
      log.info('POOLED, ALL FOUR WINDOWS — and 94.5% of it is the corpus anomaly',
        deriveBound(hist, CONFIGURED_H, 0));
      const recent = hist.filter((l) => l.label !== 'HOLDOUT-ERA');
      log.info('THE THREE POST-CORPUS WINDOWS, no-exit = 0',
        deriveBound(recent, CONFIGURED_H, 0));
      log.info('THE THREE POST-CORPUS WINDOWS, no-exit = -1',
        deriveBound(recent, CONFIGURED_H, -1));
      for (const b of NAMED_BOUNDS) reportSplit(`POST-CORPUS @ ${b}bps`, recent, b, CONFIGURED_H);
      reportBands(recent, SLIPPAGE_BPS, CONFIGURED_H);
    }
  } finally { c.release(); }

  log.info('revert-economics complete', { cu_spent: rpc.cuSpent });
  await app.pool.end();
  process.exit(0);
}

main().catch((e) => { log.error('revert-economics failed', errorFields(e)); process.exit(1); });

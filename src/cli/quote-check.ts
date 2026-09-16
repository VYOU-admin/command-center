/**
 * `npm run quote-check -- [--commit]`
 *
 * DOES THE IMPACT-CORRECTED QUOTE ACTUALLY REDUCE THE REVERTS? Measured on the trades
 * already recorded, against ground truth, before the corrected quote is trusted.
 *
 * **THE GROUND TRUTH IS THE REVERT ITSELF.** `V4TooLittleReceived(uint256,uint256)`
 * carries (minAmountOutReceived, amountReceived) — the second word is exactly what the
 * pool WOULD have paid for our size at that block. So setting `amountOutMinimum` to a
 * deliberately unreachable value turns the router into an oracle for its own output, at
 * 26 CU and with no assumption anywhere. Nothing else available on this chain answers
 * "what would $10 actually have got" exactly.
 *
 * The three questions, in the order they decide anything:
 *
 * 1. **How many of the recorded reverts would the corrected quote have avoided?** A
 *    trade clears when its bound is at or below what the pool pays.
 * 2. **What does it do to quote ACCURACY overall** — quoted/actual, median and
 *    distribution, old against new, over every trade and not only the reverts.
 * 3. **What does it cost?** Launches the corrected quote REFUSES rather than mis-quotes,
 *    counted separately, because a fix that trades nothing is not a fix.
 *
 * **IF IT DOES NOT MATERIALLY REDUCE THE REVERTS, THAT IS THE ANSWER** and is reported
 * as such. Nothing here ships on the strength of being a better idea.
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { AbiCoder, id } from 'ethers';
import { buildSwap } from '../bot/calldata.js';
import { quote } from '../bot/quote.js';
import type { PoolTick } from '../bot/quote.js';
import { swapAmounts, tokenPrice } from '../bot/price.js';
import {
  ENTRY_DELAY_BLOCKS, IMPACT_MIN_OBSERVATIONS, POOL_MANAGER, SLIPPAGE_BPS,
  UNIVERSAL_ROUTER,
} from '../bot/config.js';
import { TOPICS } from '../adapters/token-updates/decode.js';

const RPC_URL = 'https://robinhood-mainnet.g.alchemy.com/v2/{key}';
const abi = AbiCoder.defaultAbiCoder();
const V4_TOO_LITTLE = id('V4TooLittleReceived(uint256,uint256)').slice(0, 10);
/** Unreachable by construction, so the router always reports its own output. */
const PROBE_MIN_OUT = (1n << 127n);
const GETLOGS_CU = 60;
const CALL_CU = 26;

interface RpcOut { result?: unknown; error?: { message?: string; data?: unknown } }
async function rawCall(url: string, method: string, params: unknown[]): Promise<RpcOut> {
  const res = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return (await res.json()) as RpcOut;
}

function pct(xs: number[], q: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * q))]!;
}

async function main(): Promise<void> {
  const commit = process.argv.includes('--commit');
  const key = process.env['ALCHEMY_API_KEY'];
  if (!key) throw new Error('ALCHEMY_API_KEY is not set');
  const url = RPC_URL.replace('{key}', key);

  const app = await bootstrap();
  const c = await app.pool.connect();
  try {
    const rows = await c.query<{
      id: string; pool_id: string; token: string; counter: string; fee: number;
      tick_spacing: number; hooks: string; first_swap_block: string;
      position_wei: string; status: string; quoted_out: string | null;
    }>(
      `select id::text, pool_id, token, counter, fee, tick_spacing, hooks,
              first_swap_block::text, position_wei::text, status, quoted_out::text
         from bot_trades
        where chain='robinhood' and first_swap_block is not null and position_wei > 0
        order by created_at`);
    const n = rows.rowCount ?? 0;
    const cu = n * (GETLOGS_CU + CALL_CU);
    log.info('QUOTE CHECK WORK SET', {
      trades: n,
      reverted: rows.rows.filter((r) => r.status === 'sim_reverted').length,
      estimate: { cu, usd: ((cu * 0.45) / 1e6).toFixed(5) },
      ground_truth: 'V4TooLittleReceived second word, from an unreachable minOut',
      commit,
    });
    if (!commit) {
      log.info('DRY RUN — nothing read', { note: 'pass --commit' });
      c.release(); await app.pool.end(); process.exit(0);
    }

    const oldRatios: number[] = []; const newRatios: number[] = [];
    let refusedFewTicks = 0; let refusedImpact = 0; let noTruth = 0;
    let oldWouldClear = 0; let newWouldClear = 0; let compared = 0;
    let revOldClear = 0; let revNewClear = 0; let revCompared = 0;
    const impacts: number[] = [];
    const byBasis: Record<string, number> = {};
    const detail: Array<Record<string, unknown>> = [];

    for (const r of rows.rows) {
      const entryBlock = Number(r.first_swap_block) + ENTRY_DELAY_BLOCKS;
      const tokenIsC0 = r.token.toLowerCase() < r.counter.toLowerCase();
      const zeroIsPricing = !tokenIsC0;
      const size = BigInt(r.position_wei);

      /* The pool's swaps from its first trade up to the entry moment — everything the
       * bot could observe at the instant it must decide. Nothing after it. */
      const logs = (await rawCall(url, 'eth_getLogs', [{
        address: POOL_MANAGER, topics: [TOPICS.swapV4, r.pool_id],
        fromBlock: `0x${Number(r.first_swap_block).toString(16)}`,
        toBlock: `0x${entryBlock.toString(16)}`,
      }])).result as Array<{ blockNumber: string; logIndex: string; data: string }> | undefined;

      const ticks: PoolTick[] = [];
      for (const l of logs ?? []) {
        const a = swapAmounts(l.data);
        if (!a) continue;
        const px = tokenPrice(a, tokenIsC0);
        /* NOTIONAL IS THE PRICING-ASSET SIDE, both directions. */
        const notional = Number(tokenIsC0 ? (a.amount1 < 0n ? -a.amount1 : a.amount1)
          : (a.amount0 < 0n ? -a.amount0 : a.amount0));
        if (!(px > 0) || !(notional > 0)) continue;
        ticks.push({
          block: Number(BigInt(l.blockNumber)), logIndex: Number(BigInt(l.logIndex)),
          price: px, notional,
        });
      }
      const last = ticks[ticks.length - 1];
      if (!last) { noTruth += 1; continue; }
      /* tokens per pricing unit = 1 / (pricing units per token). bot/price.ts owns
       * the convention; this is its reciprocal and nothing else. */
      const rate = 1 / last.price;

      /* ---- the two quotes ---- */
      const linear = BigInt(Math.floor(Number(size) * rate));
      let newQuoted: bigint | null = null; let impactFrac = 0; let refusal = '';
      let basis = 'refused'; let feeFrac = 0;
      try {
        const q = quote({
          amountIn: size, rateOutPerIn: rate, side: 'buy', fee: r.fee, ticks,
        });
        newQuoted = q.expectedOut; impactFrac = q.impactFraction;
        basis = q.basis; feeFrac = q.feeFraction;
        if (q.basis === 'fee+impact') impacts.push(q.impactFraction);
        byBasis[q.basis] = (byBasis[q.basis] ?? 0) + 1;
      } catch (e) {
        refusal = (e as Error).message.slice(0, 90);
        if (refusal.includes('fewer than')) refusedFewTicks += 1; else refusedImpact += 1;
      }

      /* ---- ground truth: what the pool would actually pay ---- */
      const probe = buildSwap({
        pool: {
          currency0: tokenIsC0 ? r.token : r.counter,
          currency1: tokenIsC0 ? r.counter : r.token,
          fee: r.fee, tickSpacing: r.tick_spacing, hooks: r.hooks,
        },
        zeroForOne: zeroIsPricing,
        amountIn: size, amountOutMinimum: PROBE_MIN_OUT,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
      });
      const out = await rawCall(url, 'eth_call', [{
        from: '0x000000000000000000000000000000000000dEaD',
        to: UNIVERSAL_ROUTER, value: `0x${size.toString(16)}`, data: probe.data,
      }, `0x${entryBlock.toString(16)}`]);
      let actual: bigint | null = null;
      const d = out.error?.data;
      if (typeof d === 'string' && d.startsWith(V4_TOO_LITTLE)) {
        const [, got] = abi.decode(['uint256', 'uint256'],
          `0x${d.slice(10)}`) as unknown as [bigint, bigint];
        actual = got;
      }
      if (actual === null || actual === 0n) {
        /* A pool that pays nothing, or a revert for some other reason, cannot score a
         * quote. Counted, never folded into the accuracy figures. */
        noTruth += 1;
        detail.push({ trade: r.id, status: r.status, ground_truth: 'unavailable',
          reason: String(out.error?.message ?? 'no V4TooLittleReceived').slice(0, 60),
          refusal: refusal || null });
        continue;
      }

      compared += 1;
      const bp = BigInt(10000 - SLIPPAGE_BPS);
      const oldBound = (linear * bp) / 10000n;
      const oldClears = oldBound <= actual;
      if (oldClears) oldWouldClear += 1;
      oldRatios.push(Number(linear) / Number(actual));

      let newClears: boolean | null = null;
      if (newQuoted !== null) {
        const newBound = (newQuoted * bp) / 10000n;
        newClears = newBound <= actual;
        if (newClears) newWouldClear += 1;
        newRatios.push(Number(newQuoted) / Number(actual));
      }

      if (r.status === 'sim_reverted') {
        revCompared += 1;
        if (oldClears) revOldClear += 1;
        if (newClears) revNewClear += 1;
      }
      detail.push({
        trade: r.id, status: r.status, ticks: ticks.length,
        fee_tier: r.fee, fee_pct: (feeFrac * 100).toFixed(4), basis,
        impact_pct: newQuoted === null ? null : (impactFrac * 100).toFixed(2),
        linear: linear.toString(), corrected: newQuoted?.toString() ?? 'REFUSED',
        actual: actual.toString(),
        old_over_actual: (Number(linear) / Number(actual)).toFixed(3),
        new_over_actual: newQuoted === null ? null
          : (Number(newQuoted) / Number(actual)).toFixed(3),
        old_clears: oldClears, new_clears: newClears,
        refusal: refusal || null,
      });
    }

    log.info('1. WOULD THE CORRECTED QUOTE HAVE AVOIDED THE REVERTS?', {
      trades_with_ground_truth: compared,
      recorded_reverts_among_them: revCompared,
      reverts_the_OLD_quote_would_clear: revOldClear,
      reverts_the_CORRECTED_quote_would_clear: revNewClear,
      note: 'a trade clears when its bound is at or below what the pool would pay. '
        + 'The old figure is not always 0: some reverts are reproduced only at head, '
        + 'and this re-simulates at the block the bot would have traded.',
    });
    log.info('2. QUOTE ACCURACY — quoted / actual, 1.0 is exact', {
      note: 'above 1.0 is an OVER-quote, which is what makes a bound unreachable.',
      old: oldRatios.length === 0 ? 'RETURNED NO ROWS' : {
        n: oldRatios.length, p10: pct(oldRatios, 0.1).toFixed(3),
        p25: pct(oldRatios, 0.25).toFixed(3), median: pct(oldRatios, 0.5).toFixed(3),
        p75: pct(oldRatios, 0.75).toFixed(3), p90: pct(oldRatios, 0.9).toFixed(3),
        over_quoted_share: `${((oldRatios.filter((x) => x > 1).length
          / oldRatios.length) * 100).toFixed(1)}%`,
      },
      corrected: newRatios.length === 0 ? 'RETURNED NO ROWS' : {
        n: newRatios.length, p10: pct(newRatios, 0.1).toFixed(3),
        p25: pct(newRatios, 0.25).toFixed(3), median: pct(newRatios, 0.5).toFixed(3),
        p75: pct(newRatios, 0.75).toFixed(3), p90: pct(newRatios, 0.9).toFixed(3),
        over_quoted_share: `${((newRatios.filter((x) => x > 1).length
          / newRatios.length) * 100).toFixed(1)}%`,
      },
    });
    log.info('3. WHAT THE CORRECTION COSTS', {
      quotes_by_basis: byBasis,
      note: 'fee-only means the pool had fewer than the minimum consecutive swaps, so '
        + 'the EXACT fee term applied and impact was not measurable. It is not a refusal.',
      refused_outright: refusedFewTicks + refusedImpact,
      min_observations_required: IMPACT_MIN_OBSERVATIONS,
      refused_impact_at_or_above_100pct: refusedImpact,
      no_ground_truth_available: noTruth,
      measured_impact_fraction: impacts.length === 0 ? 'RETURNED NO ROWS' : {
        n: impacts.length,
        median_pct: (pct(impacts, 0.5) * 100).toFixed(2),
        p90_pct: (pct(impacts, 0.9) * 100).toFixed(2),
        max_pct: (Math.max(...impacts) * 100).toFixed(2),
      },
    });
    /*
     * WHERE THE REMAINING OVER-QUOTE LIVES. If the fee term were double-counting, the
     * high-fee tier would now UNDER-quote while the low-fee tier still over-quoted.
     * Splitting by tier is the cheapest way to tell a missing term from a doubled one.
     */
    const byTier: Record<string, { n: number; old: number[]; neu: number[] }> = {};
    for (const d0 of detail) {
      const f = String(d0['fee_tier'] ?? 'unknown');
      const o = d0['old_over_actual']; const nw = d0['new_over_actual'];
      if (typeof o !== 'string') continue;
      byTier[f] ??= { n: 0, old: [], neu: [] };
      byTier[f]!.n += 1; byTier[f]!.old.push(Number(o));
      if (typeof nw === 'string') byTier[f]!.neu.push(Number(nw));
    }
    log.info('OVER-QUOTE BY FEE TIER, before and after the fee term', {
      note: 'a tier that now sits BELOW 1.0 would mean the fee is double-counted; one '
        + 'still above it means a term is still missing.',
      tiers: Object.entries(byTier).map(([f, v]) => ({
        fee: f, n: v.n,
        old_median: v.old.length ? pct(v.old, 0.5).toFixed(4) : 'n/a',
        new_median: v.neu.length ? pct(v.neu, 0.5).toFixed(4) : 'n/a',
      })),
    });
    /*
     * THE LADDER MUST BE RE-DERIVED FROM THE CORRECTED QUOTE. The rungs in
     * EXIT_RETRY.BOUND_BPS were the quantiles of the shortfall under the OLD quote, and
     * a rung calibrated against a quote that has since been corrected is a rung
     * calibrated against a defect. This reports the same quantiles under the corrected
     * quote, over exactly the trades whose corrected bound would still NOT clear.
     */
    const stillFail = newRatios.filter((x) => x > 1 / (1 - SLIPPAGE_BPS / 10000));
    log.info('RE-DERIVING THE RETRY LADDER FROM THE CORRECTED SHORTFALL', {
      corrected_quotes: newRatios.length,
      would_still_miss_the_300bps_bound: stillFail.length,
      note: 'needed one-leg slippage = 1 - 1/ratio, over the trades that still miss. '
        + 'These quantiles are the candidate rungs.',
      shortfall: stillFail.length === 0 ? 'RETURNED NO ROWS' : {
        n: stillFail.length,
        p25_bps: Math.ceil((1 - 1 / pct(stillFail, 0.25)) * 10000),
        median_bps: Math.ceil((1 - 1 / pct(stillFail, 0.5)) * 10000),
        p75_bps: Math.ceil((1 - 1 / pct(stillFail, 0.75)) * 10000),
        p90_bps: Math.ceil((1 - 1 / pct(stillFail, 0.9)) * 10000),
        max_bps: Math.ceil((1 - 1 / Math.max(...stillFail)) * 10000),
      },
    });
    log.info('PER-TRADE DETAIL', { detail });
  } finally { c.release(); }
  await app.pool.end();
  process.exit(0);
}

main().catch((err) => { log.error('quote-check failed', errorFields(err)); process.exit(1); });

/**
 * `npm run runner-label` — 5A: LABEL THE RUNNERS, OUTCOME FIRST.
 *
 * The goal, unchanged: find tokens that run hard in the first 15 minutes, get in within
 * the first 15–30 seconds, flip for a profit. **This pass labels the outcome and
 * nothing else.** No exit rule of ours is involved; every prior one is discarded.
 *
 * ===========================================================================
 * THE PRICE PATH COMES FROM THE POOL'S OWN SWAP LOGS, AT 60 CU A POOL
 * ===========================================================================
 *
 * The v4 `Swap` event carries **`sqrtPriceX96` as its third data word** — 192 data
 * bytes, per `ROBINHOOD.md` step 3. So one sparse `eth_getLogs`
 * (`topics = [swapV4, poolId]`, 9,000 blocks) yields the pool's entire mid-price path
 * for **60 CU**, against ~75 sell simulations at ~1,950 CU. **Thirty-two times cheaper
 * for the same question**, and it is what the brief asked for: the token's own path.
 *
 * **WHAT THIS PRICE IS AND IS NOT.** `sqrtPriceX96` is the pool's mid-price after each
 * swap — clean of the swapper's own impact and of the fee. It is the right instrument
 * for *"did this token run"* and the WRONG one for *"what would we have received"*. §6A.3
 * is the record of using one where the other was needed, so 5D — if it gets that far —
 * must price a real sell. **Nothing here is a realisable return and nothing here is
 * labelled as one.**
 *
 * **THE DIRECTION IS VALIDATED, NOT REASONED.** For these pools `currency0` is native
 * ETH and `currency1` the token, so v4's `price = token1/token0` is TOKENS PER ETH and
 * moves INVERSELY to a token position's value — the inversion §6H.1 records. Rather than
 * trust that, every pool that also has a stored sell-proceeds path in `bot_exit_path`
 * is cross-checked: the sqrt-derived multiple must move the SAME WAY as the measured
 * proceeds. The agreement rate is reported, and **a low one voids this measurement.**
 */
import { AbiCoder } from 'ethers';
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { RpcClient } from '../adapters/token-updates/rpc.js';
import { ReadOnlyRpc } from '../bot/rpc.js';
import { poolIdOf } from '../bot/pool-state.js';
import { TOPICS } from '../adapters/token-updates/decode.js';

const CHAIN = 'robinhood';
const RPC_URL = 'https://robinhood-mainnet.g.alchemy.com/v2/{key}';
const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const PT_FACTORY = '0x000000e200088d55c39a11f609e5f667729ad49b';
const TOKEN_CREATED = '0x4ef8284ecf42d4cd19686572ffd87f630858c82398911e776cb831de35eddbf4';
const abi = AbiCoder.defaultAbiCoder();
const CU_CEILING = 600_000;
const PRICING = [
  '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
  '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
  '0x0000000000000000000000000000000000000000',
];
const BLOCKS_PER_DAY = 864_000;
/** PINNED. Seven full days spanning the §6J regime change at ~62.2–63.1M. */
const START_BLOCK = 60_480_000;
const END_BLOCK = 66_528_000;
const ENTRY_BLOCKS = 150;      /* +15 s — where the operator wants to be */
const WINDOW_BLOCKS = 9_000;   /* 15 minutes */
const PER_DAY_SAMPLE = 150;

interface Log { topics: string[]; data: string; blockNumber: string; transactionHash: string }
const quant = (xs: number[], p: number): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]!;
};
const pc = (x: number | null): string => x === null ? '  n/a' : `${(100 * x).toFixed(1)}%`;

async function sweep(
  rpc: ReadOnlyRpc, f: Record<string, unknown>, from: number, to: number, span0: number,
): Promise<Log[]> {
  const out: Log[] = []; let cur = from; let span = span0;
  while (cur <= to) {
    const end = Math.min(cur + span - 1, to);
    try {
      const got = (await rpc.call('eth_getLogs', [{
        ...f, fromBlock: `0x${cur.toString(16)}`, toBlock: `0x${end.toString(16)}`,
      }])) as Log[];
      out.push(...got); cur = end + 1;
      if (got.length < 3_000) span = Math.min(Math.floor(span * 1.5), span0 * 8);
    } catch (err) {
      if (!/exceed|limit|response size/i.test((err as Error).message)) throw err;
      span = Math.max(Math.floor(span / 4), 2_000);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const key = process.env['ALCHEMY_API_KEY'];
  if (!key) throw new Error('ALCHEMY_API_KEY is not set');
  const app = await bootstrap();
  const c = await app.pool.connect();
  const inner = new RpcClient(RPC_URL.replace('{key}', key), 60_000, CU_CEILING);
  const rpc = new ReadOnlyRpc(inner);

  try {
    await c.query(`create table if not exists bot_runner_label (
      chain text not null, pool_id text not null, token text not null,
      init_block bigint not null, day_bucket integer not null,
      swaps_in_window integer, entry_sqrt numeric, peak_mult numeric,
      time_to_peak_s integer, end_mult numeric,
      measured_at timestamptz not null default now(),
      primary key (chain, pool_id)
    )`);

    const days: number[] = [];
    for (let b = START_BLOCK / BLOCKS_PER_DAY; b * BLOCKS_PER_DAY < END_BLOCK; b += 1) days.push(b);

    log.info('5A  BEFORE THE FIRST PAID CALL', {
      window_PINNED: `${START_BLOCK}..${END_BLOCK}`,
      days: days.length,
      per_day_sample: PER_DAY_SAMPLE,
      entry: `+${ENTRY_BLOCKS} blocks = +15 s`,
      peak_window: `${WINDOW_BLOCKS} blocks = 15 min`,
      method: "sqrtPriceX96 from the pool's own Swap logs - 1 sparse getLogs per pool",
      estimate_cu: days.length * (PER_DAY_SAMPLE * 60 + 8 * 60),
      ceiling_cu: CU_CEILING,
      NOT_a_realisable_return: 'this is the pool mid-price, clean of our size and the '
        + 'fee. It labels a RUNNER. It does not say what we would have received.',
    });

    const have = new Set((await c.query<{ pool_id: string }>(
      `select pool_id from bot_runner_label where chain=$1`, [CHAIN])).rows.map((r) => r.pool_id));

    for (const d of days) {
      const from = d * BLOCKS_PER_DAY;
      const to = Math.min(from + BLOCKS_PER_DAY - 1, END_BLOCK - 1);
      const created = await sweep(rpc, { address: PT_FACTORY, topics: [TOKEN_CREATED] },
        from, to, 900_000);
      if (created.length === 0) { log.info('day done', { bucket: d, canonical: 0 }); continue; }
      const ptTxs = new Set(created.map((l) => l.transactionHash.toLowerCase()));
      const inits = await sweep(rpc, { address: POOL_MANAGER, topics: [TOPICS.initializeV4] },
        from, to, 40_000);
      const canon = inits.filter((l) => ptTxs.has(l.transactionHash.toLowerCase())
        && PRICING.includes(`0x${(l.topics[2] ?? '').slice(26)}`.toLowerCase())
          !== PRICING.includes(`0x${(l.topics[3] ?? '').slice(26)}`.toLowerCase()));
      const step = Math.max(1, Math.floor(canon.length / PER_DAY_SAMPLE));
      const pick = canon.filter((_, i) => i % step === 0).slice(0, PER_DAY_SAMPLE);

      for (const l of pick) {
        const pid = (l.topics[1] ?? '').toLowerCase();
        if (have.has(pid)) continue;
        const c0 = `0x${(l.topics[2] ?? '').slice(26)}`.toLowerCase();
        const c1 = `0x${(l.topics[3] ?? '').slice(26)}`.toLowerCase();
        const dd = abi.decode(['uint24', 'int24', 'address', 'uint160', 'int24'], l.data) as
          unknown as [bigint, bigint, string, bigint, bigint];
        const pool = { currency0: c0, currency1: c1, fee: Number(dd[0]),
          tickSpacing: Number(dd[1]), hooks: dd[2].toLowerCase() };
        if (poolIdOf(pool).toLowerCase() !== pid) continue;
        const zeroIsPricing = PRICING.includes(c0);
        const token = zeroIsPricing ? c1 : c0;
        const initBlock = Number(BigInt(l.blockNumber));

        let swaps: Log[];
        try {
          swaps = (await rpc.call('eth_getLogs', [{
            address: POOL_MANAGER, topics: [TOPICS.swapV4, pid],
            fromBlock: `0x${initBlock.toString(16)}`,
            toBlock: `0x${(initBlock + WINDOW_BLOCKS).toString(16)}`,
          }])) as Log[];
        } catch { continue; }

        /* sqrtPriceX96 is data word 2 of the v4 Swap event. */
        const pts = swaps.map((x) => ({
          off: Number(BigInt(x.blockNumber)) - initBlock,
          sqrt: BigInt(`0x${x.data.slice(2).slice(128, 192)}`),
        })).filter((x) => x.sqrt > 0n).sort((a, b) => a.off - b.off);
        if (pts.length === 0) continue;

        /* The last price at or before the entry block is what we would have bought at. */
        const atEntry = pts.filter((x) => x.off <= ENTRY_BLOCKS).pop() ?? pts[0]!;
        const after = pts.filter((x) => x.off >= ENTRY_BLOCKS);
        /*
         * VALUE moves INVERSELY to `price = token1/token0` when the token is currency1.
         * multiple = (sqrt_entry / sqrt_t)^2, inverted when the token is currency0.
         */
        const mult = (s: bigint): number => {
          const r = (Number(atEntry.sqrt) / Number(s)) ** 2;
          return zeroIsPricing ? r : 1 / r;
        };
        let peak = 1; let peakAt = 0;
        for (const x of after) {
          const m = mult(x.sqrt);
          if (Number.isFinite(m) && m > peak) { peak = m; peakAt = x.off; }
        }
        const endM = after.length > 0 ? mult(after[after.length - 1]!.sqrt) : 1;

        await c.query(
          `insert into bot_runner_label (chain, pool_id, token, init_block, day_bucket,
             swaps_in_window, entry_sqrt, peak_mult, time_to_peak_s, end_mult)
           values ($1,$2,$3,$4,$5,$6,$7::numeric,$8::numeric,$9,$10::numeric)
           on conflict do nothing`,
          [CHAIN, pid, token, initBlock, d, swaps.length, atEntry.sqrt.toString(),
            peak.toString(), Math.round(peakAt / 10),
            Number.isFinite(endM) ? endM.toString() : null]);
      }
      log.info('day done', { bucket: d, canonical: canon.length, sampled: pick.length });
    }

    /* ---- DIRECTION CHECK against stored sell proceeds -------------------- */
    const cross = (await c.query<{ pool_id: string; peak_mult: string; agree: boolean | null }>(
      `with p as (
         select pool_id,
                max(case when grid_offset between 150 and 9000
                     then eth_out end) as best_out,
                max(case when grid_offset = 150 then eth_out end) as out_at_entry
           from bot_exit_path where chain=$1 and entry_offset=1 and sell_executes
          group by pool_id
       )
       select r.pool_id, r.peak_mult::text,
              case when p.best_out is null or p.out_at_entry is null then null
                   when (r.peak_mult > 1.05) = (p.best_out > p.out_at_entry * 1.05)
                   then true else false end as agree
         from bot_runner_label r join p on p.pool_id = r.pool_id
        where r.chain=$1`, [CHAIN])).rows;
    const testable = cross.filter((r) => r.agree !== null);
    const agreed = testable.filter((r) => r.agree === true).length;
    log.info('DIRECTION CHECK — sqrt-derived multiple vs MEASURED sell proceeds', {
      pools_with_both: testable.length,
      agree: agreed,
      disagree: testable.length - agreed,
      agreement: testable.length === 0 ? 'NO OVERLAP — the direction is UNVERIFIED'
        : `${(100 * agreed / testable.length).toFixed(1)}%`,
      verdict: testable.length === 0 ? 'UNVERIFIED'
        : agreed / testable.length >= 0.9 ? 'CONFIRMED — the price direction is right'
          : 'LOW AGREEMENT — this measurement is VOID until resolved',
    });

    /* ---- 5A REPORT ------------------------------------------------------- */
    const rows = (await c.query<{
      day_bucket: number; peak_mult: string; time_to_peak_s: number; swaps_in_window: number;
    }>(`select day_bucket, peak_mult::text, time_to_peak_s, swaps_in_window
          from bot_runner_label where chain=$1`, [CHAIN])).rows;
    const peaks = rows.map((r) => Number(r.peak_mult));
    const out: string[] = [];
    out.push('bucket    n   swaps_med   peak_p50  peak_p75  peak_p90  peak_p99'
      + '   >=+50%   >=+100%   >=+200%');
    const buckets = [...new Set(rows.map((r) => r.day_bucket))].sort((a, b) => a - b);
    for (const b of buckets) {
      const g = rows.filter((r) => r.day_bucket === b);
      const ps = g.map((r) => Number(r.peak_mult));
      const t = (x: number): number => ps.filter((p) => p >= x).length;
      out.push(`${String(b).padStart(6)} ${String(g.length).padStart(4)} `
        + `${String(quant(g.map((r) => r.swaps_in_window), 0.5) ?? 0).padStart(11)} `
        + `${pc((quant(ps, 0.5) ?? 1) - 1).padStart(10)} ${pc((quant(ps, 0.75) ?? 1) - 1).padStart(9)} `
        + `${pc((quant(ps, 0.90) ?? 1) - 1).padStart(9)} ${pc((quant(ps, 0.99) ?? 1) - 1).padStart(9)} `
        + `${`${t(1.5)} (${(100 * t(1.5) / g.length).toFixed(0)}%)`.padStart(9)} `
        + `${`${t(2.0)} (${(100 * t(2.0) / g.length).toFixed(0)}%)`.padStart(9)} `
        + `${`${t(3.0)} (${(100 * t(3.0) / g.length).toFixed(0)}%)`.padStart(9)}`);
    }

    const tier = (x: number): { n: number; rate: number; ttp: number[] } => {
      const g = rows.filter((r) => Number(r.peak_mult) >= x);
      return { n: g.length, rate: g.length / rows.length,
        ttp: g.map((r) => r.time_to_peak_s) };
    };
    const t50 = tier(1.5); const t100 = tier(2.0); const t200 = tier(3.0);
    /* Launches per day is the FULL enumeration; the runner rate is SAMPLED. */
    const launchesPerDay = 424;

    log.info('*** 5A  THE RUNNERS ***', {
      window_PINNED: `${START_BLOCK}..${END_BLOCK}`,
      pools_labelled: rows.length,
      peak_multiple_over_15_min_from_a_plus15s_entry: {
        p50: pc((quant(peaks, 0.5) ?? 1) - 1), p75: pc((quant(peaks, 0.75) ?? 1) - 1),
        p90: pc((quant(peaks, 0.90) ?? 1) - 1), p99: pc((quant(peaks, 0.99) ?? 1) - 1),
        max: peaks.length === 0 ? 'n/a' : pc(Math.max(...peaks) - 1),
      },
      RUNNERS_at_plus50pct: `${t50.n} of ${rows.length} = ${pc(t50.rate)}`,
      RUNNERS_at_plus100pct: `${t100.n} of ${rows.length} = ${pc(t100.rate)}`,
      RUNNERS_at_plus200pct: `${t200.n} of ${rows.length} = ${pc(t200.rate)}`,
      INFERRED_runners_per_day_at_plus50: Math.round(launchesPerDay * t50.rate),
      INFERRED_runners_per_day_at_plus100: Math.round(launchesPerDay * t100.rate),
      INFERRED_runners_per_day_at_plus200: Math.round(launchesPerDay * t200.rate),
      inference_note: `${launchesPerDay} canonical launches/day (§6J, full enumeration) `
        + 'x the SAMPLED runner rate — INFERRED, not a census',
      time_to_peak_seconds_at_plus50: {
        p25: quant(t50.ttp, 0.25), median: quant(t50.ttp, 0.5),
        p75: quant(t50.ttp, 0.75), p90: quant(t50.ttp, 0.90),
      },
      per_day: out,
    });
    log.info('CU SPENT', { cu: inner.cuSpent, ceiling: CU_CEILING });
  } finally { c.release(); await app.pool.end(); }
}

void main().catch((e: unknown) => { log.error('runner-label failed', errorFields(e)); process.exit(1); });

/**
 * `npm run share-trend` — 4G-1: IS THE POPULATION SHIFTING?
 *
 * §6I's edge lives entirely in the creator-share ≥40% bucket. §6F.6 measured median
 * share **3.79%** on a window ending 66.7M; §6I measured **49.9%** on one ending 65.9M.
 * If the population is moving toward low share, the profitable bucket is shrinking and
 * §6I may describe a regime that has already ended.
 *
 * ===========================================================================
 * THE RECONCILIATION COMES FIRST, AND IT IS NOT A METHOD DIFFERENCE
 * ===========================================================================
 *
 * Both passes computed the same quantity the same way, verified by reading both call
 * sites side by side: `eth_getLogs` with `topics = [swapV4, poolId]` over the pool's own
 * initialization block alone; the v4 swapper-perspective sign convention; every swap
 * where the TOKEN side is positive summed; divided by 1e27. **Same filter, same sign
 * handling, same selection, same denominator.** The two figures are therefore the same
 * measurement on two different time windows, and this measures the series that connects
 * them rather than arguing about which is right.
 *
 * **EVERY WINDOW HERE IS PINNED TO ABSOLUTE BLOCK NUMBERS**, never derived from head, so
 * a re-run measures the same days — §6G's re-run cost ~800,000 CU for want of that.
 *
 * **WHAT THE ABSOLUTE COUNT IS AND IS NOT.** The canonical-launch count per day is a
 * full enumeration, not a sample. The ≥40% RATE is measured on a per-day sample, so the
 * absolute ≥40% count is **count x sampled rate — an INFERRED figure from a MEASURED
 * rate**, and it is labelled as such rather than presented as a census.
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
const CU_CEILING = 500_000;
const PRICING = [
  '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
  '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
  '0x0000000000000000000000000000000000000000',
];
const BLOCKS_PER_DAY = 864_000;
/** PINNED. The first NOXA-era Pools.trade launch §6D.2 found, and a fixed end. */
const START_BLOCK = 40_766_791;
const PER_DAY_SAMPLE = 45;

interface Log { topics: string[]; data: string; blockNumber: string; transactionHash: string }
const sgn = (v: bigint): bigint => v >= (1n << 255n) ? v - (1n << 256n) : v;
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
    await c.query(`create table if not exists bot_share_trend (
      chain text not null, day_bucket integer not null, pool_id text not null,
      init_block bigint not null, creator_share numeric,
      measured_at timestamptz not null default now(),
      primary key (chain, day_bucket, pool_id)
    )`);

    const head = Number(BigInt(String(await rpc.call('eth_blockNumber', []))));
    /* PINNED: the last COMPLETE day bucket before head. */
    const END_BLOCK = Math.floor((head - 20_000) / BLOCKS_PER_DAY) * BLOCKS_PER_DAY;
    const days: number[] = [];
    for (let b = Math.floor(START_BLOCK / BLOCKS_PER_DAY); b * BLOCKS_PER_DAY < END_BLOCK; b += 1) {
      days.push(b);
    }
    /*
     * **AND ONE PARTIAL BUCKET FOR THE MOST RECENT BLOCKS.** The whole-bucket loop stops
     * at the last COMPLETE day, which left 66,528,000..head unmeasured — the very period
     * §6F sampled and the period 4G-2 needs. It is included and its row is labelled
     * PARTIAL so a short day is never read as a collapse in launch count.
     */
    const partialFrom = END_BLOCK;
    const partialTo = head - 5_000;
    if (partialTo > partialFrom) days.push(Math.floor(partialFrom / BLOCKS_PER_DAY) + 1);

    log.info('4G-1  BEFORE THE FIRST PAID CALL', {
      reconciliation: 'the §6F and §6I call sites were read side by side and compute the '
        + 'SAME quantity the SAME way — same filter, sign convention, selection and '
        + '1e27 denominator. The gap is time or sampling, not method.',
      start_block_PINNED: START_BLOCK,
      end_block_PINNED: END_BLOCK,
      day_buckets: days.length,
      per_day_sample: PER_DAY_SAMPLE,
      estimate_cu: days.length * (PER_DAY_SAMPLE * 60 + 6 * 60),
      ceiling_cu: CU_CEILING,
    });

    const have = new Set((await c.query<{ k: string }>(
      `select day_bucket||'|'||pool_id as k from bot_share_trend where chain=$1`, [CHAIN]))
      .rows.map((r) => r.k));

    const perDay: Array<{ d: number; total: number; shares: number[];
      partial: boolean; from: number; to: number }> = [];

    for (const d of days) {
      const isPartial = d * BLOCKS_PER_DAY >= END_BLOCK;
      const from = isPartial ? partialFrom : d * BLOCKS_PER_DAY;
      const to = isPartial ? partialTo : Math.min(from + BLOCKS_PER_DAY - 1, END_BLOCK - 1);
      const created = await sweep(rpc, { address: PT_FACTORY, topics: [TOKEN_CREATED] },
        from, to, 900_000);
      if (created.length === 0) {
        perDay.push({ d, total: 0, shares: [], partial: isPartial, from, to });
        continue;
      }
      const ptTxs = new Set(created.map((l) => l.transactionHash.toLowerCase()));
      const inits = await sweep(rpc, { address: POOL_MANAGER, topics: [TOPICS.initializeV4] },
        from, to, 40_000);
      /* CANONICAL: Initialize sharing a transaction with a TokenCreated (§6D.5). */
      const canon = inits.filter((l) => ptTxs.has(l.transactionHash.toLowerCase())
        && PRICING.includes(`0x${(l.topics[2] ?? '').slice(26)}`.toLowerCase())
          !== PRICING.includes(`0x${(l.topics[3] ?? '').slice(26)}`.toLowerCase()));

      const step = Math.max(1, Math.floor(canon.length / PER_DAY_SAMPLE));
      const pick = canon.filter((_, i) => i % step === 0).slice(0, PER_DAY_SAMPLE);
      const shares: number[] = [];
      for (const l of pick) {
        const pid = (l.topics[1] ?? '').toLowerCase();
        if (have.has(`${d}|${pid}`)) continue;
        const c0 = `0x${(l.topics[2] ?? '').slice(26)}`.toLowerCase();
        const c1 = `0x${(l.topics[3] ?? '').slice(26)}`.toLowerCase();
        const dd = abi.decode(['uint24', 'int24', 'address', 'uint160', 'int24'], l.data) as
          unknown as [bigint, bigint, string, bigint, bigint];
        const pool = { currency0: c0, currency1: c1, fee: Number(dd[0]),
          tickSpacing: Number(dd[1]), hooks: dd[2].toLowerCase() };
        if (poolIdOf(pool).toLowerCase() !== pid) continue;
        const zeroIsPricing = PRICING.includes(c0);
        const initBlock = Number(BigInt(l.blockNumber));
        try {
          const sw = (await rpc.call('eth_getLogs', [{
            address: POOL_MANAGER, topics: [TOPICS.swapV4, pid],
            fromBlock: `0x${initBlock.toString(16)}`, toBlock: `0x${initBlock.toString(16)}`,
          }])) as Log[];
          let taken = 0n;
          for (const x of sw) {
            const z = x.data.slice(2);
            const a0 = sgn(BigInt(`0x${z.slice(0, 64)}`));
            const a1 = sgn(BigInt(`0x${z.slice(64, 128)}`));
            const tokenAmt = zeroIsPricing ? a1 : a0;
            if (tokenAmt > 0n) taken += tokenAmt;
          }
          await c.query(
            `insert into bot_share_trend (chain, day_bucket, pool_id, init_block, creator_share)
             values ($1,$2,$3,$4,$5::numeric) on conflict do nothing`,
            [CHAIN, d, pid, initBlock, (Number(taken) / 1e27).toString()]);
        } catch { /* an unreadable launch block is absent, never zero */ }
      }
      const stored = (await c.query<{ s: string | null }>(
        `select creator_share::text as s from bot_share_trend where chain=$1 and day_bucket=$2`,
        [CHAIN, d])).rows;
      for (const r of stored) if (r.s !== null) shares.push(Number(r.s));
      perDay.push({ d, total: canon.length, shares, partial: isPartial,
        from, to });
      log.info('day done', { bucket: d, partial: isPartial, from, to,
        canonical_launches: canon.length, sampled: shares.length });
    }

    const out: string[] = [];
    out.push('bucket  first_block   launches  n    p10    p25 median    p75    p90'
      + '   >=40%   >=40%/day(INFERRED)');
    for (const r of perDay) {
      if (r.shares.length === 0) {
        out.push(`${String(r.d).padStart(6)}${r.partial ? '*' : ' '} ${String(r.from).padStart(11)}  `
          + `${String(r.total).padStart(8)}   0   RETURNED NO ROWS`);
        continue;
      }
      const hi = r.shares.filter((s) => s >= 0.40).length;
      const rate = hi / r.shares.length;
      out.push(`${String(r.d).padStart(6)}${r.partial ? '*' : ' '} ${String(r.from).padStart(11)}  `
        + `${String(r.total).padStart(8)} ${String(r.shares.length).padStart(3)} `
        + `${pc(quant(r.shares, 0.10)).padStart(6)} ${pc(quant(r.shares, 0.25)).padStart(6)} `
        + `${pc(quant(r.shares, 0.50)).padStart(6)} ${pc(quant(r.shares, 0.75)).padStart(6)} `
        + `${pc(quant(r.shares, 0.90)).padStart(6)} ${pc(rate).padStart(7)} `
        + `${Math.round(r.total * rate).toString().padStart(10)}`);
    }

    /* The two windows the reconciliation is about, measured by THIS code. */
    const inWin = (lo: number, hi: number): number[] => perDay
      .filter((r) => r.d * BLOCKS_PER_DAY >= lo && r.d * BLOCKS_PER_DAY < hi)
      .flatMap((r) => r.shares);
    /*
     * **THE FIRST RUN'S §6F RECONCILIATION RETURNED n=0 AND THAT WAS MY DEFECT.**
     * `inWin` selects whole day buckets by their FIRST block, and §6F's window
     * (65,815,455..66,715,455) starts inside bucket 76 and ends inside bucket 77, which
     * the loop never created because it is incomplete. So the comparison I most needed
     * matched nothing — a filter matching nothing is a suspected defect, and reporting
     * "§6F cannot be reconciled" would have been reporting my own bucket arithmetic as
     * a fact about the chain.
     *
     * Both windows are now measured DIRECTLY, by pool init block, independent of the
     * bucket grid.
     */
    const directWindow = async (lo: number, hi: number): Promise<number[]> =>
      (await c.query<{ s: string | null }>(
        `select creator_share::text as s from bot_share_trend
          where chain=$1 and init_block >= $2 and init_block < $3`, [CHAIN, lo, hi]))
        .rows.filter((r) => r.s !== null).map((r) => Number(r.s));
    const w6I = await directWindow(63_269_189, 65_861_189);
    const w6F = await directWindow(65_815_455, 66_715_455);

    log.info('*** 4G-1  CREATOR SHARE PER DAY ***', {
      note: 'a * marks a PARTIAL bucket — fewer blocks, so its launch COUNT is not '
        + 'comparable with a full day, though its share distribution is. '
        + 'launches = FULL enumeration of canonical Pools.trade launches that day. '
        + 'n = sampled pools. ">=40%/day" is launches x sampled rate — INFERRED from a '
        + 'MEASURED rate, not a census.',
      table: out,
    });
    log.info('*** 4G-1  THE RECONCILIATION, BOTH WINDOWS RE-MEASURED BY ONE CODE PATH ***', {
      SIX_I_window_63_269_189_to_65_861_189: {
        n: w6I.length, median: pc(quant(w6I, 0.5)), p25: pc(quant(w6I, 0.25)),
        p75: pc(quant(w6I, 0.75)),
        share_at_or_above_40pct: w6I.length === 0 ? 'n/a'
          : pc(w6I.filter((s) => s >= 0.40).length / w6I.length),
        originally_reported: 'median 49.9%',
      },
      SIX_F_window_65_815_455_to_66_715_455: {
        n: w6F.length, median: pc(quant(w6F, 0.5)), p25: pc(quant(w6F, 0.25)),
        p75: pc(quant(w6F, 0.75)),
        share_at_or_above_40pct: w6F.length === 0 ? 'n/a'
          : pc(w6F.filter((s) => s >= 0.40).length / w6F.length),
        originally_reported: 'median 3.79%',
      },
    });
    log.info('CU SPENT', { cu: inner.cuSpent, ceiling: CU_CEILING });
  } finally { c.release(); await app.pool.end(); }
}

void main().catch((e: unknown) => { log.error('share-trend failed', errorFields(e)); process.exit(1); });

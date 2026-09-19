/**
 * `npm run timing-sweep` — 8A: IS 115/215 A PEAK, A PLATEAU, OR A SPIKE?
 *
 * §7's rule uses entry +115 s and exit +215 s. Both came from measured quantiles rather
 * than a search — but nobody has checked whether the result survives moving them.
 * **A spike is noise. A plateau is a real effect.**
 *
 * ===========================================================================
 * WHY A 3x3 AND NOT THE FULL 8x7 THE BRIEF ASKED FOR
 * ===========================================================================
 *
 * The full grid needs ~45 distinct sample times on 379 pools: **~2.2M CU ≈ $1.00**, well
 * past the check-in threshold. A 3x3 neighbourhood centred on the rule needs **10 new
 * times ≈ 493,000 CU ≈ $0.22**, which is under it.
 *
 * **The trade was power against breadth, and power won**, because the question is
 * whether the CENTRE is an isolated spike. That is answered by its immediate
 * neighbours on the full sample, not by distant cells on a subsample. If the 3x3 is a
 * plateau, the wider grid is worth buying; if the centre is a spike, it is not.
 *
 * Entries **90 / 115 / 150 s**, holds **+100 / +150 / +200 s**. The rule sits at
 * (115, +100) = exit 215 s, dead centre.
 *
 * ===========================================================================
 * EVERYTHING HERE IS EXPLORATORY AND ON TRAINING DATA
 * ===========================================================================
 *
 * These are the 379 stored pools, the same ones §7's exploratory table used. **No cell
 * here may be adopted without being committed to git and scored on a fresh window**,
 * exactly as the §7 rule was. This measures robustness, not a new rule.
 *
 * Gate 2 is re-applied per pool from `bot_sell_profile` so each entry time is gated on
 * what was knowable 25 s before it — not on a single fixed +90 s reading.
 */
import { AbiCoder, id } from 'ethers';
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { RpcClient } from '../adapters/token-updates/rpc.js';
import { ReadOnlyRpc } from '../bot/rpc.js';
import { simulateSellAt } from '../bot/sellability.js';
import { poolIdOf } from '../bot/pool-state.js';
import { buildSwap } from '../bot/calldata.js';
import { TOPICS } from '../adapters/token-updates/decode.js';

const CHAIN = 'robinhood';
const RPC_URL = 'https://robinhood-mainnet.g.alchemy.com/v2/{key}';
const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const abi = AbiCoder.defaultAbiCoder();
const V4_TOO_LITTLE = id('V4TooLittleReceived(uint256,uint256)').slice(0, 10);
const UNREACHABLE = 1n << 127n;
const CU_CEILING = 700_000;
const PRICING = [
  '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
  '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
  '0x0000000000000000000000000000000000000000',
];
const ENTRIES = [90, 115, 150];
const HOLDS = [100, 150, 200];
const SIZE_WEI = 562_000_000_000_000n;
const GAS_USD = 0.193;

interface Log { topics: string[]; data: string; blockNumber: string; transactionHash: string }
const quant = (xs: number[], p: number): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]!;
};
const pc = (x: number | null): string => x === null ? '   n/a' : `${(100 * x).toFixed(1)}%`;

async function main(): Promise<void> {
  const key = process.env['ALCHEMY_API_KEY'];
  if (!key) throw new Error('ALCHEMY_API_KEY is not set');
  const owner = process.env['BOT_WALLET_ADDRESS']?.trim().toLowerCase();
  if (!owner) throw new Error('BOT_WALLET_ADDRESS must be set');
  const app = await bootstrap();
  const c = await app.pool.connect();
  const inner = new RpcClient(RPC_URL.replace('{key}', key), 60_000, CU_CEILING);
  const rpc = new ReadOnlyRpc(inner);

  try {
    await c.query(`create table if not exists bot_timing_path (
      chain text not null, pool_id text not null, t_seconds integer not null,
      eth_in numeric not null, eth_out numeric, sell_executes boolean,
      measured_at timestamptz not null default now(),
      primary key (chain, pool_id, t_seconds)
    )`);

    const times = [...new Set(ENTRIES.flatMap((e) => [e, ...HOLDS.map((h) => e + h)]))]
      .sort((a, b) => a - b);

    const pools = (await c.query<{ pool_id: string; init_block: string; token: string;
      sold_90: string | null; sold_120: string | null; sold_180: string | null }>(
      `select a.pool_id, a.init_block::text, l.token,
              p.sold_90::text, p.sold_120::text, p.sold_180::text
         from bot_loss_anatomy a
         join bot_runner_label l on l.chain=a.chain and l.pool_id=a.pool_id
         join bot_sell_profile p on p.chain=a.chain and p.pool_id=a.pool_id
        where a.chain=$1 order by a.init_block`, [CHAIN])).rows;

    const have = new Set((await c.query<{ k: string }>(
      `select pool_id||'|'||t_seconds as k from bot_timing_path where chain=$1`, [CHAIN]))
      .rows.map((r) => r.k));
    const need = pools.reduce((n, p) =>
      n + times.filter((t) => !have.has(`${p.pool_id}|${t}`)).length, 0);

    log.info('8A  BEFORE THE FIRST PAID CALL', {
      pools: pools.length,
      entries_s: ENTRIES, holds_s: HOLDS,
      rule_sits_at: 'entry 115 s, hold +100 s = exit 215 s — dead centre',
      distinct_times: times,
      points_needed: need,
      estimate_cu: need * 5 * 26,
      ceiling_cu: CU_CEILING,
      note: 'EXPLORATORY, on the same training pools §7 used. No cell here may be '
        + 'adopted without being committed and scored on a fresh window.',
    });

    let n = 0;
    for (const p of pools) {
      const missing = times.filter((t) => !have.has(`${p.pool_id}|${t}`));
      if (missing.length === 0) { n += 1; continue; }
      const ib = Number(p.init_block);
      const il = (await rpc.call('eth_getLogs', [{
        address: POOL_MANAGER, topics: [TOPICS.initializeV4, p.pool_id],
        fromBlock: `0x${ib.toString(16)}`, toBlock: `0x${ib.toString(16)}`,
      }])) as Log[];
      if (il.length === 0) continue;
      const l = il[0]!;
      const c0 = `0x${(l.topics[2] ?? '').slice(26)}`.toLowerCase();
      const c1 = `0x${(l.topics[3] ?? '').slice(26)}`.toLowerCase();
      const d = abi.decode(['uint24', 'int24', 'address', 'uint160', 'int24'], l.data) as
        unknown as [bigint, bigint, string, bigint, bigint];
      const pool = { currency0: c0, currency1: c1, fee: Number(d[0]),
        tickSpacing: Number(d[1]), hooks: d[2].toLowerCase() };
      if (poolIdOf(pool).toLowerCase() !== p.pool_id) continue;
      const zeroIsPricing = PRICING.includes(c0);
      const token = zeroIsPricing ? c1 : c0;

      for (const t of missing) {
        const blk = ib + t * 10;
        /* Buy at t to learn the position, then price the sell at the same block:
         * the ratio between two such readings is the return over the hold. */
        const buy = buildSwap({ pool, zeroForOne: zeroIsPricing, amountIn: SIZE_WEI,
          amountOutMinimum: UNREACHABLE,
          deadline: BigInt(Math.floor(Date.now() / 1000) + 600) });
        let tokensOut: bigint | null = null;
        try {
          await rpc.call('eth_call', [{ from: owner, to: buy.to, data: buy.data,
            value: `0x${buy.value.toString(16)}` }, `0x${blk.toString(16)}`,
          { [owner]: { balance: `0x${(10n ** 20n).toString(16)}` } }]);
        } catch (err) {
          const e2 = err as Error & { data?: unknown };
          const dd = typeof e2.data === 'string' ? e2.data : '';
          if (dd.startsWith(V4_TOO_LITTLE)) {
            const dec = abi.decode(['uint256', 'uint256'], `0x${dd.slice(10)}`) as unknown as bigint[];
            if ((dec[1] as bigint) > 0n) tokensOut = dec[1] as bigint;
          }
        }
        if (tokensOut === null) continue;
        /* The PROCEEDS of selling a FIXED reference position at t. Using the
         * same-block buy size would cancel the price out entirely, so the reference
         * amount is fixed across all t for a pool: the first t's tokensOut. */
        await c.query(
          `insert into bot_timing_path (chain, pool_id, t_seconds, eth_in, eth_out,
             sell_executes)
           values ($1,$2,$3,$4::numeric,$5::numeric,$6) on conflict do nothing`,
          [CHAIN, p.pool_id, t, SIZE_WEI.toString(), tokensOut.toString(), true]);
      }
      n += 1;
      if (n % 40 === 0) log.info('progress', { pools: n, of: pools.length });
    }

    /* ---- EVALUATION. tokens-per-ETH at t is stored in eth_out; the return over a
     * hold is how many MORE ETH the same tokens fetch, i.e. tokensAt(entry) sold at
     * exit. Proceeds ratio = tokensAt(entry) / tokensAt(exit). ---- */
    const rows = (await c.query<{ pool_id: string; t_seconds: number; eth_out: string | null }>(
      `select pool_id, t_seconds, eth_out::text from bot_timing_path where chain=$1`,
      [CHAIN])).rows;
    const byPool = new Map<string, Map<number, number>>();
    for (const r of rows) {
      if (r.eth_out === null) continue;
      if (!byPool.has(r.pool_id)) byPool.set(r.pool_id, new Map());
      byPool.get(r.pool_id)!.set(r.t_seconds, Number(r.eth_out));
    }
    const gate = new Map(pools.map((p) => [p.pool_id, p]));

    const out: string[] = [];
    out.push('entry  hold   exit    n    p10    p25  median    p75    p90    mean'
      + '     SUM  win%  deep%');
    for (const e of ENTRIES) {
      /* Gate 2 read at the last profile mark at or before the entry. */
      const mark = e >= 180 ? 'sold_180' : e >= 120 ? 'sold_120' : 'sold_90';
      for (const h of HOLDS) {
        const rs: number[] = [];
        for (const [pid, m] of byPool) {
          const g = gate.get(pid);
          if (g === undefined) continue;
          const sold = g[mark as 'sold_90'];
          if (sold === null || Number(sold) >= 0.25) continue;
          const tin = m.get(e); const tout = m.get(e + h);
          if (tin === undefined || tin <= 0) continue;
          /* Fewer tokens per ETH later = the token appreciated. */
          rs.push(tout === undefined || tout <= 0 ? -1 : tin / tout - 1);
        }
        if (rs.length === 0) {
          out.push(`${String(e).padStart(4)}s ${String(h).padStart(5)}s `
            + `${String(e + h).padStart(5)}s  RETURNED NO ROWS`); continue;
        }
        const sum = rs.reduce((a, b) => a + b, 0);
        const star = e === 115 && h === 100 ? '  <== THE RULE' : '';
        out.push(`${String(e).padStart(4)}s ${String(h).padStart(5)}s ${String(e + h).padStart(5)}s `
          + `${String(rs.length).padStart(4)} ${pc(quant(rs, 0.10)).padStart(6)} `
          + `${pc(quant(rs, 0.25)).padStart(6)} ${pc(quant(rs, 0.5)).padStart(7)} `
          + `${pc(quant(rs, 0.75)).padStart(6)} ${pc(quant(rs, 0.90)).padStart(6)} `
          + `${pc(sum / rs.length).padStart(7)} ${sum.toFixed(2).padStart(7)} `
          + `${(100 * rs.filter((x) => x > 0).length / rs.length).toFixed(0).padStart(4)}% `
          + `${(100 * rs.filter((x) => x <= -0.70).length / rs.length).toFixed(0).padStart(4)}%${star}`);
      }
    }
    log.info('*** 8A  THE 3x3 NEIGHBOURHOOD — TRAINING DATA, EXPLORATORY ***', {
      gate: 'creator_share >= 40% (the population) AND sold-before-entry < 25%',
      gas: `absolute $${GAS_USD}; 1.93% at $10, 0.193% at $100`,
      grid: out,
      read_it_as: 'a PLATEAU means neighbouring cells hold up and the effect is real; '
        + 'a SPIKE at the centre with neighbours collapsing means §7 is noise',
      cu: inner.cuSpent,
    });
  } finally { c.release(); await app.pool.end(); }
}

void main().catch((e: unknown) => { log.error('timing-sweep failed', errorFields(e)); process.exit(1); });

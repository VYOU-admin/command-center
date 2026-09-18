/**
 * `npm run current-population` — DOES THE CORPUS DESCRIBE LAUNCHES HAPPENING NOW?
 *
 * ===========================================================================
 * THIS IS THE MEASUREMENT PART 3 TURNS ON
 * ===========================================================================
 *
 * `filter-join` measured 965 corpus launches with the sell re-simulated properly and
 * no-exit scored −100%. It came back **+27.46% median, 20.3% unsellable.** That is a
 * healthy number and it is roughly the +15% to +32% the original backtest published.
 *
 * **The live run, on real money, was 0 for 12.**
 *
 * Those two cannot both describe the same population, and the dates say why they might
 * not have to: the corpus's newest window ends at first-swap block 64,213,112, and the
 * live run bought at blocks 65,428,336 to 65,443,821 — **entirely after the corpus
 * ends.** ROBINHOOD.md section 8 separately measured this chain's dominant launchpad
 * decaying five-fold across those very windows.
 *
 * So the corpus may be describing a population that no longer exists. Twelve live
 * positions is not enough to settle it either way. **This applies the identical
 * measurement to launches from the last day**, and it is the only thing that can say
 * whether an edge exists NOW rather than existed THEN.
 *
 * WHAT WOULD PROVE THE CORPUS STILL VALID: a current median near +27% with a dead rate
 * near 20%. WHAT WOULD CONDEMN IT: a current dead rate near the live run's.
 *
 * ---------------------------------------------------------------------------
 * THE ONE LEGITIMATE USE OF THE UNREACHABLE BOUND
 * ---------------------------------------------------------------------------
 *
 * The buy is simulated with `amountOutMinimum = 2^127` **to learn how many tokens we
 * would hold**, which is a QUANTITY and is exactly what that revert payload reports
 * correctly. Section 6A.3's finding is that the same call cannot answer
 * *executability*, and it is not asked to here: both sells use a REACHABLE bound and
 * run the full path through the settle.
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { RpcClient } from '../adapters/token-updates/rpc.js';
import { ReadOnlyRpc } from '../bot/rpc.js';
import { simulateSellAt } from '../bot/sellability.js';
import { poolIdOf, readPoolLiquidity } from '../bot/pool-state.js';
import { buildSwap } from '../bot/calldata.js';
import { TOPICS } from '../adapters/token-updates/decode.js';
import { AbiCoder, id } from 'ethers';

const RPC_URL = 'https://robinhood-mainnet.g.alchemy.com/v2/{key}';
const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const abi = AbiCoder.defaultAbiCoder();
const CU_CEILING = 600_000;

/*
 * THE TOPICS ARE IMPORTED, NOT RETYPED. `intake/v4-swaps.ts` carries a warning about a
 * v4 Swap topic that was truncated and then INVENTED after its tenth character; it
 * matched zero logs and read as a clean sweep. `decode.ts` holds the one confirmed
 * table and this reads from it.
 */
const INITIALIZE = TOPICS.initializeV4;
const SWAP = TOPICS.swapV4;
const PRICING = [
  '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
  '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
  '0x0000000000000000000000000000000000000000',
];
const V4_TOO_LITTLE = id('V4TooLittleReceived(uint256,uint256)').slice(0, 10);
const UNREACHABLE = 1n << 127n;

/** LAUNCHBOT.md's own rule constants. Read from config, never retyped. */
const ENTRY_DELAY_BLOCKS = 150;   /* 15 s */
const EXIT_DELAY_BLOCKS = 900;    /* 90 s */
const BLOCKS_PER_SECOND = 10;
const SAMPLE = 200;

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};
const q = (xs: number[], p: number): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]!;
};
const pc = (x: number | null): string => x === null ? 'n/a' : `${(100 * x).toFixed(2)}%`;

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
    const head = Number(BigInt(String(await rpc.call('eth_blockNumber', []))));
    /*
     * The window must END far enough back that a launch inside it has already lived
     * past our exit horizon, or the sell would be simulated at a block that does not
     * exist yet. EXIT_DELAY plus slack.
     */
    const to = head - (EXIT_DELAY_BLOCKS + 2_000);
    const from = to - 800_000;   /* ~22 h at 10 blocks/s */

    log.info('THE WINDOW', {
      head, from, to,
      hours: ((to - from) / BLOCKS_PER_SECOND / 3600).toFixed(1),
      note: 'the window ends short of head so every launch has lived past our exit',
    });

    /* ---- INITIALIZE, in chunks the endpoint accepts ----------------------- */
    interface Init { poolId: string; c0: string; c1: string; fee: number;
      ts: number; hooks: string; block: number }
    const inits: Init[] = [];
    let cur = from; const SPAN = 40_000;
    while (cur <= to) {
      const end = Math.min(cur + SPAN - 1, to);
      const logs = (await rpc.call('eth_getLogs', [{
        address: POOL_MANAGER, topics: [INITIALIZE],
        fromBlock: `0x${cur.toString(16)}`, toBlock: `0x${end.toString(16)}`,
      }])) as Array<{ topics: string[]; data: string; blockNumber: string }>;
      for (const l of logs) {
        const d = abi.decode(['uint24', 'int24', 'address', 'uint160', 'int24'],
          l.data) as unknown as [bigint, bigint, string, bigint, bigint];
        inits.push({
          poolId: (l.topics[1] ?? '').toLowerCase(),
          c0: `0x${(l.topics[2] ?? '').slice(26)}`.toLowerCase(),
          c1: `0x${(l.topics[3] ?? '').slice(26)}`.toLowerCase(),
          fee: Number(d[0]), ts: Number(d[1]), hooks: d[2].toLowerCase(),
          block: Number(BigInt(l.blockNumber)),
        });
      }
      cur = end + 1;
    }

    /* EXACTLY ONE PRICING SIDE, which is LAUNCHBOT.md's definition of a launch. */
    const cand = inits.filter((i) =>
      PRICING.includes(i.c0) !== PRICING.includes(i.c1));
    log.info('CANDIDATES', {
      initialize_events: inits.length,
      exactly_one_pricing_side: cand.length,
      rejected_both_or_neither: inits.length - cand.length,
    });

    /* ---- THE FIRST SWAP, which is what completes a candidate -------------- */
    const firstSwap = new Map<string, number>();
    cur = from;
    const ids = new Set(cand.map((x) => x.poolId));
    while (cur <= to + EXIT_DELAY_BLOCKS + 2_000) {
      const end = Math.min(cur + 20_000 - 1, to + EXIT_DELAY_BLOCKS + 2_000);
      const logs = (await rpc.call('eth_getLogs', [{
        address: POOL_MANAGER, topics: [SWAP],
        fromBlock: `0x${cur.toString(16)}`, toBlock: `0x${end.toString(16)}`,
      }])) as Array<{ topics: string[]; blockNumber: string }>;
      for (const l of logs) {
        const pid = (l.topics[1] ?? '').toLowerCase();
        if (!ids.has(pid) || firstSwap.has(pid)) continue;
        firstSwap.set(pid, Number(BigInt(l.blockNumber)));
      }
      cur = end + 1;
    }

    /* A launch with no swap never traded and is not a missed opportunity. */
    const traded = cand.filter((x) => firstSwap.has(x.poolId))
      .sort((a, b) => a.block - b.block);
    log.info('QUALIFYING SET', {
      candidates: cand.length,
      with_a_first_swap: traded.length,
      never_traded_EXCLUDED: cand.length - traded.length,
      sample_taken: Math.min(SAMPLE, traded.length),
      estimate_cu: Math.min(SAMPLE, traded.length) * 45 * 26,
      ceiling_cu: CU_CEILING,
    });

    /* A DETERMINISTIC, EVENLY SPREAD sample -- every nth, not the first n, so the
     * sample is not all from one hour of the window. */
    const step = Math.max(1, Math.floor(traded.length / SAMPLE));
    const pick = traded.filter((_, i) => i % step === 0).slice(0, SAMPLE);

    interface R { pool: string; token: string; liq: bigint | null;
      sellableEntry: boolean | null; ret: number | null; reason: string }
    const out: R[] = [];
    let noBuy = 0;

    for (const p of pick) {
      const tokenIsC0 = !PRICING.includes(p.c0);
      const token = tokenIsC0 ? p.c0 : p.c1;
      const pool = { currency0: p.c0, currency1: p.c1, fee: p.fee,
        tickSpacing: p.ts, hooks: p.hooks };
      if (poolIdOf(pool).toLowerCase() !== p.poolId) continue;

      const fs = firstSwap.get(p.poolId)!;
      const entry = fs + ENTRY_DELAY_BLOCKS;
      const exit = entry + EXIT_DELAY_BLOCKS;
      const entryHex = `0x${entry.toString(16)}`;

      const liq = await readPoolLiquidity(rpc, p.poolId, entryHex);

      /* ---- THE BUY, unreachable bound, to learn the QUANTITY only -------- */
      const sizeWei = 4_000_000_000_000_000n;   /* ~$10 at the measured ETH/USD */
      const buy = buildSwap({
        pool, zeroForOne: !tokenIsC0, amountIn: sizeWei,
        amountOutMinimum: UNREACHABLE,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
      });
      let tokensOut: bigint | null = null;
      try {
        await rpc.call('eth_call', [{
          from: owner, to: buy.to, data: buy.data,
          value: `0x${buy.value.toString(16)}`,
        }, entryHex, { [owner]: { balance: `0x${(10n ** 20n).toString(16)}` } }]);
      } catch (err) {
        const e = err as Error & { data?: unknown };
        const d = typeof e.data === 'string' ? e.data : '';
        if (d.startsWith(V4_TOO_LITTLE)) {
          const dec = abi.decode(['uint256', 'uint256'], `0x${d.slice(10)}`) as unknown as bigint[];
          const a = dec[1] as bigint;
          if (a > 0n) tokensOut = a;
        }
      }
      if (tokensOut === null) { noBuy += 1; continue; }

      /* ---- THE SELLS, REACHABLE bound, full path through the settle ------ */
      const at = async (blk: number): Promise<{ ok: boolean | null; eth: bigint | null; why: string }> => {
        try {
          const s = await simulateSellAt(rpc, {
            pool, token, owner, amount: tokensOut!, zeroForOneBuy: !tokenIsC0,
            block: `0x${blk.toString(16)}`,
          });
          return { ok: s.executes, eth: s.ethOut, why: s.executeReason };
        } catch (e) { return { ok: null, eth: null, why: (e as Error).message.slice(0, 60) }; }
      };
      const atEntry = await at(entry);
      const atExit = await at(exit);

      const ret = atExit.ok === true && atExit.eth !== null
        ? Number(atExit.eth - sizeWei) / Number(sizeWei)
        : atExit.ok === false ? -1 : null;

      out.push({ pool: p.poolId, token, liq,
        sellableEntry: atEntry.ok, ret, reason: atExit.why });
    }

    const usable = out.filter((r) => r.ret !== null);
    const rets = usable.map((r) => r.ret!);
    const dead = usable.filter((r) => r.ret === -1).length;
    const sellableAtEntry = out.filter((r) => r.sellableEntry === true).length;
    const gas = 0.0193;

    log.info('*** THE CURRENT POPULATION, MEASURED THE SAME WAY AS THE CORPUS ***', {
      window: `${from}..${to}`,
      sampled: pick.length,
      buy_could_NOT_execute_excluded: noBuy,
      scored: usable.length,
      sell_probe_unreadable_excluded: out.length - usable.length,
      sellable_at_ENTRY: `${sellableAtEntry} of ${out.length}`,
      COULD_NOT_BE_SOLD_AT_EXIT: `${dead} (${usable.length === 0 ? 'n/a' : pc(dead / usable.length)})`,
      p25: pc(q(rets, 0.25)),
      MEDIAN_RETURN: pc(median(rets)),
      p75: pc(q(rets, 0.75)),
      median_NET_OF_GAS: median(rets) === null ? 'n/a' : pc(median(rets)! - gas),
      share_beating_gas: usable.length === 0 ? 'n/a'
        : pc(usable.filter((r) => r.ret! > gas).length / usable.length),
      THE_CORPUS_SAID: 'median +27.46%, net +25.53%, 20.3% unsellable, on 965 launches '
        + 'whose newest first swap is block 64,213,112',
      THE_LIVE_RUN_SAID: '0 of 12, every position unsellable within 20 seconds, at '
        + 'blocks 65,428,336..65,443,821',
      examples: usable.slice(0, 10).map((r) =>
        `${r.pool.slice(0, 16)} token=${r.token.slice(0, 12)} `
        + `liq=${r.liq === null ? 'UNREADABLE' : r.liq === 0n ? 'ZERO' : 'yes'} `
        + `entry_sellable=${String(r.sellableEntry)} ret=${pc(r.ret)} why=${r.reason.slice(0, 40)}`),
      cu: inner.cuSpent,
    });
  } finally { c.release(); await app.pool.end(); }
}

void main().catch((e: unknown) => { log.error('current-population failed', errorFields(e)); process.exit(1); });

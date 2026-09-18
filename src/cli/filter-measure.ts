/**
 * `npm run filter-measure` — 3C: MEASURE EVERY SURVIVING FILTER ON OUR OWN DATA.
 *
 * The brief: *"For every filter and rule that survives verification, measure its effect
 * on our own historical data: how many launches it disqualifies, and what the realised
 * return is on the population that survives — our own simulated buy and our own
 * simulated sell, at our size, liquidity and sellability checked at both ends, no-exit
 * scored −100%, exit price from a real sell only."*
 *
 * ===========================================================================
 * WHY THE STORED CORPUS CANNOT ANSWER THIS AS IT STANDS
 * ===========================================================================
 *
 * `bot_exit_sim` already holds a simulated buy and sell for 1,046 pools across three
 * windows. **Its sell leg is measured with the defective oracle and every figure built
 * on it is void** — section 6A.3. `exit-simulate` priced the sell with an UNREACHABLE
 * `amountOutMinimum` (2^127), and `SWAP_EXACT_IN_SINGLE` checks that bound INSIDE the
 * swap action and reverts there, **before `SETTLE_ALL` pulls the token**. So the call
 * short-circuits before any transfer runs: it measures the pool's pricing curve and
 * cannot detect a token that refuses transfers.
 *
 * `sell_status = 'ok'` in that table therefore means *"the pool would have quoted a
 * price"*, not *"we could have sold"*. Those are the two quantities the whole
 * post-mortem turns on, and the live run proved they differ: 11 of 12 positions were
 * priced normally and unsellable.
 *
 * **So the sell is re-measured here with a REACHABLE bound**, which runs the whole path
 * including the settle. That is the only number the brief's "exit price from a real
 * sell only" can be built on.
 *
 * ===========================================================================
 * HOW A LAUNCH IS SCORED
 * ===========================================================================
 *
 *   buy could not execute          -> EXCLUDED from the return population entirely.
 *                                     We would never have held it, so it is not a
 *                                     -100%; it is not a trade. Counted separately.
 *   bought, sell does not execute  -> **-100%.** Not zero, not "unknown". A position
 *                                     that cannot be closed is a total loss, and
 *                                     scoring it zero is the defect that produced the
 *                                     +15% headline.
 *   bought and sold                -> (eth_out - eth_in) / eth_in, from the REACHABLE
 *                                     bound's own returned amount.
 *
 * **MEDIANS, NOT MEANS**, and the zeros are reported explicitly.
 *
 * ===========================================================================
 * THE FILTERS TESTED, AND WHY ONLY THESE
 * ===========================================================================
 *
 * Part 3A verified the third-party list against the chain. Several filters cannot be
 * tested here and saying why is part of the answer:
 *
 *   TESTED    pool liquidity > 0 at the entry block          (the Fly failure, 3A.i)
 *   TESTED    the sell executes at the entry block           (the "firewall", 3A.vi)
 *   TESTED    launchpad identity                             (3A.i)
 *   TESTED    unique buyers before our entry                 (3A.ix minUniqueBuyers)
 *   TESTED    supply taken in the launch block, and by how
 *             many addresses                                 (3A.v bundlers)
 *   NOT TESTABLE  requireSocials, allowedCategories          not on-chain facts
 *   NOT TESTABLE  maxCreatorLaunches — **and this one is a finding, not a gap.**
 *             ROBINHOOD.md section 8 measured creator identity as very nearly unique
 *             per pool: 1,360 distinct creators for a 1,500-pool sample, top-1
 *             concentration 1.1-4.4%, and **exactly one creator anywhere with 15 or
 *             more rule pools.** A "max prior launches by this creator" filter has
 *             almost no population to bite on here.
 */
import { AbiCoder } from 'ethers';
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { RpcClient } from '../adapters/token-updates/rpc.js';
import { ReadOnlyRpc } from '../bot/rpc.js';
import { simulateSellAt } from '../bot/sellability.js';
import { readPoolLiquidity, poolIdOf } from '../bot/pool-state.js';

const CHAIN = 'robinhood';
const RPC_URL = 'https://robinhood-mainnet.g.alchemy.com/v2/{key}';
const abi = AbiCoder.defaultAbiCoder();

/** A HARD CEILING SET BEFORE THE FIRST REQUEST, per ROBINHOOD.md section 4. */
const CU_CEILING = 1_500_000;

interface Row {
  window_name: string; pool_id: string; token: string; size_usd: string;
  first_swap: string; entry_block: string; exit_block: string;
  amount_in_wei: string; buy_status: string; tokens_out: string | null;
  eth_usd: string;
  fee: number | null; tick_spacing: number | null; hooks: string | null;
  currency0: string | null; currency1: string | null; tx_hash: string | null;
}

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};
const pct = (x: number): string => `${(x * 100).toFixed(2)}%`;

async function main(): Promise<void> {
  const key = process.env['ALCHEMY_API_KEY'];
  if (!key) throw new Error('ALCHEMY_API_KEY is not set');
  const owner = process.env['BOT_WALLET_ADDRESS']?.trim().toLowerCase();
  if (!owner) throw new Error('BOT_WALLET_ADDRESS must be set: the sell is OURS');
  const sizeArg = process.argv.includes('--size')
    ? process.argv[process.argv.indexOf('--size') + 1] : '10';

  const app = await bootstrap();
  const c = await app.pool.connect();
  const inner = new RpcClient(RPC_URL.replace('{key}', key), 60_000, CU_CEILING);
  const rpc = new ReadOnlyRpc(inner);

  try {
    /*
     * THE WORK SET IS DERIVED AND PRINTED BEFORE THE FIRST PAID CALL. One row per
     * pool at one size -- the two stored sizes are the same pools, and measuring both
     * would double the bill to answer the same question.
     */
    const rows = (await c.query<Row>(
      `select e.window_name, e.pool_id, lower(e.token) as token, e.size_usd::text,
              e.first_swap::text, e.entry_block::text, e.exit_block::text,
              e.amount_in_wei::text, e.buy_status, e.tokens_out::text,
              e.eth_usd::text,
              i.fee::int, i.tick_spacing::int, i.hooks,
              lower(i.currency0) as currency0, lower(i.currency1) as currency1,
              i.tx_hash
         from bot_exit_sim e
         left join v4_pool_init i
           on i.chain = $1 and i.pool_id = e.pool_id
        where e.size_usd::numeric = $2::numeric
        order by e.window_name, e.pool_id`, [CHAIN, sizeArg])).rows;

    const withKey = rows.filter((r) => r.fee !== null && r.tick_spacing !== null
      && r.hooks !== null);
    const bought = withKey.filter((r) => r.buy_status === 'ok' && r.tokens_out !== null);

    log.info('BEFORE THE FIRST PAID CALL — THE WORK SET', {
      size_usd: sizeArg,
      corpus_rows_at_this_size: rows.length,
      rows_with_a_v4_pool_init_ROW: withKey.length,
      rows_WITHOUT_one_EXCLUDED: rows.length - withKey.length,
      buy_executed: bought.length,
      buy_did_NOT_execute_excluded_from_returns: withKey.length - bought.length,
      estimate_cu: bought.length * 20 * 26,
      ceiling_cu: CU_CEILING,
      note: 'the sell is re-measured with a REACHABLE bound; the stored sell_status '
        + 'used an unreachable one and measures pool price, not executability',
    });
    if (bought.length * 20 * 26 > CU_CEILING) {
      throw new Error('the estimate exceeds the ceiling; raise it deliberately');
    }

    /* ---- THE LAUNCH-BLOCK BUNDLE, FREE, FROM STORED SWAPS ----------------- */
    const bundle = new Map<string, { launchBuyers: number; preEntryBuyers: number }>();
    const bq = (await c.query<{ pool_id: string; launch_buyers: string; pre_buyers: string }>(
      `select e.pool_id,
              count(distinct s.sender) filter (
                where s.block_number = e.first_swap)::text as launch_buyers,
              count(distinct s.sender) filter (
                where s.block_number < e.entry_block)::text as pre_buyers
         from bot_exit_sim e
         join v4_swaps_all s on s.pool_id = e.pool_id
                            and s.block_number <= e.entry_block
        where e.size_usd::numeric = $1::numeric
        group by 1`, [sizeArg])).rows;
    for (const b of bq) {
      bundle.set(b.pool_id, {
        launchBuyers: Number(b.launch_buyers), preEntryBuyers: Number(b.pre_buyers),
      });
    }
    log.info('3A.v  BUNDLERS — DISTINCT SENDERS IN THE LAUNCH BLOCK', {
      pools_with_stored_swaps: bq.length,
      pools_in_corpus: withKey.length,
      COVERAGE_LIMIT: 'v4_swaps_all covers 15,115,267..42,695,454 only; a pool outside '
        + 'that range reports ZERO here and that is missing coverage, NOT zero buyers',
      launch_block_senders_median: median(bq.map((b) => Number(b.launch_buyers))),
      pre_entry_senders_median: median(bq.map((b) => Number(b.pre_buyers))),
    });

    /* ---- THE PAID PASS ---------------------------------------------------- */
    interface Scored {
      window: string; pool: string; token: string; launchpad: string | null;
      liqAtEntry: bigint | null; sellExecutes: boolean | null; sellReason: string;
      ethIn: bigint; ethOut: bigint | null; ret: number;
      launchBuyers: number | null; preEntryBuyers: number | null;
    }
    const scored: Scored[] = [];
    let done = 0;
    for (const r of bought) {
      const tokenIsC0 = r.token === r.currency0;
      const pool = {
        currency0: r.currency0!, currency1: r.currency1!,
        fee: r.fee!, tickSpacing: r.tick_spacing!, hooks: r.hooks!,
      };
      /* THE KEY IS CHECKED, for the reason launchbot.ts records: a wrong key addresses
       * a pool that does not exist, the call reverts, and a revert here would be read
       * as a honeypot. A mismatch VOIDS the row rather than becoming a finding. */
      if (poolIdOf(pool).toLowerCase() !== r.pool_id.toLowerCase()) {
        log.warn('pool key does not reproduce the stored id — row VOID', {
          pool: r.pool_id });
        continue;
      }

      const entryHex = `0x${BigInt(r.entry_block).toString(16)}`;
      const liq = await readPoolLiquidity(rpc, r.pool_id, entryHex);

      let executes: boolean | null = null;
      let reason = 'not run';
      let ethOut: bigint | null = null;
      try {
        const sim = await simulateSellAt(rpc, {
          pool, token: r.token, owner, amount: BigInt(r.tokens_out!),
          zeroForOneBuy: !tokenIsC0, block: entryHex,
        });
        executes = sim.executes; reason = sim.executeReason; ethOut = sim.ethOut;
      } catch (e) { reason = `probe failed: ${(e as Error).message.slice(0, 90)}`; }

      const ethIn = BigInt(r.amount_in_wei);
      /*
       * **A SELL THAT DOES NOT EXECUTE IS -100%, AND A SELL THAT COULD NOT BE PROBED
       * IS EXCLUDED RATHER THAN SCORED.** Those are different: the first is a
       * measurement, the second is an absence of one, and folding an unreadable probe
       * into -100% would manufacture losses the chain never showed.
       */
      const ret = executes === true && ethOut !== null
        ? Number(ethOut - ethIn) / Number(ethIn)
        : executes === false ? -1 : Number.NaN;

      const bb = bundle.get(r.pool_id);
      scored.push({
        window: r.window_name, pool: r.pool_id, token: r.token,
        launchpad: null, liqAtEntry: liq, sellExecutes: executes, sellReason: reason,
        ethIn, ethOut, ret,
        launchBuyers: bb?.launchBuyers ?? null, preEntryBuyers: bb?.preEntryBuyers ?? null,
      });
      done += 1;
      if (done % 100 === 0) log.info('progress', { done, of: bought.length });
    }

    /* ---- THE LAUNCHPAD, one transaction read per distinct creating tx ----- */
    const txs = [...new Set(bought.map((r) => r.tx_hash).filter((x): x is string => x !== null))];
    const padByTx = new Map<string, string>();
    for (const t of txs) {
      try {
        const tx = (await rpc.call('eth_getTransactionByHash', [t])) as { to?: string | null };
        if (tx?.to) padByTx.set(t, tx.to.toLowerCase());
      } catch { /* an unreadable launchpad stays null rather than becoming a guess */ }
    }
    for (const s of scored) {
      const row = bought.find((b) => b.pool_id === s.pool);
      s.launchpad = row?.tx_hash ? (padByTx.get(row.tx_hash) ?? null) : null;
    }

    /* ---- REPORT ----------------------------------------------------------- */
    const usable = scored.filter((s) => !Number.isNaN(s.ret));
    const unprobed = scored.length - usable.length;

    const report = (name: string, set: Scored[]): Record<string, unknown> => {
      const rets = set.map((s) => s.ret);
      const dead = set.filter((s) => s.sellExecutes === false).length;
      return {
        launches: set.length,
        could_NOT_be_sold: dead,
        could_not_be_sold_share: set.length === 0 ? 'n/a' : pct(dead / set.length),
        median_return: median(rets) === null ? null : pct(median(rets)!),
        /* Gas is charged against the MEDIAN, not the mean, and stated separately so
         * the gross and the net are both visible. */
        median_return_net_of_gas_at_this_size: median(rets) === null ? null
          : pct(median(rets)! - 0.0193),
      };
    };

    log.info('3C  THE WHOLE CORPUS, SELL RE-MEASURED WITH A REACHABLE BOUND', {
      size_usd: sizeArg,
      scored: scored.length,
      probe_unreadable_EXCLUDED: unprobed,
      ...report('all', usable),
      by_window: Object.fromEntries(['MIDPOINT', 'CALM', 'SELLOFF'].map((w) =>
        [w, report(w, usable.filter((s) => s.window === w))])),
      gas_assumption: 'a 10-leg round trip measured at ~1.93% of a $10 position; '
        + 'stated rather than folded in silently',
    });

    /* ---- EACH FILTER, IN TURN --------------------------------------------- */
    const filters: Array<{ name: string; keep: (s: Scored) => boolean }> = [
      { name: 'A. liquidity > 0 at the entry block (the Fly failure)',
        keep: (s) => s.liqAtEntry !== null && s.liqAtEntry > 0n },
      { name: 'B. the sell EXECUTES at the entry block (the firewall / round trip)',
        keep: (s) => s.sellExecutes === true },
      { name: 'C. A and B together',
        keep: (s) => s.liqAtEntry !== null && s.liqAtEntry > 0n && s.sellExecutes === true },
      { name: 'D. at least 2 distinct senders before our entry (minUniqueBuyers)',
        keep: (s) => (s.preEntryBuyers ?? 0) >= 2 },
      { name: 'E. NOT bundled: fewer than 3 senders in the launch block',
        keep: (s) => (s.launchBuyers ?? 0) < 3 },
      { name: 'F. launchpad 0x58daec… (the live launchpad)',
        keep: (s) => s.launchpad === '0x58daec3116aae6d93017baaea7749052e8a04fa7' },
      { name: 'G. created DIRECTLY on the PoolManager, no launchpad',
        keep: (s) => s.launchpad === '0x8366a39cc670b4001a1121b8f6a443a643e40951' },
    ];
    for (const f of filters) {
      const kept = usable.filter(f.keep);
      log.info(`3C FILTER — ${f.name}`, {
        of: usable.length,
        survives: kept.length,
        disqualifies: usable.length - kept.length,
        disqualifies_share: usable.length === 0 ? 'n/a'
          : pct((usable.length - kept.length) / usable.length),
        ...report(f.name, kept),
      });
    }

    /* A SAMPLE, DECODED, because an aggregate is a hypothesis. */
    log.info('TEN INDIVIDUAL LAUNCHES, OPENABLE', {
      rows: usable.slice(0, 10).map((s) =>
        `${s.window} ${s.pool.slice(0, 14)} token=${s.token.slice(0, 12)} `
        + `liq=${s.liqAtEntry === null ? 'UNREADABLE' : s.liqAtEntry.toString()} `
        + `sells=${String(s.sellExecutes)} ret=${pct(s.ret)} `
        + `pad=${s.launchpad ?? 'unknown'} why=${s.sellReason.slice(0, 50)}`),
    });
    log.info('CU SPENT', { cu: inner.cuSpent, ceiling: CU_CEILING });
  } finally {
    c.release(); await app.pool.end();
  }
}

void main().catch((e: unknown) => { log.error('filter-measure failed', errorFields(e)); process.exit(1); });

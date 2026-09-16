/**
 * `npm run exit-horizon -- --half search|holdout [--windows a:b,c:d]`
 *
 * WHAT EXIT HORIZON IS BEST, tested against the pre-committed holdout.
 *
 * Both dry runs showed +30 s — the implemented `EXIT_DELAY_BLOCKS` — as the WORST of
 * four horizons, with longer monotonically better. That is 36 launches from one
 * afternoon and is not evidence. This sweeps a ten-point grid out to +600 s on the
 * SEARCH half only; whatever survives is tested ONCE on the holdout.
 *
 * READ-ONLY, zero CU. Everything comes from `v4_swaps_all` and `v4_pool_init`.
 *
 * THE SPLIT IS `bot/holdout.ts` AND IS NOT RE-IMPLEMENTED HERE. The same predicate that
 * `launch-search.ts` fixed before any hypothesis was formed.
 *
 * WHAT THIS HOLDOUT DOES AND DOES NOT PROVE, per `bot/holdout.ts`: it proves an effect
 * is not an artefact of which pools were looked at. It proves nothing about a later era.
 * `ROBINHOOD.md` records that both corpus halves come from the same 32 days and that the
 * rule they established decayed by half within ten days of the corpus ceiling.
 *
 * ---------------------------------------------------------------------------
 * THE THREE THINGS THAT WOULD MAKE THIS GRID LIE, AND WHAT IS DONE ABOUT EACH
 * ---------------------------------------------------------------------------
 *
 * 1. **A LONGER HORIZON HAS MORE CHANCE TO FIND A FILL.** Exit at +600 s can use any
 *    trade in ten minutes; exit at +15 s can use only trades in fifteen seconds. If
 *    "no exit found" is scored as zero, the long horizons win partly by being given
 *    more opportunities rather than better prices. **Exit-availability is therefore
 *    reported PER HORIZON beside every median**, and the conditional median is reported
 *    beside the unconditional one. A reader who sees only the medians is being misled
 *    and the columns exist to stop that.
 *
 * 2. **CENSORING AT THE WINDOW EDGE.** A launch near the end of a swept window has no
 *    data for its own +600 s. Including it would score the long horizons as "no exit"
 *    for a reason that is about our collection, not the market. **Every launch must
 *    have its FULL longest horizon inside the swept range** — `first_swap + entry_delay
 *    + max_horizon <= window_to` — and the count excluded for this is reported.
 *
 * 3. **MARK-TO-MARK PRICES THAT NOBODY COULD TRADE AT.** `ROBINHOOD.md` records a
 *    decile-1 launch whose "price" was a ladder of nine swaps inside ONE block with
 *    ascending log_index. Entry and exit are therefore the first trade STRICTLY AFTER
 *    the mark, never the last trade at or before it.
 *
 * The denominator is EVERY rule launch in the half. No-fill is scored zero and counted,
 * never dropped — that is the survivorship rule that produced a +18.2% median once.
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { halfPredicate, isHalf } from '../bot/holdout.js';
import { ALLOWED_FEES, ENTRY_DELAY_BLOCKS, GAP_MAX_BLOCKS, GAP_MIN_BLOCKS } from '../bot/config.js';

const PRICING = [
  '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
  '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
  '0x0000000000000000000000000000000000000000',
];
const BLOCKS_PER_SECOND = 10;

/** Out to +600 s, as required. Seconds after the ENTRY moment. */
const HORIZONS_S = [15, 30, 45, 60, 90, 120, 180, 300, 450, 600] as const;
const MAX_HORIZON_BLOCKS = Math.max(...HORIZONS_S) * BLOCKS_PER_SECOND;
/*
 * SLACK BEYOND THE LONGEST HORIZON, SO THE LONGEST HORIZON CAN ACTUALLY FILL.
 *
 * The first run of this grid loaded ticks only to +600 s and then asked the +600 s
 * horizon for a trade strictly AFTER +600 s. There is none by construction, so the cell
 * reported `exit_found: 0` and a median of exactly 0.00000 — a boundary presented as a
 * market result. `ROBINHOOD.md` records the identical shape in `surv_1h`, which read
 * 0.02% everywhere because its swap window was capped and it "measured a boundary
 * rather than survival".
 *
 * 3,000 blocks = 300 s. NOT picked: the median exit fill lands 1.1–3.7 s past its mark
 * across every horizon measured in that first run, so this is roughly 80x the observed
 * median delay. Exits that still do not fill inside it are counted and reported rather
 * than being silently scored as no-exit.
 */
const FILL_SLACK_BLOCKS = 3000;
const TICK_HORIZON_BLOCKS = MAX_HORIZON_BLOCKS + FILL_SLACK_BLOCKS;

/** The four swept windows. `v4_swaps_all` covers all of them. */
const WINDOWS: Array<[string, number, number]> = [
  ['HOLDOUT-ERA', 15115267, 42695454],
  ['MIDPOINT', 52200000, 53200000],
  ['CALM', 60700000, 61700000],
  ['SELLOFF', 63216393, 64216393],
];

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const hi = args.indexOf('--half');
  const half = hi >= 0 ? String(args[hi + 1]) : 'search';
  if (!isHalf(half)) throw new Error(`--half must be search|holdout|all, got "${half}"`);

  const wi = args.indexOf('--windows');
  const windows = wi >= 0
    ? String(args[wi + 1]).split(',').map((w) => {
      const [a, b] = w.split(':');
      return [`${a}:${b}`, Number(a), Number(b)] as [string, number, number];
    })
    : WINDOWS;

  const app = await bootstrap();
  const c = await app.pool.connect();
  try {
    await c.query('set statement_timeout = 0');

    /*
     * MATERIALISED INTO INDEXED TEMP TABLES. `ROBINHOOD.md` records three separate
     * queries of this shape hanging for 19, 17 and 10 minutes because the planner has
     * no statistics for a CTE and no index across it.
     */
    await c.query(`create temp table launches (
      win text, pool_id text primary key, fee bigint, token_is_c0 boolean,
      first_swap bigint, entry_block bigint)`);

    const perWindow: Array<Record<string, unknown>> = [];
    for (const [label, from, to] of windows) {
      /* Every launch must carry its FULL longest horizon inside the swept range. */
      const usableTo = to - ENTRY_DELAY_BLOCKS - TICK_HORIZON_BLOCKS;
      const all = await c.query<{ n: string }>(
        `select count(*)::text n from v4_pool_init i
          join lateral (select min(block_number) fb from v4_swaps_all s
                         where s.pool_id = i.pool_id
                           and s.block_number between $2 and $3) f on true
         where i.block_number between $2 and $3
           and i.fee = any($4)
           and ((i.currency0 = any($1)) <> (i.currency1 = any($1)))
           and f.fb is not null
           and (f.fb - i.block_number) between ${GAP_MIN_BLOCKS} and ${GAP_MAX_BLOCKS}`,
        [PRICING, from, to, ALLOWED_FEES]);

      const ins = await c.query(
        `insert into launches
         select $5, i.pool_id, i.fee,
                (i.currency1 = any($1)) as token_is_c0,
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

      perWindow.push({
        window: label,
        rule_launches_in_window_both_halves: Number(all.rows[0]!.n),
        kept_in_this_half_and_fully_observable: ins.rowCount,
        usable_to: usableTo,
        censored_note: `launches with first_swap > ${usableTo} are EXCLUDED: their `
          + `+${Math.max(...HORIZONS_S)}s exit plus ${FILL_SLACK_BLOCKS / BLOCKS_PER_SECOND}s `
          + 'of fill slack falls outside the swept range',
      });
    }
    await c.query('analyze launches');

    const total = await c.query<{ n: string }>('select count(*)::text n from launches');
    log.info('EXIT HORIZON GRID — population', {
      half,
      split: 'md5(pool_id) first hex char; 0-7 search, 8-f holdout (bot/holdout.ts)',
      horizons_s: HORIZONS_S,
      entry_delay_blocks: ENTRY_DELAY_BLOCKS,
      fill_slack_s: FILL_SLACK_BLOCKS / BLOCKS_PER_SECOND,
      fee_allow_list: ALLOWED_FEES,
      gap_blocks: [GAP_MIN_BLOCKS, GAP_MAX_BLOCKS],
      per_window: perWindow,
      launches_total: Number(total.rows[0]!.n),
    });
    if (Number(total.rows[0]!.n) === 0) {
      throw new Error('the launch set is EMPTY. A population matching nothing is a '
        + 'suspected defect, not a clean pass.');
    }

    /*
     * Every swap from each launch's ENTRY onward, to the longest horizon. Price is
     * PRICING PER TOKEN — the convention every figure in both documents uses.
     * Absolute values make it independent of the sign convention.
     */
    await c.query(`create temp table ticks as
      select l.pool_id,
             (s.block_number - l.entry_block)::bigint off,
             s.log_index,
             case when l.token_is_c0
                  then abs(s.amount1)::double precision / abs(s.amount0)
                  else abs(s.amount0)::double precision / abs(s.amount1) end as px
        from launches l
        join v4_swaps_all s on s.pool_id = l.pool_id
       where s.block_number > l.entry_block
         and s.block_number <= l.entry_block + ${TICK_HORIZON_BLOCKS}
         and s.amount0 <> 0 and s.amount1 <> 0`);
    await c.query('create index on ticks (pool_id, off, log_index); analyze ticks');

    /*
     * ENTRY: the FIRST trade strictly after the entry mark. Not the last trade at or
     * before it — that is the intra-block ladder ROBINHOOD.md records.
     */
    await c.query(`create temp table entries as
      select distinct on (pool_id) pool_id, off as entry_off, px as entry_px
        from ticks order by pool_id, off asc, log_index asc`);
    await c.query('alter table entries add primary key (pool_id); analyze entries');

    const filled = await c.query<{ n: string }>('select count(*)::text n from entries');
    const nAll = Number(total.rows[0]!.n);
    const nFilled = Number(filled.rows[0]!.n);

    const rows: Array<Record<string, unknown>> = [];
    for (const h of HORIZONS_S) {
      const mark = h * BLOCKS_PER_SECOND;
      /*
       * The exit SEARCH ceiling. The mark says when we want out; the fill is whatever
       * trades next, which can be later. Capping the search at the mark would score a
       * pool with no trade in that exact instant as "no exit" when the bot would simply
       * have sold on the next trade. The ceiling is the observable range, which every
       * launch is guaranteed to carry by the censoring rule above.
       */
      const mark2 = TICK_HORIZON_BLOCKS;
      const r = await c.query<{
        exits: string; med_uncond: string | null; med_cond: string | null;
        pos: string; p25: string | null; p75: string | null; worst: string | null;
        fill_delay: string | null;
      }>(
        /*
         * THE EXIT IS STRICTLY AFTER BOTH THE HORIZON MARK AND THE ENTRY FILL.
         * `greatest` is not decoration: where a pool is quiet the entry can fill LATER
         * than an early horizon mark, and a plain `off > mark` would then re-select the
         * entry tick itself and report a return of exactly 0 for a trade that never
         * happened. That would look like an ordinary flat result rather than a defect.
         */
        `with x as (
           select distinct on (t.pool_id) t.pool_id, t.px as exit_px, t.off as exit_off
             from ticks t join entries e on e.pool_id = t.pool_id
            where t.off > greatest(${mark}, e.entry_off) and t.off <= ${mark2}
            order by t.pool_id, t.off asc, t.log_index asc
         ), r as (
           /* EVERY launch in the half. A launch that never filled, or that filled and
              found no exit trade by this horizon, contributes 0 -- counted, not dropped. */
           select l.pool_id,
                  case when e.pool_id is null or x.pool_id is null then 0
                       else x.exit_px / e.entry_px - 1 end as ret,
                  (x.pool_id is not null) as exited,
                  x.exit_off - ${mark} as fill_delay
             from launches l
             left join entries e on e.pool_id = l.pool_id
             left join x on x.pool_id = l.pool_id
         )
         select count(*) filter (where exited)::text exits,
                percentile_cont(0.5) within group (order by ret)::text med_uncond,
                percentile_cont(0.5) within group (order by ret)
                  filter (where exited)::text med_cond,
                count(*) filter (where ret > 0)::text pos,
                percentile_cont(0.25) within group (order by ret)::text p25,
                percentile_cont(0.75) within group (order by ret)::text p75,
                min(ret)::text worst,
                percentile_cont(0.5) within group (order by fill_delay)
                  filter (where exited)::text fill_delay
           from r`,
        []);
      const q = r.rows[0]!;
      rows.push({
        horizon_s: h,
        launches: nAll,
        entry_filled: nFilled,
        exit_found: Number(q.exits),
        exit_found_pct: ((Number(q.exits) / nAll) * 100).toFixed(1),
        median_all: Number(q.med_uncond ?? 0).toFixed(5),
        median_given_exit: q.med_cond === null ? 'RETURNED NO ROWS' : Number(q.med_cond).toFixed(5),
        pct_positive: ((Number(q.pos) / nAll) * 100).toFixed(1),
        p25: Number(q.p25 ?? 0).toFixed(5),
        p75: Number(q.p75 ?? 0).toFixed(5),
        worst: Number(q.worst ?? 0).toFixed(5),
        /* How far past its own mark the exit actually filled, in seconds. A horizon
         * whose fills land far beyond it is not really that horizon. */
        median_fill_delay_s: q.fill_delay === null
          ? 'RETURNED NO ROWS' : (Number(q.fill_delay) / BLOCKS_PER_SECOND).toFixed(1),
      });
    }

    log.info('EXIT HORIZON GRID — results', {
      half,
      note: 'median_all scores no-fill and no-exit as 0 over EVERY launch. '
        + 'exit_found_pct rises with the horizon by construction — a longer horizon has '
        + 'more trades to choose from — so the two columns must be read together.',
      grid: rows,
    });

    /* The best cell on the unconditional median, which is the one a bot actually gets. */
    const best = [...rows].sort((a, b) =>
      Number(b['median_all']) - Number(a['median_all']))[0]!;
    const configured = rows.find((x) => x['horizon_s'] === 30)!;
    log.info('BEST CELL vs THE CONFIGURED ONE', {
      half,
      configured_horizon_s: 30,
      configured_median_all: configured['median_all'],
      best_horizon_s: best['horizon_s'],
      best_median_all: best['median_all'],
      margin: (Number(best['median_all']) - Number(configured['median_all'])).toFixed(5),
    });
  } finally {
    c.release();
  }
  await app.pool.end();
  process.exit(0);
}

main().catch((err) => { log.error('exit-horizon failed', errorFields(err)); process.exit(1); });

/**
 * `npm run filter-join` — 3C's HEADLINE NUMBER, COMPUTED WITHOUT CIRCULARITY.
 *
 * ===========================================================================
 * WHY THIS EXISTS: THE FIRST VERSION OF THE FILTER TABLE WAS CIRCULAR
 * ===========================================================================
 *
 * `filter-measure --at exit` reported *"filter B — the sell executes: survives 769,
 * median +40.27%, could not be sold 0.00%"*. **That number is survivorship, not a
 * filter result, and reporting it would have repeated the exact defect Part 1 was
 * written to kill.**
 *
 * The reason: in the `--at exit` run, `sell_executes` IS the exit-block executability.
 * So "filter on sell_executes" selects the launches that could be sold and then reports
 * their return — necessarily excluding every −100%. It is the no-exit-scored-as-absent
 * error wearing a filter's label.
 *
 * A filter has to be evaluated on information available **BEFORE the buy**, and the
 * outcome has to be measured **AFTER the hold**. So this joins the two stored points:
 *
 *     FILTER   from at_point = 'entry'  — liquidity, sellability, buyers, launchpad
 *     OUTCOME  from at_point = 'exit'   — the return 90 seconds later
 *
 * and a launch that cannot be sold at the exit is **−100%**, never dropped.
 *
 * **WHAT WOULD PROVE THIS WRONG:** a filter whose survivor count equals its
 * "could not be sold = 0" count, which is the signature of the circularity above
 * reappearing. Both columns are printed side by side so it cannot hide.
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';

const SQL = `
with j as (
  select en.pool_id, en.window_name, en.launchpad,
         en.liq_at_entry, en.sell_executes as sellable_at_entry,
         en.pre_entry_buyers, en.launch_buyers,
         ex.sell_executes as sellable_at_exit,
         case when ex.sell_executes then (ex.eth_out - ex.eth_in) / ex.eth_in
              when ex.sell_executes = false then -1 end as ret
    from bot_filter_measure en
    join bot_filter_measure ex
      on ex.chain = en.chain and ex.size_usd = en.size_usd
     and ex.pool_id = en.pool_id and ex.at_point = 'exit'
   where en.at_point = 'entry' and en.size_usd = $1::numeric
)
select $2::text as filter_name,
       count(*)::int as n,
       count(*) filter (where sellable_at_exit = false)::int as dead,
       round((100 * percentile_cont(0.5) within group (order by ret))::numeric, 2) as med,
       round((100 * percentile_cont(0.25) within group (order by ret))::numeric, 2) as p25,
       round((100 * percentile_cont(0.75) within group (order by ret))::numeric, 2) as p75,
       count(*) filter (where ret > 0.0193)::int as beat_gas
  from j where ret is not null and (CLAUSE)`;

/** ~1.93% of a $10 position for a 10-leg round trip, measured, not assumed. */
const GAS_PCT = 1.93;

const FILTERS: Array<[string, string]> = [
  ['ALL — no filter', 'true'],
  ['A  liquidity > 0 at entry', 'liq_at_entry > 0'],
  ['B  sell EXECUTES at entry (firewall)', 'sellable_at_entry'],
  ['D  >= 2 distinct buyers before entry', 'pre_entry_buyers >= 2'],
  ['E  < 3 senders in the launch block', 'launch_buyers < 3'],
  ['F  launchpad 0x58daec (the live one)', "launchpad = '0x58daec3116aae6d93017baaea7749052e8a04fa7'"],
  ['G  created direct on the PoolManager', "launchpad = '0x8366a39cc670b4001a1121b8f6a443a643e40951'"],
  ['B + D', 'sellable_at_entry and pre_entry_buyers >= 2'],
  ['B + G', "sellable_at_entry and launchpad = '0x8366a39cc670b4001a1121b8f6a443a643e40951'"],
  ['B + D + G', "sellable_at_entry and pre_entry_buyers >= 2 and launchpad = '0x8366a39cc670b4001a1121b8f6a443a643e40951'"],
];

async function main(): Promise<void> {
  const app = await bootstrap();
  const c = await app.pool.connect();
  try {
    const out: string[] = [];
    out.push('filter                                  n   dead  dead%   p25     median   p75    net    >gas');
    for (const [name, clause] of FILTERS) {
      const r = (await c.query<{
        n: number; dead: number; med: string | null; p25: string | null;
        p75: string | null; beat_gas: number;
      }>(SQL.replace('(CLAUSE)', `(${clause})`), ['10', name])).rows[0]!;
      if (r.n === 0) {
        out.push(`${name.padEnd(38)} RETURNED NO ROWS — the filter matched nothing`);
        continue;
      }
      const med = Number(r.med);
      out.push(
        `${name.padEnd(38)} ${String(r.n).padStart(4)} ${String(r.dead).padStart(5)} `
        + `${(100 * r.dead / r.n).toFixed(1).padStart(5)}% `
        + `${Number(r.p25).toFixed(1).padStart(7)}% ${med.toFixed(2).padStart(7)}% `
        + `${Number(r.p75).toFixed(1).padStart(7)}% `
        + `${(med - GAS_PCT).toFixed(2).padStart(7)}% `
        + `${(100 * r.beat_gas / r.n).toFixed(0).padStart(4)}%`);
    }

    /* THE WINDOWS' OWN DATES, because whether the corpus describes TODAY is the
     * single biggest caveat on every figure above. */
    const win = (await c.query<{ window_name: string; n: string; lo: string; hi: string }>(
      `select e.window_name, count(*)::text n,
              min(e.first_swap)::text lo, max(e.first_swap)::text hi
         from bot_exit_sim e where e.size_usd::numeric = 10
        group by 1 order by 3`)).rows;

    log.info('3C  EVERY FILTER — EVALUATED ON PRE-BUY INFORMATION, SCORED AFTER THE HOLD', {
      method: 'FILTER from at_point=entry, OUTCOME from at_point=exit, no-exit = -100%',
      gas_pct_subtracted_in_the_net_column: GAS_PCT,
      '>gas': 'share of launches whose own return beat gas — not the median',
      table: out,
      circularity_check: 'a filter whose dead count is 0 while ALL has 196 is measuring '
        + 'its own outcome; both columns are printed so it cannot hide',
    });
    log.info('WHAT PERIOD THE CORPUS ACTUALLY DESCRIBES', {
      note: 'THE BIGGEST CAVEAT ON EVERY FIGURE ABOVE. ROBINHOOD.md section 8 measured '
        + 'the dominant launchpad decaying five-fold across these windows and the '
        + 'population shifting away from it. A median from these windows is not a '
        + 'prediction about launches happening now.',
      windows: win.map((w) => `${w.window_name} n=${w.n} first_swap ${w.lo}..${w.hi}`),
    });
  } finally { c.release(); await app.pool.end(); }
}

void main().catch((e: unknown) => { log.error('filter-join failed', errorFields(e)); process.exit(1); });

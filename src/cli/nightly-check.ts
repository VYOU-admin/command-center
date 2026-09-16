/**
 * `npm run nightly-check -- [--commit]`
 *
 * THE NIGHTLY SELF-CHECK, MADE ADAPTIVE — AS A RECOMMENDATION, NEVER AS AN EDIT.
 *
 * For every trade the bot took, it backfills the price at EVERY horizon in the grid and
 * reports which horizon would have been best. When a different horizon beats the
 * configured one by a material margin over a sufficient sample, it ALERTS with the
 * evidence.
 *
 * **IT DOES NOT AND MUST NOT CHANGE `EXIT_DELAY_BLOCKS`.** A rule that rewrites its own
 * parameters will eventually chase noise into a bad regime with nobody able to say when
 * it changed, and this project's own history is the argument: the fee-tier rule was
 * measured at +0.298, decayed to +0.145 within ten days, and NOTHING about the data
 * announced that the regime had moved. A bot that had been re-fitting itself nightly
 * would have followed that decay down without a single line in any log saying so. The
 * alert is the output; a human flips the constant.
 *
 * ------------------------------------------------------------------
 * THE TWO THRESHOLDS, BOTH DERIVED FROM THE 2026-09-16 HOLDOUT STUDY
 * ------------------------------------------------------------------
 *
 * **MINIMUM SAMPLE — 140 trades.** The offline grid ran on both halves of the
 * pre-committed split at several sample sizes. The two halves AGREED on the direction
 * (a longer horizon beats +30 s) in 6 of 6 window×half combinations, and the smallest
 * per-window sample where they still agreed was the CALM window at **144 search / 141
 * holdout**. Below that the halves start disagreeing about which horizon wins. 140 is
 * that floor. **At `MAX_TRADES_PER_DAY = 40` a single day can never reach it**, so the
 * check accumulates over a trailing window and says how many days it is drawing on —
 * a nightly check that could never satisfy its own threshold would alert on noise
 * forever or never alert at all.
 *
 * **MARGIN — 0.25 of median return.** Two independent halves measuring the SAME
 * quantity at that sample size differed by as much as **0.247** (CALM, +180 s, n=141
 * vs 144: 0.339 against 0.092). That is the measurement's own noise floor at this
 * sample size, so a margin below it would be firing on disagreement that two halves of
 * one dataset already produce by themselves. 0.25 is that figure rounded up.
 *
 * Both are deliberately conservative. A check that cries wolf is a check that gets
 * ignored, and `ROBINHOOD.md` records the same reasoning for why an empty period sends
 * nothing.
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { RpcClient } from '../adapters/token-updates/rpc.js';
import { BOT_SCHEMA } from '../bot/state.js';
import { EXIT_DELAY_BLOCKS, ENTRY_DELAY_BLOCKS, POOL_MANAGER } from '../bot/config.js';
import { TOPICS } from '../adapters/token-updates/decode.js';
import { swapAmounts, tokenPrice } from '../bot/price.js';

const RPC_URL = 'https://robinhood-mainnet.g.alchemy.com/v2/{key}';
const BLOCKS_PER_SECOND = 10;
const GETLOGS_CU = 60;

/** The grid. The configured horizon must be in it or the comparison is meaningless. */
const HORIZONS_S = [15, 30, 45, 60, 90, 120, 180, 300, 450, 600] as const;
const CONFIGURED_S = EXIT_DELAY_BLOCKS / BLOCKS_PER_SECOND;

/** DERIVED — see the header. Not tunable without re-deriving them. */
const MIN_SAMPLE = 140;
const MARGIN = 0.25;

export const HORIZON_SCHEMA = `
create table if not exists bot_horizon_prices (
  chain      text not null,
  trade_id   bigint not null,
  horizon_s  integer not null,
  px         numeric,
  filled     boolean not null,
  read_at    timestamptz not null default now(),
  primary key (chain, trade_id, horizon_s)
);
`;

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) / 2;
  return s.length % 2 ? s[i]! : (s[Math.floor(i)]! + s[Math.ceil(i)]!) / 2;
}

async function main(): Promise<void> {
  const commit = process.argv.includes('--commit');
  const di = process.argv.indexOf('--days');
  const days = di >= 0 ? Number(process.argv[di + 1]) : 30;

  const app = await bootstrap();
  const c = await app.pool.connect();
  let alerted = false;
  try {
    await c.query(BOT_SCHEMA);
    await c.query(HORIZON_SCHEMA);

    /* Trades whose FULL longest horizon has elapsed. A trade whose +600 s has not
     * happened yet is not yet evidence, and scoring it as a no-exit would be the
     * censoring defect the offline grid had to fix. */
    const key = process.env['ALCHEMY_API_KEY'];
    if (!key) throw new Error('ALCHEMY_API_KEY is not set');
    const probe = new RpcClient(RPC_URL.replace('{key}', key), 60000, 1000);
    const head = Number(BigInt(String(await probe.raw('eth_blockNumber', []))));
    const maxH = Math.max(...HORIZONS_S) * BLOCKS_PER_SECOND;

    const todo = await c.query<{
      id: string; pool_id: string; token: string; counter: string;
      first_swap_block: string; px_entry: string | null;
    }>(
      `select b.id::text, b.pool_id, b.token, b.counter, b.first_swap_block::text,
              b.px_entry::text
         from bot_trades b
        where b.chain='robinhood' and b.px_entry is not null
          and b.first_swap_block is not null
          and b.created_at >= now() - ($1::int * interval '1 day')
          and b.first_swap_block + ${ENTRY_DELAY_BLOCKS} + ${maxH} <= $2
          and not exists (select 1 from bot_horizon_prices h
                           where h.chain='robinhood' and h.trade_id = b.id
                             and h.horizon_s = ${Math.max(...HORIZONS_S)})
        order by b.created_at`, [days, head]);

    const n = todo.rowCount ?? 0;
    log.info('NIGHTLY CHECK WORK SET', {
      trailing_days: days, head,
      trades_needing_backfill: n,
      estimate: { cu: n * GETLOGS_CU, usd: ((n * GETLOGS_CU * 0.45) / 1e6).toFixed(5) },
      horizons_s: HORIZONS_S, configured_horizon_s: CONFIGURED_S,
      min_sample: MIN_SAMPLE, margin: MARGIN, commit,
    });
    if (!commit) {
      log.info('DRY RUN — nothing read, nothing written', { note: 'pass --commit' });
      c.release(); await app.pool.end(); process.exit(0);
    }

    /* ---- backfill every horizon, one filtered eth_getLogs per trade ---- */
    const rpc = new RpcClient(RPC_URL.replace('{key}', key), 120000,
      Math.max(10000, Math.ceil(n * GETLOGS_CU * 1.5)));
    let filledTrades = 0; let noSwaps = 0; let failed = 0;
    for (const t of todo.rows) {
      const entry = Number(t.first_swap_block) + ENTRY_DELAY_BLOCKS;
      try {
        const logs = (await rpc.raw('eth_getLogs', [{
          address: POOL_MANAGER, topics: [TOPICS.swapV4, t.pool_id],
          fromBlock: `0x${entry.toString(16)}`,
          toBlock: `0x${(entry + maxH + 3000).toString(16)}`,
        }])) as Array<{ blockNumber: string; data: string; logIndex: string }>;
        const tokenIsC0 = t.token.toLowerCase() < t.counter.toLowerCase();
        const ticks = logs.map((l) => {
          const a = swapAmounts(l.data);
          if (!a) return null;
          return { off: Number(BigInt(l.blockNumber)) - entry, px: tokenPrice(a, tokenIsC0) };
        }).filter((x): x is { off: number; px: number } => x !== null && x.px > 0);
        if (ticks.length === 0) { noSwaps += 1; }
        for (const h of HORIZONS_S) {
          /* THE FIRST TRADE STRICTLY AFTER THE MARK — the same convention as the
           * offline grid, so the two are comparable. A last-trade-at-or-before mark
           * would be the intra-block ladder ROBINHOOD.md records. */
          const after = ticks.find((x) => x.off > h * BLOCKS_PER_SECOND);
          await c.query(
            `insert into bot_horizon_prices (chain,trade_id,horizon_s,px,filled)
             values ('robinhood',$1,$2,$3,$4)
             on conflict (chain,trade_id,horizon_s) do update
               set px = excluded.px, filled = excluded.filled, read_at = now()`,
            [t.id, h, after ? after.px : null, after !== undefined]);
        }
        if (ticks.length > 0) filledTrades += 1;
      } catch (err) {
        /* A READ THAT FAILS IS COUNTED AND LEFT ABSENT. Never a zero price. */
        failed += 1;
        log.warn('horizon backfill failed', { trade: t.id,
          error: (err as Error).message.slice(0, 140) });
      }
    }
    log.info('BACKFILL COMPLETE', {
      attempted: n, trades_with_ticks: filledTrades, pool_had_no_swaps: noSwaps,
      read_failed: failed, cu_spent: rpc.cuSpent ?? 'unknown',
    });

    /* ---- the comparison, over EVERY trade in the window ---- */
    const pop = await c.query<{ id: string; px_entry: string }>(
      `select id::text, px_entry::text from bot_trades
        where chain='robinhood' and px_entry is not null
          and created_at >= now() - ($1::int * interval '1 day')
          and exists (select 1 from bot_horizon_prices h
                       where h.chain='robinhood' and h.trade_id = id)`, [days]);
    const sample = pop.rowCount ?? 0;

    const grid: Array<Record<string, unknown>> = [];
    for (const h of HORIZONS_S) {
      const rs = await c.query<{ ret: string | null; filled: boolean }>(
        `select case when h.filled and h.px is not null and b.px_entry > 0
                     then (h.px / b.px_entry - 1)::text else null end ret,
                h.filled
           from bot_horizon_prices h
           join bot_trades b on b.id = h.trade_id and b.chain = h.chain
          where h.chain='robinhood' and h.horizon_s = $1
            and b.created_at >= now() - ($2::int * interval '1 day')`, [h, days]);
      /* NO-EXIT SCORES ZERO AND IS COUNTED — the survivorship rule. */
      const rets = rs.rows.map((x) => (x.ret === null ? 0 : Number(x.ret)));
      grid.push({
        horizon_s: h, n: rets.length,
        exit_found: rs.rows.filter((x) => x.filled).length,
        median_all: median(rets).toFixed(5),
        pct_positive: rets.length
          ? ((rets.filter((x) => x > 0).length / rets.length) * 100).toFixed(1) : '0.0',
      });
    }

    const conf = grid.find((g) => g['horizon_s'] === CONFIGURED_S);
    const best = [...grid].sort((a, b) =>
      Number(b['median_all']) - Number(a['median_all']))[0]!;
    const margin = conf ? Number(best['median_all']) - Number(conf['median_all']) : 0;
    const enough = sample >= MIN_SAMPLE;
    const material = margin >= MARGIN;

    log.info('HORIZON RECOMMENDATION', {
      sample, min_sample: MIN_SAMPLE, sample_sufficient: enough,
      configured_horizon_s: CONFIGURED_S,
      configured_median: conf?.['median_all'] ?? 'CONFIGURED HORIZON NOT IN THE GRID',
      best_horizon_s: best['horizon_s'], best_median: best['median_all'],
      margin: margin.toFixed(5), margin_threshold: MARGIN, margin_material: material,
      would_alert: enough && material && best['horizon_s'] !== CONFIGURED_S,
      grid,
      note: 'THIS CHANGES NOTHING. EXIT_DELAY_BLOCKS is a constant in config.ts and is '
        + 'flipped by a human, never by this job.',
    });

    if (enough && material && best['horizon_s'] !== CONFIGURED_S) {
      /* The sink bootstrap already built — a second one would resolve channels twice. */
      const sent = await app.discord.send({
        level: 'info',
        title: `Exit horizon: +${best['horizon_s']}s beats the configured +${CONFIGURED_S}s`,
        description: 'RECOMMENDATION ONLY — nothing has been changed. '
          + '`EXIT_DELAY_BLOCKS` is a hard-coded constant and only a human flips it.',
        fields: [
          { name: 'configured', value: `+${CONFIGURED_S}s → median ${conf?.['median_all']}`, inline: true },
          { name: 'best', value: `+${best['horizon_s']}s → median ${best['median_all']}`, inline: true },
          { name: 'margin', value: `${margin.toFixed(4)} (threshold ${MARGIN})`, inline: true },
          { name: 'sample', value: `${sample} trades over ${days} days (minimum ${MIN_SAMPLE})`, inline: false },
          { name: 'how the thresholds were derived', value:
            'minimum sample = the smallest per-window n where both holdout halves still '
            + 'agreed (CALM, 141/144). margin = the largest disagreement between those '
            + 'two halves measuring the same quantity (0.247).', inline: false },
        ],
      }, 'system');
      /* Report what the sink actually did. A send that went nowhere is not an alert. */
      alerted = sent;
      if (!sent) {
        log.warn('THE RECOMMENDATION WAS NOT DELIVERED', {
          note: 'the alert condition was met and the sink reported failure — reported '
            + 'rather than counted as sent',
        });
      }
    }
  } finally { c.release(); }

  /* VERIFIED ON A FRESH CONNECTION, not from this script exiting cleanly. */
  const fresh = await app.pool.connect();
  try {
    const v = await fresh.query(
      `select count(*)::int rows, count(distinct trade_id)::int trades,
              count(*) filter (where filled)::int filled
         from bot_horizon_prices where chain='robinhood'`);
    log.info('VERIFIED ON A FRESH CONNECTION', { ...v.rows[0], alert_sent: alerted });
  } finally { fresh.release(); }
  await app.pool.end();
  process.exit(0);
}

main().catch((err) => { log.error('nightly-check failed', errorFields(err)); process.exit(1); });

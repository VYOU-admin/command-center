/**
 * MOS price: an hourly heartbeat and an immediate all-time-high alert.
 *
 * ONE DexScreener READ PER CYCLE, no RPC. The pair is the DYN2 MOS/USDC pool,
 * which holds 99.7% of all MOS liquidity.
 *
 * A FAILED READ IS NOT A PRICE. It is recorded with price_usd null so the
 * failure is visible in the series, and then it is inert: nothing computes a
 * change from it, nothing compares against it, and it can never raise the
 * high-water mark. The alternative -- treating a missing price as 0, or as
 * unchanged -- would either fire a false ATH later or silently freeze the mark.
 *
 * THE HEARTBEAT STILL FIRES AFTER A FAILURE. Skipping the hour would be
 * indistinguishable from the monitor being dead, which is the one thing a
 * heartbeat exists to rule out. It reports the last good reading and says when
 * it was taken.
 *
 * ATH AND HEARTBEAT CAN BOTH FIRE IN THE SAME CYCLE. They answer different
 * questions -- "is it still alive and where is it" and "it just broke its
 * record" -- so one is never suppressed because the other went out.
 */
import type { AdapterContext, SourceAdapter } from './types.js';
import { requireString } from './types.js';
import type { PoolClient } from '../store/db.js';
import { migrate } from './mos-price/schema.js';
import { heartbeat, ath, type Reading } from './mos-price/message.js';

interface RunResult {
  token: string; chain: string; pair: string;
  status: string; error: string | null;
  reading: Reading | null;          // this cycle's, only when ok
  parts: { title: string; body: string }[];
  raiseHigh: { usd: number; at: Date; cap: number | null } | null;
  heartbeatSent: boolean;
  stats: Record<string, unknown>;
}

const num = (o: Record<string, unknown>, k: string, d: number): number => {
  const v = o[k]; return typeof v === 'number' && Number.isFinite(v) ? v : d;
};

const adapter: SourceAdapter<RunResult> = {
  type: 'mos-price',
  validate(o, id) {
    requireString(o, 'token', id);
    requireString(o, 'pair', id);
    requireString(o, 'dexscreener_chain', id);
    if (num(o, 'heartbeat_minutes', 0) < 1)
      throw new Error(`monitor "${id}": options.heartbeat_minutes must be >= 1`);
  },
  migrate,

  async fetch(ctx: AdapterContext): Promise<RunResult[]> {
    const o = ctx.options;
    const token = String(o.token), pair = String(o.pair), chain = 'solana';
    const hbMin = num(o, 'heartbeat_minutes', 60);
    const started = Date.now();

    // ---- the one read ------------------------------------------------------
    let priceUsd: number | null = null, marketCap: number | null = null;
    let status = 'ok', error: string | null = null;
    try {
      const r = await fetch(
        `https://api.dexscreener.com/latest/dex/pairs/${String(o.dexscreener_chain)}/${pair}`,
        { signal: ctx.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json() as { pairs?: Record<string, unknown>[]; pair?: Record<string, unknown> };
      const p = j.pairs?.[0] ?? j.pair;
      if (!p) throw new Error('no pair in response');
      const px = Number(p.priceUsd);
      if (!Number.isFinite(px) || px <= 0) throw new Error(`implausible priceUsd ${String(p.priceUsd)}`);
      priceUsd = px;
      const fdv = Number(p.fdv);
      marketCap = Number.isFinite(fdv) ? fdv : null;
    } catch (e) {
      status = 'failed';
      error = e instanceof Error ? e.message : String(e);
      priceUsd = null; marketCap = null;
    }
    const readAt = new Date();

    // ---- state: previous good reading, the high, the heartbeat clock ------
    const prevRow = await ctx.db.query(
      `select price_usd::float8 p, read_at from mos_price_readings
        where token = $1 and status = 'ok' order by read_at desc limit 1`, [token]);
    const prevPrice: number | null = prevRow.rows.length ? Number(prevRow.rows[0].p) : null;
    const prevGood = prevRow.rows.length
      ? { priceUsd: Number(prevRow.rows[0].p),
          marketCap: null as number | null,
          readAt: new Date(String(prevRow.rows[0].read_at)) }
      : null;

    const hiRow = await ctx.db.query(
      `select high_usd::float8 h, high_at from mos_price_high where token = $1 and chain = $2`,
      [token, chain]);
    const high = hiRow.rows.length
      ? { usd: Number(hiRow.rows[0].h), at: new Date(String(hiRow.rows[0].high_at)) } : null;

    const hbRow = await ctx.db.query(
      `select last_sent_at from mos_price_heartbeat where token = $1 and chain = $2`, [token, chain]);
    const lastHb = hbRow.rows.length ? new Date(String(hbRow.rows[0].last_sent_at)) : null;
    const hbDue = lastHb === null || (Date.now() - lastHb.getTime()) >= hbMin * 60_000;

    // ---- decide what to send ----------------------------------------------
    const parts: { title: string; body: string }[] = [];
    let raiseHigh: RunResult['raiseHigh'] = null;
    let heartbeatSent = false;
    const cur: Reading | null = priceUsd === null ? null
      : { priceUsd, marketCap, readAt };

    // ATH: only ever from a verified reading, and only strictly above the mark.
    // The FIRST good reading sets the bar without alerting -- "all-time" starts
    // now, and announcing the starting point as a record would be nonsense.
    let athFired = false;
    if (cur) {
      if (high === null) {
        raiseHigh = { usd: cur.priceUsd, at: readAt, cap: marketCap };
      } else if (cur.priceUsd > high.usd) {
        raiseHigh = { usd: cur.priceUsd, at: readAt, cap: marketCap };
        athFired = true;
        parts.push({ title: 'MOS new all-time high',
          body: ath(cur, prevPrice, high.usd, high.at) });
      }
    }

    if (hbDue) {
      // Stale path: no price this cycle, so report the last good one and say so.
      const shown = cur ?? prevGood;
      if (shown) {
        parts.push({ title: 'MOS price hourly',
          body: heartbeat(shown, cur ? prevPrice : null, cur === null) });
        heartbeatSent = true;
      } else {
        // Nothing has ever been read successfully. There is no price to report
        // and inventing one is worse than staying quiet for one more cycle.
        ctx.log.warn('heartbeat due but no good reading has ever been taken');
      }
    }

    ctx.log.info('mos price cycle', { status, priceUsd, marketCap, prevPrice,
      high: high?.usd ?? null, athFired, heartbeatSent, hbDue,
      error, durationMs: Date.now() - started });

    return [{ token, chain, pair, status, error, reading: cur, parts, raiseHigh,
      heartbeatSent,
      stats: { status, priceUsd, marketCap, athFired, heartbeatSent,
        highUsd: raiseHigh?.usd ?? high?.usd ?? null, durationMs: Date.now() - started } }];
  },

  async persist(ctx, client: PoolClient, records): Promise<number> {
    const r = records[0];
    if (!r) return 0;

    // Every cycle is recorded, including failures -- price_usd null on those.
    await client.query(
      `insert into mos_price_readings (token, chain, pair, price_usd, market_cap, status)
       values ($1,$2,$3,$4,$5,$6)`,
      [r.token, r.chain, r.pair, r.reading?.priceUsd ?? null,
       r.reading?.marketCap ?? null, r.status]);

    // RAISED ONLY FROM A VERIFIED READING. r.raiseHigh is null on any failed
    // cycle by construction, so a failure can neither advance nor reset it.
    if (r.raiseHigh) {
      await client.query(
        `insert into mos_price_high (token, chain, high_usd, high_at, market_cap, updated_at)
         values ($1,$2,$3,$4,$5, now())
         on conflict (token, chain) do update set
           high_usd = excluded.high_usd, high_at = excluded.high_at,
           market_cap = excluded.market_cap, updated_at = now()`,
        [r.token, r.chain, r.raiseHigh.usd, r.raiseHigh.at, r.raiseHigh.cap]);
    }

    const sendAlerts = ctx.options.send_alerts !== false;
    if (r.heartbeatSent && sendAlerts) {
      await client.query(
        `insert into mos_price_heartbeat (token, chain, last_sent_at) values ($1,$2, now())
         on conflict (token, chain) do update set last_sent_at = now()`, [r.token, r.chain]);
    }

    await client.query(
      `insert into mos_price_stats (ran_at, token, status, price_usd, market_cap,
         heartbeat, ath, high_usd, duration_ms, error)
       values (now(),$1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [r.token, r.status, r.reading?.priceUsd ?? null, r.reading?.marketCap ?? null,
       r.heartbeatSent, r.stats.athFired === true, r.stats.highUsd,
       r.stats.durationMs, r.error]);

    if (parts_len(r) && sendAlerts) {
      for (const p of r.parts)
        ctx.queueAlert({ level: 'warning', title: p.title, description: p.body });
    }
    ctx.log.info('mos price written', { status: r.status, parts: r.parts.length,
      queued: parts_len(r) > 0 && sendAlerts, highRaised: r.raiseHigh !== null });
    return 1;
  },
};
const parts_len = (r: RunResult): number => r.parts.length;
export default adapter;

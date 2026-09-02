/**
 * Repeated balance readings for wallets that bought and held.
 *
 * SCOPE COMES FROM THE SEED, NOT A QUERY. Group 1 is "bought, never sold to the
 * pool, never transferred out", and the last clause lives in transfer logs that
 * were never loaded into Postgres -- the closest SQL-only proxy returns 119 of
 * the 266 ODYSSEUS wallets. So the scanner reads exactly the wallets that have a
 * 'window_close' row for that token.
 *
 * SCHEDULE IS PER TOKEN, dated from that token's own window close: every 6 hours
 * for the first 4 weeks, daily after. A token seeded later runs on its own clock
 * rather than inheriting a global one.
 *
 * EVERY WALLET IS READ EVERY PASS, including wallets currently at zero -- a
 * wallet that sold out can buy back in, and only re-reading catches it.
 */
import type { AdapterContext, SourceAdapter } from './types.js';
import { requireString } from './types.js';
import type { PoolClient } from '../store/db.js';
import { migrate } from './token-balance-scan/schema.js';

interface Reading {
  token: string; chain: string; wallet: string; block: number;
  readAt: Date; balanceRaw: string | null; status: string;
}
interface RunResult { readings: Reading[]; stats: Record<string, number>; tokens: string[] }

const num = (o: Record<string, unknown>, k: string, d: number): number => {
  const v = o[k]; return typeof v === 'number' && Number.isFinite(v) ? v : d;
};

const adapter: SourceAdapter<RunResult> = {
  type: 'token-balance-scan',
  validate(o, id) {
    requireString(o, 'chain', id); requireString(o, 'rpc_url', id);
    if (num(o, 'min_interval_ms', 0) < 1000)
      throw new Error(`monitor "${id}": options.min_interval_ms must be >= 1000`);
    if (num(o, 'batch_size', 0) < 1 || num(o, 'batch_size', 0) > 50)
      throw new Error(`monitor "${id}": options.batch_size must be 1..50`);
  },
  migrate,

  async fetch(ctx: AdapterContext): Promise<RunResult[]> {
    const o = ctx.options;
    const chain = String(o.chain), url = String(o.rpc_url);
    const gap = num(o, 'min_interval_ms', 4000);
    const batch = num(o, 'batch_size', 20);
    const fastHours = num(o, 'fast_interval_hours', 6);
    const slowHours = num(o, 'slow_interval_hours', 24);
    const fastWeeks = num(o, 'fast_phase_weeks', 4);
    const started = Date.now();
    let last = 0;
    const pace = async () => {
      const w = last + gap - Date.now();
      if (w > 0) await new Promise((r) => setTimeout(r, w));
      last = Date.now();
    };
    let requests = 0;
    const backoff = num(o, 'backoff_base_ms', 1500);
    const backoffCap = num(o, 'backoff_cap_ms', 30_000);
    const call = async (body: unknown): Promise<unknown[] | null> => {
      for (let a = 0; a < 6; a++) {
        if (ctx.signal.aborted) throw new Error('run aborted');
        await pace(); requests++;
        try {
          const r = await fetch(url, { method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body), signal: ctx.signal });
          // ESCALATING BACKOFF, not just the pacing gap. Relying on the 4,000 ms
          // pace alone meant a rate-limited batch retried six times at the same
          // cadence and failed all 20 wallets: 120 of 266 reads were lost that
          // way on the first pass.
          if (r.status === 429 || r.status >= 500) {
            await new Promise((res) => setTimeout(res, Math.min(backoffCap, backoff * (a + 1) ** 2)));
            continue;
          }
          const j = await r.json();
          return Array.isArray(j) ? j : [j];
        } catch (e) {
          if (ctx.signal.aborted) throw e;
          await new Promise((res) => setTimeout(res, Math.min(backoffCap, backoff * (a + 1) ** 2)));
        }
      }
      return null;
    };

    // which tokens are seeded, and when did each window close
    const seeded = await ctx.db.query(
      `select token, chain, min(read_at) as window_close,
              count(distinct wallet)::int as wallets
         from token_balance_scans where scan_kind = 'window_close' and chain = $1
        group by 1,2`, [chain]);
    const due: { token: string; wallets: string[] }[] = [];
    for (const t of seeded.rows as Record<string, unknown>[]) {
      const token = String(t.token);
      const wc = new Date(String(t.window_close)).getTime();
      const ageDays = (Date.now() - wc) / 86_400_000;
      const everyMs = (ageDays <= fastWeeks * 7 ? fastHours : slowHours) * 3_600_000;
      const lastScan = await ctx.db.query(
        `select max(scanned_at) m from token_balance_scans
          where token = $1 and scan_kind = 'scan'`, [token]);
      const lm = lastScan.rows[0]?.m ? new Date(String(lastScan.rows[0].m)).getTime() : 0;
      const dueNow = Date.now() - lm >= everyMs;
      ctx.log.info('token schedule', { token, ageDays: Number(ageDays.toFixed(2)),
        everyHours: everyMs / 3_600_000, lastScan: lm ? new Date(lm).toISOString() : null, dueNow });
      if (!dueNow) continue;
      const ws = await ctx.db.query(
        `select distinct wallet from token_balance_scans
          where token = $1 and scan_kind = 'window_close' order by wallet`, [token]);
      due.push({ token, wallets: (ws.rows as Record<string, unknown>[]).map((r) => String(r.wallet)) });
    }
    if (!due.length) {
      ctx.log.info('no token due for a balance scan');
      return [{ readings: [], stats: { requests: 0, wallets: 0, errors: 0, durationMs: 0 }, tokens: [] }];
    }

    const hn = (await call({ jsonrpc: '2.0', id: 0, method: 'eth_blockNumber', params: [] })) as
      { result?: string }[] | null;
    const head = Number.parseInt(String(hn?.[0]?.result ?? ''), 16);
    if (!Number.isFinite(head)) throw new Error('could not read head block');
    const hbr = (await call({ jsonrpc: '2.0', id: 0, method: 'eth_getBlockByNumber',
      params: ['0x' + head.toString(16), false] })) as { result?: { timestamp?: string } }[] | null;
    const hb = hbr?.[0];
    if (!hb?.result?.timestamp) throw new Error('could not read head timestamp');
    const readAt = new Date(Number.parseInt(hb.result.timestamp, 16) * 1000);

    const readings: Reading[] = []; let errors = 0;
    for (const { token, wallets } of due) {
      const contract = (await ctx.db.query(
        `select token_address from wallet_pnl_tokens where token = $1 and chain = $2`,
        [token, chain])).rows[0]?.token_address;
      if (!contract) { ctx.log.warn('no token_address; skipping', { token }); continue; }
      // RETRY INDIVIDUAL WALLETS, never discard a whole batch. A failed batch
      // used to mark all 20 of its wallets as errors; now failures go back into
      // a retry pool and only become errors after every round is exhausted.
      const ok = new Map<string, string>();
      const failed = new Map<string, string>();
      let todo = wallets.slice();
      const maxRounds = num(o, 'max_rounds', 5);
      for (let round = 0; round < maxRounds && todo.length; round++) {
        const size = round === 0 ? batch : Math.max(1, Math.floor(batch / (2 ** round)));
        const next: string[] = [];
        for (let i = 0; i < todo.length; i += size) {
          const ch = todo.slice(i, i + size);
          const res = await call(ch.map((w, j) => ({ jsonrpc: '2.0', id: j, method: 'eth_call',
            params: [{ to: contract, data: '0x70a08231' + '0'.repeat(24) + w.slice(2) },
                     '0x' + head.toString(16)] })));
          if (res === null) {
            for (const w of ch) { next.push(w); failed.set(w, 'transport failure'); }
            continue;
          }
          const seen = new Set<string>();
          for (const r of res as Record<string, unknown>[]) {
            const w = ch[Number(r.id)]; if (w === undefined) continue;
            seen.add(w);
            const v = r.result as string | undefined;
            if (r.error || !v || v === '0x') {
              next.push(w);
              failed.set(w, String((r.error as { message?: string })?.message ?? 'empty result').slice(0, 120));
            } else { ok.set(w, BigInt(v).toString()); failed.delete(w); }
          }
          for (const w of ch) if (!seen.has(w)) { next.push(w); failed.set(w, 'no response for id'); }
        }
        todo = next.filter((w) => !ok.has(w));
        if (todo.length) ctx.log.info('balance retry round',
          { token, round: round + 1, remaining: todo.length, batch: size });
      }
      for (const [w, bal] of ok)
        readings.push({ token, chain, wallet: w, block: head, readAt, balanceRaw: bal, status: 'ok' });
      for (const w of wallets) {
        if (ok.has(w)) continue;
        errors++;
        readings.push({ token, chain, wallet: w, block: head, readAt,
          balanceRaw: null, status: failed.get(w) ?? 'unresolved' });
      }
    }
    ctx.log.info('balance scan pass', { tokens: due.map((d) => d.token), block: head,
      readings: readings.length, errors, requests, durationMs: Date.now() - started });
    return [{ readings, stats: { requests, wallets: readings.length, errors,
      block: head, durationMs: Date.now() - started }, tokens: due.map((d) => d.token) }];
  },

  async persist(ctx, client: PoolClient, records): Promise<number> {
    const r = records[0];
    if (!r || !r.readings.length) return 0;
    let n = 0;
    for (let i = 0; i < r.readings.length; i += 200) {
      const b = r.readings.slice(i, i + 200);
      // APPEND ONLY: plain insert, no on-conflict clause anywhere.
      const res = await client.query(
        `insert into token_balance_scans (token, chain, wallet, block, read_at, balance_raw, status, scan_kind)
         select * from unnest($1::text[],$2::text[],$3::text[],$4::bigint[],$5::timestamptz[],
                              $6::numeric[],$7::text[],$8::text[])`,
        [b.map((x) => x.token), b.map((x) => x.chain), b.map((x) => x.wallet), b.map((x) => x.block),
         b.map((x) => x.readAt), b.map((x) => x.balanceRaw), b.map((x) => x.status),
         b.map(() => 'scan')]);
      n += res.rowCount ?? 0;
    }
    ctx.log.info('balance scan written', { rows: n, errors: r.stats.errors });
    return n;
  },
};
export default adapter;

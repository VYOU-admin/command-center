/**
 * Repeated balance readings for wallets that bought and held.
 *
 * SCOPE COMES FROM THE SEED, NOT A QUERY. Group 1 is "bought, never sold to the
 * pool, never transferred out", and the last clause lives in transfer logs that
 * were never loaded into Postgres -- the closest SQL-only proxy returns 119 of
 * the 266 ODYSSEUS wallets. So the scanner reads exactly the wallets that have a
 * 'window_close' row for that token.
 *
 * ONE ROLLING SWEEP, NOT A PER-TOKEN SCHEDULE. A pass consumes `wallet_budget`
 * wallets from a single ordering -- (token, wallet) ascending across every
 * seeded token -- and resumes from `balance_scan_cursor` on the next pass. A
 * pass may therefore span two tokens, and may span the end of one sweep and the
 * start of the next.
 *
 * The per-token schedule this replaced could not survive a cursor: it asked
 * `max(scanned_at) where token = $1`, so reading one wallet of a token marked
 * the whole token scanned and the rest of it was never picked up.
 *
 * EVERY WALLET IS READ EVERY SWEEP, including wallets currently at zero -- a
 * wallet that sold out can buy back in, and only re-reading catches it.
 *
 * A WALLET THE BUDGET NEVER REACHED IS NOT WRITTEN AT ALL. Only wallets
 * actually attempted produce a row; a genuine endpoint failure produces
 * status <> 'ok' with balance_raw null. Neither is ever mapped to zero.
 */
import type { AdapterContext, SourceAdapter } from './types.js';
import { requireString } from './types.js';
import type { PoolClient } from '../store/db.js';
import { migrate } from './token-balance-scan/schema.js';

interface Reading {
  token: string; chain: string; wallet: string; block: number;
  readAt: Date; balanceRaw: string | null; status: string; sweepNo: number;
}
interface Cursor {
  lastToken: string; lastWallet: string; sweepNo: number; sweepStartedAt: Date;
}
interface RunResult {
  readings: Reading[]; stats: Record<string, number>; tokens: string[];
  cursor: Cursor | null;
}

const num = (o: Record<string, unknown>, k: string, d: number): number => {
  const v = o[k]; return typeof v === 'number' && Number.isFinite(v) ? v : d;
};

const DEFAULT_BUDGET = 400;

const adapter: SourceAdapter<RunResult> = {
  type: 'token-balance-scan',
  validate(o, id) {
    requireString(o, 'chain', id); requireString(o, 'rpc_url', id);
    if (num(o, 'min_interval_ms', 0) < 1000)
      throw new Error(`monitor "${id}": options.min_interval_ms must be >= 1000`);
    if (num(o, 'batch_size', 0) < 1 || num(o, 'batch_size', 0) > 50)
      throw new Error(`monitor "${id}": options.batch_size must be 1..50`);
    const budget = num(o, 'wallet_budget', DEFAULT_BUDGET);
    if (budget < 50 || budget > 1000)
      throw new Error(
        `monitor "${id}": options.wallet_budget must be 50..1000. Below 50 the two ` +
        `fixed overhead requests (eth_blockNumber, eth_getBlockByNumber) cost more ` +
        `than a fifth of the pass and a full sweep takes days; above 1000 the pass ` +
        `cannot fit the spine's 300s run ceiling, since 1000 wallets is 52 batches ` +
        `plus 2 overhead at 4000ms pacing = 274s before any retry round.`);
  },
  migrate,

  async fetch(ctx: AdapterContext): Promise<RunResult[]> {
    const o = ctx.options;
    const chain = String(o.chain), url = String(o.rpc_url);
    const gap = num(o, 'min_interval_ms', 4000);
    const batch = num(o, 'batch_size', 20);
    const budget = num(o, 'wallet_budget', DEFAULT_BUDGET);
    // Stop ourselves here rather than being aborted at MAX_RUN_MS. An abort
    // throws out of fetch(), and the scheduler only reaches persist() after
    // fetch() resolves -- so an aborted pass loses every reading it took.
    const softCeiling = num(o, 'soft_ceiling_ms', 240_000);
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
    /** Projected wall cost of one more request, self-calibrating from this pass. */
    const requestCost = (): number =>
      requests > 0 ? (Date.now() - started) / requests : num(o, 'request_cost_ms', 5500);
    const outOfTime = (): boolean => Date.now() - started + requestCost() > softCeiling;

    // ---- where the last pass stopped --------------------------------------
    const cq = await ctx.db.query(
      `select last_token, last_wallet, sweep_no, sweep_started_at
         from balance_scan_cursor where monitor_id = $1 and chain = $2`,
      [ctx.monitorId, chain]);
    const c0 = cq.rows[0] as Record<string, unknown> | undefined;
    let sweepNo = c0 ? Number(c0.sweep_no) : 1;
    let sweepStartedAt = c0?.sweep_started_at
      ? new Date(String(c0.sweep_started_at)) : new Date();
    let fromToken = c0?.last_token == null ? null : String(c0.last_token);
    let fromWallet = c0?.last_wallet == null ? null : String(c0.last_wallet);
    const cursorBefore = { token: fromToken, wallet: fromWallet, sweepNo };

    // ---- the slice: `budget` wallets from the cursor, wrapping at the end --
    // A RANGE, NOT AN OFFSET. `(token, wallet) > (last_token, last_wallet)`
    // stays correct across a re-run of run_token.py, which rewrites
    // wallet_groups wholesale and can move membership underneath the cursor.
    const range = async (t: string | null, w: string | null, limit: number) =>
      (await ctx.db.query(
        `select distinct token, wallet
           from token_balance_scans
          where scan_kind = 'window_close' and chain = $1
            and ($2::text is null or (token, wallet) > ($2::text, $3::text))
          order by token, wallet
          limit $4::int`, [chain, t, w, limit])).rows as { token: string; wallet: string }[];

    const slice: { token: string; wallet: string; sweepNo: number; sweepStartedAt: Date }[] = [];
    const inPass = new Set<string>();
    let wrapped = 0, suppressed = 0;
    while (slice.length < budget) {
      const rows = await range(fromToken, fromWallet, budget - slice.length);
      let dup = false;
      for (const r of rows) {
        const k = `${r.token}|${r.wallet}`;
        // A budget larger than the whole seeded cohort would otherwise read the
        // same wallet twice at the same block inside one pass, which is not a
        // second observation. Stop the pass short instead.
        if (inPass.has(k)) { dup = true; break; }
        inPass.add(k);
        slice.push({ token: r.token, wallet: r.wallet, sweepNo, sweepStartedAt });
      }
      if (dup) { suppressed = budget - slice.length; break; }
      if (slice.length >= budget) break;
      if (rows.length === 0 && fromToken === null) break;   // nothing seeded at all
      // Fewer rows than asked for: the ordering is exhausted, so this sweep ends
      // here and the remainder of the pass belongs to the next one.
      sweepNo += 1; sweepStartedAt = new Date();
      fromToken = null; fromWallet = null;
      if (++wrapped > 2) break;
    }

    if (!slice.length) {
      ctx.log.info('no seeded wallets to scan', { chain, cursorBefore });
      return [{ readings: [], stats: { requests: 0, wallets: 0, errors: 0, attempted: 0,
        durationMs: Date.now() - started }, tokens: [], cursor: null }];
    }

    // ---- one contract lookup for every token in the slice ------------------
    const sliceTokens = [...new Set(slice.map((s) => s.token))];
    const cm = await ctx.db.query(
      `select token, token_address from wallet_pnl_tokens
        where chain = $1 and token = any($2::text[])`, [chain, sliceTokens]);
    const contracts = new Map<string, string>();
    for (const r of cm.rows as Record<string, unknown>[])
      if (r.token_address) contracts.set(String(r.token), String(r.token_address));
    const missing = sliceTokens.filter((t) => !contracts.has(t));
    // FAIL, DO NOT SKIP. Skipping would advance the cursor past wallets that
    // were never read, and they would not come round again for a whole sweep --
    // a silent hole in the series rather than a visible failure.
    if (missing.length)
      throw new Error(`seeded token(s) with no token_address in wallet_pnl_tokens: ${missing.join(', ')}`);

    const hn = (await call({ jsonrpc: '2.0', id: 0, method: 'eth_blockNumber', params: [] })) as
      { result?: string }[] | null;
    const head = Number.parseInt(String(hn?.[0]?.result ?? ''), 16);
    if (!Number.isFinite(head)) throw new Error('could not read head block');
    const hbr = (await call({ jsonrpc: '2.0', id: 0, method: 'eth_getBlockByNumber',
      params: ['0x' + head.toString(16), false] })) as { result?: { timestamp?: string } }[] | null;
    const hb = hbr?.[0];
    if (!hb?.result?.timestamp) throw new Error('could not read head timestamp');
    const readAt = new Date(Number.parseInt(hb.result.timestamp, 16) * 1000);

    // ---- phase 1: walk the slice in order, batching within a token ---------
    // In order, because the cursor is the position of the last wallet ATTEMPTED
    // and a pass that stops early must leave the untouched tail for next time.
    const ok = new Map<string, string>();
    const failed = new Map<string, string>();
    const attempted: typeof slice = [];
    const retry: { token: string; wallet: string }[] = [];
    let stoppedEarly = false;

    for (let i = 0; i < slice.length && !stoppedEarly;) {
      // Longest run of one token starting at i: a batch is one eth_call array
      // against one contract, so it cannot straddle a token boundary.
      const token = slice[i]!.token;
      let j = i;
      while (j < slice.length && slice[j]!.token === token && j - i < batch) j++;
      if (outOfTime()) { stoppedEarly = true; break; }
      const ch = slice.slice(i, j);
      const contract = contracts.get(token)!;
      const res = await call(ch.map((s, k) => ({ jsonrpc: '2.0', id: k, method: 'eth_call',
        params: [{ to: contract, data: '0x70a08231' + '0'.repeat(24) + s.wallet.slice(2) },
                 '0x' + head.toString(16)] })));
      for (const s of ch) attempted.push(s);
      if (res === null) {
        for (const s of ch) { failed.set(`${s.token}|${s.wallet}`, 'transport failure');
          retry.push({ token: s.token, wallet: s.wallet }); }
      } else {
        const seen = new Set<number>();
        for (const r of res as Record<string, unknown>[]) {
          const s = ch[Number(r.id)]; if (s === undefined) continue;
          seen.add(Number(r.id));
          const k = `${s.token}|${s.wallet}`;
          const v = r.result as string | undefined;
          if (r.error || !v || v === '0x') {
            failed.set(k, String((r.error as { message?: string })?.message ?? 'empty result').slice(0, 120));
            retry.push({ token: s.token, wallet: s.wallet });
          } else { ok.set(k, BigInt(v).toString()); failed.delete(k); }
        }
        ch.forEach((s, k) => {
          if (seen.has(k)) return;
          failed.set(`${s.token}|${s.wallet}`, 'no response for id');
          retry.push({ token: s.token, wallet: s.wallet });
        });
      }
      i = j;
    }

    // ---- phase 2: retry pool, halving the batch each round -----------------
    // RETRY INDIVIDUAL WALLETS, never discard a whole batch. A failed batch used
    // to mark all 20 of its wallets as errors; failures go back into this pool
    // and only become errors after every round is exhausted. Retries never
    // change WHICH wallets were attempted, so the cursor is unaffected by them.
    const maxRounds = num(o, 'max_rounds', 5);
    let todo = retry.filter((r) => !ok.has(`${r.token}|${r.wallet}`));
    for (let round = 1; round <= maxRounds && todo.length; round++) {
      if (outOfTime()) {
        ctx.log.warn('out of time before retry round', { round, remaining: todo.length });
        break;
      }
      const size = Math.max(1, Math.floor(batch / (2 ** round)));
      const next: typeof todo = [];
      for (let i = 0; i < todo.length;) {
        const token = todo[i]!.token;
        let j = i;
        while (j < todo.length && todo[j]!.token === token && j - i < size) j++;
        if (outOfTime()) { next.push(...todo.slice(i)); break; }
        const ch = todo.slice(i, j);
        const contract = contracts.get(token)!;
        const res = await call(ch.map((s, k) => ({ jsonrpc: '2.0', id: k, method: 'eth_call',
          params: [{ to: contract, data: '0x70a08231' + '0'.repeat(24) + s.wallet.slice(2) },
                   '0x' + head.toString(16)] })));
        if (res === null) {
          for (const s of ch) { next.push(s); failed.set(`${s.token}|${s.wallet}`, 'transport failure'); }
        } else {
          const seen = new Set<number>();
          for (const r of res as Record<string, unknown>[]) {
            const s = ch[Number(r.id)]; if (s === undefined) continue;
            seen.add(Number(r.id));
            const k = `${s.token}|${s.wallet}`;
            const v = r.result as string | undefined;
            if (r.error || !v || v === '0x') {
              next.push(s);
              failed.set(k, String((r.error as { message?: string })?.message ?? 'empty result').slice(0, 120));
            } else { ok.set(k, BigInt(v).toString()); failed.delete(k); }
          }
          ch.forEach((s, k) => {
            if (seen.has(k)) return;
            next.push(s); failed.set(`${s.token}|${s.wallet}`, 'no response for id');
          });
        }
        i = j;
      }
      todo = next.filter((r) => !ok.has(`${r.token}|${r.wallet}`));
      if (todo.length) ctx.log.info('balance retry round', { round, remaining: todo.length, batch: size });
    }

    // ---- phase 3: one row per ATTEMPTED wallet, and only those -------------
    const readings: Reading[] = []; let errors = 0;
    for (const s of attempted) {
      const k = `${s.token}|${s.wallet}`;
      const bal = ok.get(k);
      if (bal !== undefined) {
        readings.push({ token: s.token, chain, wallet: s.wallet, block: head, readAt,
          balanceRaw: bal, status: 'ok', sweepNo: s.sweepNo });
      } else {
        errors++;
        readings.push({ token: s.token, chain, wallet: s.wallet, block: head, readAt,
          balanceRaw: null, status: failed.get(k) ?? 'unresolved', sweepNo: s.sweepNo });
      }
    }

    // The cursor is the last wallet ATTEMPTED, so a pass that stopped early
    // leaves its untouched tail to the next one rather than skipping it.
    const tail = attempted[attempted.length - 1];
    const cursor: Cursor | null = tail
      ? { lastToken: tail.token, lastWallet: tail.wallet,
          sweepNo: tail.sweepNo, sweepStartedAt: tail.sweepStartedAt }
      : null;

    ctx.log.info('balance scan pass', {
      chain, block: head, tokens: sliceTokens, budget,
      sliceSize: slice.length, attempted: attempted.length,
      unattempted: slice.length - attempted.length,
      ok: ok.size, errors, requests, stoppedEarly, wrapped, suppressed,
      cursorBefore, cursorAfter: cursor && { token: cursor.lastToken, wallet: cursor.lastWallet, sweepNo: cursor.sweepNo },
      durationMs: Date.now() - started,
    });
    return [{ readings, cursor, tokens: sliceTokens, stats: {
      requests, wallets: readings.length, errors, block: head,
      slice: slice.length, attempted: attempted.length,
      unattempted: slice.length - attempted.length,
      ok: ok.size, stoppedEarly: stoppedEarly ? 1 : 0, wrapped, suppressed,
      sweepNo: cursor?.sweepNo ?? sweepNo, durationMs: Date.now() - started } }];
  },

  async persist(ctx, client: PoolClient, records): Promise<number> {
    const r = records[0];
    if (!r) return 0;
    let n = 0;
    for (let i = 0; i < r.readings.length; i += 200) {
      const b = r.readings.slice(i, i + 200);
      // APPEND ONLY: plain insert, no on-conflict clause anywhere.
      const res = await client.query(
        `insert into token_balance_scans (token, chain, wallet, block, read_at, balance_raw, status, scan_kind, sweep_no)
         select * from unnest($1::text[],$2::text[],$3::text[],$4::bigint[],$5::timestamptz[],
                              $6::numeric[],$7::text[],$8::text[],$9::bigint[])`,
        [b.map((x) => x.token), b.map((x) => x.chain), b.map((x) => x.wallet), b.map((x) => x.block),
         b.map((x) => x.readAt), b.map((x) => x.balanceRaw), b.map((x) => x.status),
         b.map(() => 'scan'), b.map((x) => x.sweepNo)]);
      n += res.rowCount ?? 0;
    }
    // SAME TRANSACTION as the readings. A cursor that advanced without its rows
    // landing would skip those wallets for a whole sweep; rows landing without
    // the cursor advancing would re-read them at the next pass. Both are wrong,
    // and only one transaction rules both out.
    if (r.cursor) {
      await client.query(
        `insert into balance_scan_cursor
           (monitor_id, chain, last_token, last_wallet, sweep_no, sweep_started_at, updated_at)
         values ($1::text,$2::text,$3::text,$4::text,$5::bigint,$6::timestamptz, now())
         on conflict (monitor_id, chain) do update set
           last_token = excluded.last_token, last_wallet = excluded.last_wallet,
           sweep_no = excluded.sweep_no, sweep_started_at = excluded.sweep_started_at,
           updated_at = now()`,
        [ctx.monitorId, String(ctx.options.chain), r.cursor.lastToken, r.cursor.lastWallet,
         r.cursor.sweepNo, r.cursor.sweepStartedAt]);
    }
    ctx.log.info('balance scan written', { rows: n, errors: r.stats.errors,
      cursor: r.cursor && { token: r.cursor.lastToken, wallet: r.cursor.lastWallet, sweepNo: r.cursor.sweepNo } });
    return n;
  },
};
export default adapter;

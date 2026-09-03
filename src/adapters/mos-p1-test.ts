/**
 * MOS-P1: a cost and correctness probe over 10 wallets.
 *
 * NOT A PRODUCTION MONITOR. No Discord, own tables, nothing else reads it. Its
 * output is a request count and a flag rate, so the question "what would 74
 * wallets cost" can be answered from measurement rather than arithmetic.
 *
 * BOTH TOKEN PROGRAMS, ALWAYS. getTokenAccountsByOwner takes one programId, so
 * covering legacy SPL Token and Token-2022 needs two sub-calls per wallet. They
 * are sent as ONE batched HTTP request for the whole stage. Querying only the
 * legacy program returns nothing for MOS, which is Token-2022 -- measured: the
 * legacy filter returns 0 accounts for this mint. Both counts are reported,
 * because an HTTP request and a billable sub-call are not the same unit and the
 * provider's pricing for either has never been verified.
 *
 * A NEW MINT ALWAYS FLAGS. There is no prior balance to take a percentage
 * against, so a size threshold cannot apply to it.
 *
 * NOTHING MISSING IS ZERO. A failed read and an absent prior snapshot are each
 * carried as their own state and excluded from the diff, never substituted with
 * 0 -- which would manufacture a -100% move out of an absence of data.
 */
import type { AdapterContext, SourceAdapter } from './types.js';
import { requireString } from './types.js';
import type { PoolClient } from '../store/db.js';
import { migrate } from './mos-p1-test/schema.js';

const TOKEN_LEGACY = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

interface Snap { wallet: string; mint: string | null; amount: string | null;
  decimals: number | null; program: string | null; status: string }
interface Act { wallet: string; mint: string; side: string; amount: number;
  usd: number | null; sig: string; blockTime: Date | null }
interface RunResult {
  cycleAt: Date; snaps: Snap[]; acts: Act[];
  flagged: string[]; newMints: number; skipped: number; walletsRead: number;
  failures: Record<string, string>;
  stats: Record<string, number>;
}

const num = (o: Record<string, unknown>, k: string, d: number): number => {
  const v = o[k]; return typeof v === 'number' && Number.isFinite(v) ? v : d;
};

const adapter: SourceAdapter<RunResult> = {
  type: 'mos-p1-test',
  validate(o, id) {
    requireString(o, 'rpc_url', id);
    requireString(o, 'tag', id);
    if (num(o, 'move_pct', 0) <= 0)
      throw new Error(`monitor "${id}": options.move_pct must be > 0`);
    if (num(o, 'activity_minutes', 0) <= 0)
      throw new Error(`monitor "${id}": options.activity_minutes must be > 0`);
  },
  migrate,

  async fetch(ctx: AdapterContext): Promise<RunResult[]> {
    const o = ctx.options;
    const url = String(o.rpc_url), tag = String(o.tag);
    const movePct = num(o, 'move_pct', 5);
    const actMin = num(o, 'activity_minutes', 30);
    const started = Date.now();
    const cycleAt = new Date();
    let s1req = 0, s1sub = 0, s2req = 0, s3req = 0;
    const failures: Record<string, string> = {};

    // WRITTEN AT CYCLE START, before any work. A cycle killed by the abort
    // guard throws out of fetch() and never reaches persist(), so without this
    // the worst cycles would be the ones leaving no evidence at all -- the
    // exact blind spot that produced four wrong diagnoses on group1.
    await ctx.db.query(
      `insert into mos_p1_test_stats (cycle_at, completed) values ($1, false)
       on conflict (cycle_at) do nothing`, [cycleAt]);

    const abort = (): void => { if (ctx.signal.aborted) throw new Error('run aborted'); };
    const post = async (body: unknown): Promise<unknown> => {
      const r = await fetch(url, { method: 'POST', signal: ctx.signal,
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    };

    // ---- the cohort: 10 wallets, read as-is (base58 is case-sensitive) ----
    const wq = await ctx.db.query(
      `select wallet from wallet_tags where tag = $1 and chain = 'solana'
        order by wallet`, [tag]);
    const all = (wq.rows as Record<string, unknown>[]).map((r) => String(r.wallet));
    const batchq = await ctx.db.query(
      `select wallet from mos_p1_test_batch order by wallet`);
    const inBatch = new Set((batchq.rows as Record<string, unknown>[]).map((r) => String(r.wallet)));
    const wallets = all.filter((w) => inBatch.has(w));
    if (!wallets.length) throw new Error(`no test_batch wallets found for tag ${tag}`);

    // ---- STAGE 1: balances, both programs, one batched request ------------
    abort();
    const subs: unknown[] = [];
    const idMap: { wallet: string; program: string }[] = [];
    for (const w of wallets) {
      for (const prog of [TOKEN_LEGACY, TOKEN_2022]) {
        subs.push({ jsonrpc: '2.0', id: idMap.length, method: 'getTokenAccountsByOwner',
          params: [w, { programId: prog }, { encoding: 'jsonParsed' }] });
        idMap.push({ wallet: w, program: prog });
      }
    }
    s1req = 1; s1sub = subs.length;
    let raw: unknown[] = [];
    try {
      const j = await post(subs);
      raw = Array.isArray(j) ? j : [j];
    } catch (e) {
      // THE WHOLE STAGE FAILED. Every wallet is unread, not empty.
      const msg = e instanceof Error ? e.message : String(e);
      for (const w of wallets) failures[w] = `stage1: ${msg}`;
    }

    const held = new Map<string, Map<string, { amount: bigint; dec: number; prog: string }>>();
    const readOk = new Set<string>();
    for (const entry of raw as Record<string, unknown>[]) {
      const meta = idMap[Number(entry.id)];
      if (!meta) continue;
      if (entry.error) { failures[meta.wallet] = String((entry.error as { message?: string }).message ?? 'rpc error'); continue; }
      const value = ((entry.result as Record<string, unknown>)?.value ?? []) as Record<string, unknown>[];
      readOk.add(meta.wallet);
      let m = held.get(meta.wallet);
      if (!m) { m = new Map(); held.set(meta.wallet, m); }
      for (const a of value) {
        const info = ((a.account as Record<string, unknown>)?.data as Record<string, unknown>)
          ?.parsed as Record<string, unknown> | undefined;
        const i = info?.info as Record<string, unknown> | undefined;
        const ta = i?.tokenAmount as Record<string, unknown> | undefined;
        if (!i?.mint || !ta) continue;
        const mint = String(i.mint);
        const amt = BigInt(String(ta.amount ?? '0'));
        const prev = m.get(mint);
        m.set(mint, { amount: (prev?.amount ?? 0n) + amt, dec: Number(ta.decimals ?? 0), prog: meta.program });
      }
    }
    // A wallet is only "read" when BOTH of its sub-calls came back.
    const bothOk = wallets.filter((w) => readOk.has(w) && failures[w] === undefined);

    const snaps: Snap[] = [];
    for (const w of wallets) {
      if (failures[w] !== undefined || !readOk.has(w)) {
        snaps.push({ wallet: w, mint: null, amount: null, decimals: null,
          program: null, status: failures[w] ?? 'unread' });
        continue;
      }
      const m = held.get(w);
      if (!m || m.size === 0) {
        snaps.push({ wallet: w, mint: null, amount: null, decimals: null,
          program: null, status: 'no_account' });
        continue;
      }
      for (const [mint, v] of m)
        snaps.push({ wallet: w, mint, amount: v.amount.toString(),
          decimals: v.dec, program: v.prog, status: 'ok' });
    }

    // ---- STAGE 2: diff against the previous cycle -------------------------
    abort();
    const prevCycle = await ctx.db.query(
      `select max(cycle_at) c from mos_p1_balance_snapshots where cycle_at < $1`, [cycleAt]);
    s2req = 0;   // database only; no RPC in this stage
    const prevAt = prevCycle.rows[0]?.c ? new Date(String(prevCycle.rows[0].c)) : null;
    const prior = new Map<string, Map<string, bigint>>();
    if (prevAt) {
      const pr = await ctx.db.query(
        `select wallet, mint, amount::text amount from mos_p1_balance_snapshots
          where cycle_at = $1 and status = 'ok' and mint is not null`, [prevAt]);
      for (const r of pr.rows as Record<string, unknown>[]) {
        const w = String(r.wallet);
        let m = prior.get(w); if (!m) { m = new Map(); prior.set(w, m); }
        m.set(String(r.mint), BigInt(String(r.amount)));
      }
    }
    const flagged: string[] = [];
    let newMints = 0;
    if (prevAt) {
      for (const w of bothOk) {
        const now = held.get(w) ?? new Map();
        const was = prior.get(w);
        // NO PRIOR SNAPSHOT IS NOT A SET OF ZEROS. Nothing to diff against, so
        // the wallet is not flagged and not counted as changed.
        if (!was) continue;
        let flag = false;
        for (const [mint, v] of now) {
          const before = was.get(mint);
          if (before === undefined) { newMints++; flag = true; continue; }  // new mint always flags
          if (before === 0n) { if (v.amount !== 0n) flag = true; continue; }
          const pct = Number((v.amount - before) * 10000n / before) / 100;
          if (Math.abs(pct) > movePct) flag = true;
        }
        if (flag) flagged.push(w);
      }
    }

    // ---- STAGE 3: activity, flagged wallets only --------------------------
    const acts: Act[] = [];
    const since = Math.floor(Date.now() / 1000) - actMin * 60;
    for (const w of flagged) {
      abort();
      s3req++;
      try {
        const j = await post({ jsonrpc: '2.0', id: 1, method: 'getTransactionsForAddress',
          params: [w, { transactionDetails: 'full', encoding: 'jsonParsed',
            maxSupportedTransactionVersion: 0, sortOrder: 'desc', limit: 100 }] }) as
          { result?: { data?: Record<string, unknown>[] }; error?: { message?: string } };
        if (j.error) { failures[w] = `stage3: ${j.error.message}`; continue; }
        for (const t of j.result?.data ?? []) {
          const bt = Number(t.blockTime);
          if (!Number.isFinite(bt) || bt < since) continue;
          const meta = t.meta as Record<string, unknown> | undefined;
          if (!meta || meta.err) continue;
          // SAME METHOD AS THE MOS BACKFILL: net token deltas for this owner,
          // at any call depth, rather than decoding an instruction layout.
          const pre = new Map<string, bigint>(), post2 = new Map<string, bigint>();
          for (const b of (meta.preTokenBalances ?? []) as Record<string, unknown>[])
            if (String(b.owner) === w) pre.set(String(b.mint),
              (pre.get(String(b.mint)) ?? 0n) + BigInt(String((b.uiTokenAmount as Record<string, unknown>).amount)));
          for (const b of (meta.postTokenBalances ?? []) as Record<string, unknown>[])
            if (String(b.owner) === w) post2.set(String(b.mint),
              (post2.get(String(b.mint)) ?? 0n) + BigInt(String((b.uiTokenAmount as Record<string, unknown>).amount)));
          const mints = new Set([...pre.keys(), ...post2.keys()]);
          const sig = String(((t.transaction as Record<string, unknown>)?.signatures as string[])?.[0] ?? '');
          for (const mint of mints) {
            const d = (post2.get(mint) ?? 0n) - (pre.get(mint) ?? 0n);
            if (d === 0n) continue;
            const dec = decOf(meta, mint);
            acts.push({ wallet: w, mint, side: d > 0n ? 'buy' : 'sell',
              amount: Number(d < 0n ? -d : d) / Math.pow(10, dec),
              // USD IS NULL, NOT 0. There is no price series for arbitrary
              // mints here, and 0 would read as a worthless trade.
              usd: null, sig, blockTime: new Date(bt * 1000) });
          }
        }
      } catch (e) {
        failures[w] = `stage3: ${e instanceof Error ? e.message : String(e)}`;
      }
    }

    const skipped = wallets.length - bothOk.length;
    const stats = {
      walletsTotal: wallets.length, walletsRead: bothOk.length,
      walletsFlagged: flagged.length, walletsSkipped: skipped, mintsNew: newMints,
      stage1Requests: s1req, stage1Subcalls: s1sub, stage2Requests: s2req,
      stage3Requests: s3req, totalRequests: s1req + s2req + s3req,
      durationMs: Date.now() - started,
    };
    ctx.log.info('mos-p1 cycle', { ...stats, firstCycle: prevAt === null,
      failures: Object.keys(failures).length ? failures : undefined });
    return [{ cycleAt, snaps, acts, flagged, newMints, skipped,
      walletsRead: bothOk.length, failures, stats }];
  },

  async persist(ctx, client: PoolClient, records): Promise<number> {
    const r = records[0];
    if (!r) return 0;
    for (let i = 0; i < r.snaps.length; i += 200) {
      const b = r.snaps.slice(i, i + 200);
      await client.query(
        `insert into mos_p1_balance_snapshots
           (cycle_at, wallet, mint, amount, decimals, program, read_at, status)
         select $1, * from unnest($2::text[],$3::text[],$4::numeric[],$5::int[],
                                  $6::text[],$7::timestamptz[],$8::text[])`,
        [r.cycleAt, b.map((x) => x.wallet), b.map((x) => x.mint), b.map((x) => x.amount),
         b.map((x) => x.decimals), b.map((x) => x.program), b.map(() => r.cycleAt),
         b.map((x) => x.status)]);
    }
    for (const a of r.acts) {
      await client.query(
        `insert into mos_p1_activity (cycle_at, wallet, mint, side, amount, usd, tx_sig, block_time)
         values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (wallet, mint, tx_sig) do nothing`,
        [r.cycleAt, a.wallet, a.mint, a.side, a.amount, a.usd, a.sig, a.blockTime]);
    }
    await client.query(
      `update mos_p1_test_stats set finished_at = now(), completed = true,
         wallets_total=$2, wallets_read=$3, wallets_flagged=$4, wallets_skipped=$5,
         mints_new=$6, stage1_requests=$7, stage1_subcalls=$8, stage2_requests=$9,
         stage3_requests=$10, total_requests=$11, duration_ms=$12, failures=$13
       where cycle_at = $1`,
      [r.cycleAt, r.stats.walletsTotal, r.stats.walletsRead, r.stats.walletsFlagged,
       r.stats.walletsSkipped, r.stats.mintsNew, r.stats.stage1Requests,
       r.stats.stage1Subcalls, r.stats.stage2Requests, r.stats.stage3Requests,
       r.stats.totalRequests, r.stats.durationMs, JSON.stringify(r.failures)]);
    ctx.log.info('mos-p1 written', { snaps: r.snaps.length, acts: r.acts.length });
    return r.snaps.length;
  },
};

function decOf(meta: Record<string, unknown>, mint: string): number {
  for (const k of ['postTokenBalances', 'preTokenBalances'])
    for (const b of (meta[k] ?? []) as Record<string, unknown>[])
      if (String(b.mint) === mint)
        return Number((b.uiTokenAmount as Record<string, unknown>).decimals ?? 0);
  return 0;
}

export default adapter;

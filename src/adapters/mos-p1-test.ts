/**
 * MOS-P1: what the tagged cohort is holding, and what it has just started holding.
 *
 * Began as a 10-wallet cost probe with no Discord. It now reads all 74 tagged
 * wallets and alerts to the new-token channel.
 *
 * BOTH TOKEN PROGRAMS, ALWAYS. getTokenAccountsByOwner takes one programId, so
 * covering legacy SPL Token and Token-2022 needs two sub-calls per wallet.
 * Querying only the legacy program returns nothing for MOS, which is
 * Token-2022 -- measured: the legacy filter returns 0 accounts for this mint.
 *
 * THE PROVIDER CAPS A BATCH BETWEEN 28 AND 32 SUB-CALLS. Measured on this key:
 * 20, 24 and 28 return 200; 32, 40, 100 and 148 return HTTP 429 within ~20ms,
 * and 40 stayed refused across three attempts with 12s backoff, so it is a size
 * ceiling rather than a rate limit. 148 sub-calls therefore go as chunks of 20
 * spaced a few seconds apart -- measured 8/8 clean in 40.7s.
 *
 * A NEW MINT ALWAYS FLAGS. There is no prior balance to take a percentage
 * against, so a size threshold cannot apply to it.
 *
 * NOTHING MISSING IS ZERO. A failed read, a partial read and an absent prior
 * snapshot are each carried as their own state and excluded from the diff,
 * never substituted with 0 -- which would manufacture a -100% move out of an
 * absence of data.
 *
 * ALERTS ARE NOT THE FLAG SET. The balance diff still flags percentage moves,
 * and stage 3 still pulls their activity, but only mints crossing a wallet-count
 * high-water mark are ever sent: USDC and stablecoin shuffling dominated the
 * measured flag rate and is not signal.
 */
import type { AdapterContext, SourceAdapter } from './types.js';
import { requireString } from './types.js';
import type { PoolClient } from '../store/db.js';
import { migrate } from './mos-p1-test/schema.js';
import { renderAlert, type MintLine } from './mos-p1-test/message.js';
import { resolveMint, DEFAULT_INTERVAL_MS } from './mos-p1-test/dexscreener.js';

const TOKEN_LEGACY = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

/** Overridden by options.denylist_mints; kept here so an empty config is safe. */
const DEFAULT_DENYLIST = [
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',   // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',   // USDT
  'So11111111111111111111111111111111111111112',    // wrapped SOL
];

interface Snap { wallet: string; mint: string | null; amount: string | null;
  decimals: number | null; program: string | null; status: string }
interface Act { wallet: string; mint: string; side: string; amount: number;
  usd: number | null; sig: string; blockTime: Date | null }
interface Alerted { mint: string; count: number; symbol: string | null }
interface RunResult {
  cycleAt: Date; snaps: Snap[]; acts: Act[];
  flagged: string[]; newMints: number; skipped: number; walletsRead: number;
  failures: Record<string, string>;
  alerted: Alerted[]; seeds: Alerted[]; parts: string[]; messageText: string;
  bootstrap: boolean;
  stats: Record<string, number>;
}

const num = (o: Record<string, unknown>, k: string, d: number): number => {
  const v = o[k]; return typeof v === 'number' && Number.isFinite(v) ? v : d;
};
const strList = (o: Record<string, unknown>, k: string, d: string[]): string[] => {
  const v = o[k];
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : d;
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
    const bs = num(o, 'batch_subcalls', 20);
    // 32 was refused; 28 was the largest that returned 200. Anything above 28
    // is a configuration that cannot work, so it fails the deploy rather than
    // every cycle.
    if (bs < 1 || bs > 28)
      throw new Error(`monitor "${id}": options.batch_subcalls must be 1..28 (32 measured as refused)`);
    if (num(o, 'min_holders', 1) < 1)
      throw new Error(`monitor "${id}": options.min_holders must be >= 1`);
  },
  migrate,

  async fetch(ctx: AdapterContext): Promise<RunResult[]> {
    const o = ctx.options;
    const url = String(o.rpc_url), tag = String(o.tag);
    const movePct = num(o, 'move_pct', 5);
    const actMin = num(o, 'activity_minutes', 30);
    const batchSize = num(o, 'batch_subcalls', 20);
    const batchGapMs = num(o, 'batch_interval_ms', 5000);
    const minHolders = num(o, 'min_holders', 2);
    const dexCap = num(o, 'dexscreener_cap', 60);
    const dexGapMs = num(o, 'dexscreener_interval_ms', DEFAULT_INTERVAL_MS);
    const denylist = new Set(strList(o, 'denylist_mints', DEFAULT_DENYLIST));
    const started = Date.now();
    const cycleAt = new Date();
    let s1req = 0, s1sub = 0, s2req = 0, s3req = 0, s1fail = 0;
    const failures: Record<string, string> = {};

    // WRITTEN AT CYCLE START, before any work. A cycle killed by the abort
    // guard throws out of fetch() and never reaches persist(), so without this
    // the worst cycles would be the ones leaving no evidence at all -- the
    // exact blind spot that produced four wrong diagnoses on group1.
    await ctx.db.query(
      `insert into mos_p1_test_stats (cycle_at, completed) values ($1, false)
       on conflict (cycle_at) do nothing`, [cycleAt]);

    const abort = (): void => { if (ctx.signal.aborted) throw new Error('run aborted'); };
    const sleep = (ms: number): Promise<void> => new Promise((res, rej) => {
      const t = setTimeout(res, ms);
      ctx.signal.addEventListener('abort',
        () => { clearTimeout(t); rej(new Error('run aborted')); }, { once: true });
    });
    const post = async (body: unknown): Promise<unknown> => {
      const r = await fetch(url, { method: 'POST', signal: ctx.signal,
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    };

    // ---- the cohort: read as-is (base58 is case-sensitive) ----------------
    const wq = await ctx.db.query(
      `select wallet from wallet_tags where tag = $1 and chain = 'solana'
        order by wallet`, [tag]);
    const all = (wq.rows as Record<string, unknown>[]).map((r) => String(r.wallet));
    const batchq = await ctx.db.query(
      `select wallet from mos_p1_test_batch order by wallet`);
    const inBatch = new Set((batchq.rows as Record<string, unknown>[]).map((r) => String(r.wallet)));
    const wallets = all.filter((w) => inBatch.has(w));
    if (!wallets.length) throw new Error(`no test_batch wallets found for tag ${tag}`);

    // ---- STAGE 1: balances, both programs, chunked ------------------------
    abort();
    const subs: Record<string, unknown>[] = [];
    const idMap: { wallet: string; program: string }[] = [];
    for (const w of wallets) {
      for (const prog of [TOKEN_LEGACY, TOKEN_2022]) {
        subs.push({ jsonrpc: '2.0', id: idMap.length, method: 'getTokenAccountsByOwner',
          params: [w, { programId: prog }, { encoding: 'jsonParsed' }] });
        idMap.push({ wallet: w, program: prog });
      }
    }
    s1sub = subs.length;

    const held = new Map<string, Map<string, { amount: bigint; dec: number; prog: string }>>();
    // Counts RESPONSES, not successes-so-far: a wallet is only read when both of
    // its sub-calls actually came back. A response merely missing from the array
    // would otherwise leave a wallet looking read with half its accounts.
    const answered = new Map<string, number>();

    for (let i = 0; i < subs.length; i += batchSize) {
      const chunk = subs.slice(i, i + batchSize);
      if (i > 0) await sleep(batchGapMs);
      abort();
      s1req++;
      let raw: Record<string, unknown>[] = [];
      try {
        const j = await post(chunk);
        raw = (Array.isArray(j) ? j : [j]) as Record<string, unknown>[];
      } catch (e) {
        // THIS CHUNK FAILED, and only this chunk. Its wallets are unread, not
        // empty; the other chunks stand on their own.
        s1fail++;
        const msg = e instanceof Error ? e.message : String(e);
        for (const s of chunk) {
          const meta = idMap[Number(s.id)];
          if (meta) failures[meta.wallet] = `stage1: ${msg}`;
        }
        continue;
      }
      for (const entry of raw) {
        const meta = idMap[Number(entry.id)];
        if (!meta) continue;
        if (entry.error) {
          failures[meta.wallet] = String((entry.error as { message?: string }).message ?? 'rpc error');
          continue;
        }
        answered.set(meta.wallet, (answered.get(meta.wallet) ?? 0) + 1);
        const value = ((entry.result as Record<string, unknown>)?.value ?? []) as Record<string, unknown>[];
        let m = held.get(meta.wallet);
        if (!m) { m = new Map(); held.set(meta.wallet, m); }
        for (const a of value) {
          const info = ((a.account as Record<string, unknown>)?.data as Record<string, unknown>)
            ?.parsed as Record<string, unknown> | undefined;
          const inf = info?.info as Record<string, unknown> | undefined;
          const ta = inf?.tokenAmount as Record<string, unknown> | undefined;
          if (!inf?.mint || !ta) continue;
          const mint = String(inf.mint);
          const amt = BigInt(String(ta.amount ?? '0'));
          const prev = m.get(mint);
          m.set(mint, { amount: (prev?.amount ?? 0n) + amt, dec: Number(ta.decimals ?? 0), prog: meta.program });
        }
      }
    }
    // A wallet is only "read" when BOTH of its sub-calls came back and neither
    // errored. A partial read is recorded as a failure, never as a balance.
    for (const w of wallets) {
      const n = answered.get(w) ?? 0;
      if (failures[w] === undefined && n > 0 && n < 2)
        failures[w] = `stage1: partial read, ${n} of 2 sub-calls returned`;
    }
    const bothOk = wallets.filter((w) => (answered.get(w) ?? 0) === 2 && failures[w] === undefined);

    const snaps: Snap[] = [];
    for (const w of wallets) {
      if (failures[w] !== undefined || (answered.get(w) ?? 0) < 2) {
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
    // NOT new Date(String(...)). pg returns a Date; String() renders it as
    // "Wed Sep 03 2026 04:09:37 GMT+0000 (...)", which DROPS MILLISECONDS.
    // cycle_at values carry them, so the reparsed value missed every row and
    // four cycles reported flagged 0 while five positions should have flagged.
    const prevRaw = prevCycle.rows[0]?.c ?? null;
    const prevAt = prevRaw === null ? null : new Date(prevRaw as string | number | Date);
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

    // ---- STAGE 2b: which mints the cohort holds, and which cross a high ----
    // HOLDING MEANS A POSITIVE BALANCE. 82.4% of the cohort's token accounts sit
    // at exactly 0 -- accounts opened and drained -- and counting those as
    // holders would put a number on the line that means nothing.
    const holders = new Map<string, { n: number; total: bigint; dec: number }>();
    for (const w of bothOk) {
      const m = held.get(w);
      if (!m) continue;
      for (const [mint, v] of m) {
        if (v.amount <= 0n) continue;
        const cur = holders.get(mint) ?? { n: 0, total: 0n, dec: v.dec };
        cur.n++; cur.total += v.amount;
        holders.set(mint, cur);
      }
    }
    const mintsHeld = holders.size;
    let belowFloor = 0, denied = 0;
    const candidates: string[] = [];
    for (const [mint, v] of holders) {
      if (denylist.has(mint)) { denied++; continue; }
      if (v.n < minHolders) { belowFloor++; continue; }
      candidates.push(mint);
    }

    const highs = new Map<string, number>();
    if (candidates.length) {
      const h = await ctx.db.query(
        `select mint, last_alerted_count from mos_p1_mint_alerts where mint = any($1::text[])`,
        [candidates]);
      for (const r of h.rows as Record<string, unknown>[])
        highs.set(String(r.mint), Number(r.last_alerted_count));
    }

    // BOOTSTRAP. On an empty table every one of the ~5,900 mints the cohort
    // already holds would clear a zero high-water mark at once. The first cycle
    // therefore records what is already held and sends nothing; from then on a
    // line means the count genuinely rose.
    const seededQ = await ctx.db.query(`select count(*)::int n from mos_p1_mint_alerts`);
    const bootstrap = Number((seededQ.rows[0] as Record<string, unknown>).n) === 0;

    const crossing = candidates.filter((m) => (holders.get(m)!.n) > (highs.get(m) ?? 0));
    const suppressed = candidates.length - crossing.length;

    const seeds: Alerted[] = bootstrap
      ? candidates.map((m) => ({ mint: m, count: holders.get(m)!.n, symbol: null }))
      : [];

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

    // ---- STAGE 4: symbols for the lines that will actually be sent ---------
    // Only crossing mints are resolved. Resolving everything the cohort holds
    // would be ~5,900 requests a cycle to label lines nobody will see.
    const lines: MintLine[] = [];
    let dexReq = 0, dexFailed = 0, unresolved = 0, dexTruncated = 0;
    if (!bootstrap && crossing.length) {
      const ordered = [...crossing].sort((a, b) => holders.get(b)!.n - holders.get(a)!.n);
      const resolvable = ordered.slice(0, dexCap);
      dexTruncated = ordered.length - resolvable.length;
      const symbolOf = new Map<string, { symbol: string | null; url: string | null }>();
      for (const mint of resolvable) {
        abort();
        if (dexReq > 0) await sleep(dexGapMs);
        dexReq++;
        const r = await resolveMint(mint, ctx.signal);
        if (r.state === 'ok') symbolOf.set(mint, { symbol: r.symbol, url: r.url });
        else {
          if (r.state === 'failed') dexFailed++;
          unresolved++;
          symbolOf.set(mint, { symbol: null, url: null });
        }
      }
      for (const mint of ordered) {
        const v = holders.get(mint)!;
        const s = symbolOf.get(mint);
        // A MINT PAST THE RESOLVER CAP STILL GETS A LINE, unlabelled. Dropping
        // it would raise no high-water mark and quietly lose the mint.
        if (!s) unresolved++;
        const prev = highs.get(mint);

        // WHAT ACTUALLY TRIGGERED THE LINE. `total` is cohort-wide and can be
        // dominated by a wallet that has held for hours: ANSEM alerted at
        // "13 wallets · 12,789" where one long-standing wallet held 12,150 and
        // the new holder brought 617.
        //
        // A HOLDER WITH NO PRIOR SNAPSHOT MAKES THIS UNKNOWN, NOT ZERO. It
        // cannot be compared, so the true figure could be larger, and the whole
        // segment is dropped rather than understated.
        let freshHolders = 0, freshAmt = 0n, incomparable = false;
        for (const w of bothOk) {
          const cur = held.get(w)?.get(mint);
          if (!cur || cur.amount <= 0n) continue;      // not a holder now
          const was = prior.get(w);
          if (!was) { incomparable = true; continue; }
          if ((was.get(mint) ?? 0n) === 0n) { freshHolders++; freshAmt += cur.amount; }
        }
        const newAmount = incomparable || freshHolders === 0 || freshHolders === v.n
          ? null                                       // unknown, none, or "all of it"
          : Number(freshAmt) / Math.pow(10, v.dec);

        lines.push({ mint, symbol: s?.symbol ?? null, url: s?.url ?? null,
          wallets: v.n, total: Number(v.total) / Math.pow(10, v.dec),
          growth: prev === undefined ? null : v.n - prev, newAmount });
      }
    }
    const { parts, duplicateSymbols } = renderAlert(lines);
    const messageText = parts.join('\n---\n');

    const skipped = wallets.length - bothOk.length;
    const stats = {
      walletsTotal: wallets.length, walletsRead: bothOk.length,
      walletsFlagged: flagged.length, walletsSkipped: skipped, mintsNew: newMints,
      stage1Requests: s1req, stage1Subcalls: s1sub, stage2Requests: s2req,
      stage3Requests: s3req, batchRequests: s1req, batchFailures: s1fail,
      mintsHeld, mintsCandidate: candidates.length, mintsBelowFloor: belowFloor,
      mintsDenylisted: denied, mintsAlerted: lines.length, mintsSuppressed: suppressed,
      symbolsUnresolved: unresolved, dexscreenerRequests: dexReq,
      dexscreenerFailed: dexFailed, dexscreenerTruncated: dexTruncated,
      duplicateSymbols, alertParts: parts.length,
      totalRequests: s1req + s2req + s3req + dexReq,
      durationMs: Date.now() - started,
    };
    ctx.log.info('mos-p1 cycle', { ...stats, bootstrap, firstCycle: prevAt === null,
      failures: Object.keys(failures).length ? failures : undefined });
    return [{ cycleAt, snaps, acts, flagged, newMints, skipped,
      walletsRead: bothOk.length, failures, bootstrap,
      alerted: lines.map((l) => ({ mint: l.mint, count: l.wallets, symbol: l.symbol })),
      seeds, parts, messageText, stats }];
  },

  async persist(ctx, client: PoolClient, records): Promise<number> {
    const r = records[0];
    if (!r) return 0;
    const sendAlerts = ctx.options.send_alerts !== false;
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

    // The seed writes marks for mints nobody was told about, which is the point:
    // it is the record of what the cohort already held before alerting began.
    if (r.bootstrap && r.seeds.length) {
      for (let i = 0; i < r.seeds.length; i += 500) {
        const b = r.seeds.slice(i, i + 500);
        await client.query(
          `insert into mos_p1_mint_alerts (mint, last_alerted_count, seeded)
           select *, true from unnest($1::text[], $2::int[])
           on conflict (mint) do nothing`,
          [b.map((x) => x.mint), b.map((x) => x.count)]);
      }
      ctx.log.info('mos-p1 bootstrap seeded high-water marks', { mints: r.seeds.length });
    }

    // ONLY WHAT WAS ACTUALLY SENT raises the high-water mark. A mint whose line
    // was rendered but not queued must keep its old high, or it is retired from
    // alerting without ever having been reported.
    if (r.alerted.length && sendAlerts) {
      for (const a of r.alerted) {
        await client.query(
          `insert into mos_p1_mint_alerts
             (mint, last_alerted_count, last_alerted_at, first_alerted_at, symbol, seeded)
           values ($1,$2,now(),now(),$3,false)
           on conflict (mint) do update set
             last_alerted_count = excluded.last_alerted_count,
             last_alerted_at = now(),
             symbol = coalesce(excluded.symbol, mos_p1_mint_alerts.symbol),
             -- A SEEDED ROW HAS NEVER BEEN ALERTED. Its bootstrap timestamp is
             -- not a first alert, so the first real alert stamps it here and
             -- clears the flag. A row that has genuinely alerted before keeps
             -- its original first_alerted_at.
             first_alerted_at = case when mos_p1_mint_alerts.seeded then now()
                                     else mos_p1_mint_alerts.first_alerted_at end,
             seeded = false`,
          [a.mint, a.count, a.symbol]);
      }
    }

    await client.query(
      `update mos_p1_test_stats set finished_at = now(), completed = true,
         wallets_total=$2, wallets_read=$3, wallets_flagged=$4, wallets_skipped=$5,
         mints_new=$6, stage1_requests=$7, stage1_subcalls=$8, stage2_requests=$9,
         stage3_requests=$10, total_requests=$11, duration_ms=$12, failures=$13,
         mints_held=$14, mints_candidate=$15, mints_below_floor=$16,
         mints_denylisted=$17, mints_alerted=$18, mints_suppressed=$19,
         symbols_unresolved=$20, dexscreener_requests=$21, dexscreener_failed=$22,
         duplicate_symbols=$23, alert_parts=$24, bootstrap=$25,
         batch_requests=$26, batch_failures=$27, message_text=$28
       where cycle_at = $1`,
      [r.cycleAt, r.stats.walletsTotal, r.stats.walletsRead, r.stats.walletsFlagged,
       r.stats.walletsSkipped, r.stats.mintsNew, r.stats.stage1Requests,
       r.stats.stage1Subcalls, r.stats.stage2Requests, r.stats.stage3Requests,
       r.stats.totalRequests, r.stats.durationMs, JSON.stringify(r.failures),
       r.stats.mintsHeld, r.stats.mintsCandidate, r.stats.mintsBelowFloor,
       r.stats.mintsDenylisted, r.stats.mintsAlerted, r.stats.mintsSuppressed,
       r.stats.symbolsUnresolved, r.stats.dexscreenerRequests, r.stats.dexscreenerFailed,
       r.stats.duplicateSymbols, r.stats.alertParts, r.bootstrap,
       r.stats.batchRequests, r.stats.batchFailures, r.messageText || null]);

    if (r.bootstrap) {
      ctx.log.info('mos-p1 bootstrap cycle: nothing sent', { seeded: r.seeds.length });
    } else if (r.parts.length && sendAlerts) {
      for (const p of r.parts)
        ctx.queueAlert({ level: 'warning', title: 'MOS-P1', description: p });
      ctx.log.info('queued alert parts', { parts: r.parts.length, mints: r.alerted.length });
    } else if (r.parts.length) {
      ctx.log.info('send_alerts is false; rendered but not queued', { parts: r.parts.length });
    } else {
      ctx.log.info('no mint crossed its high-water mark; nothing to alert');
    }
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

/**
 * New-token watch — wallets we already know, buying tokens that just launched.
 *
 * WALLET-FIRST, AND THAT WAS MEASURED, NOT ASSUMED. The obvious design is
 * pool-first: find new pools, pull their swaps, attribute wallets. Measured on
 * chain 4663 that is 17,642 pools and 183,201 swaps per hour, of which 117,101
 * sit in pools under a day old. Attributing those by balance delta needs a
 * receipt per transaction, and at this project's measured receipt rate
 * (9-10/s) one hourly cycle would take about 3.6 hours. It cannot keep up.
 *
 * Wallet-first inverts it: ask only for Transfer logs whose `to` is a
 * watchlist wallet. That is 52-80 requests per cycle and needs NO receipts,
 * because an inbound Transfer to a known wallet already IS the balance-delta
 * evidence the pipeline would have reconstructed. Measured: 127 requests and
 * 5.3 minutes for a full cycle, entirely on the free public RPC.
 *
 * A TRANSFER IS NOT A BUY. An airdrop also arrives as an inbound Transfer, and
 * this chain has a lot of them. Only transfers sent BY a venue contract count —
 * on v4 that is the PoolManager, which hands the token to the buyer directly.
 * Measured: 7,700 inbound transfers per hour, of which 1,980 come from the
 * PoolManager. Without this rule the monitor is a spam feed.
 *
 * POOL AGE IS THE POINT. Of those 1,980, tokens whose pool is under two hours
 * old account for 1,119 transfers across 53 tokens and 217 wallets. The 24-hour
 * equivalent is 155 tokens, so the age rule removes two thirds of the tokens.
 *
 * KNOWN GAP: v3 launches are invisible. Everything here keys off the v4
 * PoolManager's Initialize event. PONS was a v3 pool and would not appear.
 * Covering v3 needs each factory address and its PoolCreated topic.
 *
 * SENDS NOTHING TO DISCORD. Content alerting is deliberately not wired yet;
 * only the spine's own failure/recovery alerts apply.
 */
import type { AdapterContext, SourceAdapter } from './types.js';
import { requireString } from './types.js';
import type { PoolClient } from '../store/db.js';
import { migrate } from './new-token-watch/schema.js';
import { loadWatchlist, type WatchWallet } from './new-token-watch/watchlist.js';
import { PublicRpc, topicAddress, padAddress, type RpcLog } from './new-token-watch/rpc.js';
import { renderMessages, type HitRow, type MessagePart } from './new-token-watch/message.js';

interface Hit {
  chain: string;
  token: string;
  wallet: string;
  transfers: number;
  createdBlock: number;
  createdAt: Date;
  poolId: string | null;
  cohorts: number;
  totalRealizedUsd: number;
  crossToken: boolean;
}

interface RunResult {
  hits: Hit[];
  /**
   * EVERY pool creation observed in this cycle's sweep, not just the ones that
   * produced a hit.
   *
   * This is a correctness requirement, not an optimisation. Sweeps are
   * incremental, so a token created 90 minutes ago appears in the PREVIOUS
   * cycle's sweep and in no later one. If only hit-producing tokens were
   * cached, that token would be unresolvable on this cycle and silently
   * dropped despite being inside the 2-hour rule.
   */
  pools: { token: string; block: number; at: Date; poolId: string | null }[];
  /**
   * Rendered in fetch(); empty when the cycle produced no hits. Several parts
   * when the per-token list will not fit one embed -- it splits rather than
   * dropping tokens.
   */
  parts: MessagePart[];
  stats: Record<string, number>;
  sweptFrom: number;
  sweptTo: number;
}

const num = (o: Record<string, unknown>, k: string, d: number): number => {
  const v = o[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
};

const newTokenWatch: SourceAdapter<RunResult> = {
  type: 'new-token-watch',

  validate(options, monitorId) {
    requireString(options, 'chain', monitorId);
    requireString(options, 'rpc_url', monitorId);
    requireString(options, 'pool_manager', monitorId);
    requireString(options, 'initialize_topic', monitorId);
    requireString(options, 'transfer_topic', monitorId);
    for (const k of ['max_pool_age_minutes', 'lookback_hours', 'bootstrap_hours']) {
      if (num(options, k, -1) <= 0) throw new Error(`monitor "${monitorId}": options.${k} must be > 0`);
    }
    const chunk = num(options, 'watchlist_chunk', 200);
    // Measured ceiling on this chain: >1,000 selectors is rejected outright and
    // 500 times out. Failing at boot beats discovering it mid-run.
    if (chunk < 1 || chunk > 400) {
      throw new Error(`monitor "${monitorId}": options.watchlist_chunk must be 1..400 (measured: 500 times out)`);
    }
  },

  migrate,

  async fetch(ctx: AdapterContext): Promise<RunResult[]> {
    const o = ctx.options;
    const chain = String(o.chain);
    const PM = String(o.pool_manager).toLowerCase();
    const INIT = String(o.initialize_topic).toLowerCase();
    const TRANSFER = String(o.transfer_topic).toLowerCase();
    const maxAgeMin = num(o, 'max_pool_age_minutes', 120);
    const lookbackH = num(o, 'lookback_hours', 1);
    const bootstrapH = num(o, 'bootstrap_hours', 24);
    const chunkSize = num(o, 'watchlist_chunk', 200);
    const transferWindow = num(o, 'transfer_block_window', 10_000);
    const sweepWindow = num(o, 'sweep_block_window', 20_000);
    const started = Date.now();

    const rpc = new PublicRpc(String(o.rpc_url), num(o, 'min_interval_ms', 1100), ctx.log, ctx.signal);
    const head = await rpc.blockNumber();

    // Block time is MEASURED each run rather than pinned. It sets both the
    // lookback range and every pool age, so a stale constant would mis-age
    // every token at once.
    const probe = Math.max(1, head - 100_000);
    const [tHead, tProbe] = [await rpc.blockTimestamp(head), await rpc.blockTimestamp(probe)];
    const blockSeconds = (tHead - tProbe) / (head - probe);
    if (!(blockSeconds > 0) || !Number.isFinite(blockSeconds)) {
      throw new Error(`implausible block time ${blockSeconds}`);
    }
    const perHour = Math.floor(3600 / blockSeconds);

    // ---- sweep Initialize, incremental from the cursor -------------------
    const cur = await ctx.db.query(
      `select last_swept_block from new_token_cursor where chain = $1`, [chain]);
    // THE CATCH-UP IS BOUNDED. Without this the sweep grows for every hour the
    // monitor is down, so a run that failed on duration makes the next run
    // longer and more likely to fail again -- a spiral, not a blip. Anything
    // older than bootstrap_hours is necessarily older than max_pool_age_minutes
    // and would be dropped by the age rule regardless, so skipping it costs
    // nothing except the wasted requests it avoids.
    const floorBlock = head - Math.floor(perHour * bootstrapH);
    const rawFrom = cur.rows.length
      ? Number(cur.rows[0].last_swept_block) + 1
      : floorBlock;
    const sweptFrom = Math.max(rawFrom, floorBlock);
    const skippedBlocks = Math.max(0, sweptFrom - rawFrom);
    if (skippedBlocks > 0) {
      ctx.log.warn('sweep catch-up capped at bootstrap_hours', {
        cursorWanted: rawFrom, sweepingFrom: sweptFrom, skippedBlocks,
        skippedHours: Number((skippedBlocks / perHour).toFixed(2)),
        bootstrapHours: bootstrapH,
      });
    }
    const initLogs = sweptFrom <= head
      ? await rpc.logsRange({ address: PM, topics: [INIT] }, sweptFrom, head, sweepWindow)
      : [];
    // topics[1] is the poolId, which is what DexScreener uses as the pair
    // address on v4 and therefore what a link needs. Earlier versions read only
    // the two currency topics and threw the poolId away.
    const created = new Map<string, { block: number; poolId: string }>();
    for (const l of initLogs) {
      const block = Number.parseInt(l.blockNumber, 16);
      const poolId = String(l.topics[1] ?? '').toLowerCase();
      for (const t of [topicAddress(l.topics[2]), topicAddress(l.topics[3])]) {
        const prev = created.get(t);
        if (prev === undefined || block < prev.block) created.set(t, { block, poolId });
      }
    }
    ctx.log.info('initialize sweep', {
      from: sweptFrom, to: head, logs: initLogs.length, tokens: created.size,
    });

    // ---- inbound transfers to watchlist wallets --------------------------
    const watchlist = await loadWatchlist(ctx.db, chain);
    const byWallet = new Map(watchlist.map((w) => [w.wallet, w]));
    const lo = head - Math.floor(perHour * lookbackH);
    const addrs = watchlist.map((w) => padAddress(w.wallet));
    const transfers: RpcLog[] = [];
    for (let i = 0; i < addrs.length; i += chunkSize) {
      const part = addrs.slice(i, i + chunkSize);
      transfers.push(...(await rpc.logsRange(
        { topics: [TRANSFER, null, part] }, lo, head, transferWindow)));
    }
    const venue = transfers.filter((l) => topicAddress(l.topics[1]) === PM);

    // ---- age lookup: cache first, once per distinct token ----------------
    const distinct = [...new Set(venue.map((l) => l.address.toLowerCase()))];
    const cached = distinct.length
      ? await ctx.db.query(
          `select token, created_block, created_at, older_than_sweep, pool_id
             from token_pool_first where chain = $1 and token = any($2::text[])`,
          [chain, distinct])
      : { rows: [] as Record<string, unknown>[] };
    const cache = new Map<string, { block: number | null; at: Date | null; old: boolean; poolId: string | null }>();
    for (const r of cached.rows as Record<string, unknown>[]) {
      cache.set(String(r.token), {
        block: r.created_block === null ? null : Number(r.created_block),
        at: r.created_at ? new Date(String(r.created_at)) : null,
        old: r.older_than_sweep === true,
        poolId: r.pool_id === null || r.pool_id === undefined ? null : String(r.pool_id),
      });
    }
    let hits = 0, misses = 0, negatives = 0;
    const resolved = new Map<string, { block: number; at: Date; poolId: string | null } | null>();
    for (const token of distinct) {
      const c = cache.get(token);
      if (c) {
        hits++;
        // A cache row written before poolId was captured has none; the sweep may
        // still know it, so prefer the sweep's value when the cache lacks one.
        const swept = created.get(token);
        resolved.set(token, c.old || c.block === null || !c.at ? null
          : { block: c.block, at: c.at, poolId: c.poolId ?? swept?.poolId ?? null });
        continue;
      }
      misses++;
      const entry = created.get(token);
      if (entry === undefined) {
        // Not created inside any window we have swept, so it is older than our
        // coverage. Cached as a NEGATIVE so it is never looked up again.
        negatives++;
        resolved.set(token, null);
        continue;
      }
      resolved.set(token, {
        block: entry.block, poolId: entry.poolId,
        at: new Date((tHead - (head - entry.block) * blockSeconds) * 1000),
      });
    }

    // ---- apply the age rule ----------------------------------------------
    const maxAgeBlocks = (maxAgeMin * 60) / blockSeconds;
    const agg = new Map<string, Hit>();
    for (const l of venue) {
      const token = l.address.toLowerCase();
      const r = resolved.get(token);
      if (!r) continue;
      if (head - r.block > maxAgeBlocks) continue;
      const wallet = topicAddress(l.topics[2]);
      const w = byWallet.get(wallet);
      if (!w) continue;
      const key = `${token}|${wallet}`;
      const existing = agg.get(key);
      if (existing) { existing.transfers++; continue; }
      agg.set(key, {
        chain, token, wallet, transfers: 1,
        createdBlock: r.block, createdAt: r.at, poolId: r.poolId,
        cohorts: w.cohorts, totalRealizedUsd: w.totalRealizedUsd, crossToken: w.crossToken,
      });
    }
    const out = [...agg.values()];

    // ---- render the hourly message (no send here; the spine flushes it) ---
    let parts: MessagePart[] = [];
    if (out.length) {
      const cl = await ctx.db.query(
        `select lower(wallet) w, min(cluster_id) cid from wallet_clusters
          where chain = $1 and lower(wallet) = any($2::text[]) group by 1`,
        [chain, [...new Set(out.map((h) => h.wallet))]]);
      const clusterOf = new Map(
        (cl.rows as Record<string, unknown>[]).map((r) => [String(r.w), String(r.cid)]));
      const rows: HitRow[] = out.map((h) => ({
        token: h.token, wallet: h.wallet, cohorts: h.cohorts,
        totalRealizedUsd: h.totalRealizedUsd, crossToken: h.crossToken,
        poolAgeMinutes: (Date.now() - h.createdAt.getTime()) / 60_000,
        clusterId: clusterOf.get(h.wallet) ?? null,
        poolId: h.poolId,
      }));
      // Symbols cost one eth_call each, so only the tokens that will actually
      // be printed get looked up -- the lead sections are capped, and the run
      // sits close to the spine's 5-minute ceiling.
      const lead = rows.filter((r) => r.crossToken || r.clusterId)
        .sort((a, b) => b.totalRealizedUsd - a.totalRealizedUsd);
      const wanted = [...new Set(lead.map((r) => r.token))].slice(0, 30);
      const symbols = new Map<string, string>();
      for (const t of wanted) {
        try {
          const hex = String(await rpc.call('eth_call', [{ to: t, data: '0x95d89b41' }, 'latest']));
          if (hex && hex !== '0x') {
            const b = Buffer.from(hex.slice(2), 'hex');
            const raw = b.length >= 64
              ? b.subarray(64, 64 + Number(BigInt('0x' + b.subarray(32, 64).toString('hex')))).toString('utf8')
              : b.toString('utf8');
            const clean = raw.replace(/\0/g, '').trim();
            if (clean) symbols.set(t, clean);
          }
        } catch {
          // A missing symbol is cosmetic: the row still prints by address.
        }
      }
      for (const r of rows) r.symbol = symbols.get(r.token) ?? null;
      const start = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);
      const label = `${start.toISOString().slice(11, 16)}–`
        + `${new Date(start.getTime() + 3_600_000).toISOString().slice(11, 16)} UTC`;
      parts = renderMessages(rows, label);
    }

    ctx.log.info('new-token watch cycle', {
      requests: rpc.requests, transfers: transfers.length, venueTransfers: venue.length,
      distinctTokens: distinct.length, cacheHits: hits, cacheMisses: misses,
      cacheNegatives: negatives, tokens: new Set(out.map((h) => h.token)).size,
      wallets: new Set(out.map((h) => h.wallet)).size, rows: out.length,
    });
    return [{
      hits: out,
      parts,
      pools: [...created.entries()].map(([token, e]) => ({
        token, block: e.block, poolId: e.poolId,
        at: new Date((tHead - (head - e.block) * blockSeconds) * 1000),
      })),
      stats: {
        head, blockSeconds, requests: rpc.requests, transfers: transfers.length,
        venueTransfers: venue.length, distinctTokens: distinct.length,
        cacheHits: hits, cacheMisses: misses, cacheNegatives: negatives,
        tokens: new Set(out.map((h) => h.token)).size,
        wallets: new Set(out.map((h) => h.wallet)).size,
        rows: out.length, durationMs: Date.now() - started,
      },
      sweptFrom, sweptTo: head,
    }];
  },

  async persist(ctx, client: PoolClient, records): Promise<number> {
    const r = records[0];
    if (!r) return 0;
    const chain = String(ctx.options.chain);
    const retentionH = num(ctx.options, 'retention_hours', 24);

    // Cache every creation this sweep observed. Chunked: a bootstrap sweep
    // carries thousands of tokens and one unnest of that size is a large
    // parameter payload.
    let cached = 0;
    for (let i = 0; i < r.pools.length; i += 500) {
      const b = r.pools.slice(i, i + 500);
      const res = await client.query(
        `insert into token_pool_first (token, chain, created_block, created_at, older_than_sweep, pool_id)
         select * from unnest($1::text[], $2::text[], $3::bigint[], $4::timestamptz[], $5::boolean[], $6::text[])
         on conflict (token) do update set
           created_block = least(token_pool_first.created_block, excluded.created_block),
           created_at = least(token_pool_first.created_at, excluded.created_at),
           older_than_sweep = false,
           pool_id = coalesce(token_pool_first.pool_id, excluded.pool_id)`,
        [b.map((p) => p.token), b.map(() => chain), b.map((p) => p.block),
         b.map((p) => p.at), b.map(() => false), b.map((p) => p.poolId)]);
      cached += res.rowCount ?? 0;
    }
    ctx.log.info('pool cache', { observed: r.pools.length, written: cached });

    const bucket = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);
    let rows = 0;
    for (let i = 0; i < r.hits.length; i += 200) {
      const b = r.hits.slice(i, i + 200);
      const res = await client.query(
        `insert into new_token_hits (hour_bucket, chain, token, wallet, n_transfers,
             pool_created_block, pool_created_at, cohorts, total_realized_usd, cross_token)
         select $1, * from unnest($2::text[], $3::text[], $4::text[], $5::int[],
             $6::bigint[], $7::timestamptz[], $8::int[], $9::numeric[], $10::boolean[])
         on conflict (hour_bucket, chain, token, wallet) do update set
           n_transfers = greatest(new_token_hits.n_transfers, excluded.n_transfers)`,
        [bucket, b.map((h) => h.chain), b.map((h) => h.token), b.map((h) => h.wallet),
         b.map((h) => h.transfers), b.map((h) => h.createdBlock), b.map((h) => h.createdAt),
         b.map((h) => h.cohorts), b.map((h) => h.totalRealizedUsd), b.map((h) => h.crossToken)]);
      rows += res.rowCount ?? 0;
    }

    await client.query(
      `insert into new_token_cursor (chain, last_swept_block) values ($1, $2)
       on conflict (chain) do update set last_swept_block = excluded.last_swept_block`,
      [chain, r.sweptTo]);
    await client.query(
      `insert into new_token_cycle_stats (ran_at, head_block, block_seconds, requests,
         transfers_seen, venue_transfers, distinct_tokens, cache_hits, cache_misses,
         cache_negative, tokens_alerted, wallets_alerted, rows_written, swept_from,
         swept_to, duration_ms)
       values (now(), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [r.stats.head, r.stats.blockSeconds, r.stats.requests, r.stats.transfers,
       r.stats.venueTransfers, r.stats.distinctTokens, r.stats.cacheHits, r.stats.cacheMisses,
       r.stats.cacheNegatives, r.stats.tokens, r.stats.wallets, rows, r.sweptFrom,
       r.sweptTo, r.stats.durationMs]);

    // Rolling retention. token_pool_first is DELIBERATELY not in here.
    const cut = `now() - interval '${Math.floor(retentionH)} hours'`;
    const d1 = await client.query(`delete from new_token_hits where hour_bucket < ${cut}`);
    const d2 = await client.query(`delete from new_token_cycle_stats where ran_at < ${cut}`);
    ctx.log.info('retention', { hitsDeleted: d1.rowCount ?? 0, statsDeleted: d2.rowCount ?? 0 });

    // Queued, not sent: the spine flushes alerts after the transaction commits.
    const sendAlerts = ctx.options.send_alerts !== false;
    const chars = r.parts.reduce((n, p) => n + p.description.length, 0);
    if (r.parts.length && sendAlerts) {
      // One queued alert per part; the spine posts each as its own message, so a
      // long per-token list splits instead of being cut.
      for (const p of r.parts) {
        // 'warning' is this spine's convention for a content alert; the levels
        // are critical/warning/recovery and there is no informational tier.
        ctx.queueAlert({ level: 'warning', title: p.title, description: p.description });
      }
      ctx.log.info('queued alert parts', { parts: r.parts.length, chars });
    } else if (r.parts.length) {
      ctx.log.info('send_alerts is false; parts rendered but not queued',
        { parts: r.parts.length, chars });
    } else {
      ctx.log.info('no hits this cycle; nothing queued');
    }
    return rows;
  },
};

export default newTokenWatch;

/**
 * NFT mint collector — Solana + EVM, individual mint level.
 *
 * COLLECTION ONLY. It scores nothing and alerts on nothing; the daily digest is
 * a later, separate monitor that reads this table. That split is deliberate:
 * the filter thresholds below will be retuned, and retuning a reader must never
 * put collection at risk.
 *
 * WHY FILTERING IS NOT OPTIONAL. Measured before any of this was written:
 * chain 4663 alone produces 674,759 ERC-721 mints/day, of which 61.5% are a
 * single farm collection and ~8.6% are DEX liquidity-position NFTs, which are
 * not collectibles. Unfiltered this table adds ~6.1 GB/month and fills the
 * remaining volume in about eight months. Filtered it is ~0.3 GB/month.
 *
 * WHY REJECTIONS ARE COUNTED. A filter that matches nothing and a filter that
 * matches everything look identical from outside. The early_snapshots retention
 * gate matched almost nothing for days while reporting success, and the volume
 * filled. Every drop here is counted per day, per chain, per rule into
 * nft_mint_filter_stats — aggregate counts only, never the rejected rows.
 *
 * RETENTION SHIPS WITH THE COLLECTOR, not after it. Full detail for
 * full_detail_days, then collapsed into nft_mint_daily, then aggregates purged.
 * Rows belonging to a known wallet are never purged, because those are the ones
 * the whole exercise exists to find.
 */

import type { AdapterContext, PanelContext, SourceAdapter } from './types.js';
import type { PoolClient } from '../store/db.js';
import { configNumber, requireString, section } from './types.js';
import { SCHEMA } from './nft-mints/schema.js';
import {
  applyFilters, dayKey, RejectionLog,
  type CandidateMint, type FilterConfig,
} from './nft-mints/filters.js';
import {
  evmBlockTimes, evmCollectionName, evmHeadBlock, fetchEvmMints, fetchSolanaMints,
  type EvmChainConfig, type SolanaConfig,
} from './nft-mints/sources.js';

interface RetentionConfig {
  fullDetailDays: number;
  aggregateAfterDays: number;
  purgeAggregatesDays: number;
  keepForeverIfKnownWallet: boolean;
}

interface NftConfig {
  solana: SolanaConfig | null;
  evm: EvmChainConfig[];
  filters: FilterConfig;
  retention: RetentionConfig;
  lookbackMinutes: number;
}

interface Drain {
  cfg: NftConfig;
  mints: CandidateMint[];
  rejections: RejectionLog;
  cursors: Array<{ chain: string; value: string }>;
  stats: Record<string, number>;
}

function parseConfig(options: Record<string, unknown>, monitorId: string): NftConfig {
  const ctx = `monitor "${monitorId}"`;
  const f = section(options, 'collection_filter');
  const r = section(options, 'retention');

  const sol = section(options, 'solana');
  const solana: SolanaConfig | null = sol.enabled === false ? null : {
    chain: 'solana',
    rpcUrl: requireString(sol, 'rpc_url', monitorId),
    pageLimit: configNumber(sol, 'page_limit', ctx, 1000),
    maxPagesPerRun: configNumber(sol, 'max_pages_per_run', ctx, 25),
    includeCompressed: sol.include_compressed === true,
  };

  const rawEvm = Array.isArray(options.evm_chains) ? options.evm_chains : [];
  const evm: EvmChainConfig[] = rawEvm.map((entry, i) => {
    const e = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
    if (e.enabled === false) return null;
    const name = requireString(e, 'chain', `${monitorId} evm_chains[${i}]`);
    return {
      chain: name,
      chainId: configNumber(e, 'chain_id', ctx, 0),
      rpcUrl: requireString(e, 'rpc_url', `${monitorId} evm_chains[${i}]`),
      blocksPerPass: configNumber(e, 'blocks_per_pass', ctx, 2000),
      maxPassesPerRun: configNumber(e, 'max_passes_per_run', ctx, 5),
    };
  }).filter((x): x is EvmChainConfig => x !== null);

  if (!solana && evm.length === 0) {
    throw new Error(`${ctx}: every chain is disabled — nothing would be collected`);
  }

  const retention: RetentionConfig = {
    fullDetailDays: configNumber(r, 'full_detail_days', ctx, 30),
    aggregateAfterDays: configNumber(r, 'aggregate_after_days', ctx, 30),
    purgeAggregatesDays: configNumber(r, 'purge_aggregates_days', ctx, 365),
    keepForeverIfKnownWallet: r.keep_forever_if_known_wallet !== false,
  };
  if (retention.purgeAggregatesDays <= retention.aggregateAfterDays) {
    throw new Error(`${ctx}: retention.purge_aggregates_days must exceed aggregate_after_days`);
  }

  return {
    solana,
    evm,
    filters: {
      excludeLpPositions: f.exclude_lp_positions !== false,
      maxMintsPerCollectionPerDay: configNumber(f, 'max_mints_per_collection_per_day', ctx, 500),
      minDistinctMintersPerDay: configNumber(f, 'min_distinct_minters_per_day', ctx, 5),
      includeCompressed: solana?.includeCompressed ?? false,
      // Derived from the configured EVM chains rather than listed separately,
      // so adding a chain cannot forget to enable the rule for it.
      lpRuleChains: new Set(evm.map((e) => e.chain)),
    },
    retention,
    lookbackMinutes: configNumber(options, 'lookback_minutes', ctx, 30),
  };
}

async function readCursor(db: AdapterContext['db'], monitorId: string, chain: string)
: Promise<string | null> {
  const r = await db.query<{ cursor_val: string }>(
    `select cursor_val from nft_mint_cursor where monitor_id = $1 and chain = $2`,
    [monitorId, chain],
  );
  return r.rows[0]?.cursor_val ?? null;
}

const nftMints: SourceAdapter<Drain> = {
  type: 'nft-mints',

  validate(options, monitorId) {
    parseConfig(options, monitorId);
  },

  async migrate(client) {
    await client.query(SCHEMA);
  },

  async fetch(ctx) {
    const cfg = parseConfig(ctx.options, ctx.monitorId);
    const rejections = new RejectionLog();
    const mints: CandidateMint[] = [];
    const cursors: Array<{ chain: string; value: string }> = [];
    const stats: Record<string, number> = {};

    /* ---- Solana, via DAS createdAt windows ---- */
    if (cfg.solana) {
      const last = await readCursor(ctx.db, ctx.monitorId, 'solana');
      const now = new Date();
      const defaultFrom = new Date(now.getTime() - cfg.lookbackMinutes * 60_000);
      const from = last ? new Date(last) : defaultFrom;
      // never re-scan more than the lookback, so a long outage does not turn
      // into an unbounded backfill on the next run
      const start = from.getTime() < defaultFrom.getTime() ? defaultFrom : from;
      const assets = await fetchSolanaMints(cfg.solana, start, now, ctx.signal);
      for (const a of assets) {
        mints.push({ ...a, blockTime: now });
      }
      stats.solana_seen = assets.length;
      cursors.push({ chain: 'solana', value: now.toISOString() });
    }

    /* ---- EVM chains ---- */
    for (const chain of cfg.evm) {
      const head = await evmHeadBlock(chain, ctx.signal);
      const last = await readCursor(ctx.db, ctx.monitorId, chain.chain);
      const lastBlock = last ? Number.parseInt(last, 10) : head - chain.blocksPerPass;
      let cursor = Number.isFinite(lastBlock) ? lastBlock : head - chain.blocksPerPass;
      // a restart after a long gap must not try to replay the whole chain
      const floor = head - chain.blocksPerPass * chain.maxPassesPerRun;
      if (cursor < floor) {
        stats[`${chain.chain}_skipped_blocks`] = floor - cursor;
        cursor = floor;
      }

      let seen = 0;
      const blockTimes = new Map<number, number>();
      const names = new Map<string, string | null>();
      for (let pass = 0; pass < chain.maxPassesPerRun && cursor < head; pass += 1) {
        const to = Math.min(cursor + chain.blocksPerPass, head);
        const { candidates, blocks } = await fetchEvmMints(chain, cursor + 1, to, ctx.signal);
        seen += candidates.length;

        const missing = [...blocks].filter((b) => !blockTimes.has(b));
        const times = await evmBlockTimes(chain, missing, ctx.signal);
        for (const [b, t] of times) blockTimes.set(b, t);

        for (const c of candidates) {
          const addr = c.collectionAddress;
          if (!names.has(addr)) {
            names.set(addr, await evmCollectionName(chain, addr, ctx.signal));
          }
        }
        for (const c of candidates) {
          const ts = blockTimes.get(c.blockNumber);
          if (ts === undefined) {
            // No timestamp means we cannot date the mint, and an undated row
            // would be invisible to every retention and digest query that keys
            // on block_time. Count it rather than storing a row dated 1970.
            rejections.reject(chain.chain, 'missing_minter');
            continue;
          }
          const { blockNumber: _bn, ...rest } = c;
          mints.push({
            ...rest,
            collectionName: names.get(c.collectionAddress) ?? null,
            blockTime: new Date(ts * 1000),
          });
        }
        cursor = to;
      }
      stats[`${chain.chain}_seen`] = seen;
      cursors.push({ chain: chain.chain, value: String(cursor) });
    }

    return [{ cfg, mints, rejections, cursors, stats }];
  },

  async persist(ctx, client, drains) {
    const drain = drains[0];
    if (!drain) return 0;
    const { cfg, mints, rejections } = drain;

    // prior counts for today, so the per-collection caps see the whole day
    const existing = new Map<string, { mints: number; minters: Set<string> }>();
    if (mints.length > 0) {
      const days = [...new Set(mints.map((m) => m.blockTime.toISOString().slice(0, 10)))];
      const rows = await client.query<{
        chain: string; collection_address: string; day_key: string;
        mints: string; minters: string[];
      }>(
        `select chain, collection_address,
                to_char(block_time::date,'YYYY-MM-DD') as day_key,
                count(*)::text as mints, array_agg(distinct minter_wallet) as minters
           from nft_mints
          where block_time::date = any($1::date[])
          group by 1,2,3`,
        [days],
      );
      for (const r of rows.rows) {
        existing.set(dayKey(r.chain, r.collection_address, r.day_key),
          { mints: Number(r.mints), minters: new Set(r.minters) });
      }
    }

    const kept = applyFilters(mints, cfg.filters, existing, rejections);

    let inserted = 0;
    if (kept.length > 0) {
      const res = await client.query(
        `insert into nft_mints (
           chain, collection_address, collection_name, token_id, mint_address,
           minter_wallet, block_time, mint_price, price_currency, tx_hash,
           compressed, is_known_wallet)
         select u.chain, u.collection_address, u.collection_name, u.token_id,
                u.mint_address, u.minter_wallet, u.block_time, u.mint_price,
                u.price_currency, u.tx_hash, u.compressed,
                exists (select 1 from wallet_pnl w where w.wallet = u.minter_wallet)
           from unnest($1::text[],$2::text[],$3::text[],$4::text[],$5::text[],
                       $6::text[],$7::timestamptz[],$8::numeric[],$9::text[],
                       $10::text[],$11::boolean[])
                as u(chain, collection_address, collection_name, token_id,
                     mint_address, minter_wallet, block_time, mint_price,
                     price_currency, tx_hash, compressed)
         on conflict (chain, collection_address, token_id, mint_address) do nothing`,
        [
          kept.map((k) => k.chain),
          kept.map((k) => k.collectionAddress),
          kept.map((k) => k.collectionName),
          kept.map((k) => k.tokenId),
          kept.map((k) => k.mintAddress),
          kept.map((k) => k.minterWallet),
          kept.map((k) => k.blockTime),
          kept.map((k) => k.mintPrice),
          kept.map((k) => k.priceCurrency),
          kept.map((k) => k.txHash),
          kept.map((k) => k.compressed),
        ],
      );
      inserted = res.rowCount ?? 0;
    }

    // rejection accounting — counts only, upserted per day/chain/rule
    const entries = rejections.entries();
    if (entries.length > 0) {
      await client.query(
        `insert into nft_mint_filter_stats (day, chain, rule, rejected)
         select current_date, u.chain, u.rule, u.n
           from unnest($1::text[],$2::text[],$3::bigint[]) as u(chain, rule, n)
         on conflict (day, chain, rule)
           do update set rejected = nft_mint_filter_stats.rejected + excluded.rejected`,
        [entries.map((e) => e[0]), entries.map((e) => e[1]), entries.map((e) => e[2])],
      );
    }

    for (const c of drain.cursors) {
      await client.query(
        `insert into nft_mint_cursor (monitor_id, chain, cursor_val, updated_at)
         values ($1::text,$2::text,$3::text, now())
         on conflict (monitor_id, chain)
           do update set cursor_val = excluded.cursor_val, updated_at = now()`,
        [ctx.monitorId, c.chain, c.value],
      );
    }

    const removed = await runRetention(client, cfg.retention);

    ctx.log.info('nft mints stored', {
      candidates: mints.length,
      kept: kept.length,
      inserted,
      rejected: rejections.total(),
      rejections: rejections.summary(),
      retention: removed,
      ...drain.stats,
    });
    return inserted;
  },

  async renderPanel(ctx: PanelContext) {
    const rows = await ctx.db.query<{ chain: string; n: string; wallets: string; known: string }>(
      `select chain, count(*)::text n, count(distinct minter_wallet)::text wallets,
              count(*) filter (where is_known_wallet)::text known
         from nft_mints
        where block_time > now() - ($1 || ' hours')::interval
        group by chain order by 2 desc`,
      [String(ctx.windowHours)],
    );
    const rej = await ctx.db.query<{ chain: string; rule: string; rejected: string }>(
      `select chain, rule, sum(rejected)::text rejected
         from nft_mint_filter_stats where day >= current_date - 1
         group by 1,2 order by 3 desc limit 8`,
    );
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
    const body = rows.rows.length === 0
      ? '<p class="muted">No mints collected in this window.</p>'
      : `<table><thead><tr><th>Chain</th><th>Mints</th><th>Minters</th><th>Known</th></tr></thead><tbody>${
        rows.rows.map((r) => `<tr><td>${esc(r.chain)}</td><td>${r.n}</td><td>${r.wallets}</td><td>${r.known}</td></tr>`).join('')
      }</tbody></table>`;
    const rejBody = rej.rows.length === 0
      ? '<p class="muted">No rejections recorded — check the filters are actually matching.</p>'
      : `<table><thead><tr><th>Chain</th><th>Rule</th><th>Rejected (24h)</th></tr></thead><tbody>${
        rej.rows.map((r) => `<tr><td>${esc(r.chain)}</td><td>${esc(r.rule)}</td><td>${r.rejected}</td></tr>`).join('')
      }</tbody></table>`;
    return `<h2>${esc(ctx.monitorName)}</h2>${body}<h3>Filter rejections</h3>${rejBody}`;
  },
};

/**
 * Retention. Returns what it actually removed, so a policy that runs and
 * deletes nothing is visible in the logs rather than being assumed to work.
 */
async function runRetention(client: PoolClient, r: RetentionConfig)
: Promise<{ aggregated: number; detail_removed: number; aggregates_removed: number }> {
  // 1. collapse detail older than the window into per-collection dailies
  const agg = await client.query(
    `insert into nft_mint_daily (day, chain, collection_address, collection_name,
                                 mints, distinct_minters, known_wallet_mints)
     select block_time::date, chain, collection_address, min(collection_name),
            count(*), count(distinct minter_wallet),
            count(*) filter (where is_known_wallet)
       from nft_mints
      where block_time < now() - ($1 || ' days')::interval
      group by 1,2,3
     on conflict (day, chain, collection_address) do update set
       mints = excluded.mints,
       distinct_minters = excluded.distinct_minters,
       known_wallet_mints = excluded.known_wallet_mints`,
    [String(r.aggregateAfterDays)],
  );

  // 2. drop the detail now that it is summarised — never for known wallets
  const del = await client.query(
    `delete from nft_mints
      where block_time < now() - ($1 || ' days')::interval
        and ($2::boolean is false or not is_known_wallet)`,
    [String(r.fullDetailDays), r.keepForeverIfKnownWallet],
  );

  // 3. finally expire the aggregates themselves
  const purge = await client.query(
    `delete from nft_mint_daily where day < current_date - ($1 || ' days')::interval`,
    [String(r.purgeAggregatesDays)],
  );

  return {
    aggregated: agg.rowCount ?? 0,
    detail_removed: del.rowCount ?? 0,
    aggregates_removed: purge.rowCount ?? 0,
  };
}

export default nftMints;

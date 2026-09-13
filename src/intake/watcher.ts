/**
 * The watcher: what the watchlist wallets are doing, on any token.
 *
 * docs/ROBINHOOD.md step 17. Every other job in this system fixes a TOKEN and
 * lets the wallets vary. This one fixes the WALLETS and lets the token vary, and
 * three things follow from that inversion:
 *
 *   1. The filter inverts. `address` is unset and the wallet set goes in
 *      `topics[1]` (sent) or `topics[2]` (received). The step 5 chunk rule still
 *      applies -- a 540-entry topic array is accepted and 5,024 HANGS with neither
 *      an answer nor a refusal -- so wallets are chunked at 500.
 *   2. There is no pool set. `pool_meta` exists only for tracked tokens, so a
 *      counterparty is classified from the chain and cached permanently.
 *   3. There is usually no price series, so USD is often null. Never zero.
 *
 * STEP 11'S DEFINITION IS KEPT WHOLE. A trade is a transfer whose counterparty is
 * a pool AND which sits in a transaction containing a Swap on that pool. The
 * weaker "was in a transaction containing a Swap" is not used; that conflation
 * produced a wrong count of 34,744 once, and a watchlist wallet's transfers sit in
 * transactions full of unrelated hops.
 *
 * For v4 the Swap half is STRUCTURAL rather than a redundant check: the
 * PoolManager is the counterparty for every v4 pool, so the transfer alone cannot
 * say which pool traded and the Swap log is the only thing that can.
 */

import type { PoolClient } from '../store/db.js';
import type { RpcClient, LogEntry } from '../adapters/token-updates/rpc.js';
import {
  TOPICS, SELECTORS, addressTopic, addressFromTopic, decodeString,
} from '../adapters/token-updates/decode.js';
import { log } from '../logger.js';

/** Step 5: 540 accepted, 5,024 hangs. */
export const WALLET_CHUNK = 500;

export const WATCHER_SCHEMA = `
create table if not exists watchlist_activity (
  chain        text        not null,
  wallet       text        not null,
  token        text        not null,
  side         text        not null,
  venue        text        not null,
  pool         text        not null,
  counterparty text        not null,
  tx_hash      text        not null,
  log_index    bigint      not null,
  block_number bigint      not null,
  block_time   timestamptz not null,
  token_amount numeric     not null,
  usd_amount   numeric,
  seen_at      timestamptz not null default now(),
  constraint watchlist_activity_side_ck check (side in ('buy','sell')),
  primary key (chain, tx_hash, wallet, token, side, log_index)
);

create index if not exists watchlist_activity_block_idx
  on watchlist_activity (chain, block_number);
create index if not exists watchlist_activity_wallet_idx
  on watchlist_activity (chain, wallet);

/*
 * PERMANENT CACHE. A pool is a pool for good, so each address or pool id is
 * classified once and never asked again. kind: 'v3' | 'v4' | 'not-a-pool'.
 * 'not-a-pool' is a RESULT and is cached too -- re-asking a settled negative is
 * how a classifier once spent five rounds on 1,664 answered questions.
 */
create table if not exists chain_pool_cache (
  chain       text not null,
  id          text not null,
  kind        text not null,
  currency0   text,
  currency1   text,
  primary key (chain, id)
);

create table if not exists token_decimals_cache (
  chain    text    not null,
  token    text    not null,
  decimals integer,
  primary key (chain, token)
);

/*
 * Name and symbol for the alert, which must read as a token rather than as an
 * address. Both are nullable and a null is rendered as the short address -- a
 * token that does not answer name() is not a broken row, and inventing a label
 * for it would be worse than showing the address.
 */
alter table token_decimals_cache add column if not exists name text;
alter table token_decimals_cache add column if not exists symbol text;
`;

export async function loadWatchlistWallets(
  client: PoolClient, chain: string,
): Promise<string[]> {
  const r = await client.query<{ wallet: string }>(
    'select distinct wallet from wallet_watchlist where chain = $1 order by wallet', [chain],
  );
  /*
   * AN EMPTY WATCHLIST IS A DEFECT, NOT A QUIET RUN. Sweeping for nobody returns
   * nothing and reads exactly like a period in which nobody traded.
   */
  if (r.rowCount === 0) {
    throw new Error(
      `wallet_watchlist holds no wallets for ${chain}. That is not an empty period; `
      + 'it means the watchlist was never built or was emptied.',
    );
  }
  return r.rows.map((x) => x.wallet.toLowerCase());
}

export const chunk = <T>(xs: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

export interface DensitySample {
  from: number;
  to: number;
  logs: number;
  requests: number;
}

/**
 * Measure the density of the wallet-keyed filter over the blocks the watcher will
 * actually read.
 *
 * Step 5: "a token's density is not constant over its life, so probe the range you
 * will actually sweep." A density taken from the wrong range has been wrong here
 * by 16x, by 27% and by 2.0x. A wallet-keyed filter across every token on the
 * chain has no measured density at all, so the watcher's cost is a guess until
 * this runs.
 */
export async function probeWatchDensity(
  rpc: RpcClient,
  wallets: string[],
  samples: { from: number; to: number }[],
): Promise<{ samples: DensitySample[]; logsPerBlock: number; requests: number }> {
  const chunks = chunk(wallets, WALLET_CHUNK);
  const out: DensitySample[] = [];
  let requests = 0;
  for (const s of samples) {
    let logs = 0;
    for (const c of chunks) {
      const topics = c.map(addressTopic);
      for (const position of [1, 2] as const) {
        const filter = position === 1
          ? { topics: [TOPICS.transfer, topics] }
          : { topics: [TOPICS.transfer, null, topics] };
        const got = await rpc.getLogs(filter, s.from, s.to, s.to - s.from + 1, 25);
        logs += got.length;
        requests += 1;
      }
    }
    out.push({ from: s.from, to: s.to, logs, requests: chunks.length * 2 });
  }
  const blocks = out.reduce((n, s) => n + (s.to - s.from + 1), 0);
  const logs = out.reduce((n, s) => n + s.logs, 0);
  return { samples: out, logsPerBlock: blocks > 0 ? logs / blocks : 0, requests };
}

export interface TokenMeta { decimals: number | null; name: string | null; symbol: string | null }

/**
 * Name, symbol and decimals for a token, read once and cached.
 *
 * A SYMBOL IS A LABEL, NOT AN IDENTITY (step 16, AI): two tokens on this chain
 * both answer `symbol()` with "NVDA". The alert therefore shows the symbol AND
 * links the address, so a reader is never asked to trust a name alone.
 */
export async function tokenMeta(
  client: PoolClient, rpc: RpcClient, chain: string, token: string,
  cache: Map<string, TokenMeta>,
): Promise<TokenMeta> {
  const hit = cache.get(token);
  if (hit) return hit;
  const stored = await client.query<{
    decimals: number | null; name: string | null; symbol: string | null;
  }>('select decimals, name, symbol from token_decimals_cache where chain=$1 and token=$2',
    [chain, token]);
  if (stored.rowCount && stored.rows[0]!.symbol !== null) {
    const m = stored.rows[0]!;
    const meta = { decimals: m.decimals, name: m.name, symbol: m.symbol };
    cache.set(token, meta);
    return meta;
  }

  let decimals: number | null = stored.rows[0]?.decimals ?? null;
  if (stored.rowCount === 0) {
    try {
      const r = await rpc.ethCall(token, SELECTORS.decimals);
      /*
       * A `0x` RETURN IS UNKNOWN, NOT 18 AND NOT 0 (step 1). Assuming 18 for an
       * unreadable decimals is a factor-of-10^12 error waiting to happen.
       */
      if (typeof r === 'string' && r.length >= 66) decimals = Number(BigInt(r));
      if (decimals !== null && (!Number.isFinite(decimals) || decimals < 0 || decimals > 36)) {
        decimals = null;
      }
    } catch { decimals = null; }
  }
  let name: string | null = null;
  let symbol: string | null = null;
  try { name = decodeString(await rpc.ethCall(token, SELECTORS.name)) || null; } catch { name = null; }
  try { symbol = decodeString(await rpc.ethCall(token, SELECTORS.symbol)) || null; } catch { symbol = null; }

  const meta: TokenMeta = { decimals, name, symbol };
  cache.set(token, meta);
  await client.query(
    `insert into token_decimals_cache (chain, token, decimals, name, symbol)
     values ($1,$2,$3,$4,$5)
     on conflict (chain, token) do update
       set name = coalesce(excluded.name, token_decimals_cache.name),
           symbol = coalesce(excluded.symbol, token_decimals_cache.symbol)`,
    [chain, token, decimals, name, symbol],
  );
  return meta;
}

/* --------------------------------------------------------- pool classification */

export interface PoolInfo {
  kind: 'v3' | 'v4' | 'not-a-pool';
  currency0: string | null;
  currency1: string | null;
}

export async function loadPoolCache(
  client: PoolClient, chain: string,
): Promise<Map<string, PoolInfo>> {
  const r = await client.query<{
    id: string; kind: string; currency0: string | null; currency1: string | null;
  }>('select id, kind, currency0, currency1 from chain_pool_cache where chain = $1', [chain]);
  const m = new Map<string, PoolInfo>();
  for (const x of r.rows) {
    m.set(x.id.toLowerCase(), {
      kind: x.kind as PoolInfo['kind'], currency0: x.currency0, currency1: x.currency1,
    });
  }
  return m;
}

async function cachePool(
  client: PoolClient, chain: string, id: string, info: PoolInfo,
): Promise<void> {
  await client.query(
    `insert into chain_pool_cache (chain, id, kind, currency0, currency1)
     values ($1,$2,$3,$4,$5) on conflict (chain, id) do nothing`,
    [chain, id, info.kind, info.currency0, info.currency1],
  );
}

/**
 * Classify a v3 candidate by asking it. Step 3: a pool answers both `token0()`
 * and `token1()`; **a revert is the answer, not a failure** — it means the
 * contract has no such function and is therefore not a pool.
 */
export async function classifyV3(
  client: PoolClient, rpc: RpcClient, chain: string, address: string,
  cache: Map<string, PoolInfo>, block: number,
): Promise<PoolInfo> {
  const hit = cache.get(address);
  if (hit) return hit;
  let info: PoolInfo = { kind: 'not-a-pool', currency0: null, currency1: null };
  try {
    const t0 = await rpc.ethCall(address, SELECTORS.token0, block);
    const t1 = await rpc.ethCall(address, SELECTORS.token1, block);
    if (typeof t0 === 'string' && typeof t1 === 'string' && t0.length >= 66 && t1.length >= 66) {
      info = {
        kind: 'v3',
        currency0: '0x' + t0.slice(-40).toLowerCase(),
        currency1: '0x' + t1.slice(-40).toLowerCase(),
      };
    }
  } catch {
    // A revert is the answer: not a pool. Cached as such so it is asked once.
  }
  cache.set(address, info);
  await cachePool(client, chain, address, info);
  return info;
}

/**
 * Classify a v4 pool id from its `Initialize` event, which carries both
 * currencies as indexed topics. One sparse filter over the chain's life.
 */
export async function classifyV4(
  client: PoolClient, rpc: RpcClient, chain: string, poolId: string,
  cache: Map<string, PoolInfo>, poolManager: string, head: number, sparseSpan: number,
): Promise<PoolInfo> {
  const hit = cache.get(poolId);
  if (hit) return hit;
  const logs = await rpc.getLogs(
    { address: poolManager, topics: [TOPICS.initializeV4, poolId] },
    0, head, sparseSpan, 25,
  );
  let info: PoolInfo = { kind: 'not-a-pool', currency0: null, currency1: null };
  const l = logs[0];
  if (l && l.topics[2] && l.topics[3]) {
    info = {
      kind: 'v4',
      currency0: addressFromTopic(l.topics[2]),
      currency1: addressFromTopic(l.topics[3]),
    };
  }
  cache.set(poolId, info);
  await cachePool(client, chain, poolId, info);
  return info;
}

export async function tokenDecimals(
  client: PoolClient, rpc: RpcClient, chain: string, token: string,
  cache: Map<string, number | null>,
): Promise<number | null> {
  if (cache.has(token)) return cache.get(token) ?? null;
  const stored = await client.query<{ decimals: number | null }>(
    'select decimals from token_decimals_cache where chain=$1 and token=$2', [chain, token],
  );
  if (stored.rowCount) {
    const d = stored.rows[0]!.decimals;
    cache.set(token, d);
    return d;
  }
  let dec: number | null = null;
  try {
    const r = await rpc.ethCall(token, SELECTORS.decimals);
    /*
     * A `0x` RETURN IS UNKNOWN, NOT 18 AND NOT 0 (step 1). Assuming 18 for an
     * unreadable decimals is a factor-of-10^12 error waiting to happen, so this
     * stores null and the row's USD stays null rather than being invented.
     */
    if (typeof r === 'string' && r.length >= 66) dec = Number(BigInt(r));
    if (dec !== null && (!Number.isFinite(dec) || dec < 0 || dec > 36)) dec = null;
  } catch {
    dec = null;
  }
  cache.set(token, dec);
  await client.query(
    `insert into token_decimals_cache (chain, token, decimals) values ($1,$2,$3)
     on conflict (chain, token) do nothing`, [chain, token, dec],
  );
  return dec;
}

export { type LogEntry };
export const transferTopic = TOPICS.transfer;
export const swapV3Topic = TOPICS.swapV3;
export const swapV4Topic = TOPICS.swapV4;

void log;

/* ------------------------------------------------------------------- the sweep */

const NATIVE_ETH = '0x0000000000000000000000000000000000000000';
const BATCH_ROWS = 500;

export interface WatchRow {
  wallet: string;
  token: string;
  tokenName: string | null;
  tokenSymbol: string | null;
  side: 'buy' | 'sell';
  venue: 'v3' | 'v4';
  pool: string;
  counterparty: string;
  txHash: string;
  logIndex: number;
  block: number;
  blockTime: Date;
  tokenAmount: string;
  usdAmount: number | null;
}

export interface SweepReport {
  transfersMatched: number;
  candidates: number;
  trades: number;
  rejectedNoPoolCounterparty: number;
  rejectedNoSwapOnThatPool: number;
  rejectedTokenNotInPool: number;
  walletToWallet: number;
  poolsClassified: number;
  decimalsRead: number;
  usdPriced: number;
  usdNull: number;
  nullReasons: Record<string, number>;
  rows: WatchRow[];
}

const signed = (hex: string): bigint => {
  let v = BigInt('0x' + hex);
  if (v >= 1n << 255n) v -= 1n << 256n;
  return v;
};

const formatUnits = (raw: bigint, decimals: number): string => {
  const neg = raw < 0n; const abs = neg ? -raw : raw;
  const s = abs.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const frac = decimals > 0 ? '.' + s.slice(s.length - decimals) : '';
  return (neg ? '-' : '') + whole + frac;
};

/**
 * ETH/USD at a block, by NEAREST PRECEDING BUCKET.
 *
 * Everywhere else an exact-bucket lookup is required, because a token's rows live
 * on that token's fixed grid. The watcher has no grid: it prices arbitrary tokens,
 * and `native_usd_prices` holds two interleaved residues. Taking the greatest
 * bucket at or below the block, within one bucket width, reads whichever grid is
 * nearer rather than missing both. Documented in step 17 as a deliberate
 * departure; this is a signal feed, not the accounting record.
 */
async function ethUsdAt(
  client: PoolClient, chain: string, block: number, bucketBlocks: number,
): Promise<number | null> {
  const r = await client.query<{ px: string }>(
    `select eth_usd::text px from native_usd_prices
      where chain = $1 and block_number <= $2 and block_number > $2 - $3
      order by block_number desc limit 1`,
    [chain, block, bucketBlocks],
  );
  const v = r.rows[0] ? Number(r.rows[0].px) : null;
  return v !== null && Number.isFinite(v) && v > 0 ? v : null;
}

export async function sweepWatchlistActivity(
  client: PoolClient,
  rpc: RpcClient,
  chain: string,
  cfg: {
    v4PoolManager: string; usdAsset: string; nativeAssets: string[];
    maxLogSpanBlocks: number; minLogSpanBlocks: number; sparseLogSpanBlocks: number;
    bucketBlocks: number;
  },
  wallets: string[],
  fromBlock: number,
  toBlock: number,
): Promise<SweepReport> {
  const walletSet = new Set(wallets);
  const poolManager = cfg.v4PoolManager.toLowerCase();
  const usdAsset = cfg.usdAsset.toLowerCase();
  const natives = new Set(cfg.nativeAssets.map((a) => a.toLowerCase()));
  const rep: SweepReport = {
    transfersMatched: 0, candidates: 0, trades: 0,
    rejectedNoPoolCounterparty: 0, rejectedNoSwapOnThatPool: 0,
    rejectedTokenNotInPool: 0, walletToWallet: 0,
    poolsClassified: 0, decimalsRead: 0, usdPriced: 0, usdNull: 0,
    nullReasons: {}, rows: [],
  };
  const nullBecause = (why: string): void => {
    rep.usdNull += 1;
    rep.nullReasons[why] = (rep.nullReasons[why] ?? 0) + 1;
  };

  /* 1. the wallet-keyed transfer filters, chunked at 500 per step 5 */
  const seen = new Set<string>();
  const transfers: LogEntry[] = [];
  for (const c of chunk(wallets, WALLET_CHUNK)) {
    const topics = c.map(addressTopic);
    for (const position of [1, 2] as const) {
      const filter = position === 1
        ? { topics: [TOPICS.transfer, topics] }
        : { topics: [TOPICS.transfer, null, topics] };
      const got = await rpc.getLogs(
        filter, fromBlock, toBlock, cfg.maxLogSpanBlocks, cfg.minLogSpanBlocks,
      );
      for (const l of got) {
        // A transfer with both sides on the watchlist matches both filters.
        const k = `${l.transactionHash}:${l.logIndex}`;
        if (seen.has(k)) continue;
        seen.add(k);
        transfers.push(l);
      }
    }
  }
  rep.transfersMatched = transfers.length;
  if (transfers.length === 0) return rep;

  /* 2. candidates: a watchlist side, a counterparty, an amount */
  interface Cand {
    log: LogEntry; token: string; wallet: string; side: 'buy' | 'sell';
    counterparty: string; raw: bigint; block: number;
  }
  const cands: Cand[] = [];
  for (const l of transfers) {
    const t1 = l.topics[1]; const t2 = l.topics[2];
    if (!t1 || !t2) continue;
    const body = l.data.replace(/^0x/, '');
    if (body.length < 64) continue; // non-standard Transfer; no amount to read
    const raw = BigInt('0x' + body.slice(0, 64));
    if (raw === 0n) continue;
    const from = addressFromTopic(t1); const to = addressFromTopic(t2);
    const token = l.address.toLowerCase();
    const block = Number(BigInt(l.blockNumber));
    const fromIn = walletSet.has(from); const toIn = walletSet.has(to);
    if (fromIn && toIn) { rep.walletToWallet += 1; continue; }
    if (toIn) cands.push({ log: l, token, wallet: to, side: 'buy', counterparty: from, raw, block });
    else if (fromIn) cands.push({ log: l, token, wallet: from, side: 'sell', counterparty: to, raw, block });
  }
  rep.candidates = cands.length;
  if (cands.length === 0) return rep;

  /* 3. the Swap logs. Step 11's second half, and for v4 the only source of pool identity. */
  const v3Candidates = [...new Set(cands.map((c) => c.counterparty)
    .filter((a) => a !== poolManager && a !== NATIVE_ETH))];
  const v4Swaps = new Map<string, { pool: string; a0: bigint; a1: bigint }[]>();
  const v3Swaps = new Map<string, { pool: string; a0: bigint; a1: bigint }[]>();

  if (cands.some((c) => c.counterparty === poolManager)) {
    const logs = await rpc.getLogs(
      { address: poolManager, topics: [TOPICS.swapV4] },
      fromBlock, toBlock, cfg.maxLogSpanBlocks, cfg.minLogSpanBlocks,
    );
    for (const l of logs) {
      const body = l.data.replace(/^0x/, '');
      if (body.length < 128 || !l.topics[1]) continue;
      const list = v4Swaps.get(l.transactionHash) ?? [];
      list.push({ pool: l.topics[1].toLowerCase(), a0: signed(body.slice(0, 64)), a1: signed(body.slice(64, 128)) });
      v4Swaps.set(l.transactionHash, list);
    }
  }
  if (v3Candidates.length) {
    const logs = await rpc.getLogs(
      { address: v3Candidates, topics: [TOPICS.swapV3] },
      fromBlock, toBlock, cfg.maxLogSpanBlocks, cfg.minLogSpanBlocks,
    );
    for (const l of logs) {
      const body = l.data.replace(/^0x/, '');
      if (body.length < 128) continue;
      const list = v3Swaps.get(l.transactionHash) ?? [];
      list.push({ pool: l.address.toLowerCase(), a0: signed(body.slice(0, 64)), a1: signed(body.slice(64, 128)) });
      v3Swaps.set(l.transactionHash, list);
    }
  }

  /* 4. classify, match, price */
  const poolCache = await loadPoolCache(client, chain);
  const metaCache = new Map<string, TokenMeta>();
  const cacheSizeBefore = poolCache.size;
  const head = toBlock;

  for (const c of cands) {
    const isV4 = c.counterparty === poolManager;
    let matched: { venue: 'v3' | 'v4'; pool: string; info: PoolInfo; a0: bigint; a1: bigint } | null = null;

    if (isV4) {
      const swaps = v4Swaps.get(c.log.transactionHash) ?? [];
      if (swaps.length === 0) { rep.rejectedNoSwapOnThatPool += 1; continue; }
      let sawPool = false;
      for (const s of swaps) {
        const info = await classifyV4(client, rpc, chain, s.pool, poolCache,
          poolManager, head, cfg.sparseLogSpanBlocks);
        if (info.kind !== 'v4') continue;
        sawPool = true;
        if (info.currency0 === c.token || info.currency1 === c.token) {
          matched = { venue: 'v4', pool: s.pool, info, a0: s.a0, a1: s.a1 };
          break;
        }
      }
      if (!matched) { if (sawPool) rep.rejectedTokenNotInPool += 1; else rep.rejectedNoSwapOnThatPool += 1; continue; }
    } else {
      const info = await classifyV3(client, rpc, chain, c.counterparty, poolCache, head);
      if (info.kind !== 'v3') { rep.rejectedNoPoolCounterparty += 1; continue; }
      if (info.currency0 !== c.token && info.currency1 !== c.token) {
        rep.rejectedTokenNotInPool += 1; continue;
      }
      const s = (v3Swaps.get(c.log.transactionHash) ?? []).find((x) => x.pool === c.counterparty);
      if (!s) { rep.rejectedNoSwapOnThatPool += 1; continue; }
      matched = { venue: 'v3', pool: c.counterparty, info, a0: s.a0, a1: s.a1 };
    }

    const meta = await tokenMeta(client, rpc, chain, c.token, metaCache);
    const dec = meta.decimals;
    if (dec === null) {
      /*
       * NO DECIMALS MEANS NO AMOUNT WE CAN STATE. token_amount is NOT NULL by
       * design -- a row that cannot say how much moved is not a row -- so this is
       * skipped rather than written with a guessed 18.
       */
      nullBecause('token decimals unreadable; row skipped entirely');
      continue;
    }

    /* USD from the counter side, which needs no series for the token itself. */
    const tokenIsSide0 = matched.info.currency0 === c.token;
    const counter = (tokenIsSide0 ? matched.info.currency1 : matched.info.currency0) ?? '';
    const counterRaw = tokenIsSide0 ? matched.a1 : matched.a0;
    const tokenRaw = tokenIsSide0 ? matched.a0 : matched.a1;
    let usd: number | null = null;
    if (counter === usdAsset) {
      usd = Math.abs(Number(counterRaw)) / 1e6;
    } else if (natives.has(counter)) {
      const px = await ethUsdAt(client, chain, c.block, cfg.bucketBlocks);
      if (px === null) nullBecause('no ETH/USD bucket within one bucket width');
      else usd = (Math.abs(Number(counterRaw)) / 1e18) * px;
    } else {
      nullBecause('counter asset is not a recognised pricing asset and has no series');
    }
    /*
     * Allocate by this wallet's share of the token the swap moved, so two
     * watchlist wallets in one swap do not each claim the whole of it.
     */
    if (usd !== null) {
      const swapTok = Math.abs(Number(tokenRaw));
      const mine = Number(c.raw);
      const share = swapTok > 0 ? Math.min(1, mine / swapTok) : 1;
      usd *= share;
      rep.usdPriced += 1;
    }

    const ts = c.log.blockTimestamp;
    if (!ts || ts === '0x0') {
      /*
       * block_time is NOT NULL, and a 0x0 is what the public RPC returns for every
       * log. Storing it would stamp the row 1970 with nothing raised.
       */
      throw new Error(
        `transfer ${c.log.transactionHash}:${c.log.logIndex} has blockTimestamp `
        + `${String(ts)}. On Alchemy that is a defect, not midnight 1970.`,
      );
    }
    rep.trades += 1;
    rep.rows.push({
      wallet: c.wallet, token: c.token,
      tokenName: meta.name, tokenSymbol: meta.symbol,
      side: c.side, venue: matched.venue,
      pool: matched.pool, counterparty: c.counterparty,
      txHash: c.log.transactionHash, logIndex: Number(BigInt(c.log.logIndex)),
      block: c.block, blockTime: new Date(Number(BigInt(ts)) * 1000),
      tokenAmount: formatUnits(c.raw, dec), usdAmount: usd,
    });
  }
  rep.poolsClassified = poolCache.size - cacheSizeBefore;
  rep.decimalsRead = metaCache.size;
  return rep;
}

/** Batched, per section 7: one row per statement fsyncs the WAL per row. */
export async function persistWatchRows(
  client: PoolClient, chain: string, rows: WatchRow[],
): Promise<number> {
  let stored = 0;
  for (let i = 0; i < rows.length; i += BATCH_ROWS) {
    const batch = rows.slice(i, i + BATCH_ROWS);
    const vals: string[] = [];
    const params: unknown[] = [chain];
    for (const r of batch) {
      const b = params.length;
      vals.push(`($1,$${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11},$${b + 12})`);
      params.push(r.wallet, r.token, r.side, r.venue, r.pool, r.counterparty,
        r.txHash, r.logIndex, r.block, r.blockTime, r.tokenAmount, r.usdAmount);
    }
    const res = await client.query(
      `insert into watchlist_activity
         (chain, wallet, token, side, venue, pool, counterparty, tx_hash, log_index,
          block_number, block_time, token_amount, usd_amount)
       values ${vals.join(',')} on conflict do nothing`,
      params,
    );
    stored += res.rowCount ?? 0;
  }
  return stored;
}

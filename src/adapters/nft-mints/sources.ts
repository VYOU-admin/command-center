/**
 * Chain sources for the NFT mint collector.
 *
 * SOLANA — Helius DAS polling, not a WebSocket. Measured before choosing:
 * searchAssets with createdAt {after, before} returns exactly the assets
 * created in a window, ~4 calls/day at limit 1000 for regular NFTs. The
 * WebSocket alternative means decoding every Token Metadata transaction —
 * 66,718/day, of which only ~2.5% are creates, so ~97.5% of the work is thrown
 * away. Latency is the socket's only advantage and a daily digest does not need
 * it.
 *
 * Two DAS quirks worth recording, both found by trying: `tokenType` requires
 * `ownerAddress`, so it cannot be used for a global feed; and `createdAt`
 * accepts only `after`/`before` as RFC 3339 STRINGS — integer timestamps and
 * gte/lte are rejected.
 *
 * EVM — public RPC for bulk logs, per the measured split: the public endpoint
 * serves 25k-50k block spans while Alchemy's free tier caps eth_getLogs at nine
 * blocks. The ERC-721 Transfer signature is identical to ERC-20's, and the only
 * difference is that ERC-721 indexes tokenId, giving four topics instead of
 * three. That cannot be expressed in an RPC topic filter, so ~1.32M ERC-20 logs
 * a day are fetched and discarded. Measured, unavoidable, and the reason the
 * block window is small.
 *
 * MINTER = THE TRANSFER `to`, NEVER tx.from. On this chain tx.from was the
 * actual party only 46% of the time for swaps. For mints it is better (86.7%)
 * but still wrong 13.3% of the time, and wrong in the worst way: a single
 * minting service mints to many recipients, so tx.from would collapse many
 * distinct minters into one address — erasing exactly the signal this monitor
 * exists to capture.
 */

import type { CandidateMint } from './filters.js';

const ZERO32 = `0x${'0'.repeat(64)}`;
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const TRANSFER_SINGLE = '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62';
const TRANSFER_BATCH = '0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb';

/** An EVM mint before its block timestamp and collection name are resolved. */
export type EvmCandidate =
  Omit<CandidateMint, 'blockTime' | 'collectionName'> & { blockNumber: number };

export interface EvmChainConfig {
  chain: string;
  chainId: number;
  rpcUrl: string;
  blocksPerPass: number;
  maxPassesPerRun: number;
}

interface JsonRpcResult<T> {
  result?: T;
  error?: { message?: string };
}

/**
 * One JSON-RPC attempt. Separated from the retry loop so the failure modes
 * stay legible.
 *
 * A public RPC does not always answer with JSON. Under load it returns an HTML
 * error page, and `r.json()` then throws SyntaxError: Unexpected token '<'.
 * That is a transport failure wearing a parser's clothing, and treating it as
 * fatal failed whole production runs — three times in the first twenty here,
 * and once before that it killed a 4,851-page pull outright. It is retryable.
 */
async function attempt<T>(url: string, body: unknown, signal: AbortSignal, timeoutMs: number)
: Promise<{ ok: true; value: JsonRpcResult<T> } | { ok: false; retryable: boolean; message: string }> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  const onAbort = () => ac.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (r.status === 429 || r.status >= 500) {
      return { ok: false, retryable: true, message: `http ${r.status}` };
    }
    const text = await r.text();
    try {
      return { ok: true, value: JSON.parse(text) as JsonRpcResult<T> };
    } catch {
      return { ok: false, retryable: true, message: `non-JSON response (${text.slice(0, 40)})` };
    }
  } catch (err) {
    // The caller's signal aborting is a real stop; our own timeout is not.
    if (signal.aborted) return { ok: false, retryable: false, message: 'run aborted' };
    return { ok: false, retryable: true, message: (err as Error).message };
  } finally {
    clearTimeout(t);
    signal.removeEventListener('abort', onAbort);
  }
}

async function post<T>(url: string, body: unknown, signal: AbortSignal, timeoutMs: number)
: Promise<JsonRpcResult<T>> {
  let last = 'unknown';
  for (let i = 0; i < 4; i += 1) {
    const r = await attempt<T>(url, body, signal, timeoutMs);
    if (r.ok) return r.value;
    last = r.message;
    if (!r.retryable) break;
    await new Promise((res) => setTimeout(res, 400 * (i + 1) ** 2));
  }
  return { error: { message: last } };
}

interface EvmLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
}

const addrFromTopic = (t: string): string => `0x${t.slice(-40)}`.toLowerCase();

export async function evmHeadBlock(cfg: EvmChainConfig, signal: AbortSignal): Promise<number> {
  const j = await post<string>(cfg.rpcUrl,
    { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }, signal, 20_000);
  if (!j.result) throw new Error(`${cfg.chain}: eth_blockNumber failed: ${j.error?.message ?? 'no result'}`);
  return Number.parseInt(j.result, 16);
}

async function getLogs(cfg: EvmChainConfig, from: number, to: number, topics: (string | null)[],
                       signal: AbortSignal): Promise<EvmLog[]> {
  const j = await post<EvmLog[]>(cfg.rpcUrl, {
    jsonrpc: '2.0', id: 1, method: 'eth_getLogs',
    params: [{ fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`, topics }],
  }, signal, 90_000);
  if (j.error) {
    const m = j.error.message ?? '';
    // Splitting on a size or time error is what stops a skipped window from
    // silently becoming missing data, which cost 66% of a previous dataset.
    if ((m.includes('exceeds limit') || m.includes('timed out') || m.includes('429')) && to > from) {
      const mid = Math.floor((from + to) / 2);
      const a = await getLogs(cfg, from, mid, topics, signal);
      const b = await getLogs(cfg, mid + 1, to, topics, signal);
      return [...a, ...b];
    }
    throw new Error(`${cfg.chain}: eth_getLogs ${from}-${to}: ${m}`);
  }
  return j.result ?? [];
}

/** Block timestamps, one call per distinct block, cached by the caller. */
export async function evmBlockTimes(cfg: EvmChainConfig, blocks: number[], signal: AbortSignal)
: Promise<Map<number, number>> {
  const out = new Map<number, number>();
  for (const b of blocks) {
    const j = await post<{ timestamp: string }>(cfg.rpcUrl, {
      jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber',
      params: [`0x${b.toString(16)}`, false],
    }, signal, 30_000);
    if (j.result?.timestamp) out.set(b, Number.parseInt(j.result.timestamp, 16));
  }
  return out;
}

/** Collection name via name(); failures are non-fatal and leave it null. */
export async function evmCollectionName(cfg: EvmChainConfig, address: string, signal: AbortSignal)
: Promise<string | null> {
  const j = await post<string>(cfg.rpcUrl, {
    jsonrpc: '2.0', id: 1, method: 'eth_call',
    params: [{ to: address, data: '0x06fdde03' }, 'latest'],
  }, signal, 20_000);
  const hex = j.result;
  if (!hex || hex === '0x') return null;
  try {
    const body = hex.slice(2);
    const len = Number.parseInt(body.slice(64, 128), 16);
    if (!Number.isFinite(len) || len === 0 || len > 512) return null;
    const bytes = body.slice(128, 128 + len * 2);
    const s = Buffer.from(bytes, 'hex').toString('utf8').replace(/\0+$/, '').trim();
    return s === '' ? null : s;
  } catch {
    return null;
  }
}

/**
 * Mints in [fromBlock, toBlock]: ERC-721 Transfer and ERC-1155 TransferSingle,
 * both with from = the zero address.
 */
export async function fetchEvmMints(
  cfg: EvmChainConfig,
  fromBlock: number,
  toBlock: number,
  signal: AbortSignal,
): Promise<{ candidates: EvmCandidate[]; blocks: Set<number> }> {
  const erc721 = await getLogs(cfg, fromBlock, toBlock, [TRANSFER, ZERO32], signal);
  const single = await getLogs(cfg, fromBlock, toBlock, [TRANSFER_SINGLE, null, ZERO32], signal);
  const batch = await getLogs(cfg, fromBlock, toBlock, [TRANSFER_BATCH, null, ZERO32], signal);

  const out: EvmCandidate[] = [];
  const blocks = new Set<number>();

  for (const l of erc721) {
    // four topics is what separates ERC-721 from ERC-20; the RPC filter cannot
    // express it, so it is applied here
    if (l.topics.length !== 4) continue;
    const bn = Number.parseInt(l.blockNumber, 16);
    blocks.add(bn);
    out.push({
      chain: cfg.chain,
      blockNumber: bn,
      collectionAddress: l.address.toLowerCase(),
      tokenId: BigInt(l.topics[3] ?? '0x0').toString(),
      mintAddress: '',
      minterWallet: addrFromTopic(l.topics[2] ?? ''),
      mintPrice: null,
      priceCurrency: null,
      txHash: l.transactionHash,
      compressed: false,
    });
  }
  for (const l of single) {
    if (l.topics.length !== 4) continue;
    const bn = Number.parseInt(l.blockNumber, 16);
    blocks.add(bn);
    const id = l.data.length >= 66 ? BigInt(`0x${l.data.slice(2, 66)}`).toString() : '';
    out.push({
      chain: cfg.chain,
      blockNumber: bn,
      collectionAddress: l.address.toLowerCase(),
      tokenId: id,
      mintAddress: '',
      minterWallet: addrFromTopic(l.topics[3] ?? ''),
      mintPrice: null,
      priceCurrency: null,
      txHash: l.transactionHash,
      compressed: false,
    });
  }
  for (const l of batch) {
    if (l.topics.length !== 4) continue;
    const bn = Number.parseInt(l.blockNumber, 16);
    blocks.add(bn);
    // TransferBatch carries arrays; one row per id keeps the grain consistent
    const body = l.data.slice(2);
    const idsOffset = Number.parseInt(body.slice(0, 64), 16) * 2;
    const count = Number.parseInt(body.slice(idsOffset, idsOffset + 64), 16);
    for (let i = 0; i < Math.min(count, 256); i += 1) {
      const at = idsOffset + 64 + i * 64;
      const id = body.slice(at, at + 64);
      if (id.length < 64) break;
      out.push({
        chain: cfg.chain,
        blockNumber: bn,
        collectionAddress: l.address.toLowerCase(),
        tokenId: BigInt(`0x${id}`).toString(),
        mintAddress: '',
        minterWallet: addrFromTopic(l.topics[3] ?? ''),
        mintPrice: null,
        priceCurrency: null,
        txHash: l.transactionHash,
        compressed: false,
      });
    }
  }
  return { candidates: out, blocks };
}

/* ----------------------------------------------------------------- Solana */

export interface SolanaConfig {
  chain: string;
  rpcUrl: string;
  pageLimit: number;
  maxPagesPerRun: number;
  includeCompressed: boolean;
}

interface DasAsset {
  id: string;
  interface?: string;
  compression?: { compressed?: boolean };
  ownership?: { owner?: string };
  content?: { metadata?: { name?: string } };
  grouping?: Array<{ group_key?: string; group_value?: string }>;
  /** Update authority. Present on ungrouped assets — measured 9 of 9. */
  authorities?: Array<{ address?: string; scopes?: string[] }>;
}

/**
 * The cap bucket for a Solana asset.
 *
 * WHY NOT 'unknown'. A single literal for every asset with no collection
 * grouping put unrelated mints in one bucket, which then hit
 * collection_daily_cap and rejected the rest. It accepted EXACTLY 500 on
 * 2026-08-29, -30 and -31 — the cap, to the row — while Solana collected ~1,500
 * a day against ~9,952 regular candidates seen.
 *
 * WHY NOT THE MINT ADDRESS EITHER. Keying on the mint makes every ungrouped
 * asset its own collection with one mint and one minter, so neither
 * collection_daily_cap (1 < 500) nor min_distinct_minters (1 < 5) can ever
 * fire. That removes volume bounding from precisely the population that filled
 * a 5 GB volume, trading a visible bug for an invisible one.
 *
 * UPDATE AUTHORITY is what "collection" means for an asset that never
 * registered one: the issuer. A farm minting ten thousand ungrouped NFTs from
 * one authority still gets capped, while unrelated issuers stop colliding. The
 * mint address remains the last resort so an asset with neither grouping nor
 * authority is still its own bucket rather than rejoining a shared one.
 */
export function solanaCollectionKey(a: {
  id: string;
  grouping?: Array<{ group_key?: string; group_value?: string }>;
  authorities?: Array<{ address?: string }>;
}): { key: string; source: 'collection' | 'authority' | 'mint' } {
  const collection = a.grouping?.find((g) => g.group_key === 'collection')?.group_value;
  if (collection) return { key: collection, source: 'collection' };
  const auth = a.authorities?.find((x) => x.address)?.address;
  if (auth) return { key: auth, source: 'authority' };
  return { key: a.id, source: 'mint' };
}

/** RFC 3339 with seconds, which is the only shape DAS accepts. */
export const rfc3339 = (d: Date): string => `${d.toISOString().slice(0, 19)}Z`;

export async function fetchSolanaMints(
  cfg: SolanaConfig,
  after: Date,
  before: Date,
  signal: AbortSignal,
): Promise<Omit<CandidateMint, 'blockTime'>[]> {
  const out: Omit<CandidateMint, 'blockTime'>[] = [];
  for (let page = 1; page <= cfg.maxPagesPerRun; page += 1) {
    const j = await post<{ items?: DasAsset[] }>(cfg.rpcUrl, {
      jsonrpc: '2.0', id: '1', method: 'searchAssets',
      params: {
        createdAt: { after: rfc3339(after), before: rfc3339(before) },
        sortBy: { sortBy: 'created', sortDirection: 'asc' },
        limit: cfg.pageLimit,
        page,
      },
    }, signal, 60_000);
    if (j.error) throw new Error(`solana searchAssets: ${j.error.message ?? 'unknown'}`);
    const items = j.result?.items ?? [];
    for (const a of items) {
      const compressed = a.compression?.compressed === true;
      const { key } = solanaCollectionKey(a);
      out.push({
        chain: cfg.chain,
        collectionAddress: key,
        collectionName: a.content?.metadata?.name ?? null,
        tokenId: '',
        mintAddress: a.id,
        minterWallet: a.ownership?.owner ?? '',
        mintPrice: null,
        priceCurrency: null,
        txHash: '',
        compressed,
      });
    }
    if (items.length < cfg.pageLimit) break;
  }
  return out;
}

export { TRANSFER, TRANSFER_SINGLE, TRANSFER_BATCH, ZERO32 };

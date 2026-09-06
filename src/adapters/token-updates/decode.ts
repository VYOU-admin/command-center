/**
 * Event signatures and log decoding.
 *
 * EVERY TOPIC HASH BELOW WAS READ OFF THE CHAIN, NOT RECALLED. A fabricated
 * topic matches zero logs across any span and reads as a clean sweep -- this
 * project has shipped that defect once already. Each constant here was
 * confirmed by querying the contract that emits it and counting the result.
 */

import type { LogEntry } from './rpc.js';

export const TOPICS = {
  /** Uniswap v3 Swap. Confirmed against the in-scope PONS v3 pools. */
  swapV3: '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67',
  /** Uniswap v4 Swap on the PoolManager. 3 topics, 192 data bytes. */
  swapV4: '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f',
  /** Uniswap v4 Initialize. topics: id, currency0, currency1. */
  initializeV4: '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438',
  /**
   * Uniswap v3 PoolCreated(token0, token1, fee, tickSpacing, pool).
   * Confirmed by reading every log the factory 0x1f7d7550... emitted across
   * 36,000 blocks: 5 logs, all carrying this topic0 and four topics.
   */
  poolCreatedV3: '0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118',
  /** ERC-20 Transfer. */
  transfer: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
} as const;

export const SELECTORS = {
  decimals: '0x313ce567',
  symbol: '0x95d89b41',
} as const;

/** Pad an address into a 32-byte topic, for filtering by an indexed address. */
export function addressTopic(address: string): string {
  return '0x' + '0'.repeat(24) + address.replace(/^0x/, '').toLowerCase();
}

/** Addresses are compared lowercased throughout; EVM addresses are case-insensitive. */
export function normalizeAddress(value: string): string {
  return value.trim().toLowerCase();
}

export function addressFromTopic(topic: string): string {
  return '0x' + topic.slice(-40).toLowerCase();
}

function word(data: string, index: number): string {
  const body = data.startsWith('0x') ? data.slice(2) : data;
  const start = index * 64;
  if (body.length < start + 64) {
    throw new Error(`log data has no word ${index}: ${body.length / 2} bytes present`);
  }
  return body.slice(start, start + 64);
}

/** Two's-complement signed integer from a 32-byte word. */
function signed(hex: string): bigint {
  const v = BigInt('0x' + hex);
  return v >= 1n << 255n ? v - (1n << 256n) : v;
}

function unsigned(hex: string): bigint {
  return BigInt('0x' + hex);
}

/**
 * A log's timestamp, refusing the endpoint-specific trap.
 *
 * Alchemy populates blockTimestamp on this chain and it matches the block
 * itself exactly. The PUBLIC RPC returns the same field as 0x0 on every log --
 * a present, well-formed, entirely wrong value that would stamp every row
 * 1970-01-01 without raising anything. Absent or zero is a failed read here,
 * never a date.
 */
export function logTimestamp(log: LogEntry): number {
  if (log.blockTimestamp === undefined) {
    throw new Error(
      'log carried no blockTimestamp. This endpoint cannot supply timestamps ' +
        'with logs; use Alchemy or fetch blocks explicitly.',
    );
  }
  const ts = Number.parseInt(log.blockTimestamp, 16);
  if (!Number.isFinite(ts) || ts <= 0) {
    throw new Error(
      `log blockTimestamp is ${log.blockTimestamp}, which is not a real time. ` +
        'The public RPC reports 0x0 here; only Alchemy populates it on this chain.',
    );
  }
  return ts;
}

export const blockOf = (log: LogEntry): number => Number.parseInt(log.blockNumber, 16);
export const logIndexOf = (log: LogEntry): number => Number.parseInt(log.logIndex, 16);

export interface SwapLog {
  venue: 'v3' | 'v4';
  /** v3: the pool address. v4: the pool id. */
  pool: string;
  txHash: string;
  block: number;
  logIndex: number;
  timestamp: number;
  amount0: bigint;
  amount1: bigint;
}

export function decodeSwap(log: LogEntry, venue: 'v3' | 'v4'): SwapLog {
  return {
    venue,
    pool: venue === 'v3' ? normalizeAddress(log.address) : log.topics[1]!.toLowerCase(),
    txHash: log.transactionHash.toLowerCase(),
    block: blockOf(log),
    logIndex: logIndexOf(log),
    timestamp: logTimestamp(log),
    amount0: signed(word(log.data, 0)),
    amount1: signed(word(log.data, 1)),
  };
}

export interface TransferLog {
  from: string;
  to: string;
  amount: bigint;
  txHash: string;
  block: number;
  logIndex: number;
  timestamp: number;
}

export function decodeTransfer(log: LogEntry): TransferLog {
  return {
    from: addressFromTopic(log.topics[1]!),
    to: addressFromTopic(log.topics[2]!),
    amount: unsigned(word(log.data, 0)),
    txHash: log.transactionHash.toLowerCase(),
    block: blockOf(log),
    logIndex: logIndexOf(log),
    timestamp: logTimestamp(log),
  };
}

export interface NewPool {
  venue: 'v3' | 'v4';
  pool: string;
  currency0: string;
  currency1: string;
  block: number;
}

export function decodeInitializeV4(log: LogEntry): NewPool {
  return {
    venue: 'v4',
    pool: log.topics[1]!.toLowerCase(),
    currency0: addressFromTopic(log.topics[2]!),
    currency1: addressFromTopic(log.topics[3]!),
    block: blockOf(log),
  };
}

export function decodePoolCreatedV3(log: LogEntry): NewPool {
  // data = [int24 tickSpacing, address pool]; the pool is the second word.
  return {
    venue: 'v3',
    pool: '0x' + word(log.data, 1).slice(-40).toLowerCase(),
    currency0: addressFromTopic(log.topics[1]!),
    currency1: addressFromTopic(log.topics[2]!),
    block: blockOf(log),
  };
}

/** ABI-decode a uint8 return, e.g. decimals(). `0x` is unknown, not zero. */
export function decodeUint8(result: string): number {
  if (!result || result === '0x') {
    throw new Error('contract returned no data; the value is unknown, not zero');
  }
  const n = Number(BigInt(result));
  if (!Number.isInteger(n) || n < 0 || n > 255) {
    throw new Error(`expected a uint8, got ${result}`);
  }
  return n;
}

/** ABI-decode a string return. Falls back to bytes32 for older tokens. */
export function decodeString(result: string): string | null {
  if (!result || result === '0x') return null;
  const body = result.slice(2);
  const strip = (s: string): string => s.replace(/\u0000/g, '').trim();
  if (body.length === 64) {
    const bytes = body.replace(/(00)+$/, '');
    return strip(Buffer.from(bytes, 'hex').toString('utf8')) || null;
  }
  if (body.length < 128) return null;
  const length = Number(BigInt('0x' + body.slice(64, 128)));
  const text = Buffer.from(body.slice(128, 128 + length * 2), 'hex').toString('utf8');
  return strip(text) || null;
}

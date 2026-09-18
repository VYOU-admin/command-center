/**
 * POOL LIQUIDITY, READ FROM THE POOLMANAGER'S OWN STORAGE
 * ======================================================================
 *
 * This is the "was there any liquidity" reader, extracted from `cli/post-mortem.ts` so
 * the bot's pre-buy gate and the post-mortem use the SAME code. Two readers of the same
 * fact would be two chances to be wrong about it.
 *
 * **WHY IT EXISTS: `Fly` WAS BOUGHT THREE TIMES INTO A POOL WITH ZERO LIQUIDITY.** That
 * number was readable before every one of those buys and nothing read it, because the
 * bot's only notion of a pool's health was the router's quote — and section 6A.3 is the
 * finding that the router's quote, taken against an unreachable bound, short-circuits
 * inside the swap action and reports a healthy price on a pool nothing can leave.
 *
 * **THE LAYOUT IS CONFIRMED, NOT INFERRED.** `POOLS_SLOT = 6` and `liquidity` at
 * offset 3 come from Uniswap's `StateLibrary`, which is a claim about someone else's
 * code. It was validated by agreement with the router oracle across all 12 live
 * positions in `post-mortem.ts` — an independent route to the same quantity, which is
 * the one real observation the standing rules require before it becomes a decision.
 *
 * **WHAT WOULD PROVE IT WRONG:** a pool where the router quotes a sane price and this
 * reader returns 0, or vice versa. `post-mortem.ts` prints the agreement count on every
 * run; if it ever drops below n, the layout has changed and this reader is void.
 *
 * `0x` and a short response are UNKNOWN and return `null`, never `0n` — a plausible
 * zero from a failed transport is the failure mode that manufactured a false decode
 * crisis on this project once already.
 */
import { AbiCoder, concat, id, keccak256, toBeHex, zeroPadValue } from 'ethers';
import { POOL_MANAGER } from './config.js';

const h32 = (v: bigint | number | string): string => zeroPadValue(toBeHex(v), 32);

/** COMPUTED from the signature, never a pasted selector. */
export const EXTSLOAD = id('extsload(bytes32)').slice(0, 10);

const POOLS_SLOT = 6n;
const LIQUIDITY_OFFSET = 3n;

/** The storage slot holding `liquidity` for a pool. */
export const liquiditySlot = (poolId: string): string =>
  h32(BigInt(keccak256(concat([poolId, h32(POOLS_SLOT)]))) + LIQUIDITY_OFFSET);

export interface RpcLike { call(method: string, params: unknown[]): Promise<unknown>; }

/**
 * The pool's live liquidity, or `null` when it could not be read.
 *
 * `null` is NOT zero and callers must not treat it as zero: an unreadable pool is a
 * pool we know nothing about, and the correct response to knowing nothing before
 * spending money is to decline, not to proceed on a default.
 */
export async function readPoolLiquidity(
  rpc: RpcLike, poolId: string, block: string = 'latest',
): Promise<bigint | null> {
  const slot = liquiditySlot(poolId);
  try {
    const r = String(await rpc.call('eth_call', [{
      to: POOL_MANAGER, data: EXTSLOAD + slot.slice(2),
    }, block]));
    if (!r.startsWith('0x') || r.length < 66) return null;
    return BigInt(r) & ((1n << 128n) - 1n);
  } catch { return null; }
}

/**
 * THE POOL ID A POOL KEY PRODUCES — `keccak256(abi.encode(PoolKey))`, v4's own id.
 *
 * **THIS EXISTS AS A CHECK, NOT AS A LOOKUP.** The bot stores `pool_id` from the
 * `Initialize` log, which is ground truth, and separately reconstructs the `PoolKey`
 * from the token/counter ordering whenever it needs to swap. If that reconstruction is
 * ever wrong — the currencies transposed, a fee or tickSpacing off — the resulting call
 * addresses A DIFFERENT POOL, and the failure is silent in the dangerous direction: the
 * swap reverts and a sellability probe reads that revert as "the token refuses to
 * transfer". A false honeypot verdict looks exactly like a true one.
 *
 * So the reconstruction is checked against the stored id before its result is trusted.
 */
export function poolIdOf(pool: {
  currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string;
}): string {
  return keccak256(AbiCoder.defaultAbiCoder().encode(
    ['address', 'address', 'uint24', 'int24', 'address'],
    [pool.currency0, pool.currency1, pool.fee, pool.tickSpacing, pool.hooks]));
}

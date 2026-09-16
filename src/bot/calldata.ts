/**
 * THE ONE IMPLEMENTATION of transaction construction. Nothing else builds calldata.
 *
 * ROBINHOOD.md records two implementations of one rule drifting apart FIVE times, and
 * the last time the weaker copy was the one that ran. The dry-run path and any future
 * live path call exactly these functions; a dry run that exercises different code from
 * the live path proves nothing about the live path.
 *
 * Every layout here was derived from observed transactions and verified, never assumed:
 * 190 of 198 Universal Router calls reconstruct byte-for-byte from pool data and policy
 * alone, and 6 of 6 constructed calls returned cleanly from `eth_call` at their
 * historical block. See LAUNCHBOT.md section 2.
 */
import { AbiCoder, id } from 'ethers';
import { NATIVE_ETH, PERMIT2, UNIVERSAL_ROUTER } from './config.js';

const abi = AbiCoder.defaultAbiCoder();

/** Selectors, COMPUTED. ROBINHOOD.md: a fabricated hash has shipped here once. */
export const SELECTORS = {
  /** Verified against 19 observed transactions. */
  execute3: id('execute(bytes,bytes[],uint256)').slice(0, 10),
  /** Verified against 125 observed transactions. */
  execute2: id('execute(bytes,bytes[])').slice(0, 10),
  approve: id('approve(address,uint256)').slice(0, 10),
  /** Permit2's own approve. 20 of 20 UR sellers emitted its Approval event. */
  permit2Approve: id('approve(address,address,uint160,uint48)').slice(0, 10),
} as const;

/** Observed action sequences. `0x060c0f` is the 64-byte take form. */
const ACTIONS_TAKE_ALL = '0x060c0f';
const POOLKEY = '(address,address,uint24,int24,address)';
const SWAP_352 = `(${POOLKEY},bool,uint128,uint128,bytes)`;

export interface PoolKey {
  currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string;
}

export interface SwapPlan {
  pool: PoolKey;
  /** true = spending currency0 to receive currency1. */
  zeroForOne: boolean;
  amountIn: bigint;
  /** OUR bound. Never zero -- see config.SLIPPAGE_BPS. */
  amountOutMinimum: bigint;
  deadline: bigint;
}

export interface TxRequest {
  to: string; data: string; value: bigint; description: string;
}

/**
 * Build the Universal Router swap. ONE function for both legs -- a buy and a sell
 * differ only in `zeroForOne` and which currency carries the value, so writing them
 * separately would be the two-implementations trap in miniature.
 */
export function buildSwap(plan: SwapPlan): TxRequest {
  if (plan.amountOutMinimum <= 0n) {
    /*
     * REFUSED, not defaulted. The observed buyers pass zero and take no protection;
     * emitting a zero here because a caller forgot would silently reproduce that.
     */
    throw new Error('amountOutMinimum must be positive: an unprotected swap is refused');
  }
  const k = plan.pool;
  const key = [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks];
  const inCur = plan.zeroForOne ? k.currency0 : k.currency1;
  const outCur = plan.zeroForOne ? k.currency1 : k.currency0;

  const p0 = abi.encode([SWAP_352],
    [[key, plan.zeroForOne, plan.amountIn, plan.amountOutMinimum, '0x']]);
  const p1 = abi.encode(['address', 'uint256'], [inCur, plan.amountIn]);
  const p2 = abi.encode(['address', 'uint256'], [outCur, plan.amountOutMinimum]);
  const blob = abi.encode(['bytes', 'bytes[]'], [ACTIONS_TAKE_ALL, [p0, p1, p2]]);

  const data = SELECTORS.execute3
    + abi.encode(['bytes', 'bytes[]', 'uint256'], ['0x10', [blob], plan.deadline]).slice(2);
  return {
    to: UNIVERSAL_ROUTER,
    data,
    /* Native ETH rides as value; an ERC-20 input rides as an allowance. */
    value: inCur.toLowerCase() === NATIVE_ETH ? plan.amountIn : 0n,
    description: `${plan.zeroForOne ? 'BUY' : 'SELL'} amountIn=${plan.amountIn} `
      + `minOut=${plan.amountOutMinimum}`,
  };
}

/** Step 1 of 2 for selling: the token allows Permit2 to move it. */
export function buildTokenApprove(token: string, amount: bigint): TxRequest {
  return {
    to: token,
    data: SELECTORS.approve + abi.encode(['address', 'uint256'], [PERMIT2, amount]).slice(2),
    value: 0n,
    description: `APPROVE token->Permit2 amount=${amount}`,
  };
}

/**
 * Step 2 of 2: Permit2 allows the router to move it.
 *
 * MEASURED, NOT ASSUMED: 20 of 20 Universal Router sellers emitted Permit2's
 * `Approval(owner,token,spender,amount,expiration)` naming the router as spender --
 * 225 events -- and ZERO used the signature-based `Permit`. So the on-chain grant is
 * what this chain actually does, and the route costs two setup transactions.
 */
export function buildPermit2Approve(
  token: string, amount: bigint, expiration: number,
): TxRequest {
  return {
    to: PERMIT2,
    data: SELECTORS.permit2Approve + abi.encode(
      ['address', 'address', 'uint160', 'uint48'],
      [token, UNIVERSAL_ROUTER, amount, expiration]).slice(2),
    value: 0n,
    description: `APPROVE Permit2->UniversalRouter amount=${amount}`,
  };
}

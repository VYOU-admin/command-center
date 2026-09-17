/**
 * THE ONE PLACE ALLOWANCES ARE READ. docs/LAUNCHBOT.md section 2B.
 *
 * A sell pulls the token through Permit2 and needs TWO grants — `token.approve(PERMIT2,
 * n)` and `Permit2.approve(token, ROUTER, n, expiry)` — so two places want to read them:
 * `approve-setup`, which grants them, and `exit-exec`, which must refuse to broadcast a
 * sell that would revert for want of them.
 *
 * **THIS EXISTS BECAUSE THE SECOND CALLER ARRIVED.** The reads were written inline in
 * `approve-setup` first. Copying them into the exit path would have been the
 * two-implementations trap for the eighth recorded time on this project, and in the worst
 * place for it: the granting side and the checking side disagreeing about whether an
 * allowance is sufficient is how a bot sells into a revert it had already been told about.
 *
 * TWO PROPERTIES THAT ARE NOT OBVIOUS AND ARE THE REASON THIS IS NOT A ONE-LINER:
 *
 * 1. **`0x` IS UNKNOWN, NEVER ZERO.** An unreadable allowance must not be treated as
 *    absent (which would send a pointless approval) or as present (which would sell into
 *    a revert). It is its own answer and both callers refuse on it.
 * 2. **A PERMIT2 GRANT EXPIRES.** A non-zero amount whose expiration has passed is
 *    worthless. A check written from the ERC-20 shape reads the amount, sees a number and
 *    concludes the grant is in place — which is a plausible value on an error path.
 */
import { AbiCoder, id } from 'ethers';
import { PERMIT2 } from './config.js';

const abi = AbiCoder.defaultAbiCoder();

/** Selectors COMPUTED from keccak, never transcribed. A wrong one returns `0x`. */
const ERC20_ALLOWANCE = id('allowance(address,address)').slice(0, 10);
const PERMIT2_ALLOWANCE = id('allowance(address,address,address)').slice(0, 10);
const BALANCE_OF = id('balanceOf(address)').slice(0, 10);

export interface AllowanceRpc { call(method: string, params: unknown[]): Promise<unknown> }

/** A 32-byte left-padded address word. */
const word = (a: string): string => a.replace(/^0x/, '').toLowerCase().padStart(64, '0');

export interface Erc20Allowance {
  /** null = UNREADABLE, which is neither zero nor sufficient. */
  amount: bigint | null;
  note: string;
}

export interface Permit2Allowance {
  amount: bigint | null;
  /** Unix seconds. A grant at or past this is worthless whatever its amount. */
  expiration: number;
  note: string;
}

export async function readErc20Allowance(
  rpc: AllowanceRpc, token: string, owner: string, spender: string,
): Promise<Erc20Allowance> {
  const r = await rpc.call('eth_call', [{
    to: token, data: ERC20_ALLOWANCE + word(owner) + word(spender),
  }, 'latest']);
  if (typeof r !== 'string' || r === '0x' || r === '') {
    return { amount: null, note: `allowance() returned ${JSON.stringify(r)} — UNKNOWN, `
      + 'not zero; refusing to treat an unreadable allowance as absent' };
  }
  return { amount: BigInt(r), note: 'read' };
}

/**
 * Permit2 `allowance(owner, token, spender)` -> `(uint160 amount, uint48 expiration,
 * uint48 nonce)`.
 */
export async function readPermit2Allowance(
  rpc: AllowanceRpc, owner: string, token: string, spender: string,
): Promise<Permit2Allowance> {
  const r = await rpc.call('eth_call', [{
    to: PERMIT2, data: PERMIT2_ALLOWANCE + word(owner) + word(token) + word(spender),
  }, 'latest']);
  if (typeof r !== 'string' || r === '0x' || r === '') {
    return { amount: null, expiration: 0, note: `returned ${JSON.stringify(r)} — UNKNOWN` };
  }
  const [amount, expiration] = abi.decode(['uint160', 'uint48', 'uint48'], r) as
    unknown as [bigint, bigint, bigint];
  return { amount, expiration: Number(expiration), note: 'read' };
}

/** A token balance. `0x` is UNKNOWN, never zero — the standing rule. */
export async function readTokenBalance(
  rpc: AllowanceRpc, token: string, owner: string,
): Promise<bigint> {
  const r = await rpc.call('eth_call', [{
    to: token, data: BALANCE_OF + word(owner),
  }, 'latest']);
  if (typeof r !== 'string' || r === '0x' || r === '') {
    throw new Error(`balanceOf returned ${JSON.stringify(r)} for ${token}: the balance is `
      + 'UNKNOWN, not zero.');
  }
  return BigInt(r);
}

export interface SellReadiness {
  ready: boolean;
  /** Why not, in one line, naming what closes it. Empty when ready. */
  reason: string;
  erc20: Erc20Allowance;
  permit2: Permit2Allowance;
}

/**
 * CAN THIS ADDRESS ACTUALLY SELL `amount` OF `token` THROUGH THE ROUTER RIGHT NOW?
 *
 * The ONE answer to that question, so the granting side and the selling side cannot
 * disagree. Used by `exit-exec` before it broadcasts and by `approve-setup` to decide what
 * to grant.
 *
 * `nowSeconds` is a parameter rather than being read from the clock so a drill can test
 * the expiry branch, which is otherwise only reachable by waiting an hour.
 */
export async function checkSellReadiness(
  rpc: AllowanceRpc, token: string, owner: string, spender: string,
  amount: bigint, nowSeconds: number,
): Promise<SellReadiness> {
  const erc20 = await readErc20Allowance(rpc, token, owner, PERMIT2);
  const permit2 = await readPermit2Allowance(rpc, owner, token, spender);

  if (erc20.amount === null || permit2.amount === null) {
    return { ready: false, erc20, permit2,
      reason: 'an allowance could not be read. UNKNOWN is not zero and is not sufficient: '
        + `erc20=${erc20.note} permit2=${permit2.note}` };
  }
  if (erc20.amount < amount) {
    return { ready: false, erc20, permit2,
      reason: `token -> Permit2 allowance is ${erc20.amount} against ${amount} needed. `
        + 'Run approve-setup for this token.' };
  }
  if (permit2.amount < amount) {
    return { ready: false, erc20, permit2,
      reason: `Permit2 -> router allowance is ${permit2.amount} against ${amount} needed. `
        + 'Run approve-setup for this token.' };
  }
  if (permit2.expiration <= nowSeconds) {
    return { ready: false, erc20, permit2,
      reason: `the Permit2 grant EXPIRED at ${permit2.expiration} (now ${nowSeconds}). `
        + 'A non-zero amount past its expiry is worthless; re-run approve-setup.' };
  }
  return { ready: true, reason: '', erc20, permit2 };
}

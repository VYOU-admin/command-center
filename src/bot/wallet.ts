/**
 * THE WALLET: AN ADDRESS, A BALANCE READ FROM THE CHAIN, AND AN ARMING GATE.
 *
 * **NO PRIVATE KEY IS READ HERE OR ANYWHERE.** This module handles an ADDRESS and a
 * BALANCE and nothing else. There is no signing path in this repository and this file
 * does not add one — `ReadOnlyRpc` refuses every signing and broadcast method by name,
 * and `eth_getBalance` is a read.
 *
 * ---------------------------------------------------------------------------
 * WHY THE BALANCE IS READ RATHER THAN CONFIGURED
 * ---------------------------------------------------------------------------
 *
 * `LAUNCHBOT.md` section 0 carried "the operator states ~$24 of ETH on chain 4663; this
 * has not been read from the chain by any code here" for the whole build. A stated
 * balance is not a balance: it goes stale the moment a trade lands, and a bot that arms
 * against a figure somebody typed is a bot that will one day try to open five $10
 * positions against $12.
 *
 * **The gate is `MAX_CONCURRENT × MAX_POSITION_USD`** — the most the rails will ever let
 * be at risk at once. Arming with less than that is arming into a state where a rail
 * that is supposed to bound exposure would instead be bounded by running out of money,
 * and the failure would surface as a broadcast that reverts rather than as a refusal.
 *
 * **A BALANCE THAT CANNOT BE READ REFUSES TO ARM.** It is never treated as zero (which
 * would refuse for the wrong reason) and never as sufficient (which would arm blind).
 * `ROBINHOOD.md`'s standing rule: an error path that emits a plausible value is the
 * worst defect shape on this project, and a `balanceOf` reader that mapped 490 HTTP 429s
 * to `0.0` is the case that earned it.
 */
import { RAILS } from './config.js';
import type { PoolClient } from '../store/db.js';

export interface BalanceRpc { call(method: string, params: unknown[]): Promise<unknown> }

export interface WalletState {
  address: string;
  balanceWei: bigint;
  balanceEth: number;
  ethUsd: number;
  balanceUsd: number;
  requiredUsd: number;
  canArm: boolean;
  reason: string;
}

/**
 * The configured address, validated. Returns null when none is set — which is a state
 * the caller must handle, not a reason to invent one.
 */
export function configuredWallet(): string | null {
  const raw = process.env['BOT_WALLET_ADDRESS'];
  if (!raw) return null;
  const a = raw.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) {
    throw new Error(`BOT_WALLET_ADDRESS is not a 20-byte hex address: "${a}". Refusing `
      + 'to run against a malformed address rather than reading a balance for nobody.');
  }
  return a.toLowerCase();
}

/** What the rails can put at risk at once. The gate, and the ONE place it is computed. */
export function requiredUsd(): number {
  return RAILS.MAX_CONCURRENT * RAILS.MAX_POSITION_USD;
}

/**
 * Read the address's native balance and decide whether the bot may arm.
 * RAISES on an unreadable balance or an unreadable ETH/USD rate.
 */
export async function readWalletState(
  rpc: BalanceRpc, c: PoolClient, address: string,
): Promise<WalletState> {
  const raw = await rpc.call('eth_getBalance', [address, 'latest']);
  if (typeof raw !== 'string' || !raw.startsWith('0x')) {
    throw new Error(`eth_getBalance returned ${JSON.stringify(raw)} for ${address}; the `
      + 'balance is UNKNOWN, not zero, and the bot will not arm against an unknown.');
  }
  const balanceWei = BigInt(raw);
  const balanceEth = Number(balanceWei) / 1e18;

  const r = await c.query<{ e: string | null }>(
    `select eth_usd::text e from native_usd_prices
      where chain = 'robinhood' order by block_number desc limit 1`);
  const ethUsd = Number(r.rows[0]?.e ?? NaN);
  if (!Number.isFinite(ethUsd) || ethUsd <= 0) {
    throw new Error('no usable ETH/USD rate in native_usd_prices; a balance cannot be '
      + 'valued and the bot will not arm against an unvalued one.');
  }

  const balanceUsd = balanceEth * ethUsd;
  const need = requiredUsd();
  const canArm = balanceUsd >= need;
  return {
    address, balanceWei, balanceEth, ethUsd, balanceUsd, requiredUsd: need, canArm,
    reason: canArm
      ? `balance $${balanceUsd.toFixed(2)} covers MAX_CONCURRENT ${RAILS.MAX_CONCURRENT}`
        + ` x $${RAILS.MAX_POSITION_USD} = $${need}`
      : `balance $${balanceUsd.toFixed(2)} is BELOW MAX_CONCURRENT ${RAILS.MAX_CONCURRENT}`
        + ` x $${RAILS.MAX_POSITION_USD} = $${need}`,
  };
}

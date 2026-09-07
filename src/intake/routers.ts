/**
 * Identifying routers by behaviour, not by a hand-typed list.
 *
 * `config/infrastructure.yaml` holds addresses somebody noticed. That is a
 * guess: for PONS it named 3 and behaviour identifies at least 5, and one of
 * the three it named turns out to front 36,850 recipients while two others on
 * the list front far fewer.
 *
 * docs/ROBINHOOD.md step 7 gives the test, and it has three parts that must all
 * hold:
 *
 *   1. it is a deployed contract          -- an EOA distributing tokens is not
 *                                            a router, and neither is an
 *                                            EIP-7702 account
 *   2. it sends the token to many distinct recipients
 *   3. a HIGH SHARE of its sends sit inside a transaction that contains a swap
 *
 * Part 3 is the discriminator and it separates cleanly. Measured on PONS across
 * its cohort window:
 *
 *   0xb92fe925...  36,850 recipients  150,347 sends   75.6% in a swap tx
 *   0x39b38686...   2,308              95,715         88.4%
 *   0xb477751b...   2,189              25,754         88.2%
 *   0x8876789976    1,714              12,468         98.3%
 *   0x1d4b8649...   1,558              50,387         72.5%
 *   0x6a37f719...   2,181              50,303          0.0%   <- distributor
 *   0xa1d65242...   1,444               8,613          0.0%   <- distributor
 *   0x73991a25...   1,097               6,467          0.0%   <- distributor
 *
 * The three at zero move comparable volume to comparable numbers of wallets and
 * are airdrops or payouts. Without part 3 they would be indistinguishable.
 */

import type { IntakeConfig } from './plan.js';
import { classifyCode } from '../adapters/token-updates/decode.js';
import type { RpcClient } from '../adapters/token-updates/rpc.js';
import type { PoolClient } from '../store/db.js';

export interface RouterCandidate {
  address: string;
  recipients: number;
  sends: number;
  sendsInSwapTx: number;
  swapShare: number;
  /** From eth_getCode at the probe block. */
  kind: 'eoa' | 'delegated' | 'contract';
  isRouter: boolean;
  reason: string;
}

/**
 * Rank every non-pool sender of the token by behaviour and classify it.
 *
 * Reads stored logs; the only RPC is one `eth_getCode` per candidate that
 * clears the volume bar, so the cost is bounded by that bar and reported.
 */
export async function detectRouters(
  client: PoolClient,
  rpc: RpcClient,
  cfg: IntakeConfig,
  poolAddresses: string[],
  fromBlock: number,
  toBlock: number,
  probeBlock: number,
): Promise<{ candidates: RouterCandidate[]; probed: number }> {
  const counterparties = [...new Set([...poolAddresses, cfg.v4PoolManager.toLowerCase()])];

  const rows = await client.query<{
    addr: string; recipients: number; sends: number; in_swap: number;
  }>(
    `with sends as (
       select t.from_addr addr, t.to_addr recipient, t.tx_hash
         from token_transfer_logs t
        where t.chain = $1 and t.token = $2
          and t.block_number between $3 and $4
          and t.from_addr <> all($5::text[])
          and t.from_addr <> '0x0000000000000000000000000000000000000000'
     ),
     swaptx as (
       select distinct tx_hash from token_swap_logs
        where chain = $1 and token = $2 and block_number between $3 and $4
     )
     select s.addr,
            count(distinct s.recipient)::int              as recipients,
            count(*)::int                                 as sends,
            count(x.tx_hash)::int                         as in_swap
       from sends s
       left join swaptx x on x.tx_hash = s.tx_hash
      group by s.addr
     having count(distinct s.recipient) >= $6
      order by count(distinct s.recipient) desc`,
    [cfg.chain, cfg.token, fromBlock, toBlock, counterparties, cfg.routerMinRecipients],
  );

  const candidates: RouterCandidate[] = [];
  let probed = 0;
  for (const r of rows.rows) {
    const share = r.sends > 0 ? r.in_swap / r.sends : 0;
    // Only probe what clears the volume bar; eth_getCode is 26 CU each.
    const code = await rpc.getCode(r.addr, probeBlock);
    probed += 1;
    const kind = classifyCode(code);

    let isRouter = false;
    let reason: string;
    if (kind !== 'contract') {
      reason = `not a deployed contract (${kind}) -- a distributor, not a router`;
    } else if (share < cfg.routerMinSwapShare) {
      reason =
        `only ${(100 * share).toFixed(1)}% of its sends sit inside a swap transaction, ` +
        `below the ${(100 * cfg.routerMinSwapShare).toFixed(0)}% bar -- it moves tokens ` +
        'without trading them';
    } else {
      isRouter = true;
      reason =
        `${(100 * share).toFixed(1)}% of ${r.sends.toLocaleString()} sends sit inside a ` +
        `swap transaction, across ${r.recipients.toLocaleString()} recipients`;
    }
    candidates.push({
      address: r.addr, recipients: r.recipients, sends: r.sends,
      sendsInSwapTx: r.in_swap, swapShare: share, kind, isRouter, reason,
    });
  }
  return { candidates, probed };
}

/**
 * The exclusions the pipeline actually applies: the configured infrastructure
 * list UNION every address behaviour identified as a router.
 *
 * Detecting routers in a report while the hand-typed list does the real work is
 * the same defect as documenting a rule the code does not implement. For PONS,
 * behaviour finds 30 routers where the list holds 3, of which only 2 are
 * routers at all -- a router the list misses gets the trade attributed to it
 * instead of to the buyer.
 */
export async function effectiveExclusions(
  client: PoolClient,
  chain: string,
  token: string,
  configured: string[],
): Promise<{ addresses: Set<string>; fromConfig: number; fromBehaviour: number }> {
  const res = await client.query<{ phase: string }>(
    `select phase from token_intake_state
      where chain = $1 and token = $2 and phase like 'router:%'`,
    [chain, token],
  );
  const detected = res.rows.map((r) => r.phase.slice('router:'.length).toLowerCase());
  const addresses = new Set(configured.map((a) => a.toLowerCase()));
  const before = addresses.size;
  for (const a of detected) addresses.add(a);
  return {
    addresses,
    fromConfig: before,
    fromBehaviour: addresses.size - before,
  };
}

/**
 * Compare what behaviour finds against what the configured list says. Both
 * directions matter: a router missing from the list is attributed to the wrong
 * address, and a list entry behaviour does not support is a claim nobody checked.
 */
export function compareToList(
  candidates: RouterCandidate[],
  configured: string[],
): { onlyBehavioural: string[]; onlyConfigured: string[]; both: string[] } {
  const found = new Set(candidates.filter((c) => c.isRouter).map((c) => c.address));
  const listed = new Set(configured.map((a) => a.toLowerCase()));
  return {
    onlyBehavioural: [...found].filter((a) => !listed.has(a)),
    onlyConfigured: [...listed].filter((a) => !found.has(a)),
    both: [...found].filter((a) => listed.has(a)),
  };
}

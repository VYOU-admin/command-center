/**
 * Proving the second half of a buy: did the wallet give up value?
 *
 * docs/ROBINHOOD.md step 7 defines a buy as a swap in which the wallet receives
 * the token AND gives up value in the same transaction. The first half is
 * provable from the token's own Transfer logs. The second is NOT, and an
 * earlier attempt to prove it from logs alone was wrong in a way worth
 * recording:
 *
 * It asked "did the wallet send a pricing asset to a pool?", which is a much
 * narrower question. Measured on 40 decoded PONS buys, that rule rejected 39
 * and ALL 39 had actually paid -- 36 of them in native ETH, which moves with no
 * Transfer log at all. On this chain the normal path is: the wallet sends
 * native ETH, a wrapper converts it, and the POOL receives WETH from the
 * wrapper. The wallet never appears as the sender of an ERC-20.
 *
 * So payment is proven from the transaction receipt plus the transaction's own
 * `value` field, which together see both halves:
 *
 *   - any ERC-20 Transfer whose sender is the wallet, other than the token
 *     being bought (sending that back is a round trip, not a payment)
 *   - the wallet being the transaction's sender with a non-zero `value`
 *
 * ONE RECEIPT SERVES EVERY WALLET IN THAT TRANSACTION, so the cost is per
 * transaction rather than per candidate, and a wallet needs only one proven
 * payment to be a buyer -- which is what makes this affordable.
 */

import type { RpcClient } from '../adapters/token-updates/rpc.js';

const XFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export interface PaymentProof {
  paid: boolean;
  /** What was given up, for the report. Empty when nothing was. */
  how: string;
  /**
   * Was a pool actually paid in this transaction?
   *
   * NOT "did the wallet hand a pool the money" -- that is the log-based rule
   * this replaces, and on the normal path it is false: the wallet sends native
   * ETH to a router, the router wraps it, and the POOL receives WETH from the
   * router. Asking whether the wallet's own address appears as the sender is
   * what rejected 39 of 40 real buyers.
   *
   * So this asks the weaker, answerable question: did any pricing asset reach
   * a pool counterparty in this transaction, from anyone. Where payment is
   * proven and this is false, the rule still accepts -- the document's
   * definition asks only that the wallet gave up value -- but the case is
   * reported as purpose-unproven rather than hidden inside the accept total.
   */
  reachedAPool: boolean | null;
  /** The old rule's question, kept only to size the difference. */
  walletPaidPoolDirectly: boolean | null;
  /** True when the native test failed and a receipt had to be bought. */
  neededReceipt: boolean;
}

interface CachedTx {
  txFrom: string;
  txValue: bigint;
  txTo: string;
  /**
   * Sender of each ERC-20 Transfer, with the token contract it moved. Null
   * until the receipt has actually been fetched -- see the two-step order in
   * `prove`. Null is "not looked at", never "there were none".
   */
  sends: { token: string; from: string; to: string; raw: bigint }[] | null;
}

/**
 * Caches one receipt per transaction. Deliberately NOT a global: a run should
 * be able to bound and report its own receipt count.
 */
export class ReceiptPayments {
  private readonly cache = new Map<string, CachedTx>();
  private txFetched = 0;
  private receiptFetched = 0;
  /** Wallets already proven to have paid somewhere; see `provenWallets`. */
  private readonly proven = new Set<string>();

  constructor(
    private readonly rpc: RpcClient,
    /** The token being bought; sending it back is not a payment. */
    private readonly token: string,
    /** v3 pools plus the v4 PoolManager, lowercased. */
    private readonly poolCounterparties: Set<string>,
  ) {}

  get receiptsFetched(): number {
    return this.receiptFetched;
  }

  get transactionsFetched(): number {
    return this.txFetched;
  }

  /** 15 CU per transaction read, 15 more only when a receipt was needed. */
  get cuSpent(): number {
    return this.txFetched * 15 + this.receiptFetched * 15;
  }

  /** The transaction alone: sender, value, callee. 15 CU. */
  private async loadTx(txHash: string): Promise<CachedTx> {
    const hit = this.cache.get(txHash);
    if (hit) return hit;

    const tx = (await this.rpc.raw('eth_getTransactionByHash', [txHash])) as {
      from?: string; value?: string; to?: string;
    } | null;
    this.txFetched += 1;
    // A transaction that cannot be read is a failed read, not an absent payment.
    if (!tx) {
      throw new Error(`could not read transaction ${txHash}; refusing to call that "unpaid"`);
    }
    const entry: CachedTx = {
      txFrom: (tx.from ?? '').toLowerCase(),
      txValue: BigInt(tx.value ?? '0x0'),
      txTo: (tx.to ?? '').toLowerCase(),
      sends: null,
    };
    this.cache.set(txHash, entry);
    return entry;
  }

  /** The receipt's Transfer logs. A further 15 CU, and only when needed. */
  private async loadReceipt(txHash: string, entry: CachedTx): Promise<CachedTx> {
    if (entry.sends !== null) return entry;

    const receipt = (await this.rpc.raw('eth_getTransactionReceipt', [txHash])) as {
      logs?: { address: string; topics: string[]; data: string }[];
    } | null;
    this.receiptFetched += 1;
    if (!receipt) {
      throw new Error(`could not read receipt for ${txHash}; refusing to call that "unpaid"`);
    }

    const sends: CachedTx['sends'] = [];
    for (const l of receipt.logs ?? []) {
      if ((l.topics[0] ?? '').toLowerCase() !== XFER || l.topics.length < 3) continue;
      sends.push({
        token: l.address.toLowerCase(),
        from: '0x' + l.topics[1]!.slice(-40).toLowerCase(),
        to: '0x' + l.topics[2]!.slice(-40).toLowerCase(),
        raw: BigInt(l.data === '0x' ? '0x0' : l.data),
      });
    }
    entry.sends = sends;
    return entry;
  }

  /**
   * THE CHEAP HALF FIRST. Measured on this chain, native ETH is how the large
   * majority of buyers pay, and that is visible in the transaction alone: the
   * wallet is the sender and `value` is non-zero. That costs 15 CU and needs no
   * receipt at all.
   *
   * The receipt -- another 15 CU -- is fetched only when the native test fails,
   * because then the only remaining way to have paid is an ERC-20 leg, which
   * lives in the logs. Ordering the two this way is not an approximation: every
   * case still gets a definite answer, and the answer is identical to fetching
   * both. It only avoids buying evidence that cannot change the verdict.
   */
  async prove(txHash: string, wallet: string): Promise<PaymentProof> {
    const key = txHash.toLowerCase();
    const w = wallet.toLowerCase();
    const token = this.token.toLowerCase();

    const t = await this.loadTx(key);
    if (t.txFrom === w && t.txValue > 0n) {
      this.proven.add(w);
      return {
        paid: true, how: `${t.txValue.toString()} wei native`,
        // Not looked at: settling it would cost a receipt that cannot change
        // the verdict. Null is "unknown", never "no".
        reachedAPool: null, walletPaidPoolDirectly: null, neededReceipt: false,
      };
    }

    await this.loadReceipt(key, t);
    const sends = t.sends!;
    const tokenSends = sends.filter((s) => s.from === w && s.token !== token);
    const poolWasPaid = sends.some(
      (s) => s.token !== token && this.poolCounterparties.has(s.to),
    );
    const direct = tokenSends.some((s) => this.poolCounterparties.has(s.to));

    if (tokenSends.length === 0) {
      return {
        paid: false, how: '', reachedAPool: poolWasPaid,
        walletPaidPoolDirectly: false, neededReceipt: true,
      };
    }
    this.proven.add(w);
    return {
      paid: true,
      how: tokenSends.map((s) => `${s.raw.toString()} raw of ${s.token}`).join(' + '),
      reachedAPool: poolWasPaid, walletPaidPoolDirectly: direct, neededReceipt: true,
    };
  }

  /** Wallets proven to have paid at least once during this run. */
  get provenWallets(): ReadonlySet<string> {
    return this.proven;
  }
}

/**
 * Prove cohort membership: which of these wallets bought.
 *
 * ONE PROVEN PAYMENT PER WALLET, and proving stops there. Membership asks "did
 * this wallet buy", which one purchase answers for good. Walking every
 * candidate transaction instead costs $4.23 an intake against $0.13, for a
 * precision the `inflated-pnl` flag already delivers -- see docs/ROBINHOOD.md
 * step 7, where this is recorded as settled.
 *
 * `candidates` maps a wallet to the transactions in which it received the token
 * from a pool, cheapest first is not required -- the loop exits on the first
 * success either way.
 *
 * `alreadyProven` is the free fast path: wallets `token_payment_logs` already
 * shows paying a pool directly. Those cost nothing to confirm.
 */
export async function provenBuyers(
  rpc: RpcClient,
  token: string,
  poolCounterparties: Iterable<string>,
  candidates: Map<string, string[]>,
  alreadyProven: ReadonlySet<string>,
): Promise<{
  buyers: Set<string>;
  walletsProvenFree: number;
  walletsProvenByRpc: number;
  walletsWithNoPaymentInAnyTransaction: number;
  transactionsRead: number;
  receiptsRead: number;
  cuSpent: number;
}> {
  const prover = new ReceiptPayments(
    rpc, token, new Set([...poolCounterparties].map((a) => a.toLowerCase())),
  );
  const buyers = new Set<string>();
  let free = 0;
  let byRpc = 0;
  let unpaid = 0;

  for (const [wallet, txs] of candidates) {
    const w = wallet.toLowerCase();
    if (alreadyProven.has(w)) {
      buyers.add(w);
      free += 1;
      continue;
    }
    let proven = false;
    for (const txHash of txs) {
      const proof = await prover.prove(txHash, w);
      if (proof.paid) { proven = true; break; }
    }
    if (proven) { buyers.add(w); byRpc += 1; } else { unpaid += 1; }
  }

  return {
    buyers,
    walletsProvenFree: free,
    walletsProvenByRpc: byRpc,
    walletsWithNoPaymentInAnyTransaction: unpaid,
    transactionsRead: prover.transactionsFetched,
    receiptsRead: prover.receiptsFetched,
    cuSpent: prover.cuSpent,
  };
}

/**
 * The free fast path: wallets `token_payment_logs` already shows sending a
 * pricing asset straight to a pool. That is the rejected rule's evidence, and
 * while it is far too narrow to DECIDE payment, every wallet in it did pay --
 * so it is sound as a shortcut and unsound as a test. It is not worth
 * collecting for a new token; it is worth reading where it already exists.
 */
export async function fastPathPayers(
  client: { query: (sql: string, params: unknown[]) => Promise<{ rows: { payer: string }[] }> },
  chain: string,
  token: string,
): Promise<Set<string>> {
  const res = await client.query(
    `select distinct payer from token_payment_logs where chain = $1 and token = $2`,
    [chain, token],
  );
  return new Set(res.rows.map((r) => r.payer.toLowerCase()));
}

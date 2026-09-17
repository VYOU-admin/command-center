/**
 * THE SIGNING AND BROADCAST PATH. IT EXISTS, AND IT IS UNREACHABLE OUTSIDE LIVE MODE.
 *
 * `LAUNCHBOT.md` section 2A. **THIS IS THE ONLY FILE IN THE REPOSITORY THAT MAY READ A
 * PRIVATE KEY OR CONSTRUCT A SIGNER**, and `scripts/check-live-gate.mjs` FAILS THE BUILD
 * if the key's variable name, `ethers`' `Wallet`, or `eth_sendRawTransaction` appears
 * anywhere else. That is a static guarantee rather than a convention: an edit that starts
 * reading a key from a second place cannot be deployed.
 *
 * ---------------------------------------------------------------------------
 * NO KEY EXISTS YET, AND THAT IS THE POINT OF BUILDING THIS FIRST
 * ---------------------------------------------------------------------------
 *
 * The operator's instruction was that live mode "must exist and be provably off before any
 * key is added — there must be nothing for it to do wrong when it arrives". So this path
 * is written, gated and exercised while `BOT_PRIVATE_KEY` is unset, which means every
 * refusal below has been observed rather than asserted, and the arrival of a key changes
 * no code.
 *
 * **THIS HAS NOW SIGNED AND SUBMITTED, AND THE NODE REJECTED IT** — 2026-09-16, on the
 * first real attempt, for `max fee per gas less than block base fee`. Nothing landed and
 * no gas was spent, and the fee construction below is what that rejection changed. The
 * claim here used to read "nothing has ever signed or broadcast", which stopped being
 * true the moment it did.
 *
 * The signing arithmetic is `ethers`', not ours — `LAUNCHBOT.md` section 2 records why
 * that dependency was chosen: hand-rolling secp256k1, RLP and EIP-1559 is exactly what
 * loses money. The wiring around it is what had to be got right, and the first
 * transaction it was pointed at was deliberately the bounded approval of `approve-setup`
 * rather than a trade — so the defect surfaced on a call that moved nothing.
 *
 * ---------------------------------------------------------------------------
 * THE NONCE IS TRACKED ACROSS A TRADE, AND THE CHAIN SEEDS IT RATHER THAN DECIDING IT
 * ---------------------------------------------------------------------------
 *
 * **THIS KILLED THE FIRST LIVE RUN AFTER FOUR MINUTES.** It was read per transaction as
 * `eth_getTransactionCount(address, 'pending')`, on the reasoning that a replaced
 * container must not be able to reuse one. That reasoning still holds and is preserved
 * below. What it got wrong is that **`'pending'` LAGS A RECEIPT WE HAVE ALREADY
 * CONFIRMED**: on trade 614's STEP 2 the node answered 136 for an account whose state
 * was already 137, and the send was rejected `nonce too low: tx: 136 state: 137`.
 *
 * **A CONFIRMED RECEIPT IS BETTER INFORMATION THAN THE NODE'S MEMPOOL VIEW.** Section 2D
 * already requires that MINED is the only outcome that permits the next send, so when we
 * are about to send again we have a mined receipt for nonce N in hand — and the next
 * nonce is N+1 as a matter of arithmetic, whatever `'pending'` currently says.
 *
 * So the chain SEEDS the counter and confirmed sends ADVANCE it:
 *
 *   first send of a process   -> read from the chain
 *   a broadcast we got a hash for -> the next nonce is this one + 1
 *   a broadcast that THREW    -> INVALIDATE, and re-read from the chain next time
 *
 * **THE COUNTER IS INVALIDATED BEFORE THE BROADCAST AND SET AFTER IT, NEVER THE OTHER
 * WAY ROUND.** A throw is not proof nothing was sent — section 2C's own rule — so after
 * one we can neither reuse the nonce nor assume it advanced, and the only honest state
 * is "ask the chain". That is also why the invalidation is not in a `catch`: a throw
 * between signing and the result being read must leave it invalid too.
 *
 * **THE ORIGINAL GUARANTEE IS UNCHANGED.** The counter lives in this closure and dies
 * with the process, so a replaced container reads the chain on its first send and cannot
 * reuse anything. What it must not do is survive a container, and it cannot.
 *
 * **ONE HAZARD IT DOES NOT REMOVE, STATED RATHER THAN DISCOVERED:** a second process
 * signing for the same address concurrently. Its sends are invisible here, so our
 * counter goes stale — exactly as a `'pending'` read would have been raced. That is
 * recovered rather than ignored: a rejection naming a too-low nonce invalidates the
 * counter, re-reads the chain and retries ONCE, which is safe precisely because such a
 * rejection is proof the transaction was NOT accepted.
 */
import { Wallet } from 'ethers';
import type { BotMode } from './mode.js';
import { LIVE_FLAG } from './mode.js';

/** The ONLY key variable this repository reads, and only from this file. */
export const KEY_ENV = 'BOT_PRIVATE_KEY';

/** Robinhood Chain, from ROBINHOOD.md section 3. Asserted against the endpoint. */
export const CHAIN_ID = 4663;

export interface SignRpc { call(method: string, params: unknown[]): Promise<unknown> }

export interface UnsignedTx {
  to: string;
  data: string;
  value: bigint;
  /** What this transaction is for, carried into the log and the stored row. */
  description: string;
}

export interface Broadcaster {
  readonly address: string;
  /** Signs and sends. Returns the transaction hash. */
  send(tx: UnsignedTx): Promise<string>;
  /**
   * Drop the tracked nonce so the next send re-reads it from the chain.
   * Called by a caller that has reconciled against the chain itself, and by the drill.
   */
  resyncNonce(): void;
  /** The nonce the next send WOULD use without asking the chain, or null. */
  trackedNonce(): number | null;
  /** The nonce actually used by the most recent successful send, or null. */
  lastNonce(): number | null;
}

/**
 * THE REFUSAL, AS ITS OWN EXPORTED FUNCTION SO IT CAN BE DEMONSTRATED.
 *
 * Callers on a non-live path can assert their own unreachability, and the drill can prove
 * the refusal fires rather than taking the absence of a signer on trust.
 */
export function assertNotLive(mode: BotMode, what: string): void {
  if (mode.live) {
    throw new Error(`${what} was reached in LIVE mode, where it must not be`);
  }
}

/**
 * Construct the broadcaster. **THE GATE IS HERE AND IT IS THE FIRST THING THAT RUNS.**
 *
 * Two refusals, in this order, and the order matters:
 *
 *  1. NOT LIVE -> refuse before the key is even looked for. A non-live process must not
 *     so much as read the variable, because "we read it but did not use it" is a weaker
 *     guarantee than "the read is unreachable", and a key in a process's memory is a key
 *     that can appear in a crash dump or a log line.
 *  2. LIVE WITH NO KEY -> refuse AT STARTUP, naming the variable. The operator's
 *     requirement was explicit: it must not fail later, mid-trade. A bot that arms, finds
 *     a launch, builds calldata and only then discovers it cannot sign has already spent
 *     the compute units and, worse, may have a position open.
 */
export async function createBroadcaster(
  mode: BotMode, rpc: SignRpc,
): Promise<Broadcaster> {
  if (!mode.live) {
    throw new Error('NO SIGNING PATH EXISTS OUTSIDE LIVE MODE. createBroadcaster was '
      + `called in mode "${mode.label}"; the private key is not read, no signer is `
      + `constructed, and eth_sendRawTransaction is refused by name. Pass ${LIVE_FLAG} `
      + 'deliberately if you mean to trade with real money.');
  }

  const raw = process.env[KEY_ENV];
  if (!raw || raw.trim() === '') {
    throw new Error(`LIVE MODE REQUIRES ${KEY_ENV} AND IT IS NOT SET. Refusing to start `
      + 'rather than failing mid-trade: a bot that arms, finds a launch and only then '
      + 'discovers it cannot sign has spent the compute units and may hold a position. '
      + 'No key is read in this build and none is expected yet.');
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw.trim())) {
    /* A malformed key is not a missing one and must not be reported as one. */
    throw new Error(`${KEY_ENV} is set but is not a 32-byte hex private key. Refusing to `
      + 'derive an address from a malformed value.');
  }

  const wallet = new Wallet(raw.trim());
  const address = wallet.address.toLowerCase();

  /*
   * THE CHAIN IS CONFIRMED BEFORE ANYTHING CAN BE SIGNED FOR IT. A correctly signed
   * transaction for the wrong chain is a perfectly valid transaction somewhere else.
   */
  const idHex = String(await rpc.call('eth_chainId', []));
  const id = Number(BigInt(idHex));
  if (id !== CHAIN_ID) {
    throw new Error(`endpoint reports chainId ${id} (${idHex}), expected ${CHAIN_ID}. `
      + 'Refusing to sign for the wrong chain.');
  }

  /*
   * THE CONFIGURED WALLET AND THE KEY MUST BE THE SAME ADDRESS. Otherwise every balance
   * read, every rail and every reconciliation is about one account while the signing is
   * about another — and the bot would arm against a balance it cannot spend.
   */
  const configured = process.env['BOT_WALLET_ADDRESS']?.trim().toLowerCase();
  if (configured && configured !== address) {
    throw new Error(`${KEY_ENV} derives ${address} but BOT_WALLET_ADDRESS is `
      + `${configured}. Every rail, balance read and reconciliation is about the `
      + 'configured address; signing with a different one would arm against a balance '
      + 'this key cannot spend.');
  }

  /*
   * THE TRACKED NONCE. `null` means "ask the chain", which is the state a process starts
   * in and the state any unresolved broadcast returns it to.
   */
  let nextNonce: number | null = null;
  let lastUsed: number | null = null;

  const readChainNonce = async (): Promise<number> => {
    const hex = String(await rpc.call('eth_getTransactionCount', [address, 'pending']));
    const n = Number(BigInt(hex));
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(`eth_getTransactionCount returned ${hex}, which is not a nonce`);
    }
    return n;
  };

  /** Build and sign at an EXACT nonce, so a retry can re-sign at a corrected one. */
  const signAt = async (tx: UnsignedTx, nonce: number): Promise<string> => {
    const estHex = String(await rpc.call('eth_estimateGas', [{
      from: address, to: tx.to, value: `0x${tx.value.toString(16)}`, data: tx.data,
    }]));

    /*
     * ---------------------------------------------------------------------
     * EIP-1559, AND THE FIRST REAL TRANSACTION IS WHY
     * ---------------------------------------------------------------------
     *
     * This built a LEGACY (type 0) transaction with `gasPrice` straight from
     * `eth_gasPrice`, and the first real send was REJECTED BY THE NODE:
     *
     *   max fee per gas less than block base fee:
     *   maxFeePerGas: 49556000  baseFee: 49626000
     *
     * Two defects in one line. **This chain has a base fee**, so a legacy transaction
     * must carry a `gasPrice` at or above it — and `eth_gasPrice` was 0.14% BELOW the
     * base fee by the time the node saw it. At a measured 100.52 ms block interval the
     * base fee moves between the read and the send, so a figure used verbatim is a race
     * this would lose again at random.
     *
     * **HEADROOM IS FREE UNDER EIP-1559 AND IS NOT UNDER LEGACY**, which is the reason
     * to change type rather than just add a margin. A type-2 transaction is charged
     * `baseFee + tip` and the rest of `maxFeePerGas` is never spent, so a generous
     * ceiling costs nothing; a legacy transaction is charged its whole `gasPrice`, so
     * the same margin would be paid on every transaction for ever.
     *
     * The fallback is stated rather than assumed: a chain with NO `baseFeePerGas` is
     * pre-1559 and takes the legacy shape, with a margin, because there is nothing to
     * be refunded from.
     */
    const blk = (await rpc.call('eth_getBlockByNumber', ['latest', false])) as
      { baseFeePerGas?: string } | null;
    if (blk === null || blk === undefined) {
      throw new Error('eth_getBlockByNumber returned no head block, so the fee market '
        + 'is UNKNOWN. Refusing to guess a gas price for a real transaction.');
    }

    const gasLimit = BigInt(estHex);
    const base: Record<string, unknown> = {
      to: tx.to, data: tx.data, value: tx.value, nonce, gasLimit, chainId: CHAIN_ID,
    };

    let fees: Record<string, unknown>;
    if (blk.baseFeePerGas !== undefined) {
      const baseFee = BigInt(blk.baseFeePerGas);
      let tip: bigint;
      try {
        tip = BigInt(String(await rpc.call('eth_maxPriorityFeePerGas', [])));
      } catch {
        const gp = BigInt(String(await rpc.call('eth_gasPrice', [])));
        tip = gp > baseFee ? gp - baseFee : baseFee / 10n;
      }
      fees = { type: 2, maxPriorityFeePerGas: tip, maxFeePerGas: baseFee * 2n + tip };
    } else {
      /* PRE-1559: legacy, with a margin, because nothing is refunded here. */
      const gp = BigInt(String(await rpc.call('eth_gasPrice', [])));
      fees = { type: 0, gasPrice: gp + gp / 10n };
    }
    return wallet.signTransaction({ ...base, ...fees });
  };

  /**
   * ONE ATTEMPT AT ONE NONCE.
   *
   * The counter is INVALIDATED BEFORE the broadcast and SET AFTER it. A throw anywhere
   * between the two therefore leaves it invalid, which is the only honest state: section
   * 2C's rule is that a throw is not proof nothing was sent, so the nonce can neither be
   * reused nor assumed spent.
   */
  const attempt = async (tx: UnsignedTx, nonce: number): Promise<string> => {
    const signed = await signAt(tx, nonce);
    nextNonce = null;
    const hash = await rpc.call('eth_sendRawTransaction', [signed]);
    if (typeof hash !== 'string' || !hash.startsWith('0x')) {
      throw new Error(`eth_sendRawTransaction returned ${JSON.stringify(hash)}; the `
        + 'transaction may or may not be in flight and MUST be reconciled against the '
        + 'chain before anything else is sent.');
    }
    nextNonce = nonce + 1;
    lastUsed = nonce;
    return hash;
  };

  return {
    address,
    resyncNonce(): void { nextNonce = null; },
    trackedNonce(): number | null { return nextNonce; },
    lastNonce(): number | null { return lastUsed; },

    async send(tx: UnsignedTx): Promise<string> {
      const nonce = nextNonce ?? await readChainNonce();
      try {
        return await attempt(tx, nonce);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        /*
         * A REJECTION NAMING A TOO-LOW NONCE IS PROOF THE TRANSACTION WAS NOT ACCEPTED,
         * which is what makes ONE retry safe here and makes it unsafe for every other
         * error. It is the recovery for the only hazard tracking introduces: another
         * process signing for this address while we hold a stale counter.
         */
        if (!/nonce too low/i.test(msg)) throw err;
        const fresh = await readChainNonce();
        return attempt(tx, fresh);
      }
    },
  };
}

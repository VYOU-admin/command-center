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
 * THE NONCE IS READ FROM THE CHAIN, NEVER CARRIED
 * ---------------------------------------------------------------------------
 *
 * Section 2 rule 5: a replaced container must not be able to reuse one. `ROBINHOOD.md`
 * records containers being replaced mid-job twice, so a nonce held in memory is a nonce
 * that can be spent twice. It is fetched per transaction, from the chain.
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

  return {
    address,
    async send(tx: UnsignedTx): Promise<string> {
      /* THE NONCE IS READ PER TRANSACTION, NEVER CARRIED. Section 2 rule 5. */
      const nonceHex = String(await rpc.call('eth_getTransactionCount',
        [address, 'pending']));
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
        to: tx.to, data: tx.data, value: tx.value,
        nonce: Number(BigInt(nonceHex)), gasLimit, chainId: CHAIN_ID,
      };

      let fees: Record<string, unknown>;
      if (blk.baseFeePerGas !== undefined) {
        const baseFee = BigInt(blk.baseFeePerGas);
        /*
         * THE TIP IS ASKED FOR AND DERIVED ONLY IF THE METHOD IS ABSENT. `eth_gasPrice`
         * on a 1559 chain is conventionally `baseFee + tip`, so the difference is the
         * node's own view of the tip — a derivation from a real figure rather than a
         * number chosen here. A floor applies only if that difference is non-positive.
         */
        let tip: bigint;
        try {
          tip = BigInt(String(await rpc.call('eth_maxPriorityFeePerGas', [])));
        } catch {
          const gp = BigInt(String(await rpc.call('eth_gasPrice', [])));
          tip = gp > baseFee ? gp - baseFee : baseFee / 10n;
        }
        /* 2x the base fee plus the tip. Never spent above baseFee+tip, so the headroom
         * absorbs a rising base fee at no cost. */
        fees = {
          type: 2,
          maxPriorityFeePerGas: tip,
          maxFeePerGas: baseFee * 2n + tip,
        };
      } else {
        /* PRE-1559: legacy, with a margin, because nothing is refunded here. */
        const gp = BigInt(String(await rpc.call('eth_gasPrice', [])));
        fees = { type: 0, gasPrice: gp + gp / 10n };
      }

      const signed = await wallet.signTransaction({ ...base, ...fees });
      const hash = await rpc.call('eth_sendRawTransaction', [signed]);
      if (typeof hash !== 'string' || !hash.startsWith('0x')) {
        /* A broadcast whose result cannot be read is NOT a broadcast that failed — the
         * transaction may well be in flight. It raises so the caller reconciles against
         * the chain rather than assuming either outcome. */
        throw new Error(`eth_sendRawTransaction returned ${JSON.stringify(hash)}; the `
          + 'transaction may or may not be in flight and MUST be reconciled against the '
          + 'chain before anything else is sent.');
      }
      return hash;
    },
  };
}

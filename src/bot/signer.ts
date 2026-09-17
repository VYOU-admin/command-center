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
 * **NOTHING HERE HAS EVER SIGNED OR BROADCAST A TRANSACTION.** The signing arithmetic is
 * `ethers`', not ours — `LAUNCHBOT.md` section 2 records why that dependency was chosen:
 * hand-rolling secp256k1, RLP and EIP-1559 is exactly what loses money. But the wiring
 * around it is untested against a real key by construction, and the first transaction it
 * is pointed at must be the bounded approval of `approve-setup`, not a trade.
 *
 * ---------------------------------------------------------------------------
 * THE NONCE IS READ FROM THE CHAIN, NEVER CARRIED
 * ---------------------------------------------------------------------------
 *
 * Section 2 rule 5: a replaced container must not be able to reuse one. `ROBINHOOD.md`
 * records containers being replaced mid-job twice, so a nonce held in memory is a nonce
 * that can be spent twice. It is fetched per transaction, from the chain.
 */
import { Transaction, Wallet } from 'ethers';
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
      const gasHex = String(await rpc.call('eth_gasPrice', []));
      const estHex = String(await rpc.call('eth_estimateGas', [{
        from: address, to: tx.to, value: `0x${tx.value.toString(16)}`, data: tx.data,
      }]));

      const signed = await wallet.signTransaction(Transaction.from({
        to: tx.to,
        data: tx.data,
        value: tx.value,
        nonce: Number(BigInt(nonceHex)),
        gasLimit: BigInt(estHex),
        gasPrice: BigInt(gasHex),
        chainId: CHAIN_ID,
        type: 0,
      }).toJSON());

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

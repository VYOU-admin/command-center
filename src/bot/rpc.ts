/**
 * The bot's RPC clients. TWO of them, and which one you can build is decided by the mode.
 *
 * THE DENY-LIST IS THE POINT. A dry run must not be able to broadcast, and "we did not
 * write the call" is a weaker guarantee than "the call is refused". Any method that could
 * move money is rejected by name in `ReadOnlyRpc`, so a future edit that reaches for one
 * fails loudly instead of succeeding quietly.
 *
 * ---------------------------------------------------------------------------
 * WHY `ReadOnlyRpc` IS NOT MADE MODE-AWARE
 * ---------------------------------------------------------------------------
 *
 * The obvious shape is one client that permits broadcasting when `mode.live`. That is
 * exactly wrong: it would mean every existing call site — the dry run, the drills, the
 * measurement CLIs, `wallet-probe` — silently gains the ability to broadcast the moment
 * someone passes `--live`, and the guarantee would rest on none of them ever being handed
 * a live mode by accident.
 *
 * So `ReadOnlyRpc` REFUSES FOREVER, in every mode including live, and a live path must
 * reach for `BroadcastRpc` explicitly and by name. **Broadcasting is opt-in per call
 * site, not a property the process acquires.** `ROBINHOOD.md`'s standing lesson applies:
 * a capability that arrives as a side effect of another change is indistinguishable from
 * no guarantee at all until someone reads the whole path.
 */
import { RpcClient } from '../adapters/token-updates/rpc.js';
import type { BotMode } from './mode.js';
import { LIVE_FLAG } from './mode.js';

/**
 * Every method that could move money or authorise moving it.
 *
 * `eth_sendRawTransaction` is the broadcast; the rest are ways to obtain a signature that
 * someone else could broadcast, which is the same exposure one step removed.
 */
const FORBIDDEN = new Set([
  'eth_sendRawTransaction', 'eth_sendTransaction', 'eth_sign', 'eth_signTransaction',
  'eth_signTypedData', 'eth_signTypedData_v4', 'personal_sign', 'personal_sendTransaction',
]);

/** Exported so the gate drill can demonstrate the refusal over the real list. */
export const FORBIDDEN_METHODS: readonly string[] = [...FORBIDDEN];

export class ReadOnlyRpc {
  constructor(private readonly inner: RpcClient) {}

  get cuSpent(): number { return this.inner.cuSpent; }

  async call(method: string, params: unknown[]): Promise<unknown> {
    if (FORBIDDEN.has(method)) {
      throw new Error(
        `${method} is refused by ReadOnlyRpc BY NAME, in every mode including live. `
        + 'Broadcasting is opt-in per call site: a live path must construct a '
        + 'BroadcastRpc explicitly, which is only possible in live mode.',
      );
    }
    return this.inner.raw(method, params);
  }
}

/**
 * THE BROADCAST-CAPABLE CLIENT. CONSTRUCTING IT IS THE PRIVILEGE, NOT CALLING IT.
 *
 * It cannot be built outside live mode, so in every other mode there is no object in the
 * process that can reach `eth_sendRawTransaction` at all — which is a stronger statement
 * than "the call would have been refused".
 *
 * It still refuses the SIGNING methods. The bot signs locally with its own key in
 * `bot/signer.ts` and never asks a node to sign for it; a node-side signing method is
 * either a misconfiguration or an attempt to use an unlocked account, and neither is
 * something this bot should be able to do.
 */
export class BroadcastRpc {
  constructor(private readonly inner: RpcClient, mode: BotMode) {
    if (!mode.live) {
      throw new Error('BroadcastRpc CANNOT BE CONSTRUCTED OUTSIDE LIVE MODE. It was asked '
        + `for in mode "${mode.label}". In every non-live mode no object in this process `
        + `can reach eth_sendRawTransaction. Pass ${LIVE_FLAG} deliberately if you mean `
        + 'to trade with real money.');
    }
  }

  get cuSpent(): number { return this.inner.cuSpent; }

  async call(method: string, params: unknown[]): Promise<unknown> {
    if (method !== 'eth_sendRawTransaction' && FORBIDDEN.has(method)) {
      throw new Error(`${method} is refused even in live mode: this bot signs locally with `
        + 'its own key and never asks a node to sign for it. A node-side signing method is '
        + 'either a misconfiguration or an unlocked account.');
    }
    return this.inner.raw(method, params);
  }
}

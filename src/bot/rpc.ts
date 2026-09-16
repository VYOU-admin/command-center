/**
 * The bot's RPC client. READ AND SIMULATE ONLY.
 *
 * THE DENY-LIST IS THE POINT. This pass must not be able to broadcast, and "we did not
 * write the call" is a weaker guarantee than "the call is refused". Any method that
 * could move money is rejected here, so a future edit that reaches for one fails loudly
 * instead of succeeding quietly.
 */
import { RpcClient } from '../adapters/token-updates/rpc.js';

const FORBIDDEN = new Set([
  'eth_sendRawTransaction', 'eth_sendTransaction', 'eth_sign', 'eth_signTransaction',
  'eth_signTypedData', 'eth_signTypedData_v4', 'personal_sign', 'personal_sendTransaction',
]);

export class ReadOnlyRpc {
  constructor(private readonly inner: RpcClient) {}

  get cuSpent(): number { return this.inner.cuSpent; }

  async call(method: string, params: unknown[]): Promise<unknown> {
    if (FORBIDDEN.has(method)) {
      throw new Error(
        `${method} is refused: this build is dry-run only and carries no signing path. `
        + 'Broadcasting requires an explicitly approved live mode.',
      );
    }
    return this.inner.raw(method, params);
  }
}

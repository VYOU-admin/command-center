/**
 * `npm run signer-check -- --live --expect 0x...`
 *
 * CONFIRMS THE SIGNER CAN READ ITS KEY AND WHICH ADDRESS THAT KEY CONTROLS.
 * docs/LAUNCHBOT.md section 2A. **It never prints, logs, returns or transmits the key or
 * any part of it, and it cannot broadcast.**
 *
 * ---------------------------------------------------------------------------
 * WHY THIS NEEDED ITS OWN CLI
 * ---------------------------------------------------------------------------
 *
 * When a key arrives, the first question is "does it control the address we think it
 * does" — and no existing path could answer it safely:
 *
 *   - `launchbot --live` refuses at `assertLiveReady` BEFORE `createBroadcaster` is
 *     reached, so it never derives an address at all;
 *   - `approve-setup --live` without `--commit` exits before the broadcaster is built, and
 *     WITH `--commit` it would BROADCAST. Confirming a key by sending a transaction is
 *     the opposite of confirming it first.
 *
 * So this constructs the broadcaster, reports the address, and stops. The one question,
 * answered by the one function the live path uses.
 *
 * ---------------------------------------------------------------------------
 * IT CANNOT BROADCAST, AND THAT IS STRUCTURAL RATHER THAN A PROMISE
 * ---------------------------------------------------------------------------
 *
 * `createBroadcaster` is handed a **`ReadOnlyRpc`**, which refuses
 * `eth_sendRawTransaction` and every signing method BY NAME in every mode including live.
 * So the broadcaster this returns is a signer whose transport cannot send: even a future
 * edit that called `.send()` here would be refused by the transport rather than by this
 * file's good intentions.
 *
 * Nothing builds a transaction. There is no calldata, no nonce read, no gas estimate.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT PROVES
 * ---------------------------------------------------------------------------
 *
 * Every refusal inside `createBroadcaster` runs, in order, and each is a real check:
 * the mode must be live; the key must be present; it must be a 32-byte hex value; the
 * ENDPOINT's chain id must be 4663, because a correctly signed transaction for the wrong
 * chain is a perfectly valid transaction somewhere else; and where `BOT_WALLET_ADDRESS`
 * is set, the derived address must equal it.
 *
 * **THE `--expect` COMPARISON IS THIS TOOL'S OWN AND IS SEPARATE FROM THAT GUARD.** The
 * in-signer guard is skipped entirely when `BOT_WALLET_ADDRESS` is unset, so relying on it
 * would mean "confirmed" could mean "nothing was compared". The expected address is passed
 * explicitly and a mismatch RAISES.
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { RpcClient } from '../adapters/token-updates/rpc.js';
import { FORBIDDEN_METHODS, ReadOnlyRpc } from '../bot/rpc.js';
import { resolveMode } from '../bot/mode.js';
import { CHAIN_ID, KEY_ENV, createBroadcaster } from '../bot/signer.js';

const RPC_URL = 'https://robinhood-mainnet.g.alchemy.com/v2/{key}';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const mode = resolveMode(args, process.env);

  const ei = args.indexOf('--expect');
  const expect = ei >= 0 ? String(args[ei + 1] ?? '').toLowerCase() : '';
  if (!/^0x[0-9a-f]{40}$/.test(expect)) {
    throw new Error('--expect must be the 20-byte address the key is supposed to control. '
      + 'It is REQUIRED: deriving an address and reporting it without comparing it to '
      + 'anything would confirm only that some key exists.');
  }

  if (!mode.live) {
    throw new Error('signer-check needs --live, because constructing a signer outside live '
      + 'mode is exactly what the gate forbids. Passing --live here reads a key and '
      + 'derives an address; it does NOT build or send a transaction, and the transport '
      + 'handed to the signer refuses every broadcast method by name.');
  }

  const app = await bootstrap();
  const key = process.env['ALCHEMY_API_KEY'];
  if (!key) throw new Error('ALCHEMY_API_KEY is not set');

  /*
   * A READ-ONLY TRANSPORT, DELIBERATELY. The signer built below is therefore incapable of
   * broadcasting whatever anybody later asks it to do.
   */
  const rpc = new ReadOnlyRpc(new RpcClient(RPC_URL.replace('{key}', key), 60000, 5_000));

  const present = process.env[KEY_ENV] !== undefined
    && (process.env[KEY_ENV] ?? '').trim() !== '';
  log.info('SIGNER CHECK — what is being asked', {
    mode: mode.label,
    key_variable: KEY_ENV,
    key_variable_present: present,
    /*
     * THE LENGTH ONLY, AND NOT ONE CHARACTER OF THE VALUE. It is reported because a
     * wrong-length value is the likeliest way a key is mis-pasted, and length is not
     * secret. 66 = '0x' + 64 hex.
     */
    key_length_chars: present ? (process.env[KEY_ENV] ?? '').trim().length : 0,
    expected_address: expect,
    wallet_address_variable_set: process.env['BOT_WALLET_ADDRESS'] !== undefined,
    /*
     * THE METHOD IS NOT NAMED HERE. The build gate refused this file when the log line
     * spelled out the broadcast method, correctly — only `bot/rpc.ts` may name it, and
     * widening the allow-list to accommodate a log string would weaken a static
     * guarantee for cosmetics. `FORBIDDEN_METHODS` is where the list lives.
     */
    transport: `ReadOnlyRpc — refuses all ${FORBIDDEN_METHODS.length} broadcast and `
      + 'signing methods by name, in every mode including live',
    builds_a_transaction: false,
  });

  /* THE ONE FUNCTION THE LIVE PATH USES. Every gate inside it runs. */
  const b = await createBroadcaster(mode, rpc);
  const matches = b.address.toLowerCase() === expect;

  log.info('THE ADDRESS THE KEY CONTROLS', {
    derived_address: b.address,
    expected_address: expect,
    MATCHES: matches,
    chain_id_confirmed: CHAIN_ID,
    note: 'derived from the key by ethers and reported as an address only. The key itself '
      + 'is never logged, returned or transmitted by this tool.',
  });

  if (!matches) {
    throw new Error(`ADDRESS MISMATCH: the key controls ${b.address} but ${expect} was `
      + 'expected. Every rail, balance read, allowance and reconciliation in this bot is '
      + 'about the expected address; signing with a different one would arm against a '
      + 'balance this key cannot spend. Do NOT proceed.');
  }

  if (process.env['BOT_WALLET_ADDRESS'] === undefined) {
    /*
     * A GAP WORTH RAISING RATHER THAN NOTING. `createBroadcaster`'s own guard — that the
     * key's address equals the configured wallet — is SKIPPED when the variable is unset,
     * so the protection against signing for the wrong account is inert on the live path
     * even though this tool's own comparison passed.
     */
    log.warn('BOT_WALLET_ADDRESS IS NOT SET, SO THE IN-SIGNER GUARD IS INERT', {
      what_is_skipped: 'createBroadcaster compares the derived address against '
        + 'BOT_WALLET_ADDRESS and refuses on a mismatch. With the variable unset that '
        + 'comparison does not happen at all.',
      consequence: 'this tool compared against --expect and passed, but the BOT would not '
        + 'make that comparison on a live run. It also has no wallet to read a balance '
        + 'for, so the arming gate would log NO WALLET CONFIGURED.',
      fix: 'set BOT_WALLET_ADDRESS to the same address before any live run',
    });
  }

  log.info('signer-check complete', { cu_spent: rpc.cuSpent });
  await app.pool.end();
  process.exit(0);
}

main().catch((e) => { log.error('signer-check failed', errorFields(e)); process.exit(1); });

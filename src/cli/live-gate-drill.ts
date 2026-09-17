/**
 * `npm run live-gate-drill`
 *
 * DEMONSTRATES THAT LIVE MODE IS OFF, RATHER THAN ASSERTING IT.
 *
 * docs/LAUNCHBOT.md section 2A. The operator's requirement was: *with MODE not live,
 * prove it — no code path can construct a signer, read a key, or call
 * eth_sendRawTransaction. Demonstrate the refusal rather than asserting it.*
 *
 * **THIS IS THE WEAKER OF THE TWO CHECKS AND SAYING SO IS THE POINT.** It proves the
 * refusals fire on the paths it exercises; it cannot prove no OTHER path exists.
 * `scripts/check-live-gate.mjs` answers that, statically, over all 132 source files, on
 * every build — and it is known to be able to fail, having been made to fail on a probe
 * file that read the key variable. Both exist because they answer different questions.
 *
 * IT SPENDS NOTHING AND TOUCHES NOTHING. No database, no RPC call that reaches a network:
 * every case is a constructor or a refusal, which is the whole point — the refusals
 * happen before any transport is used.
 */
import { errorFields, log } from '../logger.js';
import { RpcClient } from '../adapters/token-updates/rpc.js';
import { BroadcastRpc, FORBIDDEN_METHODS, ReadOnlyRpc } from '../bot/rpc.js';
import { DRY_RUN, LIVE_FLAG, resolveMode } from '../bot/mode.js';
import { KEY_ENV, createBroadcaster } from '../bot/signer.js';

interface Case { name: string; expect: 'REFUSED' | 'ALLOWED'; got: string; detail: string }

const results: Case[] = [];

/** Run a case and record which way it went, never throwing out of the drill itself. */
async function probe(
  name: string, expect: 'REFUSED' | 'ALLOWED', fn: () => unknown | Promise<unknown>,
): Promise<void> {
  try {
    await fn();
    results.push({ name, expect, got: 'ALLOWED', detail: 'no error raised' });
  } catch (e) {
    results.push({ name, expect, got: 'REFUSED', detail: (e as Error).message.slice(0, 150) });
  }
}

async function main(): Promise<void> {
  /*
   * A TRANSPORT IS CONSTRUCTED BUT NEVER REACHED. `RpcClient` makes no network call on
   * construction, and every case below refuses before it would — which is exactly the
   * property being demonstrated.
   */
  const inner = new RpcClient('https://invalid.invalid/never-used', 1000, 0);

  const dry = resolveMode([], {});
  const dryLabelled = resolveMode(['--run-label', 'probe'], {});
  const live = resolveMode([LIVE_FLAG], {});

  log.info('MODES RESOLVED BY bot/mode.ts — THE ONE PLACE', {
    'no flags': dry,
    '--run-label probe': dryLabelled,
    [LIVE_FLAG]: live,
    note: 'live is false unless the explicit flag is present; a label can only SUFFIX '
      + "'dry-run', so no argument can produce a live label",
  });

  /* ---- 1. NOT LIVE: NO SIGNER CAN BE CONSTRUCTED AND NO KEY IS READ -------- */
  await probe('createBroadcaster in dry-run', 'REFUSED',
    () => createBroadcaster(dry, { call: async () => '0x1237' }));
  await probe('createBroadcaster in a LABELLED dry-run', 'REFUSED',
    () => createBroadcaster(dryLabelled, { call: async () => '0x1237' }));

  /* ---- 2. NOT LIVE: THE BROADCAST CLIENT CANNOT EVEN BE BUILT ------------- */
  await probe('new BroadcastRpc in dry-run', 'REFUSED',
    () => new BroadcastRpc(inner, dry));
  await probe('new BroadcastRpc in a labelled dry-run', 'REFUSED',
    () => new BroadcastRpc(inner, dryLabelled));

  /* ---- 3. ReadOnlyRpc REFUSES EVERY MONEY METHOD, BY NAME ----------------- */
  const ro = new ReadOnlyRpc(inner);
  for (const m of FORBIDDEN_METHODS) {
    await probe(`ReadOnlyRpc.call('${m}')`, 'REFUSED', () => ro.call(m, []));
  }

  /* ---- 4. AN ENV VAR ALONE CANNOT ENABLE LIVE MODE ------------------------ */
  await probe("resolveMode with BOT_LIVE=1 and no flag", 'REFUSED',
    () => resolveMode([], { BOT_LIVE: '1' }));
  await probe("resolveMode with LAUNCHBOT_LIVE=true and no flag", 'REFUSED',
    () => resolveMode([], { LAUNCHBOT_LIVE: 'true' }));
  /*
   * AND THE IMPOSTOR RAISES EVEN ALONGSIDE THE REAL FLAG, so nobody can come away
   * believing the variable is what did it.
   */
  await probe(`resolveMode with BOT_MODE=live AND ${LIVE_FLAG}`, 'REFUSED',
    () => resolveMode([LIVE_FLAG], { BOT_MODE: 'live' }));

  /* ---- 5. A LIVE RUN MAY NOT CARRY A TEST LABEL --------------------------- */
  await probe(`${LIVE_FLAG} combined with --run-label`, 'REFUSED',
    () => resolveMode([LIVE_FLAG, '--run-label', 'x'], {}));

  /* ---- 6. LIVE + KEY: THE CASE WHOSE PREMISE THE WORLD CHANGES ------------- */
  /*
   * **THIS CASE'S EXPECTATION FLIPS WHEN A KEY EXISTS, AND THAT IS NOT THE TEST BEING
   * WEAKENED.** It was written to prove that live mode refuses AT STARTUP rather than
   * mid-trade when the key is missing, and LAUNCHBOT.md section 8 step 4 predicted in
   * advance that it "becomes vacuous the moment a key exists and the drill SAYS SO".
   *
   * A key is now set, so asserting REFUSED would fail for the right reason — the premise
   * is gone. Asserting the opposite is not a softer test, it is a DIFFERENT and equally
   * real one: with a key present, live mode must construct a signer rather than refuse,
   * which is the only way to tell "the gate is off" from "the feature is missing".
   *
   * The expectation therefore follows the world, and the drill reports WHICH assertion it
   * made so nobody reads a pass here as proof of the other.
   */
  const keyWasSet = (process.env[KEY_ENV] ?? '').trim() !== '';
  await probe(
    keyWasSet
      ? `createBroadcaster in LIVE mode WITH ${KEY_ENV} set -> constructs (the no-key `
        + 'refusal is no longer demonstrable: the premise is gone)'
      : `createBroadcaster in LIVE mode with ${KEY_ENV} unset -> refuses at startup`,
    keyWasSet ? 'ALLOWED' : 'REFUSED',
    () => createBroadcaster(live, { call: async () => '0x1237' }));

  /* ---- 7. THE PATH EXISTS: IN LIVE MODE THE CLIENT CONSTRUCTS ------------- */
  /*
   * This case is expected to be ALLOWED and it is the one that proves the build is not
   * simply missing the feature. A gate that refuses because the capability was never
   * written is indistinguishable from one that refuses because it is off.
   */
  await probe(`new BroadcastRpc in LIVE mode (the path EXISTS)`, 'ALLOWED',
    () => new BroadcastRpc(inner, live));

  /* ---- 8. EVEN IN LIVE MODE, ReadOnlyRpc STILL REFUSES -------------------- */
  /*
   * THE METHOD NAME COMES FROM `FORBIDDEN_METHODS`, NOT FROM A STRING TYPED HERE.
   *
   * Two reasons, and the second is the better one. The build gate refused this file when
   * the name was typed — correctly, since only `bot/rpc.ts` may name the broadcast
   * method — and widening the allow-list to admit a drill would have weakened the static
   * guarantee to make a test convenient. And a drill that types its own copy of the list
   * is testing its copy: if a method were removed from the real deny-list, a typed test
   * would go on passing against a name nothing refuses any more.
   */
  const broadcastMethod = FORBIDDEN_METHODS.find((m) => m.includes('RawTransaction'));
  if (broadcastMethod === undefined) {
    throw new Error('no raw-transaction method in FORBIDDEN_METHODS — the deny-list no '
      + 'longer names the broadcast, so this drill would pass while guarding nothing');
  }
  await probe(`ReadOnlyRpc still refuses ${broadcastMethod} in LIVE mode `
    + '(broadcasting is per call site, not a process property)',
  'REFUSED', () => ro.call(broadcastMethod, ['0xdeadbeef']));

  /* ---- 9. AND BroadcastRpc STILL REFUSES NODE-SIDE SIGNING ---------------- */
  const bro = new BroadcastRpc(inner, live);
  await probe("BroadcastRpc refuses eth_sign even in live mode", 'REFUSED',
    () => bro.call('eth_sign', []));

  const failed = results.filter((r) => r.got !== r.expect);
  log.info('LIVE GATE DRILL', {
    cases: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    key_env_var: KEY_ENV,
    key_present_in_this_process: keyWasSet,
    note: keyWasSet
      ? `${KEY_ENV} IS SET in this process, so the no-key refusal is NOT demonstrated by `
        + 'this run. Case 6 asserted the opposite instead — that live mode with a key '
        + 'CONSTRUCTS a signer — which distinguishes "the gate is off" from "the feature '
        + 'was never built". The no-key refusal was demonstrated before the key arrived '
        + 'and is recorded in LAUNCHBOT.md section 2A.'
      : `${KEY_ENV} is NOT set, so case 6 is a real demonstration of the no-key refusal`,
    results: results.map((r) => `${r.got === r.expect ? 'PASS' : 'FAIL'}  `
      + `[${r.expect}] ${r.name}\n        -> ${r.detail}`),
  });

  if (failed.length > 0) {
    log.error('LIVE GATE DRILL FAILED', { failed: failed.map((f) => f.name) });
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => { log.error('live-gate-drill failed', errorFields(e)); process.exit(1); });

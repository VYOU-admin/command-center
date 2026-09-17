/**
 * `npm run nonce-drill` — PROVE THE NONCE FIX WITH REAL TRANSACTIONS.
 *
 * **THIS IS THE DEFECT THAT KILLED THE FIRST LIVE RUN AFTER FOUR MINUTES.** Trade 614's
 * STEP 2 was rejected `nonce too low: tx: 136 state: 137` — the signer had read
 * `eth_getTransactionCount(address, 'pending')` and the node answered 136 for an account
 * whose state was already 137, because **`'pending'` lags a receipt we had already
 * confirmed.** The guard held and nothing was double-sent, but the run stopped.
 *
 * The fix tracks the nonce across a trade: the chain seeds it, a broadcast we got a hash
 * for advances it, and a broadcast that threw invalidates it. **A drill against a test
 * double cannot prove any of that** — it would be testing the double's arithmetic — so
 * this sends REAL TRANSACTIONS and reads the nonces back off the chain.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT SENDS, AND WHY IT IS THE SAFEST THING THAT PROVES ANYTHING
 * ---------------------------------------------------------------------------
 *
 * Three bounded `approve` calls for ONE RAW UNIT of the USDG dust the wallet holds — the
 * same shape section 8 step 5 chose for the first transaction this project ever signed,
 * and for the same reason: **if the nonce handling is wrong, it is wrong on a call that
 * moves nothing.** The amounts differ (1, 2, 1) so each is a genuine state change rather
 * than a no-op the node might treat differently.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS ASSERTED, AND THE MEASUREMENT THAT MAKES IT WORTH RUNNING
 * ---------------------------------------------------------------------------
 *
 *   1. every send is followed by a MINED receipt before the next begins
 *   2. the nonces READ BACK FROM THE CHAIN are strictly consecutive
 *   3. the nonce the signer TRACKED equals the one the chain recorded
 *
 * And the one that says whether the fix was needed at all: **at the instant of each send
 * it also asks `eth_getTransactionCount('pending')` and records whether that lagged.**
 * A lag observed here is the original defect reproducing against the fix and being
 * survived; no lag is reported as no lag rather than as proof of anything.
 */
import { RpcClient } from '../adapters/token-updates/rpc.js';
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { BroadcastRpc, ReadOnlyRpc } from '../bot/rpc.js';
import { resolveMode } from '../bot/mode.js';
import { createBroadcaster } from '../bot/signer.js';
import { awaitReceipt } from '../bot/receipt.js';
import { buildTokenApprove } from '../bot/calldata.js';
import { RECEIPT_POLL_MS, RECEIPT_TIMEOUT_MS } from '../bot/config.js';

const RPC_URL = 'https://robinhood-mainnet.g.alchemy.com/v2/{key}';
/** The only token the wallet holds, at 6 decimals. One raw unit is 0.000001. */
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const AMOUNTS = [1n, 2n, 1n];

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const commit = args.includes('--commit');
  const mode = resolveMode(args, process.env);
  const key = process.env['ALCHEMY_API_KEY'];
  if (!key) throw new Error('ALCHEMY_API_KEY is not set');

  const app = await bootstrap();
  const inner = new RpcClient(RPC_URL.replace('{key}', key), 60000, 60_000);
  const read = new ReadOnlyRpc(inner);
  const pass: string[] = [];
  const fail: string[] = [];
  const record = (name: string, ok: boolean, detail: string): void => {
    (ok ? pass : fail).push(`${ok ? 'PASS' : 'FAIL'}  ${name}  —  ${detail}`);
    log.info(`${ok ? 'PASS' : 'FAIL'} ${name}`, { detail });
  };

  try {
    if (!commit) {
      log.warn('DRY — nothing will be sent', {
        note: 'this drill proves nothing without --live --commit, because a test double '
          + 'would be testing its own arithmetic rather than the signer',
        would_send: AMOUNTS.map((a) => `USDG.approve(Permit2, ${a})`),
      });
      return;
    }
    const sender = new BroadcastRpc(inner, mode);
    const bcast = await createBroadcaster(mode, sender);
    log.warn('NONCE DRILL — REAL TRANSACTIONS', {
      address: bcast.address, sends: AMOUNTS.length,
      tracked_before_anything: bcast.trackedNonce(),
    });

    /* A fresh process has nothing tracked: the FIRST send must read the chain. */
    record('a fresh signer tracks NOTHING and must seed from the chain',
      bcast.trackedNonce() === null, `trackedNonce()=${String(bcast.trackedNonce())}`);

    interface Row {
      i: number; tracked: number | null; pendingSaid: number; used: number;
      hash: string; outcome: string; waitMs: number; polls: number;
    }
    const rows: Row[] = [];
    const order: string[] = [];

    for (let i = 0; i < AMOUNTS.length; i += 1) {
      const amt = AMOUNTS[i] ?? 1n;
      const tracked = bcast.trackedNonce();
      /* WHAT THE NODE WOULD HAVE SAID, asked at the instant of the send. */
      const pendingSaid = Number(BigInt(String(
        await read.call('eth_getTransactionCount', [bcast.address, 'pending']))));

      const tx = buildTokenApprove(USDG, amt);
      order.push('SEND');
      const hash = await bcast.send({
        to: tx.to, data: tx.data, value: tx.value,
        description: `nonce-drill ${i + 1} of ${AMOUNTS.length}`,
      });
      const rec = await awaitReceipt(read, hash, {
        timeoutMs: RECEIPT_TIMEOUT_MS, pollMs: RECEIPT_POLL_MS,
      });
      order.push(`RECEIPT ${rec.outcome}`);

      /* THE NONCE THE CHAIN RECORDED, not the one we believe we used. */
      const onChain = (await read.call('eth_getTransactionByHash', [hash])) as
        { nonce?: string } | null;
      if (onChain?.nonce === undefined) {
        throw new Error(`eth_getTransactionByHash returned no nonce for ${hash}; the `
          + 'chain is the adjudicator and it did not answer');
      }
      const used = Number(BigInt(onChain.nonce));
      rows.push({ i: i + 1, tracked, pendingSaid, used, hash,
        outcome: rec.outcome, waitMs: rec.waitMs, polls: rec.polls });
      log.warn(`SEND ${i + 1} MINED`, {
        hash, nonce_on_chain: used, tracked_before_send: tracked,
        pending_said: pendingSaid,
        lagged: pendingSaid !== used ? `YES — 'pending' said ${pendingSaid}` : 'no',
        receipt_wait_ms: rec.waitMs, polls: rec.polls, outcome: rec.outcome,
      });
    }

    /* ---- THE ASSERTIONS ------------------------------------------------- */
    record('every send was MINED', rows.every((r) => r.outcome === 'mined'),
      rows.map((r) => r.outcome).join(', '));

    const consecutive = rows.every((r, k) => k === 0 || r.used === (rows[k - 1]?.used ?? -9) + 1);
    record('the nonces READ BACK FROM THE CHAIN are strictly consecutive',
      consecutive, rows.map((r) => r.used).join(' -> '));

    const trackedMatched = rows.every((r) => r.tracked === null || r.tracked === r.used);
    record('the nonce the signer TRACKED equals the one the chain recorded',
      trackedMatched,
      rows.map((r) => `${String(r.tracked)}/${r.used}`).join(' '));

    /* Between any two SENDs there must be a RECEIPT. The invariant, over the trace. */
    let lastSend = -1; let ordering = true;
    order.forEach((ev, k) => {
      if (ev === 'SEND') { if (lastSend >= 0) ordering = false; lastSend = k; }
      else lastSend = -1;
    });
    record('between any two SENDs there is a RECEIPT', ordering, order.join(' -> '));

    const lagged = rows.filter((r) => r.pendingSaid !== r.used);
    log.warn(lagged.length > 0
      ? "THE DEFECT REPRODUCED AND WAS SURVIVED: 'pending' LAGGED"
      : "'pending' did NOT lag on this run — reported as no lag, not as proof",
    {
      sends: rows.length, lagged: lagged.length,
      detail: rows.map((r) => ({ send: r.i, pending_said: r.pendingSaid,
        chain_recorded: r.used, lag: r.used - r.pendingSaid })),
      note: lagged.length > 0
        ? 'the OLD signer would have signed at the stale value and been rejected '
          + '"nonce too low", which is exactly how trade 614 died'
        : 'a lag is intermittent; its absence here does not mean the old code was safe',
    });

    /* ---- RESYNC IS EXERCISED TOO, NOT JUST DECLARED ---------------------- */
    const before = bcast.trackedNonce();
    bcast.resyncNonce();
    record('resyncNonce() drops the tracked value so the next send re-reads the chain',
      before !== null && bcast.trackedNonce() === null,
      `before=${String(before)} after=${String(bcast.trackedNonce())}`);

    log.warn('NONCE DRILL COMPLETE', {
      passed: pass.length, failed: fail.length,
      cu_spent: inner.cuSpent, failures: fail,
    });
    if (fail.length > 0) process.exitCode = 1;
  } catch (err) {
    log.error('nonce-drill failed', errorFields(err));
    process.exitCode = 1;
  } finally {
    await app.pool.end();
  }
}

void main();

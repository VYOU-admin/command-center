/**
 * THE ONE PLACE A BROADCAST'S RECEIPT IS WAITED FOR. docs/LAUNCHBOT.md section 2C.
 *
 * **THIS EXISTS BECAUSE THE SECOND CALLER ARRIVED**, which is the same reason
 * `bot/allowance.ts` exists. The loop was written inside `exit-exec`'s `send`; then
 * `approve-setup` needed it, because sending TWO approvals in sequence without confirming
 * the first is a nonce hazard — `signer.send` reads the nonce per transaction as
 * `'pending'`, and on a node that does not track the mempool the second send reuses the
 * first's nonce and REPLACES it. Copying the loop would have been the two-implementations
 * trap in the one place where the cost is a transaction landing twice or not at all.
 *
 * ---------------------------------------------------------------------------
 * THREE OUTCOMES, AND THE THIRD IS THE ONE THAT MATTERS
 * ---------------------------------------------------------------------------
 *
 *   `mined`   — a receipt with status 1. The transaction did what it said.
 *   `reverted`— a receipt with status 0. SETTLED: it definitively did not happen, and a
 *               caller may safely do something else.
 *   `unknown` — no receipt inside the timeout. **NEITHER confirmed NOR failed.** The
 *               transaction may still land, so a caller must NOT send a replacement and
 *               must NOT record a failure. Both would be a plausible value on an error
 *               path, and the first would spend money twice.
 *
 * It returns the outcome rather than throwing, because the three are different facts and
 * each caller reacts differently — `exit-exec` turns `unknown` into
 * `ExitUnrecoverableError` to stop its ladder, while `approve-setup` refuses to send its
 * second approval. **A shared helper that threw one error for all three would force every
 * caller to re-derive which case it was from a string.**
 *
 * The timeout's derivation is in `exit-exec`: measured at 60 of 60 receipts served on the
 * FIRST ask with a 36 ms maximum, against an inclusion half that cannot be measured
 * without sending. `receipt_wait_ms` and `receipt_polls` are returned so the first real
 * transactions measure the half that could not be.
 */

export interface ReceiptRpc { call(method: string, params: unknown[]): Promise<unknown> }

export type ReceiptOutcome = 'mined' | 'reverted' | 'unknown';

export interface ReceiptResult {
  outcome: ReceiptOutcome;
  /** Null when the outcome is `unknown`. */
  blockNumber: number | null;
  waitMs: number;
  polls: number;
  /** Polls that failed at the TRANSPORT and were retried. Counted, never swallowed. */
  transportErrors: number;
  lastTransportError: string | null;
}

export interface ReceiptOptions {
  timeoutMs: number;
  pollMs: number;
  /** Injected so a drill drives the poll without real time. */
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
}

export async function awaitReceipt(
  rpc: ReceiptRpc, hash: string, opts: ReceiptOptions,
): Promise<ReceiptResult> {
  const now = opts.now ?? ((): number => Date.now());
  const wait = opts.wait ?? ((ms: number): Promise<void> =>
    new Promise((r) => { setTimeout(r, ms); }));
  const start = now();
  const deadline = start + opts.timeoutMs;
  let polls = 0;
  let transportErrors = 0;
  let lastTransportError: string | null = null;
  for (;;) {
    polls += 1;
    let rec: { status?: string; blockNumber?: string } | null = null;
    try {
      rec = (await rpc.call('eth_getTransactionReceipt', [hash])) as
        { status?: string; blockNumber?: string } | null;
    } catch (err) {
      /*
       * ---------------------------------------------------------------------
       * A FLAKY POLL IS NOT A VERDICT ON THE TRANSACTION
       * ---------------------------------------------------------------------
       *
       * **THIS ENDED THE FIRST 240-MINUTE RUN AFTER NINETY SECONDS.** Trade 706's
       * STEP 2 approval was broadcast, and the very next receipt poll came back
       * `eth_getTransactionReceipt: response carried no result` — the transport
       * answering with neither a receipt nor a `null`. That threw out of this loop, the
       * caller read it as an unresolved position, and the mode halted with a real
       * position open. **The transaction was fine; one poll was not.**
       *
       * `ROBINHOOD.md` section 3 already separates these and this loop was conflating
       * them: a 429, a 5xx, a timeout or a malformed body **says nothing about the
       * data** and is retried, where a wrong ANSWER is raised on at once. A receipt poll
       * has no wrong-answer case — it either carries a status or it does not — so every
       * transport failure here is category one.
       *
       * **THE SAFETY PROPERTY IS UNCHANGED, AND THAT IS THE POINT.** The deadline is
       * still the arbiter: if the timeout expires having never read a status, this
       * returns `unknown` exactly as before and the caller still treats that as
       * unrecoverable. What changes is that ONE flaky poll can no longer decide it,
       * where the 60 s timeout allows roughly sixty attempts.
       *
       * The errors are COUNTED and RETURNED rather than swallowed: a receipt that took
       * forty attempts is a different fact from one served first ask, and a caller that
       * cannot see the difference cannot report it.
       */
      transportErrors += 1;
      lastTransportError = (err as Error).message.slice(0, 160);
      rec = null;
    }
    if (rec !== null && rec !== undefined && rec.status !== undefined) {
      const block = rec.blockNumber === undefined
        ? null : Number(BigInt(rec.blockNumber));
      return {
        outcome: Number(BigInt(rec.status)) === 1 ? 'mined' : 'reverted',
        blockNumber: block, waitMs: now() - start, polls,
        transportErrors, lastTransportError,
      };
    }
    if (now() >= deadline) {
      return { outcome: 'unknown', blockNumber: null, waitMs: now() - start, polls,
        transportErrors, lastTransportError };
    }
    await wait(opts.pollMs);
  }
}

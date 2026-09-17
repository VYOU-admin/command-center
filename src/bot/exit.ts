/**
 * THE ONE IMPLEMENTATION OF THE EXIT, INCLUDING ITS RETRY.
 *
 * An exit that reverts and is then abandoned leaves the bot holding a token it cannot
 * sell. `LAUNCHBOT.md` already records that as the most dangerous state in the system,
 * because a container replacement produces it and no code path currently acts on it.
 * This is the path that must not quietly give up.
 *
 * THREE PROPERTIES, and each exists because its absence is a failure this project has
 * already had:
 *
 * 1. **EVERY ATTEMPT RE-QUOTES.** A retry that resubmits the same calldata against the
 *    same bound will fail the same way, and doing it four times is not four attempts —
 *    it is one attempt logged four times. The caller supplies a fresh quote per attempt
 *    and the bound widens along the measured ladder in `config.EXIT_RETRY`.
 *
 * 2. **EXHAUSTION RAISES.** It does not return a status the caller may ignore. The
 *    position is still open, and a function that reports "could not exit" through a
 *    return value will eventually be called by something that does not check it —
 *    which is exactly how an error path that emits a plausible value gets built.
 *
 * 3. **EVERY ATTEMPT IS RECORDED BEFORE THE NEXT ONE**, so a container replaced
 *    mid-ladder leaves a durable trail of what was already tried rather than nothing.
 */
import { EXIT_RETRY } from './config.js';
import { log } from '../logger.js';

export interface ExitQuote {
  /** Expected output at the CURRENT pool state, re-read for this attempt. */
  expectedOut: bigint;
  /** What will actually be sent, built from the bound this attempt carries. */
  amountOutMinimum: bigint;
}

export interface ExitAttempt {
  attempt: number;
  boundBps: number;
  expectedOut: string;
  amountOutMinimum: string;
  ok: boolean;
  detail: string;
  /**
   * How long the receipt took, and how many polls it needed. **Null on a simulated
   * attempt, which is every attempt recorded so far.**
   *
   * `receipt-timing` measured the RECEIPT AVAILABILITY half of the timeout exactly — 60
   * of 60 served on the first ask, max 36 ms — and cannot measure INCLUSION, because
   * nothing in this repository can send. These fields are how the first real exit
   * measures the half that is currently a margin rather than a figure.
   */
  receiptWaitMs?: number;
  receiptPolls?: number;
}

/**
 * What `send` resolves with. A bare string is the simulated case and stays supported, so
 * the drills and every existing caller are unchanged; the object form carries the receipt
 * timing that only a real broadcast can produce.
 */
export type SendResult = string | {
  detail: string;
  receiptWaitMs?: number;
  receiptPolls?: number;
};

export interface ExitOutcome {
  filled: boolean;
  attempts: ExitAttempt[];
  /** The attempt that succeeded, 1-based. Null when none did. */
  filledOn: number | null;
}

/** The bound for an attempt, from the measured ladder. Never extrapolated past it. */
export function boundForAttempt(attempt: number): number {
  const i = attempt - 1;
  const rung = EXIT_RETRY.BOUND_BPS[i];
  if (rung === undefined) {
    throw new Error(`no measured bound for exit attempt ${attempt}; the ladder has `
      + `${EXIT_RETRY.BOUND_BPS.length} rungs and is not extrapolated past its data`);
  }
  return rung;
}

/** minOut at a given bound. The ONE place a bound becomes a number of tokens. */
export function boundedMinOut(expectedOut: bigint, boundBps: number): bigint {
  if (expectedOut <= 0n) {
    throw new Error(`cannot bound an exit against a non-positive expected output `
      + `(${expectedOut}); an unquotable pool is not a pool to sell into blindly`);
  }
  const out = (expectedOut * BigInt(10000 - boundBps)) / 10000n;
  if (out <= 0n) {
    throw new Error(`bound ${boundBps} bps reduces minOut to ${out}; a non-positive `
      + 'bound is no protection at all and buildSwap refuses it');
  }
  return out;
}

/**
 * A FAILURE THAT MUST STOP THE LADDER RATHER THAN ADVANCE IT.
 *
 * **THIS IS THE MOST DANGEROUS THING IN THE EXIT PATH AND IT ONLY EXISTS ONCE SENDS ARE
 * REAL.** While `send` was an `eth_call`, every failure was safe to retry: nothing had
 * been submitted, so climbing to a wider bound cost nothing. Once `send` BROADCASTS, one
 * failure mode stops being safe — **a transaction that was sent and whose outcome is
 * unknown.** The ladder's ordinary behaviour would widen the bound and send a SECOND sell
 * while the first may still be in flight, and two sells of one position is not a retry,
 * it is a second position we do not have.
 *
 * So `send` may reject in two distinguishable ways:
 *
 *   - an ORDINARY rejection — the simulation refused, or a broadcast was mined and
 *     reverted. Nothing is in flight and the next rung is safe.
 *   - an `ExitUnrecoverableError` — something was sent and its result is not established,
 *     or a precondition makes every rung fail identically. The ladder stops AT ONCE and
 *     rethrows, leaving the chain to adjudicate through boot reconciliation.
 *
 * It rethrows rather than returning a status for the reason property 2 already gives: a
 * caller that ignored a status field would carry on, and this is precisely the case where
 * carrying on spends money twice.
 */
export class ExitUnrecoverableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExitUnrecoverableError';
  }
}

export interface ExitDeps {
  /** Re-quote the pool at the CURRENT state. Must not reuse the entry quote. */
  quote: (attempt: number, boundBps: number) => Promise<ExitQuote>;
  /**
   * Submit or simulate. Resolves on success, REJECTS with the reason on failure.
   *
   * Reject with `ExitUnrecoverableError` when something was SENT and its outcome is not
   * established, or when a precondition makes every rung fail identically. The ladder
   * then stops instead of advancing.
   */
  send: (q: ExitQuote, attempt: number) => Promise<SendResult>;
  /** Persist one attempt before the next begins. */
  record: (a: ExitAttempt) => Promise<void>;
  /** Injected so the drill does not wait 15 real seconds. */
  wait?: (ms: number) => Promise<void>;
}

const defaultWait = (ms: number): Promise<void> =>
  new Promise((r) => { setTimeout(r, ms); });

/**
 * Try to exit, widening along the measured ladder. RAISES if every rung fails.
 */
export async function exitWithRetry(deps: ExitDeps, poolId: string): Promise<ExitOutcome> {
  const attempts: ExitAttempt[] = [];
  const wait = deps.wait ?? defaultWait;

  for (let n = 1; n <= EXIT_RETRY.MAX_ATTEMPTS; n += 1) {
    const boundBps = boundForAttempt(n);
    let rec: ExitAttempt;
    try {
      /* RE-QUOTED PER ATTEMPT. The pool has moved; the previous quote is stale. */
      const q = await deps.quote(n, boundBps);
      const res = await deps.send(q, n);
      const sent = typeof res === 'string' ? { detail: res } : res;
      rec = {
        attempt: n, boundBps, expectedOut: q.expectedOut.toString(),
        amountOutMinimum: q.amountOutMinimum.toString(), ok: true, detail: sent.detail,
        ...(sent.receiptWaitMs === undefined ? {} : { receiptWaitMs: sent.receiptWaitMs }),
        ...(sent.receiptPolls === undefined ? {} : { receiptPolls: sent.receiptPolls }),
      };
      attempts.push(rec);
      await deps.record(rec);
      log.info('EXIT FILLED', {
        pool: poolId, attempt: n, boundBps, detail: sent.detail,
        receipt_wait_ms: sent.receiptWaitMs ?? null,
        receipt_polls: sent.receiptPolls ?? null,
      });
      return { filled: true, attempts, filledOn: n };
    } catch (err) {
      rec = {
        attempt: n, boundBps, expectedOut: '0', amountOutMinimum: '0', ok: false,
        detail: (err as Error).message.slice(0, 200),
      };
      attempts.push(rec);
      /* RECORDED BEFORE THE NEXT ATTEMPT, so a replaced container inherits the trail.
       * Recorded for an unrecoverable failure TOO, and before the rethrow, because that
       * is the case a human will have to reconstruct from the table. */
      await deps.record(rec);

      if (err instanceof ExitUnrecoverableError) {
        /*
         * STOP. Do not widen, do not send again. Something is in flight or every rung
         * would fail the same way, and the next rung would be a second transaction
         * against one position.
         */
        log.error('EXIT STOPPED — UNRECOVERABLE, THE LADDER DID NOT ADVANCE', {
          pool: poolId, attempt: n, boundBps, reason: rec.detail,
          note: 'the position state is NOT established by this outcome; boot '
            + 'reconciliation against the chain is what settles it',
        });
        throw err;
      }

      log.warn('EXIT ATTEMPT FAILED', {
        pool: poolId, attempt: n, boundBps, of: EXIT_RETRY.MAX_ATTEMPTS,
        reason: rec.detail,
      });
      if (n < EXIT_RETRY.MAX_ATTEMPTS) await wait(EXIT_RETRY.INTERVAL_MS);
    }
  }

  /*
   * EXHAUSTED. This RAISES rather than returning `filled: false`, because the position
   * is still open and a caller that ignored a status field would leave it open for
   * good. The ladder's last rung is the measured p75 shortfall; past it the bound
   * costs more than the trade can earn, so there is no rung to add — the correct
   * response is to stop and be loud, not to keep widening.
   */
  throw new Error(`EXIT EXHAUSTED on ${poolId}: ${EXIT_RETRY.MAX_ATTEMPTS} attempts at `
    + `${EXIT_RETRY.BOUND_BPS.join('/')} bps all failed. THE POSITION IS STILL OPEN. `
    + `Last reason: ${attempts[attempts.length - 1]?.detail ?? 'unknown'}`);
}

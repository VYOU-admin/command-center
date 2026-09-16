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
}

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

export interface ExitDeps {
  /** Re-quote the pool at the CURRENT state. Must not reuse the entry quote. */
  quote: (attempt: number, boundBps: number) => Promise<ExitQuote>;
  /** Submit or simulate. Resolves on success, REJECTS with the reason on failure. */
  send: (q: ExitQuote, attempt: number) => Promise<string>;
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
      const detail = await deps.send(q, n);
      rec = {
        attempt: n, boundBps, expectedOut: q.expectedOut.toString(),
        amountOutMinimum: q.amountOutMinimum.toString(), ok: true, detail,
      };
      attempts.push(rec);
      await deps.record(rec);
      log.info('EXIT FILLED', { pool: poolId, attempt: n, boundBps, detail });
      return { filled: true, attempts, filledOn: n };
    } catch (err) {
      rec = {
        attempt: n, boundBps, expectedOut: '0', amountOutMinimum: '0', ok: false,
        detail: (err as Error).message.slice(0, 200),
      };
      attempts.push(rec);
      /* RECORDED BEFORE THE NEXT ATTEMPT, so a replaced container inherits the trail. */
      await deps.record(rec);
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

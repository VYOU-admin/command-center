/**
 * THE ONE PLACE AN APPROVAL IS DECIDED AND GRANTED. docs/LAUNCHBOT.md section 2D.
 *
 * A sell pulls the token through Permit2 and needs TWO grants — `token.approve(PERMIT2, n)`
 * and `Permit2.approve(token, ROUTER, n, expiry)`. Three places need that to happen:
 *
 *   - `launchbot`'s loop, immediately after a live BUY confirms;
 *   - `exit-exec`, immediately before it broadcasts a sell, so a boot sweep can rescue a
 *     position whose inline grant failed;
 *   - `approve-setup`, the operator CLI that signed the first two real transactions.
 *
 * ---------------------------------------------------------------------------
 * IT WAS EXTRACTED, NOT WRITTEN, AND THAT IS THE WHOLE POINT
 * ---------------------------------------------------------------------------
 *
 * Every rule below already existed inside `approve-setup` and was proven by the first real
 * transactions this project ever signed. Copying it into the loop would have been the NINTH
 * recorded instance of the two-implementations trap, in the place `bot/allowance.ts`'s own
 * header names as the worst for it: *the side that grants an allowance and the side that
 * checks it disagreeing about sufficiency is how a bot sells into a revert it had already
 * been told about.* So the CLI now calls this too, and there is one copy of each rule:
 *
 *   - **SKIP what already covers the amount**, and report it as SKIPPED rather than as done.
 *     An allowance already in place is a different fact from one this run granted.
 *   - **AN UNREADABLE ALLOWANCE IS UNKNOWN AND REFUSES.** `0x` is not zero. Sending an
 *     approval against a state that could not be established is the plausible-value-on-an-
 *     error-path failure with a signature attached.
 *   - **HONOUR THE PERMIT2 EXPIRY.** A non-zero amount past its expiration is worthless and
 *     must not read as already granted. `bot/allowance.ts` owns that test.
 *   - **RE-READ BOTH FROM THE CHAIN AFTERWARDS** and raise if they do not cover. A
 *     transaction the node accepted is not an allowance that is set.
 *
 * ---------------------------------------------------------------------------
 * ONE BROADCAST IN FLIGHT AT A TIME. THE RECEIPT IS THE GATE.
 * ---------------------------------------------------------------------------
 *
 * `signer.send` reads the nonce per transaction as `'pending'`, deliberately, so a replaced
 * container cannot reuse one. **On a node that does not track the mempool `'pending'` equals
 * `'latest'`**, so sending step 2 before step 1 is mined gives BOTH THE SAME NONCE and the
 * second replaces the first — step 1 would silently never happen while the run reported two
 * broadcasts. That is not hypothetical; `approve-setup` is written the way it is because of
 * it, and `bot/receipt.ts` exists for it.
 *
 * So: send, await the receipt, and **`mined` is the only outcome that permits the next
 * send.** A revert and an absent receipt are different facts and neither continues — the
 * first because the allowance is not in place, the second because the transaction may still
 * land and a second one now could take its nonce.
 *
 * ---------------------------------------------------------------------------
 * THE CONTRACT, SO A CALLER CANNOT GET IT WRONG
 * ---------------------------------------------------------------------------
 *
 * **WITH A BROADCASTER, RETURNING NORMALLY MEANS READY.** Anything that prevents readiness
 * — an unreadable allowance, a reverted grant, an absent receipt, a re-read that still does
 * not cover — RAISES. There is no status field to leave unchecked, for the same reason
 * `exitWithRetry` raises on exhaustion rather than returning one.
 *
 * **WITHOUT A BROADCASTER NOTHING CAN BE ACHIEVED, SO NOTHING IS PROMISED.** It reads the
 * real allowances, builds the real calldata and returns the plan with `hypothetical: true`.
 * That is what a dry run exercises: the path is reached and constructed, and no key is read
 * because `createBroadcaster` is the only way to obtain one and it refuses outside live mode.
 */
import { buildPermit2Approve, buildTokenApprove } from './calldata.js';
import type { TxRequest } from './calldata.js';
import { checkSellReadiness } from './allowance.js';
import type { AllowanceRpc, SellReadiness } from './allowance.js';
import {
  APPROVAL_TTL_SECONDS, PERMIT2, RECEIPT_POLL_MS, RECEIPT_TIMEOUT_MS, UNIVERSAL_ROUTER,
} from './config.js';
import { awaitReceipt } from './receipt.js';
import type { ReceiptOutcome } from './receipt.js';
import type { Broadcaster } from './signer.js';
import { log } from '../logger.js';

export interface ApprovalRpc extends AllowanceRpc {
  call(method: string, params: unknown[]): Promise<unknown>;
}

/** One of the two grants, with the verdict that was reached BEFORE anything was sent. */
export interface ApprovalStep {
  label: 'STEP 1 token -> Permit2' | 'STEP 2 Permit2 -> router';
  /** SEND, or SKIP because what is already granted covers the amount. */
  verdict: 'SEND' | 'SKIP';
  /** The allowance as the chain reported it, or why it could not be read. */
  current: string;
  tx: TxRequest;
}

export interface SentApproval {
  label: string;
  hash: string;
  outcome: ReceiptOutcome;
  blockNumber: number | null;
  waitMs: number;
  polls: number;
}

export interface ApprovalPlan {
  /** True only when the allowances cover `amount` NOW — after any grants this made. */
  ready: boolean;
  /** True when there was no broadcaster: the plan was built and NOTHING was sent. */
  hypothetical: boolean;
  amount: bigint;
  token: string;
  owner: string;
  steps: ApprovalStep[];
  sent: SentApproval[];
  /** The allowances before anything was granted. */
  before: SellReadiness;
  /** Re-read from the chain after granting. Null when nothing was sent. */
  after: SellReadiness | null;
}

export interface ApprovalContext {
  rpc: ApprovalRpc;
  /**
   * PRESENT ONLY IN LIVE MODE. `createBroadcaster` is the sole way to obtain one and it
   * refuses outside live mode and without a key, so `null` here is the mode's decision
   * arriving rather than a choice this module makes.
   */
  broadcaster?: Broadcaster | null;
  /** Injected so a drill can drive the receipt poll without real time. */
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  receiptTimeoutMs?: number;
}

/**
 * MAKE `owner` ABLE TO SELL `amount` OF `token` THROUGH THE UNIVERSAL ROUTER.
 *
 * `amount` is the CALLER'S, and its provenance is the caller's to state. The live loop
 * passes the balance read from the chain after the buy confirmed, because an allowance
 * below the balance leaves part of the position unsellable and a quote is not a balance.
 * A dry run passes the quoted output and labels the result hypothetical, because there is
 * no balance to read — nothing was bought.
 */
export async function ensureSellReadiness(
  ctx: ApprovalContext,
  args: { token: string; owner: string; amount: bigint },
): Promise<ApprovalPlan> {
  const { token, owner, amount } = args;
  const bcast = ctx.broadcaster ?? null;
  const nowMs = ctx.now ?? ((): number => Date.now());
  const nowSec = Math.floor(nowMs() / 1000);

  if (amount <= 0n) {
    /*
     * REFUSED, NOT DEFAULTED. An approval for zero grants nothing while reporting success,
     * and sizing one against a zero balance is approving a number rather than a position.
     * On the live path a zero here means the buy mined and the wallet holds none of the
     * token — a contradiction the chain is asserting, which must surface rather than
     * becoming a pointless transaction.
     */
    throw new Error(`refusing to approve ${amount} of ${token}: an approval for zero or `
      + 'less grants nothing while reporting success. If this came from a balance read '
      + 'after a mined buy, the chain is saying the position does not exist.');
  }

  /* ---- 1. WHAT IS ALREADY GRANTED -------------------------------------- */
  /*
   * ONE READ, SHARED WITH THE SELLING SIDE. `checkSellReadiness` is what `exit-exec`
   * refuses on, so the granting side and the checking side cannot disagree about whether
   * an allowance is sufficient — which is the entire reason `bot/allowance.ts` exists.
   */
  const before = await checkSellReadiness(
    ctx.rpc, token, owner, UNIVERSAL_ROUTER, amount, nowSec);

  const expiry = nowSec + APPROVAL_TTL_SECONDS;
  const e = before.erc20;
  const p = before.permit2;
  /* A Permit2 grant is live only if it is both large enough AND unexpired. */
  const p2Covers = p.amount !== null && p.amount >= amount && p.expiration > nowSec;

  const steps: ApprovalStep[] = [
    {
      label: 'STEP 1 token -> Permit2',
      verdict: e.amount !== null && e.amount >= amount ? 'SKIP' : 'SEND',
      current: e.amount === null ? e.note : e.amount.toString(),
      tx: buildTokenApprove(token, amount),
    },
    {
      label: 'STEP 2 Permit2 -> router',
      verdict: p2Covers ? 'SKIP' : 'SEND',
      current: p.amount === null ? p.note
        : `${p.amount} expiring ${p.expiration}${p.expiration <= nowSec ? ' (EXPIRED)' : ''}`,
      tx: buildPermit2Approve(token, amount, expiry),
    },
  ];

  const unreadable = e.amount === null || p.amount === null;

  /*
   * REPORTED BEFORE ANYTHING IS SENT, IN EVERY CALLER.
   *
   * It lives here rather than in `approve-setup` because the loop and the exit path grant
   * unattended — there is no operator watching a CLI's output — and the line that says
   * what was about to be approved, to whom, for how much, and what was already in place is
   * the one a human reconstructs the trade from afterwards. Logging it after the sends
   * would lose it exactly when a send failed.
   */
  log.info('APPROVALS — WHAT WILL BE GRANTED, TO WHOM, AND FOR HOW MUCH', {
    token, owner, amount_raw: amount.toString(),
    spender_step_1: PERMIT2, spender_step_2: UNIVERSAL_ROUTER,
    policy: 'EXACT AMOUNT, never unlimited: every token here is a launch minutes old from '
      + 'a contract nobody has read, so the cost of being wrong is bounded by the allowance',
    expiry_unix: expiry, expiry_ttl_seconds: APPROVAL_TTL_SECONDS,
    steps: steps.map((st) => ({ step: st.label, verdict: st.verdict, current: st.current })),
    already_ready: before.ready,
    will_send: bcast !== null,
    note: bcast === null
      ? 'NO BROADCASTER — the allowances were READ and the calldata BUILT; nothing can be '
        + 'sent and no key is read'
      : 'each grant is confirmed by its receipt before the next is sent; MINED is the only '
        + 'outcome that continues',
  });

  /* ---- 2. NO BROADCASTER: THE PLAN, AND NOTHING IS PROMISED ------------- */
  if (bcast === null) {
    return {
      ready: before.ready, hypothetical: true, amount, token, owner,
      steps, sent: [], before, after: null,
    };
  }

  /* ---- 3. LIVE: REFUSE BEFORE SENDING AGAINST AN UNKNOWN STATE ---------- */
  if (unreadable) {
    throw new Error('an allowance could not be read, so the current state is UNKNOWN and '
      + `UNKNOWN is not zero: erc20=${e.note} permit2=${p.note}. Refusing to send an `
      + 'approval against a state that could not be established.');
  }
  if (before.ready) {
    /* Reported as SKIPPED rather than as done, and never as a grant this run made. */
    log.info('APPROVALS ALREADY COVER THIS POSITION — NOTHING SENT', {
      token, owner, amount_raw: amount.toString(),
      erc20: e.amount?.toString(), permit2: p.amount?.toString(),
      permit2_expiration: p.expiration,
    });
    return { ready: true, hypothetical: false, amount, token, owner,
      steps, sent: [], before, after: before };
  }

  /* ---- 4. GRANT, ONE AT A TIME, EACH CONFIRMED BEFORE THE NEXT ---------- */
  const sent: SentApproval[] = [];
  for (const step of steps) {
    if (step.verdict === 'SKIP') continue;
    let hash: string;
    try {
      hash = await bcast.send(step.tx);
    } catch (err) {
      /*
       * A THROWN SEND IS NOT PROOF NOTHING WAS SENT. A transport error can arrive after
       * the node accepted the transaction — `signer.send` says exactly this — so nothing
       * further goes out and the caller must reconcile against the chain.
       */
      throw new Error(`${step.label} BROADCAST FAILED AND THE OUTCOME IS NOT ESTABLISHED: `
        + `${(err as Error).message.slice(0, 160)}. A transaction may or may not be in `
        + 'flight; NOTHING FURTHER WAS SENT. Read the allowances from the chain before '
        + 'retrying, because a second send now could take its nonce.');
    }
    log.warn(`${step.label} BROADCAST`, { hash, what: step.tx.description, token });

    const rec = await awaitReceipt(ctx.rpc, hash, {
      timeoutMs: ctx.receiptTimeoutMs ?? RECEIPT_TIMEOUT_MS,
      pollMs: RECEIPT_POLL_MS,
      ...(ctx.wait ? { wait: ctx.wait } : {}),
      ...(ctx.now ? { now: ctx.now } : {}),
    });
    sent.push({ label: step.label, hash, outcome: rec.outcome,
      blockNumber: rec.blockNumber, waitMs: rec.waitMs, polls: rec.polls });
    log.info(`${step.label} RECEIPT`, {
      hash, outcome: rec.outcome, block: rec.blockNumber,
      receipt_wait_ms: rec.waitMs, receipt_polls: rec.polls,
    });

    if (rec.outcome === 'reverted') {
      throw new Error(`${step.label} was MINED AND REVERTED (${hash}). The allowance is `
        + 'NOT in place and nothing further was sent: a second transaction would be built '
        + 'against a state that does not exist. On a launch-minute token this is usually '
        + 'the token itself — a blacklist, a transfer hook or a non-standard approve.');
    }
    if (rec.outcome === 'unknown') {
      throw new Error(`${step.label} produced NO RECEIPT in ${rec.waitMs} ms after `
        + `${rec.polls} polls (${hash}). It may still land, so NOTHING FURTHER WAS SENT — `
        + 'a second transaction now could reuse its nonce and replace it. The allowance '
        + 'state is UNKNOWN: read it from the chain before selling or retrying.');
    }
  }

  /* ---- 5. VERIFY BY RE-READING THE CHAIN -------------------------------- */
  /*
   * A transaction the node accepted is not an allowance that is set. This is the
   * fresh-connection rule in its on-chain form, and it is the check that would catch a
   * token whose `approve` returns success and stores nothing.
   */
  const after = await checkSellReadiness(
    ctx.rpc, token, owner, UNIVERSAL_ROUTER, amount, Math.floor(nowMs() / 1000));
  if (!after.ready) {
    throw new Error('THE ALLOWANCES DO NOT COVER THE POSITION AFTER GRANTING THEM: '
      + `${after.reason} ${sent.length} transaction(s) were mined. Do not sell against `
      + 'this state.');
  }
  log.info('APPROVALS VERIFIED BY RE-READING THE CHAIN', {
    token, owner, amount_raw: amount.toString(),
    sent: sent.map((s) => `${s.label} ${s.hash} ${s.outcome} block ${s.blockNumber ?? '?'} `
      + `${s.waitMs}ms/${s.polls} polls`),
    erc20_now: after.erc20.amount?.toString(),
    permit2_now: after.permit2.amount?.toString(),
    permit2_expiration_now: after.permit2.expiration,
  });

  return { ready: true, hypothetical: false, amount, token, owner, steps, sent, before, after };
}

/** What a plan would send, for a log line. Empty when both steps are already covered. */
export function plannedSends(plan: ApprovalPlan): string[] {
  return plan.steps.filter((s) => s.verdict === 'SEND').map((s) => s.tx.description);
}

export { PERMIT2, UNIVERSAL_ROUTER };

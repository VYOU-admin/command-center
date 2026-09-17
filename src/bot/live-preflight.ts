/**
 * THE LIVE PREFLIGHT: WHAT MUST BE TRUE BEFORE THE BOT MAY ARM WITH REAL MONEY.
 *
 * docs/LAUNCHBOT.md section 2A and section 8.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS RATHER THAN A HALF-WIRED LIVE PATH
 * ---------------------------------------------------------------------------
 *
 * Live mode is built in this pass and the key arrives in a later one. The requirement was
 * that there be **nothing for it to do wrong when it arrives** — and the dangerous shape
 * is not a missing feature, it is a PARTIAL one. A live loop whose BUY broadcasts and
 * whose SELL does not would open real positions it cannot close, which is the single worst
 * outcome available to this bot and the thing `needs_exit`, the retry ladder and the boot
 * sweep all exist to prevent.
 *
 * So the unwired steps are named here, and live mode REFUSES TO ARM while any of them is
 * outstanding. **The refusal is data, not a comment**: it is a list the operator can read,
 * each item disappears when its work lands, and the bot arms when the list is empty. A
 * `TODO` in a source file does not stop a process; this does.
 *
 * **THIS IS NOT A SUBSTITUTE FOR THE OPERATOR'S JUDGEMENT** and it is not a claim that an
 * empty list means the bot is safe. It means the things known to be missing are no longer
 * missing. Section 7's categories B and C are the ones that stay open regardless.
 */
import type { BotMode } from './mode.js';

export interface Prerequisite {
  /** Short key, stable, so an operator can refer to one. */
  readonly id: string;
  /** What is missing, in one line. */
  readonly what: string;
  /** Why arming without it is unsafe rather than merely incomplete. */
  readonly why: string;
  /** What closes it. */
  readonly closedBy: string;
}

/**
 * THE OUTSTANDING LIST, AS OF 2026-09-16.
 *
 * Every entry is a thing that would cost money on the first live trade, not a nicety.
 * Removing one is a deliberate edit with evidence, exactly like closing a section 7
 * category A item.
 */
export const LIVE_PREREQUISITES: readonly Prerequisite[] = [
  /*
   * `sell-not-broadcast` WAS HERE AND IS CLOSED — 2026-09-16.
   *
   * The broadcaster is threaded through `exit-exec.ts` and forwarded by BOTH callers, so
   * the ladder sends. It is removed rather than struck through because this list is read
   * by code and a commented-out entry would either still refuse or quietly stop
   * refusing; LAUNCHBOT.md section 6 carries what it was and what closed it.
   */
  /*
   * `approvals-not-executed` WAS HERE AND ITS LITERAL CONDITION IS MET — both setup
   * transactions were executed on 2026-09-16 (`0x999fdb79…` and `0x178977d3…`, both
   * status 1). **It is NOT simply closed, because closing it there would have marked the
   * risk resolved while the thing that actually prevents it stayed unbuilt.**
   */
  /*
   * `approvals-not-inline` WAS HERE AND IS CLOSED — 2026-09-16. LAUNCHBOT.md section 2D.
   *
   * The loop grants both approvals as part of the trade: BUY -> receipt -> the exact
   * balance read from the chain -> APPROVE -> receipt -> PERMIT2 APPROVE -> receipt, and
   * the SELL at +90 s. `bot/approvals.ts` is the one implementation and `approve-setup`
   * was rewritten to call it rather than being copied from.
   *
   * **CLOSING IT REQUIRED FIXING SOMETHING UPSTREAM THAT WAS NOT ON THIS LIST: the loop
   * never broadcast the BUY either.** The broadcaster reached only the exit paths, so a
   * live run would have opened rows for positions it had not bought. Wiring approvals to a
   * buy that does not happen would have met this entry's words and left the risk exactly
   * where it was — which is why `approvals-not-executed` was replaced by it one pass
   * earlier rather than being ticked off.
   *
   * Removed rather than struck through, because this list is read by code.
   */
  /*
   * `fill-not-modelled` WAS HERE AND WAS **ACCEPTED** — 2026-09-16, by the operator.
   * LAUNCHBOT.md section 6.
   *
   * It is the only entry ever removed by acceptance rather than by work, and its own
   * `closedBy` named that as one of its two conditions: *"accepted as a known unknown by
   * the operator, or measured from the first live fills"*. **The second is unreachable
   * from here** — the quantity is what our own fills cost, a transaction in a block
   * carries no record of when it was offered, and the mempool is in none of the available
   * methods. `receipt-timing` hit the same wall on the inclusion half of the receipt
   * timeout and it only moved once we had sent something ourselves.
   *
   * So the choice was never "measure it or accept it". It was **accept it and measure it,
   * or neither** — a prerequisite whose only evidence lies past itself never closes, and
   * keeping it would have been a permanent refusal dressed as diligence.
   *
   * WHAT WAS ACCEPTED, so nobody has to reconstruct it: winning the fill against competing
   * buyers in the same block, and our own marginal impact at the moment of it. Note that
   * the published medians ALREADY score a measured 16.75%-24.21% no-fill rate as ZERO, so
   * the population carries a fifth at zero for this reason; what is unknown is whether OUR
   * rate is that one. `bot_trades.executed_out`, `realised_slippage_entry` and the loop's
   * `fill_vs_quote` are the columns that answer it and every one is NULL today.
   *
   * Removed rather than struck through, because this list is read by code.
   */
  /*
   * `dry-run-boot-halts-the-chain` WAS HERE AND IS CLOSED — 2026-09-16, by operator
   * decision: AUTOMATIC halts are now scoped to the mode that raised them and MANUAL
   * halts stay chain-wide. A dry run that ends with an open position still halts ITS OWN
   * mode at the next boot — which is correct, it has an unresolved position — and no
   * longer touches live.
   *
   * Removed rather than struck through, because this list is read by code.
   */
];

/**
 * Raise unless the bot may arm in this mode.
 *
 * A NO-OP OUTSIDE LIVE MODE, deliberately: a dry run holds nothing and broadcasts
 * nothing, so none of these can cost anything there, and blocking dry runs on them would
 * stop the measurement that closes them.
 *
 * ---------------------------------------------------------------------------
 * THE LIST IS EMPTY AS OF 2026-09-16, SO THIS NOW PASSES
 * ---------------------------------------------------------------------------
 *
 * **`launchbot --live` no longer refuses here.** Four entries were closed with evidence —
 * `sell-not-broadcast`, `approvals-not-executed`/`approvals-not-inline`,
 * `stuck-rows-can-halt`/`dry-run-boot-halts-the-chain` — and the fifth was accepted.
 *
 * **IT IS STILL CALLED FIRST IN THE BOOT SEQUENCE AND THAT STILL MATTERS.** A live run
 * that is going to be refused must be refused before it reads a balance, reconciles a row
 * or spends a compute unit; an empty list makes that free rather than pointless, and any
 * entry added later refuses at the cheapest possible moment without anything being
 * rewired.
 *
 * **WHAT AN EMPTY LIST DOES NOT MEAN**, restated here because this is the function that
 * stops refusing: it is not a claim that the bot is safe, and it is not the thing that
 * bounds a mistake. **The SIX RAILS in `bot/config.ts` are** — $10 a position, 5
 * concurrent, $100 deployed, 40 trades a day, $15 of realised loss, 3 consecutive reverts
 * — plus a kill switch re-read on a fresh connection every tick. A stray `--live` is
 * bounded at $15 of realised loss before the mode halts itself. The preflight was never
 * what limited the damage; it was what stopped a HALF-BUILT path from running at all.
 */
export function assertLiveReady(mode: BotMode): void {
  if (!mode.live) return;
  if (LIVE_PREREQUISITES.length === 0) return;
  const lines = LIVE_PREREQUISITES
    .map((p, i) => `  ${i + 1}. [${p.id}] ${p.what}\n       WHY: ${p.why}\n`
      + `       CLOSED BY: ${p.closedBy}`)
    .join('\n');
  throw new Error(`REFUSING TO ARM IN LIVE MODE: ${LIVE_PREREQUISITES.length} `
    + `prerequisite(s) outstanding.\n${lines}\n`
    + 'These are listed in bot/live-preflight.ts and in LAUNCHBOT.md section 8. A live '
    + 'loop whose buy broadcasts and whose sell does not would open positions it cannot '
    + 'close, so this refuses rather than trading partially.');
}

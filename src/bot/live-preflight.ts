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
  {
    id: 'approvals-not-executed',
    what: 'neither setup transaction has ever been executed — token -> Permit2 and '
      + 'Permit2 -> router',
    why: 'the sell pulls the token through Permit2, so without both allowances every '
      + 'exit reverts for a reason that has nothing to do with the pool. Section 6 '
      + 'measured 9 of 14 dry-run exit reverts as exactly this, on a borrowed holder.',
    closedBy: '`npm run approve-setup -- --live --commit` once a key exists; it is '
      + 'deliberately a separate CLI so the first transaction this project signs is a '
      + 'bounded approval and not a trade',
  },
  {
    id: 'fill-not-modelled',
    what: '`fill_status` is the literal `dry-run` on every row and nothing models '
      + 'winning the fill against competing buyers in the same block',
    why: 'every return figure in this document is mark-to-market against a later trade '
      + 'in the pool. A live fill competes for the same block, and the measured edge has '
      + 'never been tested against that.',
    closedBy: 'accepted as a known unknown by the operator, or measured from the first '
      + 'live fills',
  },
  {
    id: 'dry-run-boot-halts-the-chain',
    what: 'ANY dry run that ends with an open position leaves a row that halts the '
      + 'CHAIN-WIDE kill switch at the next boot of its mode',
    why: 'this replaced "7 needs_exit rows in dry-run-r5", which was RESOLVED on '
      + '2026-09-16 — and resolving it demonstrated the hazard is not those seven rows '
      + 'but the dry-run lifecycle. reconcileOnBoot reads the BORROWED holder\'s balance '
      + '(deliberately, so hypothetical positions are not all reported closed), that '
      + 'holder usually still holds, so the row becomes needs_exit; the sweep then tries '
      + 'to sell a dead launch pool as somebody else, exhausts, and halts. It recurred '
      + 'within minutes of the first cleanup, on rows a verification run had left.',
    closedBy: 'an operator decision on section 4\'s open item — automatic halts scoped '
      + 'to the mode that raised them, with manual halts staying chain-wide. Until then '
      + 'every dry run must be left with no open position, and `resolve-unsellable` is '
      + 'the way out when one is stuck',
  },
];

/**
 * Raise unless the bot may arm in this mode.
 *
 * A NO-OP OUTSIDE LIVE MODE, deliberately: a dry run holds nothing and broadcasts
 * nothing, so none of these can cost anything there, and blocking dry runs on them would
 * stop the measurement that closes them.
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

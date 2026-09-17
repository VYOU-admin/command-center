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
  {
    id: 'sell-not-broadcast',
    what: 'the SELL leg is simulated, never broadcast: `exit-exec` calls `eth_call` and '
      + 'no broadcaster is threaded through it',
    why: 'a live BUY with a simulated SELL opens real positions the bot cannot close. '
      + 'That is worse than not trading: an unsellable position is not a loss of some '
      + 'size, it is an unbounded one.',
    closedBy: 'threading the broadcaster through `exit-exec.ts` and `exit.ts` so the '
      + 'ladder sends rather than simulates, with the SAME executor the boot sweep uses',
  },
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
    id: 'stuck-rows-can-halt',
    what: '7 `needs_exit` rows in mode `dry-run-r5` can halt the chain-wide kill switch',
    why: 'the kill switch is keyed on CHAIN, so a dry-run boot that cannot clear a '
      + 'stuck position halts LIVE trading too. Section 4 decides this stays chain-wide.',
    closedBy: 'resolving those 7 rows before the first live run — see section 8',
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

/**
 * Group 1 balance changes between two consecutive scans.
 *
 * A DELTA NEEDS TWO GOOD READINGS. Only a pair where BOTH sides are status 'ok'
 * produces one. A missing, failed or no_account prior is not a balance of zero,
 * and subtracting from it would manufacture a change the size of the whole
 * holding out of an absence of data -- on the exact table built to keep those
 * apart. Those wallets are excluded and counted as noPrior.
 *
 * ALL THREE FIGURES SHARE ONE BASELINE. The line reads `had <prev> · now <cur> ·
 * <delta>`, and delta is exactly cur - prev, so every line reconciles by
 * inspection.
 *
 * IT USED TO PRINT `bought` INSTEAD OF `prev`, taken from wallet_pnl.tokens_bought
 * -- a cumulative lifetime figure frozen at backfill time, on no snapshot basis
 * at all. Sitting next to a live balance it read as the prior holding, so a
 * wallet that had acquired MOS outside the tracked venue appeared to lose more
 * than it held: 5dn4…pRyK showed "bought 1,059,364 · now 0 · -1,626,660" when its
 * actual prior balance was 1,626,660. Only 79 of 267 group-1 wallets were ever in
 * the state where prev happened to equal bought, so roughly two thirds of lines
 * carried figures that could not add up. There is no labelling that makes a
 * frozen lifetime total read correctly beside a live balance, so it is gone.
 *
 * AN ACCOUNT THAT CLOSED IS NOT A SALE. A wallet going from a real balance to
 * no_account means its token account no longer exists. The tokens may have been
 * sold, transferred, or the account emptied and closed in one instruction -- and
 * nothing in a balance reading distinguishes those. Reporting it as
 * "-full balance" would assert a movement that has not been observed, so it is
 * counted separately as accountClosed and left OUT of the alert. Confirming it
 * needs the transfer history, which this scanner does not read.
 */
export interface Reading { wallet: string; balanceRaw: string | null; status: string }

export interface Change {
  wallet: string; prev: number; now: number; delta: number;
}
export interface Comparison {
  changes: Change[];
  group1: number; compared: number; changed: number; unchanged: number;
  noPrior: number; accountClosed: number;
}

export function compare(
  group1: string[], current: Map<string, Reading>, previous: Map<string, Reading>,
  scale: number,
): Comparison {
  const changes: Change[] = [];
  let compared = 0, unchanged = 0, noPrior = 0, accountClosed = 0;
  for (const w of group1) {
    const cur = current.get(w), prv = previous.get(w);
    // A wallet with no current reading was never attempted this pass; it has no
    // comparison either way and counts as noPrior rather than silently vanishing.
    if (!cur || !prv || prv.status !== 'ok' || prv.balanceRaw === null) { noPrior++; continue; }
    if (cur.status === 'no_account') { accountClosed++; continue; }
    if (cur.status !== 'ok' || cur.balanceRaw === null) { noPrior++; continue; }
    compared++;
    const a = Number(prv.balanceRaw) / scale, b = Number(cur.balanceRaw) / scale;
    if (a === b) { unchanged++; continue; }
    changes.push({ wallet: w, prev: a, now: b, delta: b - a });
  }
  // Largest absolute move first: the point of the alert is what moved most.
  changes.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
  return { changes, group1: group1.length, compared, changed: changes.length,
    unchanged, noPrior, accountClosed };
}

const SOLSCAN = 'https://solscan.io/account/';
const short = (a: string): string => `${a.slice(0, 4)}…${a.slice(-4)}`;
const n0 = (v: number): string => Math.round(v).toLocaleString('en-US');
const signed = (v: number): string => `${v > 0 ? '+' : '-'}${n0(Math.abs(v))}`;

/** Discord caps an embed description; a long list splits rather than truncating. */
export const PART_BUDGET = 1900;

export function renderChangeAlert(c: Comparison): string[] {
  if (!c.changes.length) return [];          // nothing changed sends nothing at all
  // The header must not be mistakable for the group1 or group2 new-token alerts,
  // which share this channel. Those announce BUYS of newly launched tokens; this
  // announces BALANCE MOVES of a known cohort, so it names both.
  const header = `**MOS · GROUP 1 BALANCE CHANGES · ${c.changed} wallet${c.changed === 1 ? '' : 's'}**`;
  const lines = c.changes.map((x) =>
    `[${short(x.wallet)}](${SOLSCAN}${x.wallet}) · had ${n0(x.prev)} · now ${n0(x.now)} · ${signed(x.delta)}`);
  const parts: string[] = [];
  let cur = header;
  for (const line of lines) {
    if (cur.length + 1 + line.length > PART_BUDGET && cur.length) { parts.push(cur); cur = ''; }
    cur = cur ? `${cur}\n${line}` : line;
  }
  if (cur) parts.push(cur);
  return parts;
}

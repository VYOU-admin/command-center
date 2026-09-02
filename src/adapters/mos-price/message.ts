/**
 * The two price messages.
 *
 * BOTH HEADERS NAME THE TOKEN AND THE QUESTION. Four alert kinds share the
 * newtoken channel: group1 and group2 announce BUYS of newly launched tokens,
 * the balance alert announces MOVES of a known cohort, and these two announce
 * PRICE. A reader must be able to tell which at a glance, so each header is a
 * distinct noun phrase rather than a shared prefix with a suffix.
 */
export interface Reading { priceUsd: number; marketCap: number | null; readAt: Date }

const usd = (v: number): string =>
  v >= 1 ? `$${v.toLocaleString('en-US', { maximumFractionDigits: 4 })}`
         : `$${v.toPrecision(4)}`;
const cap = (v: number | null): string =>
  v == null ? '—' : `$${Math.round(v).toLocaleString('en-US')}`;
const stamp = (d: Date): string => d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

/** Signed percentage against the previous reading; null when there is no prior. */
function change(now: number, prev: number | null): string {
  if (prev === null || prev === 0) return 'no prior reading';
  const pct = ((now - prev) / prev) * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}% since last reading`;
}

export function heartbeat(
  cur: Reading, prev: number | null, stale: boolean,
): string {
  const lines = [
    '**MOS · PRICE · HOURLY**',
    `${usd(cur.priceUsd)} · mcap ${cap(cur.marketCap)} · ${change(cur.priceUsd, prev)}`,
  ];
  // A HEARTBEAT AFTER A FAILED CYCLE STILL FIRES. It reports the last good
  // reading and says when it was taken, rather than skipping the hour in
  // silence, which would be indistinguishable from the monitor being dead.
  if (stale) lines.push(`_last good reading ${stamp(cur.readAt)} — the most recent read failed_`);
  return lines.join('\n');
}

export function ath(
  cur: Reading, prev: number | null, prevHigh: number, prevHighAt: Date,
): string {
  return [
    '**MOS · NEW ALL-TIME HIGH**',
    `${usd(cur.priceUsd)} · mcap ${cap(cur.marketCap)} · ${change(cur.priceUsd, prev)}`,
    `previous high ${usd(prevHigh)}, set ${stamp(prevHighAt)}`,
  ].join('\n');
}

/**
 * The hourly Discord message.
 *
 * READABILITY IS THE CONSTRAINT. A cycle produces ~53 tokens and ~217 wallets;
 * listing them is unreadable and exceeds Discord's 2,000-character limit. So the
 * message leads with the two graded sections and reduces the rest to counts.
 *
 * Ordering is by signal strength, which is why the grading fields are carried on
 * each hit row rather than joined at send time:
 *   1. cross-token wallets  — in 2+ cohorts, the strongest signal
 *   2. clustered wallets    — linked to others by a shared signer
 *   3. everything else      — one line, counts only, no per-token list
 *
 * Truncation is explicit: sections cut to a budget and say "+N more" rather
 * than failing, splitting into several messages, or silently dropping rows.
 */
export const DISCORD_LIMIT = 2000;

export interface HitRow {
  token: string;
  wallet: string;
  cohorts: number;
  totalRealizedUsd: number;
  crossToken: boolean;
  poolAgeMinutes: number;
  clusterId?: string | null;
  symbol?: string | null;
}

const shortAddr = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;
const tokenLabel = (h: HitRow): string =>
  h.symbol ? `${h.symbol} ${shortAddr(h.token)}` : shortAddr(h.token);
const age = (m: number): string => (m < 60 ? `${Math.round(m)}m` : `${(m / 60).toFixed(1)}h`);
const usd = (n: number): string =>
  `${n < 0 ? '-' : ''}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`;

export function renderMessage(
  hits: HitRow[], hourLabel: string, opts: { maxLead?: number } = {},
): string | null {
  // No hits means no message at all, not an empty one.
  if (hits.length === 0) return null;
  const maxLead = opts.maxLead ?? 12;
  const tokens = new Set(hits.map((h) => h.token)).size;
  const wallets = new Set(hits.map((h) => h.wallet)).size;

  const cross = hits.filter((h) => h.crossToken)
    .sort((a, b) => b.totalRealizedUsd - a.totalRealizedUsd);
  const clustered = hits.filter((h) => !h.crossToken && h.clusterId)
    .sort((a, b) => b.totalRealizedUsd - a.totalRealizedUsd);
  const restRows = hits.filter((h) => !h.crossToken && !h.clusterId);

  const out: string[] = [];
  out.push(`**New-token buys · ${hourLabel}**`);
  out.push(`${tokens} tokens · ${wallets} watchlist wallets · pool age under 2h`);

  if (cross.length) {
    out.push('');
    out.push(`__Cross-token wallets — 2+ cohorts (${cross.length})__`);
    for (const h of cross.slice(0, maxLead)) {
      out.push(`\`${shortAddr(h.wallet)}\` ${h.cohorts} cohorts, ${usd(h.totalRealizedUsd)}`
        + ` → ${tokenLabel(h)} · pool ${age(h.poolAgeMinutes)}`);
    }
    if (cross.length > maxLead) out.push(`… +${cross.length - maxLead} more`);
  }

  if (clustered.length) {
    out.push('');
    out.push(`__Clustered wallets (${clustered.length})__`);
    for (const h of clustered.slice(0, maxLead)) {
      out.push(`\`${shortAddr(h.wallet)}\` ${h.clusterId}`
        + ` → ${tokenLabel(h)} · pool ${age(h.poolAgeMinutes)}`);
    }
    if (clustered.length > maxLead) out.push(`… +${clustered.length - maxLead} more`);
  }

  if (restRows.length) {
    const t = new Set(restRows.map((h) => h.token)).size;
    const w = new Set(restRows.map((h) => h.wallet)).size;
    out.push('');
    out.push(`Other watchlist buyers: ${w} wallets across ${t} tokens.`);
  }

  // Hard budget. Trim from the end of the lead sections, never mid-line.
  let msg = out.join('\n');
  let trimmed = 0;
  while (msg.length > DISCORD_LIMIT && out.length > 3) {
    const i = out.findLastIndex((l) => l.startsWith('`'));
    if (i < 0) break;
    out.splice(i, 1); trimmed++;
    msg = out.join('\n') + (trimmed ? `\n… +${trimmed} more trimmed for length` : '');
  }
  return msg;
}

/**
 * The alert body. Dashboard link, then one line per token, and nothing else.
 *
 * No header, no summary, no per-wallet lines, no cohort counts, no PnL -- the
 * old monitor's lead block carried all of those and is deliberately not reused.
 *
 * tokenLink is imported from the old monitor rather than copied: it already
 * builds exactly the markdown link this needs, falling back to a short address
 * when a token has no symbol. Its sibling tokenLines is NOT reused, because its
 * line format is `link · N` with no unit and no growth suffix.
 *
 * SPLITS RATHER THAN TRUNCATES. Discord caps an embed description; a cycle with
 * many tokens becomes several messages, and the dashboard link leads only the
 * first -- repeating it on every part would be the header this spec excludes.
 */
import { tokenLink, PART_BUDGET } from '../new-token-watch/message.js';

export interface AlertLine {
  token: string;
  symbol: string | null;
  poolId: string;
  wallets: number;
  /** Increase over the highest count previously alerted; null on a first alert. */
  growth: number | null;
}

export function renderLine(l: AlertLine, suffix = ''): string {
  // suffix disambiguates colliding symbols and is DISPLAY ONLY -- it is never
  // stored, and nothing keyed on the token ever sees it.
  const label = l.symbol === null ? null : l.symbol + suffix;
  const base = `${tokenLink({ token: l.token, symbol: label, poolId: l.poolId })}`
    + ` · ${l.wallets} ${l.wallets === 1 ? 'wallet' : 'wallets'}`;
  return l.growth === null ? base : `${base} · +${l.growth}`;
}

export interface RenderedAlert {
  parts: string[];
  /** Lines that had to be marked because their symbol was already used. */
  duplicateSymbols: number;
}

/**
 * Sorted by wallet count descending, as specified.
 *
 * DISAMBIGUATION FOLLOWS THAT SORT, not insertion order, so which of two
 * same-symbol tokens keeps the bare name is deterministic: the one with more
 * buyers. Two distinct tokens really do share a symbol -- one dry run produced
 * BUBBLE twice from different pools -- and without this the message gives the
 * reader no way to tell them apart.
 */
export function renderAlert(dashboardUrl: string, lines: AlertLine[]): RenderedAlert {
  if (!lines.length) return { parts: [], duplicateSymbols: 0 };
  const sorted = [...lines].sort((a, b) => b.wallets - a.wallets || a.token.localeCompare(b.token));

  const seen = new Map<string, number>();
  let duplicateSymbols = 0;
  const rendered = sorted.map((l) => {
    if (l.symbol === null) return renderLine(l);   // falls back to a unique short address
    const n = seen.get(l.symbol) ?? 0;
    seen.set(l.symbol, n + 1);
    if (n > 0) duplicateSymbols++;
    return renderLine(l, '*'.repeat(n));
  });

  const parts: string[] = [];
  let cur = dashboardUrl;
  for (const line of rendered) {
    if (cur.length + 1 + line.length > PART_BUDGET && cur.length) { parts.push(cur); cur = ''; }
    cur = cur ? `${cur}\n${line}` : line;
  }
  if (cur) parts.push(cur);
  return { parts, duplicateSymbols };
}

/**
 * The MOS-P1 cohort-activity alert body.
 *
 * ONE LINE PER MINT: link, how many cohort wallets hold it, total held. The
 * header is repeated on every part, unlike group2's dashboard link, because a
 * split message's second half is otherwise unattributable in a busy channel.
 *
 * LINKS ARE BUILT FROM THE MINT, NOT A POOL ADDRESS. group2's resolvePairs
 * lowercases pairAddress, which is correct for EVM and destroys a Solana base58
 * address. DexScreener resolves a token URL from the mint directly, so nothing
 * here ever changes the case of an address.
 *
 * AN UNINDEXED MINT STILL GETS A LINE, labelled with a short address. group2
 * omits those, but its subject is a launch that may not exist yet; here the
 * cohort demonstrably holds the token, so dropping it would hide the signal the
 * alert exists to carry.
 */
export const HEADER = '**MOS-P1 · cohort activity**';
export const DEXSCREENER_SOLANA = 'https://dexscreener.com/solana/';

/** Discord: 4096 per embed description; headroom for the title and overhead. */
export const PART_BUDGET = 3800;

export interface MintLine {
  mint: string;
  symbol: string | null;
  /** Resolved DexScreener URL; null falls back to a mint-addressed link. */
  url: string | null;
  wallets: number;
  /** Total held across the cohort, already scaled out of base units. */
  total: number;
  /** Increase over the highest count previously alerted; null on a first alert. */
  growth: number | null;
}

export const shortMint = (m: string): string =>
  m.length <= 10 ? m : `${m.slice(0, 4)}…${m.slice(-4)}`;

/**
 * Readable at both ends of a range that spans 0.02 to 60,214,438. Never rounds
 * a non-zero amount to "0", which would read as an empty position.
 */
export function fmtAmount(n: number): string {
  if (!Number.isFinite(n)) return '?';
  if (n === 0) return '0';
  const abs = Math.abs(n);
  if (abs >= 1000) return Math.round(n).toLocaleString('en-US');
  if (abs >= 1) return trim(n.toFixed(2));
  if (abs >= 0.0001) return trim(n.toFixed(6));
  return n.toExponential(2);
}
const trim = (s: string): string => s.replace(/\.?0+$/, '');

export function renderLine(l: MintLine, suffix = ''): string {
  // suffix disambiguates colliding symbols and is DISPLAY ONLY -- it is never
  // stored, and nothing keyed on the mint ever sees it.
  const label = l.symbol === null ? shortMint(l.mint) : l.symbol + suffix;
  const url = l.url ?? `${DEXSCREENER_SOLANA}${l.mint}`;
  const base = `[${label}](${url}) · ${l.wallets} ${l.wallets === 1 ? 'wallet' : 'wallets'}`
    + ` · ${fmtAmount(l.total)}`;
  return l.growth === null ? base : `${base} · +${l.growth}`;
}

export interface RenderedAlert {
  parts: string[];
  /** Lines that had to be marked because their symbol was already used. */
  duplicateSymbols: number;
}

/**
 * Sorted by wallet count descending, then by total held, then by mint so the
 * order is total and deterministic. Disambiguation follows that sort, so which
 * of two same-symbol mints keeps the bare name never depends on read order.
 */
export function renderAlert(lines: MintLine[]): RenderedAlert {
  if (!lines.length) return { parts: [], duplicateSymbols: 0 };
  const sorted = [...lines].sort((a, b) =>
    b.wallets - a.wallets || b.total - a.total || a.mint.localeCompare(b.mint));

  const seen = new Map<string, number>();
  let duplicateSymbols = 0;
  const rendered = sorted.map((l) => {
    if (l.symbol === null) return renderLine(l);   // short address is already unique
    const n = seen.get(l.symbol) ?? 0;
    seen.set(l.symbol, n + 1);
    if (n > 0) duplicateSymbols++;
    return renderLine(l, '*'.repeat(n));
  });

  const parts: string[] = [];
  let cur = HEADER;
  for (const line of rendered) {
    if (cur.length + 1 + line.length > PART_BUDGET && cur !== HEADER) {
      parts.push(cur); cur = HEADER;
    }
    cur = `${cur}\n${line}`;
  }
  if (cur !== HEADER) parts.push(cur);
  return { parts, duplicateSymbols };
}

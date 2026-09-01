/**
 * The hourly Discord message.
 *
 * READABILITY IS THE CONSTRAINT. A cycle produces ~53 tokens and ~217 wallets;
 * listing them is unreadable and exceeds Discord's 2,000-character limit. So the
 * message leads with the two graded sections and reduces the rest to counts.
 *
 * GROUPED BY WALLET, not one line per buy. A wallet that bought four tokens
 * used four of the twelve lead lines, crowding out other wallets; one line per
 * wallet with its tokens listed inline fits far more distinct wallets in the
 * same budget.
 *
 * LINKS ARE MARKDOWN, which is both clickable and shorter than a bare URL.
 * Tokens link to DexScreener by POOL address (v4 pairs are identified by their
 * poolId, not the token). Wallet links to Blockscout are added only if the
 * message still fits: token links are the priority, so wallet links are dropped
 * first when the budget is tight.
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
  /** DexScreener identifies a v4 pair by poolId; null means no link is possible. */
  poolId?: string | null;
}

const shortAddr = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;
const age = (m: number): string => (m < 60 ? `${Math.round(m)}m` : `${(m / 60).toFixed(1)}h`);
const usd = (n: number): string =>
  `${n < 0 ? '-' : ''}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`;

const DEXSCREENER = 'https://dexscreener.com/robinhood/';
const BLOCKSCOUT = 'https://robinhoodchain.blockscout.com/address/';

/** Token as a DexScreener link, or plain text when we have no pool address. */
function tokenLink(h: HitRow): string {
  const label = h.symbol ?? shortAddr(h.token);
  return h.poolId ? `[${label}](${DEXSCREENER}${h.poolId})` : label;
}

function walletLink(addr: string, linked: boolean): string {
  return linked ? `[${shortAddr(addr)}](${BLOCKSCOUT}${addr})` : `\`${shortAddr(addr)}\``;
}

interface Group {
  wallet: string;
  cohorts: number;
  total: number;
  clusterId: string | null;
  rows: HitRow[];
}

function group(rows: HitRow[]): Group[] {
  const by = new Map<string, Group>();
  for (const r of rows) {
    let g = by.get(r.wallet);
    if (!g) {
      g = { wallet: r.wallet, cohorts: r.cohorts, total: r.totalRealizedUsd,
            clusterId: r.clusterId ?? null, rows: [] };
      by.set(r.wallet, g);
    }
    g.rows.push(r);
  }
  for (const g of by.values()) {
    // Newest pool first: the freshest launch is the interesting one.
    g.rows.sort((a, b) => a.poolAgeMinutes - b.poolAgeMinutes);
  }
  return [...by.values()].sort((a, b) => b.total - a.total);
}

function tokensOf(g: Group, maxTokens: number): string {
  const shown = g.rows.slice(0, maxTokens)
    .map((r) => `${tokenLink(r)} ${age(r.poolAgeMinutes)}`).join(' · ');
  const extra = g.rows.length - maxTokens;
  return extra > 0 ? `${shown} · +${extra}` : shown;
}

function build(
  hits: HitRow[], hourLabel: string, maxLead: number, maxTokens: number, walletLinks: boolean,
): string {
  const tokens = new Set(hits.map((h) => h.token)).size;
  const wallets = new Set(hits.map((h) => h.wallet)).size;
  const cross = group(hits.filter((h) => h.crossToken));
  const clustered = group(hits.filter((h) => !h.crossToken && h.clusterId));
  const rest = hits.filter((h) => !h.crossToken && !h.clusterId);

  const out: string[] = [];
  out.push(`**New-token buys · ${hourLabel}**`);
  out.push(`${tokens} tokens · ${wallets} watchlist wallets · pool age under 2h`);

  if (cross.length) {
    out.push('');
    out.push(`__Cross-token wallets — 2+ cohorts (${cross.length})__`);
    for (const g of cross.slice(0, maxLead)) {
      out.push(`${walletLink(g.wallet, walletLinks)} · ${g.cohorts} cohorts · ${usd(g.total)}`
        + ` → ${tokensOf(g, maxTokens)}`);
    }
    if (cross.length > maxLead) out.push(`… +${cross.length - maxLead} more wallets`);
  }

  if (clustered.length) {
    out.push('');
    out.push(`__Clustered wallets (${clustered.length})__`);
    for (const g of clustered.slice(0, maxLead)) {
      out.push(`${walletLink(g.wallet, walletLinks)} · ${g.clusterId}`
        + ` → ${tokensOf(g, maxTokens)}`);
    }
    if (clustered.length > maxLead) out.push(`… +${clustered.length - maxLead} more wallets`);
  }

  if (rest.length) {
    const t = new Set(rest.map((h) => h.token)).size;
    const w = new Set(rest.map((h) => h.wallet)).size;
    out.push('');
    out.push(`Other watchlist buyers: ${w} wallets across ${t} tokens.`);
  }
  return out.join('\n');
}

export function renderMessage(
  hits: HitRow[], hourLabel: string, opts: { maxLead?: number; maxTokens?: number } = {},
): string | null {
  // No hits means no message at all, not an empty one.
  if (hits.length === 0) return null;
  const maxLead = opts.maxLead ?? 12;
  const maxTokens = opts.maxTokens ?? 3;

  /*
   * WHAT GETS SACRIFICED, IN ORDER. A v4 pool address is 66 hex characters, so
   * one linked token costs about 106 of the 2,000 available -- roughly 14 links
   * fit in an entire message. Something has to give, and the order matters:
   *
   *   1. wallet links      cosmetic; token links were the stated priority
   *   2. tokens per wallet a wallet's second and third token, shown as "+N"
   *   3. wallets shown     last, because distinct wallets are the point of
   *                        grouping in the first place
   *
   * Shrinking tokens-per-wallet before wallets-shown is what keeps twelve
   * distinct wallets visible instead of three.
   */
  const attempts: [number, number, boolean][] = [];
  for (const links of [true, false]) {
    for (let t = maxTokens; t >= 1; t--) attempts.push([maxLead, t, links]);
  }
  for (let lead = maxLead - 1; lead >= 1; lead--) attempts.push([lead, 1, false]);

  let msg = '';
  for (const [lead, toks, links] of attempts) {
    msg = build(hits, hourLabel, lead, toks, links);
    if (msg.length <= DISCORD_LIMIT) return msg;
  }
  return msg.slice(0, DISCORD_LIMIT - 20).concat('\n… truncated');
}

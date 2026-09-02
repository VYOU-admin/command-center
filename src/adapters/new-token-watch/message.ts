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
 *   1. cross-token wallets  — in 3+ cohorts, the strongest signal
 *   2. clustered wallets    — linked to others by a shared signer
 *   3. every token bought   — one line per token with a distinct-wallet count
 *
 * THE 3+ THRESHOLD IS A DISPLAY GROUPING, NOT A WATCHLIST RULE. Wallets in
 * exactly two cohorts remain on the watchlist and still appear, via the
 * clustered section or the per-token counts; they simply no longer head the
 * message. After nine tokens loaded, 425 wallets sit at exactly 2 cohorts and
 * only 60 at 3+, so 2+ had stopped selecting anything.
 *
 * THE TAIL NAMES EVERY TOKEN, including those already named above -- it is the
 * complete per-token view rather than the leftovers -- and never names a wallet.
 * At ~126 characters per linked token and ~76 tokens a cycle, that list alone
 * exceeds one embed, so the message SPLITS ACROSS MESSAGES rather than
 * truncating. Truncation only happens if a single part still will not fit, and
 * it says so with the count omitted.
 *
 * Truncation is explicit: sections cut to a budget and say "+N more" rather
 * than failing, splitting into several messages, or silently dropping rows.
 */
/** Discord: 4096 per embed description, 6000 per embed overall, 10 embeds/message. */
export const EMBED_DESCRIPTION_LIMIT = 4096;
/** Headroom for the title and Discord's own overhead against the 6000 ceiling. */
export const PART_BUDGET = 3800;
export const DISCORD_LIMIT = EMBED_DESCRIPTION_LIMIT;

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

export interface MessagePart { title: string; description: string }

/** Wallets in this many cohorts or more head the message. Display only. */
export const CROSS_TOKEN_MIN_COHORTS = 3;

const shortAddr = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;
const age = (m: number): string => (m < 60 ? `${Math.round(m)}m` : `${(m / 60).toFixed(1)}h`);
const usd = (n: number): string =>
  `${n < 0 ? '-' : ''}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`;

const DEXSCREENER = 'https://dexscreener.com/robinhood/';
const BLOCKSCOUT = 'https://robinhoodchain.blockscout.com/address/';

export function tokenLink(h: { token: string; symbol?: string | null; poolId?: string | null }): string {
  const label = h.symbol ?? shortAddr(h.token);
  return h.poolId ? `[${label}](${DEXSCREENER}${h.poolId})` : label;
}
const walletLink = (a: string, linked: boolean): string =>
  linked ? `[${shortAddr(a)}](${BLOCKSCOUT}${a})` : `\`${shortAddr(a)}\``;

interface Group {
  wallet: string; cohorts: number; total: number; clusterId: string | null; rows: HitRow[];
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
  for (const g of by.values()) g.rows.sort((a, b) => a.poolAgeMinutes - b.poolAgeMinutes);
  return [...by.values()].sort((a, b) => b.total - a.total);
}

function tokensOf(g: Group, maxTokens: number): string {
  const shown = g.rows.slice(0, maxTokens)
    .map((r) => `${tokenLink(r)} ${age(r.poolAgeMinutes)}`).join(' · ');
  const extra = g.rows.length - maxTokens;
  return extra > 0 ? `${shown} · +${extra}` : shown;
}

/** One line per token: link plus how many distinct watchlist wallets bought it. */
function tokenLines(hits: HitRow[]): string[] {
  const by = new Map<string, { row: HitRow; wallets: Set<string> }>();
  for (const h of hits) {
    let e = by.get(h.token);
    if (!e) { e = { row: h, wallets: new Set() }; by.set(h.token, e); }
    e.wallets.add(h.wallet);
  }
  return [...by.values()]
    .sort((a, b) => b.wallets.size - a.wallets.size
      || a.row.poolAgeMinutes - b.row.poolAgeMinutes)
    .map((e) => `${tokenLink(e.row)} · ${e.wallets.size}`);
}

function leadBlock(
  hits: HitRow[], hourLabel: string, maxLead: number, maxTokens: number, walletLinks: boolean,
): string {
  const tokens = new Set(hits.map((h) => h.token)).size;
  const wallets = new Set(hits.map((h) => h.wallet)).size;
  const cross = group(hits.filter((h) => h.cohorts >= CROSS_TOKEN_MIN_COHORTS));
  const crossSet = new Set(cross.map((g) => g.wallet));
  const clustered = group(hits.filter((h) => !crossSet.has(h.wallet) && h.clusterId));

  const out: string[] = [];
  out.push(`**New-token buys · ${hourLabel}**`);
  out.push(`${tokens} tokens · ${wallets} watchlist wallets · pool age under 2h`);
  if (cross.length) {
    out.push('');
    out.push(`__Cross-token wallets — ${CROSS_TOKEN_MIN_COHORTS}+ cohorts (${cross.length})__`);
    for (const g of cross.slice(0, maxLead))
      out.push(`${walletLink(g.wallet, walletLinks)} · ${g.cohorts} cohorts · ${usd(g.total)}`
        + ` → ${tokensOf(g, maxTokens)}`);
    if (cross.length > maxLead) out.push(`… +${cross.length - maxLead} more wallets`);
  }
  if (clustered.length) {
    out.push('');
    out.push(`__Clustered wallets (${clustered.length})__`);
    for (const g of clustered.slice(0, maxLead))
      out.push(`${walletLink(g.wallet, walletLinks)} · ${g.clusterId}`
        + ` → ${tokensOf(g, maxTokens)}`);
    if (clustered.length > maxLead) out.push(`… +${clustered.length - maxLead} more wallets`);
  }
  return out.join('\n');
}

export function renderMessages(
  hits: HitRow[], hourLabel: string, opts: { maxLead?: number; maxTokens?: number } = {},
): MessagePart[] {
  if (hits.length === 0) return [];          // no hits sends nothing at all
  const maxLead = opts.maxLead ?? 12;
  const maxTokens = opts.maxTokens ?? 3;

  // Lead block: sacrifice wallet links, then tokens per wallet, then wallets.
  let lead = '';
  const attempts: [number, number, boolean][] = [];
  for (const links of [true, false])
    for (let t = maxTokens; t >= 1; t--) attempts.push([maxLead, t, links]);
  for (let l = maxLead - 1; l >= 1; l--) attempts.push([l, 1, false]);
  for (const [l, t, links] of attempts) {
    lead = leadBlock(hits, hourLabel, l, t, links);
    if (lead.length <= PART_BUDGET) break;
  }
  const parts: MessagePart[] = [{ title: `New-token buys · ${hourLabel}`, description: lead }];

  // Per-token list, split across as many parts as it needs.
  const lines = tokenLines(hits);
  const chunks: string[][] = [];
  let cur: string[] = [], len = 0;
  for (const line of lines) {
    if (len + line.length + 1 > PART_BUDGET - 80 && cur.length) { chunks.push(cur); cur = []; len = 0; }
    cur.push(line); len += line.length + 1;
  }
  if (cur.length) chunks.push(cur);
  chunks.forEach((ch, i) => {
    const label = chunks.length > 1 ? ` (${i + 1}/${chunks.length})` : '';
    parts.push({
      title: `Tokens bought · ${hourLabel}${label}`,
      description: `__All tokens bought, by distinct watchlist wallets__\n` + ch.join('\n'),
    });
  });

  // Last resort only: a single part that still will not fit says what it dropped.
  return parts.map((p) => {
    if (p.description.length <= EMBED_DESCRIPTION_LIMIT) return p;
    const keep = p.description.slice(0, EMBED_DESCRIPTION_LIMIT - 60);
    const cut = keep.lastIndexOf('\n');
    const kept = keep.slice(0, cut > 0 ? cut : keep.length);
    const dropped = p.description.slice(kept.length).split('\n').filter(Boolean).length;
    return { ...p, description: `${kept}\n… TRUNCATED, ${dropped} line(s) omitted` };
  });
}

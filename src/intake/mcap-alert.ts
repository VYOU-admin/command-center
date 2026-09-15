/**
 * The market-cap alert: buys only, filtered by TOTAL-SUPPLY market cap.
 *
 * A SECOND MESSAGE TO THE SAME CHANNEL ON THE SAME RUN, not a replacement. The
 * existing alert ranks whatever the watchlist touched; this one asks which SMALL
 * tokens they are buying, where an early position is still an early position.
 *
 * MARKET CAP HERE IS TOTAL-SUPPLY MARKET CAP AND THE BODY SAYS SO. Both of its terms
 * carry a limitation that is labelled rather than buried:
 *
 *  - Total supply is NOT circulating supply. A burn address or a locked LP makes the
 *    two diverge and nothing here measures either.
 *  - The slice-implied price is NOT a market price. It is the same volume-weighted
 *    average over one wallet set's trades in ~10,000 blocks the existing alert's
 *    price line uses. Multiplying it by a supply does not make it more of a market
 *    figure than it was.
 *
 * THE TOKENS THE FILTER CANNOT SEE ARE THE POINT, NOT AN EDGE CASE. 439 tokens
 * measured on 2026-09-14 are quoted only against other memecoins and have no USD
 * route at any effort; the earliest signal is likeliest to be exactly there. They get
 * their own section below the filtered list, never dropped, with the two reasons
 * labelled distinctly because they are not the same condition.
 */
import {
  BODY_MARGIN, chartUrl, fitBody, mcapFigure, n0, px, short, tokenLabel, usdFigure,
} from './alert-format.js';

export interface McapRow {
  token: string;
  wallet: string;
  side: 'buy' | 'sell';
  tokenAmount: number;
  usdAmount: number | null;
  tokenName: string | null;
  tokenSymbol: string | null;
}

export interface McapInput {
  rows: McapRow[];
  /** Whole-token supply per token, from `loadSupplies`. Absent = never read. */
  supplies: Map<string, { units: number | null }>;
  maxMarketCapUsd: number;
  /** Measured alongside and reported, so the cut can be moved from evidence. */
  compareMarketCapUsd: number;
  fromBlock: number;
  toBlock: number;
  publicUrl?: string | null;
  cap?: number;
  margin?: number;
}

interface Agg {
  token: string;
  name: string | null;
  symbol: string | null;
  buyers: Set<string>;
  buyTrades: number;
  buyUsd: number;
  buyUnpriced: number;
  buyTokens: number;
  /* The price line's two terms, over PRICED rows only -- including an unpriced row's
   * tokens would divide real dollars by tokens that contributed none. Both sides feed
   * the price, as in the existing alert; only the DISPLAY is buys-only. */
  pricedUsd: number;
  pricedTokens: number;
}

export interface McapReport {
  /** Tokens with a derivable market cap at or under the threshold. */
  qualifying: number;
  /** Same, measured at `compareMarketCapUsd`, for tuning. Never rendered. */
  qualifyingAtCompare: number;
  /** Tokens with a derivable market cap ABOVE the threshold: filtered out. */
  aboveThreshold: number;
  /** Bought, priced, but no resolvable supply. */
  noSupply: number;
  /** Bought and nothing priced: no USD route at all. */
  noPrice: number;
  tokensWithBuys: number;
  buyRows: number;
  buyWallets: number;
  shownQualifying: number;
  shownUnvalued: number;
  droppedQualifying: number;
  droppedUnvalued: number;
  characters: number;
  overran: boolean;
  /** Null when nothing is to be sent. */
  body: string | null;
  title: string | null;
}

/**
 * Build the alert body, or return `body: null` when there is nothing to send.
 *
 * NOTHING IS SENT ON AN EMPTY PERIOD, and "empty" means BOTH sections are empty. A
 * slice with no qualifying token but a full unpriceable section still posts, because
 * that section is the signal this alert exists to carry.
 */
export function buildMcapAlert(input: McapInput): McapReport {
  const CAP = input.cap ?? 10;
  const MARGIN = input.margin ?? BODY_MARGIN;

  const byToken = new Map<string, Agg>();
  for (const r of input.rows) {
    const key = r.token.toLowerCase();
    const e = byToken.get(key) ?? {
      token: key, name: r.tokenName, symbol: r.tokenSymbol,
      buyers: new Set<string>(), buyTrades: 0, buyUsd: 0, buyUnpriced: 0,
      buyTokens: 0, pricedUsd: 0, pricedTokens: 0,
    };
    const amt = Math.abs(Number(r.tokenAmount));
    if (r.side === 'buy') {
      e.buyers.add(r.wallet);
      e.buyTrades += 1;
      e.buyTokens += amt;
      if (r.usdAmount === null) e.buyUnpriced += 1; else e.buyUsd += r.usdAmount;
    }
    if (r.usdAmount !== null) { e.pricedUsd += r.usdAmount; e.pricedTokens += amt; }
    byToken.set(key, e);
  }

  /* BUYS ONLY: a token the slice only sold has no line here at all. */
  const bought = [...byToken.values()].filter((e) => e.buyTrades > 0);

  const impliedPrice = (e: Agg): number | null =>
    (e.pricedTokens > 0 && e.pricedUsd > 0 ? e.pricedUsd / e.pricedTokens : null);

  interface Valued { e: Agg; price: number; supply: number; mcap: number }
  const valued: Valued[] = [];
  const noSupply: Agg[] = [];
  const noPrice: Agg[] = [];

  for (const e of bought) {
    const price = impliedPrice(e);
    if (price === null) { noPrice.push(e); continue; }
    const supply = input.supplies.get(e.token)?.units ?? null;
    /*
     * A NULL SUPPLY IS NOT A ZERO SUPPLY. Zero would compute a $0 market cap, which
     * clears any ceiling and would put every unreadable token at the top of the
     * filtered list -- step 1's rule deciding what appears in an alert.
     */
    if (supply === null || !(supply > 0)) { noSupply.push(e); continue; }
    valued.push({ e, price, supply, mcap: supply * price });
  }

  const qualifying = valued
    .filter((v) => v.mcap <= input.maxMarketCapUsd)
    .sort((a, b) => (b.e.buyers.size - a.e.buyers.size) || (b.e.buyUsd - a.e.buyUsd));
  const qualifyingAtCompare =
    valued.filter((v) => v.mcap <= input.compareMarketCapUsd).length;
  const aboveThreshold = valued.length - qualifying.length;

  /*
   * THE UNVALUED SECTION, both kinds together but LABELLED DISTINCTLY. Ordered the
   * same way -- distinct buying wallets, then whatever dollars are known -- so the
   * coordination signal leads here too.
   */
  type Unvalued = { e: Agg; kind: 'no-price' | 'no-supply' };
  const unvalued: Unvalued[] = [
    ...noPrice.map((e) => ({ e, kind: 'no-price' as const })),
    ...noSupply.map((e) => ({ e, kind: 'no-supply' as const })),
  ].sort((a, b) => (b.e.buyers.size - a.e.buyers.size) || (b.e.buyUsd - a.e.buyUsd));

  const buyRows = input.rows.filter((r) => r.side === 'buy').length;
  const buyWallets = new Set(
    input.rows.filter((r) => r.side === 'buy').map((r) => r.wallet),
  ).size;

  if (qualifying.length === 0 && unvalued.length === 0) {
    return {
      qualifying: 0, qualifyingAtCompare, aboveThreshold, noSupply: 0, noPrice: 0,
      tokensWithBuys: bought.length, buyRows, buyWallets,
      shownQualifying: 0, shownUnvalued: 0, droppedQualifying: 0, droppedUnvalued: 0,
      characters: 0, overran: false, body: null, title: null,
    };
  }

  const wallets = (n: number): string => `${n} wallet${n === 1 ? '' : 's'}`;

  const qualBlock = (v: Valued): string => {
    const e = v.e;
    return `[${tokenLabel(e.token, e.symbol, e.name)}](${chartUrl(e.token)})`
      + `  \`${short(e.token)}\`\n`
      + `　bought   ${wallets(e.buyers.size)}  `
      + `${usdFigure(e.buyUsd, e.buyUnpriced, e.buyTrades)}\n`
      + `　mcap     ${mcapFigure(v.mcap)} (total supply)  ·  price ${px(v.price)}`;
  };

  const unvaluedBlock = (u: Unvalued): string => {
    const e = u.e;
    const tok = e.buyTokens.toLocaleString('en-US', { maximumFractionDigits: 0 });
    /*
     * A TOKEN WHOSE USD WE DO KNOW IS NOT RENDERED `unpriced`. Printing `unpriced`
     * over a figure the run computed would misstate what is known. The no-price kind
     * genuinely has no dollars; the no-supply kind keeps its dollars and loses only
     * the market cap, and the two are labelled so a reader can tell which is which.
     */
    const money = u.kind === 'no-price'
      ? 'unpriced'
      : `${usdFigure(e.buyUsd, e.buyUnpriced, e.buyTrades)}  ·  mcap unknown`;
    const why = u.kind === 'no-price' ? 'no USD route' : 'supply unread';
    return `[${tokenLabel(e.token, e.symbol, e.name)}](${chartUrl(e.token)})`
      + `  \`${short(e.token)}\`\n`
      + `　bought   ${wallets(e.buyers.size)}  ${tok} tokens  ·  ${money}  _(${why})_`;
  };

  const render = (counts: number[]): string => {
    const [nq, nu] = [counts[0]!, counts[1]!];
    const shownQ = qualifying.slice(0, nq);
    const shownU = unvalued.slice(0, nu);
    const dropQ = qualifying.length - shownQ.length;
    const dropU = unvalued.length - shownU.length;

    let s = `Buys only  ·  market cap ≤ $${n0(input.maxMarketCapUsd)}`
      + `  ·  blocks ${input.fromBlock}–${input.toBlock}\n`
      + `_Market cap is TOTAL supply × a slice-implied price — not circulating `
      + `supply, and not a market price._`;

    if (shownQ.length > 0) {
      s += `\n\n${shownQ.map(qualBlock).join('\n\n')}`;
    } else {
      /*
       * REPORTED, NOT OMITTED. An absent section reads as "there were none to look
       * at"; this says the filter ran and matched nothing, which is a result.
       */
      s += `\n\n_No token under $${n0(input.maxMarketCapUsd)} was bought this slice._`;
    }
    if (dropQ > 0) {
      s += `\n\n_…and ${dropQ} more under the cap._`;
    }

    if (shownU.length > 0) {
      s += `\n\n**No market cap — ${unvalued.length} token`
        + `${unvalued.length === 1 ? '' : 's'} the filter cannot see**\n`
        + `_${noPrice.length} with no USD route, ${noSupply.length} with an unread `
        + `supply. These are where the earliest signal is likeliest to be._\n\n`
        + shownU.map(unvaluedBlock).join('\n\n');
      if (dropU > 0) {
        s += `\n\n_…and ${dropU} more with no market cap._`;
      }
    }

    s += input.publicUrl
      ? `\n\n**[Every trade on the watchlist tab →](${input.publicUrl}/watchlist)**`
      : `\n\nAll buys are in \`watchlist_activity\`; the watchlist tab has no `
        + 'public URL configured.';
    return s;
  };

  /*
   * THE GUARD DROPS FROM THE UNPRICEABLE TAIL FIRST AND THE FILTERED TAIL SECOND, so
   * the list the alert is named for survives longest. The floors are 0 and 0: either
   * section may vanish entirely rather than let the footer be sliced off, and the
   * footer then still states what was dropped.
   */
  const fit = fitBody(
    render,
    [Math.min(CAP, qualifying.length), Math.min(CAP, unvalued.length)],
    [0, 0],
    [1, 0],
    MARGIN,
  );

  return {
    qualifying: qualifying.length,
    qualifyingAtCompare,
    aboveThreshold,
    noSupply: noSupply.length,
    noPrice: noPrice.length,
    tokensWithBuys: bought.length,
    buyRows,
    buyWallets,
    shownQualifying: fit.counts[0]!,
    shownUnvalued: fit.counts[1]!,
    droppedQualifying: qualifying.length - fit.counts[0]!,
    droppedUnvalued: unvalued.length - fit.counts[1]!,
    characters: fit.characters,
    overran: fit.overran,
    body: fit.body,
    title: `Small-cap buys: ${qualifying.length} token`
      + `${qualifying.length === 1 ? '' : 's'} under $${n0(input.maxMarketCapUsd)}`
      + `, ${unvalued.length} unvalued`,
  };
}

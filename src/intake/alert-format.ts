/**
 * Formatting shared by BOTH watchlist alerts.
 *
 * WHY THIS FILE EXISTS. Every one of these rules was inline in
 * `adapters/watchlist-watch.ts` and serving one alert. Adding a second alert that
 * copied them would be the FIFTH instance of the two-implementations trap
 * docs/ROBINHOOD.md records -- the failure mode it names more often than any other,
 * and the one where the copy is always the weaker of the two. They are extracted
 * rather than duplicated, and the existing alert imports them unchanged.
 *
 * Nothing here reads the database or the chain. It is formatting and one measuring
 * loop, so both callers can be reasoned about from their own numbers.
 */

/** `0x39dbed…4571` — the address is ALWAYS shown; see `tokenLabel`. */
export const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Whole dollars with separators. */
export const n0 = (x: number): string =>
  x.toLocaleString('en-US', { maximumFractionDigits: 0 });

/**
 * A ZERO USD FIGURE IS NEVER PRINTED AS `$0`.
 *
 * Either the side had no trades -- a dash -- or every row on it was unpriced, or it
 * is partly unpriced and reads `$n+` so a total is never presented as complete when
 * it is not. `$0` would be a measurement, and the wrong one.
 */
export const usdFigure = (v: number, unpriced: number, trades: number): string => {
  if (trades === 0) return '—';
  if (unpriced === trades) return 'unpriced';
  return unpriced > 0 ? `$${n0(v)}+` : `$${n0(v)}`;
};

/** Token prices span many orders of magnitude here, so the scale picks itself. */
export const px = (v: number): string => {
  if (v >= 1) return `$${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  if (v >= 0.0001) return `$${v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`;
  return `$${v.toPrecision(3)}`;
};

/** A market cap reads better abbreviated; the ceiling it is compared against is exact. */
export const mcapFigure = (v: number): string => {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}k`;
  return `$${n0(v)}`;
};

/**
 * A SYMBOL IS A LABEL, NOT AN IDENTITY.
 *
 * Two tokens on this chain both answer `symbol()` with "NVDA" (step 16), so the
 * address is always rendered beside the label, and a token answering neither
 * `name()` nor `symbol()` shows its address rather than a label somebody invented.
 */
export const tokenLabel = (
  token: string, symbol: string | null, name: string | null,
): string => (symbol && name ? `**${symbol}** — ${name}`
  : symbol ? `**${symbol}**`
    : name ? `**${name}**`
      : `\`${short(token)}\``);

/** The same URL the `/watchlist` tab links to, so both surfaces agree. */
export const chartUrl = (token: string): string =>
  `https://dexscreener.com/robinhood/${token}`;

/** Discord's embed description caps at 4,096 and the sink slices at 4,000. */
export const SINK_SLICE = 4000;
/** 400 below the slice: room for one more block plus footer growth. A round number. */
export const BODY_MARGIN = 3600;

export interface FitResult {
  body: string;
  /** How many units each render step was asked for, after dropping. */
  counts: number[];
  /** True when even the smallest render still overran. */
  overran: boolean;
  characters: number;
}

/**
 * MEASURE THE RENDERED BODY AND DROP FROM THE TAIL UNTIL IT FITS.
 *
 * A CAP ALONE CANNOT GUARANTEE THE FIT because a block's length is not fixed: names
 * run from `FAB` to `Large Language Model`, USD from `$40` to `$8,537+`, prices from
 * `$0.0000350` to `$2,524.13`. Past the sink's slice the alert does not vanish -- it
 * silently loses its TAIL, which is the "and N more" footer and the tab link, the two
 * elements that say something was omitted. A truncated alert would look complete.
 *
 * `counts` is a vector so a caller with more than one section can say which section
 * shrinks first. `order` gives the index to decrement, tried left to right, so a
 * caller puts its least important section first. The floor for each is `floors[i]`,
 * which is 0 for a section that may vanish entirely and 1 for one that must not.
 */
export function fitBody(
  render: (counts: number[]) => string,
  initial: number[],
  floors: number[],
  order: number[],
  margin: number = BODY_MARGIN,
): FitResult {
  const counts = [...initial];
  let body = render(counts);
  for (const i of order) {
    while (body.length > margin && counts[i]! > (floors[i] ?? 0)) {
      counts[i] = counts[i]! - 1;
      body = render(counts);
    }
    if (body.length <= margin) break;
  }
  return {
    body, counts, overran: body.length > margin, characters: body.length,
  };
}

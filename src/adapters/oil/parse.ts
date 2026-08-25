/**
 * HTML parsers, one per source.
 *
 * The governing rule here is that these throw rather than return something
 * plausible. A silently wrong price is worse than a missing one: a null or a
 * zero flows into the comparison table, the change alert, and the history, and
 * nothing downstream can tell it apart from a real number. So every field that
 * must exist is asserted, and every price is range-checked before it is
 * returned. A scraper that breaks should look broken.
 */

const MIN_PLAUSIBLE_PRICE = 0.5;
const MAX_PLAUSIBLE_PRICE = 25;

/** Vendor history predating this is a mis-typed two-digit year, not a record. */
const MIN_HISTORY_DATE = '2000-01-01';

/** Allow a little slack for timezone skew, but not a year into the future. */
function maxHistoryDate(): string {
  return new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
}

export class ParseError extends Error {
  constructor(source: string, detail: string) {
    super(`${source}: ${detail}`);
    this.name = 'ParseError';
  }
}

/** Strip tags to newline-separated text, preserving reading order. */
export function textLines(html: string): string[] {
  const stripped = html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, '\n');
  return decodeEntities(stripped)
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 0);
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#8217;|&rsquo;/gi, '’')
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)));
}

/**
 * Parse a price and refuse anything outside a plausible retail range. Catches
 * the failure mode where a layout change makes a regex match some other number
 * on the page — a phone number fragment or a gallon count — which would
 * otherwise be stored as a perfectly valid-looking price.
 */
export function price(raw: string, source: string, what: string): number {
  const m = /(\d+(?:\.\d+)?)/.exec(raw.replace(/[$,\s]/g, ''));
  if (!m) throw new ParseError(source, `${what}: no number in ${JSON.stringify(raw)}`);
  const value = Number.parseFloat(m[1]!);
  if (!Number.isFinite(value)) {
    throw new ParseError(source, `${what}: unparseable number ${JSON.stringify(raw)}`);
  }
  if (value < MIN_PLAUSIBLE_PRICE || value > MAX_PLAUSIBLE_PRICE) {
    throw new ParseError(
      source,
      `${what}: ${value} is outside the plausible range ` +
        `${MIN_PLAUSIBLE_PRICE}-${MAX_PLAUSIBLE_PRICE}/gal — the page layout has probably changed`,
    );
  }
  return value;
}

/**
 * Calendar-validity check. Month and day ranges are not enough: vendors publish
 * dates that cannot exist. McKinley's own historical table contains 9/31/24.
 */
function isRealDate(year: number, month: number, day: number): boolean {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** "August 25, 2026" / "Aug 26th 2026" -> YYYY-MM-DD. */
export function longDate(raw: string, source: string, what: string): string {
  const m = /([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/.exec(raw);
  if (!m) throw new ParseError(source, `${what}: no date in ${JSON.stringify(raw)}`);
  const month = MONTHS[m[1]!.slice(0, 3).toLowerCase()];
  if (!month) throw new ParseError(source, `${what}: unknown month in ${JSON.stringify(raw)}`);
  const day = Number.parseInt(m[2]!, 10);
  const year = Number.parseInt(m[3]!, 10);
  // A single critical date being impossible is a hard error: there is no
  // defensible way to guess whether 9/31 meant the 30th or the 1st.
  if (!isRealDate(year, month, day)) {
    throw new ParseError(source, `${what}: ${JSON.stringify(raw)} is not a real date`);
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** "8/25/26" -> YYYY-MM-DD, pivoting two-digit years on 70. */
export function shortDate(raw: string, source: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(raw.trim());
  if (!m) return null;
  const month = Number.parseInt(m[1]!, 10);
  const day = Number.parseInt(m[2]!, 10);
  let year = Number.parseInt(m[3]!, 10);
  if (m[3]!.length === 2) year += year < 70 ? 2000 : 1900;
  if (!isRealDate(year, month, day)) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/* --------------------------------------------------------------- mckinley */

export interface McKinleyToday {
  pricePerGallon: number;
  gallonMinimum: number;
  priceDate: string;
  surchargeNote: string | null;
}

export function parseMcKinleyToday(html: string): McKinleyToday {
  const S = 'mckinley';
  const lines = textLines(html);

  const dateLine = lines.find((l) => /[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}/.test(l));
  if (!dateLine) throw new ParseError(S, 'no date line found on the price frame');
  const priceDate = longDate(dateLine, S, 'price date');

  // The price is the figure immediately before "per gallon", not simply the
  // first dollar amount on the page — the surcharge note also contains one.
  const perGallonAt = lines.findIndex((l) => /^per\s+gallon/i.test(l));
  let priceLine: string | undefined;
  if (perGallonAt > 0) {
    priceLine = lines.slice(0, perGallonAt).reverse().find((l) => /\$\s*\d/.test(l));
  }
  priceLine ??= lines.find((l) => /^\$\s*\d/.test(l));
  if (!priceLine) throw new ParseError(S, 'no price found near "per gallon"');
  const pricePerGallon = price(priceLine, S, 'price per gallon');

  const minLine = lines.find((l) => /\d+\s*gallon\s*minimum/i.test(l));
  if (!minLine) throw new ParseError(S, 'no "N gallon Minimum" line found');
  const minMatch = /(\d+)\s*gallon\s*minimum/i.exec(minLine)!;
  const gallonMinimum = Number.parseInt(minMatch[1]!, 10);
  if (!Number.isFinite(gallonMinimum) || gallonMinimum <= 0 || gallonMinimum > 10_000) {
    throw new ParseError(S, `implausible gallon minimum ${gallonMinimum}`);
  }

  const surchargeNote = lines.find((l) => /extra per gallon|surcharge/i.test(l)) ?? null;

  return { pricePerGallon, gallonMinimum, priceDate, surchargeNote };
}

export interface McKinleyHistory {
  rows: { priceDate: string; price: number }[];
  /**
   * Date cells that looked like dates but are not real ones. Reported rather
   * than dropped quietly: the vendor's table really does contain 9/31/24, and
   * coercing that to a neighbouring day would invent a price that was never
   * published.
   */
  skipped: string[];
}

export function parseMcKinleyHistory(html: string): McKinleyHistory {
  const S = 'mckinley-history';
  const lines = textLines(html);
  const out: { priceDate: string; price: number }[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < lines.length - 1; i++) {
    const raw = lines[i]!;
    let date = shortDate(raw, S);
    // Two-digit years cannot distinguish a typo from a real year: "7/30/90"
    // parses cleanly as 1990, decades before this vendor's table begins, and
    // would otherwise sit in the history as a real data point.
    if (date && (date < MIN_HISTORY_DATE || date > maxHistoryDate())) {
      skipped.push(raw);
      date = null;
      continue;
    }
    if (!date) {
      // Shaped like a date but not a real one, and followed by a price.
      if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(raw) && /^\$\s*\d/.test(lines[i + 1] ?? '')) {
        skipped.push(raw);
      }
      continue;
    }
    const next = lines[i + 1]!;
    if (!/^\$\s*\d/.test(next)) continue;
    if (seen.has(date)) continue;
    seen.add(date);
    out.push({ priceDate: date, price: price(next, S, `history price for ${date}`) });
  }

  if (out.length < 100) {
    throw new ParseError(
      S,
      `only ${out.length} history rows parsed; the table has thousands, so the layout has changed`,
    );
  }
  // A handful of vendor typos is normal; a flood means the date format moved.
  if (skipped.length > out.length * 0.05) {
    throw new ParseError(
      S,
      `${skipped.length} of ${out.length + skipped.length} history dates were unparseable ` +
        `(e.g. ${skipped.slice(0, 3).join(', ')}) — the date format has probably changed`,
    );
  }
  return { rows: out, skipped };
}

/* -------------------------------------------------------- cashheatingoil */

export interface GallonBand {
  gallonMin: number;
  gallonMax: number | null;
  pricePerGallon: number;
}

export interface CashHeatingOilListing {
  position: number;
  listingId: string | null;
  dealerId: string | null;
  deliveryDate: string | null;
  priceUpdatedOn: string | null;
  cash: GallonBand[];
  credit: GallonBand[];
}

export interface CashHeatingOilPage {
  zip: string;
  city: string | null;
  state: string | null;
  listingId: string | null;
  listings: CashHeatingOilListing[];
}

function bandsFrom(tableHtml: string, source: string, what: string): GallonBand[] {
  const bands: GallonBand[] = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let row: RegExpExecArray | null;
  while ((row = rowRe.exec(tableHtml)) !== null) {
    const cells = [...row[1]!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) =>
      decodeEntities(c[1]!.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim(),
    );
    if (cells.length < 2) continue;
    const bandMatch = /^(\d+)\s*-\s*(\d+)?\+?$/.exec(cells[0]!) ?? /^(\d+)\+$/.exec(cells[0]!);
    if (!bandMatch) continue;
    if (!/\$?\s*\d/.test(cells[1]!)) continue;
    bands.push({
      gallonMin: Number.parseInt(bandMatch[1]!, 10),
      gallonMax: bandMatch[2] ? Number.parseInt(bandMatch[2], 10) : null,
      pricePerGallon: price(cells[1]!, source, `${what} band ${cells[0]}`),
    });
  }
  return bands;
}

function hidden(block: string, name: string): string | null {
  const re = new RegExp(`name=["']${name}["'][^>]*value=["']([^"']*)["']`, 'i');
  const alt = new RegExp(`value=["']([^"']*)["'][^>]*name=["']${name}["']`, 'i');
  const m = re.exec(block) ?? alt.exec(block);
  return m ? m[1]!.trim() || null : null;
}

function labelled(block: string, label: string): string | null {
  const re = new RegExp(
    `${label}[\\s\\S]{0,40}?:[\\s\\S]{0,120}?<label[^>]*class=["']varlabel["'][^>]*>([\\s\\S]*?)</label>`,
    'i',
  );
  const m = re.exec(block);
  return m ? decodeEntities(m[1]!.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim() || null : null;
}

export function parseCashHeatingOil(html: string, zip: string): CashHeatingOilPage {
  const S = `cashheatingoil[${zip}]`;

  // Page-level identity. The user-visible "LISTING ID" belongs to the search
  // page, not to any one dealer.
  const idMatch = /LISTING ID[\s\S]{0,200}?<td[^>]*>\s*([A-Za-z0-9]{4,16})\s*<\/td>/i.exec(html);
  const cityMatch = /City[\s\S]{0,120}?<td[^>]*class=["']varlabel["'][^>]*>\s*([^<]{1,60})\s*<\/td>/i.exec(html);
  const stateMatch = /State[\s\S]{0,120}?<td[^>]*>\s*([A-Z]{2})\s*<\/td>/.exec(html);

  const blocks = html
    .split(/(?=<div\s+class=["']boxlisting["'])/i)
    .filter((b) => /class=["']boxlisting["']/i.test(b));

  if (blocks.length === 0) {
    throw new ParseError(S, 'no dealer listing blocks (div.boxlisting) found');
  }

  const listings: CashHeatingOilListing[] = [];
  blocks.forEach((block, i) => {
    const cashTable = /<table[^>]*class=["']paywithcash["'][^>]*>([\s\S]*?)<\/table>/i.exec(block);
    const creditTable = /<table[^>]*class=["']paybycredit["'][^>]*>([\s\S]*?)<\/table>/i.exec(block);

    // Missing table ELEMENTS mean the layout changed and this parser is now
    // guessing, which is the case that must fail loudly.
    //
    // Tables present but holding no band rows is different: it is a dealer who
    // currently lists no prices, which really happens — dealer 1154 in Wolcott
    // was in exactly that state when this was written. Treating that as a parse
    // error would take down the whole scrape for a legitimate empty state, so
    // it yields no price rows instead. It can never produce a null or zero
    // price, because a row is only written per band that actually parsed.
    if (!cashTable && !creditTable) {
      throw new ParseError(
        S,
        `listing ${i + 1} has neither a paywithcash nor a paybycredit table — layout changed`,
      );
    }

    const cash = cashTable ? bandsFrom(cashTable[1]!, S, 'cash') : [];
    const credit = creditTable ? bandsFrom(creditTable[1]!, S, 'credit') : [];

    const updated = labelled(block, 'Price Updated on');
    listings.push({
      position: i + 1,
      listingId: hidden(block, 'listingid') ?? idMatch?.[1] ?? null,
      dealerId: hidden(block, 'dealerid'),
      // The hidden earlistdate is already ISO, so prefer it to the rendered
      // "Aug 26th 2026" which is a formatting choice that could change.
      deliveryDate:
        hidden(block, 'earlistdate') ??
        (labelled(block, 'Delivery Date')
          ? longDate(labelled(block, 'Delivery Date')!, S, 'delivery date')
          : null),
      priceUpdatedOn: updated ? longDate(updated, S, 'price updated on') : null,
      cash,
      credit,
    });
  });

  // Every dealer being empty is not ten coincidences, it is a layout change.
  if (!listings.some((l) => l.cash.length > 0 || l.credit.length > 0)) {
    throw new ParseError(
      S,
      `${listings.length} listings parsed but not one had a single price band — layout changed`,
    );
  }

  return {
    zip,
    city: cityMatch ? decodeEntities(cityMatch[1]!).trim() : null,
    state: stateMatch ? stateMatch[1]! : null,
    listingId: idMatch ? idMatch[1]! : null,
    listings,
  };
}

/**
 * Generic vendor price extractor.
 *
 * These sites are built on Elementor, Gantry and hand-rolled templates, and
 * their markup shares nothing — deeply nested divs with generated class names.
 * Parsing the DOM per site would mean a dozen bespoke parsers that break on any
 * theme update, which is the most common kind of change a small business site
 * makes.
 *
 * The rendered TEXT, by contrast, is near-identical across all of them: an
 * anchor heading followed by gallon quantities and prices. So extraction is
 * anchored on text and described in YAML, and adding a vendor whose page has
 * that shape needs no code at all.
 *
 * It still fails loudly. A missing anchor, a window with no prices, or a price
 * outside a plausible retail range all throw rather than yielding a partial
 * result that looks like a real one.
 */

import { ParseError, price as parsePrice, textLines } from './parse.js';

export interface ExtractRule {
  /** Text that introduces the price block. Matched case-insensitively. */
  anchor: string;
  /** How many lines after the anchor to consider. */
  window: number;
  product: string;
  /** Gallon minimum to record when the vendor quotes one headline price. */
  defaultGallonMin: number | null;
}

export interface ExtractedBand {
  product: string;
  gallonMin: number | null;
  gallonMax: number | null;
  pricePerGallon: number;
}

/** "100 - 299 Gallons", "300+", "Over 500", "500 PLUS", "50-99 GAL", "150". */
function gallonSpec(line: string): { min: number; max: number | null } | null {
  // Vendors decorate these — PriceRite writes "**50 - 99 GAL $5.23/GAL**" — so
  // strip emphasis and punctuation before matching the numbers.
  const s = line
    .replace(/gallons?|gal\b/gi, '')
    .replace(/^[^0-9a-z]+|[^0-9a-z+]+$/gi, '')
    .trim();
  let m = /^(\d{1,5})\s*[-–]\s*(\d{1,5})$/.exec(s);
  if (m) return { min: Number(m[1]), max: Number(m[2]) };
  m = /^(?:over|above)\s*(\d{1,5})$/i.exec(s) ?? /^(\d{1,5})\s*(?:\+|plus)$/i.exec(s);
  if (m) return { min: Number(m[1]), max: null };
  m = /^(\d{1,5})$/.exec(s);
  if (m) {
    const n = Number(m[1]);
    // Bare numbers are only gallon quantities in a plausible delivery range;
    // otherwise this would happily read a year or a phone fragment as a band.
    if (n >= 10 && n <= 5000) return { min: n, max: null };
  }
  return null;
}

const PRICE_ONLY = /^\$\s*\d+(?:\.\d+)?$/;

export function extractBands(
  html: string,
  rule: ExtractRule,
  source: string,
): ExtractedBand[] {
  const lines = textLines(html);
  const anchorAt = lines.findIndex((l) => l.toLowerCase().includes(rule.anchor.toLowerCase()));
  if (anchorAt === -1) {
    throw new ParseError(
      source,
      `anchor ${JSON.stringify(rule.anchor)} not found — the page layout or wording changed`,
    );
  }

  const window = lines.slice(anchorAt, Math.min(lines.length, anchorAt + rule.window + 1));
  const bands: ExtractedBand[] = [];
  const seen = new Set<string>();

  const add = (min: number | null, max: number | null, raw: string, what: string): void => {
    const value = parsePrice(raw, source, what);
    const key = `${min}|${max}`;
    if (seen.has(key)) return;
    seen.add(key);
    bands.push({ product: rule.product, gallonMin: min, gallonMax: max, pricePerGallon: value });
  };

  for (let i = 0; i < window.length; i++) {
    const line = window[i]!;

    // Shape 1: band and price on one line — "50 - 99 GAL $5.23/GAL".
    const inline = /^(.{1,24}?)\s*\$\s*(\d+(?:\.\d+)?)/.exec(line);
    if (inline) {
      const spec = gallonSpec(inline[1]!);
      if (spec) {
        add(spec.min, spec.max, inline[2]!, `${rule.product} band ${inline[1]!.trim()}`);
        continue;
      }
    }

    // Shape 2: a band line, then a price line, possibly with a unit line
    // ("Gallons") in between as Incredible Oil renders it.
    const spec = gallonSpec(line);
    if (spec) {
      for (let j = i + 1; j <= i + 2 && j < window.length; j++) {
        const next = window[j]!;
        if (PRICE_ONLY.test(next)) {
          add(spec.min, spec.max, next, `${rule.product} band ${line}`);
          i = j;
          break;
        }
        if (!/^gallons?$/i.test(next.trim())) break;
      }
      continue;
    }

    // Shape 3: one headline price, on the anchor line or just after it.
    if (bands.length === 0 && i <= 2) {
      const onLine = /\$\s*(\d+(?:\.\d+)?)/.exec(line);
      if (onLine && /price/i.test(line)) {
        add(rule.defaultGallonMin, null, onLine[1]!, `${rule.product} headline price`);
        continue;
      }
      if (/price/i.test(line) && PRICE_ONLY.test(window[i + 1] ?? '')) {
        add(rule.defaultGallonMin, null, window[i + 1]!, `${rule.product} headline price`);
        i += 1;
      }
    }
  }

  if (bands.length === 0) {
    throw new ParseError(
      source,
      `anchor ${JSON.stringify(rule.anchor)} found but no prices parsed in the ` +
        `${rule.window} lines after it — the layout changed`,
    );
  }

  return bands;
}

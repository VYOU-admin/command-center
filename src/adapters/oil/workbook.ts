/**
 * The two Excel exports.
 *
 * cashheatingoil.xlsx answers one question — "who is cheapest in each of my
 * zips, and where does FJB sit" — so it is deliberately narrow: the 100-149
 * gallon band, cash prices only, the top N dealers per zip, plus FJB's own row
 * whenever FJB is not already in that top N. Everything else from that source
 * is dropped.
 *
 * other-sources.xlsx keeps the original seven-column layout unchanged, because
 * it is the general-purpose dump and the narrowing above would destroy it. It
 * carries HEATING OIL ONLY: propane is excluded on the stored `product` field,
 * which each scraper sets from the page's own section anchor rather than from
 * any price threshold — a threshold would misclassify the moment oil moves.
 *
 * WHY FJB IS ALWAYS PRESENT. The point of the file is comparison against one
 * specific dealer. A file that silently omits FJB when it happens to be third
 * outside the reported top N would answer "who is cheapest" while hiding the
 * thing being asked about, so FJB is appended with its true rank and flagged.
 */

import ExcelJS from 'exceljs';

export interface CashRow {
  observed_at: Date;
  zip: string;
  rank: number;
  price_per_gallon: number;
  is_fjb: boolean;
  dealer_id: string | null;
  listing_position: number | null;
  /** True when this row is FJB appended outside the reported top N. */
  extra: boolean;
}

export interface OtherRow {
  observed_at: Date;
  company: string | null;
  source: string;
  zip: string | null;
  band: string | null;
  payment_type: string | null;
  price_per_gallon: string | number;
}

/** One heating-oil price per company: the band that covers a 150 gal delivery. */
export interface CompanyRow {
  observed_at: Date;
  company: string;
  source: string;
  band_label: string;
  price_per_gallon: number;
  zip: string | null;
}

/**
 * Pick the single band that a 150-gallon delivery falls into.
 *
 * Every site labels its tiers differently — "100-299 Gallons", "TODAY'S PRICE",
 * a bare "150" row, "150-199 gallons" behind a zip form — so the choice is made
 * on the parsed bounds rather than on the label. Among a source's heating-oil
 * bands, take the one with the HIGHEST lower bound that still admits 150. The
 * highest-qualifying bound is what makes open-ended tiers work: a site
 * publishing 100+ and 150+ means the 150+ tier for this delivery, not the 100+.
 *
 * Cash wins where a site quotes cash and credit separately.
 */
export function selectCompanyRows(
  rows: {
    observed_at: Date;
    company: string | null;
    source: string;
    zip: string | null;
    gallon_min: number | null;
    gallon_max: number | null;
    payment_type: string | null;
    price_per_gallon: string | number;
    band_label_override?: string | null;
  }[],
  gallons: number,
): CompanyRow[] {
  const bySource = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = bySource.get(r.source) ?? [];
    list.push(r);
    bySource.set(r.source, list);
  }

  const out: CompanyRow[] = [];
  for (const [source, list] of [...bySource.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const eligible = list.filter((r) => {
      const min = r.gallon_min ?? 0;
      const max = r.gallon_max;
      return min <= gallons && (max === null || max >= gallons);
    });
    if (eligible.length === 0) continue;

    // Cash beats credit; then the highest qualifying lower bound.
    eligible.sort((a, b) => {
      const cash = (x: typeof a): number => (x.payment_type === 'credit' ? 1 : 0);
      if (cash(a) !== cash(b)) return cash(a) - cash(b);
      return (b.gallon_min ?? 0) - (a.gallon_min ?? 0);
    });
    const pick = eligible[0]!;
    const label =
      pick.band_label_override ??
      (pick.gallon_min === null
        ? '(no band stated)'
        : pick.gallon_max === null
          ? `${pick.gallon_min}+`
          : `${pick.gallon_min}-${pick.gallon_max}`);
    out.push({
      observed_at: pick.observed_at,
      company: pick.company ?? source,
      source,
      band_label: label,
      price_per_gallon: Number(pick.price_per_gallon),
      zip: pick.zip,
    });
  }
  return out;
}

/** Zips where the FJB blurb matched nothing this run. */
export interface FjbMiss {
  zip: string;
}

async function toBuffer(wb: ExcelJS.Workbook): Promise<string> {
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf).toString('base64');
}

export async function buildCashWorkbook(
  rows: CashRow[],
  misses: FjbMiss[],
): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('CashHeatingOil 100-149 cash');
  ws.columns = [
    { header: 'timestamp', key: 'timestamp', width: 26 },
    { header: 'zip', key: 'zip', width: 10 },
    { header: 'rank', key: 'rank', width: 7 },
    { header: 'price_per_gallon', key: 'price', width: 18 },
    { header: 'is_fjb', key: 'is_fjb', width: 10 },
    { header: 'dealer_id', key: 'dealer_id', width: 12 },
    { header: 'listing_position', key: 'pos', width: 18 },
    { header: 'note', key: 'note', width: 28 },
  ];
  ws.getRow(1).font = { bold: true };

  for (const r of rows) {
    const row = ws.addRow({
      timestamp: r.observed_at.toISOString(),
      // Text, not a number: 06010 loses its leading zero the moment Excel
      // decides it is numeric, and a wrong zip is worse than an ugly one.
      zip: String(r.zip),
      rank: r.rank,
      price: Number(r.price_per_gallon),
      is_fjb: r.is_fjb ? 'true' : 'false',
      dealer_id: r.dealer_id ?? '',
      pos: r.listing_position ?? '',
      note: r.extra ? 'FJB outside top N' : '',
    });
    row.getCell('price').numFmt = '0.000';
    row.getCell('zip').numFmt = '@';
    row.getCell('zip').alignment = { horizontal: 'left' };
    if (r.is_fjb) row.font = { bold: true };
  }

  // A missing FJB is recorded IN the file as well as alerted, so a file read
  // later on its own still says the tag failed rather than looking like FJB
  // was simply absent from that zip.
  if (misses.length > 0) {
    ws.addRow({});
    const head = ws.addRow({ zip: 'FJB NOT FOUND', note: 'blurb matched no listing' });
    head.font = { bold: true };
    for (const m of misses) ws.addRow({ zip: m.zip, note: 'FJB not found' });
  }
  return toBuffer(wb);
}

export async function buildOtherWorkbook(rows: CompanyRow[]): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Heating oil @150 gal');
  ws.columns = [
    { header: 'timestamp', key: 'timestamp', width: 26 },
    { header: 'company', key: 'company', width: 28 },
    { header: 'band_label', key: 'band', width: 20 },
    { header: 'price_per_gallon', key: 'price', width: 18 },
    { header: 'zip', key: 'zip', width: 10 },
  ];
  ws.getRow(1).font = { bold: true };
  for (const r of [...rows].sort((a, b) => a.price_per_gallon - b.price_per_gallon)) {
    const row = ws.addRow({
      timestamp: r.observed_at.toISOString(),
      company: r.company,
      band: r.band_label,
      price: r.price_per_gallon,
      zip: r.zip === null ? '' : String(r.zip),
    });
    row.getCell('price').numFmt = '0.000';
    row.getCell('zip').numFmt = '@';
  }
  return toBuffer(wb);
}

/**
 * Rank the cash 100-149 quotes within each zip and pick what the file shows:
 * the N cheapest, and FJB as an extra flagged row when it is not among them.
 */
export function selectCashRows(
  quotes: {
    observed_at: Date;
    zip: string;
    price_per_gallon: string | number;
    company: string | null;
    dealer_id: string | null;
    listing_position: number | null;
  }[],
  fjbCompany: string,
  topN: number,
): { rows: CashRow[]; zipsSeen: Set<string>; zipsWithFjb: Set<string> } {
  const byZip = new Map<string, typeof quotes>();
  for (const q of quotes) {
    const list = byZip.get(q.zip) ?? [];
    list.push(q);
    byZip.set(q.zip, list);
  }
  const rows: CashRow[] = [];
  const zipsWithFjb = new Set<string>();

  for (const [zip, list] of [...byZip.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    list.sort((a, b) => Number(a.price_per_gallon) - Number(b.price_per_gallon));
    const fjbIndex = list.findIndex((q) => q.company === fjbCompany);
    if (fjbIndex >= 0) zipsWithFjb.add(zip);

    list.slice(0, topN).forEach((q, i) => {
      rows.push({
        observed_at: q.observed_at,
        zip,
        rank: i + 1,
        price_per_gallon: Number(q.price_per_gallon),
        is_fjb: q.company === fjbCompany,
        dealer_id: q.dealer_id,
        listing_position: q.listing_position,
        extra: false,
      });
    });

    if (fjbIndex >= topN) {
      const q = list[fjbIndex]!;
      rows.push({
        observed_at: q.observed_at,
        zip,
        rank: fjbIndex + 1,
        price_per_gallon: Number(q.price_per_gallon),
        is_fjb: true,
        dealer_id: q.dealer_id,
        listing_position: q.listing_position,
        extra: true,
      });
    }
  }
  return { rows, zipsSeen: new Set(byZip.keys()), zipsWithFjb };
}

/**
 * What changed between two runs, in the ranked view this file is about.
 *
 * Compared by DEALER rather than by rank slot. Comparing slot-to-slot cannot
 * tell "the dealer in position 2 cut their price" from "a cheaper dealer
 * appeared and pushed everyone down" — the same slot shows a different number
 * either way. Tracking the dealer makes a price move, a re-ordering, and an
 * entry or exit three distinct, correctly-labelled events.
 */
export function diffTopRanks(previous: CashRow[], current: CashRow[]): string[] {
  const label = (r: { is_fjb: boolean }): string => (r.is_fjb ? 'FJB' : 'competitor');
  const money = (n: number): string => `$${n.toFixed(2)}`;
  const byZip = (rows: CashRow[]): Map<string, Map<string, CashRow>> => {
    const m = new Map<string, Map<string, CashRow>>();
    for (const r of rows.filter((x) => !x.extra)) {
      const inner = m.get(r.zip) ?? new Map<string, CashRow>();
      inner.set(r.dealer_id ?? `pos${r.listing_position ?? r.rank}`, r);
      m.set(r.zip, inner);
    }
    return m;
  };
  const prev = byZip(previous);
  const curr = byZip(current);
  const out: string[] = [];

  for (const zip of [...curr.keys()].sort()) {
    const p = prev.get(zip);
    const c = curr.get(zip)!;
    // No prior state for this zip at all: a first run, not a set of changes.
    if (!p || p.size === 0) continue;

    for (const [dealer, now] of c) {
      const was = p.get(dealer);
      if (!was) {
        out.push(
          `CashHeatingOil — entered top 3 at ${money(now.price_per_gallon)} · ${zip} · ` +
            `rank ${now.rank} · ${label(now)}`,
        );
        continue;
      }
      const delta = now.price_per_gallon - was.price_per_gallon;
      const moved = Math.abs(delta) > 0.0005;
      const reranked = was.rank !== now.rank;
      if (moved) {
        const sign = delta > 0 ? '+' : '-';
        out.push(
          `CashHeatingOil — ${money(was.price_per_gallon)} → ${money(now.price_per_gallon)} ` +
            `(${sign}${Math.abs(delta).toFixed(2)}) · ${zip} · rank ${now.rank} · ${label(now)}` +
            (reranked ? ` · rank ${was.rank} → ${now.rank}` : ''),
        );
      } else if (reranked) {
        out.push(
          `CashHeatingOil — ${money(now.price_per_gallon)} unchanged · ${zip} · ` +
            `rank ${was.rank} → ${now.rank} · ${label(now)}`,
        );
      }
    }

    for (const [dealer, was] of p) {
      if (c.has(dealer)) continue;
      out.push(
        `CashHeatingOil — left top 3 (was rank ${was.rank} at ${money(was.price_per_gallon)}) · ` +
          `${zip} · ${label(was)}`,
      );
    }
  }
  return out;
}

/**
 * Change lines for the non-listing sources, same one-line-per-change shape.
 * Keyed on source plus band, since a vendor publishes one price per band.
 */
export interface OtherQuote {
  source: string;
  company: string | null;
  band: string | null;
  price: number;
}

/** Change lines for the one-row-per-company view. */
export function diffCompanyRows(previous: CompanyRow[], current: CompanyRow[]): string[] {
  const prev = new Map(previous.map((r) => [r.source, r]));
  const out: string[] = [];
  for (const r of [...current].sort((a, b) => a.company.localeCompare(b.company))) {
    const p = prev.get(r.source);
    if (!p) {
      out.push(`${r.company} — new quote $${r.price_per_gallon.toFixed(2)} · ${r.band_label}`);
      continue;
    }
    const delta = r.price_per_gallon - p.price_per_gallon;
    if (Math.abs(delta) <= 0.0005) continue;
    const sign = delta > 0 ? '+' : '-';
    out.push(
      `${r.company} — $${p.price_per_gallon.toFixed(2)} → $${r.price_per_gallon.toFixed(2)} ` +
        `(${sign}${Math.abs(delta).toFixed(2)}) · ${r.band_label}`,
    );
  }
  for (const [source, p] of prev) {
    if (!current.some((c) => c.source === source)) {
      out.push(`${p.company} — no longer quoting (was $${p.price_per_gallon.toFixed(2)})`);
    }
  }
  return out;
}

export function diffOtherSources(
  previous: OtherQuote[],
  current: OtherQuote[],
): string[] {
  const key = (q: OtherQuote): string => `${q.source}|${q.band ?? ''}`;
  const prev = new Map(previous.map((q) => [key(q), q]));
  const out: string[] = [];
  for (const q of current) {
    const p = prev.get(key(q));
    const name = q.company ?? q.source;
    const band = q.band ? ` · ${q.band}gal` : '';
    if (!p) {
      out.push(`${name} — new quote $${q.price.toFixed(2)}${band}`);
      continue;
    }
    const delta = q.price - p.price;
    if (Math.abs(delta) <= 0.0005) continue;
    const sign = delta > 0 ? '+' : '-';
    out.push(
      `${name} — $${p.price.toFixed(2)} → $${q.price.toFixed(2)} ` +
        `(${sign}${Math.abs(delta).toFixed(2)})${band}`,
    );
  }
  return out;
}

/**
 * The two Excel exports.
 *
 * cashheatingoil.xlsx answers one question — "who is cheapest in each of my
 * zips, and where does FJB sit" — so it is deliberately narrow: the 100-149
 * gallon band, cash prices only, the top two dealers per zip, plus FJB's own
 * row whenever FJB is not already in that top two. Everything else from that
 * source is dropped.
 *
 * other-sources.xlsx keeps the original seven-column layout unchanged, because
 * it is the general-purpose dump and the narrowing above would destroy it.
 *
 * WHY FJB IS ALWAYS PRESENT. The point of the file is comparison against one
 * specific dealer. A file that silently omits FJB when it happens to be third
 * cheapest would answer "who is cheapest" while hiding the thing being asked
 * about, so FJB is appended with its true rank and flagged.
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
  /** True when this row is FJB appended outside the top two. */
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
      zip: r.zip,
      rank: r.rank,
      price: Number(r.price_per_gallon),
      is_fjb: r.is_fjb ? 'true' : 'false',
      dealer_id: r.dealer_id ?? '',
      pos: r.listing_position ?? '',
      note: r.extra ? 'FJB outside top 2' : '',
    });
    row.getCell('price').numFmt = '0.000';
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

export async function buildOtherWorkbook(rows: OtherRow[]): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Other sources');
  // The original CSV layout, column for column.
  ws.columns = [
    { header: 'timestamp', key: 'timestamp', width: 26 },
    { header: 'company', key: 'company', width: 26 },
    { header: 'source', key: 'source', width: 18 },
    { header: 'zip', key: 'zip', width: 10 },
    { header: 'gallon_band', key: 'band', width: 14 },
    { header: 'payment_type', key: 'payment_type', width: 14 },
    { header: 'price_per_gallon', key: 'price', width: 18 },
  ];
  ws.getRow(1).font = { bold: true };
  for (const r of rows) {
    const row = ws.addRow({
      timestamp: r.observed_at.toISOString(),
      company: r.company ?? '',
      source: r.source,
      zip: r.zip ?? '',
      band: r.band ?? '',
      payment_type: r.payment_type ?? '',
      price: Number(r.price_per_gallon),
    });
    row.getCell('price').numFmt = '0.000';
  }
  return toBuffer(wb);
}

/**
 * Rank the cash 100-149 quotes within each zip and pick what the file shows:
 * the two cheapest, and FJB as an extra flagged row when it is not among them.
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
 * What changed between two runs, comparing only the ranked positions this file
 * is about. A price that moved or a ranking that flipped is a change; anything
 * deeper in the list is not, because the file does not show it.
 */
export function diffTopRanks(
  previous: CashRow[],
  current: CashRow[],
): string[] {
  const key = (r: CashRow): string => `${r.zip}#${r.rank}`;
  const prev = new Map(previous.filter((r) => !r.extra).map((r) => [key(r), r]));
  const out: string[] = [];

  for (const r of current.filter((c) => !c.extra)) {
    const p = prev.get(key(r));
    const who = r.is_fjb ? 'FJB' : (r.dealer_id ?? 'unknown');
    if (!p) {
      out.push(`${r.zip} #${r.rank}: new — ${who} at $${r.price_per_gallon.toFixed(3)}`);
      continue;
    }
    const priceMoved = Math.abs(p.price_per_gallon - r.price_per_gallon) > 1e-9;
    const dealerChanged = (p.dealer_id ?? '') !== (r.dealer_id ?? '');
    if (priceMoved && dealerChanged) {
      out.push(
        `${r.zip} #${r.rank}: ${p.dealer_id ?? '?'} $${p.price_per_gallon.toFixed(3)} → ` +
          `${who} $${r.price_per_gallon.toFixed(3)} (ranking flipped)`,
      );
    } else if (dealerChanged) {
      out.push(`${r.zip} #${r.rank}: ranking flipped — ${p.dealer_id ?? '?'} → ${who}`);
    } else if (priceMoved) {
      const dir = r.price_per_gallon > p.price_per_gallon ? '↑' : '↓';
      out.push(
        `${r.zip} #${r.rank}: ${who} $${p.price_per_gallon.toFixed(3)} → ` +
          `$${r.price_per_gallon.toFixed(3)} ${dir}`,
      );
    }
  }
  return out;
}

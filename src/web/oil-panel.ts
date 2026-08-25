/**
 * Oil price dashboard panel.
 *
 * Two things side by side: what every source quotes right now, normalised to
 * one gallon quantity so the numbers actually mean the same thing, and the
 * recent history of the cheapest quote per source.
 *
 * Normalisation matters more than it looks. Vendors quote at different
 * minimums and in different gallon bands, so putting their headline numbers
 * next to each other unadjusted compares a 100-gallon price against a
 * 150-gallon one. The panel therefore shows only quotes whose band actually
 * covers the comparison quantity, and says which quantity that is.
 */

import type { PanelContext } from '../adapters/types.js';
import { escapeHtml } from './views.js';

interface CurrentRow {
  source: string;
  company: string | null;
  product: string;
  zip: string | null;
  city: string | null;
  payment_type: string | null;
  gallon_min: number | null;
  gallon_max: number | null;
  price_per_gallon: string | number;
  gallon_minimum: number | null;
  surcharge_note: string | null;
  price_date: Date | null;
  delivery_date: Date | null;
  dealer_id: string | null;
  observed_at: Date;
  dealers: number;
}

function n(v: string | number | null): number | null {
  if (v === null || v === undefined) return null;
  const p = typeof v === 'string' ? Number.parseFloat(v) : v;
  return Number.isFinite(p) ? p : null;
}

const usd = (v: number | null): string => (v === null ? '—' : `$${v.toFixed(2)}`);

function ago(d: Date | null): string {
  if (!d) return 'never';
  const s = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172_800) return `${(s / 3600).toFixed(1)}h ago`;
  return `${(s / 86_400).toFixed(1)}d ago`;
}

const day = (d: Date | null): string => (d ? d.toISOString().slice(0, 10) : '—');

export async function renderOilPanel(ctx: PanelContext): Promise<string> {
  const compareGallons =
    typeof ctx.options['compare_gallons'] === 'number' ? (ctx.options['compare_gallons'] as number) : 150;

  const [current, history, sources] = await Promise.all([
    // Cheapest quote per source/zip/payment type that actually covers the
    // comparison quantity, from the most recent scrape of each.
    ctx.db.query(
      `with latest as (
         select distinct on (coalesce(company, source), coalesce(zip,''), coalesce(payment_type,''), product)
                source, company, product, zip, city, payment_type, gallon_min, gallon_max,
                price_per_gallon, gallon_minimum, surcharge_note,
                price_date, delivery_date, dealer_id, observed_at
           from oil_observations
          where monitor_id = $1
            and (gallon_min is null
                 or (gallon_min <= $2 and (gallon_max is null or gallon_max >= $2)))
            and observed_at > now() - interval '2 days'
          order by coalesce(company, source), coalesce(zip,''), coalesce(payment_type,''), product,
                   observed_at desc, price_per_gallon asc
       ),
       dealer_counts as (
         select source, coalesce(zip,'') zk, count(distinct dealer_id) dealers
           from oil_observations
          where monitor_id = $1 and observed_at > now() - interval '1 day'
          group by 1, 2
       )
       select l.*, coalesce(d.dealers, 0)::int as dealers
         from latest l
         left join dealer_counts d on d.source = l.source and d.zk = coalesce(l.zip,'')
        order by l.product, l.price_per_gallon asc, coalesce(l.company, l.source)`,
      [ctx.monitorId, compareGallons],
    ),
    // History: cheapest covering quote per source per day, plus any vendor
    // published history, unioned so a backfilled table shows up here too.
    ctx.db.query(
      `select price_date::date as d, source, min(price_per_gallon) p
         from oil_price_history
        where monitor_id = $1 and price_date > now() - ($2 || ' days')::interval
        group by 1,2
       union all
       select date_trunc('day', observed_at)::date as d, coalesce(company, source) as source,
              min(price_per_gallon) p
         from oil_observations
        where monitor_id = $1 and observed_at > now() - ($2 || ' days')::interval
          and product = 'fuel_oil'
          and (gallon_min is null
               or (gallon_min <= $3 and (gallon_max is null or gallon_max >= $3)))
        group by 1,2
        order by d desc, source`,
      [ctx.monitorId, 30, compareGallons],
    ),
    ctx.db.query(
      `select source, consecutive_failures, last_ok_at, last_error, backfilled_at
         from oil_source_state where monitor_id = $1 order by source`,
      [ctx.monitorId],
    ),
  ]);

  const rows = current.rows as CurrentRow[];
  const header =
    `<h2 class="section">${escapeHtml(ctx.monitorName)}</h2>` +
    `<p class="panel-meta">Prices normalised to <strong>${compareGallons} gallons</strong> — only quotes whose ` +
    `band covers that quantity are shown, so the columns are directly comparable. ` +
    `Every gallon band from every dealer is stored in full; this is the comparison view.</p>`;

  const broken = (sources.rows as { source: string; consecutive_failures: number; last_error: string | null }[])
    .filter((s) => s.consecutive_failures > 0);
  const brokenBanner = broken.length
    ? `<p class="error">${broken
        .map(
          (s) =>
            `<strong>${escapeHtml(s.source)}</strong> has failed ${s.consecutive_failures} ` +
            `consecutive scrape${s.consecutive_failures === 1 ? '' : 's'}: ${escapeHtml((s.last_error ?? '').slice(0, 200))}`,
        )
        .join('<br>')}</p>`
    : '';

  if (rows.length === 0) {
    return (
      header +
      brokenBanner +
      `<p class="empty">No prices stored yet at ${compareGallons} gallons. The first scrape runs at the next tick.</p>`
    );
  }

  const cards = rows
    .map((r) => {
      const where = r.zip ? `${r.city ?? ''} ${r.zip}`.trim() : '';
      const pay = r.payment_type ? ` · ${r.payment_type}` : '';
      const band =
        r.gallon_min !== null
          ? `${r.gallon_min}${r.gallon_max ? `–${r.gallon_max}` : '+'} gal band`
          : r.gallon_minimum
            ? `${r.gallon_minimum} gal minimum`
            : '';
      return (
        `<article class="card"><h3>${escapeHtml(r.company ?? r.source)}${escapeHtml(pay)}` +
        `${r.product !== 'fuel_oil' ? ` <span style="opacity:.6">${escapeHtml(r.product)}</span>` : ''}</h3>` +
        `<p class="big">${usd(n(r.price_per_gallon))}<span style="font-size:13px;font-weight:400"> /gal</span></p>` +
        `<p class="panel-meta">${escapeHtml(where || r.source)}</p>` +
        `<p class="panel-meta">` +
        [
          band && where ? escapeHtml(band) : '',
          r.dealers > 1 ? `${r.dealers} dealers listed` : '',
          r.price_date ? `priced ${day(r.price_date)}` : '',
          r.delivery_date ? `delivery ${day(r.delivery_date)}` : '',
          `checked ${ago(r.observed_at)}`,
        ]
          .filter(Boolean)
          .join(' · ') +
        `</p>` +
        (r.surcharge_note ? `<p class="panel-meta"><em>${escapeHtml(r.surcharge_note)}</em></p>` : '') +
        `</article>`
      );
    })
    .join('');

  // History pivot: one row per day, one column per source.
  const hist = history.rows as { d: Date; source: string; p: string | number }[];
  const bySource = [...new Set(hist.map((h) => h.source))].sort();
  const byDay = new Map<string, Map<string, number>>();
  for (const h of hist) {
    const k = day(h.d);
    const m = byDay.get(k) ?? new Map<string, number>();
    const price = n(h.p);
    const existing = m.get(h.source);
    if (price !== null && (existing === undefined || price < existing)) m.set(h.source, price);
    byDay.set(k, m);
  }
  const days = [...byDay.keys()].sort().reverse().slice(0, 30);

  const historyTable = days.length
    ? `<div class="table-wrap"><table class="tokens" style="min-width:420px">` +
      `<thead><tr><th>Date</th>${bySource.map((s) => `<th>${escapeHtml(s)}</th>`).join('')}</tr></thead><tbody>` +
      days
        .map((d) => {
          const m = byDay.get(d)!;
          return (
            `<tr><td>${escapeHtml(d)}</td>` +
            bySource
              .map((s) => {
                const v = m.get(s);
                return `<td>${v === undefined ? '—' : usd(v)}</td>`;
              })
              .join('') +
            `</tr>`
          );
        })
        .join('') +
      `</tbody></table></div>`
    : '';

  const backfilled = (sources.rows as { source: string; backfilled_at: Date | null }[]).filter(
    (s) => s.backfilled_at,
  );

  return (
    header +
    brokenBanner +
    `<div class="cards stats">${cards}</div>` +
    `<p class="panel-meta" style="margin-top:18px">Cheapest covering quote per source per day, last 30 days` +
    (backfilled.length
      ? ` · includes vendor-published history backfilled from ${backfilled.map((b) => escapeHtml(b.source)).join(', ')}`
      : '') +
    `</p>` +
    historyTable
  );
}

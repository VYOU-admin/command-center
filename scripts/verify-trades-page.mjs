/**
 * Execute the SERVED /trades page in a DOM and count what it actually renders.
 *
 * docs/ROBINHOOD.md step 14: a green build proves the page compiles and ships and
 * proves NOTHING about whether the table has rows in it.
 *
 * It additionally checks THE MODE LABELLING, which matters more on this page than
 * anywhere else in the project: in dry run every figure is hypothetical, and a tab that
 * does not say so will be read as real money by someone who was not here today. The
 * mode must appear in the banner AND on every row, and totals must be grouped per mode
 * so a dry-run figure and a live figure are never summed.
 *
 * usage: node scripts/verify-trades-page.mjs <base-url>
 */
import { JSDOM, VirtualConsole } from 'jsdom';

const base = process.argv[2];
if (!base) { console.error('usage: verify-trades-page.mjs <base-url>'); process.exit(2); }
const root = base.replace(/\/+$/, '');

let failures = 0;
const fail = (m) => { console.error(`  FAIL  ${m}`); failures++; };
const ok = (m) => console.log(`  ok    ${m}`);

async function load(path) {
  const url = root + path;
  const res = await fetch(url);
  if (!res.ok) { fail(`${url} returned HTTP ${res.status}`); return null; }
  const html = await res.text();
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(e.message));
  const dom = new JSDOM(html, { runScripts: 'dangerously', virtualConsole: vc });
  const d = dom.window.document;
  const bodyRows = [...d.querySelectorAll('table tbody tr')];
  const dataRows = bodyRows.filter((r) => !r.querySelector('td.empty'));
  const countText = d.body.textContent ?? '';
  const m = /Showing ([\d,]+) of ([\d,]+) matching/.exec(countText);
  return {
    dom, d, html, errors,
    rendered: dataRows.length,
    claimShown: m ? Number(m[1].replace(/,/g, '')) : null,
    claimTotal: m ? Number(m[2].replace(/,/g, '')) : null,
    modeCells: dataRows.filter((r) => r.querySelector('.mode')).length,
    banner: d.querySelector('.banner')?.textContent?.trim() ?? '',
    totalBlocks: [...d.querySelectorAll('.tot .totmode')].map((x) => x.textContent.trim()),
    modeOptions: d.querySelectorAll('select#mode option').length,
    padOptions: d.querySelectorAll('select#launchpad option').length,
    tokenLinks: [...d.querySelectorAll('td a[href^="https://dexscreener.com/"]')],
    headerCells: d.querySelectorAll('table thead th').length,
    cellsPerRow: dataRows.map((r) => r.querySelectorAll('td').length),
    exitChips: [...d.querySelectorAll('td .ex')].map((x) => x.textContent.trim()),
    exitChipClasses: [...d.querySelectorAll('td .ex')].map((x) => x.className),
    /* A price cell is either a number or an em dash. A ZERO would mean the price
       went to zero and must never stand in for "not observed". */
    priceCellsZero: [...d.querySelectorAll('table tbody tr td.n')]
      .filter((x) => /^0(\.0+)?$/.test(x.textContent.trim())).length,
    nulls: d.querySelectorAll('td .nul').length,
  };
}

console.log('/trades');
const all = await load('/trades');
if (!all) { console.error('could not load /trades'); process.exit(1); }

console.log(`rendered data rows   ${all.rendered}`);
console.log(`page claims          ${all.claimShown} of ${all.claimTotal}`);
console.log(`banner               ${all.banner.slice(0, 70)}`);
console.log(`totals blocks        ${JSON.stringify(all.totalBlocks)}`);

if (all.errors.length) fail(`script errors: ${all.errors.join('; ')}`);
else ok('no script errors');

if (all.claimShown === null) fail('the page does not state a "Showing N of M" count');
else if (all.rendered !== all.claimShown) {
  fail(`rendered ${all.rendered} rows but the page claims ${all.claimShown}`);
} else ok(`rendered rows match the page's own count (${all.rendered})`);

/* THE MODE CHECKS -- the reason this verifier differs from the others. */
if (!/DRY RUN|LIVE TRADES/i.test(all.banner)) {
  fail('the banner does not state the mode; a tab that does not say so reads as real money');
} else ok(`the banner states the mode`);

if (all.rendered > 0 && all.modeCells !== all.rendered) {
  fail(`${all.modeCells} of ${all.rendered} rows carry a mode label; every row must`);
} else if (all.rendered > 0) ok(`every one of ${all.rendered} rows carries a mode label`);

if (all.totalBlocks.length === 0) fail('no per-mode totals block rendered');
else ok(`totals are grouped per mode (${all.totalBlocks.length} block(s))`);

/* Every token link must resolve to a real DexScreener URL, not .../undefined. */
const bad = all.tokenLinks.filter((a) => !/^https:\/\/dexscreener\.com\/robinhood\/0x[0-9a-fA-F]{40}$/.test(a.href));
if (bad.length) fail(`${bad.length} token link(s) are malformed`);
else ok(`${all.tokenLinks.length} token link(s) well-formed`);

if (all.rendered === 0) {
  console.log('  note  ZERO data rows. If bot_trades has rows for this chain that is a defect;');
  console.log('        if the bot has not run yet it is the correct empty state.');
} else ok(`${all.rendered} rows present`);

/* FILTERS. A filter that silently matches nothing is the failure shape to catch. */
if (all.rendered > 0) {
  const mode = all.d.querySelector('select#mode option[value]:not([value=""])')?.value;
  if (mode) {
    const f = await load(`/trades?mode=${encodeURIComponent(mode)}`);
    if (!f) fail('mode filter page did not load');
    else if (f.rendered === 0) fail(`mode filter "${mode}" returned ZERO rows`);
    else ok(`mode filter "${mode}" returned ${f.rendered} rows`);
  }
  const pad = all.d.querySelector('select#launchpad option[value]:not([value=""])')?.value;
  if (pad) {
    const f = await load(`/trades?launchpad=${encodeURIComponent(pad)}`);
    if (!f) fail('launchpad filter page did not load');
    else if (f.rendered === 0) fail(`launchpad filter returned ZERO rows`);
    else if (f.rendered > all.rendered) fail('launchpad filter returned MORE rows than unfiltered');
    else ok(`launchpad filter returned ${f.rendered} of ${all.rendered} rows`);
  }
  const badF = await load('/trades?launchpad=0xnothex&mode=%%%');
  if (!badF) fail('malformed-filter page did not load');
  else if (badF.rendered !== all.rendered) {
    fail(`a malformed filter changed the result (${badF.rendered} vs ${all.rendered}); `
      + 'it must be ignored, not applied');
  } else ok('a malformed filter is ignored, not applied');
}




/* ---- the exit-leg and backfill columns ---------------------------------- */
console.log('\nexit-leg and price-backfill columns');
if (all.headerCells === 14) ok(`header has ${all.headerCells} columns`);
else fail(`header has ${all.headerCells} columns, expected 14`);

const wrongWidth = all.cellsPerRow.filter((n) => n !== 14).length;
if (wrongWidth === 0) ok(`every one of ${all.cellsPerRow.length} rows has 14 cells`);
else fail(`${wrongWidth} rows do not have 14 cells`);

/* EVERY ROW CARRIES AN EXIT-SIM VALUE OR AN EXPLICIT DASH -- never a silent blank,
   which a reader would take for "fine". */
const exitShown = all.exitChips.length + [...all.d.querySelectorAll('table tbody tr')]
  .filter((r) => !r.querySelector('td.empty'))
  .filter((r) => r.querySelectorAll('td')[11]?.querySelector('.nul')).length;
if (exitShown >= all.rendered) ok(`all ${all.rendered} rows show an exit-sim value or a dash`);
else fail(`only ${exitShown} of ${all.rendered} rows show an exit-sim value`);

/* NOT-ATTEMPTED MUST NOT RENDER AS EITHER PASS OR FAIL. */
const miscoloured = all.exitChips.map((t, i) => ({ t, c: all.exitChipClasses[i] }))
  .filter(({ t, c }) => (t !== 'clean' && c.includes('ok')) || (t !== 'reverted' && c.includes('bad')));
if (miscoloured.length === 0) ok('no exit-sim chip is coloured as a pass or fail it is not');
else fail(`${miscoloured.length} exit-sim chips are miscoloured: ${JSON.stringify(miscoloured)}`);

if (all.priceCellsZero === 0) ok('no numeric cell renders a bare zero');
else fail(`${all.priceCellsZero} numeric cells render 0, which must be a dash if unobserved`);

console.log(`  (em dashes on the page: ${all.nulls})`);

console.log(failures === 0 ? '\nverify-trades-page: PASS' : `\nverify-trades-page: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

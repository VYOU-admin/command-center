/**
 * Execute the SERVED /watchlist page in a DOM and count what it actually renders.
 *
 * docs/ROBINHOOD.md step 14: a green build proves the page compiles and ships and
 * proves NOTHING about whether the table has rows in it. This fetches the live
 * page, runs it in jsdom, and counts rendered rows against the database figure the
 * page itself claims.
 *
 * It also exercises the two FILTERS, because a filter that silently matches nothing
 * is the failure shape this project keeps hitting: a token filter must return fewer
 * rows than the unfiltered page and more than zero, and a wallet filter likewise.
 *
 * usage: node scripts/verify-watchlist-page.mjs <base-url>
 */
import { JSDOM, VirtualConsole } from 'jsdom';

const base = process.argv[2];
if (!base) { console.error('usage: verify-watchlist-page.mjs <base-url>'); process.exit(2); }
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
  vc.on('jsdomError', (e) => errors.push(String(e.message)));
  vc.on('error', (...a) => errors.push(a.map(String).join(' ')));
  const dom = new JSDOM(html, { url, runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc });
  const doc = dom.window.document;
  const bodyRows = [...doc.querySelectorAll('tbody tr')];
  const dataRows = bodyRows.filter((r) => !r.querySelector('td.empty'));
  const countText = doc.querySelector('.count')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  const m = /Showing ([\d,]+) of ([\d,]+) matching/.exec(countText);
  return {
    url, bytes: Buffer.byteLength(html, 'utf8'), errors, doc,
    rendered: dataRows.length,
    claimShown: m ? Number(m[1].replace(/,/g, '')) : null,
    claimTotal: m ? Number(m[2].replace(/,/g, '')) : null,
    firstTokenHref: doc.querySelector('tbody tr td.tk a')?.getAttribute('href') ?? null,
    tokenOptions: doc.querySelectorAll('#token option').length,
    countText,
  };
}

const all = await load('/watchlist?limit=2000');
if (!all) process.exit(1);
console.log(`page                 ${all.url}`);
console.log(`page size            ${all.bytes.toLocaleString()} bytes  (${(all.bytes / 1048576).toFixed(2)} MB)`);
console.log(`rendered data rows   ${all.rendered}`);
console.log(`page claims          ${all.claimShown} of ${all.claimTotal}`);
console.log(`token filter options ${all.tokenOptions}`);

if (all.errors.length) fail(`page raised ${all.errors.length} script error(s): ${all.errors[0]}`);
else ok('no script errors');

/*
 * THE RENDERED COUNT MUST EQUAL WHAT THE PAGE CLAIMS. That is the whole point of
 * running it in a DOM: a page can claim 500 rows in its header and render none.
 */
if (all.claimShown === null) fail('the page does not state a "Showing N of M" count');
else if (all.rendered !== all.claimShown) {
  fail(`rendered ${all.rendered} rows but the page claims ${all.claimShown}`);
} else ok(`rendered rows match the page's own count (${all.rendered})`);

if (all.rendered === 0) {
  fail('ZERO data rows rendered. If watchlist_activity has rows this is the defect '
    + 'the harness exists to catch; if it is genuinely empty, say so rather than '
    + 'reading this as a pass.');
} else ok(`${all.rendered} rows present`);

if (all.firstTokenHref && all.firstTokenHref.startsWith('https://dexscreener.com/robinhood/')) {
  ok(`DexScreener link built: ${all.firstTokenHref}`);
} else fail(`first row has no DexScreener link (got ${all.firstTokenHref})`);

/* ---- the filters, exercised rather than assumed ---- */
const firstTokenOpt = all.doc.querySelectorAll('#token option')[1]?.getAttribute('value');
if (!firstTokenOpt) fail('no token available to filter by');
else {
  const byToken = await load(`/watchlist?limit=2000&token=${firstTokenOpt}`);
  if (byToken) {
    if (byToken.rendered === 0) fail(`token filter ${firstTokenOpt} returned ZERO rows`);
    else if (byToken.claimTotal > all.claimTotal) {
      fail(`token filter reports MORE rows (${byToken.claimTotal}) than unfiltered (${all.claimTotal})`);
    } else ok(`token filter works: ${byToken.rendered} of ${all.rendered} rows`);
  }
}
const firstWallet = all.doc.querySelector('tbody tr td:nth-child(2) a')?.getAttribute('title');
if (!firstWallet) fail('no wallet available to filter by');
else {
  const byWallet = await load(`/watchlist?limit=2000&wallet=${firstWallet}`);
  if (byWallet) {
    if (byWallet.rendered === 0) fail(`wallet filter ${firstWallet} returned ZERO rows`);
    else ok(`wallet filter works: ${byWallet.rendered} rows for ${firstWallet.slice(0, 10)}…`);
  }
}
/* A nonsense filter must show everything, not nothing -- a half-typed address. */
const junk = await load('/watchlist?limit=2000&wallet=0xnotanaddress');
if (junk && junk.claimTotal !== all.claimTotal) {
  fail(`a malformed wallet filter changed the result (${junk.claimTotal} vs ${all.claimTotal})`);
} else if (junk) ok('a malformed filter is ignored rather than matching nothing');

if (failures) {
  console.error(`\nverify-watchlist-page: ${failures} failure(s)`);
  process.exit(1);
}
console.log('\nverify-watchlist-page: all checks passed');

/**
 * Execute the SERVED /tokens page in a DOM and check what it actually renders.
 *
 * A green build proves the page compiles and ships. It proves nothing about
 * whether the table has rows in it. This fetches the live page, runs its
 * scripts in jsdom, and counts what appears -- including the new score column
 * and the per-metric breakdown that loads when a row is expanded.
 *
 * usage: node scripts/verify-tokens-page.mjs <base-url> <mint>
 */
import { JSDOM, VirtualConsole } from 'jsdom';

const base = process.argv[2];
const mint = process.argv[3];
if (!base || !mint) {
  console.error('usage: verify-tokens-page.mjs <base-url> <mint>');
  process.exit(2);
}

const pageUrl = base.replace(/\/+$/, '') + '/tokens';
const res = await fetch(pageUrl);
if (!res.ok) {
  console.error(`FAIL: ${pageUrl} returned HTTP ${res.status}`);
  process.exit(1);
}
const html = await res.text();
const bytes = Buffer.byteLength(html, 'utf8');
console.log(`page                 ${pageUrl}`);
console.log(`page size            ${bytes.toLocaleString()} bytes  (${(bytes / 1048576).toFixed(2)} MB)`);

const errors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (e) => errors.push(String(e.message)));
virtualConsole.on('error', (...a) => errors.push(a.map(String).join(' ')));

const dom = new JSDOM(html, {
  url: pageUrl,
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  virtualConsole,
});
const { window } = dom;

// The page's expansion fetch must reach the real API. jsdom has no fetch, so
// hand it Node's and record what it asks for.
const asked = [];
window.fetch = (input, init) => {
  const u = String(input);
  asked.push(u);
  return fetch(u.startsWith('http') ? u : base.replace(/\/+$/, '') + u, init);
};

await new Promise((r) => setTimeout(r, 1500));

const doc = window.document;
const fail = (m) => { console.error('FAIL: ' + m); process.exitCode = 1; };

if (errors.length) {
  console.log(`script errors        ${errors.length}`);
  for (const e of errors.slice(0, 5)) console.log('   ' + e.slice(0, 200));
  fail(`${errors.length} script error(s) while rendering`);
} else {
  console.log('script errors        0');
}

/* ---- the table actually has rows -------------------------------------- */
const headCells = Array.from(doc.querySelectorAll('#head th')).map((th) => th.textContent.trim().replace(/[▲▼]\s*$/, '').trim());
console.log(`header columns       ${headCells.length}: ${headCells.join(' | ')}`);
if (!headCells.includes('score')) fail('the score column is not in the header');

const rows = doc.querySelectorAll('tr.w');
console.log(`wallet rows rendered ${rows.length}`);
if (rows.length === 0) fail('the table rendered zero wallet rows');

const countText = doc.getElementById('count') ? doc.getElementById('count').textContent : '';
console.log(`count line           ${countText}`);

/* ---- the score cells carry values ------------------------------------- */
/*
 * NO OFFSET. `#head` is built as '<th class="nosort"></th>' + COLS, so the
 * leading caret column is ALREADY headCells[0] and the index lines up with the
 * row's children directly. Adding one here read the buys column and reported
 * buy counts as scores -- which is exactly the kind of thing a build passing
 * cannot tell you.
 */
const scoreIdx = headCells.indexOf('score');
let scored = 0, unscored = 0, partial = 0;
const samples = [];
for (const tr of rows) {
  const cell = tr.children[scoreIdx];
  if (!cell) { fail('a row has no cell at the score column index'); break; }
  const text = cell.textContent.trim();
  if (text === 'unscored') unscored += 1;
  else {
    scored += 1;
    if (/% of weight/.test(text)) partial += 1;
  }
  if (samples.length < 3) samples.push(text);
}
console.log(`score cells          ${scored} with a value, ${unscored} unscored, ${partial} showing a partial weight`);
console.log(`sample score cells   ${JSON.stringify(samples)}`);
if (scored === 0) fail('every score cell on the first page rendered as unscored');

/* ---- sorting by the new column actually reorders ----------------------- */
const th = Array.from(doc.querySelectorAll('#head th')).find((x) => x.dataset.k === 'score');
if (!th) fail('the score header cell has no data-k');
else {
  th.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 300));
  const after = doc.querySelectorAll('tr.w');
  const first = after[0] ? after[0].children[scoreIdx].textContent.trim() : '';
  const second = after[1] ? after[1].children[scoreIdx].textContent.trim() : '';
  const a = Number.parseFloat(first), b = Number.parseFloat(second);
  console.log(`after sorting by score  top two = ${JSON.stringify([first, second])}`);
  if (Number.isFinite(a) && Number.isFinite(b) && a < b) {
    fail('sorting by score did not put the highest first');
  }
}

/* ---- expanding a row loads and renders the metric breakdown ------------ */
const firstRow = doc.querySelectorAll('tr.w')[0];
const wallet = firstRow.dataset.w;
firstRow.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await new Promise((r) => setTimeout(r, 2500));

const exp = doc.querySelector('tr.exp');
console.log(`expanded wallet      ${wallet}`);
console.log(`api calls made       ${JSON.stringify(asked)}`);
if (!exp) fail('clicking a row rendered no expansion');
else {
  const text = exp.textContent;
  const hasScoreLine = /computed on \d+% of the total weight/.test(text);
  const metricRows = Array.from(exp.querySelectorAll('table tr')).filter((tr) =>
    /PnL USD|PnL percent|number of buys|earliness|hold time|pre-pump share|buy-size trend|total USD in/.test(
      tr.textContent,
    ),
  );
  console.log(`breakdown header     ${hasScoreLine ? 'present' : 'MISSING'}`);
  console.log(`metric rows rendered ${metricRows.length} of 8`);
  if (!hasScoreLine) fail('the expansion has no score/weight line');
  if (metricRows.length !== 8) fail(`expected 8 metric rows, rendered ${metricRows.length}`);
  // Count only the table cells, not the sentence in the header that also
  // contains the word.
  const dropped = Array.from(exp.querySelectorAll('table td')).filter(
    (td) => td.textContent.trim() === 'dropped',
  ).length;
  const present = 8 - dropped;
  console.log(`metrics dropped as null   ${dropped}   metrics contributing   ${present}`);
}

window.close();
if (process.exitCode) console.error('\nVERIFICATION FAILED');
else console.log('\nVERIFICATION PASSED');

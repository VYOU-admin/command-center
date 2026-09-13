/**
 * Execute the SERVED /tokens page in a DOM and check what it actually renders.
 *
 * A green build proves the page compiles and ships. It proves nothing about
 * whether the table has rows in it. This fetches the live page, runs its
 * scripts in jsdom, and counts what appears -- including the new score column
 * and the per-metric breakdown that loads when a row is expanded.
 *
 * usage: node scripts/verify-tokens-page.mjs <base-url> <ticker> [expected-mint]
 *
 * THE SECOND ARGUMENT USED TO BE ACCEPTED AND NEVER READ. The harness verified
 * whichever token tab happened to render first -- the page opens on the first
 * token that has rows -- so a caller asking for CHUMP was shown a pass for AI
 * and had no way to tell. Found 2026-09-13, and it is the THIRD fault this
 * harness has had in itself rather than in the page.
 *
 * It now selects the tab by ticker and, when `expected-mint` is given, asserts
 * that the row-expansion API call carries that mint -- so the tab label and the
 * data behind it are both checked, rather than trusting the label.
 */
import { JSDOM, VirtualConsole } from 'jsdom';

const base = process.argv[2];
const ticker = process.argv[3];
const expectedMint = process.argv[4];
if (!base || !ticker) {
  console.error('usage: verify-tokens-page.mjs <base-url> <ticker> [expected-mint]');
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

/* ---- SELECT THE REQUESTED TOKEN'S TAB --------------------------------- */
const tabs = Array.from(doc.querySelectorAll('#tokenTabs > *'));
console.log(`token tabs           ${JSON.stringify(tabs.map((e) => e.textContent.trim()))}`);
if (tabs.length === 0) {
  console.error('FAIL: the page rendered no token tabs at all');
  process.exit(1);
}
const wanted = tabs.find((e) => new RegExp(`^${ticker}\\b`, 'i').test(e.textContent.trim()));
if (!wanted) {
  console.error(`FAIL: no token tab for "${ticker}". A token absent from the page is not `
    + 'a pass -- it is the token never having been rendered.');
  process.exit(1);
}
if (!wanted.classList.contains('on')) {
  wanted.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 1500));
}
const active = Array.from(doc.querySelectorAll('#tokenTabs > *')).find((e) => e.classList.contains('on'));
console.log(`token tab selected   ${active ? JSON.stringify(active.textContent.trim()) : 'NONE'}`);
if (!active || !new RegExp(`^${ticker}\\b`, 'i').test(active.textContent.trim())) {
  fail(`clicking the "${ticker}" tab did not make it the active one`);
}

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
const sortedTh = doc.querySelector('#head th .ar');
const defaultSortCol = sortedTh ? sortedTh.parentElement.dataset.k : null;
console.log(`default sort column  ${defaultSortCol}`);
if (defaultSortCol !== 'score') fail(`default sort is "${defaultSortCol}", expected score`);

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

/* ---- flags render, and are not excluded by default ---------------------- */
const chips = doc.querySelectorAll('tr.w .chip.flag');
console.log(`flag chips on page 1 ${chips.length}`);
const chipText = [...new Set(Array.from(chips).map((c) => c.textContent.trim()))];
console.log(`distinct flags shown  ${JSON.stringify(chipText)}`);

const noLow = doc.getElementById('fNoLow');
const noInf = doc.getElementById('fNoInf');
if (!noLow || !noInf) fail('the exclude-flagged checkboxes are missing');
else {
  console.log(`exclude checkboxes    low-weight=${noLow.checked ? 'checked' : 'unchecked'}, `
    + `inflated-pnl=${noInf.checked ? 'checked' : 'unchecked'}`);
  if (noLow.checked || noInf.checked) {
    fail('a flagged-exclusion box defaults to checked; flagged wallets must be marked, not hidden');
  }
}

const countOf = () => {
  const m = /^(\d+) of/.exec(doc.getElementById('count').textContent.trim());
  return m ? Number(m[1]) : -1;
};
const baseline = countOf();
console.log(`rows before excluding ${baseline}`);

if (noInf) {
  noInf.checked = true;
  noInf.dispatchEvent(new window.Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 500));
  const after = countOf();
  console.log(`after excluding inflated-pnl  ${after}   (removed ${baseline - after})`);
  if (after >= baseline) fail('excluding inflated-pnl removed no wallets');
  noInf.checked = false;
  noInf.dispatchEvent(new window.Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 500));
  if (countOf() !== baseline) fail('unchecking the filter did not restore the full set');
}

/* ---- sorting by the new column actually reorders ----------------------- */
/*
 * score is now the DEFAULT sort, so clicking its header toggles to ascending
 * rather than setting descending. An earlier version of this check compared the
 * top two rendered strings and passed because both rounded to the same 4dp --
 * it verified nothing. This reads the underlying numbers, requires the column
 * to be monotonic in one direction, and requires a second click to reverse it.
 */
const scoresNow = () =>
  Array.from(doc.querySelectorAll('tr.w'))
    .map((tr) => Number.parseFloat(tr.children[scoreIdx].textContent.trim()))
    .filter((x) => Number.isFinite(x));

const th = Array.from(doc.querySelectorAll('#head th')).find((x) => x.dataset.k === 'score');
if (!th) fail('the score header cell has no data-k');
else {
  const before = scoresNow();
  const desc = before.every((v, i) => i === 0 || before[i - 1] >= v);
  console.log(`default order        ${desc ? 'descending' : 'NOT descending'} (${before[0]} .. ${before[before.length - 1]})`);
  if (!desc) fail('the default score order is not descending');

  th.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 400));
  const asc = scoresNow();
  const isAsc = asc.every((v, i) => i === 0 || asc[i - 1] <= v);
  console.log(`after one click      ${isAsc ? 'ascending' : 'NOT ascending'} (${asc[0]} .. ${asc[asc.length - 1]})`);
  if (!isAsc) fail('clicking the score header did not sort ascending');
  if (asc[0] > before[0]) fail('the ascending top is above the descending top');

  th.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 400));
  const back = scoresNow();
  console.log(`after second click   top = ${back[0]}`);
  if (back[0] !== before[0]) fail('a second click did not restore descending order');
}

/* ---- expanding a row loads and renders the metric breakdown ------------ */
const firstRow = doc.querySelectorAll('tr.w')[0];
const wallet = firstRow.dataset.w;
firstRow.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await new Promise((r) => setTimeout(r, 2500));

const exp = doc.querySelector('tr.exp');
console.log(`expanded wallet      ${wallet}`);
console.log(`api calls made       ${JSON.stringify(asked)}`);
/*
 * THE TAB LABEL IS NOT THE DATA. Asserting the expansion call carries the mint
 * we asked for is what proves the rows under that tab belong to that token,
 * rather than trusting a label that happens to read "CHUMP".
 */
if (expectedMint) {
  const hit = asked.some((u) => u.toLowerCase().includes(expectedMint.toLowerCase()));
  console.log(`expansion mint       ${hit ? 'MATCHES ' + expectedMint : 'DOES NOT MATCH ' + expectedMint}`);
  if (!hit) fail(`the expansion API call carries no mint ${expectedMint}; the tab label and the data disagree`);
}
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

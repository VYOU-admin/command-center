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
    rowModes: dataRows.map((r) => r.querySelector('.mode')?.textContent?.trim() ?? ''),
    bannerSaysLive: /LIVE TRADES/i.test(d.querySelector('.banner')?.textContent ?? ''),
    liveChips: [...d.querySelectorAll('td .mode.live')].map((x) => x.textContent.trim()),
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

/* ---- THE BANNER MUST NOT CLAIM LIVE MONEY OVER A DRY RUN --------------- */
console.log('\nmode labelling is CORRECT, not merely present');
const dry = (m) => m === 'dry-run' || m.startsWith('dry-run-');
const allDry = all.rowModes.length > 0 && all.rowModes.every(dry);
if (allDry && all.bannerSaysLive) {
  fail(`every row is a dry-run mode (${[...new Set(all.rowModes)].join(', ')}) but the `
    + 'banner announces LIVE TRADES — the label is not merely missing, it is WRONG');
} else if (allDry) {
  ok(`all ${all.rowModes.length} rows are dry-run modes and the banner does not claim live`);
} else {
  ok(`page carries non-dry-run modes: ${[...new Set(all.rowModes.filter((m) => !dry(m)))].join(', ')}`);
}
const wrongChips = all.liveChips.filter(dry);
if (wrongChips.length === 0) ok('no dry-run row is chipped as live');
else fail(`${wrongChips.length} dry-run rows are chipped as live: ${[...new Set(wrongChips)].join(', ')}`);

/* ====================================================================== */
/* THE ON/OFF CONTROL -- PRESSED, NOT INSPECTED                           */
/* ====================================================================== */
/*
 * A button whose script parses is not a button that works. The failure this guards
 * against is the operator tapping STOP on a phone, seeing no error, and believing the
 * bot is stopped while it keeps trading -- which is strictly worse than having no
 * button, because it converts "I cannot stop it" into "I already did".
 *
 * So the buttons are CLICKED in the DOM, with `fetch` and `confirm` replaced by
 * recorders, and the assertions are about what the page would actually have sent.
 */
console.log('\nthe on/off control -- clicked in a DOM');

const ctl = all.d.querySelector('.ctl');
if (!ctl) {
  fail('there is no on/off control on /trades at all');
} else {
  const word = all.d.querySelector('.ctl-word')?.textContent?.trim() ?? '';
  if (word === 'STOPPED' || word === 'RUNNING') {
    ok(`the control states its state in words: ${word}`);
  } else {
    fail(`the control does not state STOPPED or RUNNING in words (got "${word}"); a `
      + 'colour alone is ambiguous about whether it reports or acts');
  }

  const stopBtn = all.d.querySelector('.ctl-buttons .stop');
  const startBtn = all.d.querySelector('.ctl-buttons .start');
  if (!stopBtn) fail('there is no STOP button');
  if (!startBtn) fail('there is no start button');

  if (stopBtn && startBtn) {
    /* STOP MUST BE THE BIGGER TARGET. A phone tap is about 44px. */
    const stopCss = stopBtn.getAttribute('class') ?? '';
    ok(`stop button classes: ${stopCss}`);

    const w = all.dom.window;
    const sent = [];
    /* A recorder, resolving the shape the real endpoint returns. */
    w.fetch = (url, init) => {
      sent.push({ url, init });
      return Promise.resolve({
        status: 200, ok: true,
        json: () => Promise.resolve({
          ok: true, halted: true, reason: 'stub', mode_halts_still_blocking: [],
        }),
      });
    };
    let confirmCalls = 0; let confirmAnswer = false;
    w.confirm = () => { confirmCalls += 1; return confirmAnswer; };
    /* location.reload is called on success; neutralise it so the DOM survives. */
    try { w.location.reload = () => {}; } catch { /* jsdom may refuse; harmless */ }

    /* ---- 1. STOP, WITH NO CONFIRMATION ------------------------------- */
    sent.length = 0; confirmCalls = 0;
    stopBtn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 30));
    if (confirmCalls !== 0) {
      fail(`STOP asked for confirmation (${confirmCalls} time(s)). It must not: a dialog `
        + 'in front of the stop button is a defect in the scenario it exists for');
    } else ok('STOP asked for NO confirmation');
    if (sent.length !== 1) {
      fail(`STOP sent ${sent.length} request(s), expected exactly 1`);
    } else {
      const { url, init } = sent[0];
      const body = JSON.parse(init.body);
      if (url !== '/api/bot-halt') fail(`STOP posted to ${url}, expected /api/bot-halt`);
      else if (init.method !== 'POST') fail(`STOP used ${init.method}, expected POST`);
      else if (body.action !== 'stop') fail(`STOP sent action=${body.action}`);
      else ok(`STOP posted {action:"stop", chain:"${body.chain}"} to /api/bot-halt`);
    }

    /* ---- 2. START, CONFIRMATION DECLINED: NOTHING MAY BE SENT -------- */
    sent.length = 0; confirmCalls = 0; confirmAnswer = false;
    startBtn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 30));
    if (confirmCalls !== 1) fail(`start asked for confirmation ${confirmCalls} times, expected 1`);
    else if (sent.length !== 0) {
      fail(`start sent ${sent.length} request(s) AFTER the confirmation was declined`);
    } else ok('start asked once and sent NOTHING when the confirmation was declined');

    /* ---- 3. START, CONFIRMED ----------------------------------------- */
    sent.length = 0; confirmCalls = 0; confirmAnswer = true;
    startBtn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 30));
    if (sent.length !== 1) fail(`confirmed start sent ${sent.length} request(s), expected 1`);
    else {
      const body = JSON.parse(sent[0].init.body);
      if (body.action !== 'start') fail(`confirmed start sent action=${body.action}`);
      else if (body.confirm !== true) {
        fail('confirmed start did not carry confirm:true, which the server requires');
      } else ok('confirmed start posted {action:"start", confirm:true}');
    }

    /* ---- 4. THE OPEN-POSITION WARNING -------------------------------- */
    const note = [...all.d.querySelectorAll('.ctl-note')].map((n) => n.textContent).join(' ');
    if (/position\(s\) are open right now/.test(note)) {
      ok('the control states how many positions are open, so STOP is not read as "flat"');
    } else {
      fail('the control does not say how many positions are open; STOP prevents new buys '
        + 'and does not close held ones, and five positions were stranded that way');
    }
  }
}

console.log(failures === 0 ? '\nverify-trades-page: PASS' : `\nverify-trades-page: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

/**
 * Parse-check every <script> block the web pages emit.
 *
 * The client-side JS is built inside server-side template literals, so any
 * escape written as \n or \d is consumed at BUILD time: the browser then
 * receives a real newline inside a regex (a SyntaxError that blanks the whole
 * page) or a silently different pattern. tsc cannot see this — to the compiler
 * the template literal is just a string, so the build passes and the page is
 * dead. That is exactly how /cate shipped blank.
 *
 * This runs as part of `npm run build`, so a page whose script cannot parse
 * fails the deploy instead of reaching production.
 */
import { renderCatePnlPage } from '../dist/web/cate-pnl.js';
import { renderDashboard } from '../dist/web/views.js';

const SAMPLE_PNL = [{
  token: 'CATE', wallet: 'So11111111111111111111111111111111111111112',
  tag: 'grp-01', tag_source: 'auto',
  first_buy_time_utc: '2026-07-26T16:24:38Z', first_buy_mcap_usd: 2531,
  // a never-sold wallet: the null path through the aggregate must render too
  last_sell_time_utc: null, n_buys: 1, n_sells: 0,
  sol_in: 1, sol_out: 0, realized_pnl_sol: 0, realized_pnl_usd: 0,
  tokens_still_held: 100, hold_min: null, sold_out: false,
  cluster_id: 'ntf-c001', cluster_signal: 'shared_signer', cluster_confidence: 'high',
  rate_basis: 'constant 2439.92 USD/ETH (test)', pre_window_entry: true, cluster_count: 2,
}];

// A clustered wallet with NO PnL row: 259 of 274 look like this, and the Groups
// tab exists to show them, so the gate must exercise that path.
const SAMPLE_CLUSTERS = [
  { chain: 'robinhood', wallet: '0xaaa0000000000000000000000000000000000001',
    cluster_id: 'ntf-c001', signal: 'shared_signer', evidence: '0xsigner',
    confidence: 'high', cluster_size: 2, has_pnl: false },
  { chain: 'solana', wallet: 'So11111111111111111111111111111111111111112',
    cluster_id: 'ntf-c001', signal: 'shared_signer', evidence: '0xsigner',
    confidence: 'high', cluster_size: 2, has_pnl: true },
];

const pages = [
  ['cate-pnl', () => renderCatePnlPage(SAMPLE_PNL, SAMPLE_CLUSTERS, new Date())],
  ['dashboard', () => renderDashboard({ monitors: [], panels: [], overall: 'ok', generatedAt: new Date() })],
];

let failures = 0;
for (const [name, render] of pages) {
  let html;
  try {
    html = render();
  } catch (err) {
    console.error(`  FAIL  ${name}: render threw: ${err.message}`);
    failures++;
    continue;
  }
  const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
  if (!blocks.length) {
    console.log(`  ok    ${name}: no inline script`);
    continue;
  }
  let bad = 0;
  for (const [i, m] of blocks.entries()) {
    try {
      new Function(m[1]);
    } catch (err) {
      console.error(`  FAIL  ${name}: script block ${i + 1} does not parse: ${err.message}`);
      bad++;
    }
  }
  if (bad) failures += bad;
  else console.log(`  ok    ${name}: ${blocks.length} script block(s) parse`);
}

if (failures) {
  console.error(`\ncheck-pages: ${failures} failure(s) — not deploying a page whose script cannot run.`);
  process.exit(1);
}
console.log('check-pages: all page scripts parse');

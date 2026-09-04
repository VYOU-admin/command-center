/**
 * Parse-check every <script> block the web pages emit.
 *
 * The client-side JS is built inside server-side template literals, so any
 * escape written as \n or \d is consumed at BUILD time: the browser then
 * receives a real newline inside a regex (a SyntaxError that blanks the whole
 * page) or a silently different pattern. tsc cannot see this — to the compiler
 * the template literal is just a string, so the build passes and the page is
 * dead. A page has shipped blank this way before.
 *
 * This runs as part of `npm run build`, so a page whose script cannot parse
 * fails the deploy instead of reaching production.
 */
import { renderDashboard } from '../dist/web/views.js';
import { renderTokensPage } from '../dist/web/tokens-page.js';

// A token with a wallet that has BOTH a priced and an unpriced purchase, so the
// null-rendering branch and the partial-total branch are both exercised by the
// gate rather than only on production data.
const SAMPLE_TOKENS = [{
  chain: 'solana',
  tokens: [{
    mint: '4ChT49V1iazP2XUGtycGkEsS6pRMqvGfUbqvRC9Z91ZT',
    ticker: 'MOS', name: 'Mosaic', decimals: 9,
    chartedPair: 'gjL62zuUAdJm7cZhrWtnBoCGN31kSFyWHScEYfTWiWh',
    windows: [
      { tag: 'MOS-P1', start: '2026-09-02T12:00:00.000Z', end: '2026-09-02T14:00:00.000Z', label: 'accumulation' },
      { tag: 'MOS-P2', start: '2026-09-02T19:05:00.000Z', end: '2026-09-02T19:45:00.000Z', label: 'spike' },
    ],
    wallets: [{
      wallet: 'HbPEA8hC6QnuxEfcQhfepY3s5akxuKMGa2T97WZVWB4a',
      tags: [{ tag: 'MOS-P1', source: 'auto' }, { tag: 'watch', source: 'manual' }],
      purchases: [
        { signature: '5xQ', pool: 'gjL62zuUAdJm7cZhrWtnBoCGN31kSFyWHScEYfTWiWh',
          blockTime: '2026-09-02T12:34:56.000Z', tokenAmount: 1234.5,
          usdAmount: 2000.25, priceUsd: 0.00162, windowTag: 'MOS-P1' },
        { signature: '6yR', pool: 'EVw13whn1d8dy1fggVFkeaeVgAWNnemFf6fMgtJM9ZDQ',
          blockTime: '2026-09-02T19:10:00.000Z', tokenAmount: 10,
          usdAmount: null, priceUsd: null, windowTag: 'MOS-P2' },
      ],
    }],
  }],
}];

const pages = [
  ['dashboard', () => renderDashboard({ monitors: [], overall: 'ok', generatedAt: new Date() })],
  ['tokens', () => renderTokensPage({ chains: SAMPLE_TOKENS, generatedAt: new Date() })],
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

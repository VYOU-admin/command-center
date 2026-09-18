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
import { renderWatchlistPage } from '../dist/web/watchlist-page.js';
import { renderTradesPage } from '../dist/web/trades-page.js';

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
  /*
   * A watchlist row with a PRICED and an UNPRICED trade, and a token with neither
   * name nor symbol, so the "unpriced" branch and the unnamed-token branch are both
   * exercised by the gate rather than only on production data.
   */
  ['watchlist', () => renderWatchlistPage({
    rows: [
      { wallet: '0x' + '1'.repeat(40), token: '0x' + '2'.repeat(40),
        name: 'Pons', symbol: 'PONS', side: 'buy', venue: 'v4',
        tokenAmount: '1234.5', usdAmount: 2000.25,
        blockNumber: '61574943', blockTime: '2026-09-13T01:00:00.000Z',
        txHash: '0x' + 'a'.repeat(64) },
      { wallet: '0x' + '3'.repeat(40), token: '0x' + '4'.repeat(40),
        name: null, symbol: null, side: 'sell', venue: 'v3',
        tokenAmount: '10', usdAmount: null,
        blockNumber: '61574900', blockTime: '2026-09-13T00:59:00.000Z',
        txHash: '0x' + 'b'.repeat(64) },
    ],
    tokens: [
      { token: '0x' + '2'.repeat(40), name: 'Pons', symbol: 'PONS', trades: 1 },
      { token: '0x' + '4'.repeat(40), name: null, symbol: null, trades: 1 },
    ],
    total: 2, limit: 500, filterToken: '', filterWallet: '', walletCount: 2,
    generatedAt: new Date(),
  })],
  /*
   * /trades GAINED AN INLINE SCRIPT when the on/off control was built, and this gate
   * did not cover the page. A script that does not parse is a stop button that does
   * nothing when pressed, which is worse than no button: the operator taps it, sees no
   * error, and believes the bot is stopped.
   *
   * THREE RENDERS, because the control has three distinct states and each builds
   * different markup: stopped chain-wide, running clean, and the case that would
   * otherwise lie -- no chain-wide halt but a mode halt still stopping the bot.
   */
  ...[
    ['trades-stopped', {
      rows: [{ mode: '*', halted: true, reason: 'STOPPED BY THE OPERATOR from /trades',
        updatedAt: '2026-09-17T12:00:00.000Z' }], openPositions: 3 }],
    ['trades-running', { rows: [], openPositions: 0 }],
    ['trades-mode-halt-only', {
      rows: [
        { mode: '*', halted: false, reason: null, updatedAt: '2026-09-17T12:00:00.000Z' },
        { mode: 'live', halted: true, reason: 'DEFECT: unresolved live position',
          updatedAt: '2026-09-17T12:01:00.000Z' },
      ], openPositions: 1 }],
  ].map(([name, control]) => [name, () => renderTradesPage({
    rows: [{
      id: '798', mode: 'live', createdAt: '2026-09-17T11:00:00.000Z',
      poolId: '0x' + '8'.repeat(64), token: '0x' + '9'.repeat(40),
      launchpad: '0x' + 'd'.repeat(40), fee: 500, positionUsd: 1,
      entryPrice: 1, exitPrice: null, grossReturn: null, gasUsd: 0.01,
      netPnlUsd: -1, fillStatus: 'filled', exitSimStatus: null,
      px30s: null, px300s: null, status: 'holding',
    }],
    totals: [{ mode: 'live', trades: 1, wins: 0, netPnl: -1, gas: 0.01 }],
    shown: 1, total: 1, modes: ['live'], launchpads: [],
    filterMode: null, filterLaunchpad: null, cap: 500,
    control,
  })]),
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

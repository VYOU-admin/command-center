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

const pages = [
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

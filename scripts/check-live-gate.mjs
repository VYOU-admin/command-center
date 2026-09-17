#!/usr/bin/env node
/**
 * THE LIVE-MODE GATE, CHECKED STATICALLY AT BUILD TIME.
 *
 * docs/LAUNCHBOT.md section 2A. This runs inside `npm run build`, so a commit that starts
 * reading a private key from a second place, or reaches for a signer or a broadcast
 * outside the one file allowed to, CANNOT BE BUILT AND THEREFORE CANNOT BE DEPLOYED.
 *
 * WHY THIS IS STATIC AND NOT A RUNTIME DRILL. A runtime drill proves the refusal fires on
 * the paths it exercises. It cannot prove that no OTHER path exists — and "no other path
 * exists" is the actual requirement: *with MODE not live, no code path can construct a
 * signer, read a key, or call eth_sendRawTransaction*. That is a statement about the whole
 * source tree, so it is checked over the whole source tree. Both exist; they answer
 * different questions and the drill is the weaker of the two.
 *
 * ROBINHOOD.md's standing lesson is the reason to bother: a capability that arrives as a
 * side effect of an unrelated edit is indistinguishable from no guarantee at all until
 * somebody reads the entire path end to end. This reads it on every build.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = 'src';

/** Each rule: a pattern that may appear ONLY in the listed files. */
const RULES = [
  {
    name: 'the private-key environment variable',
    /* Matches the literal name however it is written, including in a string. */
    re: /BOT_PRIVATE_KEY/,
    allow: ['src/bot/signer.ts'],
    why: 'only bot/signer.ts may read a private key, and only in live mode',
  },
  {
    name: "ethers' signing primitives",
    re: /\b(?:new\s+Wallet|Wallet\.fromPhrase|HDNodeWallet|SigningKey|signTransaction)\b/,
    allow: ['src/bot/signer.ts'],
    why: 'only bot/signer.ts may construct a signer',
  },
  {
    name: 'eth_sendRawTransaction',
    re: /eth_sendRawTransaction/,
    allow: ['src/bot/rpc.ts', 'src/bot/signer.ts'],
    why: 'bot/rpc.ts names it to REFUSE it and to gate BroadcastRpc; bot/signer.ts is the '
      + 'one caller, reachable only in live mode',
  },
  {
    name: 'eth_sendTransaction',
    re: /eth_sendTransaction/,
    allow: ['src/bot/rpc.ts'],
    why: 'named only in the deny-list',
  },
];

/**
 * THE MODE FLAG MUST NOT BE READABLE FROM THE ENVIRONMENT.
 *
 * Checked separately because it is the inverse shape: not "this appears in too many
 * files" but "this must never be read from env at all". `bot/mode.ts` names the impostor
 * variables in order to RAISE on them, which is the one legitimate mention.
 */
const MODE_ENV_RULE = {
  name: 'live mode from an environment variable',
  re: /process\.env\[?['"`]?(?:BOT_LIVE|LAUNCHBOT_LIVE|BOT_GO_LIVE|LIVE)['"`]?\]?/,
  allow: ['src/bot/mode.ts'],
  why: 'live mode is enabled by an explicit flag only; mode.ts names these to raise on them',
};

/**
 * IS THIS LINE PROSE RATHER THAN CODE?
 *
 * The rules are about what the program can DO, and a doc comment naming
 * `eth_sendRawTransaction` in order to explain that it is refused cannot execute. The
 * first run of this gate failed on exactly that — two header comments in `launchbot.ts`
 * and `wallet-probe.ts` describing the deny-list.
 *
 * COMMENT MENTIONS ARE PERMITTED AND COUNTED, NEVER SILENTLY DROPPED. Stripping them
 * invisibly would leave the gate reporting a clean pass over text it had decided not to
 * look at, which is the shape this project calls a filter matching nothing. They are
 * reported on every run so the total is visible.
 *
 * This is deliberately a line-level test against this codebase's comment style rather
 * than a parser: a mention on a line that also carries code counts as code.
 */
function isProse(line) {
  const t = line.trim();
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*');
}

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

const files = walk(SRC);
if (files.length === 0) {
  /* A check whose population is empty is a check that never ran. */
  console.error('LIVE GATE FAILED: no .ts files found under src/ — the check would pass '
    + 'vacuously, which is indistinguishable from passing.');
  process.exit(1);
}

let violations = 0;
let proseMentions = 0;
const report = [];
for (const rule of [...RULES, MODE_ENV_RULE]) {
  const hits = [];
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    if (!rule.re.test(text)) continue;
    const norm = f.split('\\').join('/');
    if (rule.allow.includes(norm)) continue;
    for (const [n, l] of text.split('\n').map((l, i) => [i + 1, l])) {
      if (!rule.re.test(l)) continue;
      if (isProse(l)) { proseMentions += 1; continue; }
      hits.push(`      ${f}:${n}  ${l.trim().slice(0, 100)}`);
    }
  }
  if (hits.length > 0) {
    violations += hits.length;
    report.push(`  ${rule.name} appears outside [${rule.allow.join(', ')}]:`);
    report.push(...hits);
    report.push(`      -> ${rule.why}`);
  } else {
    report.push(`  OK  ${rule.name}: confined to [${rule.allow.join(', ')}]`);
  }
}

/*
 * AND THE ALLOW-LIST ITSELF MUST NOT BE EMPTY OF THE THING IT ALLOWS. A rule whose
 * pattern no longer appears ANYWHERE is a rule guarding a capability that has been
 * renamed or deleted, and it would go on passing forever while guarding nothing — the
 * filter-matched-nothing failure this project records repeatedly.
 */
for (const rule of RULES) {
  const anywhere = files.some((f) => rule.re.test(readFileSync(f, 'utf8')));
  if (!anywhere) {
    violations += 1;
    report.push(`  STALE RULE: ${rule.name} matches NOTHING in src/. The capability was `
      + 'renamed or removed and this rule now guards nothing — a check that cannot fail.');
  }
}

console.log(`live-gate: ${files.length} source files checked, `
  + `${proseMentions} permitted mention(s) in comments`);
for (const line of report) console.log(line);

if (violations > 0) {
  console.error(`\nLIVE GATE FAILED: ${violations} violation(s). The build stops here.\n`
    + 'docs/LAUNCHBOT.md section 2A: only bot/signer.ts may read a key or construct a\n'
    + 'signer, and only bot/rpc.ts may name the broadcast method.');
  process.exit(1);
}
console.log('live-gate: PASS');

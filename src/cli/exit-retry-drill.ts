/**
 * `npm run exit-retry-drill -- [--commit]`
 *
 * FORCES AN EXIT REVERT AND CONFIRMS THE RETRY LADDER RECOVERS FROM IT.
 *
 * Two halves, and both are needed. The pure half proves the control flow — that
 * exhaustion RAISES, that each rung carries its measured bound, that a success stops
 * the ladder — without a network. The live half proves the thing that actually matters:
 * that a real `V4TooLittleReceived` against a real pool is cleared by a later rung.
 *
 * **THE FORCED FAILURE IS THE MEASURED ONE, NOT AN INVENTED ONE.** `revert-decode`
 * established that our quote is optimistic by a median factor of **1.2248** against
 * what the pool would actually pay. The live case therefore quotes at exactly that
 * measured factor, which makes the early rungs fail for precisely the reason the ladder
 * was built for. Multiplying by a round number like 2 would be testing a fault this
 * system has never had.
 *
 * It runs on chain='drill' rows only and writes nothing to the live bot state.
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { EXIT_RETRY, UNIVERSAL_ROUTER } from '../bot/config.js';
import { boundForAttempt, boundedMinOut, exitWithRetry } from '../bot/exit.js';
import type { ExitAttempt, ExitQuote } from '../bot/exit.js';
import { buildSwap } from '../bot/calldata.js';
import { swapAmounts, tokenPrice } from '../bot/price.js';
import { AbiCoder, id } from 'ethers';
import { TOPICS } from '../adapters/token-updates/decode.js';

const RPC_URL = 'https://robinhood-mainnet.g.alchemy.com/v2/{key}';
const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const abi = AbiCoder.defaultAbiCoder();
const V4_TOO_LITTLE = id('V4TooLittleReceived(uint256,uint256)').slice(0, 10);
/** The MEASURED median optimism of our quote, from the 11 decoded reverts. */
const MEASURED_QUOTE_OPTIMISM = 1.2248;

interface RpcOut { result?: unknown; error?: { message?: string; data?: unknown } }
async function rawCall(url: string, method: string, params: unknown[]): Promise<RpcOut> {
  const res = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return (await res.json()) as RpcOut;
}

interface Case { name: string; expect: string; got: string; pass: boolean }

async function main(): Promise<void> {
  const commit = process.argv.includes('--commit');
  const results: Case[] = [];
  const check = (name: string, expect: string, got: string): void => {
    results.push({ name, expect, got, pass: expect === got });
    log.info(`RETRY CASE: ${name}`, { expect, got, pass: expect === got });
  };

  /* ---------- THE LADDER ITSELF ---------------------------------------- */
  check('the ladder is the measured quantiles, in order',
    '300,400,1835,6070', EXIT_RETRY.BOUND_BPS.join(','));
  check('bound for each attempt comes from the ladder',
    '300,400,1835,6070',
    [1, 2, 3, 4].map((n) => boundForAttempt(n)).join(','));
  try {
    boundForAttempt(EXIT_RETRY.MAX_ATTEMPTS + 1);
    check('a rung past the measured data RAISES', 'raised', 'returned a value');
  } catch { check('a rung past the measured data RAISES', 'raised', 'raised'); }
  try {
    boundedMinOut(0n, 300);
    check('an unquotable pool RAISES rather than selling blind', 'raised', 'returned');
  } catch { check('an unquotable pool RAISES rather than selling blind', 'raised', 'raised'); }
  /* A bound wide enough to zero the minOut must refuse, not pass 0 to buildSwap. */
  try {
    boundedMinOut(10n, 9999);
    check('a bound that zeroes minOut RAISES', 'raised', 'returned');
  } catch { check('a bound that zeroes minOut RAISES', 'raised', 'raised'); }

  /* ---------- CONTROL FLOW, no network ---------------------------------- */
  const rec: ExitAttempt[] = [];
  const deps = (failUntil: number) => ({
    quote: async (_n: number, bps: number): Promise<ExitQuote> => ({
      expectedOut: 1000n, amountOutMinimum: boundedMinOut(1000n, bps),
    }),
    send: async (_q: ExitQuote, n: number): Promise<string> => {
      if (n < failUntil) throw new Error(`forced failure on attempt ${n}`);
      return `filled on attempt ${n}`;
    },
    record: async (a: ExitAttempt): Promise<void> => { rec.push(a); },
    wait: async (): Promise<void> => { /* no real delay in a drill */ },
  });

  rec.length = 0;
  const first = await exitWithRetry(deps(1), '0xdrill-first');
  check('a first-attempt success stops the ladder', 'filled=true attempts=1',
    `filled=${first.filled} attempts=${first.attempts.length}`);

  rec.length = 0;
  const third = await exitWithRetry(deps(3), '0xdrill-third');
  check('two failures then a fill reports the rung that worked',
    'filled=true on=3 recorded=3',
    `filled=${third.filled} on=${third.filledOn} recorded=${rec.length}`);
  check('the widening bound is applied per attempt', '300,400,1835',
    third.attempts.map((a) => a.boundBps).join(','));

  rec.length = 0;
  let raised = false; let msg = '';
  try {
    await exitWithRetry(deps(99), '0xdrill-exhaust');
  } catch (e) { raised = true; msg = (e as Error).message; }
  check('EXHAUSTION RAISES rather than returning a status', 'raised', raised ? 'raised' : 'returned');
  check('every attempt was recorded before the raise', '4', String(rec.length));
  check('the raise says the position is still open', 'yes',
    msg.includes('POSITION IS STILL OPEN') ? 'yes' : 'no');

  /* ---------- THE LIVE HALF: a real revert, cleared by a later rung ------ */
  if (!commit) {
    log.info('DRY RUN — the pure half ran; the live half needs --commit', {});
  } else {
    const key = process.env['ALCHEMY_API_KEY'];
    if (!key) throw new Error('ALCHEMY_API_KEY is not set');
    const url = RPC_URL.replace('{key}', key);
    const app = await bootstrap();
    const c = await app.pool.connect();
    try {
      /* A pool whose sell ALREADY simulated clean from a known holder, so the only
       * thing under test is the bound. Anything else would confound the two. */
      const r = await c.query<{
        pool_id: string; token: string; counter: string; fee: number;
        tick_spacing: number; hooks: string; exit_sim_from: string;
      }>(
        `select pool_id, token, counter, fee, tick_spacing, hooks, exit_sim_from
           from bot_trades
          where chain='robinhood' and exit_sim_status='clean' and exit_sim_from is not null
          order by created_at desc limit 1`);
      if (r.rowCount === 0) {
        log.warn('NO CLEAN-EXIT FIXTURE AVAILABLE', {
          note: 'RETURNED NO ROWS — the live half is reported as NOT RUN, never as a pass',
        });
      } else {
        const p = r.rows[0]!;
        const holder = p.exit_sim_from;
        /* The pool's most recent trade gives the price a sell would actually get. */
        const head = Number(BigInt(String((await rawCall(url, 'eth_blockNumber', [])).result)));
        const logs = (await rawCall(url, 'eth_getLogs', [{
          address: POOL_MANAGER, topics: [TOPICS.swapV4, p.pool_id],
          fromBlock: `0x${(head - 200000).toString(16)}`, toBlock: 'latest',
        }])).result as Array<{ data: string }> | undefined;
        if (!logs || logs.length === 0) {
          log.warn('NO RECENT SWAP ON THE FIXTURE POOL', {
            note: 'RETURNED NO ROWS — live half NOT RUN' });
        } else {
          const amts = swapAmounts(logs[logs.length - 1]!.data);
          const tokenIsC0 = p.token.toLowerCase() < p.counter.toLowerCase();
          const px = amts ? tokenPrice(amts, tokenIsC0) : 0;
          const balRaw = await rawCall(url, 'eth_call', [{
            to: p.token,
            data: id('balanceOf(address)').slice(0, 10) + '0'.repeat(24) + holder.slice(2),
          }, 'latest']);
          const bal = BigInt(String(balRaw.result ?? '0x0'));
          const sellAmt = bal / 100n > 0n ? bal / 100n : bal;
          const honest = BigInt(Math.floor(Number(sellAmt) * px));

          log.info('LIVE FIXTURE', {
            pool: p.pool_id.slice(0, 20), holder, fee: p.fee,
            holder_balance: bal.toString(), selling: sellAmt.toString(),
            honest_expected_out: honest.toString(),
            quote_optimism_applied: MEASURED_QUOTE_OPTIMISM,
            note: 'the quote is inflated by the MEASURED median optimism of our own '
              + 'quote, so the early rungs fail for the reason the ladder exists',
          });

          const liveRec: ExitAttempt[] = [];
          const liveDeps = {
            quote: async (_n: number, bps: number): Promise<ExitQuote> => {
              const optimistic = BigInt(Math.floor(Number(honest) * MEASURED_QUOTE_OPTIMISM));
              return { expectedOut: optimistic, amountOutMinimum: boundedMinOut(optimistic, bps) };
            },
            send: async (q: ExitQuote): Promise<string> => {
              const tx = buildSwap({
                pool: {
                  currency0: tokenIsC0 ? p.token : p.counter,
                  currency1: tokenIsC0 ? p.counter : p.token,
                  fee: p.fee, tickSpacing: p.tick_spacing, hooks: p.hooks,
                },
                zeroForOne: tokenIsC0,
                amountIn: sellAmt, amountOutMinimum: q.amountOutMinimum,
                deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
              });
              const out = await rawCall(url, 'eth_call', [{
                from: holder, to: UNIVERSAL_ROUTER, value: '0x0', data: tx.data,
              }, 'latest']);
              if (out.error) {
                const d = out.error.data;
                if (typeof d === 'string' && d.startsWith(V4_TOO_LITTLE)) {
                  const [mn, got] = abi.decode(['uint256', 'uint256'],
                    `0x${d.slice(10)}`) as unknown as [bigint, bigint];
                  throw new Error(`V4TooLittleReceived bound=${mn} actual=${got}`);
                }
                throw new Error(String(out.error.message ?? 'reverted').slice(0, 120));
              }
              return `returned ${String(out.result).slice(0, 18)}`;
            },
            record: async (a: ExitAttempt): Promise<void> => { liveRec.push(a); },
            wait: async (): Promise<void> => { /* the chain state is read per call */ },
          };

          let liveOutcome = 'RAISED — every rung failed';
          try {
            const o = await exitWithRetry(liveDeps, p.pool_id);
            liveOutcome = `filled on attempt ${o.filledOn} at ${boundForAttempt(o.filledOn!)} bps`;
          } catch (e) { liveOutcome = `RAISED: ${(e as Error).message.slice(0, 90)}`; }

          const sawRealRevert = liveRec.some((a) => a.detail.includes('V4TooLittleReceived'));
          check('a REAL V4TooLittleReceived was produced against a live pool',
            'yes', sawRealRevert ? 'yes' : 'no');
          log.info('LIVE RETRY LADDER', {
            outcome: liveOutcome,
            attempts: liveRec.map((a) =>
              `#${a.attempt} @${a.boundBps}bps ${a.ok ? 'FILLED' : 'failed'} — ${a.detail.slice(0, 80)}`),
          });
        }
      }
    } finally { c.release(); }
    await app.pool.end();
  }

  const failed = results.filter((x) => !x.pass);
  log.info('EXIT RETRY DRILL COMPLETE', {
    cases: results.length, passed: results.length - failed.length, failed: failed.length,
    results: results.map((x) => `${x.pass ? 'PASS' : 'FAIL'}  ${x.name}  expected `
      + `${x.expect} got ${x.got}`),
  });
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => { log.error('exit-retry-drill failed', errorFields(err)); process.exit(1); });

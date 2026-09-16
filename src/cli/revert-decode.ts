/**
 * `npm run revert-decode -- [--commit]`
 *
 * WHY 31% OF QUALIFYING TRADES REVERT. Both dry runs lost roughly a third of their
 * trades to `execution reverted` with no reason string, the fee allow-list did not move
 * the number, and an unexplained third of the trade set is the largest single cost in
 * this system.
 *
 * TWO PASSES, and the second exists because the first usually returns nothing:
 *
 * 1. **RE-SIMULATE AND CAPTURE THE REVERT DATA.** `eth_call` returns the revert payload
 *    in `error.data`, which the RPC client discards when it turns the response into an
 *    Error. This goes to the transport directly so the bytes survive. `Error(string)`
 *    and `Panic(uint256)` are decoded; anything else is reported as its raw selector,
 *    never guessed at.
 *
 * 2. **DIFF AGAINST A TRANSACTION THAT ACTUALLY WORKED.** Where the revert is bare, the
 *    pool's own first swap is fetched — a trade that DID execute on that pool at that
 *    moment — its calldata decoded, and every field compared with ours. A bare revert
 *    plus a working example is a diff, which is a fact; a bare revert alone is not a
 *    measurement of anything.
 *
 * IT SIMULATES AT THE HISTORICAL BLOCK AS WELL AS AT HEAD, because the two answer
 * different questions: at head the pool has moved on and may be drained, while at the
 * block we would have traded it the state is the state we would have met.
 * `LAUNCHBOT.md` establishes that `eth_call` at a historical block works on this
 * endpoint (6 of 6 returned).
 *
 * IF THE CAUSES DO NOT CLUSTER, THAT IS THE ANSWER AND IT IS REPORTED AS THAT. No fix
 * is proposed for a cause that has not been established.
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { AbiCoder, id } from 'ethers';
import { SELECTORS } from '../bot/calldata.js';
import { UNIVERSAL_ROUTER } from '../bot/config.js';
import { TOPICS } from '../adapters/token-updates/decode.js';

const RPC_URL = 'https://robinhood-mainnet.g.alchemy.com/v2/{key}';
const abi = AbiCoder.defaultAbiCoder();
const ERROR_STRING = id('Error(string)').slice(0, 10);
const PANIC = id('Panic(uint256)').slice(0, 10);
/*
 * IDENTIFIED BY COMPUTING keccak OF CANDIDATE SIGNATURES, never by lookup or guess.
 * ROBINHOOD.md: a fabricated topic hash has shipped on this project once, and matched
 * zero logs while reading as a clean sweep.
 *
 * V4TooLittleReceived carries (minAmountOutReceived, amountReceived) — it is the v4
 * router telling us OUR OWN BOUND rejected the trade, and the two words say by how
 * much. That turns "the bound is too tight" from an opinion into a ratio.
 */
const V4_TOO_LITTLE = id('V4TooLittleReceived(uint256,uint256)').slice(0, 10);
const DEADLINE_PASSED = id('TransactionDeadlinePassed()').slice(0, 10);

interface RpcOut { result?: unknown; error?: { code?: number; message?: string; data?: unknown } }

/** Raw transport: the RPC client raises on `error`, which throws the data away. */
async function rawCall(url: string, method: string, params: unknown[]): Promise<RpcOut> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return (await res.json()) as RpcOut;
}

/** Decode a revert payload. An unrecognised selector is REPORTED, never interpreted. */
function decodeRevert(data: unknown): string {
  if (typeof data !== 'string' || !data.startsWith('0x')) return 'no revert data returned';
  if (data === '0x') return 'empty revert payload (0x) — no reason string';
  if (data.startsWith(ERROR_STRING)) {
    try {
      return `Error(string): ${String(abi.decode(['string'], `0x${data.slice(10)}`)[0])}`;
    } catch { return `Error(string) but undecodable: ${data.slice(0, 40)}`; }
  }
  if (data.startsWith(V4_TOO_LITTLE)) {
    try {
      const [minOut, got] = abi.decode(['uint256', 'uint256'],
        `0x${data.slice(10)}`) as unknown as [bigint, bigint];
      const shortfall = minOut > 0n
        ? (Number(minOut - got) / Number(minOut) * 100).toFixed(3) : 'n/a';
      return `V4TooLittleReceived: our bound ${minOut} > actual ${got}`
        + ` — short by ${shortfall}% of the bound`;
    } catch { return 'V4TooLittleReceived but undecodable'; }
  }
  if (data.startsWith(DEADLINE_PASSED)) return 'TransactionDeadlinePassed()';
  if (data.startsWith(PANIC)) {
    try {
      return `Panic(uint256): 0x${BigInt(String(abi.decode(['uint256'], `0x${data.slice(10)}`)[0])).toString(16)}`;
    } catch { return `Panic but undecodable: ${data.slice(0, 40)}`; }
  }
  return `custom error, selector ${data.slice(0, 10)} (${data.length - 2} hex chars)`;
}

async function main(): Promise<void> {
  const commit = process.argv.includes('--commit');
  const key = process.env['ALCHEMY_API_KEY'];
  if (!key) throw new Error('ALCHEMY_API_KEY is not set');
  const url = RPC_URL.replace('{key}', key);

  const app = await bootstrap();
  const c = await app.pool.connect();
  try {
    const rows = await c.query<{
      id: string; pool_id: string; token: string; counter: string; fee: number;
      first_swap_block: string; entry_calldata: string; position_wei: string;
      launchpad: string | null;
    }>(
      `select id::text, pool_id, token, counter, fee, first_swap_block::text,
              entry_calldata, position_wei::text, launchpad
         from bot_trades
        where chain='robinhood' and status='sim_reverted' and entry_calldata is not null
        order by created_at`);
    const n = rows.rowCount ?? 0;
    /* 2 eth_call + 1 getLogs + 1 getTransactionByHash per row, worst case. */
    const cu = n * (26 + 26 + 60 + 15);
    log.info('REVERT DECODE WORK SET', {
      reverted_trades: n, estimate: { cu, usd: ((cu * 0.45) / 1e6).toFixed(5) }, commit,
    });
    if (n === 0) {
      log.info('NOTHING TO DECODE', { note: 'reported as a result, not a clean pass' });
      c.release(); await app.pool.end(); process.exit(0);
    }
    if (!commit) {
      log.info('DRY RUN — nothing read', { note: 'pass --commit' });
      c.release(); await app.pool.end(); process.exit(0);
    }

    const findings: Array<Record<string, unknown>> = [];
    const needed: number[] = [];
    const tally: Record<string, number> = {};
    const from = '0x000000000000000000000000000000000000dEaD';

    for (const r of rows.rows) {
      const blk = Number(r.first_swap_block) + 150;
      const call = {
        from, to: UNIVERSAL_ROUTER, value: `0x${BigInt(r.position_wei).toString(16)}`,
        data: r.entry_calldata,
      };
      const atBlock = await rawCall(url, 'eth_call', [call, `0x${blk.toString(16)}`]);
      const atHead = await rawCall(url, 'eth_call', [call, 'latest']);

      const reasonHist = atBlock.error
        ? decodeRevert(atBlock.error.data ?? null) : 'RETURNED — did not revert';
      const reasonHead = atHead.error
        ? decodeRevert(atHead.error.data ?? null) : 'RETURNED — did not revert';

      const f: Record<string, unknown> = {
        trade: r.id, pool: r.pool_id.slice(0, 18), fee: r.fee,
        launchpad: (r.launchpad ?? '').slice(0, 12),
        at_historical_block: reasonHist,
        at_head: reasonHead,
        historical_msg: atBlock.error?.message?.slice(0, 120) ?? null,
      };
      /* Bucket by CAUSE, not by the numbers inside it, or every row is its own cause. */
      const cause = reasonHist.startsWith('V4TooLittleReceived')
        ? 'V4TooLittleReceived (our own slippage bound)'
        : reasonHist;
      tally[cause] = (tally[cause] ?? 0) + 1;
      if (atBlock.error && typeof atBlock.error.data === 'string'
        && atBlock.error.data.startsWith(V4_TOO_LITTLE)) {
        try {
          const [minOut, got] = abi.decode(['uint256', 'uint256'],
            `0x${atBlock.error.data.slice(10)}`) as unknown as [bigint, bigint];
          /* The ratio a bound would have needed to clear. 1.0 = exactly met. */
          if (minOut > 0n) needed.push(Number(minOut) / Number(got));
        } catch { /* an undecodable payload contributes nothing, and is not invented */ }
      }

      /* PASS 2 — only where the historical revert carried no reason. */
      if (atBlock.error && !(typeof atBlock.error.data === 'string'
        && atBlock.error.data.length > 10)) {
        const logs = (await rawCall(url, 'eth_getLogs', [{
          address: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
          topics: [TOPICS.swapV4, r.pool_id],
          fromBlock: `0x${Number(r.first_swap_block).toString(16)}`,
          toBlock: `0x${(Number(r.first_swap_block) + 600).toString(16)}`,
        }])).result as Array<{ transactionHash: string }> | undefined;
        if (!logs || logs.length === 0) {
          f['working_example'] = 'RETURNED NO ROWS — no swap found on this pool to diff against';
        } else {
          const tx = (await rawCall(url, 'eth_getTransactionByHash',
            [logs[0]!.transactionHash])).result as
            { to?: string; input?: string; value?: string; from?: string } | null;
          if (!tx?.input) {
            f['working_example'] = 'transaction unreadable — UNKNOWN, not attributed';
          } else {
            const sel = tx.input.slice(0, 10);
            f['working_example'] = {
              tx: logs[0]!.transactionHash,
              their_to: tx.to,
              their_selector: sel,
              their_selector_is_universal_router:
                sel === SELECTORS.execute3 || sel === SELECTORS.execute2,
              they_used_the_same_router: (tx.to ?? '').toLowerCase() === UNIVERSAL_ROUTER,
              their_value_nonzero: BigInt(tx.value ?? '0x0') > 0n,
              their_calldata_bytes: (tx.input.length - 2) / 2,
              our_calldata_bytes: (r.entry_calldata.length - 2) / 2,
            };
          }
        }
      }
      findings.push(f);
    }

    log.info('REVERT CAUSES BY FREQUENCY', {
      total: n,
      note: 'the historical-block reason is the one that matters: it is the state we '
        + 'would actually have traded into. A cause that does not cluster is reported '
        + 'as not clustering, and no fix is proposed for it.',
      by_cause: Object.entries(tally).sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${v}x  ${k}`),
    });
    /*
     * WHAT BOUND WOULD HAVE CLEARED. minOut/actual is how many times too large our
     * bound was; the implied one-leg slippage needed is 1 - actual/minOut.
     */
    if (needed.length > 0) {
      const srt = [...needed].sort((a, b) => a - b);
      const q = (p: number): number => srt[Math.min(srt.length - 1,
        Math.floor((srt.length - 1) * p))]!;
      log.info('WHAT THE BOUND WOULD HAVE HAD TO BE', {
        n: srt.length,
        note: 'ratio = our minOut / what the pool would actually have paid. The implied '
          + 'ONE-LEG slippage that would have cleared it is (1 - 1/ratio).',
        min_ratio: srt[0]!.toFixed(4),
        p25: q(0.25).toFixed(4), median: q(0.5).toFixed(4),
        p75: q(0.75).toFixed(4), p90: q(0.9).toFixed(4),
        max_ratio: srt[srt.length - 1]!.toFixed(4),
        implied_one_leg_slippage_needed_pct: {
          median: ((1 - 1 / q(0.5)) * 100).toFixed(2),
          p90: ((1 - 1 / q(0.9)) * 100).toFixed(2),
          max: ((1 - 1 / srt[srt.length - 1]!) * 100).toFixed(2),
        },
      });
    } else {
      log.info('NO V4TooLittleReceived PAYLOADS DECODED', {
        note: 'RETURNED NO ROWS — stated, not omitted',
      });
    }
    log.info('PER-TRADE DETAIL', { findings });
  } finally { c.release(); }
  await app.pool.end();
  process.exit(0);
}

main().catch((err) => { log.error('revert-decode failed', errorFields(err)); process.exit(1); });

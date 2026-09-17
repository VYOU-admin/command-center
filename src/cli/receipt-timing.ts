/**
 * `npm run receipt-timing -- [--samples N] [--poll-ms N]`
 *
 * MEASURES WHAT THE EXIT'S RECEIPT TIMEOUT HAS TO COVER. docs/LAUNCHBOT.md section 2C.
 *
 * `exit-exec`'s receipt wait is 60,000 ms, and that was a bound chosen so the poll would
 * terminate — not a figure derived from how long this chain takes to mine. A false timeout
 * is expensive: it raises `ExitUnrecoverableError`, stops the ladder at one transaction and
 * leaves a position whose state a human has to reconcile against the chain. So the value
 * should be a measurement.
 *
 * ---------------------------------------------------------------------------
 * THE TIMEOUT COVERS TWO THINGS AND ONLY ONE OF THEM IS MEASURABLE HERE
 * ---------------------------------------------------------------------------
 *
 * From `eth_sendRawTransaction` returning to `eth_getTransactionReceipt` answering:
 *
 *   A. INCLUSION — our transaction sitting in the mempool until a block takes it.
 *   B. RECEIPT AVAILABILITY — the block existing, and this endpoint serving its receipts.
 *
 * **B IS MEASURED EXACTLY BY THIS TOOL. A IS NOT MEASURABLE WITHOUT SENDING**, and nothing
 * in this repository can send: no key exists and `ReadOnlyRpc` refuses the broadcast by
 * name. Observing somebody else's transaction cannot substitute, because their submission
 * time is not knowable — the mempool is not in any of these methods and a transaction in a
 * block carries no record of when it was offered.
 *
 * So A is BOUNDED rather than measured, from two things this tool does observe: the
 * wall-clock interval at which new blocks actually appear, and whether blocks are anywhere
 * near full. An uncongested chain includes a fee-paying transaction in the next block or
 * two; a congested one does not, and the congestion figure is what says which this is.
 * **That distinction is stated in the output rather than folded into one number**, because
 * a timeout derived from a measured half plus an inferred half is not a measured timeout.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT ACTUALLY DOES
 * ---------------------------------------------------------------------------
 *
 * Polls `eth_blockNumber`. The instant head advances, it fetches the new block and asks
 * for a receipt from it, repeatedly, until one is served — timing that gap. **That is
 * precisely the loop `exit-exec` runs after a broadcast**, against the same endpoint, so
 * the number it produces is the number that matters rather than a proxy for it.
 *
 * It also records, per sample: the wall-clock gap since the previous head advance, the
 * block's own timestamp gap, its transaction count, and its gas used against its limit.
 *
 * READ-ONLY. It goes through `ReadOnlyRpc`, so it cannot broadcast even in principle.
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { RpcClient } from '../adapters/token-updates/rpc.js';
import { ReadOnlyRpc } from '../bot/rpc.js';

const RPC_URL = 'https://robinhood-mainnet.g.alchemy.com/v2/{key}';

/** Give up on one sample rather than hanging the whole run. Reported when it binds. */
const PER_SAMPLE_CAP_MS = 30_000;

interface Sample {
  block: number;
  /** ms from head advancing to a receipt being served for a tx in that block. */
  receiptLagMs: number;
  /** How many receipt polls it took. 1 = available on the first ask. */
  polls: number;
  /** ms of wall clock since the previous head advance. */
  headGapMs: number | null;
  /**
   * HOW MANY BLOCKS HEAD ADVANCED at this observation.
   *
   * **WITHOUT THIS, `headGapMs` MEASURES THE POLL RATE RATHER THAN THE CHAIN.** The first
   * run of this tool reported a 155 ms median "between new blocks" against the ~101 ms
   * `ROBINHOOD.md` measures over 935,564 blocks — because at a ~115 ms effective poll
   * period head sometimes advances TWO blocks between observations, and counting that as
   * one gap inflates the interval by however often it happens. The true interval is total
   * elapsed over total blocks, which is immune to the poll rate.
   *
   * This is the failure shape this project records twice already: a bound of mine
   * presented as a fact about the market — `surv_1h` reading 0.02% because it measured its
   * own window cap, and the +600 s horizon reading exactly 0.00000 because it asked for a
   * trade after its own last tick.
   */
  blocksAdvanced: number;
  /** The block's own timestamp minus the previous block's, in seconds. */
  tsGapS: number | null;
  txCount: number;
  gasUsed: number;
  gasLimit: number;
  capped: boolean;
}

function quantile(xs: number[], q: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i); const hi = Math.ceil(i);
  return lo === hi ? s[lo]! : s[lo]! + (s[hi]! - s[lo]!) * (i - lo);
}
const r2 = (x: number | null): number | null =>
  (x === null ? null : Number(x.toFixed(2)));

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => { setTimeout(r, ms); });

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const si = args.indexOf('--samples');
  const samples = si >= 0 ? Number(args[si + 1] ?? 30) : 30;
  const pi = args.indexOf('--poll-ms');
  const pollMs = pi >= 0 ? Number(args[pi + 1] ?? 100) : 100;
  if (!Number.isInteger(samples) || samples < 1 || samples > 200) {
    throw new Error(`--samples must be 1..200, got "${String(args[si + 1])}"`);
  }
  if (!Number.isInteger(pollMs) || pollMs < 20) {
    throw new Error(`--poll-ms must be an integer >= 20, got "${String(args[pi + 1])}"`);
  }

  const app = await bootstrap();
  const key = process.env['ALCHEMY_API_KEY'];
  if (!key) throw new Error('ALCHEMY_API_KEY is not set');
  const rpc = new ReadOnlyRpc(new RpcClient(RPC_URL.replace('{key}', key), 60000, 500_000));

  log.info('RECEIPT TIMING — WORK SET AND WHAT IT CAN ANSWER', {
    samples, poll_ms: pollMs,
    measures: 'B: the gap between a block appearing at head and this endpoint serving a '
      + 'receipt from it — the exact loop exit-exec runs after a broadcast',
    cannot_measure: 'A: inclusion. Nothing here can send, and another party\'s submission '
      + 'time is not knowable from any of these methods.',
    estimated_cost: `~${samples * (20 + 15 * 2)} CU for the blocks and receipts plus the `
      + 'head poll; a few thousand CU in total',
  });

  const out: Sample[] = [];
  let headRetreats = 0;
  let emptyBlocks = 0;
  let prevHead = Number(BigInt(String(await rpc.call('eth_blockNumber', []))));
  let prevHeadAt: number | null = null;
  let prevTs: number | null = null;

  while (out.length < samples) {
    const h = Number(BigInt(String(await rpc.call('eth_blockNumber', []))));
    if (h < prevHead) {
      /*
       * HEAD WENT BACKWARDS. `ROBINHOOD.md` records that this chain's reorg depth has
       * never been measured and that the 200-block lag is "a margin, not a finding", so
       * an observation here is worth more than the absence of one. It also matters
       * directly: a receipt that is served and then disappears is a worse failure than a
       * receipt that is slow.
       */
      headRetreats += 1;
      log.warn('HEAD RETREATED', { from: prevHead, to: h,
        note: 'a reorg at the tip. Recorded because this chain\'s reorg depth is '
          + 'unmeasured, and a vanishing receipt is worse than a slow one.' });
      prevHead = h;
      continue;
    }
    if (h === prevHead) { await sleep(pollMs); continue; }

    const nowAt = Date.now();
    const headGapMs = prevHeadAt === null ? null : nowAt - prevHeadAt;
    const blocksAdvanced = h - prevHead;
    prevHead = h; prevHeadAt = nowAt;

    /* The new block, WITH its transactions, so a receipt can be asked for. */
    const blk = (await rpc.call('eth_getBlockByNumber', [`0x${h.toString(16)}`, true])) as {
      timestamp?: string; gasUsed?: string; gasLimit?: string;
      transactions?: Array<{ hash?: string }>;
    } | null;
    if (blk === null || blk.transactions === undefined) {
      throw new Error(`eth_getBlockByNumber returned no block for head ${h}; the head is `
        + 'UNKNOWN rather than empty and this will not average over it');
    }
    const ts = blk.timestamp === undefined ? null : Number(BigInt(blk.timestamp));
    const tsGapS = ts !== null && prevTs !== null ? ts - prevTs : null;
    if (ts !== null) prevTs = ts;

    const txs = blk.transactions;
    if (txs.length === 0) {
      /*
       * AN EMPTY BLOCK CANNOT TIME A RECEIPT, and it is COUNTED rather than skipped
       * silently: at ~0.1 s blocks most blocks on a quiet chain are empty, and a run that
       * quietly discarded them would report a sample size it did not have.
       */
      emptyBlocks += 1;
      continue;
    }
    const hash = txs[0]?.hash;
    if (hash === undefined) {
      throw new Error(`block ${h} has transactions with no hash field`);
    }

    /* ---- THE MEASUREMENT: poll for the receipt exactly as exit-exec does ---- */
    const t0 = Date.now();
    let polls = 0; let capped = false; let got = false;
    for (;;) {
      polls += 1;
      const rec = (await rpc.call('eth_getTransactionReceipt', [hash])) as
        { status?: string } | null;
      if (rec !== null && rec !== undefined && rec.status !== undefined) { got = true; break; }
      if (Date.now() - t0 >= PER_SAMPLE_CAP_MS) { capped = true; break; }
      await sleep(pollMs);
    }
    const lag = Date.now() - t0;
    if (!got && !capped) throw new Error('receipt loop exited without an answer');

    out.push({
      block: h, receiptLagMs: lag, polls, headGapMs, blocksAdvanced, tsGapS,
      txCount: txs.length,
      gasUsed: blk.gasUsed === undefined ? 0 : Number(BigInt(blk.gasUsed)),
      gasLimit: blk.gasLimit === undefined ? 0 : Number(BigInt(blk.gasLimit)),
      capped,
    });
    if (out.length % 10 === 0) {
      log.info('progress', { samples: out.length, of: samples, cu: rpc.cuSpent });
    }
  }

  /* ---- THE RESULT ------------------------------------------------------- */
  const lags = out.map((s) => s.receiptLagMs);
  const firstAsk = out.filter((s) => s.polls === 1).length;
  const cappedN = out.filter((s) => s.capped).length;
  const headGaps = out.map((s) => s.headGapMs).filter((x): x is number => x !== null);
  const tsGaps = out.map((s) => s.tsGapS).filter((x): x is number => x !== null);
  const fullness = out.filter((s) => s.gasLimit > 0)
    .map((s) => (s.gasUsed / s.gasLimit) * 100);

  log.info('B. RECEIPT AVAILABILITY — MEASURED, ms from head advance to a served receipt', {
    samples: out.length,
    available_on_the_FIRST_ask: `${firstAsk} of ${out.length}`,
    median_ms: r2(quantile(lags, 0.5)),
    p90_ms: r2(quantile(lags, 0.9)),
    max_ms: Math.max(...lags),
    capped_at_the_per_sample_limit: cappedN,
    note: cappedN > 0
      ? `${cappedN} sample(s) hit the ${PER_SAMPLE_CAP_MS} ms cap — those are a LOWER `
        + 'bound on the lag, not a measurement of it'
      : `no sample reached the ${PER_SAMPLE_CAP_MS} ms cap, so every figure above is a `
        + 'real measurement rather than a bound',
    poll_interval_ms: pollMs,
    caveat: 'this is bounded below by the poll interval: a receipt served instantly still '
      + `reads as up to ${pollMs} ms. The first-ask count is the figure that is not.`,
  });

  /*
   * THE TRUE BLOCK INTERVAL IS ELAPSED OVER BLOCKS, NOT THE MEDIAN OBSERVATION GAP.
   * Only samples with a known preceding observation contribute to both sides.
   */
  const paired = out.filter((s) => s.headGapMs !== null);
  const totalGapMs = paired.reduce((a, s) => a + (s.headGapMs ?? 0), 0);
  const totalBlocks = paired.reduce((a, s) => a + s.blocksAdvanced, 0);
  const multi = paired.filter((s) => s.blocksAdvanced > 1).length;

  log.info('A. INCLUSION — NOT MEASURED, BOUNDED FROM WHAT IS OBSERVABLE', {
    block_interval_ms_TRUE: {
      value: totalBlocks === 0 ? null : r2(totalGapMs / totalBlocks),
      derivation: `${totalGapMs} ms of wall clock over ${totalBlocks} blocks across `
        + `${paired.length} observations`,
      note: 'elapsed over BLOCKS, not the median observation gap — the latter measures '
        + 'the poll rate whenever head advances more than one block between polls',
      observations_where_head_advanced_more_than_one_block: multi,
      robinhood_md_reference: '~101 ms, measured over 935,564 blocks / 94,548 s',
    },
    observation_gap_ms_NOT_the_block_interval: {
      median: r2(quantile(headGaps, 0.5)), p90: r2(quantile(headGaps, 0.9)),
      max: headGaps.length ? Math.max(...headGaps) : null,
      note: 'kept only to show the difference. This is how often THIS TOOL looked, and '
        + 'reporting it as the block interval is what the first run got wrong.',
    },
    block_timestamp_gap_seconds: {
      median: r2(quantile(tsGaps, 0.5)), max: tsGaps.length ? Math.max(...tsGaps) : null,
      note: 'ROBINHOOD.md: timestamps have 1-second resolution and ten consecutive blocks '
        + 'share one, so this is coarse by construction and the wall-clock figure is the '
        + 'better one',
    },
    congestion: {
      /*
       * RAW FIGURES BESIDE THE PERCENTAGE. The first run reported 0% for BOTH the median
       * and the max, which tells a reader nothing except that the ratio is small — and a
       * statistic that reads zero at every quantile is indistinguishable from one that
       * was never computed.
       */
      gas_used_median: r2(quantile(out.map((s) => s.gasUsed), 0.5)),
      gas_used_max: Math.max(...out.map((s) => s.gasUsed)),
      gas_limit_median: r2(quantile(out.map((s) => s.gasLimit), 0.5)),
      gas_used_pct_of_limit_median: quantile(fullness, 0.5) === null ? null
        : Number((quantile(fullness, 0.5) ?? 0).toFixed(4)),
      gas_used_pct_of_limit_max: fullness.length
        ? Number(Math.max(...fullness).toFixed(4)) : null,
      tx_per_block_median: r2(quantile(out.map((s) => s.txCount), 0.5)),
      tx_per_block_max: Math.max(...out.map((s) => s.txCount)),
    },
    empty_blocks_skipped: emptyBlocks,
    head_retreats_observed: headRetreats,
    why_this_is_a_bound_and_not_a_measurement: 'inclusion is the gap between OUR submission '
      + 'and a block taking it. Nothing here can submit, and another party\'s submission '
      + 'time is not in any available method. Far-from-full blocks make next-block '
      + 'inclusion the expectation, which is an inference from the congestion figure '
      + 'rather than an observation of our own transaction.',
  });

  log.info('WHAT THIS IMPLIES FOR THE TIMEOUT — and the asymmetry that decides it', {
    measured_half_worst_ms: Math.max(...lags),
    asymmetry: 'a timeout that fires too EARLY raises ExitUnrecoverableError, stops the '
      + 'ladder at one transaction and leaves a position for a human to reconcile. A '
      + 'timeout that is too LATE only makes the bot wait on a $10 position. The costs '
      + 'are not symmetric, so the value belongs well above the measured tail.',
    what_is_NOT_covered: 'a transaction that never gets included at all — an underpriced '
      + 'or dropped one. No timeout distinguishes that from a slow one, which is exactly '
      + 'why the timeout raises UNRECOVERABLE rather than treating it as a failed attempt.',
    cu_spent: rpc.cuSpent,
  });

  await app.pool.end();
  process.exit(0);
}

main().catch((e) => { log.error('receipt-timing failed', errorFields(e)); process.exit(1); });

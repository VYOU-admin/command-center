/**
 * `npm run launchpad-survey` — THE THIRD-PARTY CLAIMS, CHECKED AGAINST THE CHAIN.
 *
 * Part 3A of the post-mortem brief handed over a list of claims about how launch
 * sniping is done on this chain, explicitly as **unverified third-party assertions**.
 * This measures them. Nothing here adopts a claim; each is reported as HELD, FAILED or
 * UNTESTED against what the chain says.
 *
 * The claims this answers, in the brief's numbering:
 *
 *   3A.i   the NOXA Launch Factory at 0xD9eC2db5…FCcB is what working bots watch, and
 *          our bot watches raw v4 `Initialize` instead. What fraction of the pools our
 *          rule qualified were launchpad launches?
 *   3A.ii  NOXA mints the full supply into a single-sided Uniswap V3 position and LOCKS
 *          the LP permanently; tokens deploy to vanity addresses ending in 4663.
 *   3A.iv  **THE LAUNCH RATE, AND THE BRIEF SAYS TO RESOLVE IT FIRST.** One source says
 *          "a few dozen a week"; our bot saw 200–480 qualifying launches a day. Both
 *          cannot describe the same population.
 *
 * ---------------------------------------------------------------------------
 * THE EVENT SHAPES, IDENTIFIED BY SAMPLING RATHER THAN TAKEN ON TRUST
 * ---------------------------------------------------------------------------
 *
 * ROBINHOOD.md: *"Never take a topic hash on trust. A fabricated topic matches zero
 * logs and reads as a clean sweep."* Each of these was found by pulling the factory's
 * logs with NO topic filter, grouping by `topic0`, and confirming the decode against a
 * contract's own `symbol()`:
 *
 * ```
 * 0x14613701…  4 topics,  96 data bytes   topics[1]=token topics[2]=creator topics[3]=v3 factory
 * 0xdb51ea9a…  4 topics, 224 data bytes   same key, more payload
 * 0x54729d9f…  2 topics, 256 data bytes   CONFIG: v3 factory, SwapRouter02, fee 10000
 * 0x26d31e04…  2 topics, 320 data bytes   the LP position: WETH, tickLower, liquidity
 * 0x8be0079c…  OwnershipTransferred, standard
 * ```
 *
 * `topics[1]` is the token: `0x6399e2bd…2a6fd` reads `symbol() = "ROBINDOG"`.
 * `topics[2]` has no code, so it is an EOA — the creator, not a pool.
 *
 * **AND THE FIRST WINDOW I SWEPT RETURNED ZERO, WHICH WAS NOT THE ANSWER.** 300,000
 * blocks back from head produced no logs at all. Treating that as "the factory is
 * dead" would have been the filter-matched-nothing failure this project keeps hitting;
 * widening to the whole chain hit the response-size cap instead, which proves the
 * opposite. The factory's activity is OLD. Where it stops is a measurement this makes,
 * and it is the single most decision-relevant number in Part 3.
 */
import { AbiCoder, id } from 'ethers';
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { RpcClient } from '../adapters/token-updates/rpc.js';
import { ReadOnlyRpc } from '../bot/rpc.js';

const CHAIN = 'robinhood';
const RPC_URL = 'https://robinhood-mainnet.g.alchemy.com/v2/{key}';
const abi = AbiCoder.defaultAbiCoder();

const NOXA_FACTORY = '0xd9ec2db5f3d1b236843925949fe5bd8a3836fccb';
const V3_FACTORY = '0x1f7d7550b1b028f7571e69a784071f0205fd2efa';

/** Identified by sampling, per the header. Not pasted from anywhere. */
const T_LAUNCH_A = '0x1461370115e1c2be79cb529f8cfcbd11316e789d9c6099fc83417b0b4c48c62a';
const T_LAUNCH_B = '0xdb51ea9ad51ab453a65a4cb7e60c3cb378c9501bb002609f8f97778fb6c4235a';

const SYMBOL = id('symbol()').slice(0, 10);

interface Log {
  address: string; topics: string[]; data: string;
  blockNumber: string; blockTimestamp?: string; transactionHash: string;
}

const addrOf = (topic: string): string => `0x${topic.slice(26)}`.toLowerCase();

/**
 * A SPAN-ADAPTIVE SWEEP. ROBINHOOD.md records the three refusal types and the opposite
 * responses they need; this only ever meets the result cap, so it narrows on a refusal
 * and widens on a clean read, with the span never exceeding the cap the endpoint names.
 */
async function sweep(
  rpc: ReadOnlyRpc, address: string, from: number, to: number,
): Promise<Log[]> {
  const out: Log[] = [];
  let cursor = from;
  let span = 2_000_000;
  let requests = 0;
  while (cursor <= to) {
    const end = Math.min(cursor + span - 1, to);
    try {
      const got = (await rpc.call('eth_getLogs', [{
        address, fromBlock: `0x${cursor.toString(16)}`, toBlock: `0x${end.toString(16)}`,
      }])) as Log[];
      requests += 1;
      out.push(...got);
      cursor = end + 1;
      /* Widen only on a comfortably small result; a near-cap read stays put. */
      if (got.length < 3_000) span = Math.min(span * 2, 4_000_000);
    } catch (err) {
      const m = (err as Error).message;
      if (!/exceed|limit|response size/i.test(m)) throw err;
      span = Math.max(Math.floor(span / 4), 5_000);
      if (span <= 5_000) {
        /* The floor the endpoint itself guarantees. A floor that cannot satisfy the
         * endpoint is a livelock rather than a retry -- ROBINHOOD.md, section 5. */
        const got = (await rpc.call('eth_getLogs', [{
          address, fromBlock: `0x${cursor.toString(16)}`,
          toBlock: `0x${Math.min(cursor + 4_999, to).toString(16)}`,
        }])) as Log[];
        requests += 1;
        out.push(...got);
        cursor = Math.min(cursor + 5_000, to + 1);
      }
    }
  }
  log.info('factory sweep complete', { address, from, to, requests, logs: out.length });
  return out;
}

async function main(): Promise<void> {
  const key = process.env['ALCHEMY_API_KEY'];
  if (!key) throw new Error('ALCHEMY_API_KEY is not set');
  const app = await bootstrap();
  const c = await app.pool.connect();
  const inner = new RpcClient(RPC_URL.replace('{key}', key), 60_000, 3_000_000);
  const rpc = new ReadOnlyRpc(inner);

  try {
    const head = Number(BigInt(String(await rpc.call('eth_blockNumber', []))));
    const logs = await sweep(rpc, NOXA_FACTORY, 0, head);

    const launches = logs.filter((l) => l.topics[0] === T_LAUNCH_A);
    const byTopic = new Map<string, number>();
    for (const l of logs) byTopic.set(l.topics[0]!, (byTopic.get(l.topics[0]!) ?? 0) + 1);

    /* ---- 3A.iv  THE LAUNCH RATE, WHICH THE BRIEF SAYS TO RESOLVE FIRST ---- */
    const perDay = new Map<string, number>();
    let noTs = 0;
    for (const l of launches) {
      if (l.blockTimestamp === undefined) { noTs += 1; continue; }
      const d = new Date(Number(BigInt(l.blockTimestamp)) * 1000)
        .toISOString().slice(0, 10);
      perDay.set(d, (perDay.get(d) ?? 0) + 1);
    }
    const days = [...perDay.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1);
    const counts = days.map((d) => d[1]).sort((a, b) => a - b);
    const median = counts.length === 0 ? null
      : counts[Math.floor(counts.length / 2)]!;

    const blocks = launches.map((l) => Number(BigInt(l.blockNumber)));
    const lastBlock = blocks.length === 0 ? null : Math.max(...blocks);

    log.info('3A.i/iv  NOXA LAUNCH FACTORY — WHAT IT ACTUALLY EMITTED', {
      factory: NOXA_FACTORY,
      head,
      logs_total: logs.length,
      by_topic: Object.fromEntries(byTopic),
      launches: launches.length,
      first_launch_block: blocks.length === 0 ? 'NONE' : Math.min(...blocks),
      last_launch_block: lastBlock ?? 'NONE',
      blocks_since_last_launch: lastBlock === null ? 'n/a' : head - lastBlock,
      logs_without_a_timestamp: noTs,
      active_days: days.length,
      launches_per_day_median: median,
      launches_per_day_first_5: days.slice(0, 5).map((d) => `${d[0]} ${String(d[1])}`),
      launches_per_day_last_5: days.slice(-5).map((d) => `${d[0]} ${String(d[1])}`),
    });

    /* ---- 3A.ii  THE VANITY CLAIM, ON THE WHOLE POPULATION ----------------- */
    const tokens = [...new Set(launches.map((l) => addrOf(l.topics[1] ?? '')))];
    const suffix4663 = tokens.filter((t) => t.endsWith('4663'));
    log.info('3A.ii  VANITY ADDRESSES ENDING 4663', {
      distinct_tokens: tokens.length,
      ending_4663: suffix4663.length,
      share: tokens.length === 0 ? 'n/a'
        : `${(100 * suffix4663.length / tokens.length).toFixed(2)}%`,
      examples_matching: suffix4663.slice(0, 5),
      examples_NOT_matching: tokens.filter((t) => !t.endsWith('4663')).slice(0, 5),
      verdict: tokens.length === 0 ? 'NO TOKENS — proves nothing'
        : suffix4663.length === 0 ? 'CLAIM FAILS — zero of them end 4663'
          : suffix4663.length === tokens.length ? 'CLAIM HOLDS on every token'
            : 'CLAIM HOLDS ONLY IN PART — see the share',
    });

    /* ---- 3A.i  WHAT DID OUR OWN BOT ACTUALLY BUY AND QUALIFY? ------------- */
    const noxaSet = new Set(tokens);
    const ours = (await c.query<{ token: string; launchpad: string | null; mode: string;
      fee: number | null; status: string }>(
      `select lower(token) as token, lower(launchpad) as launchpad, mode,
              fee::int, status
         from bot_trades where chain = $1`, [CHAIN])).rows;
    const oursNoxa = ours.filter((r) => noxaSet.has(r.token));
    const padCounts = new Map<string, number>();
    for (const r of ours) {
      const k = r.launchpad ?? 'NULL';
      padCounts.set(k, (padCounts.get(k) ?? 0) + 1);
    }
    log.info('3A.i  OUR QUALIFYING POOLS vs THE LAUNCHPAD', {
      our_rows_total: ours.length,
      our_rows_whose_token_NOXA_launched: oursNoxa.length,
      share: ours.length === 0 ? 'n/a'
        : `${(100 * oursNoxa.length / ours.length).toFixed(2)}%`,
      our_launchpads_by_frequency: [...padCounts.entries()]
        .sort((a, b) => b[1] - a[1]).slice(0, 10)
        .map(([k, v]) => `${k} ${String(v)}`),
      note: 'launchpad here is the Initialize transaction target, per LAUNCHBOT.md',
    });

    /* ---- Are NOXA tokens even v4? Our whole execution stack is v4. -------- */
    const v4Pools = (await c.query<{ n: string }>(
      `select count(*)::text n from v4_pool_init
        where lower(currency0) = any($1) or lower(currency1) = any($1)`,
      [tokens.slice(0, 20_000)])).rows[0];
    log.info('DO NOXA TOKENS APPEAR AS v4 POOLS AT ALL?', {
      noxa_tokens_checked: Math.min(tokens.length, 20_000),
      v4_pool_init_rows_naming_one: v4Pools?.n ?? 'query failed',
      why_it_matters: 'our entire execution stack is v4 through the Universal Router; '
        + 'a launchpad that only creates v3 pools is unreachable by it',
    });

    /* ---- A SAMPLE, DECODED, because an aggregate is a hypothesis ---------- */
    const sample = launches.slice(-5);
    const decoded: string[] = [];
    for (const l of sample) {
      const token = addrOf(l.topics[1] ?? '');
      let sym = '(unreadable)';
      try {
        const r = String(await rpc.call('eth_call', [{ to: token, data: SYMBOL }, 'latest']));
        if (r.length > 2) sym = String(abi.decode(['string'], r)[0]);
      } catch { sym = '(revert)'; }
      decoded.push(`${token} ${sym} creator=${addrOf(l.topics[2] ?? '')} `
        + `block=${String(BigInt(l.blockNumber))} tx=${l.transactionHash}`);
    }
    log.info('THE LAST FIVE NOXA LAUNCHES, DECODED INDIVIDUALLY', {
      note: 'an aggregate is a hypothesis; these are openable',
      sample: decoded,
      v3_factory_named_in_every_launch_event: V3_FACTORY,
    });
  } finally {
    c.release(); await app.pool.end();
  }
}

void main().catch((e: unknown) => { log.error('launchpad-survey failed', errorFields(e)); process.exit(1); });

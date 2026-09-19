/**
 * `npm run poolstrade-survey` — PART 4A AND 4B: POOLS.TRADE, CHECKED ON CHAIN.
 *
 * Part 3 verified NOXA (dead since 2026-07-11) and The Odyssey (4 launches) and never
 * looked at Pools.trade — Uniswap Labs' own launchpad. This is that check.
 *
 * ===========================================================================
 * A CORRECTION PART 3 FORCED, BEFORE ANYTHING ELSE
 * ===========================================================================
 *
 * **`0x58daec3116aae6d93017baaea7749052e8a04fa7` IS NOT A LAUNCHPAD.** Its own views
 * say `name() = "Uniswap v4 Positions NFT"`, `symbol() = "UNI-V4-POSM"` — it is the
 * **Uniswap v4 PositionManager**, the canonical contract you call to mint a liquidity
 * position. `ROBINHOOD.md` section 8 calls it "a launchpad", built a finding on it
 * ("the dominant launchpad decayed five-fold"), and I repeated that in Part 3.
 *
 * So `tx.to` on an `Initialize` transaction is **not a launchpad identifier at all.**
 * Both values we ever saw are Uniswap's own contracts:
 *
 * ```
 * 0x8366a39cc670…  the PoolManager      — initialize() called directly
 * 0x58daec3116aa…  the PositionManager  — initialize + mint via multicall
 * ```
 *
 * A real launchpad sits in front of both. Pools.trade is one, and its entry contract is
 * what `tx.to` shows for its launches.
 *
 * ===========================================================================
 * WHY WE TRADED ZERO OF THEM, AND IT IS NOT "WE NEVER SAW THEM"
 * ===========================================================================
 *
 * **MEASURED on BCAT (`0xb968a173…a90d`), a real Pools.trade launch:**
 *
 * ```
 * TokenCreated   factory 0x000000e2…d49b, block 66,660,815
 * Initialize     SAME BLOCK, SAME TRANSACTION
 *                currency0 = 0x0 (native ETH)   currency1 = BCAT
 *                fee = 2500 (0.25%)   tickSpacing 25   hooks = 0x0
 * tx.to          0x0000ffffbe8efe702c8703ae3477ff5de3d319c0   the entry contract
 * tx.value       3.8 ETH   <- the creator funds it in the creation transaction
 * totalSupply    1e27 / 18 decimals = exactly 1,000,000,000
 * ```
 *
 * Our rule rejects that **twice over**:
 *
 * ```
 * ALLOWED_FEES = [100, 500, 10000]   fee 2500  -> REJECTED
 * LAUNCHPADS   = [PositionManager, PoolManager]   entry 0x0000ffff… -> REJECTED
 * ```
 *
 * **So the bot saw every one of these and threw them away, on two allow-lists both
 * derived from a corpus whose launchpad attribution was wrong.** That is a filter
 * matching nothing being treated as a finding, at the level of the rule itself.
 *
 * ===========================================================================
 * 4B — THE LOCK, AND THE REFUTATION CONDITION STATED FIRST
 * ===========================================================================
 *
 * The claim is that liquidity is permanently locked, so it cannot be pulled during the
 * hold. **10 of our 12 live losses were liquidity pulled during the hold.**
 *
 * **WHAT WOULD PROVE THE CLAIM FALSE:** any material share of Pools.trade pools reading
 * `liquidity = 0` some hours after creation. A locked position cannot go to zero.
 *
 * **WHAT WOULD MAKE IT TRUE BUT USELESS TO US:** the lock holding while the price still
 * collapses, or the sell still failing. A pool can keep its liquidity and still pay
 * nothing, and §6A.3 is the record of confusing those two. So this reports the
 * liquidity fraction ONLY — it is 4C's job to say whether we could have sold.
 *
 * The control is non-Pools.trade launches over **the same window**, because a chain-wide
 * quiet day would otherwise read as a lock.
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { RpcClient } from '../adapters/token-updates/rpc.js';
import { ReadOnlyRpc } from '../bot/rpc.js';
import { readPoolLiquidity } from '../bot/pool-state.js';
import { TOPICS } from '../adapters/token-updates/decode.js';

const CHAIN = 'robinhood';
const RPC_URL = 'https://robinhood-mainnet.g.alchemy.com/v2/{key}';
const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const CU_CEILING = 500_000;

/** UNVERIFIED third-party addresses, verified by this run. */
const PT_FACTORY = '0x000000e200088d55c39a11f609e5f667729ad49b';
const PT_ENTRY_CURRENT = '0x0000ffffbe8efe702c8703ae3477ff5de3d319c0';
const PT_ENTRY_ORIGINAL = '0x00004c4ccc709ef590f7c81102c0689f0263d4e9';

/**
 * The factory's ONE event, found by pulling its logs with NO topic filter and grouping
 * by topic0 — never retyped from a signature guess. Data word 0 is the token, which was
 * confirmed by `symbol()` resolving on six consecutive records (BCAT, Bcat, WhiteBull,
 * ASKR, BabyChimp, BIDDY).
 *
 * **THE FACTORY IS SWEPT, NOT THE ENTRY CONTRACTS, AND THAT IS DELIBERATE.** The brief
 * warns that Crowd Launch auctions fire from a fresh contract per auction and that
 * filtering on the current entry contract drops ~40% of launches. The factory address
 * is constant, so sweeping it catches every launch regardless of which entry point or
 * per-auction contract produced it.
 */
const TOKEN_CREATED = '0x4ef8284ecf42d4cd19686572ffd87f630858c82398911e776cb831de35eddbf4';

const BLOCKS_PER_DAY = 864_000;   /* 10 blocks/s, measured over 935,564 blocks */

interface Log { topics: string[]; data: string; blockNumber: string; transactionHash: string }

async function sweep(
  rpc: ReadOnlyRpc, filter: Record<string, unknown>, from: number, to: number,
  startSpan = 2_000_000,
): Promise<Log[]> {
  const out: Log[] = []; let cur = from; let span = startSpan;
  while (cur <= to) {
    const end = Math.min(cur + span - 1, to);
    try {
      const got = (await rpc.call('eth_getLogs', [{
        ...filter, fromBlock: `0x${cur.toString(16)}`, toBlock: `0x${end.toString(16)}`,
      }])) as Log[];
      out.push(...got); cur = end + 1;
      if (got.length < 3_000) span = Math.min(span * 2, 4_000_000);
    } catch (err) {
      if (!/exceed|limit|response size/i.test((err as Error).message)) throw err;
      span = Math.max(Math.floor(span / 4), 2_000);
    }
  }
  return out;
}

const tokenOf = (l: Log): string => `0x${l.data.slice(2).slice(24, 64)}`.toLowerCase();
const addrTopic = (t: string): string => `0x${t.slice(26)}`.toLowerCase();

async function main(): Promise<void> {
  const key = process.env['ALCHEMY_API_KEY'];
  if (!key) throw new Error('ALCHEMY_API_KEY is not set');
  const app = await bootstrap();
  const c = await app.pool.connect();
  const inner = new RpcClient(RPC_URL.replace('{key}', key), 60_000, CU_CEILING);
  const rpc = new ReadOnlyRpc(inner);

  try {
    const head = Number(BigInt(String(await rpc.call('eth_blockNumber', []))));

    /* ---- 4A.1  the addresses, from their own views ------------------------ */
    const ident: Record<string, string> = {};
    for (const [name, a] of [['factory', PT_FACTORY], ['entry_current', PT_ENTRY_CURRENT],
      ['entry_original', PT_ENTRY_ORIGINAL], ['0x58daec_OUR_LAUNCHPAD', '0x58daec3116aae6d93017baaea7749052e8a04fa7'],
      ['0x8366a3_OUR_OTHER', POOL_MANAGER]] as Array<[string, string]>) {
      const code = String(await rpc.call('eth_getCode', [a, 'latest']));
      const size = code.startsWith('0x') ? (code.length - 2) / 2 : 0;
      let nm = '';
      try {
        const r = String(await rpc.call('eth_call', [{ to: a, data: '0x06fdde03' }, 'latest']));
        if (r.length > 130) {
          const off = parseInt(r.slice(2, 66), 16);
          const len = parseInt(r.slice(66 + off * 2 - 64, 66 + off * 2), 16);
          nm = Buffer.from(r.slice(66 + off * 2, 66 + off * 2 + len * 2), 'hex').toString('utf8');
        }
      } catch { nm = '(no name())'; }
      ident[name] = `${a} code=${size}B name=${nm || '(none)'}`;
    }
    log.info('4A.1  THE ADDRESSES, IDENTIFIED FROM THEIR OWN VIEWS', {
      ...ident,
      THE_CORRECTION: '0x58daec is the Uniswap v4 PositionManager, NOT a launchpad. '
        + 'ROBINHOOD.md section 8 calls it one and Part 3 repeated that.',
    });

    /* ---- 4A.2  the launch rate, from BLOCK NUMBERS ------------------------ */
    const from30 = head - 30 * BLOCKS_PER_DAY;
    const created = await sweep(rpc, { address: PT_FACTORY, topics: [TOKEN_CREATED] },
      Math.max(0, from30), head);
    const perDay = new Map<number, number>();
    for (const l of created) {
      const d = Math.floor(Number(BigInt(l.blockNumber)) / BLOCKS_PER_DAY);
      perDay.set(d, (perDay.get(d) ?? 0) + 1);
    }
    const counts = [...perDay.values()].sort((a, b) => a - b);
    const med = counts.length === 0 ? null : counts[Math.floor(counts.length / 2)]!;
    const blocks = created.map((l) => Number(BigInt(l.blockNumber)));

    log.info('4A.2  POOLS.TRADE LAUNCH RATE — FROM BLOCK NUMBERS, NOT TIMESTAMPS', {
      note: 'Part 3 computed a rate from block_times and undercounted TENFOLD because '
        + 'only 15.6% of rows were dated. This buckets by block number.',
      window: `${Math.max(0, from30)}..${head} (30 days)`,
      TokenCreated_events: created.length,
      distinct_tokens: new Set(created.map(tokenOf)).size,
      first_block: blocks.length === 0 ? 'NONE' : Math.min(...blocks),
      last_block: blocks.length === 0 ? 'NONE' : Math.max(...blocks),
      blocks_since_last: blocks.length === 0 ? 'n/a' : head - Math.max(...blocks),
      day_buckets: perDay.size,
      launches_per_day_median: med,
      launches_per_day_max: counts[counts.length - 1] ?? null,
      last_6_days: [...perDay.entries()].sort((a, b) => a[0] - b[0]).slice(-6)
        .map(([d, n]) => `bucket${d}: ${n}`),
    });

    /* ---- 4A.3  share of the chain's v4 initializations -------------------- */
    /* ONE DAY, because an Initialize sweep is dense -- ~10,600/day. */
    const dFrom = head - BLOCKS_PER_DAY;
    const inits = await sweep(rpc, { address: POOL_MANAGER, topics: [TOPICS.initializeV4] },
      dFrom, head, 40_000);
    const ptTokens = new Set(created.map(tokenOf));
    const ptInits = inits.filter((l) =>
      ptTokens.has(addrTopic(l.topics[2] ?? '')) || ptTokens.has(addrTopic(l.topics[3] ?? '')));
    const feeOf = (l: Log): number => parseInt(l.data.slice(2).slice(0, 64), 16);

    log.info('4A.3  WHAT SHARE OF THE CHAIN IS POOLS.TRADE', {
      window: `${dFrom}..${head} (1 day)`,
      all_v4_initializations: inits.length,
      POOLS_TRADE_initializations: ptInits.length,
      share: inits.length === 0 ? 'n/a'
        : `${(100 * ptInits.length / inits.length).toFixed(2)}%`,
      pools_trade_fee_tiers: Object.fromEntries(
        [...ptInits.reduce((m, l) => m.set(feeOf(l), (m.get(feeOf(l)) ?? 0) + 1),
          new Map<number, number>()).entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)),
      ALL_fee_tiers_top5: Object.fromEntries(
        [...inits.reduce((m, l) => m.set(feeOf(l), (m.get(feeOf(l)) ?? 0) + 1),
          new Map<number, number>()).entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)),
    });

    /* ---- 4A.4  did WE ever trade one? ------------------------------------ */
    const ours = (await c.query<{ token: string; launchpad: string | null; fee: number | null }>(
      `select lower(token) as token, lower(launchpad) as launchpad, fee::int
         from bot_trades where chain = $1`, [CHAIN])).rows;
    log.info('4A.4  OF THE 130 ROWS THE BOT TRADED, HOW MANY WERE POOLS.TRADE', {
      our_rows: ours.length,
      rows_whose_token_POOLS_TRADE_created: ours.filter((r) => ptTokens.has(r.token)).length,
      our_fee_tiers: Object.fromEntries(
        [...ours.reduce((m, r) => m.set(r.fee ?? -1, (m.get(r.fee ?? -1) ?? 0) + 1),
          new Map<number, number>()).entries()]),
      WHY_ZERO: 'NOT because we never saw them. Our ALLOWED_FEES is [100,500,10000] and '
        + 'Pools.trade uses 2500; our LAUNCHPADS list holds only the PoolManager and '
        + 'the PositionManager, and Pools.trade Initialize transactions go to its own '
        + 'entry contract. The rule rejects them twice.',
    });

    /* ---- 4B  THE LOCK ----------------------------------------------------- */
    /*
     * Pools created between 48h and 24h ago, so every one has had at least a full day
     * for its liquidity to be pulled.
     */
    const wFrom = head - 2 * BLOCKS_PER_DAY;
    const wTo = head - BLOCKS_PER_DAY;
    const wInits = await sweep(rpc, { address: POOL_MANAGER, topics: [TOPICS.initializeV4] },
      wFrom, wTo, 40_000);
    /*
     * ===================================================================
     * THE CANONICAL POOL, AND THE LOOSE MATCH WAS WRONG
     * ===================================================================
     *
     * The first version of this matched "any pool whose token the Pools.trade factory
     * created". That is too loose, and the fee tiers gave it away: of 601 such pools in
     * one day only **300 carried fee 2500**, the rest sitting at 100, 800000, 808670
     * and 991200. **Those are pools OTHER PEOPLE opened for a Pools.trade token**, and
     * nothing about Pools.trade's lock applies to them.
     *
     * The canonical pool is the one created **in the same transaction as the
     * `TokenCreated` event** — that is what "the launchpad mints the supply into a
     * locked position" means, and it is exact rather than inferred from a fee tier.
     *
     * **BOTH POPULATIONS ARE REPORTED**, because they answer different questions: the
     * canonical set is whether the lock works, and the loose set is what a bot filtering
     * only on "this token came from Pools.trade" would actually buy. A bot using the
     * loose rule gets the unlocked copies too.
     */
    const ptTxs = new Set(created.map((l) => l.transactionHash.toLowerCase()));
    const wPtCanon = wInits.filter((l) => ptTxs.has(l.transactionHash.toLowerCase()));
    const wPtLoose = wInits.filter((l) =>
      ptTokens.has(addrTopic(l.topics[2] ?? '')) || ptTokens.has(addrTopic(l.topics[3] ?? '')));
    const canonSet = new Set(wPtCanon.map((l) => l.topics[1]));
    const wPtSecondary = wPtLoose.filter((l) => !canonSet.has(l.topics[1]));
    const looseSet = new Set(wPtLoose.map((l) => l.topics[1]));
    const wOther = wInits.filter((l) => !looseSet.has(l.topics[1]));
    const wPt = wPtCanon;

    const sampleOf = <T>(xs: T[], n: number): T[] => {
      const step = Math.max(1, Math.floor(xs.length / n));
      return xs.filter((_, i) => i % step === 0).slice(0, n);
    };
    const SAMPLE = 150;
    const ptS = sampleOf(wPtCanon, SAMPLE);
    const secS = sampleOf(wPtSecondary, SAMPLE);
    const otS = sampleOf(wOther, SAMPLE);

    log.info('4B  BEFORE THE FIRST PAID CALL', {
      window: `${wFrom}..${wTo} (created 24-48 h ago)`,
      pools_trade_CANONICAL_same_tx_as_TokenCreated: wPtCanon.length,
      pools_trade_token_but_SOMEONE_ELSES_POOL: wPtSecondary.length,
      everything_else: wOther.length,
      canonical_fee_tiers: Object.fromEntries(
        [...wPtCanon.reduce((m, l) => m.set(feeOf(l), (m.get(feeOf(l)) ?? 0) + 1),
          new Map<number, number>()).entries()].sort((a4, b4) => b4[1] - a4[1])),
      sampled: `${ptS.length} canonical / ${secS.length} secondary / ${otS.length} other`,
      estimate_cu: (ptS.length + secS.length + otS.length) * 26,
      ceiling_cu: CU_CEILING,
      REFUTATION_STATED_FIRST: 'any material share of Pools.trade pools reading '
        + 'liquidity = 0 now would disprove the lock. A locked position cannot go to zero.',
      WHAT_THIS_DOES_NOT_SHOW: 'liquidity surviving is NOT the same as being able to '
        + 'sell. 6A.3 is the record of confusing those. 4C answers that.',
    });

    /*
     * ===================================================================
     * A ZERO `liquidity` IS NOT NECESSARILY A PULLED POSITION
     * ===================================================================
     *
     * The v4 pool state's `liquidity` at offset 3 is the **ACTIVE liquidity at the
     * current tick**, not the position's existence. A single-sided position has a
     * bounded range; if the price moves outside it, `liquidity` reads 0 while the
     * position is untouched. **Reporting that as a rug would be exactly the
     * measure-the-wrong-quantity error §6A.3 records.**
     *
     * So every zero is followed up with the PoolManager's own ERC-20 balance of the
     * token. The PoolManager is the singleton that custodies every v4 pool's reserves,
     * and these tokens are days old with one canonical pool each, so its balance is
     * effectively that pool's reserve.
     *
     *   liquidity 0, PoolManager still holds the token  ->  OUT OF RANGE, not pulled
     *   liquidity 0, PoolManager holds nothing          ->  the tokens LEFT. Pulled.
     *
     * The two are reported separately and never summed.
     */
    const BALANCE_OF = '0x70a08231';
    const liqZero = async (ls: Log[], label: string): Promise<{
      n: number; zero: number; unread: number; outOfRange: number; drained: number;
      examples: string[];
    }> => {
      let zero = 0; let unread = 0; let outOfRange = 0; let drained = 0;
      const examples: string[] = [];
      for (const l of ls) {
        const pid = (l.topics[1] ?? '').toLowerCase();
        const liq = await readPoolLiquidity(rpc, pid, 'latest');
        if (liq === null) { unread += 1; continue; }
        if (liq !== 0n) continue;
        zero += 1;
        const c0 = addrTopic(l.topics[2] ?? '');
        const c1 = addrTopic(l.topics[3] ?? '');
        const token = c0 === '0x0000000000000000000000000000000000000000' ? c1 : c0;
        let bal: bigint | null = null;
        try {
          const r = String(await rpc.call('eth_call', [{
            to: token, data: BALANCE_OF + '0'.repeat(24) + POOL_MANAGER.slice(2),
          }, 'latest']));
          if (r.startsWith('0x') && r.length >= 66) bal = BigInt(r);
        } catch { bal = null; }
        if (bal !== null && bal > 0n) outOfRange += 1; else drained += 1;
        if (examples.length < 8) {
          examples.push(`${pid.slice(0, 18)} token=${token.slice(0, 12)} `
            + `PoolManager_balance=${bal === null ? 'UNREADABLE'
              : bal === 0n ? 'ZERO — the tokens LEFT'
                : `${(Number(bal) / 1e18).toFixed(0)} — still custodied, OUT OF RANGE`}`);
        }
      }
      log.info(`zero-liquidity follow-up: ${label}`, {
        zero_liquidity: zero, still_custodied_OUT_OF_RANGE: outOfRange,
        PoolManager_holds_NOTHING_pulled: drained, examples,
      });
      return { n: ls.length, zero, unread, outOfRange, drained, examples };
    };
    const ptR = await liqZero(ptS, 'POOLS.TRADE CANONICAL');
    const secR = await liqZero(secS, "POOLS.TRADE TOKEN, SOMEONE ELSE'S POOL");
    const otR = await liqZero(otS, 'EVERYTHING ELSE');
    const share = (r: { n: number; zero: number; unread: number }): string => {
      const d = r.n - r.unread;
      return d === 0 ? 'NO READABLE POOLS' : `${(100 * r.zero / d).toFixed(1)}%`;
    };

    log.info('*** 4B  THE HEADLINE — LIQUIDITY AT ZERO, 24-48 H AFTER CREATION ***', {
      POOLS_TRADE_CANONICAL: `${ptR.zero} of ${ptR.n - ptR.unread} at ZERO = ${share(ptR)}`
        + ` (unreadable ${ptR.unread})`,
      POOLS_TRADE_TOKEN_SOMEONE_ELSES_POOL:
        `${secR.zero} of ${secR.n - secR.unread} at ZERO = ${share(secR)}`
        + ` (unreadable ${secR.unread})`,
      EVERYTHING_ELSE: `${otR.zero} of ${otR.n - otR.unread} at ZERO = ${share(otR)}`
        + ` (unreadable ${otR.unread})`,
      why_three_groups: 'the middle group is the trap: a bot filtering on "this token '
        + 'came from Pools.trade" buys unlocked copies of locked tokens',
      same_window_both: `${wFrom}..${wTo}`,
      /*
       * THE VERDICT TURNS ON `drained`, NOT ON `zero`. A pool whose price left the
       * position's range reads zero liquidity with the position intact, and calling
       * that a rug would measure the wrong quantity.
       */
      DRAINED_pools_trade_canonical: `${ptR.drained} of ${ptR.n}`,
      DRAINED_everything_else: `${otR.drained} of ${otR.n}`,
      verdict: ptR.n - ptR.unread === 0 ? 'NO POOLS.TRADE POOLS READABLE — proves nothing'
        : ptR.drained === 0
          ? 'LOCK HOLDS: no canonical pool had its tokens leave the PoolManager'
          : `LOCK DOES NOT HOLD LITERALLY: ${ptR.drained} canonical pool(s) drained`,
      cu: inner.cuSpent,
    });
  } finally { c.release(); await app.pool.end(); }
}

void main().catch((e: unknown) => { log.error('poolstrade-survey failed', errorFields(e)); process.exit(1); });

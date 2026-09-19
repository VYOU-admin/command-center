/**
 * `npm run loss-anatomy` — 6A: IS THE DEEP LOSS ONE MECHANISM OR SEVERAL?
 *
 * §6N established the shape: every exit rule sits at −82% to −84% at p10 and p25, and
 * the exit rule is irrelevant to that. **The losers are the whole problem.** This
 * characterises them and nothing else — no exit timing, no entry signal.
 *
 * ===========================================================================
 * WHAT IS MEASURED, AND WHY IT IS ONE SWEEP PER POOL
 * ===========================================================================
 *
 * For each of the 379 signal-firing launches, the pool's entire swap history over the
 * first ~20 minutes: **one sparse `eth_getLogs`, 60 CU.** From it, every SELL (token
 * into the pool), its size as a share of the fixed 1e27 supply, and when it landed.
 * The largest sell's transaction is then read once to learn **who** sold — the v4 Swap
 * `sender` topic is the Universal Router, not the trader (§6H.3), so the seller is
 * `tx.from`.
 *
 * **THE CREATOR IS `tx.from` OF THE CREATION TRANSACTION**, already stored in
 * `bot_runner_features.creator` from 5B. No new derivation.
 *
 * ===========================================================================
 * THE QUESTION THIS HAS TO ANSWER HONESTLY
 * ===========================================================================
 *
 * **§6H.3 decoded ONE dump and the whole document has been reasoning from it since.**
 * A single decoded record is evidence that the mechanism exists, not that it is the
 * only one. So this asks, per deep loser: does the largest single sell account for the
 * fall, is its sender the creator, and are there launches where the creator never sells
 * at all? **If some deep losses have another cause, a rule aimed only at creator dumps
 * cannot work, and that has to surface before 6B is built on it.**
 */
import { AbiCoder } from 'ethers';
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { RpcClient } from '../adapters/token-updates/rpc.js';
import { ReadOnlyRpc } from '../bot/rpc.js';
import { TOPICS } from '../adapters/token-updates/decode.js';

const CHAIN = 'robinhood';
const RPC_URL = 'https://robinhood-mainnet.g.alchemy.com/v2/{key}';
const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const abi = AbiCoder.defaultAbiCoder();
const CU_CEILING = 400_000;
const SUPPLY = 1e27;
const ENTRY_BLOCKS = 150;
const WINDOW = 12_150;          /* entry + the 12,000-block grid §6N used */
const DEEP = -0.70;             /* §6N's "deep loss" line */
const MAX_TX_READS = 4;         /* the biggest sells only */

interface Log { topics: string[]; data: string; blockNumber: string; transactionHash: string }
const sgn = (v: bigint): bigint => v >= (1n << 255n) ? v - (1n << 256n) : v;
const quant = (xs: number[], p: number): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]!;
};
const pc = (x: number | null): string => x === null ? 'n/a' : `${(100 * x).toFixed(1)}%`;

async function main(): Promise<void> {
  const key = process.env['ALCHEMY_API_KEY'];
  if (!key) throw new Error('ALCHEMY_API_KEY is not set');
  const app = await bootstrap();
  const c = await app.pool.connect();
  const inner = new RpcClient(RPC_URL.replace('{key}', key), 60_000, CU_CEILING);
  const rpc = new ReadOnlyRpc(inner);

  try {
    await c.query(`create table if not exists bot_loss_anatomy (
      chain text not null, pool_id text not null, init_block bigint not null,
      outcome numeric,
      creator text, creator_sold boolean, creator_sold_share numeric,
      creator_sell_count integer, creator_first_sell_s integer,
      biggest_sell_share numeric, biggest_sell_s integer, biggest_sell_by text,
      biggest_sell_is_creator boolean,
      total_sold_share numeric, sell_count integer,
      measured_at timestamptz not null default now(),
      primary key (chain, pool_id)
    )`);

    /* The signal-firing population with a stored outcome at the final grid point. */
    const pools = (await c.query<{ pool_id: string; init_block: string; creator: string | null;
      outcome: string | null }>(
      `select f.pool_id, f.init_block::text, f.creator,
              (case when t.sell_executes then (t.eth_out - t.eth_in)/t.eth_in
                    when t.sell_executes = false then -1 end)::text as outcome
         from bot_runner_features f
         join bot_trade_path t
           on t.chain = f.chain and t.pool_id = f.pool_id and t.grid_offset = 12000
        where f.chain = $1 and f.creator_share >= 0.40
        order by f.init_block`, [CHAIN])).rows;

    const have = new Set((await c.query<{ pool_id: string }>(
      `select pool_id from bot_loss_anatomy where chain=$1`, [CHAIN])).rows
      .map((r) => r.pool_id));

    log.info('6A  BEFORE THE FIRST PAID CALL', {
      signal_firing_pools_with_an_outcome: pools.length,
      already_done: have.size,
      deep_loss_line: `${100 * DEEP}%`,
      estimate_cu: (pools.length - have.size) * (60 + MAX_TX_READS * 15),
      ceiling_cu: CU_CEILING,
      note: '§6H.3 decoded ONE dump. One record shows a mechanism EXISTS, not that it '
        + 'is the only one. This checks whether the rest look the same.',
    });

    let n = 0;
    for (const p of pools) {
      if (have.has(p.pool_id)) { n += 1; continue; }
      const initBlock = Number(p.init_block);
      let sw: Log[];
      try {
        sw = (await rpc.call('eth_getLogs', [{
          address: POOL_MANAGER, topics: [TOPICS.swapV4, p.pool_id],
          fromBlock: `0x${initBlock.toString(16)}`,
          toBlock: `0x${(initBlock + WINDOW).toString(16)}`,
        }])) as Log[];
      } catch { continue; }

      /* Sells only: token INTO the pool, i.e. the swapper's token side negative. */
      interface Sell { off: number; share: number; tx: string }
      const sells: Sell[] = [];
      let totalSold = 0;
      for (const x of sw) {
        const d = x.data.slice(2);
        const a1 = sgn(BigInt(`0x${d.slice(64, 128)}`));   /* currency1 = the token */
        if (a1 >= 0n) continue;
        const share = Number(-a1) / SUPPLY;
        totalSold += share;
        sells.push({ off: Number(BigInt(x.blockNumber)) - initBlock, share, tx: x.transactionHash });
      }
      sells.sort((a, b) => b.share - a.share);

      /* WHO sold, on the biggest few only — the sender topic is the router. */
      const byTx = new Map<string, string>();
      for (const s of sells.slice(0, MAX_TX_READS)) {
        if (byTx.has(s.tx)) continue;
        try {
          const tx = (await rpc.call('eth_getTransactionByHash', [s.tx])) as
            { from?: string } | null;
          if (tx?.from) byTx.set(s.tx, tx.from.toLowerCase());
        } catch { /* unknown stays unknown */ }
      }

      const creator = p.creator;
      const creatorSells = sells.filter((s) => byTx.get(s.tx) === creator);
      const biggest = sells[0];
      await c.query(
        `insert into bot_loss_anatomy (chain, pool_id, init_block, outcome, creator,
           creator_sold, creator_sold_share, creator_sell_count, creator_first_sell_s,
           biggest_sell_share, biggest_sell_s, biggest_sell_by, biggest_sell_is_creator,
           total_sold_share, sell_count)
         values ($1,$2,$3,$4::numeric,$5,$6,$7::numeric,$8,$9,$10::numeric,$11,$12,$13,
                 $14::numeric,$15)
         on conflict do nothing`,
        [CHAIN, p.pool_id, initBlock, p.outcome, creator,
          creatorSells.length > 0,
          creatorSells.reduce((a, s) => a + s.share, 0).toString(),
          creatorSells.length,
          creatorSells.length === 0 ? null
            : Math.round(Math.min(...creatorSells.map((s) => s.off)) / 10),
          biggest === undefined ? null : biggest.share.toString(),
          biggest === undefined ? null : Math.round(biggest.off / 10),
          biggest === undefined ? null : (byTx.get(biggest.tx) ?? null),
          biggest === undefined ? null : (byTx.get(biggest.tx) === creator),
          totalSold.toString(), sells.length]);
      n += 1;
      if (n % 40 === 0) log.info('progress', { pools: n, of: pools.length });
    }

    /* ================== FREE ANALYSIS ================== */
    const rows = (await c.query<{
      pool_id: string; outcome: string | null; creator_sold: boolean | null;
      creator_sold_share: string | null; creator_sell_count: number | null;
      creator_first_sell_s: number | null; biggest_sell_share: string | null;
      biggest_sell_s: number | null; biggest_sell_is_creator: boolean | null;
      biggest_sell_by: string | null; total_sold_share: string | null; sell_count: number | null;
    }>(`select * from bot_loss_anatomy where chain=$1`, [CHAIN])).rows;

    const scored = rows.filter((r) => r.outcome !== null);
    const deep = scored.filter((r) => Number(r.outcome) <= DEEP);
    const rest = scored.filter((r) => Number(r.outcome) > DEEP);

    const grp = (set: typeof rows, label: string): Record<string, unknown> => {
      const sold = set.filter((r) => r.creator_sold === true);
      const bigIsCreator = set.filter((r) => r.biggest_sell_is_creator === true);
      const shares = sold.map((r) => Number(r.creator_sold_share));
      const times = sold.map((r) => r.creator_first_sell_s)
        .filter((x): x is number => x !== null);
      const counts = sold.map((r) => r.creator_sell_count)
        .filter((x): x is number => x !== null);
      const bigShare = set.map((r) => r.biggest_sell_share === null ? null
        : Number(r.biggest_sell_share)).filter((x): x is number => x !== null);
      return {
        n: set.length,
        creator_SOLD: `${sold.length} (${set.length === 0 ? 'n/a' : pc(sold.length / set.length)})`,
        creator_NEVER_sold: `${set.length - sold.length} `
          + `(${set.length === 0 ? 'n/a' : pc((set.length - sold.length) / set.length)})`,
        biggest_sell_WAS_the_creator: `${bigIsCreator.length} `
          + `(${set.length === 0 ? 'n/a' : pc(bigIsCreator.length / set.length)})`,
        creator_share_sold_p25: pc(quant(shares, 0.25)),
        creator_share_sold_median: pc(quant(shares, 0.5)),
        creator_share_sold_p75: pc(quant(shares, 0.75)),
        creator_first_sell_seconds_p25: quant(times, 0.25),
        creator_first_sell_seconds_median: quant(times, 0.5),
        creator_first_sell_seconds_p75: quant(times, 0.75),
        creator_sell_count_median: quant(counts, 0.5),
        creator_sold_in_ONE_tx: `${counts.filter((x) => x === 1).length} of ${counts.length}`,
        biggest_single_sell_share_median: pc(quant(bigShare, 0.5)),
        label,
      };
    };

    log.info('*** 6A  DEEP LOSERS vs THE REST ***', {
      signal_firing_scored: scored.length,
      deep_losses_at_or_below_70pct: `${deep.length} (${pc(deep.length / scored.length)})`,
      DEEP_LOSERS: grp(deep, 'outcome <= -70%'),
      THE_REST: grp(rest, 'outcome > -70%'),
    });

    /* Do the non-dumped launches behave differently? The decisive sub-question. */
    const noSell = scored.filter((r) => r.creator_sold !== true);
    const didSell = scored.filter((r) => r.creator_sold === true);
    const out = (set: typeof rows): number[] => set.map((r) => Number(r.outcome));
    log.info('*** 6A  LAUNCHES WHERE THE CREATOR NEVER SOLD ***', {
      creator_never_sold: `${noSell.length} of ${scored.length} `
        + `(${pc(noSell.length / scored.length)})`,
      their_outcome_p25: pc(quant(out(noSell), 0.25)),
      their_outcome_median: pc(quant(out(noSell), 0.5)),
      their_outcome_p75: pc(quant(out(noSell), 0.75)),
      their_deep_loss_rate: noSell.length === 0 ? 'n/a'
        : pc(noSell.filter((r) => Number(r.outcome) <= DEEP).length / noSell.length),
      creator_DID_sell: didSell.length,
      DID_outcome_median: pc(quant(out(didSell), 0.5)),
      DID_deep_loss_rate: didSell.length === 0 ? 'n/a'
        : pc(didSell.filter((r) => Number(r.outcome) <= DEEP).length / didSell.length),
      CAVEAT: 'seller identity is resolved on the LARGEST few sells only '
        + `(${MAX_TX_READS} tx reads per pool), so a creator who sold only in small `
        + 'pieces reads as "never sold". This is a LOWER BOUND on creator selling.',
    });

    /* INDIVIDUAL RECORDS — an aggregate is a hypothesis. */
    const sample = deep.slice(0, 10).map((r) =>
      `${r.pool_id.slice(0, 14)} outcome=${pc(Number(r.outcome))} `
      + `biggest_sell=${pc(Number(r.biggest_sell_share ?? 0))} at ${r.biggest_sell_s}s `
      + `by=${r.biggest_sell_is_creator ? 'CREATOR' : (r.biggest_sell_by ?? 'unknown')} `
      + `total_sold=${pc(Number(r.total_sold_share ?? 0))} sells=${r.sell_count}`);
    log.info('TEN DEEP LOSERS, INDIVIDUALLY', { rows: sample, cu: inner.cuSpent });
  } finally { c.release(); await app.pool.end(); }
}

void main().catch((e: unknown) => { log.error('loss-anatomy failed', errorFields(e)); process.exit(1); });

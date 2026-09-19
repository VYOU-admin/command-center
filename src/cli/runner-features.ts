/**
 * `npm run runner-features` — 5B: WHAT WAS DIFFERENT ABOUT THE RUNNERS?
 *
 * §6K labelled 1,016 launches: 42.1% peak ≥+50% within fifteen minutes, median time to
 * peak 8.2 minutes. **This asks whether a runner was identifiable BEFORE or AT our
 * entry.**
 *
 * ===========================================================================
 * TWO CONSTRAINTS THAT DECIDE WHAT MAY BE MEASURED
 * ===========================================================================
 *
 * **1. NOTHING OBSERVABLE AFTER +15 SECONDS.** The operator enters at +15 s, so a
 * quantity readable only at +60 s is useless whatever it correlates with. Every feature
 * below is read from the creation transaction or from the first 150 blocks, and the
 * cut-off is enforced in the query, not remembered.
 *
 * **2. RUNNERS ARE COMPARED WITH NON-RUNNERS FROM THE SAME HOUR.** Chain activity moved
 * by a factor of fifty across these days (§6K.5: median swaps per launch 9 → 502), so an
 * unstratified comparison would let time-of-day and activity carry any signal. Effect
 * sizes are computed **within each hour bucket and then pooled**, so a feature only
 * scores if it separates launches that happened alongside each other.
 *
 * ===========================================================================
 * THE EFFECT SIZE IS CLIFF'S DELTA, NOT A p-VALUE
 * ===========================================================================
 *
 * The brief asks for effect sizes rather than p-values alone. **Cliff's delta** is the
 * probability a random runner exceeds a random non-runner, minus the reverse: −1 to +1,
 * 0 meaning the distributions are interchangeable. It is non-parametric, it suits
 * medians, and it is unmoved by the extreme tails these distributions have. Pooled
 * across hours it answers exactly the question asked: *does this quantity have a
 * different distribution in runners than in non-runners launched beside them?*
 *
 * **EVERY FEATURE TESTED IS REPORTED, INCLUDING THE ONES THAT FIND NOTHING.** Twenty
 * tested with one survivor is a different result from one tested with one survivor, and
 * the table says which.
 */
import { AbiCoder } from 'ethers';
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { RpcClient } from '../adapters/token-updates/rpc.js';
import { ReadOnlyRpc } from '../bot/rpc.js';
import { readPoolLiquidity } from '../bot/pool-state.js';
import { TOPICS } from '../adapters/token-updates/decode.js';

const CHAIN = 'robinhood';
const RPC_URL = 'https://robinhood-mainnet.g.alchemy.com/v2/{key}';
const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const PT_FACTORY = '0x000000e200088d55c39a11f609e5f667729ad49b';
const TOKEN_CREATED = '0x4ef8284ecf42d4cd19686572ffd87f630858c82398911e776cb831de35eddbf4';
const abi = AbiCoder.defaultAbiCoder();
const CU_CEILING = 900_000;
const ENTRY_BLOCKS = 150;        /* +15 s. NOTHING after this may be read. */
const MAX_TX_READS_PER_POOL = 14;
const BLOCKS_PER_HOUR = 36_000;

interface Log { topics: string[]; data: string; blockNumber: string; transactionHash: string }
const sgn = (v: bigint): bigint => v >= (1n << 255n) ? v - (1n << 256n) : v;

/** UTF-8 string at `off` bytes into the data blob, ABI head/tail encoded. */
function strAt(data: string, off: number): string {
  try {
    const len = parseInt(data.slice(off * 2, off * 2 + 64), 16);
    if (!Number.isFinite(len) || len > 4096) return '';
    return Buffer.from(data.slice(off * 2 + 64, off * 2 + 64 + len * 2), 'hex').toString('utf8');
  } catch { return ''; }
}
/* A codepoint outside the Basic Multilingual Plane, or a pictograph block. */
const hasEmoji = (s: string): boolean =>
  [...s].some((ch) => (ch.codePointAt(0) ?? 0) > 0x2000);

async function main(): Promise<void> {
  const key = process.env['ALCHEMY_API_KEY'];
  if (!key) throw new Error('ALCHEMY_API_KEY is not set');
  const app = await bootstrap();
  const c = await app.pool.connect();
  const inner = new RpcClient(RPC_URL.replace('{key}', key), 60_000, CU_CEILING);
  const rpc = new ReadOnlyRpc(inner);

  try {
    await c.query(`create table if not exists bot_runner_features (
      chain text not null, pool_id text not null,
      init_block bigint not null, hour_bucket integer not null,
      creator text, creator_eth numeric, creator_share numeric,
      pool_liquidity numeric,
      name_len integer, symbol_len integer, desc_len integer,
      has_emoji boolean, desc_empty boolean, symbol_collision boolean,
      buyers_5s integer, buyers_10s integer, buyers_15s integer,
      eth_in_15s numeric, largest_buy_15s numeric,
      swaps_15s integer, sells_15s integer,
      scored_buyer_hits integer, best_buyer_score numeric,
      creator_sold_by_15s boolean,
      measured_at timestamptz not null default now(),
      primary key (chain, pool_id)
    )`);

    const targets = (await c.query<{ pool_id: string; token: string; init_block: string }>(
      `select r.pool_id, r.token, r.init_block::text
         from bot_runner_label r
         left join bot_runner_features f
           on f.chain = r.chain and f.pool_id = r.pool_id
        where r.chain = $1 and f.pool_id is null
        order by r.init_block`, [CHAIN])).rows;

    /* The scored-wallet set the operator already runs. */
    const scored = new Map((await c.query<{ wallet: string; score: string }>(
      `select lower(wallet) as wallet, max(score)::text as score
         from wallet_scores where chain = $1 group by 1`, [CHAIN])).rows
      .map((r) => [r.wallet, Number(r.score)]));
    /* Symbols already in use, for the collision feature. */
    const knownSymbols = new Set((await c.query<{ s: string }>(
      `select distinct lower(symbol) as s from tokens where symbol is not null`)).rows
      .map((r) => r.s));

    log.info('5B  BEFORE THE FIRST PAID CALL', {
      labelled_pools: (await c.query<{ n: string }>(
        `select count(*)::text n from bot_runner_label where chain=$1`, [CHAIN])).rows[0]?.n,
      still_to_feature: targets.length,
      scored_wallets_available: scored.size,
      known_symbols_for_collision: knownSymbols.size,
      cutoff: `NOTHING after +${ENTRY_BLOCKS} blocks (+15 s) is read`,
      estimate_cu: targets.length * (60 + 15 + 26 + MAX_TX_READS_PER_POOL * 15),
      ceiling_cu: CU_CEILING,
    });

    let n = 0;
    for (const t of targets) {
      const initBlock = Number(t.init_block);
      const pid = t.pool_id;

      /* ---- the creation transaction: TokenCreated + creator + ETH in ----- */
      let creator: string | null = null; let creatorEth = 0;
      let nameLen = 0; let symLen = 0; let descLen = 0;
      let emoji = false; let descEmpty = true; let collision = false;
      try {
        const tc = (await rpc.call('eth_getLogs', [{
          address: PT_FACTORY, topics: [TOKEN_CREATED],
          fromBlock: `0x${initBlock.toString(16)}`, toBlock: `0x${initBlock.toString(16)}`,
        }])) as Log[];
        const mine = tc.find((l) =>
          `0x${l.data.slice(2).slice(24, 64)}`.toLowerCase() === t.token.toLowerCase());
        if (mine !== undefined) {
          const data = mine.data.slice(2);
          /* head: token, then one offset to a tuple of four strings (§6D.2). */
          const base = 64;   /* bytes: word 1 is the offset to the tuple */
          const offs = [2, 3, 4, 5].map((w) =>
            base + parseInt(data.slice(w * 64, w * 64 + 64), 16));
          const parts = offs.map((o) => strAt(data, o));
          const desc = parts[0] ?? ''; const s2 = parts[1] ?? '';
          const s4 = parts[3] ?? '';
          descLen = desc.length; descEmpty = desc.trim().length === 0;
          emoji = hasEmoji(desc) || hasEmoji(s2) || hasEmoji(s4);
          const tx = (await rpc.call('eth_getTransactionByHash',
            [mine.transactionHash])) as { from?: string; value?: string } | null;
          if (tx?.from) creator = tx.from.toLowerCase();
          if (tx?.value) creatorEth = Number(BigInt(tx.value)) / 1e18;
        }
      } catch { /* absent, never defaulted */ }

      /* name()/symbol() from the token itself — cheap and exact. */
      try {
        for (const [sel, set] of [['0x06fdde03', 'n'], ['0x95d89b41', 's']] as const) {
          const r = String(await rpc.call('eth_call', [{ to: t.token, data: sel }, 'latest']));
          if (r.length > 130) {
            const off = parseInt(r.slice(2, 66), 16);
            const len = parseInt(r.slice(66 + off * 2 - 64, 66 + off * 2), 16);
            const v = Buffer.from(r.slice(66 + off * 2, 66 + off * 2 + len * 2), 'hex')
              .toString('utf8');
            if (set === 'n') { nameLen = v.length; emoji = emoji || hasEmoji(v); }
            else {
              symLen = v.length; emoji = emoji || hasEmoji(v);
              collision = knownSymbols.has(v.toLowerCase());
            }
          }
        }
      } catch { /* absent */ }

      const liq = await readPoolLiquidity(rpc, pid, `0x${initBlock.toString(16)}`);

      /* ---- the first 15 seconds, and NOT ONE BLOCK MORE ------------------ */
      let buyers5 = 0; let buyers10 = 0; let buyers15 = 0;
      let ethIn = 0; let largest = 0; let swaps15 = 0; let sells15 = 0;
      let hits = 0; let bestScore: number | null = null;
      let creatorSold = false; let share = 0;
      try {
        const sw = (await rpc.call('eth_getLogs', [{
          address: POOL_MANAGER, topics: [TOPICS.swapV4, pid],
          fromBlock: `0x${initBlock.toString(16)}`,
          toBlock: `0x${(initBlock + ENTRY_BLOCKS).toString(16)}`,
        }])) as Log[];
        swaps15 = sw.length;
        const txs = new Set<string>();
        const at5 = new Set<string>(); const at10 = new Set<string>(); const at15 = new Set<string>();
        for (const x of sw) {
          const off = Number(BigInt(x.blockNumber)) - initBlock;
          const d = x.data.slice(2);
          const a0 = sgn(BigInt(`0x${d.slice(0, 64)}`));
          const a1 = sgn(BigInt(`0x${d.slice(64, 128)}`));
          /* currency0 is native ETH on these pools (§6J.1 validated on 25 records). */
          const tokenAmt = a1; const ethAmt = a0;
          if (tokenAmt > 0n) {
            const e = Number(-ethAmt) / 1e18;
            ethIn += e; if (e > largest) largest = e;
            if (off === 0) share += Number(tokenAmt) / 1e27;
          } else if (tokenAmt < 0n) {
            sells15 += 1;
            if (off > 0) creatorSold = true;   /* someone sold inside our entry window */
          }
          txs.add(x.transactionHash);
          const bucket = off <= 50 ? at5 : off <= 100 ? at10 : at15;
          bucket.add(x.transactionHash);
        }
        buyers5 = at5.size; buyers10 = at5.size + at10.size;
        buyers15 = txs.size;
        /* The BUYER is tx.from; the swap's sender topic is the router (§6H.3). */
        let reads = 0;
        for (const h of txs) {
          if (reads >= MAX_TX_READS_PER_POOL) break;
          reads += 1;
          try {
            const tx = (await rpc.call('eth_getTransactionByHash', [h])) as
              { from?: string } | null;
            const f = tx?.from?.toLowerCase();
            if (f !== undefined && scored.has(f)) {
              hits += 1;
              const sc = scored.get(f)!;
              if (bestScore === null || sc > bestScore) bestScore = sc;
            }
          } catch { /* skip */ }
        }
      } catch { /* absent */ }

      await c.query(
        `insert into bot_runner_features (chain, pool_id, init_block, hour_bucket,
           creator, creator_eth, creator_share, pool_liquidity, name_len, symbol_len,
           desc_len, has_emoji, desc_empty, symbol_collision, buyers_5s, buyers_10s,
           buyers_15s, eth_in_15s, largest_buy_15s, swaps_15s, sells_15s,
           scored_buyer_hits, best_buyer_score, creator_sold_by_15s)
         values ($1,$2,$3,$4,$5,$6::numeric,$7::numeric,$8::numeric,$9,$10,$11,$12,$13,
                 $14,$15,$16,$17,$18::numeric,$19::numeric,$20,$21,$22,$23::numeric,$24)
         on conflict do nothing`,
        [CHAIN, pid, initBlock, Math.floor(initBlock / BLOCKS_PER_HOUR), creator,
          creatorEth.toString(), share.toString(),
          liq === null ? null : liq.toString(), nameLen, symLen, descLen, emoji,
          descEmpty, collision, buyers5, buyers10, buyers15, ethIn.toString(),
          largest.toString(), swaps15, sells15, hits,
          bestScore === null ? null : bestScore.toString(), creatorSold]);
      n += 1;
      if (n % 50 === 0) log.info('progress', { featured: n, of: targets.length });
    }

    log.info('FEATURE EXTRACTION DONE', {
      featured_this_run: n,
      cu: inner.cuSpent,
      next: 'run `npm run runner-separate` to score them — evaluation is FREE',
    });
  } finally { c.release(); await app.pool.end(); }
}

void main().catch((e: unknown) => { log.error('runner-features failed', errorFields(e)); process.exit(1); });

/**
 * `npm run follow-track` — THE OUTCOME TRACKER FOR THE FOUR WALLETS.
 *
 * The rule is `docs/NAMED-RULE-P19.md`, committed before this scored a single buy.
 * **Nothing here may adjust it.** This writes rows. It never trades.
 *
 * ===========================================================================
 * WHAT IT ANSWERS AND WHY TWO LAGS
 * ===========================================================================
 *
 * §6AI.5 named four wallets on realised P&L, IN-SAMPLE. This is the out-of-sample
 * test. §6AH.3 measured the signal after one of their buys decaying fast: +4.24%
 * median at one minute, +2.79% at five, +0.17% at fifteen, negative at sixty.
 *
 * `watchlist-watch` runs every **30 minutes**, so today's detection lag is 0-30 min
 * — median ~15, which is exactly where that curve reaches zero. So every buy is
 * scored at BOTH lags:
 *
 *   LAG_FAST   300 blocks (~30 s)   needs direct polling that does not exist yet
 *   LAG_SLOW  9000 blocks (~15 min)  what today's infrastructure actually achieves
 *
 * **If FAST pays and SLOW does not, build the poller. If neither does, stop.**
 *
 * ===========================================================================
 * THE DISCIPLINES
 * ===========================================================================
 *
 * - **Every exit is a REACHABLE-bound `simulateSellAt`** (§6A.3). An unreachable
 *   bound reverts inside the swap action before SETTLE_ALL pulls the token, so it
 *   measures the pricing curve and never proves a transfer. A position that cannot
 *   be sold is **-100%, never 0%**.
 * - **Rows are committed as they are produced**, and each horizon is filled in
 *   independently once its block matures. A +24 h horizon cannot be scored today;
 *   that is a resume problem, not a reason to skip it.
 * - **The work set is what will be written.** Only buys not already tracked, and
 *   only horizons not already scored, are priced.
 * - **Unpriceable entries are COUNTED, not dropped.** Refutation condition 4 is a
 *   plumbing check and it needs the denominator.
 * - **No filter on which buys to follow.** Filtering would layer a second
 *   in-sample selection on the first.
 */
import { AbiCoder, id } from 'ethers';
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { RpcClient } from '../adapters/token-updates/rpc.js';
import { ReadOnlyRpc } from '../bot/rpc.js';
import { simulateSellAt } from '../bot/sellability.js';
import { buildSwap } from '../bot/calldata.js';
import { TOPICS } from '../adapters/token-updates/decode.js';
import { PRICING, POOL_MANAGER, addrTopic } from '../bot/collector-rules.js';

const CHAIN = 'robinhood';
const RPC_URL = 'https://robinhood-mainnet.g.alchemy.com/v2/{key}';
const abi = AbiCoder.defaultAbiCoder();
const V4_TOO_LITTLE = id('V4TooLittleReceived(uint256,uint256)').slice(0, 10);
const UNREACHABLE = 1n << 127n;
const CU_CEILING = 250_000;

/** THE FOUR. Frozen; see docs/NAMED-RULE-P19.md. */
const WALLETS = [
  '0x0b30d99a8b5b92c302ef0df8c9068338ce46c801',
  '0x008bac045a4220bf6755564c5ea2e1b271eb670f',
  '0x91dc0fbd6d30783abea7291b512bfe59d2294a3c',
  '0xe5239c5bcdb8e9bf55322dae843c72d46f60b66c',
];
/** Two entry lags. The comparison between them IS the deliverable. */
const LAGS = [
  { key: 'fast' as const, blocks: 300 },    /* ~30 s, needs a poller we do not have */
  { key: 'slow' as const, blocks: 9_000 },  /* ~15 min, today's median monitor lag */
];
/** Horizons from ENTRY, in blocks. ~9.93 blocks/s (MEASURED §6V.2). */
const HORIZONS = [
  { key: '5m', blocks: 2_979 }, { key: '15m', blocks: 8_937 },
  { key: '1h', blocks: 35_748 }, { key: '24h', blocks: 857_952 },
];
/** $100 notional. §6S.4: gas is absolute, so a $1 position cannot carry it. */
const SIZE_WEI = 36_000_000_000_000_000n;

interface Log { topics: string[]; data: string; blockNumber: string }

/**
 * A 20-byte address, or nothing.
 *
 * **`v4_pool_init.hooks` IS KNOWINGLY SHORT BY ONE BYTE on 306,560 of 678,441 rows**
 * — `src/intake/v4-init.ts` records it: an early version used a topic helper on a
 * data word, which drops the address's HIGH byte. Those rows were never rewritten.
 * Feeding one to `buildSwap` throws `invalid address`, which is how this was found.
 *
 * So the stored row is USED ONLY IF EVERY ADDRESS IN IT IS WELL FORMED. Otherwise
 * the key is re-derived from the chain, which is always correct. A short address is
 * a defect to route around, never a value to pad and hope.
 */
const isAddr = (a: string | null | undefined): a is string =>
  typeof a === 'string' && /^0x[0-9a-f]{40}$/.test(a.toLowerCase());
interface PoolKey {
  currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string;
}

/** Quote a buy at `block`. The revert payload IS the router's own output; it is
 *  used only to size the position, never as an exit price (§6A.3). */
async function quoteBuy(
  rpc: ReadOnlyRpc, owner: string, pool: PoolKey, zeroIsPricing: boolean, block: number,
): Promise<bigint | null> {
  const buy = buildSwap({ pool, zeroForOne: zeroIsPricing, amountIn: SIZE_WEI,
    amountOutMinimum: UNREACHABLE,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 600) });
  try {
    await rpc.call('eth_call', [{ from: owner, to: buy.to, data: buy.data,
      value: `0x${buy.value.toString(16)}` }, `0x${block.toString(16)}`,
    { [owner]: { balance: `0x${(10n ** 20n).toString(16)}` } }]);
  } catch (err) {
    const e2 = err as Error & { data?: unknown };
    const dd = typeof e2.data === 'string' ? e2.data : '';
    if (dd.startsWith(V4_TOO_LITTLE)) {
      const dec = abi.decode(['uint256', 'uint256'], `0x${dd.slice(10)}`) as unknown as bigint[];
      const out = dec[1] as bigint;
      return out > 0n ? out : null;
    }
  }
  return null;
}

async function main(): Promise<void> {
  const key = process.env['ALCHEMY_API_KEY'];
  if (!key) throw new Error('ALCHEMY_API_KEY is not set');
  const owner = process.env['BOT_WALLET_ADDRESS']?.trim().toLowerCase();
  if (!owner) throw new Error('BOT_WALLET_ADDRESS must be set');
  const app = await bootstrap();
  const c = await app.pool.connect();
  const inner = new RpcClient(RPC_URL.replace('{key}', key), 60_000, CU_CEILING);
  const rpc = new ReadOnlyRpc(inner);

  try {
    await c.query(`create table if not exists bot_follow_track (
      chain text not null, wallet text not null, token text not null,
      buy_block bigint not null, pool_id text,
      currency0 text, currency1 text, fee integer, tick_spacing integer,
      hooks text, zero_is_pricing boolean,
      key_ok boolean not null default false,
      first_seen_at timestamptz not null default now(),
      primary key (chain, wallet, token, buy_block)
    )`);
    await c.query(`create table if not exists bot_follow_leg (
      chain text not null, wallet text not null, token text not null,
      buy_block bigint not null, lag text not null, horizon text not null,
      entry_block bigint, exit_block bigint,
      tokens_out numeric, eth_out numeric, sell_ok boolean, ret numeric,
      entry_ok boolean, measured_at timestamptz not null default now(),
      primary key (chain, wallet, token, buy_block, lag, horizon)
    )`);

    /* Rows stored before the isAddr check may carry a short `hooks` from
       v4_pool_init. Un-key them so discovery re-derives from the chain. */
    const fixed = await c.query(
      `update bot_follow_track set key_ok = false
        where chain = $1 and key_ok
          and (currency0 !~ '^0x[0-9a-f]{40}$' or currency1 !~ '^0x[0-9a-f]{40}$'
               or hooks !~ '^0x[0-9a-f]{40}$')`, [CHAIN]);
    if ((fixed.rowCount ?? 0) > 0) {
      log.warn('un-keyed rows carrying a malformed pool key, will re-derive', {
        rows: fixed.rowCount,
        cause: 'v4_pool_init.hooks is knowingly short by one byte on ~45% of rows',
      });
    }

    const head = Number(BigInt(String(await rpc.call('eth_blockNumber', []))));

    /* ---- 1. DISCOVER new buys by the four ------------------------------ */
    const fresh = (await c.query<{ wallet: string; token: string; bb: string; pool: string | null }>(
      `select a.wallet, lower(a.token) token, min(a.block_number)::text bb,
              min(a.pool) pool
         from watchlist_activity a
        where a.chain = $1 and a.side = 'buy' and a.wallet = any($2)
          and not exists (select 1 from bot_follow_track t
             where t.chain = a.chain and t.wallet = a.wallet
               and t.token = lower(a.token) and t.buy_block = a.block_number)
        group by 1, 2
        order by 3`, [CHAIN, WALLETS])).rows;

    let added = 0; let keyed = 0;
    for (const f of fresh) {
      const bb = Number(f.bb);
      let pk: PoolKey | null = null; let zip = false; let pid = f.pool;
      /* Prefer the stored init row; fall back to the chain. v4_pool_init covers
         only ~39% of these pools, so the fallback is the normal path. */
      const st = (await c.query<{ pool_id: string; currency0: string; currency1: string;
        fee: number; tick_spacing: number; hooks: string }>(
        `select pool_id, currency0, currency1, fee, tick_spacing, hooks
           from v4_pool_init where chain=$1 and lower(pool_id)=lower($2)`,
        [CHAIN, f.pool ?? ''])).rows[0];
      if (st !== undefined && isAddr(st.currency0) && isAddr(st.currency1)
          && isAddr(st.hooks)) {
        pk = { currency0: st.currency0.toLowerCase(), currency1: st.currency1.toLowerCase(),
          fee: st.fee, tickSpacing: st.tick_spacing, hooks: st.hooks.toLowerCase() };
        zip = PRICING.includes(pk.currency0);
      } else if (f.pool !== null) {
        try {
          const il = (await rpc.call('eth_getLogs', [{
            address: POOL_MANAGER, topics: [TOPICS.initializeV4, f.pool],
            fromBlock: '0x0', toBlock: `0x${bb.toString(16)}`,
          }])) as Log[];
          if (il.length > 0) {
            const l = il[il.length - 1]!;
            const c0 = addrTopic(l.topics[2] ?? '');
            const c1 = addrTopic(l.topics[3] ?? '');
            const d = abi.decode(['uint24', 'int24', 'address', 'uint160', 'int24'], l.data) as
              unknown as [bigint, bigint, string, bigint, bigint];
            const hk = d[2].toLowerCase();
            if (isAddr(c0) && isAddr(c1) && isAddr(hk)) {
              pk = { currency0: c0, currency1: c1, fee: Number(d[0]),
                tickSpacing: Number(d[1]), hooks: hk };
              zip = PRICING.includes(c0);
              pid = f.pool;
            }
          }
        } catch { /* counted below as key_ok=false, never silently dropped */ }
      }
      await c.query(
        `insert into bot_follow_track (chain, wallet, token, buy_block, pool_id,
           currency0, currency1, fee, tick_spacing, hooks, zero_is_pricing, key_ok)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict do nothing`,
        [CHAIN, f.wallet, f.token, bb, pid,
          pk?.currency0 ?? null, pk?.currency1 ?? null, pk?.fee ?? null,
          pk?.tickSpacing ?? null, pk?.hooks ?? null, pk === null ? null : zip,
          pk !== null]);
      added += 1; if (pk !== null) keyed += 1;
    }
    log.info('discovery', { new_buys: fresh.length, added,
      pool_key_resolved: keyed, pool_key_MISSING: added - keyed });

    /* ---- 2. SCORE every (lag, horizon) whose exit block has matured ----- */
    const todo = (await c.query<{ wallet: string; token: string; buy_block: string;
      currency0: string; currency1: string; fee: number; tick_spacing: number;
      hooks: string; zero_is_pricing: boolean }>(
      `select wallet, token, buy_block::text, currency0, currency1, fee,
              tick_spacing, hooks, zero_is_pricing
         from bot_follow_track
        where chain=$1 and key_ok order by buy_block`, [CHAIN])).rows;

    let scored = 0; let noEntry = 0; let unsellable = 0; let badKey = 0;
    for (const t of todo) {
      const bb = Number(t.buy_block);
      if (!isAddr(t.currency0) || !isAddr(t.currency1) || !isAddr(t.hooks)) {
        badKey += 1; continue;
      }
      const pool: PoolKey = { currency0: t.currency0, currency1: t.currency1,
        fee: t.fee, tickSpacing: t.tick_spacing, hooks: t.hooks };
      const token = t.zero_is_pricing ? t.currency1 : t.currency0;
      for (const lag of LAGS) {
        const entryBlock = bb + lag.blocks;
        let tokensOut: bigint | null | undefined;
        for (const h of HORIZONS) {
          const exitBlock = entryBlock + h.blocks;
          if (exitBlock > head - 60) continue;            /* not matured yet */
          const have = (await c.query(
            `select 1 from bot_follow_leg where chain=$1 and wallet=$2 and token=$3
               and buy_block=$4 and lag=$5 and horizon=$6`,
            [CHAIN, t.wallet, t.token, bb, lag.key, h.key])).rowCount ?? 0;
          if (have > 0) continue;
          if (tokensOut === undefined) {
            tokensOut = await quoteBuy(rpc, owner, pool, t.zero_is_pricing, entryBlock);
          }
          if (tokensOut === null) {
            await c.query(
              `insert into bot_follow_leg (chain, wallet, token, buy_block, lag, horizon,
                 entry_block, exit_block, entry_ok) values ($1,$2,$3,$4,$5,$6,$7,$8,false)
               on conflict do nothing`,
              [CHAIN, t.wallet, t.token, bb, lag.key, h.key, entryBlock, exitBlock]);
            noEntry += 1; continue;
          }
          let ethOut: bigint | null = null; let ok = false;
          try {
            const s = await simulateSellAt(rpc, { pool, token, owner, amount: tokensOut,
              zeroForOneBuy: t.zero_is_pricing, block: `0x${exitBlock.toString(16)}` });
            ok = s.executes === true; ethOut = s.ethOut;
          } catch { ok = false; }
          /* A position that cannot be closed is -100%, never 0%. */
          const ret = ok && ethOut !== null
            ? Number(ethOut - SIZE_WEI) / Number(SIZE_WEI) : -1;
          if (!ok) unsellable += 1;
          await c.query(
            `insert into bot_follow_leg (chain, wallet, token, buy_block, lag, horizon,
               entry_block, exit_block, tokens_out, eth_out, sell_ok, ret, entry_ok)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9::numeric,$10::numeric,$11,$12::numeric,true)
             on conflict do nothing`,
            [CHAIN, t.wallet, t.token, bb, lag.key, h.key, entryBlock, exitBlock,
              tokensOut.toString(), ethOut === null ? null : ethOut.toString(), ok,
              ret.toString()]);
          scored += 1;
        }
      }
    }
    log.info('FOLLOW-TRACK CYCLE DONE', {
      rule: 'docs/NAMED-RULE-P19.md, committed before this scored anything',
      tracked_positions: todo.length, legs_scored_this_cycle: scored,
      entry_unpriceable: noEntry, unsellable_at_exit: unsellable,
      malformed_stored_pool_key: badKey,
      note: 'unpriceable entries are COUNTED — refutation condition 4 needs the denominator',
      cu: inner.cuSpent,
    });
  } finally { c.release(); await app.pool.end(); }
}

void main().catch((e: unknown) => {
  log.error('follow-track failed', errorFields(e)); process.exit(1);
});

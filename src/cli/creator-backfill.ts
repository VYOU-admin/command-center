/**
 * `npm run creator-backfill` — PART 11C: make causal creator history TESTABLE.
 *
 * §6T.7 found a real in-sample effect — launches by a creator who has launched
 * before did better than first-ever launches — and refused to score it, because
 * `bot_runner_features` ends at block 66,439,983 while the fresh window starts at
 * 66,530,927. **Every fresh launch would have read `prior = 0`: a filter matching
 * nothing dressed as a finding.**
 *
 * ===========================================================================
 * WHY THIS BUILDS ITS OWN TABLE INSTEAD OF EXTENDING bot_runner_features
 * ===========================================================================
 *
 * `bot_runner_features` holds 1,016 launches over ~68 days — about 15/day against
 * a measured chain rate near 158/day. It is a SAMPLE. Counting "prior launches by
 * this creator" against a sample undercounts, and undercounts unevenly across
 * eras. Mixing a sampled history with a complete one would produce a number that
 * looks like a prior-launch count and is really a sampling artefact.
 *
 * So this sweeps **every** `TokenCreated` in a pinned window and resolves each
 * launch's creator the same way `runner-features` does — `tx.from` of the creation
 * transaction, which is sound attribution, unlike the seller attribution §6O.1
 * records burning us. Prior counts computed from this table are internally
 * consistent, and they mean "prior launches **within the pinned lookback**", which
 * is stated rather than implied.
 *
 * Rows are written **one at a time as they are resolved**, so a container recycle
 * costs only the launches not yet reached (the §6-recorded 416,000 CU lesson).
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { RpcClient } from '../adapters/token-updates/rpc.js';
import { ReadOnlyRpc } from '../bot/rpc.js';

const CHAIN = 'robinhood';
const RPC_URL = 'https://robinhood-mainnet.g.alchemy.com/v2/{key}';
const PT_FACTORY = '0x000000e200088d55c39a11f609e5f667729ad49b';
const TOKEN_CREATED = '0x4ef8284ecf42d4cd19686572ffd87f630858c82398911e776cb831de35eddbf4';
const CU_CEILING = 400_000;
/** PINNED. Never derived from head — §6J's rule after an 800,000 CU re-buy. */
const LOOKBACK_FROM = 65_000_000;

interface Log { data: string; blockNumber: string; transactionHash: string }

async function sweep(
  rpc: ReadOnlyRpc, from: number, to: number, span0: number,
): Promise<Log[]> {
  const out: Log[] = []; let cur = from; let span = span0;
  while (cur <= to) {
    const end = Math.min(cur + span - 1, to);
    try {
      const got = (await rpc.call('eth_getLogs', [{
        address: PT_FACTORY, topics: [TOKEN_CREATED],
        fromBlock: `0x${cur.toString(16)}`, toBlock: `0x${end.toString(16)}`,
      }])) as Log[];
      out.push(...got); cur = end + 1;
      if (got.length < 3_000) span = Math.min(Math.floor(span * 1.5), span0 * 8);
    } catch (err) {
      if (!/exceed|limit|response size/i.test((err as Error).message)) throw err;
      span = Math.max(Math.floor(span / 4), 2_000);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const key = process.env['ALCHEMY_API_KEY'];
  if (!key) throw new Error('ALCHEMY_API_KEY is not set');
  const app = await bootstrap();
  const c = await app.pool.connect();
  const inner = new RpcClient(RPC_URL.replace('{key}', key), 60_000, CU_CEILING);
  const rpc = new ReadOnlyRpc(inner);
  try {
    await c.query(`create table if not exists bot_launch_creator (
      chain text not null, tx_hash text not null, token text not null,
      init_block bigint not null, creator text,
      measured_at timestamptz not null default now(),
      primary key (chain, tx_hash)
    )`);
    await c.query(`create index if not exists bot_launch_creator_cb
      on bot_launch_creator (chain, creator, init_block)`);

    const head = Number(BigInt(String(await rpc.call('eth_blockNumber', []))));
    const to = head - 3_000;
    const created = await sweep(rpc, LOOKBACK_FROM, to, 900_000);

    const have = new Set((await c.query<{ tx_hash: string }>(
      `select tx_hash from bot_launch_creator where chain=$1`, [CHAIN]))
      .rows.map((r) => r.tx_hash));
    const todo = created.filter((l) => !have.has(l.transactionHash.toLowerCase()));

    log.info('CREATOR BACKFILL — work set derived from the rows that will be written', {
      pinned_window: `${LOOKBACK_FROM}..${to}`,
      days: ((to - LOOKBACK_FROM) / 864_000).toFixed(2),
      TokenCreated_found: created.length,
      already_stored: have.size,
      to_resolve: todo.length,
      estimate_cu: todo.length * 26,
      ceiling_cu: CU_CEILING,
      note: 'prior counts will mean "within this pinned lookback", not "ever"',
    });

    let n = 0; let unresolved = 0;
    for (const l of todo) {
      const token = `0x${l.data.slice(2).slice(24, 64)}`.toLowerCase();
      let creator: string | null = null;
      try {
        const tx = (await rpc.call('eth_getTransactionByHash',
          [l.transactionHash])) as { from?: string } | null;
        if (tx?.from) creator = tx.from.toLowerCase();
      } catch { /* leave null and COUNT it, never silently drop */ }
      if (creator === null) unresolved += 1;
      await c.query(
        `insert into bot_launch_creator (chain, tx_hash, token, init_block, creator)
         values ($1,$2,$3,$4,$5) on conflict do nothing`,
        [CHAIN, l.transactionHash.toLowerCase(), token,
          Number(BigInt(l.blockNumber)), creator]);
      n += 1;
      if (n % 200 === 0) log.info('progress', { done: n, of: todo.length, cu: inner.cuSpent });
    }

    const tot = (await c.query<{ n: string; c: string; nul: string; lo: string; hi: string }>(
      `select count(*)::text n, count(distinct creator)::text c,
              count(*) filter (where creator is null)::text nul,
              min(init_block)::text lo, max(init_block)::text hi
         from bot_launch_creator where chain=$1`, [CHAIN])).rows[0];
    log.info('CREATOR BACKFILL DONE', {
      resolved_this_run: n, unresolved_this_run: unresolved,
      table_rows: tot?.n, distinct_creators: tot?.c,
      rows_with_NULL_creator: tot?.nul,
      block_range: `${tot?.lo}..${tot?.hi}`, cu: inner.cuSpent,
    });
  } finally { c.release(); await app.pool.end(); }
}

void main().catch((e: unknown) => {
  log.error('creator-backfill failed', errorFields(e)); process.exit(1);
});

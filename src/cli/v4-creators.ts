/**
 * `npm run v4-creators -- --windows a:b,c:d --sample N [--commit]`
 *
 * WHO CREATED THE POOL. The fee tier cannot plausibly cause a return -- nobody's token
 * rises because the deployer picked 1% over 0.25% -- so the tier is most likely a
 * FINGERPRINT of the launchpad or tool that created the pool. This collects the thing
 * the tier is a shadow of, so the two can be compared like for like.
 *
 * The creator is the SENDER of the `Initialize` transaction, and the contract it was
 * sent TO is the launchpad. Both are read: `tx.from` identifies a deployer, `tx.to`
 * identifies the tool, and for fingerprinting a launchpad the second is usually the
 * sharper of the two. Neither is inferred from the other.
 *
 * IT IS SCOPED TO RULE-QUALIFYING POOLS IN NAMED WINDOWS, never the whole corpus.
 * 22,238 holdout-era rule pools at 15 CU each is $0.05 on its own and the question
 * does not need all of them; `--sample N` bounds the per-window read and the sampling
 * is deterministic (`order by pool_id`) so a re-run reads the same set.
 *
 * A SAMPLE UNDERSTATES CROSS-WINDOW OVERLAP and that is stated rather than buried: a
 * creator present in a window but outside the sample reads as absent. Top creators are
 * unaffected -- a creator with many pools is nearly certain to be sampled -- so the
 * concentration figures are sound and the long-tail overlap is a lower bound.
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { RpcClient } from '../adapters/token-updates/rpc.js';

const PRICING = [
  '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
  '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
  '0x0000000000000000000000000000000000000000',
];
const RPC_URL = 'https://robinhood-mainnet.g.alchemy.com/v2/{key}';
const TX_CU = 15;
const USD_PER_MCU = 0.45;

export const CREATOR_SCHEMA = `
create table if not exists v4_pool_creator (
  chain    text not null,
  pool_id  text not null,
  tx_hash  text not null,
  creator  text,
  target   text,
  read_at  timestamptz not null default now(),
  primary key (chain, pool_id)
);
create index if not exists v4_pool_creator_creator_idx on v4_pool_creator (chain, creator);
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const str = (f: string, d: string): string => {
    const i = args.indexOf(f); return i >= 0 ? String(args[i + 1] ?? d) : d;
  };
  const num = (f: string, d: number): number => {
    const i = args.indexOf(f); return i >= 0 ? Number(args[i + 1] ?? d) : d;
  };
  const commit = args.includes('--commit');
  const sample = num('--sample', 0);
  const windows = str('--windows', '').split(',').filter(Boolean)
    .map((w) => { const [a, b] = w.split(':'); return { from: Number(a), to: Number(b) }; });
  if (windows.length === 0) throw new Error('usage: --windows from:to,from:to');
  const chain = 'robinhood';

  const app = await bootstrap();
  const c = await app.pool.connect();
  try {
    await c.query('set statement_timeout = 0');
    await c.query(CREATOR_SCHEMA);

    /* THE WORK SET, per window, stated before the first request. */
    await c.query('create temp table want (pool_id text primary key, tx_hash text, win text)');
    for (const w of windows) {
      const lauTo = w.to - 36000;
      await c.query(`insert into want
        select p.pool_id, p.tx_hash, '${w.from}' from (
          select i.pool_id, i.tx_hash,
                 row_number() over (order by i.pool_id) rn
            from v4_pool_init i
            join (select pool_id, min(block_number) fb from v4_swaps_all
                   where block_number between ${w.from} and ${w.to} group by 1) f
              on f.pool_id = i.pool_id
           where i.block_number between ${w.from} and ${lauTo}
             and ((i.currency0 = any($1)) <> (i.currency1 = any($1)))
             and i.fee in (500,10000) and (f.fb - i.block_number) between 11 and 600
        ) p where ${sample > 0 ? `p.rn <= ${sample}` : 'true'}
        on conflict (pool_id) do nothing`, [PRICING]);
    }
    const ws = await c.query<{ win: string; pools: string; with_tx: string; txs: string }>(
      `select win, count(*)::text pools, count(tx_hash)::text with_tx,
              count(distinct tx_hash)::text txs from want group by 1 order by 1`);
    const todo = await c.query<{ n: string }>(
      `select count(distinct w.tx_hash)::text n from want w
        where w.tx_hash is not null
          and not exists (select 1 from v4_pool_creator k
                           where k.chain=$1 and k.pool_id=w.pool_id and k.creator is not null)`,
      [chain]);
    const n = Number(todo.rows[0]!.n);
    const estCu = n * TX_CU;
    log.info('CREATOR WORK SET, derived BEFORE the first request', {
      windows: windows.map((w) => `${w.from}..${w.to}`),
      sample_per_window: sample || 'all',
      per_window: ws.rows,
      distinct_transactions_to_read: n,
      estimate: { cu: estCu, usd: ((estCu * USD_PER_MCU) / 1e6).toFixed(5) },
      commit,
      note: 'pools sharing one Initialize transaction are read once',
    });
    if (n === 0) {
      log.info('NOTHING TO READ', {
        note: 'either every pool is already resolved, or v4_pool_init.tx_hash is still '
          + 'null -- re-run the Initialize sweep first. A work set of nothing is '
          + 'reported, never treated as a clean pass.',
      });
      c.release(); await app.pool.end(); process.exit(0);
    }
    if (!commit) {
      log.info('DRY RUN -- nothing read', { note: 'pass --commit to spend' });
      c.release(); await app.pool.end(); process.exit(0);
    }

    const key = process.env['ALCHEMY_API_KEY'];
    if (!key) throw new Error('ALCHEMY_API_KEY is not set');
    const ceiling = Math.max(10000, Math.ceil(estCu * 1.5));
    const rpc = new RpcClient(RPC_URL.replace('{key}', key), 120000, ceiling);

    const rows = await c.query<{ tx_hash: string }>(
      `select distinct tx_hash from want where tx_hash is not null`);
    const byTx = new Map<string, { from: string; to: string | null }>();
    let failed = 0; let done = 0;
    for (const r of rows.rows) {
      try {
        const tx = (await rpc.raw('eth_getTransactionByHash', [r.tx_hash])) as
          { from?: string; to?: string | null } | null;
        /* A transaction that cannot be read is UNKNOWN, never attributed to anyone. */
        if (!tx?.from) { failed += 1; continue; }
        byTx.set(r.tx_hash, { from: tx.from.toLowerCase(), to: tx.to ? tx.to.toLowerCase() : null });
      } catch (err) {
        if (err instanceof Error && err.message.includes('compute-unit ceiling')) throw err;
        failed += 1;
      }
      done += 1;
      if (done % 500 === 0) log.info('creator read progress', { done, of: rows.rowCount, cu: rpc.cuSpent });
    }
    const all = await c.query<{ pool_id: string; tx_hash: string }>(
      `select pool_id, tx_hash from want where tx_hash is not null`);
    let stored = 0;
    for (let i = 0; i < all.rows.length; i += 500) {
      const chunk = all.rows.slice(i, i + 500).filter((x) => byTx.has(x.tx_hash));
      if (chunk.length === 0) continue;
      const vals: unknown[] = [];
      const tuples = chunk.map((x, j) => {
        const b = j * 5; const v = byTx.get(x.tx_hash)!;
        vals.push(chain, x.pool_id, x.tx_hash, v.from, v.to);
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5})`;
      }).join(',');
      const res = await c.query(
        `insert into v4_pool_creator (chain,pool_id,tx_hash,creator,target)
         values ${tuples} on conflict (chain,pool_id) do update
           set creator=excluded.creator, target=excluded.target, read_at=now()`, vals);
      stored += res.rowCount ?? 0;
    }
    log.info('creators read', {
      transactions_requested: rows.rowCount, resolved: byTx.size, failed,
      pool_rows_stored: stored, cu_spent: rpc.cuSpent,
      usd: ((rpc.cuSpent * USD_PER_MCU) / 1e6).toFixed(5),
    });
  } finally { c.release(); }
  await app.pool.end();
  process.exit(0);
}
main().catch((e) => { log.error('v4-creators failed', errorFields(e)); process.exit(1); });

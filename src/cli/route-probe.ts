/**
 * `npm run route-probe -- --windows a:b,c:d --sample N [--commit]`
 *
 * HOW DOES A SWAP ACTUALLY GET EXECUTED ON THIS CHAIN?
 *
 * Every other CLI here READS the chain. A trading bot writes to it, and that path has
 * never been established in this repository. A v4 pool has no contract of its own and
 * the PoolManager is a singleton that end users do not call directly, so the question
 * is which periphery contract real trades route through -- and the only honest way to
 * answer it is to read what real trades did.
 *
 * It samples swap transactions on RULE-QUALIFYING pools at the moment the bot would
 * enter (off 150..450 from the pool's first swap) and reads each one, which returns
 * the routing target, the caller, the native value attached and the CALLDATA in one
 * 15 CU call.
 *
 * NOTHING HERE INFERS A CALLDATA SHAPE. It records the selector and the raw input so
 * the layout can be derived by correlating calldata words against values already known
 * from the same transaction -- the method step 3 prescribes for topic hashes: sample,
 * group, and confirm against something already known. An assumed calldata shape would
 * be worse than no bot at all, because it would fail after the money moved.
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

export const ROUTE_SCHEMA = `
create table if not exists v4_swap_tx (
  chain     text not null,
  side      text,
  tx_hash   text not null,
  pool_id   text,
  win       text,
  tx_to     text,
  tx_from   text,
  value_wei numeric,
  selector  text,
  input_len integer,
  input     text,
  read_at   timestamptz not null default now(),
  primary key (chain, tx_hash)
);
create index if not exists v4_swap_tx_to_idx on v4_swap_tx (chain, tx_to);
/*
 * ALTER, NOT JUST CREATE. Section 7's first rule: a create-table-if-not-exists is a
 * no-op on an existing table -- it does not reconcile a changed shape and it reports
 * success either way. Adding the side column to the CREATE did nothing on the table
 * the buy run had already made, every insert then referenced a column that did not
 * exist, and 315 transactions were read and discarded before that surfaced.
 * (This comment sits inside a template literal, so it carries no backticks: they
 * terminate it. That is the second time this pass.)
 */
alter table v4_swap_tx add column if not exists side text;
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
  const sample = num('--sample', 300);
  /*
   * --side. Settled empirically against `tx.value`, which is unambiguous about who
   * paid: across 143 native-ETH buys the token side is POSITIVE in 142 and
   * `tx.value = |amount0|` in 125. That is the SWAPPER perspective ROBINHOOD.md
   * states -- the swapper received the token -- so a SELL is the token side NEGATIVE.
   */
  const side = str('--side', 'buy');
  if (side !== 'buy' && side !== 'sell') throw new Error('--side must be buy or sell');
  const tokenSign = side === 'buy' ? '>' : '<';
  const windows = str('--windows', '').split(',').filter(Boolean)
    .map((w) => { const [a, b] = w.split(':'); return { from: Number(a), to: Number(b) }; });
  if (windows.length === 0) throw new Error('usage: --windows from:to,from:to');
  const chain = 'robinhood';

  const app = await bootstrap();
  const c = await app.pool.connect();
  try {
    await c.query('set statement_timeout = 0');
    await c.query(ROUTE_SCHEMA);
    await c.query('create temp table want (tx_hash text primary key, pool_id text, win text)');

    for (const w of windows) {
      const lauTo = w.to - 36000;
      await c.query(`insert into want
        with rule as (
          select i.pool_id, f.fb,
                 case when i.currency0 = any($1) then 1 else 0 end tside
            from v4_pool_init i
            join (select pool_id, min(block_number) fb from v4_swaps_all
                   where block_number between ${w.from} and ${w.to} group by 1) f
              on f.pool_id = i.pool_id
           where i.block_number between ${w.from} and ${lauTo}
             and ((i.currency0 = any($1)) <> (i.currency1 = any($1)))
             and i.fee in (500,10000) and (f.fb - i.block_number) between 11 and 600),
        entry as (
          select distinct on (s.pool_id) s.tx_hash, s.pool_id
            from v4_swaps_all s join rule r on r.pool_id = s.pool_id
           where s.block_number > r.fb + 150 and s.block_number <= r.fb + 450
             and (case when r.tside=0 then s.amount0 else s.amount1 end) ${tokenSign} 0
           order by s.pool_id, s.block_number, s.log_index)
        select tx_hash, pool_id, '${w.from}' from entry
         order by tx_hash limit ${sample}
        on conflict (tx_hash) do nothing`, [PRICING]);
    }
    const todo = await c.query<{ n: string }>(
      `select count(*)::text n from want w
        where not exists (select 1 from v4_swap_tx t where t.chain=$1 and t.tx_hash=w.tx_hash)`,
      [chain]);
    const n = Number(todo.rows[0]!.n);
    const estCu = n * TX_CU;
    log.info('ROUTE PROBE WORK SET, derived BEFORE the first request', {
      windows: windows.map((w) => `${w.from}..${w.to}`),
      sample_per_window: sample,
      transactions_to_read: n,
      estimate: { cu: estCu, usd: ((estCu * USD_PER_MCU) / 1e6).toFixed(5) },
      commit,
      side,
      note: side === 'buy'
        ? 'entry-moment BUYS on rule-qualifying pools -- the trade the bot would make'
        : 'SELLS on rule-qualifying pools -- the exit leg, which was never measured',
    });
    if (n === 0) {
      log.info('NOTHING TO READ -- stated, never treated as a clean pass');
      c.release(); await app.pool.end(); process.exit(0);
    }
    if (!commit) {
      log.info('DRY RUN -- nothing read', { note: 'pass --commit to spend' });
      c.release(); await app.pool.end(); process.exit(0);
    }

    const key = process.env['ALCHEMY_API_KEY'];
    if (!key) throw new Error('ALCHEMY_API_KEY is not set');
    const rpc = new RpcClient(RPC_URL.replace('{key}', key), 120000,
      Math.max(5000, Math.ceil(estCu * 1.5)));
    const rows = await c.query<{ tx_hash: string; pool_id: string; win: string }>(
      `select w.tx_hash, w.pool_id, w.win from want w
        where not exists (select 1 from v4_swap_tx t where t.chain=$1 and t.tx_hash=w.tx_hash)`,
      [chain]);
    let stored = 0; let failed = 0;
    for (const r of rows.rows) {
      try {
        const tx = (await rpc.raw('eth_getTransactionByHash', [r.tx_hash])) as {
          to?: string | null; from?: string; value?: string; input?: string;
        } | null;
        /* A transaction that cannot be read is UNKNOWN; nothing is invented for it. */
        if (!tx?.from || typeof tx.input !== 'string') { failed += 1; continue; }
        const input = tx.input;
        await c.query(
          `insert into v4_swap_tx
             (chain,side,tx_hash,pool_id,win,tx_to,tx_from,value_wei,selector,input_len,input)
           values ($11,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           on conflict (chain,tx_hash) do nothing`,
          [chain, r.tx_hash, r.pool_id, r.win, tx.to ? tx.to.toLowerCase() : null,
            tx.from.toLowerCase(), BigInt(tx.value ?? '0x0').toString(),
            input.slice(0, 10), input.length, input, side],
        );
        stored += 1;
      } catch (err) {
        if (err instanceof Error && err.message.includes('compute-unit ceiling')) throw err;
        /*
         * A DATABASE ERROR IS NOT A FAILED READ AND MUST NOT BE COUNTED AS ONE. The
         * first version caught both here, so a missing column reported as 315 failed
         * transaction reads -- an error path disguising a defect as data, which is the
         * shape ROBINHOOD.md section 5 calls the worst on this project. A schema or
         * query fault stops the run; only an RPC fault is tallied.
         */
        const m = err instanceof Error ? err.message : String(err);
        if (/column|relation|syntax|constraint|violates/i.test(m)) throw err;
        failed += 1;
      }
    }
    if (failed > 0 && stored === 0) {
      throw new Error(
        `route-probe read ${rows.rowCount} transactions and stored NONE. A run that `
        + 'spends and keeps nothing is a defect, not a clean pass.',
      );
    }
    log.info('route probe complete', {
      requested: rows.rowCount, stored, failed, cu_spent: rpc.cuSpent,
      usd: ((rpc.cuSpent * USD_PER_MCU) / 1e6).toFixed(5),
    });
  } finally { c.release(); }
  await app.pool.end();
  process.exit(0);
}
main().catch((e) => { log.error('route-probe failed', errorFields(e)); process.exit(1); });

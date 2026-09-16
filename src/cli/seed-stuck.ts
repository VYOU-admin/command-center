/**
 * `npm run seed-stuck -- --label <name> [--commit]`
 *
 * Seeds ONE `needs_exit` row so the boot path that clears it can be proved in the REAL
 * `launchbot` boot sequence rather than only in a drill. `LAUNCHBOT.md` records that a
 * path nobody has exercised is not a path, and the stuck-position case is the one the
 * document calls the most dangerous gap in the system.
 *
 * **THE FIXTURE IS MEASURED, NOT INVENTED.** It copies a pool from a trade whose exit
 * already simulated CLEAN, and attributes the position to that trade's own borrowed
 * holder — an address whose balance of that token is read and confirmed non-zero before
 * the row is written. A seeded position whose premise is false proves nothing, so this
 * refuses rather than seeding one.
 *
 * It writes into a DRY-RUN mode only: the label suffixes `dry-run-`, exactly as
 * `launchbot --run-label` does, so nothing here can produce a row that reads as live.
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { BOT_SCHEMA } from '../bot/state.js';
import { RpcClient } from '../adapters/token-updates/rpc.js';
import { ReadOnlyRpc } from '../bot/rpc.js';
import { id } from 'ethers';

const RPC_URL = 'https://robinhood-mainnet.g.alchemy.com/v2/{key}';
const BALANCE_OF = id('balanceOf(address)').slice(0, 10);

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const li = args.indexOf('--label');
  const label = li >= 0 ? String(args[li + 1] ?? '') : '';
  if (!/^[a-z0-9-]{1,24}$/.test(label)) {
    throw new Error(`--label must match [a-z0-9-]{1,24}, got "${label}"`);
  }
  const mode = `dry-run-${label}`;
  const commit = args.includes('--commit');

  const key = process.env['ALCHEMY_API_KEY'];
  if (!key) throw new Error('ALCHEMY_API_KEY is not set');
  const rpc = new ReadOnlyRpc(new RpcClient(RPC_URL.replace('{key}', key), 60000, 5000));

  const app = await bootstrap();
  const c = await app.pool.connect();
  try {
    await c.query(BOT_SCHEMA);

    const pre = await c.query<{ n: string }>(
      `select count(*)::text n from bot_trades where chain='robinhood' and mode=$1`, [mode]);
    log.info('DRY-RUN COUNTS BEFORE SEEDING', {
      mode, rows_already_in_this_mode: pre.rows[0]!.n,
      note: 'must be 0; a non-zero count means a previous seed was not cleaned up',
    });

    /* A pool whose exit ALREADY simulated clean, so the fixture is known-sellable. */
    const f = await c.query<{
      pool_id: string; token: string; counter: string; fee: number; tick_spacing: number;
      hooks: string; first_swap_block: string; exit_sim_from: string; quoted_out: string;
      launchpad: string | null; position_wei: string; px_entry: string;
    }>(
      `select pool_id, token, counter, fee, tick_spacing, hooks, first_swap_block::text,
              exit_sim_from, quoted_out::text, launchpad, position_wei::text,
              px_entry::text
         from bot_trades
        where chain='robinhood' and exit_sim_status='clean' and exit_sim_from is not null
          and quoted_out > 0 and px_entry > 0
        order by created_at desc limit 1`);
    if (f.rowCount === 0) {
      throw new Error('no clean-exit trade to copy a fixture from; RETURNED NO ROWS — '
        + 'refusing to invent a stuck position');
    }
    const p = f.rows[0]!;

    /* THE PREMISE IS CONFIRMED BEFORE THE ROW IS WRITTEN. */
    const bal = BigInt(String(await rpc.call('eth_call', [{
      to: p.token,
      data: BALANCE_OF + '0'.repeat(24) + p.exit_sim_from.slice(2).toLowerCase(),
    }, 'latest'])));
    if (bal === 0n) {
      throw new Error(`the fixture holder ${p.exit_sim_from} now holds 0 of ${p.token}; `
        + 'refusing to seed a stuck position whose premise is false');
    }

    log.info('FIXTURE MEASURED ON CHAIN', {
      mode, pool: p.pool_id.slice(0, 20), token: p.token, fee: p.fee,
      attributed_to: p.exit_sim_from, holder_balance: bal.toString(), commit,
    });
    if (!commit) {
      log.info('DRY RUN — nothing written', { note: 'pass --commit to seed' });
      c.release(); await app.pool.end(); process.exit(0);
    }

    const ins = await c.query<{ id: string }>(
      `insert into bot_trades
         (chain, mode, pool_id, token, counter, launchpad, fee, tick_spacing, hooks,
          status, first_swap_block, position_wei, position_usd, quoted_out, px_entry,
          exit_sim_from, fill_status, note)
       values ('robinhood',$1,$2,$3,$4,$5,$6,$7,$8,'needs_exit',$9,$10,10,$11,$12,$13,
               'dry-run','SEEDED stuck position, to prove the boot exit path runs')
       on conflict (chain,mode,pool_id) do nothing
       returning id::text`,
      [mode, p.pool_id, p.token, p.counter, p.launchpad, p.fee, p.tick_spacing, p.hooks,
        p.first_swap_block, p.position_wei, p.quoted_out, p.px_entry, p.exit_sim_from]);

    if (ins.rowCount === 0) {
      throw new Error('the insert stored no row — reported rather than treated as done');
    }
    log.info('SEEDED', { trade: ins.rows[0]!.id, mode, status: 'needs_exit' });
  } finally { c.release(); }

  /* VERIFIED ON A FRESH CONNECTION, not from this script exiting cleanly. */
  const fresh = await app.pool.connect();
  try {
    const v = await fresh.query(
      `select status, count(*)::int n from bot_trades
        where chain='robinhood' and mode=$1 group by 1`, [mode]);
    log.info('VERIFIED ON A FRESH CONNECTION', {
      mode, rows: v.rows.length ? v.rows : 'RETURNED NO ROWS',
    });
  } finally { fresh.release(); }
  await app.pool.end();
  process.exit(0);
}

main().catch((err) => { log.error('seed-stuck failed', errorFields(err)); process.exit(1); });

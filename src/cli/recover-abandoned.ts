/**
 * `npm run recover-abandoned -- [--commit]`
 *
 * RECOVER THE LIVE POSITIONS THE DUE-EXIT LOOP ABANDONED.
 *
 * The loop checked `exit_sim_from` for NULL **before** resolving who the seller is, and
 * closed the row `closed_unsimulatable / no_holder_found` when it was null. **Live rows
 * carry `exit_sim_from = NULL` by design** — section 2D writes it null so boot
 * reconciliation reads OUR balance rather than a borrowed holder's — so every live
 * position was written off as closed without a single exit attempt, while the wallet
 * still held every token.
 *
 * `closed_unsimulatable` is in neither `NON_TERMINAL` nor `HELD`, so those positions left
 * boot reconciliation, the `needs_exit` sweep, `MAX_CONCURRENT` and the capital cap all
 * at once. This puts them back into `needs_exit`, which is the one status the boot sweep
 * acts on before arming.
 *
 * ---------------------------------------------------------------------------
 * THE SCOPE IS NARROW ON PURPOSE
 * ---------------------------------------------------------------------------
 *
 * `mode = 'live'` AND `entry_tx is not null` AND **our balance of the token, read from
 * the chain, is non-zero.** All three are required:
 *
 * - a DRY-RUN `closed_unsimulatable` row is a legitimately closed simulation — nothing
 *   was ever bought — and sweeping those into `needs_exit` would arm the boot sweep
 *   against positions that do not exist, which is the landmine section 7 already records;
 * - a live row with no `entry_tx` never broadcast a buy;
 * - **a zero balance means the position really is gone**, and a row is left closed rather
 *   than resurrected on the strength of its status alone. The chain is the adjudicator.
 *
 * A balance that cannot be READ is not a zero. It raises, because recording an unreadable
 * balance as "nothing there" is the `balanceOf`-returns-zero failure this project has
 * paid for once already.
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { RpcClient } from '../adapters/token-updates/rpc.js';
import { ReadOnlyRpc } from '../bot/rpc.js';
import { readTokenBalance } from '../bot/allowance.js';
import { configuredWallet } from '../bot/wallet.js';

const CHAIN = 'robinhood';
const RPC_URL = 'https://robinhood-mainnet.g.alchemy.com/v2/{key}';
const FROM = 'closed_unsimulatable';
const TO = 'needs_exit';

async function main(): Promise<void> {
  const commit = process.argv.includes('--commit');
  const key = process.env['ALCHEMY_API_KEY'];
  if (!key) throw new Error('ALCHEMY_API_KEY is not set');
  const app = await bootstrap();
  const c = await app.pool.connect();
  const rpc = new ReadOnlyRpc(new RpcClient(RPC_URL.replace('{key}', key), 60000, 20_000));
  try {
    const wallet = configuredWallet();
    if (wallet === null) {
      throw new Error('BOT_WALLET_ADDRESS is not set, so OUR balance cannot be read — and '
        + 'the whole premise of this recovery is whether WE still hold the token. '
        + 'Refusing rather than resurrecting rows on the strength of a status.');
    }
    const rows = (await c.query<{
      id: string; token: string; position_usd: string; entry_tx: string | null;
    }>(`select id::text, token, position_usd::text, entry_tx
          from bot_trades
         where chain = $1 and mode = 'live' and status = $2
         order by id`, [CHAIN, FROM])).rows;

    const held: typeof rows = [];
    const gone: typeof rows = [];
    const nobuy: typeof rows = [];
    for (const r of rows) {
      if (r.entry_tx === null) { nobuy.push(r); continue; }
      /* THE CHAIN IS THE ADJUDICATOR. An unreadable balance RAISES. */
      const bal = await readTokenBalance(rpc, r.token, wallet);
      (bal > 0n ? held : gone).push(r);
    }

    log.info('THE COUNTS THIS WRITE MUST PRODUCE', {
      candidates_in_status: rows.length,
      to_recover_WE_STILL_HOLD: held.length,
      left_closed_balance_is_zero: gone.length,
      left_closed_no_entry_tx: nobuy.length,
      basis_recovered: held.reduce((a, r) => a + Number(r.position_usd), 0),
      rows: held.map((r) => `${r.id} ${r.token}`),
      consequence: 'each becomes needs_exit, which the next boot of live sweeps BEFORE '
        + 'arming — it reads our balance and climbs the ladder, and a ladder that '
        + 'exhausts halts the mode rather than abandoning the position again',
    });
    if (held.length === 0) {
      log.info('NOTHING TO RECOVER', { note: 'reported as zero, not omitted' });
      return;
    }
    if (!commit) { log.info('DRY RUN — NOTHING WRITTEN', {}); return; }

    const ids = held.map((r) => r.id);
    const upd = await c.query(
      `update bot_trades set status = $3, updated_at = now(),
              note = coalesce(note || ' | ', '')
                     || 'recover-abandoned: closed_unsimulatable without an exit attempt '
                     || 'because live rows carry exit_sim_from=NULL by design; we still '
                     || 'hold the token, so the position is real'
        where chain = $1 and id = any($2::bigint[]) and status = $4`,
      [CHAIN, ids, TO, FROM]);
    if ((upd.rowCount ?? 0) !== held.length) {
      throw new Error(`the update touched ${upd.rowCount} rows where ${held.length} were `
        + 'expected; refusing rather than adjusting the figure to fit');
    }
    const back = await c.query(
      `select status, count(*)::int n from bot_trades
        where chain = $1 and mode = 'live' and id = any($2::bigint[]) group by 1`,
      [CHAIN, ids]);
    log.info('VERIFIED ON A FRESH READ', { rows_updated: upd.rowCount, now: back.rows });
  } catch (err) {
    log.error('recover-abandoned failed', errorFields(err));
    process.exitCode = 1;
  } finally {
    c.release();
    await app.pool.end();
  }
}

void main();

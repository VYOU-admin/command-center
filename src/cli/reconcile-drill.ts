/**
 * `npm run reconcile-drill -- [--commit]`
 *
 * BOOT RECONCILIATION, EXERCISED AGAINST REAL ROWS AND REAL BALANCES.
 *
 * Until now it had only ever run against zero open rows, which proves only that it can
 * count to nothing. The cases that matter are the ones a container replacement actually
 * leaves behind, and each is seeded here and proved:
 *
 *   1. a buy that landed and never sold        -> balance > 0 -> 'needs_exit'
 *   2. an intent that never broadcast          -> balance = 0 -> 'closed_unfilled'
 *   3. a row saying 'holding' that the chain contradicts -> 'closed_unfilled'
 *   4. open rows with no wallet configured     -> HALT, nothing adjudicated
 *   5. a balance that cannot be read at all    -> HALT, never a plausible zero
 *
 * THE BALANCES ARE MEASURED, NOT ASSUMED. The drill probes candidate tokens first and
 * seeds each case from what actually came back; if it cannot find both a non-zero and a
 * zero holding it says so and stops, rather than seeding a case it cannot honour. Case
 * 5 uses an address that is not a contract, whose `eth_call` returns `0x` -- the exact
 * shape that a `?? 0` default would have turned into a plausible, wrong zero balance.
 *
 * IT RUNS ON chain='drill' so the real kill switch is untouched, and every row it
 * writes is deleted at the end with the deletion verified on a fresh connection.
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { BOT_SCHEMA } from '../bot/state.js';
import { POOL_MANAGER } from '../bot/config.js';
import { ReadOnlyRpc } from '../bot/rpc.js';
import { RpcClient } from '../adapters/token-updates/rpc.js';
import { reconcileOnBoot } from '../bot/reconcile.js';
import { id } from 'ethers';
import type { PoolClient } from '../store/db.js';

const CHAIN = 'drill';
const MODE = 'drill';
const RPC_URL = 'https://robinhood-mainnet.g.alchemy.com/v2/{key}';
const BALANCE_OF = id('balanceOf(address)').slice(0, 10);
/** Not a contract. `eth_call` to it returns `0x`, which must never become a zero. */
const NOT_A_CONTRACT = '0x00000000000000000000000000000000deadbeef';
/** A real address that holds nothing. Its zero balance is CONFIRMED, not assumed. */
const EMPTY_WALLET = '0x0000000000000000000000000000000000000001';

async function wipe(c: PoolClient): Promise<void> {
  await c.query('delete from bot_trades where chain = $1', [CHAIN]);
  await c.query('delete from bot_control where chain = $1', [CHAIN]);
}

async function seedRow(
  c: PoolClient, pool: string, token: string, status: string, entryTx: string | null,
): Promise<string> {
  const r = await c.query<{ id: string }>(
    `insert into bot_trades (chain,mode,pool_id,token,counter,status,entry_tx,fee)
     values ($1,$2,$3,$4,'0xcnt',$5,$6,500) returning id::text`,
    [CHAIN, MODE, pool, token, status, entryTx]);
  return r.rows[0]!.id;
}

async function main(): Promise<void> {
  const commit = process.argv.includes('--commit');
  const key = process.env['ALCHEMY_API_KEY'];
  if (!key) throw new Error('ALCHEMY_API_KEY is not set');

  const app = await bootstrap();
  const c = await app.pool.connect();
    /* A ceiling even on a drill: ~60 probes at 26 CU plus a handful of balance reads. */
  const rpc = new ReadOnlyRpc(new RpcClient(RPC_URL.replace('{key}', key), 60000, 10000));
  const results: Array<{ name: string; expect: string; got: string; pass: boolean }> = [];
  try {
    await c.query(BOT_SCHEMA);

    /*
     * TWO WALLETS, BECAUSE ONE CANNOT PRODUCE BOTH FIXTURES.
     *
     * The held case uses the v4 PoolManager, a read-only stand-in with a real balance
     * sheet: it custodies every v4 pool's tokens, so balanceOf against it is non-zero
     * for any live token. The first version of this drill tried to find a token the
     * PoolManager holds NONE of and refused to run when it could not -- correctly, and
     * for a reason worth keeping: the PoolManager holds a balance of every token that
     * ever had a v4 pool, so no such token exists. The zero case is therefore a
     * different WALLET rather than a different token, and reconciliation is run twice.
     *
     * `reconcileOnBoot` takes one wallet per call, which is exactly right -- a bot has
     * one wallet. Two boots is what the two situations actually look like.
     *
     * No key exists and none is needed: reconciliation only ever READS a balance.
     */
    const wallet = POOL_MANAGER;
    const cand = await c.query<{ token: string }>(
      `select distinct case when i.currency0 in
              ('0x0bd7d308f8e1639fab988df18a8011f41eacad73',
               '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
               '0x0000000000000000000000000000000000000000')
            then i.currency1 else i.currency0 end as token
         from v4_pool_init i
        where i.block_number > 63000000 limit 60`);

    const probeCost = cand.rowCount ?? 0;
    log.info('RECONCILE DRILL WORK SET', {
      wallet, candidate_tokens_to_probe: probeCost,
      estimate: { cu: probeCost * 26, usd: ((probeCost * 26 * 0.45) / 1e6).toFixed(5) },
      commit,
    });
    if (!commit) {
      log.info('DRY RUN -- nothing probed, nothing written', { note: 'pass --commit' });
      c.release(); await app.pool.end(); process.exit(0);
    }

    let held: string | null = null;
    for (const row of cand.rows) {
      if (held) break;
      if (!/^0x[0-9a-f]{40}$/i.test(row.token)) continue;
      try {
        const data = BALANCE_OF + '0'.repeat(24) + wallet.slice(2).toLowerCase();
        const res = await rpc.call('eth_call', [{ to: row.token, data }, 'latest']);
        if (BigInt(String(res)) > 0n) held = row.token;
      } catch { /* an unreadable candidate is simply not used as a fixture */ }
    }
    if (!held) {
      throw new Error('probe found no token the PoolManager holds; refusing to seed a '
        + 'case whose balance was not actually measured');
    }
    /* Confirmed by the same read path the bot uses, not assumed to be empty. */
    const emptyData = BALANCE_OF + '0'.repeat(24) + EMPTY_WALLET.slice(2);
    const emptyBal = BigInt(String(await rpc.call('eth_call',
      [{ to: held, data: emptyData }, 'latest'])));
    if (emptyBal !== 0n) {
      throw new Error(`the zero-balance fixture wallet holds ${emptyBal} of ${held}; `
        + 'refusing to run a case whose premise is false');
    }
    log.info('FIXTURES MEASURED ON CHAIN', {
      held_token: held, holder_wallet: wallet, zero_balance_wallet: EMPTY_WALLET,
      zero_balance_confirmed: emptyBal.toString(),
    });

    const check = async (name: string, expect: string, tradeId: string): Promise<void> => {
      const r = await c.query<{ status: string; note: string | null }>(
        'select status, note from bot_trades where id = $1', [tradeId]);
      const got = r.rows[0]?.status ?? 'ROW MISSING';
      results.push({ name, expect, got, pass: got === expect });
      log.info(`RECONCILE CASE: ${name}`, { expect, got, note: r.rows[0]?.note ?? null });
    };

    /* --- case 1: the buy landed and never sold ----------------------------- */
    await wipe(c);
    const idHolding = await seedRow(c, '0xd1', held, 'holding', '0xentry');
    const r1 = await reconcileOnBoot(c, rpc, CHAIN, wallet, MODE);
    log.info('boot A returned', { ...r1 });
    await check('1. buy landed, never sold (balance > 0)', 'needs_exit', idHolding);

    /* --- cases 2 and 3: the chain says we hold nothing ---------------------- */
    await wipe(c);
    const idIntent = await seedRow(c, '0xd2', held, 'intent', null);
    const idGhost = await seedRow(c, '0xd3', held, 'holding', '0xentry');
    const r1b = await reconcileOnBoot(c, rpc, CHAIN, EMPTY_WALLET, MODE);
    log.info('boot B returned', { ...r1b });
    await check('2. intent that never broadcast (balance = 0)', 'closed_unfilled', idIntent);
    await check('3. row says holding, chain says zero', 'closed_unfilled', idGhost);

    /* --- case 4: open rows, no wallet -------------------------------------- */
    await wipe(c);
    const idNoWallet = await seedRow(c, '0xd4', held, 'holding', '0xentry');
    const r2 = await reconcileOnBoot(c, rpc, CHAIN, null, MODE);
    const halted4 = await c.query<{ halted: boolean; reason: string | null }>(
      'select halted, reason from bot_control where chain = $1', [CHAIN]);
    results.push({
      name: '4. open rows with no wallet configured -> HALT',
      expect: 'halted=true, row untouched',
      got: `halted=${halted4.rows[0]?.halted ?? false}, unresolved=${r2.unresolved}`,
      pass: halted4.rows[0]?.halted === true && r2.unresolved === 1,
    });
    log.info('RECONCILE CASE: 4. no wallet', {
      halted: halted4.rows[0]?.halted, reason: halted4.rows[0]?.reason, returned: { ...r2 },
    });
    await check('4b. the row was NOT adjudicated', 'holding', idNoWallet);

    /* --- case 5: a balance that cannot be read ------------------------------ */
    await wipe(c);
    const idBad = await seedRow(c, '0xd5', NOT_A_CONTRACT, 'holding', '0xentry');
    const r3 = await reconcileOnBoot(c, rpc, CHAIN, wallet, MODE);
    const halted5 = await c.query<{ halted: boolean; reason: string | null }>(
      'select halted, reason from bot_control where chain = $1', [CHAIN]);
    results.push({
      name: '5. unreadable balance -> HALT, never a plausible zero',
      expect: 'halted=true, unresolved=1, row untouched',
      got: `halted=${halted5.rows[0]?.halted ?? false}, unresolved=${r3.unresolved}`,
      pass: halted5.rows[0]?.halted === true && r3.unresolved === 1,
    });
    log.info('RECONCILE CASE: 5. unreadable balance', {
      halted: halted5.rows[0]?.halted, reason: halted5.rows[0]?.reason, returned: { ...r3 },
    });
    await check('5b. the row was NOT marked closed', 'holding', idBad);

    await wipe(c);
  } finally {
    c.release();
  }

  const fresh = await app.pool.connect();
  let left = -1; let ctrl = -1;
  try {
    left = Number((await fresh.query<{ n: string }>(
      'select count(*)::text n from bot_trades where chain = $1', [CHAIN])).rows[0]!.n);
    ctrl = Number((await fresh.query<{ n: string }>(
      'select count(*)::text n from bot_control where chain = $1', [CHAIN])).rows[0]!.n);
  } finally { fresh.release(); }

  const failed = results.filter((r) => !r.pass);
  log.info('RECONCILE DRILL COMPLETE', {
    cases: results.length, passed: results.length - failed.length, failed: failed.length,
    results: results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}  expected `
      + `${r.expect} got ${r.got}`),
    cleanup_verified_on_fresh_connection: { bot_trades: left, bot_control: ctrl },
  });
  await app.pool.end();
  if (failed.length > 0 || left !== 0 || ctrl !== 0) { process.exit(1); }
  process.exit(0);
}

main().catch((err) => { log.error('reconcile-drill failed', errorFields(err)); process.exit(1); });

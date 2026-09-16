/**
 * `npm run exit-diagnose -- [--commit]`
 *
 * WHY THE EXIT SIMULATIONS REVERT. Dry run 2 simulated 16 sells and 14 reverted, every
 * one with a bare `execution reverted` and no reason string. An 87.5% failure rate with
 * no cause attached is not a measurement of anything, and reporting it as "the exit
 * fails" would be exactly the partial-check-presented-as-full failure this project
 * guards against.
 *
 * Section 2 of LAUNCHBOT.md establishes that a Universal Router sell needs TWO
 * approvals: ERC-20 -> Permit2, and Permit2 -> router. The exit simulation borrows a
 * holder -- the first swap's sender -- who has no reason to have granted either for a
 * router path they did not use. THE LEADING HYPOTHESIS IS THEREFORE THAT THE REVERTS
 * MEASURE THE FIXTURE'S APPROVALS, NOT THE POOL. This reads both allowances and settles
 * it instead of leaving it as a guess.
 *
 * It writes nothing and reads ~2 calls per trade.
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { RpcClient } from '../adapters/token-updates/rpc.js';
import { PERMIT2, UNIVERSAL_ROUTER } from '../bot/config.js';
import { id } from 'ethers';

const RPC_URL = 'https://robinhood-mainnet.g.alchemy.com/v2/{key}';
const ERC20_ALLOWANCE = id('allowance(address,address)').slice(0, 10);
const PERMIT2_ALLOWANCE = id('allowance(address,address,address)').slice(0, 10);
const pad = (a: string): string => '0'.repeat(24) + a.slice(2).toLowerCase();

async function main(): Promise<void> {
  const commit = process.argv.includes('--commit');
  const key = process.env['ALCHEMY_API_KEY'];
  if (!key) throw new Error('ALCHEMY_API_KEY is not set');
  const app = await bootstrap();
  const c = await app.pool.connect();
  try {
    const rows = await c.query<{ token: string; holder: string; st: string }>(
      `select token, exit_sim_from as holder, exit_sim_status as st
         from bot_trades
        where chain='robinhood' and exit_sim_from is not null
          and exit_sim_status in ('clean','reverted')
        order by created_at desc limit 40`);
    log.info('EXIT DIAGNOSE WORK SET', {
      trades: rows.rowCount, calls: (rows.rowCount ?? 0) * 2,
      estimate: { cu: (rows.rowCount ?? 0) * 2 * 26,
        usd: (((rows.rowCount ?? 0) * 2 * 26 * 0.45) / 1e6).toFixed(5) }, commit,
    });
    if (!commit || rows.rowCount === 0) {
      log.info(commit ? 'NOTHING TO DIAGNOSE' : 'DRY RUN -- nothing read');
      c.release(); await app.pool.end(); process.exit(0);
    }
    const rpc = new RpcClient(RPC_URL.replace('{key}', key), 60000, 10000);
    const tally: Record<string, number> = {};
    for (const r of rows.rows) {
      let erc = 'unreadable'; let p2 = 'unreadable';
      try {
        const v = BigInt(String(await rpc.raw('eth_call', [{ to: r.token,
          data: ERC20_ALLOWANCE + pad(r.holder) + pad(PERMIT2) }, 'latest'])));
        erc = v === 0n ? 'zero' : 'nonzero';
      } catch { /* left as unreadable, never defaulted to zero */ }
      try {
        const raw = String(await rpc.raw('eth_call', [{ to: PERMIT2,
          data: PERMIT2_ALLOWANCE + pad(r.holder) + pad(r.token) + pad(UNIVERSAL_ROUTER) },
        'latest']));
        /* Returns (uint160 amount, uint48 expiration, uint48 nonce) -- the amount is
         * the FIRST word, and it is read as a word rather than as the whole return. */
        const amt = BigInt(`0x${raw.slice(2, 66)}`);
        p2 = amt === 0n ? 'zero' : 'nonzero';
      } catch { /* likewise */ }
      const k = `exit=${r.st}  erc20->permit2=${erc}  permit2->router=${p2}`;
      tally[k] = (tally[k] ?? 0) + 1;
    }
    log.info('EXIT DIAGNOSE RESULT', {
      note: 'if the reverting trades hold zero on either approval, the 14/16 exit revert '
        + 'rate is a property of the borrowed fixture wallet and says nothing about '
        + "whether OUR exit would work -- which is a different claim entirely",
      breakdown: tally, cu_spent: rpc.cuSpent ?? 'unknown',
    });
  } finally { c.release(); }
  await app.pool.end();
  process.exit(0);
}
main().catch((err) => { log.error('exit-diagnose failed', errorFields(err)); process.exit(1); });

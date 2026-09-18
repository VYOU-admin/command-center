/**
 * DOES THE RECONSTRUCTED POOL KEY PRODUCE THE POOL ID THE CHAIN LOGGED?
 * =====================================================================
 *
 * A one-shot check, in the repository because it decides something. The bot rebuilds a
 * `PoolKey` from `(token, counter, fee, tickSpacing, hooks)` every time it swaps, and
 * the ordering rule it uses — `token.toLowerCase() < counter.toLowerCase()` — is an
 * assumption about how the launchpad ordered the currencies. If it is wrong the swap
 * addresses a different pool and reverts, and a sellability probe reads that revert as
 * "this token refuses transfers". **A false honeypot verdict is indistinguishable from
 * a true one**, which is why this is checked against ground truth rather than assumed.
 *
 * Ground truth is `bot_trades.pool_id`, taken from the `Initialize` log.
 *
 * WHAT WOULD PROVE THE ORDERING WRONG: any row where the derived id differs from the
 * stored one. Zeros are reported explicitly.
 */
import { poolIdOf } from '../bot/pool-state.js';
import { bootstrap } from '../bootstrap.js';
import { log } from '../logger.js';

const CHAIN = 'robinhood';

async function main(): Promise<void> {
  const app = await bootstrap();
  const c = await app.pool.connect();
  try {
    const rows = (await c.query<{
      id: string; mode: string; pool_id: string; token: string; counter: string;
      fee: number; tick_spacing: number; hooks: string;
    }>(
      `select id::text, mode, pool_id, token, counter, fee::int, tick_spacing::int, hooks
         from bot_trades
        where chain = $1 and fee is not null and tick_spacing is not null
          and hooks is not null
        order by id`, [CHAIN])).rows;

    let agree = 0; const disagree: string[] = [];
    for (const r of rows) {
      const tokenIsCurrency0 = r.token.toLowerCase() < r.counter.toLowerCase();
      const derived = poolIdOf({
        currency0: tokenIsCurrency0 ? r.token : r.counter,
        currency1: tokenIsCurrency0 ? r.counter : r.token,
        fee: r.fee, tickSpacing: r.tick_spacing, hooks: r.hooks,
      }).toLowerCase();
      if (derived === r.pool_id.toLowerCase()) agree += 1;
      else disagree.push(`${r.id} stored=${r.pool_id.slice(0, 18)} derived=${derived.slice(0, 18)}`);
    }

    log.info('POOL KEY RECONSTRUCTION vs THE Initialize LOG', {
      rows_checked: rows.length,
      agree, disagree: disagree.length,
      disagreements: disagree.slice(0, 10),
      verdict: rows.length === 0
        ? 'NO ROWS CHECKED — this proves nothing'
        : disagree.length === 0
          ? `CONFIRMED on ${String(agree)} records: token.toLowerCase() < counter.toLowerCase() reproduces the logged pool id`
          : 'ORDERING IS WRONG — every swap and every sellability probe is addressing the wrong pool',
    });
  } finally { c.release(); await app.pool.end(); }
}

void main().catch((e: unknown) => { log.error('failed', { err: String(e) }); process.exit(1); });

/**
 * `npm run decay-trajectory` — WHEN, EXACTLY, DID EACH POSITION STOP BEING SELLABLE?
 *
 * The post-mortem established that 12 of 12 sells would have executed at the block we
 * bought in and 11 of 12 would not 90 seconds later. **It did not establish the SHAPE of
 * that transition, and the shape decides what kind of stop is worth building.**
 *
 *   - If the price DECLINES over the hold, a price stop loss can fire in time.
 *   - If sellability goes from fine to zero in one step, **a price stop cannot fire at
 *     all** and the only instrument that works is polling executability itself.
 *
 * So this walks a grid of blocks from the buy to past the horizon and takes BOTH
 * measurements at each: the pool's price from an unreachable bound, and whether the sell
 * would EXECUTE from a reachable one. Section 6A.3 is why both are needed — the
 * unreachable bound short-circuits before the settle and cannot see a transfer refusal.
 *
 * **THIS IS THE MEASUREMENT THAT MUST COME BEFORE A STOP-LOSS VALUE IS CHOSEN**, rather
 * than deriving a percentage from a distribution that may not be the operative one.
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { RpcClient } from '../adapters/token-updates/rpc.js';
import { ReadOnlyRpc } from '../bot/rpc.js';
import { simulateSellAt } from '../bot/sellability.js';

const CHAIN = 'robinhood';
const RPC_URL = 'https://robinhood-mainnet.g.alchemy.com/v2/{key}';
/** Blocks after the buy. 10 blocks = 1 s, measured. +1800 is 3 minutes. */
const GRID = [0, 50, 100, 200, 300, 600, 900, 1200, 1800, 3000];

interface Row {
  id: string; token: string; pool_id: string; fee: number; tick_spacing: number;
  hooks: string; counter: string; entry_block: string | null;
  position_wei: string; quoted_out: string | null; executed_out: string | null;
  entry_tx: string | null;
}

async function main(): Promise<void> {
  const key = process.env['ALCHEMY_API_KEY'];
  if (!key) throw new Error('ALCHEMY_API_KEY is not set');
  const owner = process.env['BOT_WALLET_ADDRESS']?.trim().toLowerCase();
  if (!owner) throw new Error('BOT_WALLET_ADDRESS must be set');
  const app = await bootstrap();
  const c = await app.pool.connect();
  const inner = new RpcClient(RPC_URL.replace('{key}', key), 60000, 400_000);
  const rpc = new ReadOnlyRpc(inner);

  try {
    const rows = (await c.query<Row>(
      `select id::text, token, pool_id, fee::int, tick_spacing::int, hooks, counter,
              entry_block::text, position_wei::text, quoted_out::text,
              executed_out::text, entry_tx
         from bot_trades where chain=$1 and mode='live' and entry_tx is not null
        order by id`, [CHAIN])).rows;

    const summary: Record<string, unknown>[] = [];
    for (const r of rows) {
      let entry = r.entry_block === null ? null : Number(r.entry_block);
      if (entry === null) {
        const rec = (await rpc.call('eth_getTransactionReceipt', [r.entry_tx as string])) as
          { blockNumber?: string } | null;
        entry = rec?.blockNumber === undefined ? null : Number(BigInt(rec.blockNumber));
      }
      if (entry === null) continue;

      const zeroForOneBuy = r.counter.toLowerCase() < r.token.toLowerCase();
      const pool = {
        currency0: zeroForOneBuy ? r.counter : r.token,
        currency1: zeroForOneBuy ? r.token : r.counter,
        fee: r.fee, tickSpacing: r.tick_spacing, hooks: r.hooks,
      };
      const held = r.executed_out !== null ? BigInt(r.executed_out)
        : (r.quoted_out !== null ? BigInt(r.quoted_out) : 0n);
      if (held === 0n) continue;
      const inWei = BigInt(r.position_wei);

      const track: string[] = [];
      let lastGood: number | null = null;
      let firstBad: number | null = null;
      let worstBeforeBad: number | null = null;
      for (const off of GRID) {
        const s = await simulateSellAt(rpc, {
          pool, token: r.token, owner, amount: held, zeroForOneBuy,
          block: `0x${(entry + off).toString(16)}`,
        });
        const pct = s.ethOut === null ? null
          : Number((s.ethOut * 10000n) / inWei) / 100 - 100;
        track.push(`+${off / 10}s ${s.executes === true ? 'SELL' : 'dead'}`
          + `${pct === null ? '' : ` ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`}`);
        if (s.executes === true) {
          lastGood = off;
          if (pct !== null && (worstBeforeBad === null || pct < worstBeforeBad)) {
            worstBeforeBad = pct;
          }
        } else if (firstBad === null) firstBad = off;
      }
      const row = {
        id: r.id, entry_block: entry,
        last_block_offset_STILL_SELLABLE: lastGood === null ? 'never' : `+${lastGood / 10}s`,
        first_block_offset_NOT_SELLABLE: firstBad === null ? 'never' : `+${firstBad / 10}s`,
        worst_price_while_STILL_SELLABLE: worstBeforeBad === null ? 'n/a'
          : `${worstBeforeBad >= 0 ? '+' : ''}${worstBeforeBad.toFixed(1)}%`,
        trajectory: track.join('  '),
      };
      summary.push(row);
      log.info(`TRADE ${r.id}`, row);
    }

    /*
     * THE QUESTION A STOP LOSS HAS TO ANSWER. If the worst price seen while a position
     * was STILL SELLABLE never fell far, a price stop had nothing to fire on: the
     * position went from a normal price to unsellable in one step, and no threshold
     * between them exists.
     */
    const worst = summary
      .map((s) => s['worst_price_while_STILL_SELLABLE'])
      .filter((x): x is string => typeof x === 'string' && x !== 'n/a')
      .map((x) => Number.parseFloat(x));
    worst.sort((a, b) => a - b);
    log.info('COULD A PRICE STOP HAVE FIRED? the worst price seen while still sellable', {
      n: worst.length,
      values: worst.map((w) => `${w.toFixed(1)}%`),
      min: worst.length > 0 ? `${worst[0]?.toFixed(1)}%` : 'n/a',
      median: worst.length > 0
        ? `${(worst[Math.floor(worst.length / 2)] ?? 0).toFixed(1)}%` : 'n/a',
      reading: 'a price stop can only fire on a decline that happens WHILE the position '
        + 'is still sellable. If these are all near the LP fee, there was no decline to '
        + 'stop on and a price stop is the wrong instrument.',
    });
    log.info('decay-trajectory complete', { cu_spent: inner.cuSpent });
  } catch (err) {
    log.error('decay-trajectory failed', { ...errorFields(err), cu: inner.cuSpent });
    process.exitCode = 1;
  } finally {
    c.release();
    await app.pool.end();
  }
}

void main();

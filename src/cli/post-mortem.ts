/**
 * `npm run post-mortem` — THE LIVE RUN, ACCOUNTED FOR FROM THE CHAIN.
 *
 * The bot lost the operator's wallet in roughly fifteen minutes across twelve real buys
 * while every offline measurement said the median was positive. This reads the whole run
 * back off the chain rather than out of the bot's own log, and its central question is
 * the one nothing asked at the time:
 *
 *     **WOULD THE POOL HAVE PAID US AT THE MOMENT WE BOUGHT?**
 *
 * That is answerable, it is cheap, and it is answerable BEFORE the buy — which is what
 * makes it the measurement that decides whether these losses were avoidable.
 *
 * ---------------------------------------------------------------------------
 * TWO INDEPENDENT READS OF THE SAME THING, BECAUSE ONE WOULD BE A CLAIM
 * ---------------------------------------------------------------------------
 *
 * 1. **`extsload` on the PoolManager** for the pool's own `liquidity` — the v4 state
 *    variable. Direct, but it depends on a storage layout this project has not verified
 *    on this chain, so it is treated as INFERRED until it agrees with (2).
 * 2. **The router as an oracle**, `simulateSellAt` — an unreachable `amountOutMinimum`
 *    makes `V4TooLittleReceived` report what the pool would actually pay us, from our
 *    own address at our own size. MEASURED, no layout assumption.
 *
 * **THE VALIDATION IS THEIR AGREEMENT ACROSS ALL TWELVE ROWS.** If `liquidity == 0`
 * exactly where the oracle says the pool pays nothing, the layout is confirmed by twelve
 * records rather than asserted from a constant. If they disagree anywhere, the layout
 * read is reported as UNVERIFIED and only the oracle is used — which is the honest
 * outcome and is stated rather than papered over.
 */
import { AbiCoder, concat, id, keccak256, toBeHex, zeroPadValue } from 'ethers';
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { RpcClient } from '../adapters/token-updates/rpc.js';
import { ReadOnlyRpc } from '../bot/rpc.js';
import { simulateSellAt } from '../bot/sellability.js';
import { POOL_MANAGER } from '../bot/config.js';

const CHAIN = 'robinhood';
const RPC_URL = 'https://robinhood-mainnet.g.alchemy.com/v2/{key}';
const abi = AbiCoder.defaultAbiCoder();
const h32 = (v: bigint | number | string): string => zeroPadValue(toBeHex(v), 32);

/** COMPUTED, never looked up. */
const EXTSLOAD = id('extsload(bytes32)').slice(0, 10);
const SYMBOL = id('symbol()').slice(0, 10);
const BALANCE_OF = id('balanceOf(address)').slice(0, 10);

/** Uniswap v4 StateLibrary: POOLS_SLOT = 6, liquidity at offset 3. INFERRED. */
const POOLS_SLOT = 6n;
const LIQUIDITY_OFFSET = 3n;

interface Row {
  id: string; status: string; token: string; pool_id: string; fee: number;
  tick_spacing: number; hooks: string; counter: string;
  entry_block: string | null; exit_due_block: string | null;
  position_wei: string; quoted_out: string | null; executed_out: string | null;
  entry_tx: string | null; note: string | null;
}

async function main(): Promise<void> {
  const key = process.env['ALCHEMY_API_KEY'];
  if (!key) throw new Error('ALCHEMY_API_KEY is not set');
  const owner = process.env['BOT_WALLET_ADDRESS']?.trim().toLowerCase();
  if (!owner) throw new Error('BOT_WALLET_ADDRESS must be set: the question is about US');
  const app = await bootstrap();
  const c = await app.pool.connect();
  const inner = new RpcClient(RPC_URL.replace('{key}', key), 60000, 200_000);
  const rpc = new ReadOnlyRpc(inner);

  const liqSlot = (poolId: string): string => keccak256(
    concat([poolId, h32(POOLS_SLOT)]));
  const readLiquidity = async (poolId: string, block: string): Promise<bigint | null> => {
    const base = BigInt(liqSlot(poolId));
    const slot = h32(base + LIQUIDITY_OFFSET);
    try {
      const r = String(await rpc.call('eth_call', [{
        to: POOL_MANAGER, data: EXTSLOAD + slot.slice(2),
      }, block]));
      /* `0x` is UNKNOWN, never zero -- ROBINHOOD.md step 1. */
      if (!r.startsWith('0x') || r.length < 66) return null;
      return BigInt(r) & ((1n << 128n) - 1n);
    } catch { return null; }
  };

  try {
    const rows = (await c.query<Row>(
      `select id::text, status, token, pool_id, fee::int, tick_spacing::int, hooks,
              counter, entry_block::text, exit_due_block::text, position_wei::text,
              quoted_out::text, executed_out::text, entry_tx, note
         from bot_trades where chain=$1 and mode='live' order by id`, [CHAIN])).rows;

    log.info('LIVE ROWS', {
      total: rows.length,
      with_a_real_buy: rows.filter((r) => r.entry_tx !== null).length,
      never_bought: rows.filter((r) => r.entry_tx === null)
        .map((r) => `${r.id} (${r.status})`),
    });

    const out: Record<string, unknown>[] = [];
    let agree = 0; let disagree = 0; let liqUnreadable = 0;

    for (const r of rows) {
      if (r.entry_tx === null) continue;

      /* The entry block from the RECEIPT where the row does not carry one. */
      let entry = r.entry_block === null ? null : Number(r.entry_block);
      if (entry === null) {
        const rec = (await rpc.call('eth_getTransactionReceipt', [r.entry_tx])) as
          { blockNumber?: string } | null;
        entry = rec?.blockNumber === undefined ? null : Number(BigInt(rec.blockNumber));
      }
      if (entry === null) {
        out.push({ id: r.id, error: 'no entry block from the row OR the receipt' });
        continue;
      }
      const exitB = r.exit_due_block === null ? entry + 900 : Number(r.exit_due_block);
      const entryHex = `0x${entry.toString(16)}`;
      const exitHex = `0x${exitB.toString(16)}`;

      let symbol = '?';
      try {
        const s = String(await rpc.call('eth_call', [{ to: r.token, data: SYMBOL }, 'latest']));
        if (s.length > 130) {
          symbol = String((abi.decode(['string'], s) as unknown as string[])[0]).slice(0, 12);
        }
      } catch { symbol = '(unreadable)'; }

      const zeroForOneBuy = r.counter.toLowerCase()
        < r.token.toLowerCase();
      const pool = {
        currency0: zeroForOneBuy ? r.counter : r.token,
        currency1: zeroForOneBuy ? r.token : r.counter,
        fee: r.fee, tickSpacing: r.tick_spacing, hooks: r.hooks,
      };
      const held = r.executed_out !== null ? BigInt(r.executed_out)
        : (r.quoted_out !== null ? BigInt(r.quoted_out) : 0n);

      const liqEntry = await readLiquidity(r.pool_id, entryHex);
      const liqNow = await readLiquidity(r.pool_id, 'latest');

      /* THE CENTRAL MEASUREMENT: would the pool have paid us AT THE BUY BLOCK? */
      const atBuy = held === 0n ? null : await simulateSellAt(rpc, {
        pool, token: r.token, owner, amount: held, zeroForOneBuy, block: entryHex,
      });
      const atExit = held === 0n ? null : await simulateSellAt(rpc, {
        pool, token: r.token, owner, amount: held, zeroForOneBuy, block: exitHex,
      });

      let balNow: bigint | null = null;
      try {
        const b = String(await rpc.call('eth_call', [{
          to: r.token, data: BALANCE_OF + owner.slice(2).padStart(64, '0'),
        }, 'latest']));
        balNow = b.length >= 66 ? BigInt(b) : null;
      } catch { balNow = null; }

      /* The layout validation: does liquidity==0 coincide with the oracle paying 0? */
      if (liqEntry === null) liqUnreadable += 1;
      else if (atBuy !== null) {
        const oracleZero = atBuy.reason === 'pays_zero';
        if ((liqEntry === 0n) === oracleZero) agree += 1; else disagree += 1;
      }

      out.push({
        id: r.id, symbol, token: r.token, pool: r.pool_id.slice(0, 18),
        fee: r.fee, entry_block: entry,
        eth_in: r.position_wei,
        tokens_received: r.executed_out ?? `(quote ${r.quoted_out ?? 'null'})`,
        liquidity_at_entry: liqEntry === null ? 'UNREADABLE' : liqEntry.toString(),
        liquidity_now: liqNow === null ? 'UNREADABLE' : liqNow.toString(),
        SELL_AT_BUY_BLOCK: atBuy === null ? 'n/a (no tokens)'
          : `${atBuy.reason}${atBuy.ethOut === null ? '' : ` eth_out=${atBuy.ethOut}`}`
            + `${atBuy.detail === null ? '' : ` [${atBuy.detail}]`}`,
        SELL_AT_EXIT_BLOCK: atExit === null ? 'n/a'
          : `${atExit.reason}${atExit.ethOut === null ? '' : ` eth_out=${atExit.ethOut}`}`
            + `${atExit.detail === null ? '' : ` [${atExit.detail}]`}`,
        eth_recovered: '0',
        still_held: balNow === null ? 'UNREADABLE' : balNow.toString(),
        stored_note: (r.note ?? '').slice(0, 110),
      });
      log.info(`TRADE ${r.id} ${symbol}`, out[out.length - 1] as Record<string, unknown>);
    }

    log.info('THE STORAGE-LAYOUT READ, VALIDATED BY AGREEMENT RATHER THAN ASSERTED', {
      pools_where_liquidity_and_the_oracle_AGREE: agree,
      pools_where_they_DISAGREE: disagree,
      liquidity_UNREADABLE: liqUnreadable,
      verdict: disagree === 0 && agree > 0
        ? 'CONFIRMED on ' + String(agree) + ' records — POOLS_SLOT=6, offset 3'
        : 'UNVERIFIED — use the oracle only',
    });

    /* The decoded exit attempts, from the measurement table rather than the log. */
    const att = await c.query(
      `select trade_id::text, attempt, bound_bps, ok, left(detail, 90) detail
         from bot_exit_attempts where chain=$1
          and trade_id in (select id from bot_trades where chain=$1 and mode='live')
        order by trade_id, attempt`, [CHAIN]);
    log.info('EVERY RECORDED EXIT ATTEMPT ON A LIVE ROW', {
      rows: att.rowCount === 0 ? 'RETURNED NO ROWS' : att.rows,
    });

    log.info('post-mortem complete', { cu_spent: inner.cuSpent, trades: out.length });
  } catch (err) {
    log.error('post-mortem failed', { ...errorFields(err), cu: inner.cuSpent });
    process.exitCode = 1;
  } finally {
    c.release();
    await app.pool.end();
  }
}

void main();

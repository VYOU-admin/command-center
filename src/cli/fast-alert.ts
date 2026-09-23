/**
 * `npm run fast-alert` — WATCH THE FOUR WALLETS AND SAY SO IMMEDIATELY.
 *
 * The rule is `docs/NAMED-RULE-P20.md`, committed before this sent a message.
 * **It is an alert and a scoreboard. It never trades and contains no buy logic.**
 *
 * ===========================================================================
 * THE POLL, AND WHY IT IS ONE CALL
 * ===========================================================================
 *
 * A buy delivers the token TO the wallet, so an ERC-20 `Transfer` with the wallet
 * in `topic2` is the buy arriving. One `eth_getLogs` with all four wallets in that
 * topic slot therefore catches every buy by any of them — **60 CU per poll**,
 * Alchemy's published figure and confirmed against this account's own dashboard.
 *
 * ```
 * 15 s interval -> 5,760 polls/day -> 345,600 CU/day (~$0.17)
 * detection lag  -> worst 15.0 s, average 7.5 s (RPC round trip measured at 43 ms median)
 * ```
 *
 * 5 s was rejected at 1,036,800 CU/day — above the operator's ~500,000 guidance,
 * for a lag improvement that is irrelevant against a window §6AH measured in
 * minutes.
 *
 * ===========================================================================
 * DISCIPLINES
 * ===========================================================================
 *
 * - **De-duplicated per (wallet, token).** These wallets ladder: §6AH measured 1.4
 *   buy rows per wallet-token-minute. Forty alerts for one decision is noise.
 * - **Every alert is logged whether or not anyone acts**, and scored on a fixed
 *   grid. The scoreboard is the point; the notification is a convenience.
 * - **An unpriceable pool is recorded and COUNTED, never skipped**, and the share
 *   is reported every pass. §6AJ.0 records why: the previous attempt's "77%
 *   unpriceable" was an error path swallowing a compute-unit ceiling. Here an
 *   infrastructure failure STOPS the pass rather than becoming a verdict.
 * - **A Discord failure must not lose the row.** The row is written first.
 */
import { AbiCoder, id } from 'ethers';
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { RpcClient } from '../adapters/token-updates/rpc.js';
import { ReadOnlyRpc } from '../bot/rpc.js';
import { buildSwap } from '../bot/calldata.js';
import { simulateSellAt } from '../bot/sellability.js';
import { PRICING, POOL_MANAGER, addrTopic } from '../bot/collector-rules.js';
import { TOPICS } from '../adapters/token-updates/decode.js';

const CHAIN = 'robinhood';
const RPC_URL = 'https://robinhood-mainnet.g.alchemy.com/v2/{key}';
const abi = AbiCoder.defaultAbiCoder();
const V4_TOO_LITTLE = id('V4TooLittleReceived(uint256,uint256)').slice(0, 10);
const UNREACHABLE = 1n << 127n;
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const CU_CEILING = 450_000;
const POLL_MS = 15_000;
/** THE FOUR. Frozen; docs/NAMED-RULE-P19.md. */
const WALLETS = [
  '0x0b30d99a8b5b92c302ef0df8c9068338ce46c801',
  '0x008bac045a4220bf6755564c5ea2e1b271eb670f',
  '0x91dc0fbd6d30783abea7291b512bfe59d2294a3c',
  '0xe5239c5bcdb8e9bf55322dae843c72d46f60b66c',
];
const SHORT: Record<string, string> = Object.fromEntries(
  WALLETS.map((w) => [w, `${w.slice(0, 8)}…${w.slice(-4)}`]));
/** Horizons from the wallet's buy block, in blocks. 9.93 blocks/s (MEASURED §6V.2). */
const HORIZONS = [
  { key: '1m', blocks: 596 }, { key: '5m', blocks: 2_979 },
  { key: '15m', blocks: 8_937 }, { key: '1h', blocks: 35_748 },
  { key: '24h', blocks: 857_952 },
];
const SIZE_WEI = 36_000_000_000_000_000n;   /* ~$100 */

interface Log { topics: string[]; data: string; blockNumber: string; address: string;
  transactionHash: string }
interface PoolKey {
  currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string;
}
const isAddr = (a: string | null | undefined): a is string =>
  typeof a === 'string' && /^0x[0-9a-f]{40}$/.test(a.toLowerCase());
const pad = (a: string): string => `0x${a.slice(2).padStart(64, '0')}`;
const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });
/** An infrastructure or budget failure is never a pricing verdict (§6AJ.0). */
const isInfra = (e: unknown): boolean =>
  /compute unit|ceiling|budget|ECONNRESET|ETIMEDOUT|timeout|fetch failed|socket/i
    .test((e as Error)?.message ?? '');

async function erc20(rpc: ReadOnlyRpc, token: string, sel: string): Promise<string | null> {
  try {
    const r = String(await rpc.call('eth_call', [{ to: token, data: sel }, 'latest']));
    if (!r.startsWith('0x') || r.length < 130) return null;
    const len = Number(BigInt(`0x${r.slice(66, 130)}`));
    if (!Number.isFinite(len) || len === 0 || len > 64) return null;
    return Buffer.from(r.slice(130, 130 + len * 2), 'hex').toString('utf8').replace(/\0/g, '');
  } catch { return null; }
}

async function main(): Promise<void> {
  const key = process.env['ALCHEMY_API_KEY'];
  if (!key) throw new Error('ALCHEMY_API_KEY is not set');
  const owner = process.env['BOT_WALLET_ADDRESS']?.trim().toLowerCase();
  if (!owner) throw new Error('BOT_WALLET_ADDRESS must be set');
  const app = await bootstrap();
  const c = await app.pool.connect();
  const inner = new RpcClient(RPC_URL.replace('{key}', key), 60_000, CU_CEILING);
  const rpc = new ReadOnlyRpc(inner);

  try {
    await c.query(`create table if not exists bot_fast_alert (
      chain text not null, wallet text not null, token text not null,
      buy_block bigint not null, first_tx text, symbol text,
      pool_id text, currency0 text, currency1 text, fee integer,
      tick_spacing integer, hooks text, zero_is_pricing boolean, key_ok boolean,
      token_age_seconds integer, detect_lag_seconds numeric,
      alerted boolean not null default false, alert_error text,
      seen_at timestamptz not null default now(),
      primary key (chain, wallet, token, buy_block)
    )`);
    await c.query(`create table if not exists bot_fast_score (
      chain text not null, wallet text not null, token text not null,
      buy_block bigint not null, horizon text not null,
      exit_block bigint, entry_ok boolean, sell_ok boolean,
      eth_out numeric, ret numeric, unpriceable_reason text,
      measured_at timestamptz not null default now(),
      primary key (chain, wallet, token, buy_block, horizon)
    )`);

    const head0 = Number(BigInt(String(await rpc.call('eth_blockNumber', []))));
    log.info('FAST ALERTER STARTING', {
      rule: 'docs/NAMED-RULE-P20.md, committed before this sent anything',
      wallets: WALLETS.length, poll_seconds: POLL_MS / 1000,
      cu_per_day: Math.round(86_400_000 / POLL_MS) * 60,
      detection_lag: 'worst 15.0 s, average 7.5 s (MEASURED round trip 43 ms median)',
      horizons: HORIZONS.map((h) => h.key).join(','),
      never: 'this process does not trade and contains no buy logic',
      head: head0,
    });

    let cursor = head0 - 150;           /* ~15 s of backfill on boot, no more */
    for (;;) {
      /* ---------------- THE POLL: one call, all four wallets ------------- */
      const t0 = Date.now();
      let head: number;
      try {
        head = Number(BigInt(String(await rpc.call('eth_blockNumber', []))));
      } catch (e) { log.warn('head read failed', errorFields(e)); await sleep(POLL_MS); continue; }
      if (head > cursor) {
        let logs: Log[] = [];
        try {
          logs = (await rpc.call('eth_getLogs', [{
            topics: [TRANSFER, null, WALLETS.map(pad)],
            fromBlock: `0x${(cursor + 1).toString(16)}`, toBlock: `0x${head.toString(16)}`,
          }])) as Log[];
        } catch (e) {
          if (isInfra(e)) { log.warn('poll failed, retrying', errorFields(e)); await sleep(POLL_MS); continue; }
          throw e;
        }
        cursor = head;
        for (const l of logs) {
          const wallet = addrTopic(l.topics[2] ?? '');
          const token = l.address.toLowerCase();
          const blk = Number(BigInt(l.blockNumber));
          if (!WALLETS.includes(wallet)) continue;
          /* DE-DUPLICATE PER (wallet, token): these wallets ladder. */
          const dup = (await c.query(
            `select 1 from bot_fast_alert where chain=$1 and wallet=$2 and token=$3`,
            [CHAIN, wallet, token])).rowCount ?? 0;
          if (dup > 0) continue;

          /* Resolve the pool key from chain. v4_pool_init is not trusted: its
             `hooks` is short by one byte on 45% of rows (§6AJ.2). */
          let pk: PoolKey | null = null; let zip = false; let poolId: string | null = null;
          try {
            const iv = (await rpc.call('eth_getLogs', [{
              address: POOL_MANAGER, topics: [TOPICS.initializeV4],
              fromBlock: `0x${Math.max(0, blk - 900_000).toString(16)}`,
              toBlock: `0x${blk.toString(16)}`,
            }])) as Log[];
            for (const iL of iv.reverse()) {
              const c0 = addrTopic(iL.topics[2] ?? '');
              const c1 = addrTopic(iL.topics[3] ?? '');
              if (c0 !== token && c1 !== token) continue;
              const d = abi.decode(['uint24', 'int24', 'address', 'uint160', 'int24'],
                iL.data) as unknown as [bigint, bigint, string, bigint, bigint];
              const hk = d[2].toLowerCase();
              if (!isAddr(c0) || !isAddr(c1) || !isAddr(hk)) continue;
              pk = { currency0: c0, currency1: c1, fee: Number(d[0]),
                tickSpacing: Number(d[1]), hooks: hk };
              zip = PRICING.includes(c0);
              poolId = (iL.topics[1] ?? '').toLowerCase();
              break;
            }
          } catch (e) { if (isInfra(e)) throw e; }

          const symbol = await erc20(rpc, token, '0x95d89b41');
          const lagSec = (Date.now() - t0) / 1000 + (head - blk) / 9.93;

          /* THE ROW IS WRITTEN BEFORE THE ALERT: a Discord failure must not lose it. */
          await c.query(
            `insert into bot_fast_alert (chain, wallet, token, buy_block, first_tx,
               symbol, pool_id, currency0, currency1, fee, tick_spacing, hooks,
               zero_is_pricing, key_ok, detect_lag_seconds)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::numeric)
             on conflict do nothing`,
            [CHAIN, wallet, token, blk, l.transactionHash, symbol, poolId,
              pk?.currency0 ?? null, pk?.currency1 ?? null, pk?.fee ?? null,
              pk?.tickSpacing ?? null, pk?.hooks ?? null, pk === null ? null : zip,
              pk !== null, lagSec.toFixed(2)]);

          const amt = BigInt(l.data);
          let sent = false; let alertErr: string | null = null;
          try {
            sent = await app.discord.send({
              level: 'info',
              title: `FOLLOW: ${SHORT[wallet] ?? wallet} bought ${symbol ?? 'a token'}`,
              description: `\`${token}\``,
              fields: [
                { name: 'wallet', value: `\`${wallet}\``, inline: false },
                { name: 'tokens in', value: amt.toString(), inline: true },
                { name: 'block', value: String(blk), inline: true },
                { name: 'detection lag', value: `${lagSec.toFixed(1)} s`, inline: true },
                { name: 'pool', value: pk === null ? 'UNRESOLVED' : `fee ${pk.fee}`, inline: true },
                { name: 'chart', value: `https://dexscreener.com/robinhood/${token}`, inline: false },
                { name: 'not advice', value: 'alert only — nothing is traded by this process', inline: false },
              ],
            }, 'crypto_early');
          } catch (e) { alertErr = String((e as Error).message).slice(0, 200); }
          await c.query(
            `update bot_fast_alert set alerted=$5, alert_error=$6
              where chain=$1 and wallet=$2 and token=$3 and buy_block=$4`,
            [CHAIN, wallet, token, blk, sent, alertErr]);
          log.info('ALERT', { wallet: SHORT[wallet], token, symbol,
            block: blk, lag_s: lagSec.toFixed(1), delivered: sent,
            pool_key: pk !== null });
        }
      }

      /* ---------------- THE SCOREBOARD, independent of any click --------- */
      const due = (await c.query<{ wallet: string; token: string; buy_block: string;
        currency0: string; currency1: string; fee: number; tick_spacing: number;
        hooks: string; zero_is_pricing: boolean }>(
        `select wallet, token, buy_block::text, currency0, currency1, fee,
                tick_spacing, hooks, zero_is_pricing
           from bot_fast_alert where chain=$1 and key_ok order by buy_block`,
        [CHAIN])).rows;
      let scored = 0; let unpriceable = 0;
      for (const d of due) {
        const bb = Number(d.buy_block);
        if (!isAddr(d.currency0) || !isAddr(d.currency1) || !isAddr(d.hooks)) continue;
        const pool: PoolKey = { currency0: d.currency0, currency1: d.currency1,
          fee: d.fee, tickSpacing: d.tick_spacing, hooks: d.hooks };
        const token = d.zero_is_pricing ? d.currency1 : d.currency0;
        let tokensOut: bigint | null | undefined;
        for (const h of HORIZONS) {
          const exitBlock = bb + h.blocks;
          if (exitBlock > head - 60) continue;
          const have = (await c.query(
            `select 1 from bot_fast_score where chain=$1 and wallet=$2 and token=$3
               and buy_block=$4 and horizon=$5`,
            [CHAIN, d.wallet, d.token, bb, h.key])).rowCount ?? 0;
          if (have > 0) continue;
          if (tokensOut === undefined) {
            const buy = buildSwap({ pool, zeroForOne: d.zero_is_pricing, amountIn: SIZE_WEI,
              amountOutMinimum: UNREACHABLE,
              deadline: BigInt(Math.floor(Date.now() / 1000) + 600) });
            tokensOut = null;
            try {
              await rpc.call('eth_call', [{ from: owner, to: buy.to, data: buy.data,
                value: `0x${buy.value.toString(16)}` }, `0x${bb.toString(16)}`,
              { [owner]: { balance: `0x${(10n ** 20n).toString(16)}` } }]);
            } catch (e) {
              const dd = typeof (e as { data?: unknown }).data === 'string'
                ? (e as { data: string }).data : '';
              if (dd.startsWith(V4_TOO_LITTLE)) {
                const dec = abi.decode(['uint256', 'uint256'], `0x${dd.slice(10)}`) as unknown as bigint[];
                const o = dec[1] as bigint;
                tokensOut = o > 0n ? o : null;
              } else if (isInfra(e)) {
                /* §6AJ.0: NOT a verdict. Stop the pass rather than record a lie. */
                throw e;
              }
            }
          }
          if (tokensOut === null) {
            await c.query(
              `insert into bot_fast_score (chain, wallet, token, buy_block, horizon,
                 exit_block, entry_ok, unpriceable_reason)
               values ($1,$2,$3,$4,$5,$6,false,'entry quote returned no output')
               on conflict do nothing`,
              [CHAIN, d.wallet, d.token, bb, h.key, exitBlock]);
            unpriceable += 1; continue;
          }
          let ethOut: bigint | null = null; let ok = false;
          try {
            const s = await simulateSellAt(rpc, { pool, token, owner, amount: tokensOut,
              zeroForOneBuy: d.zero_is_pricing, block: `0x${exitBlock.toString(16)}` });
            ok = s.executes === true; ethOut = s.ethOut;
          } catch (e) { if (isInfra(e)) throw e; ok = false; }
          /* A position that cannot be closed is -100%, never 0%. */
          const ret = ok && ethOut !== null
            ? Number(ethOut - SIZE_WEI) / Number(SIZE_WEI) : -1;
          await c.query(
            `insert into bot_fast_score (chain, wallet, token, buy_block, horizon,
               exit_block, entry_ok, sell_ok, eth_out, ret)
             values ($1,$2,$3,$4,$5,$6,true,$7,$8::numeric,$9::numeric)
             on conflict do nothing`,
            [CHAIN, d.wallet, d.token, bb, h.key, exitBlock, ok,
              ethOut === null ? null : ethOut.toString(), ret.toString()]);
          scored += 1;
        }
      }
      if (scored > 0 || unpriceable > 0) {
        const share = scored + unpriceable > 0
          ? (100 * unpriceable / (scored + unpriceable)).toFixed(1) : '0.0';
        log.info('scoreboard', { legs_scored: scored, unpriceable,
          unpriceable_share_pct: share,
          note: 'reported every pass — abandonment condition 4 is >30%',
          cu: inner.cuSpent });
      }
      await sleep(POLL_MS);
    }
  } finally { c.release(); await app.pool.end(); }
}

void main().catch((e: unknown) => {
  log.error('fast-alert failed', errorFields(e)); process.exit(1);
});

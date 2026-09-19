/**
 * `npm run poolstrade-gate-drill` — 4D-5: DOES THE LIVE PRE-BUY GATE PASS A REAL
 * POOLS.TRADE LAUNCH?
 *
 * `checkSellable` is the gate `launchbot.ts` consults before committing money, and a
 * non-`ok` verdict is a refusal to buy. §6E.1 found two defects in the equivalent code
 * in `simulateSellAt`; until now `checkSellable` still carried both, which means **the
 * gate would have refused every Pools.trade launch — the exact population §6E.3
 * measures at 0 of 256 unsellable.**
 *
 * This exercises the fixed gate **against real Pools.trade tokens, not a double**, and
 * reports BEFORE and AFTER on the same tokens. The "before" is not recalled from a log:
 * the old discovery path is re-run here, on the same token, in the same call, so the
 * comparison is a measurement rather than a memory.
 *
 * **WHAT WOULD PROVE THE FIX WORTHLESS:** the integer scan finding the slots anyway. If
 * `integer_scan_found_both` is high, these tokens were never the problem and something
 * else was.
 */
import { concat, id, keccak256, toBeHex, zeroPadValue } from 'ethers';
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { RpcClient } from '../adapters/token-updates/rpc.js';
import { ReadOnlyRpc } from '../bot/rpc.js';
import { checkSellable } from '../bot/sellability.js';
import { poolIdOf } from '../bot/pool-state.js';
import { TOPICS } from '../adapters/token-updates/decode.js';
import { AbiCoder } from 'ethers';

const RPC_URL = 'https://robinhood-mainnet.g.alchemy.com/v2/{key}';
const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const PT_FACTORY = '0x000000e200088d55c39a11f609e5f667729ad49b';
const TOKEN_CREATED = '0x4ef8284ecf42d4cd19686572ffd87f630858c82398911e776cb831de35eddbf4';
const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3';
const abi = AbiCoder.defaultAbiCoder();
const h32 = (v: bigint | number | string): string => zeroPadValue(toBeHex(v), 32);
const mapSlot = (k: string, s: number): string => keccak256(concat([h32(k), h32(s)]));
const MAGIC = 987654321098765432109876n;
const MAX_SLOT = 24;
const SAMPLE = 12;

interface Log { topics: string[]; data: string; blockNumber: string; transactionHash: string }

async function main(): Promise<void> {
  const key = process.env['ALCHEMY_API_KEY'];
  if (!key) throw new Error('ALCHEMY_API_KEY is not set');
  const owner = process.env['BOT_WALLET_ADDRESS']?.trim().toLowerCase();
  if (!owner) throw new Error('BOT_WALLET_ADDRESS must be set');
  const app = await bootstrap();
  const c = await app.pool.connect();
  const inner = new RpcClient(RPC_URL.replace('{key}', key), 60_000, 300_000);
  const rpc = new ReadOnlyRpc(inner);

  try {
    const head = Number(BigInt(String(await rpc.call('eth_blockNumber', []))));
    /* Recent canonical launches: TokenCreated and Initialize in one transaction. */
    const created = (await rpc.call('eth_getLogs', [{
      address: PT_FACTORY, topics: [TOKEN_CREATED],
      fromBlock: `0x${(head - 200_000).toString(16)}`, toBlock: `0x${head.toString(16)}`,
    }])) as Log[];
    const txs = new Set(created.map((l) => l.transactionHash.toLowerCase()));
    const inits = (await rpc.call('eth_getLogs', [{
      address: POOL_MANAGER, topics: [TOPICS.initializeV4],
      fromBlock: `0x${(head - 200_000).toString(16)}`, toBlock: `0x${head.toString(16)}`,
    }])) as Log[];
    const canon = inits.filter((l) => txs.has(l.transactionHash.toLowerCase()));

    log.info('REAL POOLS.TRADE LAUNCHES FOUND', {
      window: `${head - 200_000}..${head}`,
      TokenCreated: created.length,
      canonical_pools: canon.length,
      sampling: Math.min(SAMPLE, canon.length),
    });
    if (canon.length === 0) {
      log.error('NO CANONICAL POOLS FOUND — the drill proves nothing', {});
      return;
    }

    const rows: string[] = [];
    let newOk = 0; let intBoth = 0; let infiniteAllowance = 0;
    for (const l of canon.slice(-SAMPLE)) {
      const pid = (l.topics[1] ?? '').toLowerCase();
      const c0 = `0x${(l.topics[2] ?? '').slice(26)}`.toLowerCase();
      const c1 = `0x${(l.topics[3] ?? '').slice(26)}`.toLowerCase();
      const d = abi.decode(['uint24', 'int24', 'address', 'uint160', 'int24'], l.data) as
        unknown as [bigint, bigint, string, bigint, bigint];
      const pool = { currency0: c0, currency1: c1, fee: Number(d[0]),
        tickSpacing: Number(d[1]), hooks: d[2].toLowerCase() };
      if (poolIdOf(pool).toLowerCase() !== pid) continue;
      const zeroIsPricing = c0 === '0x0000000000000000000000000000000000000000';
      const token = zeroIsPricing ? c1 : c0;

      /* ---- BEFORE: the integer scan alone, re-run here on this token ------ */
      const balData = `0x70a08231${owner.slice(2).padStart(64, '0')}`;
      const alData = `0xdd62ed3e${owner.slice(2).padStart(64, '0')}`
        + PERMIT2.slice(2).padStart(64, '0');
      let intBal: number | null = null; let intAllow: number | null = null;
      for (let i = 0; i < MAX_SLOT; i += 1) {
        try {
          const r = String(await rpc.call('eth_call', [{ to: token, data: balData }, 'latest',
            { [token]: { stateDiff: { [mapSlot(owner, i)]: h32(MAGIC) } } }]));
          if (BigInt(r) === MAGIC) { intBal = i; break; }
        } catch { /* next */ }
      }
      for (let i = 0; i < MAX_SLOT; i += 1) {
        const slot = keccak256(concat([h32(PERMIT2), mapSlot(owner, i)]));
        try {
          const r = String(await rpc.call('eth_call', [{ to: token, data: alData }, 'latest',
            { [token]: { stateDiff: { [slot]: h32(MAGIC) } } }]));
          if (BigInt(r) === MAGIC) { intAllow = i; break; }
        } catch { /* next */ }
      }
      if (intBal !== null && intAllow !== null) intBoth += 1;

      /* The allowance itself, to show WHY there is no slot. */
      let allowNow = 'unreadable';
      try {
        const r = String(await rpc.call('eth_call', [{ to: token, data: alData }, 'latest']));
        if (r.length >= 66) {
          const v = BigInt(r);
          allowNow = v === (1n << 256n) - 1n ? 'MAX_UINT256' : v.toString();
          if (v > (1n << 200n)) infiniteAllowance += 1;
        }
      } catch { /* stays unreadable */ }

      /* ---- AFTER: the fixed gate, the real one launchbot calls ------------ */
      const v = await checkSellable(rpc, {
        pool, token, owner, amountInWei: 562_000_000_000_000n,
        zeroForOneBuy: zeroIsPricing,
      });
      if (v.reason === 'ok') newOk += 1;

      rows.push(`${token.slice(0, 12)} fee=${pool.fee} `
        + `BEFORE(integer scan): bal=${intBal === null ? 'NOT FOUND' : String(intBal)} `
        + `allow=${intAllow === null ? 'NOT FOUND' : String(intAllow)} `
        + `-> ${intBal === null || intAllow === null ? 'slots_not_found = REFUSE TO BUY' : 'would have worked'} `
        + `| allowance(owner,Permit2)=${allowNow} `
        + `| AFTER: reason=${v.reason} sellable=${String(v.sellable)} `
        + `ethOut=${v.ethOut === null ? 'null' : v.ethOut.toString()} calls=${v.calls}`);
    }

    log.info('*** 4D-5  THE LIVE GATE, BEFORE AND AFTER, ON THE SAME REAL TOKENS ***', {
      tokens: rows.length,
      BEFORE_integer_scan_found_both_slots: `${intBoth} of ${rows.length}`,
      AFTER_gate_returns_ok: `${newOk} of ${rows.length}`,
      tokens_with_an_effectively_infinite_Permit2_allowance:
        `${infiniteAllowance} of ${rows.length}`,
      what_would_prove_the_fix_worthless:
        'a high BEFORE count — that would mean these tokens were never the problem',
      verdict: rows.length === 0 ? 'NO TOKENS TESTED — proves nothing'
        : intBoth === 0 && newOk === rows.length
          ? 'CONFIRMED: the old gate refused every one of these and the fixed gate '
            + 'passes every one'
          : `MIXED: before=${intBoth}, after=${newOk} — read the rows`,
      rows,
      cu: inner.cuSpent,
    });
  } finally { c.release(); await app.pool.end(); }
}

void main().catch((e: unknown) => { log.error('poolstrade-gate-drill failed', errorFields(e)); process.exit(1); });

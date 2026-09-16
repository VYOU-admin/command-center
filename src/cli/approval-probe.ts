/**
 * `npm run approval-probe -- --sample N [--commit]`
 *
 * DOES SELLING REQUIRE AN APPROVAL FIRST, AND WHAT DOES IT COST?
 *
 * The buy leg needs neither a wrap nor an approval -- `tx.value` equals the ETH paid in
 * 125 of 143 sampled buys. The sell leg sends an ERC-20 into a contract, which normally
 * needs an allowance, and at $10 positions an extra transaction per token could be a
 * material share of a +15% median. This measures it instead of assuming it.
 *
 * For each sampled SELL it sweeps `Approval` logs emitted by that token, filtered to
 * that seller as owner, over the blocks preceding the sell, and reports WHO was
 * approved. The Approval topic is computed with keccak256 rather than recalled --
 * ROBINHOOD.md records a fabricated topic shipping here once, and the same keccak
 * reproduces all three topics that document already carries.
 *
 * Gas comes from real receipts on both the sell and any approval found. Nothing is
 * assumed; a leg that cannot be read is reported as unread.
 */
import { id } from 'ethers';
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { RpcClient } from '../adapters/token-updates/rpc.js';

const RPC_URL = 'https://robinhood-mainnet.g.alchemy.com/v2/{key}';
const GETLOGS_CU = 60;
const RECEIPT_CU = 15;
const USD_PER_MCU = 0.45;
/** Computed, not recalled. */
const APPROVAL_TOPIC = id('Approval(address,address,uint256)');
/** How far back to look for an allowance. 200,000 blocks is ~5.6 h at 0.1 s. */
const LOOKBACK = 200000;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const num = (f: string, d: number): number => {
    const i = args.indexOf(f); return i >= 0 ? Number(args[i + 1] ?? d) : d;
  };
  const sample = num('--sample', 40);
  const commit = args.includes('--commit');

  const app = await bootstrap();
  const c = await app.pool.connect();
  try {
    await c.query('set statement_timeout = 0');
    const rows = await c.query<{
      tx_hash: string; pool_id: string; tx_from: string; tx_to: string;
      bn: string; token: string;
    }>(
      `select t.tx_hash, t.pool_id, t.tx_from, t.tx_to, s.block_number::text bn,
              case when i.currency0 in
                   ('0x0bd7d308f8e1639fab988df18a8011f41eacad73',
                    '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
                    '0x0000000000000000000000000000000000000000')
                   then i.currency1 else i.currency0 end token
         from v4_swap_tx t
         join v4_swaps_all s on s.tx_hash = t.tx_hash and s.pool_id = t.pool_id
         join v4_pool_init i on i.pool_id = t.pool_id
        where t.side = 'sell'
        order by t.tx_hash limit ${sample}`);

    const estCu = rows.rowCount! * (GETLOGS_CU + RECEIPT_CU) + rows.rowCount! * RECEIPT_CU;
    log.info('APPROVAL PROBE WORK SET, derived BEFORE the first request', {
      sells_to_examine: rows.rowCount,
      approval_topic_COMPUTED: APPROVAL_TOPIC,
      lookback_blocks: LOOKBACK,
      estimate: { cu: estCu, usd: ((estCu * USD_PER_MCU) / 1e6).toFixed(5) },
      commit,
      note: 'one eth_getLogs per sell for Approval, plus receipts for the sell and any '
        + 'approval found',
    });
    if (rows.rowCount === 0) {
      throw new Error('no sell transactions stored. RETURNED NO ROWS is a defect here, '
        + 'not a clean pass -- run route-probe --side sell first.');
    }
    if (!commit) {
      log.info('DRY RUN -- nothing read', { note: 'pass --commit to spend' });
      c.release(); await app.pool.end(); process.exit(0);
    }

    const key = process.env['ALCHEMY_API_KEY'];
    if (!key) throw new Error('ALCHEMY_API_KEY is not set');
    const rpc = new RpcClient(RPC_URL.replace('{key}', key), 120000,
      Math.max(10000, Math.ceil(estCu * 1.6)));

    const spenders = new Map<string, number>();
    const sellGas: number[] = []; const apprGas: number[] = [];
    let withApproval = 0; let withoutApproval = 0; let unread = 0;

    for (const r of rows.rows) {
      const bn = Number(r.bn);
      const topic = `0x000000000000000000000000${r.tx_from.slice(2)}`;
      try {
        const logs = (await rpc.raw('eth_getLogs', [{
          address: r.token, topics: [APPROVAL_TOPIC, topic],
          fromBlock: `0x${Math.max(0, bn - LOOKBACK).toString(16)}`,
          toBlock: `0x${bn.toString(16)}`,
        }])) as Array<{ topics: string[]; transactionHash: string }>;
        if (!Array.isArray(logs) || logs.length === 0) { withoutApproval += 1; continue; }
        withApproval += 1;
        for (const l of logs) {
          const sp = `0x${(l.topics[2] ?? '').slice(26)}`.toLowerCase();
          spenders.set(sp, (spenders.get(sp) ?? 0) + 1);
        }
        const ar = (await rpc.raw('eth_getTransactionReceipt',
          [logs[0]!.transactionHash])) as { gasUsed?: string; effectiveGasPrice?: string } | null;
        if (ar?.gasUsed && ar.effectiveGasPrice) {
          apprGas.push(Number(BigInt(ar.gasUsed) * BigInt(ar.effectiveGasPrice)) / 1e18);
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes('compute-unit ceiling')) throw err;
        unread += 1;
      }
      try {
        const sr = (await rpc.raw('eth_getTransactionReceipt', [r.tx_hash])) as
          { gasUsed?: string; effectiveGasPrice?: string } | null;
        if (sr?.gasUsed && sr.effectiveGasPrice) {
          sellGas.push(Number(BigInt(sr.gasUsed) * BigInt(sr.effectiveGasPrice)) / 1e18);
        }
      } catch { /* counted below by length */ }
    }
    const eth = await c.query<{ e: string }>(
      `select eth_usd::text e from native_usd_prices order by block_number desc limit 1`);
    const ethUsd = Number(eth.rows[0]?.e ?? 0);
    const med = (a: number[]): number => (a.length
      ? [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) / 2)]! : 0);

    log.info('APPROVAL AND GAS, measured', {
      sells_examined: rows.rowCount,
      sells_WITH_a_prior_approval_by_that_seller: withApproval,
      sells_WITHOUT_one_in_the_lookback: withoutApproval,
      unread,
      spenders_approved: [...spenders.entries()]
        .sort((a, b) => b[1] - a[1]).slice(0, 8)
        .map(([addr, n]) => ({ spender: addr, approvals: n })),
      eth_usd_used: ethUsd,
      sell_leg_gas_usd_median: (med(sellGas) * ethUsd).toFixed(5),
      approval_gas_usd_median: apprGas.length
        ? (med(apprGas) * ethUsd).toFixed(5) : 'RETURNED NO ROWS -- no approval receipt read',
      sell_receipts_read: sellGas.length,
      approval_receipts_read: apprGas.length,
      cu_spent: rpc.cuSpent,
      usd: ((rpc.cuSpent * USD_PER_MCU) / 1e6).toFixed(5),
    });
  } finally { c.release(); }
  await app.pool.end();
  process.exit(0);
}
main().catch((e) => { log.error('approval-probe failed', errorFields(e)); process.exit(1); });

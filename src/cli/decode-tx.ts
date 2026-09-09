/**
 * `npm run decode-tx -- <config.yaml> <txhash> [<txhash> ...]`
 *
 * Prints what a transaction actually contains: every `Swap` the PoolManager or
 * a v3 pool emitted, with its amounts decoded, and every transfer of the token,
 * with who sent and who received. Read only.
 *
 * It exists because an aggregate is a hypothesis. A residual measured across
 * tens of thousands of rows says nothing about its cause, and this project has
 * twice had a large conclusion overturned by decoding twenty transactions.
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { loadIntakeConfig } from '../intake/plan.js';
import { RpcClient } from '../adapters/token-updates/rpc.js';
import { TOPICS, addressFromTopic, classifyCode } from '../adapters/token-updates/decode.js';

const i128 = (hex: string): bigint => {
  const v = BigInt('0x' + hex);
  return v >= 1n << 127n ? v - (1n << 128n) : v;
};
const fmt = (raw: bigint, dec: number): string => {
  const neg = raw < 0n; const v = neg ? -raw : raw;
  const s = v.toString().padStart(dec + 1, '0');
  const w = s.slice(0, s.length - dec);
  const f = dec ? s.slice(s.length - dec).replace(/0+$/, '') : '';
  return (neg ? '-' : '') + w + (f ? '.' + f : '');
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const configPath = args[0];
  const hashes = args.slice(1).filter((a) => a.startsWith('0x') && a.length === 66);
  if (!configPath || hashes.length === 0) {
    throw new Error('usage: decode-tx <config.yaml> <txhash> [...]');
  }
  const cfg = await loadIntakeConfig(configPath);
  const app = await bootstrap();
  const key = app.env.configVars.get(cfg.rpcKeyVar);
  if (!key) throw new Error(`${cfg.rpcKeyVar} is not set in this process`);
  const rpc = new RpcClient(cfg.rpcUrlTemplate.replace('{key}', key), cfg.requestTimeoutMs, 20000);
  const token = cfg.token.toLowerCase();
  const pm = cfg.v4PoolManager.toLowerCase();
  const kinds = new Map<string, string>();

  for (const h of hashes) {
    const r = (await rpc.raw('eth_getTransactionReceipt', [h])) as {
      logs?: { address: string; topics: string[]; data: string }[];
    } | null;
    const tx = (await rpc.raw('eth_getTransactionByHash', [h])) as {
      from?: string; to?: string; value?: string;
    } | null;
    if (!r || !tx) throw new Error(`could not read ${h}`);

    const out: unknown[] = [];
    for (const l of r.logs ?? []) {
      const t0 = (l.topics[0] ?? '').toLowerCase();
      const addr = l.address.toLowerCase();
      const d = l.data.slice(2);
      if (t0 === TOPICS.swapV4.toLowerCase() && addr === pm) {
        out.push({
          event: 'v4 Swap', pool_id: l.topics[1],
          sender_topic: addressFromTopic(l.topics[2] ?? ''),
          amount0: i128(d.slice(0, 64)).toString(),
          amount1: i128(d.slice(64, 128)).toString(),
          tick: Number(BigInt('0x' + d.slice(256, 320)) & 0xffffffn),
        });
      } else if (t0 === TOPICS.swapV3.toLowerCase()) {
        out.push({
          event: 'v3 Swap', pool: addr,
          sender: addressFromTopic(l.topics[1] ?? ''),
          recipient: addressFromTopic(l.topics[2] ?? ''),
          amount0: i128(d.slice(0, 64)).toString(),
          amount1: i128(d.slice(64, 128)).toString(),
        });
      } else if (t0 === TOPICS.transfer.toLowerCase() && addr === token && l.topics.length >= 3) {
        const from = addressFromTopic(l.topics[1]!);
        const to = addressFromTopic(l.topics[2]!);
        for (const a of [from, to]) {
          if (!kinds.has(a)) kinds.set(a, classifyCode(await rpc.getCode(a, 'latest' as never)));
        }
        out.push({
          event: 'TOKEN Transfer',
          from, from_is: from === pm ? 'PoolManager' : kinds.get(from),
          to, to_is: to === pm ? 'PoolManager' : kinds.get(to),
          amount: fmt(BigInt(l.data === '0x' ? '0x0' : l.data), 18),
        });
      }
    }
    log.info(h, {
      tx_from: (tx.from ?? '').toLowerCase(), tx_to: (tx.to ?? '').toLowerCase(),
      value_wei: BigInt(tx.value ?? '0x0').toString(),
      total_logs: (r.logs ?? []).length, decoded: out,
    });
  }
  log.info('cost', { cu_spent: rpc.cuSpent, dollars: ((rpc.cuSpent * 0.45) / 1e6).toFixed(4) });
  await app.pool.end();
  process.exit(0);
}

main().catch((err) => { log.error('decode-tx failed', errorFields(err)); process.exit(1); });

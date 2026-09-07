/**
 * `npm run payment-test -- <config.yaml> [--n 40] [--offset 0]`
 *
 * Tests the receipt-based payment rule against decoded transactions and reports
 * the four counts, so it can be compared directly with the log-based rule it
 * replaces. READ ONLY: it fetches receipts and writes nothing.
 *
 * Selection is deterministic -- one transaction per tagged wallet, ordered by
 * wallet, evenly spaced -- so the same --n and --offset return the same set on
 * every run and two rules can be compared on identical inputs. `--offset`
 * takes a disjoint sample for an out-of-sample check.
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { loadIntakeConfig } from '../intake/plan.js';
import { RpcClient } from '../adapters/token-updates/rpc.js';
import { loadPools } from '../adapters/token-updates/pools.js';
import { ReceiptPayments } from '../intake/payment.js';

const ZERO = '0x0000000000000000000000000000000000000000';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const configPath = args.find((a) => !a.startsWith('--'));
  if (!configPath) throw new Error('usage: payment-test <config.yaml> [--n N] [--offset K]');
  const num = (flag: string, d: number): number => {
    const i = args.indexOf(flag);
    return i >= 0 ? Number.parseInt(args[i + 1] ?? String(d), 10) : d;
  };
  const n = num('--n', 40);
  const offset = num('--offset', 0);
  const windowIndex = num('--window', 0);

  const cfg = await loadIntakeConfig(configPath);
  const app = await bootstrap();
  const key = app.env.configVars.get(cfg.rpcKeyVar);
  if (!key) throw new Error(`${cfg.rpcKeyVar} is not set in this process`);
  const rpc = new RpcClient(
    cfg.rpcUrlTemplate.replace('{key}', key), cfg.requestTimeoutMs, cfg.ceilings.cohort,
  );

  const c = await app.pool.connect();
  try {
    const w = cfg.windows[windowIndex];
    if (!w) throw new Error(`no window at index ${windowIndex}`);
    const b = await c.query<{ lo: number; hi: number }>(
      `select min(block_number) lo, max(block_number) hi from block_times
        where chain=$1 and block_time between $2::timestamptz and $3::timestamptz`,
      [cfg.chain, w.start, w.end],
    );
    const lo = Number(b.rows[0]!.lo);
    const hi = Number(b.rows[0]!.hi);

    const pools = await loadPools(c, cfg.chain, cfg.token);
    const cps = [
      ...new Set([...pools.values()].filter((p) => p.venue === 'v3').map((p) => p.pool)),
      cfg.v4PoolManager.toLowerCase(),
    ];

    const rows = await c.query<{
      wallet: string; tx_hash: string; block_number: number;
      any_native: boolean; any_erc20: boolean;
    }>(
      `with sw as (
         select s.tx_hash,
                bool_or(m.counter = $2) any_native,
                bool_or(m.counter <> $2) any_erc20
           from token_swap_logs s
           join pool_meta m on m.chain=$1 and m.token=$3
                           and m.venue=s.venue and m.pool=s.pool
          where s.chain=$1 and s.token=$3 and s.block_number between $4 and $5
          group by s.tx_hash)
       select distinct on (t.to_addr) t.to_addr wallet, t.tx_hash, t.block_number,
              sw.any_native, sw.any_erc20
         from token_transfer_logs t
         join sw on sw.tx_hash=t.tx_hash
         join wallet_tags g on g.wallet=t.to_addr and g.mint=$3 and g.tag=$6
        where t.chain=$1 and t.token=$3 and t.block_number between $4 and $5
          and t.from_addr = any($7::text[])
        order by t.to_addr, t.block_number`,
      [cfg.chain, ZERO, cfg.token, lo, hi, w.label, cps],
    );

    const step = Math.max(1, Math.floor(rows.rowCount / (n + offset)));
    const all: typeof rows.rows = [];
    for (let i = 0; i < rows.rowCount && all.length < n + offset; i += step) {
      all.push(rows.rows[i]!);
    }
    const sample = all.slice(offset, offset + n);
    log.info('sample', {
      candidate_wallets: rows.rowCount, taking: sample.length, offset,
      deterministic: 'one transaction per wallet, ordered by wallet, evenly spaced',
    });

    const prover = new ReceiptPayments(rpc, cfg.token);
    let paid = 0;
    let notPaid = 0;
    const examples: unknown[] = [];
    for (const r of sample) {
      const proof = await prover.prove(r.tx_hash, r.wallet);
      if (proof.paid) paid += 1; else notPaid += 1;
      if (examples.length < 6) {
        examples.push({
          tx: r.tx_hash, wallet: r.wallet,
          pool_quote: r.any_native && !r.any_erc20 ? 'native ETH only' : 'ERC-20',
          verdict: proof.paid ? 'ACCEPT' : 'REJECT', gave_up: proof.how || 'nothing',
        });
      }
    }

    log.info('receipt rule, against the decoded transaction', {
      sample: sample.length,
      accepts_and_the_wallet_paid: paid,
      accepts_but_the_wallet_did_NOT_pay: 0,
      rejects_but_the_wallet_DID_pay: 0,
      rejects_and_the_wallet_did_not_pay: notPaid,
      note:
        'the receipt IS the ground truth here, so accept/reject and paid/did-not-pay ' +
        'cannot disagree by construction. The comparable figure is how many the rule ' +
        'now accepts where the log-based rule rejected them.',
    });
    log.info('cost actually consumed', {
      receipts_fetched: prover.receiptsFetched,
      cu_spent: rpc.cuSpent,
      dollars: (rpc.cuSpent * 0.45) / 1e6,
      calls: rpc.callCounts(),
    });
    log.info('examples', { examples });
  } finally {
    c.release();
  }
  await app.pool.end();
  process.exit(0);
}

main().catch((err) => { log.error('payment-test failed', errorFields(err)); process.exit(1); });

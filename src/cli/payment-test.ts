/**
 * `npm run payment-test -- <config.yaml> [--n 40] [--offset 0]`
 *
 * Measures the receipt-based payment rule against an INDEPENDENT ground truth
 * and reports the four counts, so it can be compared directly with the
 * log-based rule it replaces.
 *
 * The independence matters. The receipt rule reads the transaction's emitted
 * logs plus its `value` field. If the same source were used to decide whether
 * the wallet "really" paid, the four counts would be 40/0/0/0 by construction
 * and would prove nothing. So ground truth here is the EXECUTION TRACE -- the
 * call tree, which is a different view of the same transaction:
 *
 *   native   any call in the tree whose sender is the wallet and whose value is
 *            non-zero. Fee payments are excluded; they are not a purchase.
 *   ERC-20   a `transfer` the wallet itself called, or a `transferFrom` naming
 *            the wallet as the source -- read from CALLDATA, not from logs.
 *
 * A token contract can emit a Transfer log without a matching call, and can
 * take a transferFrom without emitting one, so the two views can disagree.
 * Where they do, that is a finding rather than an error to smooth over.
 *
 * READ ONLY. Fetches receipts and traces; writes nothing; decides nothing.
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
const SEL_TRANSFER = '0xa9059cbb';
const SEL_TRANSFER_FROM = '0x23b872dd';

interface TraceCall {
  from?: string; to?: string; value?: string; input?: string;
  calls?: TraceCall[];
}

/** Every way the trace shows this wallet giving up value. Calldata, not logs. */
function traceGaveUp(root: TraceCall, wallet: string, token: string): string[] {
  const out: string[] = [];
  const walk = (c: TraceCall): void => {
    const from = (c.from ?? '').toLowerCase();
    const to = (c.to ?? '').toLowerCase();
    const input = (c.input ?? '0x').toLowerCase();
    const value = BigInt(c.value && c.value !== '0x' ? c.value : '0x0');

    if (from === wallet && value > 0n) out.push(`${value.toString()} wei native`);

    if (to !== token && input.length >= 10) {
      const sel = input.slice(0, 10);
      const arg = (i: number): string => '0x' + input.slice(10 + i * 64 + 24, 10 + (i + 1) * 64);
      if (sel === SEL_TRANSFER && from === wallet) {
        out.push(`transfer of ${to} called by the wallet`);
      } else if (sel === SEL_TRANSFER_FROM && input.length >= 10 + 64 * 3 && arg(0) === wallet) {
        out.push(`transferFrom(${wallet.slice(0, 10)}...) on ${to}`);
      }
    }
    for (const k of c.calls ?? []) walk(k);
  };
  walk(root);
  return out;
}

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
  const ceiling = num('--ceiling', 60000);

  const cfg = await loadIntakeConfig(configPath);
  const app = await bootstrap();
  const key = app.env.configVars.get(cfg.rpcKeyVar);
  if (!key) throw new Error(`${cfg.rpcKeyVar} is not set in this process`);
  const rpc = new RpcClient(
    cfg.rpcUrlTemplate.replace('{key}', key), cfg.requestTimeoutMs, ceiling,
  );

  const c = await app.pool.connect();
  try {
    const w = cfg.windows[windowIndex];
    if (!w) throw new Error(`no window at index ${windowIndex}`);
    const b = await c.query<{ lo: string | null; hi: string | null }>(
      `select min(block_number)::text lo, max(block_number)::text hi from block_times
        where chain=$1 and block_time between $2::timestamptz and $3::timestamptz`,
      [cfg.chain, w.start, w.end],
    );
    if (!b.rows[0]?.lo) throw new Error(`no block_times rows inside window ${w.label}`);
    const lo = Number(b.rows[0].lo);
    const hi = Number(b.rows[0].hi);

    const pools = await loadPools(c, cfg.chain, cfg.token);
    const cps = [
      ...new Set([...pools.values()].filter((p) => p.venue === 'v3').map((p) => p.pool)),
      cfg.v4PoolManager.toLowerCase(),
    ];

    const rows = await c.query<{
      wallet: string; tx_hash: string; block_number: string;
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
       select distinct on (t.to_addr) t.to_addr wallet, t.tx_hash,
              t.block_number::text, sw.any_native, sw.any_erc20
         from token_transfer_logs t
         join sw on sw.tx_hash=t.tx_hash
         join wallet_tags g on g.wallet=t.to_addr and g.mint=$3 and g.tag=$6
        where t.chain=$1 and t.token=$3 and t.block_number between $4 and $5
          and t.from_addr = any($7::text[])
        order by t.to_addr, t.block_number`,
      [cfg.chain, ZERO, cfg.token, lo, hi, w.label, cps],
    );

    // The original test split 34 from ERC-20-quoted pools and 6 from
    // native-only, then took each evenly spaced. Reproduced exactly so the same
    // transactions come back.
    const pick = <T,>(arr: T[], k: number): T[] => {
      const step = Math.max(1, Math.floor(arr.length / k));
      const o: T[] = [];
      for (let i = 0; i < arr.length && o.length < k; i += step) o.push(arr[i]!);
      return o;
    };
    const nativeOnly = rows.rows.filter((r) => r.any_native && !r.any_erc20);
    const erc20 = rows.rows.filter((r) => r.any_erc20);
    const share = (k: number): number => Math.round(k * 0.85);
    const all = [...pick(erc20, share(n + offset)), ...pick(nativeOnly, (n + offset) - share(n + offset))];
    const sample = offset === 0 ? all.slice(0, n) : all.slice(offset, offset + n);

    log.info('sample', {
      candidate_wallets: rows.rowCount ?? 0,
      on_erc20_quoted_pools: erc20.length,
      on_native_only_pools: nativeOnly.length,
      taking: sample.length, offset, window: w.label, blocks: `${lo}..${hi}`,
    });
    log.info('pinned', {
      note: 'these were printed by the previous test and must reappear here',
      first: sample[0]?.tx_hash, last: sample[sample.length - 1]?.tx_hash,
    });

    const prover = new ReceiptPayments(rpc, cfg.token);
    let traces = 0;
    const cells = { ap: 0, an: 0, rp: 0, rn: 0 };
    const disagreements: unknown[] = [];
    const examples: unknown[] = [];

    for (const r of sample) {
      const verdict = await prover.prove(r.tx_hash, r.wallet);
      const trace = (await rpc.raw('debug_traceTransaction', [
        r.tx_hash, { tracer: 'callTracer', tracerConfig: { onlyTopCall: false } },
      ])) as TraceCall | null;
      traces += 1;
      if (!trace) throw new Error(`no trace for ${r.tx_hash}; refusing to guess a verdict`);
      const gave = traceGaveUp(trace, r.wallet.toLowerCase(), cfg.token.toLowerCase());
      const truth = gave.length > 0;

      if (verdict.paid && truth) cells.ap += 1;
      else if (verdict.paid && !truth) cells.an += 1;
      else if (!verdict.paid && truth) cells.rp += 1;
      else cells.rn += 1;

      if (verdict.paid !== truth) {
        disagreements.push({
          tx: r.tx_hash, wallet: r.wallet,
          rule: verdict.paid ? 'ACCEPT' : 'REJECT',
          receipt_shows: verdict.how || 'nothing',
          trace_shows: gave.join(' + ') || 'nothing',
        });
      } else if (examples.length < 5) {
        examples.push({
          tx: r.tx_hash, wallet: r.wallet,
          pool_quote: r.any_native && !r.any_erc20 ? 'native ETH only' : 'ERC-20',
          verdict: verdict.paid ? 'ACCEPT' : 'REJECT',
          receipt: verdict.how || 'nothing', trace: gave.join(' + ') || 'nothing',
        });
      }
    }

    log.info('RECEIPT RULE vs the execution trace', {
      sample: sample.length,
      accepts_and_the_wallet_paid: cells.ap,
      accepts_but_the_wallet_did_NOT_pay: cells.an,
      rejects_but_the_wallet_DID_pay: cells.rp,
      rejects_and_the_wallet_did_not_pay: cells.rn,
      old_log_based_rule_scored: '1 / 0 / 39 / 0',
    });
    log.info('disagreements between the receipt and the trace', {
      count: disagreements.length, disagreements,
    });
    log.info('examples where they agree', { examples });
    log.info('cost actually consumed', {
      receipts_fetched: prover.receiptsFetched, traces_fetched: traces,
      cu_spent: rpc.cuSpent, dollars: ((rpc.cuSpent * 0.45) / 1e6).toFixed(4),
      ceiling, calls: rpc.callCounts(),
    });
  } finally {
    c.release();
  }
  await app.pool.end();
  process.exit(0);
}

main().catch((err) => { log.error('payment-test failed', errorFields(err)); process.exit(1); });

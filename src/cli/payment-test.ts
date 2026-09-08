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
  const randomN = num('--random', 0);
  const seedIdx = args.indexOf('--seed');
  const seed = seedIdx >= 0 ? (args[seedIdx + 1] ?? '') : '';
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

    // The deterministic first-40. Computed here even in random mode, because
    // they are what the random sample must EXCLUDE -- a second test that
    // re-scored the same transactions would only prove the rule is consistent
    // with itself.
    const firstForty = [...pick(erc20, 34), ...pick(nativeOnly, 6)];
    const excluded = new Set(firstForty.map((r) => r.tx_hash.toLowerCase()));

    let sample: typeof rows.rows;
    if (randomN > 0) {
      if (!seed) throw new Error('--random requires --seed, so the sample is reproducible');
      const pool = rows.rows.filter((r) => !excluded.has(r.tx_hash.toLowerCase()));
      // Deterministic under the seed, unrelated to block order, wallet order or
      // pool. Shuffling in JS keeps it auditable next to the exclusion set.
      const keyed = await c.query<{ tx_hash: string; k: string }>(
        `select h tx_hash, md5(h || $1) k from unnest($2::text[]) h order by 2`,
        [seed, pool.map((r) => r.tx_hash)],
      );
      const order = new Map(keyed.rows.map((r, i) => [r.tx_hash, i]));
      sample = [...pool].sort((a, b) => order.get(a.tx_hash)! - order.get(b.tx_hash)!)
        .slice(0, randomN);
      log.info('random sample', {
        seed, requested: randomN, pool_after_exclusion: pool.length,
        excluded_first_forty: excluded.size,
        overlap_with_first_forty: sample.filter((r) => excluded.has(r.tx_hash.toLowerCase())).length,
      });
    } else {
      const all = [...pick(erc20, share(n + offset)),
        ...pick(nativeOnly, (n + offset) - share(n + offset))];
      sample = offset === 0 ? all.slice(0, n) : all.slice(offset, offset + n);
    }

    log.info('sample', {
      candidate_wallets: rows.rowCount ?? 0,
      on_erc20_quoted_pools: erc20.length,
      on_native_only_pools: nativeOnly.length,
      taking: sample.length, offset, window: w.label, blocks: `${lo}..${hi}`,
    });
    // The whole sample, printed. A comparison between two rules is only
    // "directly comparable" if the inputs can be checked against each other,
    // and first-and-last is not a check.
    log.info('sample transactions', {
      transactions: sample.map((r) => `${r.tx_hash} ${r.wallet}`),
    });
    if (args.includes('--list')) {
      log.info('--list given; stopping before any RPC call', { cu_spent: 0 });
      c.release();
      await app.pool.end();
      process.exit(0);
    }

    const prover = new ReceiptPayments(rpc, cfg.token, new Set(cps));
    const noTrace = args.includes('--no-trace');
    let neededReceipt = 0;
    let nativeOnly = 0;
    let traces = 0;
    let directCount = 0;
    const cells = { ap: 0, an: 0, rp: 0, rn: 0 };
    const disagreements: unknown[] = [];
    const undecidable: unknown[] = [];
    const unreadable: unknown[] = [];
    const examples: unknown[] = [];

    for (const r of sample) {
      let verdict;
      try {
        verdict = await prover.prove(r.tx_hash, r.wallet);
      } catch (err) {
        // A read that failed is NOT a wallet that did not pay. It is counted
        // and reported on its own line, never folded into a reject.
        unreadable.push({ tx: r.tx_hash, wallet: r.wallet, why: String(err) });
        continue;
      }
      let gave: string[] = [];
      let truth = verdict.paid;
      if (!noTrace) {
        const trace = (await rpc.raw('debug_traceTransaction', [
          r.tx_hash, { tracer: 'callTracer', tracerConfig: { onlyTopCall: false } },
        ])) as TraceCall | null;
        traces += 1;
        if (!trace) throw new Error(`no trace for ${r.tx_hash}; refusing to guess a verdict`);
        gave = traceGaveUp(trace, r.wallet.toLowerCase(), cfg.token.toLowerCase());
        truth = gave.length > 0;
      }

      if (verdict.paid && truth) cells.ap += 1;
      else if (verdict.paid && !truth) cells.an += 1;
      else if (!verdict.paid && truth) cells.rp += 1;
      else cells.rn += 1;

      if (verdict.neededReceipt) neededReceipt += 1; else nativeOnly += 1;
      if (verdict.walletPaidPoolDirectly) directCount += 1;
      if (verdict.paid && !verdict.reachedAPool) {
        undecidable.push({
          tx: r.tx_hash, wallet: r.wallet,
          why: 'the wallet gave up value, but NO pricing asset reached a pool '
             + 'counterparty anywhere in this transaction -- payment is proven, '
             + 'its purpose is not',
          receipt_shows: verdict.how, trace_shows: gave.join(' + ') || 'nothing',
        });
      }

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
      decided: cells.ap + cells.an + cells.rp + cells.rn,
      unreadable_not_scored: unreadable.length,
      accepts_and_the_wallet_paid: cells.ap,
      accepts_but_the_wallet_did_NOT_pay: cells.an,
      rejects_but_the_wallet_DID_pay: cells.rp,
      rejects_and_the_wallet_did_not_pay: cells.rn,
      old_log_based_rule_scored: '1 / 0 / 39 / 0',
    });
    log.info('disagreements between the receipt and the trace', {
      count: disagreements.length, disagreements,
    });
    log.info('accepted, but the purpose of the payment is unproven', {
      count: undecidable.length, cases: undecidable,
    });
    log.info('unreadable transactions (raised, never counted as unpaid)', {
      count: unreadable.length, cases: unreadable,
    });
    log.info('what the OLD rule would have asked, on this same sample', {
      wallet_itself_sent_a_pricing_asset_to_a_pool: directCount,
      note: 'the old rule accepted only these; the rest it rejected',
    });
    log.info('examples where they agree', { examples });

    // 2.7 -- the full-cohort projection, from measured figures only.
    const proj = await c.query<{ txs: string }>(
      `select count(distinct t.tx_hash)::text txs
         from token_transfer_logs t
        where t.chain=$1 and t.token=$2 and t.from_addr = any($3::text[])`,
      [cfg.chain, cfg.token, cps],
    );
    const txs = Number(proj.rows[0]!.txs);
    const perTx = 15 + 15; // eth_getTransactionReceipt + eth_getTransactionByHash
    log.info('projected cost of the rule across the full cohort', {
      note: 'ONE receipt serves every wallet in a transaction, so the unit is the '
          + 'transaction, not the candidate. Traces are this test only; the rule '
          + 'itself never fetches one.',
      distinct_transactions_in_which_a_pool_sent_the_token: txs,
      cu_per_transaction: perTx,
      projected_cu: txs * perTx,
      projected_dollars: ((txs * perTx * 0.45) / 1e6).toFixed(2),
    });
    log.info('which half of the rule answered it', {
      answered_by_the_transaction_alone_15_cu: nativeOnly,
      needed_a_receipt_as_well_30_cu: neededReceipt,
      distinct_wallets_in_this_sample: new Set(sample.map((r) => r.wallet)).size,
      wallets_proven_to_have_paid: prover.provenWallets.size,
      mean_cu_per_candidate: (
        (nativeOnly * 15 + neededReceipt * 30) / Math.max(1, nativeOnly + neededReceipt)
      ).toFixed(1),
    });
    log.info('cost actually consumed', {
      transactions_fetched: prover.transactionsFetched,
      receipts_fetched: prover.receiptsFetched, traces_fetched: traces,
      rule_only_cu: prover.cuSpent,
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

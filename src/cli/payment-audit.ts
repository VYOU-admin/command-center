/*
 * SUPERSEDED -- DO NOT RUN AGAINST A NEW TOKEN.
 *
 * This tool belongs to the log-based payment rule, which asked whether a wallet
 * sent a pricing asset directly to a pool. Measured against 40 decoded
 * transactions that rule rejected 39 real buyers, 36 of whom paid in native
 * ETH, which moves with no Transfer log. Payment is now proven from the
 * transaction receipt in `src/intake/payment.ts`, which is the one
 * implementation the intake and the hourly job both use.
 *
 * It is kept only to read the 813,458 rows already in `token_payment_logs`.
 * See docs/ROBINHOOD.md step 7.
 */
/**
 * `npm run payment-audit -- <config.yaml> [--window N]`
 *
 * Answers one question with evidence: does the "gave up value" rule throw out
 * real buyers? READ ONLY.
 *
 * For every wallet currently tagged in the window, it finds the transactions in
 * which that wallet received the token from a pool inside a swap, then asks
 * whether a payment by that wallet exists in the same transaction. A wallet with
 * no such payment is classified by WHY, because the reasons are not equivalent:
 *
 *   paid                     the rule accepts it
 *   paid by another address  someone paid in that transaction, but not this
 *                            wallet -- the custodial pattern
 *   native-ETH pool only     the pool is quoted in native ETH, which moves with
 *                            no Transfer log, so payment CANNOT be proven from
 *                            logs. The rule rejects it and may be wrong.
 *   no payment at all        no payment by anyone in that transaction
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { loadIntakeConfig } from '../intake/plan.js';

const ZERO = '0x0000000000000000000000000000000000000000';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const configPath = args.find((a) => !a.startsWith('--'));
  if (!configPath) throw new Error('usage: payment-audit <config.yaml> [--window N]');
  const wIdx = args.indexOf('--window');
  const windowIndex = wIdx >= 0 ? Number.parseInt(args[wIdx + 1] ?? '0', 10) : 0;

  const cfg = await loadIntakeConfig(configPath);
  const app = await bootstrap();
  const c = await app.pool.connect();
  try {
    const w = cfg.windows[windowIndex];
    if (!w) throw new Error(`no window at index ${windowIndex}`);
    const b = await c.query<{ lo: number; hi: number }>(
      `select min(block_number) lo, max(block_number) hi from block_times
        where chain=$1 and block_time between $2::timestamptz and $3::timestamptz`,
      [cfg.chain, w.start, w.end],
    );
    const lo = Number(b.rows[0]?.lo);
    const hi = Number(b.rows[0]?.hi);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      throw new Error('no stored block_times cover this window');
    }

    const cov = await c.query<{ n: string; lo: string; hi: string }>(
      `select count(*)::text n, min(block_number)::text lo, max(block_number)::text hi
         from token_payment_logs where chain=$1 and token=$2`,
      [cfg.chain, cfg.token],
    );
    log.info('payment coverage', {
      window: w.label, window_blocks: `${lo}..${hi}`,
      payment_rows: cov.rows[0]!.n,
      payment_blocks: `${cov.rows[0]!.lo}..${cov.rows[0]!.hi}`,
      complete: Number(cov.rows[0]!.hi) >= hi,
    });
    if (Number(cov.rows[0]!.hi) < hi) {
      throw new Error(
        `the payment sweep only reaches block ${cov.rows[0]!.hi} and the window ends at ` +
          `${hi}. Auditing against a partial sweep would report real buyers as unpaid.`,
      );
    }

    await c.query(`create temp table cps (addr text primary key)`);
    await c.query(
      `insert into cps select pool from pool_meta
        where chain=$1 and token=$2 and venue='v3' on conflict do nothing`,
      [cfg.chain, cfg.token]);
    await c.query(`insert into cps values ($1) on conflict do nothing`,
      [cfg.v4PoolManager.toLowerCase()]);

    await c.query(
      `create temp table cand as
       with swaps as (
         select s.tx_hash,
                bool_or(m.counter = $3) as any_native,
                bool_or(m.counter <> $3) as any_erc20
           from token_swap_logs s
           join pool_meta m on m.chain=$1 and m.token=$2
                           and m.venue=s.venue and m.pool=s.pool
          where s.chain=$1 and s.token=$2 and s.block_number between $4 and $5
          group by s.tx_hash
       )
       select t.to_addr as wallet, t.tx_hash, sw.any_native, sw.any_erc20
         from token_transfer_logs t
         join swaps sw on sw.tx_hash = t.tx_hash
        where t.chain=$1 and t.token=$2 and t.block_number between $4 and $5
          and t.from_addr in (select addr from cps)
          and t.to_addr not in (select addr from cps)`,
      [cfg.chain, cfg.token, ZERO, lo, hi]);
    await c.query(`create index on cand (wallet)`);
    await c.query(`create index on cand (tx_hash)`);
    await c.query(`analyze cand`);

    await c.query(
      `create temp table cls as
       select d.wallet, d.tx_hash, d.any_native, d.any_erc20,
              exists (select 1 from token_payment_logs p
                       where p.chain=$1 and p.token=$2
                         and p.tx_hash=d.tx_hash and p.payer=d.wallet) as paid_self,
              exists (select 1 from token_payment_logs p
                       where p.chain=$1 and p.token=$2
                         and p.tx_hash=d.tx_hash) as paid_any
         from cand d`,
      [cfg.chain, cfg.token]);
    await c.query(`create index on cls (wallet)`);
    await c.query(`analyze cls`);

    const verdicts = await c.query<{
      verdict: string; wallets: string; tagged: string;
    }>(
      `with per_wallet as (
         select wallet,
                bool_or(paid_self) as ever_paid,
                bool_or(paid_any and not paid_self) as ever_other_paid,
                bool_or(any_native and not paid_any) as ever_native_only,
                count(*) as txs
           from cls group by wallet
       )
       select case
                when p.ever_paid then 'ACCEPTED: the wallet paid'
                when p.ever_other_paid then 'REJECTED: another address paid'
                when p.ever_native_only then 'REJECTED: native-ETH pool, payment unprovable from logs'
                else 'REJECTED: no payment by anyone in the transaction'
              end as verdict,
              count(*)::text as wallets,
              count(g.wallet)::text as tagged
         from per_wallet p
         left join wallet_tags g
           on g.wallet = p.wallet and g.mint = $1 and g.tag = $2
        group by 1 order by count(*) desc`,
      [cfg.token, w.label]);
    log.info('verdict by wallet', { rows: verdicts.rows });

    const tagged = await c.query<{ n: string }>(
      `select count(*)::text n from wallet_tags where mint=$1 and tag=$2`,
      [cfg.token, w.label]);
    const kept = await c.query<{ n: string }>(
      `select count(*)::text n from wallet_tags g
        where g.mint=$1 and g.tag=$2
          and exists (select 1 from cls where cls.wallet=g.wallet and cls.paid_self)`,
      [cfg.token, w.label]);
    log.info('effect on the tagged cohort', {
      tagged_today: tagged.rows[0]!.n,
      would_survive_the_payment_rule: kept.rows[0]!.n,
      would_be_rejected: String(Number(tagged.rows[0]!.n) - Number(kept.rows[0]!.n)),
    });
  } finally {
    c.release();
  }
  await app.pool.end();
  process.exit(0);
}

main().catch((err) => { log.error('payment-audit failed', errorFields(err)); process.exit(1); });

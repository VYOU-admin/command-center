/**
 * `npm run eth-usd-repair -- <config.yaml> --from N --to M [--min-disagreement F] [--commit]`
 *
 * Overwrites stored ETH/USD buckets that are KNOWN WRONG with the market-derived
 * value. docs/ROBINHOOD.md step 10, "the one exception".
 *
 * "Never rewrite a stored bucket" is the older rule and it still governs
 * everything else. The exception needs BOTH halves and neither is an opinion:
 * the stored value disagrees materially with an independent derivation ON THE SAME
 * BUCKET, and the replacement comes from the market that IS the quantity, from
 * thousands of ticks against the stored value's handful, corroborated by
 * transactions decoded by hand.
 *
 * A TIGHTER NUMBER IS NOT GROUNDS ON ITS OWN, which is why there is a threshold
 * and why it is 10% rather than 0. USD error up to about 5% changes no decision
 * here, so rewriting a 3% difference would spend reviewed history to gain nothing.
 *
 * EVERY OVERWRITE IS RECORDED, NOT REPLACED. `native_usd_prices_history` keeps the
 * old value, its tick count, its source and the reason. Overwriting reviewed
 * history without a trail would be worse than the error it fixes.
 *
 * DRY RUN BY DEFAULT. Reports the buckets, both values, and the rows priced from
 * them per token -- including the tokens where that count is ZERO, because a token
 * on a different bucket grid is unreachable by this repair and that is a finding
 * rather than an omission.
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { loadIntakeConfig } from '../intake/plan.js';

export const REPAIR_SCHEMA = `
create table if not exists native_usd_prices_history (
  id            bigserial   primary key,
  chain         text        not null,
  block_number  bigint      not null,
  old_eth_usd   numeric     not null,
  old_usd_ticks integer,
  old_eth_ticks integer,
  old_source    text,
  new_eth_usd   numeric     not null,
  new_ticks     integer     not null,
  disagreement  numeric     not null,
  reason        text        not null,
  replaced_at   timestamptz not null default now()
);

create index if not exists native_usd_prices_history_block_idx
  on native_usd_prices_history (chain, block_number);
`;

/**
 * The market value for every bucket the stored market swaps cover, on the grid
 * given. Fenced median of |usd| / |native|, the same derivation step 10 uses --
 * expressed in SQL here so the comparison and the write see one set of numbers.
 */
const MARKET_SQL = (origin: number, size: number, fence: number): string => `
 with t as (
   select (${origin} + floor((s.block_number-${origin})/${size}.0)*${size})::bigint bkt,
     abs(case when p.native_side=0 then s.amount1 else s.amount0 end)/1e6
     / nullif(abs(case when p.native_side=0 then s.amount0 else s.amount1 end)/1e18,0) tick
   from eth_usd_market_swaps s
   join eth_usd_pools p on p.chain=s.chain and p.venue=s.venue and p.pool=s.pool
   where s.chain=$1
 ), m1 as (
   select bkt, percentile_cont(0.5) within group (order by tick) med
     from t where tick>0 group by bkt
 ), fenced as (
   select t.bkt, t.tick from t join m1 on m1.bkt=t.bkt
    where t.tick between m1.med/${fence} and m1.med*${fence}
 )
 select bkt, percentile_cont(0.5) within group (order by tick)::numeric mkt_px,
        count(*)::int mkt_ticks
   from fenced group by bkt`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const configPath = args.find((a) => !a.startsWith('--'));
  if (!configPath) throw new Error('usage: eth-usd-repair <config.yaml> --from N --to M');
  const num = (f: string, d: number): number => {
    const i = args.indexOf(f);
    return i >= 0 ? Number(args[i + 1] ?? d) : d;
  };
  const from = num('--from', 0);
  const to = num('--to', 0);
  const minDis = num('--min-disagreement', 0.10);
  const commit = args.includes('--commit');
  if (!from || !to || to <= from) throw new Error('--from and --to are required');
  if (!(minDis > 0 && minDis < 1)) {
    throw new Error(`--min-disagreement must be a fraction in (0,1); got ${minDis}`);
  }

  const cfg = await loadIntakeConfig(configPath);
  const app = await bootstrap();
  const c = await app.pool.connect();
  try {
    await c.query(REPAIR_SCHEMA);
    const mkt = MARKET_SQL(cfg.bucketOrigin, cfg.bucketBlocks, cfg.nativeFenceMultiple);

    /*
     * The candidate set, materialised once. The report and the write both read
     * this table, so they cannot describe different sets -- the two-derivations
     * fault step 9 records, in a job whose whole purpose is replacing values.
     */
    await c.query(`create temp table _fix as
      with mkt as (${mkt})
      select n.block_number, n.eth_usd as old_px, n.usd_ticks as old_usd_ticks,
             n.eth_ticks as old_eth_ticks, n.source as old_source,
             m.mkt_px as new_px, m.mkt_ticks as new_ticks,
             abs(m.mkt_px - n.eth_usd) / n.eth_usd as disagreement
        from mkt m
        join native_usd_prices n
          on n.chain = $1 and n.block_number = m.bkt
       where n.block_number between $2 and $3
         and n.source is distinct from 'eth-usd-market'
         and abs(m.mkt_px - n.eth_usd) / n.eth_usd > $4::numeric`,
      [cfg.chain, from, to, minDis]);
    await c.query('create index on _fix (block_number)');
    await c.query('analyze _fix');

    const spread = await c.query<{
      n: string; mn: string | null; md: string | null; mx: string | null;
    }>(`select count(*)::text n,
          round((min(disagreement)*100)::numeric,2)::text mn,
          round(((percentile_cont(0.5) within group (order by disagreement))*100)::numeric,2)::text md,
          round((max(disagreement)*100)::numeric,2)::text mx from _fix`);

    const rows = await c.query<{
      ticker: string; rows: string; trades: string; priced: string; usd: string | null;
    }>(`select k.ticker, count(*)::text rows,
              count(*) filter (where w.side in ('buy','sell'))::text trades,
              count(*) filter (where w.side in ('buy','sell') and w.usd_amount is not null)::text priced,
              round(sum(w.usd_amount) filter (where w.side in ('buy','sell')),2)::text usd
         from wallet_transactions w
         join tokens k on k.mint = w.token
        where w.chain = $1
          and exists (select 1 from _fix f where f.block_number =
              (${cfg.bucketOrigin} + floor((w.block_number-${cfg.bucketOrigin})/${cfg.bucketBlocks}.0)*${cfg.bucketBlocks})::bigint)
        group by 1 order by 1`, [cfg.chain]);

    /*
     * EVERY TRACKED TOKEN IS LISTED, INCLUDING THE ZEROS. A token on a different
     * bucket grid reads none of these buckets, so this repair cannot reach it --
     * which is a finding about the fragmentation, not an absence of rows to show.
     */
    const allTokens = await c.query<{ ticker: string; mint: string }>(
      `select ticker, mint from tokens where chain = $1 and role = 'tracked' order by ticker`,
      [cfg.chain],
    );
    const affected = new Map(rows.rows.map((r) => [r.ticker, r]));
    const perToken = allTokens.rows.map((t) => {
      const a = affected.get(t.ticker);
      return {
        ticker: t.ticker,
        rows_in_repaired_buckets: a ? Number(a.rows) : 0,
        trades: a ? Number(a.trades) : 0,
        priced_trades: a ? Number(a.priced) : 0,
        usd_before: a?.usd ?? null,
        reachable: a ? 'yes' : 'NO -- reads a different bucket grid',
      };
    });

    log.info(commit ? 'REPAIRING' : 'DRY RUN', {
      grid: { bucket_origin: cfg.bucketOrigin, bucket_blocks: cfg.bucketBlocks,
        residue: cfg.bucketOrigin % cfg.bucketBlocks },
      range: `${from}..${to}`,
      min_disagreement: minDis,
      buckets_to_overwrite: Number(spread.rows[0]!.n),
      disagreement_min_pct: spread.rows[0]!.mn,
      disagreement_median_pct: spread.rows[0]!.md,
      disagreement_max_pct: spread.rows[0]!.mx,
      rows_per_token: perToken,
    });

    const detail = await c.query<{
      block_number: string; old_px: string; old_usd_ticks: number | null;
      new_px: string; new_ticks: number; pct: string;
    }>(`select block_number::text, round(old_px,2)::text old_px, old_usd_ticks,
               round(new_px,2)::text new_px, new_ticks,
               round((disagreement*100)::numeric,1)::text pct
          from _fix order by disagreement desc`);
    log.info('buckets', { buckets: detail.rows });

    if (Number(spread.rows[0]!.n) === 0) {
      log.warn('NO BUCKET MEETS THE THRESHOLD -- nothing to repair', {
        note: 'that is a result, not a failure: either the series agrees or the '
          + 'market does not cover these buckets',
      });
    } else if (!commit) {
      log.info('nothing written; pass --commit', {});
    } else {
      await c.query('begin');
      try {
        const hist = await c.query(
          `insert into native_usd_prices_history
             (chain, block_number, old_eth_usd, old_usd_ticks, old_eth_ticks,
              old_source, new_eth_usd, new_ticks, disagreement, reason)
           select $1, block_number, old_px, old_usd_ticks, old_eth_ticks, old_source,
                  new_px, new_ticks, disagreement,
                  'known wrong vs the ETH/USD market; step 10 exception'
             from _fix`,
          [cfg.chain],
        );
        const upd = await c.query(
          `update native_usd_prices n
              set eth_usd = f.new_px, usd_ticks = f.new_ticks,
                  eth_ticks = f.new_ticks, source = 'eth-usd-market-repair'
             from _fix f
            where n.chain = $1 and n.block_number = f.block_number`,
          [cfg.chain],
        );
        /*
         * VERIFY INSIDE THE TRANSACTION: the history rows and the updates must
         * match the candidate set exactly. A mismatch rolls back rather than
         * leaving history and prices describing different things.
         */
        const n = Number(spread.rows[0]!.n);
        if ((hist.rowCount ?? 0) !== n || (upd.rowCount ?? 0) !== n) {
          throw new Error(
            `expected ${n} history rows and ${n} updates; got ${hist.rowCount} and `
            + `${upd.rowCount}. Rolling back.`,
          );
        }
        await c.query('commit');
        log.info('repaired', {
          buckets_overwritten: upd.rowCount, history_rows_written: hist.rowCount,
          note: 'old values are preserved in native_usd_prices_history and the '
            + 'change is reversible',
        });
      } catch (err) {
        await c.query('rollback');
        throw err;
      }
    }
    await c.query('drop table _fix');
  } finally {
    c.release();
  }
  await app.pool.end();
  process.exit(0);
}

main().catch((err) => { log.error('eth-usd-repair failed', errorFields(err)); process.exit(1); });

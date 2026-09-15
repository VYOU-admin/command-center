/**
 * `npm run token-age -- <config.yaml> [--commit] [--hours N] [--window-minutes N]`
 *
 * Two jobs in one, because they are the same measurement:
 *
 *  1. THE BACKFILL. Resolve the age of every token the watchlist has bought, so the
 *     launch alert starts with a warm cache instead of paying for a cold one on its
 *     first runs.
 *  2. THE MEASUREMENT step 17 asks for: over the activity already stored, how many
 *     distinct tokens were BOUGHT WITHIN THE WINDOW OF THEIR OWN DEPLOYMENT, with the
 *     wallets and the dollars. That is the figure that says whether the alert will
 *     ever fire, and IF IT IS ZERO IT IS REPORTED AS ZERO.
 *
 * THE ANCHOR IS THE TOKEN'S FIRST BUY, NOT THE HEAD, and that is what makes the
 * measurement cost the same as the live check. The live alert asks "did this deploy
 * in the hour before NOW"; the measurement asks "did this deploy in the hour before
 * IT WAS BOUGHT". Both are one `eth_getCode` at the window's first block:
 *
 *     code present at (firstBuy - window)  ->  it already existed an hour before the
 *                                              earliest buy, so NO buy can qualify
 *     code absent there                    ->  it deployed inside that hour; bisect
 *                                              for the block and count the buys
 *
 * AND EVERY ANSWER IT PRODUCES WARMS THE LIVE ALERT'S CACHE FOR FREE -- in the
 * negative direction it produces a STRONGER one, because a token proven to exist at
 * some block months ago is proven to exist at every window start that follows.
 * `existed_at_block` only ever moves down.
 *
 * DRY RUN BY DEFAULT, per step 9: it reports the work set, the derivation behind it
 * and the estimate, and writes only with `--commit`, so the figure the operator
 * approves is the figure the job acts on.
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { loadIntakeConfig } from '../intake/plan.js';
import { RpcClient } from '../adapters/token-updates/rpc.js';
import {
  AGE_SCHEMA, BLOCKS_PER_HOUR, CODE_CU, ageWorkSet, loadAges, resolveAges,
  windowBlocks, type AgeAnchor,
} from '../intake/token-age.js';

/** Provider's published rate, for reporting a dollar figure beside the CU. */
const USD_PER_MCU = 0.45;
/** ceil(log2(35,622)) eth_getCode plus one eth_getBlockByNumber, plus the hi check. */
const CU_PER_BISECT = 17 * CODE_CU + 20;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const configPath = args.find((a) => !a.startsWith('--'));
  if (!configPath) throw new Error('usage: token-age <config.yaml> [--commit]');
  const num = (f: string, d: number): number => {
    const i = args.indexOf(f);
    return i >= 0 ? Number(args[i + 1] ?? d) : d;
  };
  const commit = args.includes('--commit');
  const hours = num('--hours', 24);
  const minutes = num('--window-minutes', 60);
  const limit = num('--limit', 0) || null;
  const bisectCap = num('--bisect-cap', 250);

  const win = windowBlocks(minutes);
  const cfg = await loadIntakeConfig(configPath);
  const app = await bootstrap();
  const client = await app.pool.connect();
  try {
    await client.query(AGE_SCHEMA);

    /*
     * THE WORK SET IS DERIVED FROM THE ROWS THE ANSWER WILL BE COMPUTED OVER, not
     * from the superset that contains them: distinct tokens with a BUY row in the
     * lookback, each anchored at its own earliest buy.
     */
    const rows = await client.query<{
      token: string; first_buy: string; wallets: string; usd: string | null;
      buys: string; symbol: string | null; name: string | null;
    }>(
      `select lower(a.token) as token,
              min(a.block_number)::text        as first_buy,
              count(distinct a.wallet)::text   as wallets,
              sum(a.usd_amount)::text          as usd,
              count(*)::text                   as buys,
              max(c.symbol)                    as symbol,
              max(c.name)                      as name
         from watchlist_activity a
         left join token_decimals_cache c
           on c.chain = a.chain and lower(c.token) = lower(a.token)
        where a.chain = $1 and a.side = 'buy'
          and a.block_time > now() - ($2 || ' hours')::interval
        group by 1
        order by min(a.block_number)
        ${limit === null ? '' : 'limit $3'}`,
      limit === null ? [cfg.chain, String(hours)] : [cfg.chain, String(hours), limit],
    );

    /*
     * A WORK SET OF NOTHING IS A SUSPECTED DEFECT, NOT A CLEAN PASS -- the standing
     * rule that a filter matching nothing must be reported rather than passed over.
     */
    if (rows.rowCount === 0) {
      throw new Error(
        `watchlist_activity holds no BUY rows for chain "${cfg.chain}" in the last `
        + `${hours} hours. A work set of nothing is a suspected defect, not a clean `
        + 'pass: check the watcher is running before treating this as "no launches".',
      );
    }

    const anchors: AgeAnchor[] = rows.rows.map((r) => ({
      token: r.token,
      lo: Number(r.first_buy) - win,
      hi: Number(r.first_buy),
    }));
    const cached = await loadAges(client, cfg.chain, anchors.map((a) => a.token));
    const work = ageWorkSet(anchors, cached);

    /*
     * THE CEILING COMES FROM THE WORK SET, derived here and not carried in from a
     * figure quoted earlier. The bisect term is the one that cannot be known in
     * advance, so the ceiling covers the WORST case -- every token a launch -- and
     * the log says so, rather than quoting a number that assumes the happy path.
     */
    const baseCu = work.anchors.length * CODE_CU;
    const worstCu = baseCu + work.anchors.length * CU_PER_BISECT;
    const ceiling = Math.max(1000, Math.ceil(worstCu * 1.2));

    log.info('AGE WORK SET, derived BEFORE the first request', {
      chain: cfg.chain,
      lookback_hours: hours,
      launch_window_minutes: minutes,
      window_blocks: win,
      blocks_per_hour_measured: BLOCKS_PER_HOUR,
      tokens_with_buys: work.total,
      settled_by_stored_deployment_block: work.knownDeployment,
      settled_by_stored_existed_at_block: work.knownOld,
      needing_a_request: work.anchors.length,
      estimate: {
        base_cu: baseCu,
        base_usd: ((baseCu * USD_PER_MCU) / 1e6).toFixed(5),
        worst_case_cu: worstCu,
        worst_case_usd: ((worstCu * USD_PER_MCU) / 1e6).toFixed(5),
        note: 'worst case assumes EVERY token is a launch and is bisected. The real '
          + 'figure lands between base and worst and is reported after the run.',
      },
      ceiling_set: ceiling,
      bisect_cap: bisectCap,
      commit,
    });

    if (!commit) {
      log.info('DRY RUN -- nothing was read and nothing was written', {
        note: 'pass --commit to spend. The work set above is the set the job will act '
          + 'on; one derivation serves both the estimate and the fetch.',
      });
      client.release();
      await app.pool.end();
      process.exit(0);
    }

    const key = process.env[cfg.rpcKeyVar];
    if (!key) throw new Error(`${cfg.rpcKeyVar} is not set in this process`);
    const rpc = new RpcClient(
      cfg.rpcUrlTemplate.replace('{key}', key), cfg.requestTimeoutMs, ceiling,
    );

    const started = Date.now();
    const res = await resolveAges(client, rpc, cfg.chain, work.anchors, bisectCap);
    log.info('age resolved', {
      ...res,
      usd: ((res.cuSpent * USD_PER_MCU) / 1e6).toFixed(5),
      estimated_base_cu: baseCu,
      against_estimate_pct: baseCu > 0
        ? (((res.cuSpent - baseCu) / baseCu) * 100).toFixed(1) : null,
      wall_clock_s: ((Date.now() - started) / 1000).toFixed(1),
      calls: rpc.callCounts(),
    });

    /*
     * THE MEASUREMENT, READ BACK FROM THE TABLE ON THE SAME CONNECTION THE WRITES
     * WENT TO -- and re-derived from stored rows rather than from the counters above,
     * so it is a query against the database and not a restatement of what the loop
     * believed it did.
     */
    const measured = await client.query<{
      tokens: string; wallets: string; usd: string | null; buys: string;
    }>(
      `select count(distinct a.token)::text  as tokens,
              count(distinct a.wallet)::text as wallets,
              sum(a.usd_amount)::text        as usd,
              count(*)::text                 as buys
         from watchlist_activity a
         join token_decimals_cache c
           on c.chain = a.chain and lower(c.token) = lower(a.token)
        where a.chain = $1 and a.side = 'buy'
          and a.block_time > now() - ($2 || ' hours')::interval
          and c.deployment_block is not null
          and a.block_number - c.deployment_block <= $3
          and a.block_number >= c.deployment_block`,
      [cfg.chain, String(hours), win],
    );
    const detail = await client.query<{
      token: string; symbol: string | null; name: string | null;
      deployment_block: string; first_buy: string; blocks_after: string;
      minutes_after: string; wallets: string; usd: string | null; buys: string;
    }>(
      `select lower(a.token) as token, max(c.symbol) as symbol, max(c.name) as name,
              max(c.deployment_block)::text as deployment_block,
              min(a.block_number)::text     as first_buy,
              (min(a.block_number) - max(c.deployment_block))::text as blocks_after,
              round((min(a.block_number) - max(c.deployment_block))
                    / ($4::numeric / $5::numeric), 1)::text as minutes_after,
              count(distinct a.wallet)::text as wallets,
              sum(a.usd_amount)::text        as usd,
              count(*)::text                 as buys
         from watchlist_activity a
         join token_decimals_cache c
           on c.chain = a.chain and lower(c.token) = lower(a.token)
        where a.chain = $1 and a.side = 'buy'
          and a.block_time > now() - ($2 || ' hours')::interval
          and c.deployment_block is not null
          and a.block_number - c.deployment_block <= $3
          and a.block_number >= c.deployment_block
        group by 1
        order by count(distinct a.wallet) desc, sum(a.usd_amount) desc nulls last`,
      /*
       * BLOCKS-PER-MINUTE IS win/minutes, NOT win/60. They coincide only at a
       * 60-minute window, which is exactly the shape of constant that looks correct
       * until someone changes the config.
       */
      [cfg.chain, String(hours), win, win, minutes],
    );

    const m = measured.rows[0]!;
    /*
     * ZERO IS A RESULT AND IS STATED AS ONE. "No rows" here is the answer to whether
     * this alert will ever fire, and omitting the line would be indistinguishable
     * from a measurement that was never taken.
     */
    log.info('MEASURED: tokens bought within the window of their own deployment', {
      lookback_hours: hours,
      launch_window_minutes: minutes,
      window_blocks: win,
      tokens: Number(m.tokens),
      distinct_wallets: Number(m.wallets),
      buy_rows: Number(m.buys),
      usd: m.usd === null ? null : Number(m.usd).toFixed(2),
      zero: Number(m.tokens) === 0,
      note: Number(m.tokens) === 0
        ? 'ZERO. Over this lookback no token the watchlist bought had been deployed '
          + 'inside the window at the time of the buy. Reported as zero rather than '
          + 'omitted: it is the measurement that says how often this alert fires.'
        : 'each token below was deployed and bought inside the same window',
      tokens_detail: detail.rows.map((r) => ({
        token: r.token, symbol: r.symbol, name: r.name,
        deployment_block: Number(r.deployment_block),
        first_buy_block: Number(r.first_buy),
        blocks_after_deployment: Number(r.blocks_after),
        minutes_after_deployment: Number(r.minutes_after),
        wallets: Number(r.wallets),
        buys: Number(r.buys),
        usd: r.usd === null ? null : Number(r.usd).toFixed(2),
      })),
    });

    const back = await client.query<{
      total: string; with_deployment: string; with_existed: string; attempted: string;
    }>(
      `select count(*)::text as total,
              count(*) filter (where deployment_block is not null)::text as with_deployment,
              count(*) filter (where existed_at_block is not null)::text as with_existed,
              count(*) filter (where age_checked_at is not null)::text as attempted
         from token_decimals_cache where chain = $1`,
      [cfg.chain],
    );
    log.info('read back from token_decimals_cache', back.rows[0]!);
  } finally {
    client.release();
  }
  await app.pool.end();
  process.exit(0);
}

main().catch((err) => {
  log.error('token-age failed', errorFields(err));
  process.exit(1);
});

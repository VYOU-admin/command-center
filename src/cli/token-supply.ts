/**
 * `npm run token-supply -- <config.yaml> [--commit] [--ceiling N] [--ttl-days N]`
 *
 * Backfills `totalSupply()` for every token the watcher has seen.
 *
 * WHY A CLI AND NOT JUST THE MONITOR. The monitor reads supply incrementally, bounded
 * by `supply_reads_per_run`, so a newly-seen token is covered without anyone running
 * anything. The BACKFILL is a different job: 1,220 tokens at 26 CU is 31,720 CU, and
 * putting that inside a 30-minute cycle would either blow the monitor's ceiling or
 * take dozens of cycles to drain. It gets its own ceiling, set before the first
 * request, per section 4.
 *
 * DRY RUN BY DEFAULT. It reports the work set, the derivation behind it and the
 * estimate, and writes only with `--commit` -- step 9's rule that one derivation
 * serves both the estimate and the fetch, so the figure the operator approves is the
 * figure the job acts on.
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { loadIntakeConfig } from '../intake/plan.js';
import { RpcClient } from '../adapters/token-updates/rpc.js';
import {
  SUPPLY_SCHEMA, SUPPLY_TTL_DAYS, readSupplies, supplyWorkSet,
} from '../intake/supply.js';

/** Provider's published table. One `eth_call` per token. */
const CU_PER_CALL = 26;
/** Provider's published rate, for reporting a dollar figure beside the CU. */
const USD_PER_MCU = 0.45;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const configPath = args.find((a) => !a.startsWith('--'));
  if (!configPath) throw new Error('usage: token-supply <config.yaml> [--commit]');
  const num = (f: string, d: number): number => {
    const i = args.indexOf(f);
    return i >= 0 ? Number(args[i + 1] ?? d) : d;
  };
  const commit = args.includes('--commit');
  const ttlDays = num('--ttl-days', SUPPLY_TTL_DAYS);
  const limit = num('--limit', 0) || null;

  const cfg = await loadIntakeConfig(configPath);
  const app = await bootstrap();
  const client = await app.pool.connect();
  try {
    await client.query(SUPPLY_SCHEMA);

    const work = await supplyWorkSet(client, cfg.chain, ttlDays, limit);

    /*
     * A WORK SET OF NOTHING IS A SUSPECTED DEFECT, NOT A CLEAN PASS. Either the
     * watcher has stored no activity or every token is already fresh; both are
     * legitimate, and both are indistinguishable from a query that matched nothing
     * unless it is said out loud. It raises when there is no activity at all and
     * reports-and-exits when everything is simply fresh.
     */
    if (work.total === 0) {
      throw new Error(
        `watchlist_activity holds no tokens for chain "${cfg.chain}". A work set `
        + 'matching nothing is a suspected defect, not an empty result.',
      );
    }

    /*
     * THE CEILING IS SET FROM THE WORK SET, not from a round number, and it is set
     * BEFORE the first request. An account-level cap protects the wallet; only an
     * in-job ceiling protects against a job whose scope was wrong from its first
     * call. 20% of headroom covers nothing here -- the cost is exactly one call per
     * token -- so it is a tight bound by design.
     */
    const estimateCu = work.tokens.length * CU_PER_CALL;
    const ceiling = num('--ceiling', Math.max(1000, Math.ceil(estimateCu * 1.2)));

    log.info('BEFORE THE FIRST REQUEST', {
      chain: cfg.chain,
      tokens_seen_by_the_watcher: work.total,
      work_set: work.tokens.length,
      never_read: work.neverRead,
      stale_past_ttl: work.stale,
      already_fresh: work.fresh,
      ttl_days: ttlDays,
      estimated_cu: estimateCu,
      estimated_usd: ((estimateCu * USD_PER_MCU) / 1e6).toFixed(4),
      ceiling,
      commit,
      derivation: 'tokens in watchlist_activity with supply_read_at null or older '
        + 'than the TTL -- the same query the fetch iterates, so the estimate and '
        + 'the fetch cannot disagree',
    });

    if (work.tokens.length === 0) {
      log.info('NOTHING TO READ', {
        reason: `all ${work.total} tokens were read inside the last ${ttlDays} days`,
        note: 'this is a result, not a failure: the cache is fresh',
      });
      return;
    }
    if (!commit) {
      log.info('DRY RUN. Nothing was read and nothing was written; pass --commit', {});
      return;
    }

    const key = app.env.configVars.get(cfg.rpcKeyVar);
    if (!key) throw new Error(`${cfg.rpcKeyVar} is not set in this process`);
    const rpc = new RpcClient(cfg.rpcUrlTemplate.replace('{key}', key),
      cfg.requestTimeoutMs, ceiling);

    const res = await readSupplies(client, rpc, cfg.chain, work.tokens);

    log.info('SUPPLY READ', {
      ...res,
      estimated_cu: estimateCu,
      against_estimate: `${((res.cuSpent / estimateCu - 1) * 100).toFixed(1)}%`,
      dollars: ((res.cuSpent * USD_PER_MCU) / 1e6).toFixed(4),
      ceiling,
      note: 'unresolved = the contract was asked and did not give a uint256. It is '
        + 'stored as NULL with supply_read_at set, never as zero: a zero supply '
        + 'would compute a $0 market cap and clear every ceiling.',
    });

    /* VERIFIED FROM THE TABLE, not from the loop having finished. */
    const after = await client.query<{ total: string; with_supply: string;
      attempted_no_supply: string; never: string; }>(
      `with seen as (select distinct lower(token) t from watchlist_activity
                      where chain = $1)
       select count(*)::text total,
              count(*) filter (where c.total_supply is not null)::text with_supply,
              count(*) filter (where c.supply_read_at is not null
                                 and c.total_supply is null)::text attempted_no_supply,
              count(*) filter (where c.supply_read_at is null)::text never
         from seen s
         left join token_decimals_cache c on c.chain = $1 and lower(c.token) = s.t`,
      [cfg.chain],
    );
    log.info('stored, read back', after.rows[0]!);
  } finally {
    client.release();
  }
  await app.pool.end();
  process.exit(0);
}

main().catch((err) => {
  log.error('token-supply failed', errorFields(err));
  process.exit(1);
});

/**
 * `npm run load-swaps -- <config.yaml> --from N --to M [--commit] [--ceiling C]`
 *
 * Fills `token_swap_logs` for a token, from the two places its swaps live:
 *
 *   v4  copied from `v4_swaps_all`, which already holds every v4 swap on the
 *       chain for the blocks it covers. Pure SQL -- NO RPC, NO COST.
 *   v3  swept from the in-scope v3 pools, which nothing else has collected.
 *
 * WHY THIS MATTERS BEYOND ROWS. The router rule's discriminator is the share of
 * an address's sends that sit inside a transaction containing a `Swap`. With
 * this table empty the share is 0.0% for everyone and every candidate is
 * labelled a distributor -- which is what AI reported for all 16 of its
 * candidates, one of them fronting 9,765 recipients. See docs/ROBINHOOD.md
 * step 7.
 *
 * DRY RUN BY DEFAULT. `--commit` writes; without it the counts are reported and
 * nothing is inserted.
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { loadIntakeConfig } from '../intake/plan.js';
import { RpcClient } from '../adapters/token-updates/rpc.js';
import { adaptiveSweep, checkCoverage, recordSweepRange } from '../intake/sweep.js';
import { TOPICS, decodeSwap } from '../adapters/token-updates/decode.js';
import { loadPools } from '../adapters/token-updates/pools.js';
import { withTransaction } from '../store/db.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const configPath = args.find((a) => !a.startsWith('--'));
  if (!configPath) throw new Error('usage: load-swaps <config.yaml> --from N --to M');
  const num = (f: string, d: number): number => {
    const i = args.indexOf(f);
    return i >= 0 ? Number.parseInt(args[i + 1] ?? String(d), 10) : d;
  };
  const from = num('--from', 0);
  const to = num('--to', 0);
  const ceiling = num('--ceiling', 25000);
  const commit = args.includes('--commit');
  /*
   * A BRIDGE NEEDS ONLY ITS PRICEABLE POOLS. The default copies every pool of
   * the token because router detection asks whether a send sat inside a
   * transaction containing any swap of it. A bridge asset has no cohort and no
   * router detection -- only a price series -- and copying every pool of a token
   * that prices half the chain would pull in millions of rows nothing reads.
   */
  const inScopeOnly = args.includes('--in-scope-only');
  if (!from || !to || to <= from) throw new Error('--from and --to are required');

  const cfg = await loadIntakeConfig(configPath);
  const app = await bootstrap();
  const key = app.env.configVars.get(cfg.rpcKeyVar);
  if (!key) throw new Error(`${cfg.rpcKeyVar} is not set in this process`);
  const rpc = new RpcClient(cfg.rpcUrlTemplate.replace('{key}', key),
    cfg.requestTimeoutMs, ceiling);

  const c = await app.pool.connect();
  try {
    /*
     * EVERY v4 pool of this token, in scope or not. Router detection asks
     * whether a send sat inside a transaction containing a swap -- any swap of
     * this token, not only a priceable one. Restricting to in-scope pools here
     * would make a router that routed through an out-of-scope pool look like a
     * distributor. The row writer joins pool_meta and ignores the rest.
     */
    const v4Pools = (await c.query<{ pool: string }>(
      inScopeOnly
        ? `select pool from pool_meta where chain=$1 and token=$2 and venue='v4'`
        : `select pool from pool_meta where chain=$1 and token=$2 and venue='v4'
           union
           select pool from pool_rejected where chain=$1 and token=$2 and venue='v4'`,
      [cfg.chain, cfg.token],
    )).rows.map((r) => r.pool);

    const pools = await loadPools(c, cfg.chain, cfg.token);
    const v3Pools = [...new Set([...pools.values()]
      .filter((p) => p.venue === 'v3').map((p) => p.pool.toLowerCase()))];

    const already = await c.query<{ n: string }>(
      `select count(*)::text n from token_swap_logs where chain=$1 and token=$2`,
      [cfg.chain, cfg.token],
    );
    const wouldCopy = await c.query<{ n: string; lo: string | null; hi: string | null }>(
      `select count(*)::text n, min(block_number)::text lo, max(block_number)::text hi
         from v4_swaps_all
        where chain=$1 and block_number between $2 and $3 and pool_id = any($4::text[])`,
      [cfg.chain, from, to, v4Pools],
    );
    const v4Span = await c.query<{ lo: string; hi: string }>(
      `select min(block_number)::text lo, max(block_number)::text hi from v4_swaps_all`,
    );

    log.info('DRY RUN counts', {
      commit,
      pool_selection: inScopeOnly ? 'in-scope only' : 'every pool of the token',
      rows_already_present: Number(already.rows[0]!.n),
      v4_pools_of_this_token: v4Pools.length,
      v4_rows_to_copy: Number(wouldCopy.rows[0]!.n),
      v4_copy_block_range: `${wouldCopy.rows[0]!.lo ?? 'NONE'}..${wouldCopy.rows[0]!.hi ?? 'NONE'}`,
      v4_swaps_all_covers: `${v4Span.rows[0]!.lo}..${v4Span.rows[0]!.hi}`,
      v4_copy_cost: 'no RPC -- pure SQL',
      v3_pools_to_sweep: v3Pools.length,
      v3_sweep_estimate: `<= ${Math.ceil((to - from + 1) / cfg.maxLogSpanBlocks)} requests, `
        + `<= ${Math.ceil((to - from + 1) / cfg.maxLogSpanBlocks) * 60} CU`,
    });

    if (!commit) {
      log.info('dry run only; pass --commit to write', {});
      await app.pool.end();
      process.exit(0);
    }

    const copied = await c.query(
      `insert into token_swap_logs
         (chain, token, venue, pool, block_number, log_index, tx_hash,
          sender, recipient, amount0, amount1)
       select v.chain, $2, 'v4', v.pool_id, v.block_number, v.log_index, v.tx_hash,
              v.sender, null, v.amount0, v.amount1
         from v4_swaps_all v
        where v.chain = $1 and v.block_number between $3 and $4
          and v.pool_id = any($5::text[])
       on conflict do nothing`,
      [cfg.chain, cfg.token, from, to, v4Pools],
    );
    log.info('v4 copied', { rows_inserted: copied.rowCount ?? 0 });

    /*
     * v4 OUTSIDE v4_swaps_all MUST STILL BE SWEPT. That table covers a fixed
     * block range; a token older or newer than it has swaps outside, and
     * copying alone would leave them missing with nothing to say so. INDEX is
     * the first such token -- deployed at block 1,670,725, more than thirteen
     * million blocks before the table begins.
     */
    let v4SweptRows = 0;
    let v4Requests = 0;
    const covLo = Number(v4Span.rows[0]!.lo);
    const covHi = Number(v4Span.rows[0]!.hi);
    const gaps: [number, number][] = [];
    if (from < covLo) gaps.push([from, Math.min(to, covLo - 1)]);
    if (to > covHi) gaps.push([Math.max(from, covHi + 1), to]);
    if (gaps.length && v4Pools.length) {
      log.info('v4 ranges outside v4_swaps_all, sweeping', {
        gaps: gaps.map(([a, b]) => `${a}..${b}`),
        blocks: gaps.reduce((n, [a, b]) => n + (b - a + 1), 0),
        pools_in_topic_array: v4Pools.length,
      });
      /*
       * THE POOL-ID TOPIC ARRAY IS CHUNKED. ROBINHOOD.md step 5 records that a
       * 540-entry array is accepted; AI has 5,024 v4 pools and passing them all
       * in one filter HUNG -- 57 minutes with no range recorded and no error,
       * which is the shape the wall-clock rule exists to catch. The endpoint
       * neither refused nor answered.
       *
       * Chunking multiplies the request count by the number of chunks, so the
       * ceiling must be sized for that; it is the only way to sweep a token with
       * thousands of pools at all.
       */
      const CHUNK = 500;
      const chunks: string[][] = [];
      for (let i = 0; i < v4Pools.length; i += CHUNK) {
        chunks.push(v4Pools.slice(i, i + CHUNK));
      }
      if (chunks.length > 1) {
        log.info('pool-id topic array chunked', {
          pools: v4Pools.length, chunks: chunks.length, per_chunk: CHUNK,
          note: 'request count is multiplied by the chunk count',
        });
      }
      for (const [gFrom, gTo] of gaps) {
       for (const chunk of chunks) {
        const st = await adaptiveSweep(
          rpc, cfg,
          { address: cfg.v4PoolManager.toLowerCase(), topics: [TOPICS.swapV4, chunk] },
          gFrom, gTo,
          async (logs, rangeFrom, rangeTo) => {
            await withTransaction(app.pool, async (t) => {
              for (const l of logs) {
                const sw = decodeSwap(l, 'v4');
                const r = await t.query(
                  `insert into token_swap_logs
                     (chain, token, venue, pool, block_number, log_index, tx_hash,
                      sender, recipient, amount0, amount1)
                   values ($1,$2,'v4',$3,$4,$5,$6,null,null,$7,$8)
                   on conflict do nothing`,
                  [cfg.chain, cfg.token, sw.pool, sw.block, sw.logIndex, sw.txHash,
                    sw.amount0.toString(), sw.amount1.toString()],
                );
                v4SweptRows += r.rowCount ?? 0;
              }
              /*
               * Chunks share a block range, so they would collide on the
               * progress key. Only the LAST chunk records it: the range is not
               * fully read until every chunk has been.
               */
              if (chunk === chunks[chunks.length - 1]) {
                await recordSweepRange(t, cfg, 'swap-v4', rangeFrom, rangeTo, logs.length);
              }
            });
          },
        );
        v4Requests += st.requests;
       }
      }
      log.info('v4 gaps swept', { rows: v4SweptRows, requests: v4Requests });
    } else if (!gaps.length) {
      log.info('no v4 range outside v4_swaps_all', { covered: `${covLo}..${covHi}` });
    }

    let v3Rows = 0;
    let stats = null;
    if (v3Pools.length > 0) {
      stats = await adaptiveSweep(
        rpc, cfg, { address: v3Pools, topics: [TOPICS.swapV3] }, from, to,
        async (logs, rangeFrom, rangeTo) => {
          await withTransaction(app.pool, async (t) => {
            for (const l of logs) {
              const s = decodeSwap(l, 'v3');
              const r = await t.query(
                `insert into token_swap_logs
                   (chain, token, venue, pool, block_number, log_index, tx_hash,
                    sender, recipient, amount0, amount1)
                 values ($1,$2,'v3',$3,$4,$5,$6,null,null,$7,$8)
                 on conflict do nothing`,
                [cfg.chain, cfg.token, s.pool, s.block, s.logIndex, s.txHash,
                  s.amount0.toString(), s.amount1.toString()],
              );
              v3Rows += r.rowCount ?? 0;
            }
            await recordSweepRange(t, cfg, 'swap-v3', rangeFrom, rangeTo, logs.length);
          });
        },
      );
    } else {
      log.info('no in-scope v3 pools', { swept: 0, note: 'RETURNED NO POOLS -- nothing to sweep' });
    }

    const after = await c.query<{ venue: string; n: string; lo: string; hi: string }>(
      `select venue, count(*)::text n, min(block_number)::text lo, max(block_number)::text hi
         from token_swap_logs where chain=$1 and token=$2 group by venue order by venue`,
      [cfg.chain, cfg.token],
    );
    const cov = v3Pools.length
      ? await checkCoverage(c, cfg, 'swap-v3', from, to)
      : { expectedBlocks: 0, coveredBlocks: 0, gaps: [], overlaps: 0 };

    log.info('loaded', {
      by_venue: after.rows,
      v4_swept_rows: v4SweptRows, v4_sweep_requests: v4Requests,
      v3_rows_inserted: v3Rows,
      v3_requests: stats?.requests ?? 0,
      v3_size_refusals: stats?.sizeRefusals ?? 0,
      v3_rate_refusals: stats?.rateRefusals ?? 0,
      cu_spent: rpc.cuSpent,
      dollars: ((rpc.cuSpent * 0.45) / 1e6).toFixed(4),
    });
    log.info('v3 coverage', { ...cov });
  } finally {
    c.release();
  }
  await app.pool.end();
  process.exit(0);
}

main().catch((err) => { log.error('load-swaps failed', errorFields(err)); process.exit(1); });

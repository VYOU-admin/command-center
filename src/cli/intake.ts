/**
 * The token intake runner: `npm run intake -- <config.yaml> [--continue]`
 *
 * docs/ROBINHOOD-TOKEN-INTAKE.md as code. The PONS intake was carried out by
 * scripts in a scratchpad directory; the container recycled and every one of
 * them was lost. This lives in the repository.
 *
 * IT STOPS WHERE THE DOCUMENT STOPS. Five phases end by reporting and exiting:
 * pools, scope, cohort, prices, and the write's dry run. Each is a point where
 * a wrong answer is cheap to correct and expensive to carry forward. `--continue`
 * clears exactly one STOP -- the one the last invocation ended on -- so passing
 * it cannot accidentally run the whole procedure unattended.
 *
 * EVERY PHASE HAS ITS OWN COMPUTE-UNIT CEILING, set before the phase starts and
 * reported when it is reached. Phase state lives in Postgres, so a container
 * replacement costs only the phase in flight.
 */

import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { withTransaction } from '../store/db.js';
import type { PoolClient } from '../store/db.js';
import {
  PHASES,
  STATE_SCHEMA,
  STOP_AFTER,
  loadIntakeConfig,
  readPhase,
  writePhase,
  type IntakeConfig,
  type Phase,
} from '../intake/plan.js';
import { SCHEMA as TOKEN_UPDATE_SCHEMA } from '../adapters/token-updates/schema.js';
import { RpcClient } from '../adapters/token-updates/rpc.js';
import { TOPICS, decodeSwap, decodeTransfer } from '../adapters/token-updates/decode.js';
import { loadPools, persistPools, poolKey, type PoolRow } from '../adapters/token-updates/pools.js';
import { loadExclusions } from '../adapters/token-updates/exclusions.js';
import {
  discoverPools,
  readIdentity,
  resolveWindows,
  scopePools,
} from '../intake/discover.js';
import {
  adaptiveSweep,
  checkCoverage,
  recordSweepRange,
  verifyConventions,
} from '../intake/sweep.js';
import { buildCohort, writeTags } from '../intake/cohort.js';
import {
  derivePricesForLife,
  fetchTimestamps,
  loadBridgeUsd,
  loadLegsInput,
  persistAllPrices,
  persistBridgeUsd,
  planOrWrite,
  planTimestamps,
} from '../intake/write.js';
import { deriveBridgeUsd } from '../adapters/token-updates/prices.js';
import { detectRouters, compareToList } from '../intake/routers.js';

const INFRASTRUCTURE_PATH = 'config/infrastructure.yaml';

class Stop extends Error {
  constructor(
    readonly phase: Phase,
    readonly report: Record<string, unknown>,
  ) {
    super(`STOP after phase "${phase}"`);
    this.name = 'Stop';
  }
}

function client(cfg: IntakeConfig, phase: Phase, key: string): RpcClient {
  return new RpcClient(
    cfg.rpcUrlTemplate.replace('{key}', key),
    cfg.requestTimeoutMs,
    cfg.ceilings[phase],
  );
}

/** First block at which the token contract existed, by bisecting eth_getCode. */
async function deploymentBlock(rpc: RpcClient, token: string, head: number): Promise<number> {
  let lo = 1;
  let hi = head;
  if ((await rpc.getCode(token, hi)) === '0x') {
    throw new Error(`${token} has no code at the head block; it is not a contract`);
  }
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const code = await rpc.getCode(token, mid);
    if (code === '0x') lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const configPath = args.find((a) => !a.startsWith('--'));
  const clearOneStop = args.includes('--continue');
  if (!configPath) throw new Error('usage: intake <config.yaml> [--continue]');

  const cfg = await loadIntakeConfig(configPath);
  const app = await bootstrap();
  const key = app.env.configVars.get(cfg.rpcKeyVar);
  if (!key) {
    throw new Error(
      `${cfg.rpcKeyVar} is not set in this process. The intake needs an archival ` +
        'endpoint that also populates blockTimestamp on logs.',
    );
  }

  await withTransaction(app.pool, async (c) => {
    await c.query(TOKEN_UPDATE_SCHEMA);
    await c.query(STATE_SCHEMA);
  });

  const done = new Set<Phase>();
  let stoppedOn: Phase | null = null;
  await withTransaction(app.pool, async (c) => {
    for (const phase of PHASES) {
      const rec = await readPhase(c, cfg.chain, cfg.token, phase);
      if (rec?.status === 'complete') done.add(phase);
      if (rec?.status === 'stopped') stoppedOn = phase;
    }
  });

  log.info('intake starting', {
    token: cfg.token,
    ticker: cfg.ticker,
    chain: cfg.chain,
    windows: cfg.windows.map((w) => w.label),
    phases_complete: [...done],
    stopped_on: stoppedOn,
    clearing_one_stop: clearOneStop,
  });

  if (stoppedOn && !clearOneStop) {
    log.warn('the previous run stopped for review; pass --continue to clear exactly that stop', {
      stopped_on: stoppedOn,
    });
    await app.pool.end();
    process.exit(0);
  }
  if (stoppedOn) done.add(stoppedOn);

  /* Carried between phases within one invocation. */
  let identity: Awaited<ReturnType<typeof readIdentity>> | null = null;
  let head = 0;
  let firstBlock = 0;
  let pools = new Map<string, PoolRow>();
  const exclusions = await loadExclusions(INFRASTRUCTURE_PATH, cfg.chain);
  const excludedAddresses = new Set(exclusions.map((e) => e.address));

  const run = async <T>(
    phase: Phase,
    fn: (rpc: RpcClient, c: PoolClient) => Promise<{ report: Record<string, unknown>; value?: T }>,
  ): Promise<T | undefined> => {
    if (done.has(phase)) return undefined;
    const rpc = client(cfg, phase, key);
    log.info('phase starting', { phase, cu_ceiling: cfg.ceilings[phase] });
    const started = Date.now();
    let out: { report: Record<string, unknown>; value?: T };
    try {
      out = await withTransaction(app.pool, (c) => fn(rpc, c));
    } catch (err) {
      await withTransaction(app.pool, (c) =>
        writePhase(c, cfg.chain, cfg.token, {
          phase,
          status: 'failed',
          detail: { error: err instanceof Error ? err.message : String(err) },
          cuSpent: rpc.cuSpent,
        }),
      );
      throw err;
    }
    const shouldStop = STOP_AFTER.has(phase);
    await withTransaction(app.pool, (c) =>
      writePhase(c, cfg.chain, cfg.token, {
        phase,
        status: shouldStop ? 'stopped' : 'complete',
        detail: out.report,
        cuSpent: rpc.cuSpent,
      }),
    );
    log.info('phase finished', {
      phase,
      duration_ms: Date.now() - started,
      cu_spent: rpc.cuSpent,
      calls: rpc.callCounts(),
      ...out.report,
    });
    if (shouldStop) throw new Stop(phase, out.report);
    return out.value;
  };

  try {
    /* ---- 1. identity ---------------------------------------------------- */
    const id = await run('identity', async (rpc, c) => {
      head = await rpc.blockNumber();
      const value = await readIdentity(rpc, cfg);
      firstBlock = await deploymentBlock(rpc, cfg.token, head);
      await c.query(
        `insert into tokens (mint, chain, ticker, name, decimals, charted_pair)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (mint) do update set ticker = excluded.ticker,
           name = excluded.name, decimals = excluded.decimals,
           charted_pair = coalesce(excluded.charted_pair, tokens.charted_pair)`,
        [cfg.token, cfg.chain, cfg.ticker, value.name, value.decimals, cfg.chartedPair],
      );
      return {
        report: { ...value, head, deployment_block: firstBlock },
        value: { identity: value, head, firstBlock },
      };
    });
    if (id) {
      identity = id.identity;
      head = id.head;
      firstBlock = id.firstBlock;
    }

    /* ---- 2. windows ----------------------------------------------------- */
    const win = await run('windows', async (rpc) => {
      if (!head) head = await rpc.blockNumber();
      const resolved = await resolveWindows(rpc, cfg, firstBlock || 1, head);
      return {
        report: {
          windows: resolved.map((w) => ({
            label: w.label, start: w.start, end: w.end,
            start_block: w.startBlock, end_block: w.endBlock,
            blocks: w.endBlock! - w.startBlock!,
          })),
        },
        value: resolved,
      };
    });
    const windows = win ?? cfg.windows;

    /* ---- 3. pools ------------------------------------------- STOP ------ */
    await run('pools', async (rpc, c) => {
      if (!head) head = await rpc.blockNumber();
      const sweepStream = async (
        filter: object, from: number, to: number,
        onBatch: (logs: Parameters<typeof decodeSwap>[0][]) => void,
        startSpan?: number,
      ) => {
        await adaptiveSweep(
          rpc, cfg, filter, from, to,
          async (logs) => { onBatch(logs); },
          startSpan,
        );
      };
      const found = await discoverPools(
        rpc, cfg, firstBlock || 1, head, sweepStream, head,
      );
      await c.query(
        `insert into token_intake_state (chain, token, phase, status, detail)
         values ($1, $2, 'pools:candidates', 'complete', $3::jsonb)
         on conflict (chain, token, phase) do update set detail = excluded.detail`,
        [cfg.chain, cfg.token, JSON.stringify(found.candidates)],
      );
      return {
        report: {
          candidates: found.candidates.length,
          v4_from_initialize: found.v4FromInitialize,
          v3_from_factory: found.v3FromFactory,
          v3_from_flow_probe: found.v3FromFlowProbe,
          transfers_scanned: found.transfersScanned,
          flow_addresses_tested: found.flowAddressesTested,
          flow_not_contracts: found.flowNotContracts,
          flow_reverted_not_a_pool: found.flowReverted,
          venues_with_no_pools: found.emptyVenues,
        },
      };
    });

    /* ---- 4. scope ------------------------------------------- STOP ------ */
    await run('scope', async (rpc, c) => {
      const stored = await c.query<{ detail: unknown }>(
        `select detail from token_intake_state
          where chain = $1 and token = $2 and phase = 'pools:candidates'`,
        [cfg.chain, cfg.token],
      );
      const candidates = (stored.rows[0]?.detail ?? []) as Parameters<typeof scopePools>[2];
      if (!Array.isArray(candidates) || candidates.length === 0) {
        throw new Error('no pool candidates stored; phase "pools" did not complete');
      }
      const scope = await scopePools(rpc, cfg, candidates);
      await persistPools(c, cfg.chain, cfg.token, scope.inScope);

      /*
       * WHO IS A ROUTER, FROM BEHAVIOUR. Reported here rather than taken from
       * config/infrastructure.yaml, which is a list somebody noticed. Both
       * directions are reported: a router the list misses gets a trade
       * attributed to it instead of to the buyer, and a list entry behaviour
       * does not support is a claim nobody checked.
       */
      const v3Addrs = scope.inScope.filter((p) => p.venue === 'v3').map((p) => p.pool);
      const w0 = windows[0]!;
      const detected = await detectRouters(
        c, rpc, cfg, v3Addrs, w0.startBlock ?? firstBlock, w0.endBlock ?? head, head,
      );
      const versus = compareToList(detected.candidates, exclusions.map((e) => e.address));

      return {
        report: {
          routers: {
            probed: detected.probed,
            identified: detected.candidates.filter((x) => x.isRouter).length,
            rejected: detected.candidates.filter((x) => !x.isRouter).length,
            top: detected.candidates.slice(0, 10).map((x) => ({
              address: x.address, recipients: x.recipients, sends: x.sends,
              swap_share: Number((100 * x.swapShare).toFixed(1)),
              kind: x.kind, router: x.isRouter, reason: x.reason,
            })),
            in_behaviour_not_in_config: versus.onlyBehavioural,
            in_config_not_in_behaviour: versus.onlyConfigured,
            in_both: versus.both,
          },
          in_scope: scope.inScope.length,
          rejected: scope.rejected.length,
          counters: scope.counters.map((x) => ({
            symbol: x.symbol, address: x.address, decimals: x.decimals,
            classification: x.classification, pools: x.pools,
          })),
          no_usd_route: scope.noUsdRoute,
          no_native_route: scope.noNativeRoute,
          note: scope.noUsdRoute
            ? 'NO USD-QUOTED POOL EXISTS. Every row will carry a null usd_amount; ' +
              'nothing will be priced from a non-USD reference.'
            : null,
        },
      };
    });

    /* ---- 5. sweep -------------------------------------------------------- */
    await run('sweep', async (rpc, c) => {
      pools = await loadPools(c, cfg.chain, cfg.token);
      if (!head) head = await rpc.blockNumber();
      const v3 = [...pools.values()].filter((p) => p.venue === 'v3').map((p) => p.pool);
      const v4 = [...pools.values()].filter((p) => p.venue === 'v4').map((p) => p.pool);
      const totals: Record<string, number> = { v3: 0, v4: 0, transfer: 0 };

      if (v3.length > 0) {
        const s = await adaptiveSweep(
          rpc, cfg, { address: v3, topics: [TOPICS.swapV3] }, firstBlock, head,
          async (logs, from, to) => {
            for (const l of logs) {
              const d = decodeSwap(l, 'v3');
              await c.query(
                `insert into token_swap_logs
                   (chain, token, venue, pool, block_number, log_index, tx_hash,
                    sender, recipient, amount0, amount1)
                 values ($1,$2,'v3',$3,$4,$5,$6,$7,$8,$9,$10)
                 on conflict do nothing`,
                [cfg.chain, cfg.token, d.pool, d.block, d.logIndex, d.txHash,
                 l.topics[1] ?? null, l.topics[2] ?? null, d.amount0.toString(), d.amount1.toString()],
              );
              await c.query(
                `insert into block_times (chain, block_number, block_time)
                 values ($1,$2,to_timestamp($3)) on conflict do nothing`,
                [cfg.chain, d.block, d.timestamp],
              );
            }
            await recordSweepRange(c, cfg, 'swap-v3', from, to, logs.length);
          },
        );
        totals['v3'] = s.logs;
      }

      if (v4.length > 0) {
        const s = await adaptiveSweep(
          rpc, cfg, { address: cfg.v4PoolManager, topics: [TOPICS.swapV4, v4] },
          firstBlock, head,
          async (logs, from, to) => {
            for (const l of logs) {
              const d = decodeSwap(l, 'v4');
              await c.query(
                `insert into token_swap_logs
                   (chain, token, venue, pool, block_number, log_index, tx_hash,
                    sender, recipient, amount0, amount1)
                 values ($1,$2,'v4',$3,$4,$5,$6,$7,null,$8,$9)
                 on conflict do nothing`,
                [cfg.chain, cfg.token, d.pool, d.block, d.logIndex, d.txHash,
                 l.topics[2] ?? null, d.amount0.toString(), d.amount1.toString()],
              );
              await c.query(
                `insert into block_times (chain, block_number, block_time)
                 values ($1,$2,to_timestamp($3)) on conflict do nothing`,
                [cfg.chain, d.block, d.timestamp],
              );
            }
            await recordSweepRange(c, cfg, 'swap-v4', from, to, logs.length);
          },
        );
        totals['v4'] = s.logs;
      }

      const t = await adaptiveSweep(
        rpc, cfg, { address: cfg.token, topics: [TOPICS.transfer] }, firstBlock, head,
        async (logs, from, to) => {
          for (const l of logs) {
            const d = decodeTransfer(l);
            await c.query(
              `insert into token_transfer_logs
                 (chain, token, block_number, log_index, tx_hash, from_addr, to_addr, amount)
               values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict do nothing`,
              [cfg.chain, cfg.token, d.block, d.logIndex, d.txHash, d.from, d.to, d.amount.toString()],
            );
            await c.query(
              `insert into block_times (chain, block_number, block_time)
               values ($1,$2,to_timestamp($3)) on conflict do nothing`,
              [cfg.chain, d.block, d.timestamp],
            );
          }
          await recordSweepRange(c, cfg, 'transfer', from, to, logs.length);
        },
      );
      totals['transfer'] = t.logs;

      const coverage: Record<string, unknown> = {};
      for (const kind of ['swap-v3', 'swap-v4', 'transfer']) {
        const chk = await checkCoverage(c, cfg, kind, firstBlock, head);
        coverage[kind] = chk;
        if (chk.gaps.length > 0 || chk.coveredBlocks !== chk.expectedBlocks) {
          throw new Error(
            `sweep "${kind}" did not cover ${firstBlock}..${head} exactly: ` +
              `${chk.coveredBlocks} of ${chk.expectedBlocks} blocks, ${chk.gaps.length} gap(s), ` +
              `${chk.overlaps} overlap(s). A sweep with a gap is not a completed sweep.`,
          );
        }
      }
      return { report: { logs: totals, coverage } };
    });

    /* ---- 6. sign conventions -------------------------------------------- */
    await run('conventions', async (_rpc, c) => {
      pools = pools.size ? pools : await loadPools(c, cfg.chain, cfg.token);
      const regions: { label: string; from: number; to: number }[] = [];
      const w0 = windows[0]!;
      regions.push({ label: 'in-window', from: w0.startBlock!, to: w0.endBlock! });
      regions.push({ label: 'before-window', from: firstBlock, to: w0.startBlock! - 1 });
      regions.push({ label: 'after-window', from: w0.endBlock! + 1, to: head });

      const results: unknown[] = [];
      for (const region of regions) {
        if (region.to <= region.from) continue;
        const swapRows = await c.query<{
          venue: string; pool: string; block_number: number; log_index: number;
          tx_hash: string; amount0: string; amount1: string;
        }>(
          `select venue, pool, block_number, log_index, tx_hash, amount0::text, amount1::text
             from token_swap_logs
            where chain=$1 and token=$2 and block_number between $3 and $4
            order by block_number limit 800`,
          [cfg.chain, cfg.token, region.from, region.to],
        );
        const txs = swapRows.rows.map((r) => r.tx_hash);
        if (txs.length === 0) continue;
        const transferRows = await c.query<{
          block_number: number; log_index: number; tx_hash: string;
          from_addr: string; to_addr: string; amount: string;
        }>(
          `select block_number, log_index, tx_hash, from_addr, to_addr, amount::text
             from token_transfer_logs
            where chain=$1 and token=$2 and tx_hash = any($3::text[])`,
          [cfg.chain, cfg.token, txs],
        );
        const asLog = (r: { block_number: number; log_index: number; tx_hash: string }) => ({
          address: cfg.token, topics: [] as string[], data: '0x',
          blockNumber: '0x' + r.block_number.toString(16),
          transactionHash: r.tx_hash,
          logIndex: '0x' + r.log_index.toString(16),
          blockTimestamp: '0x1',
        });
        const swaps = swapRows.rows
          .map((r) => {
            const venue = r.venue === 'v4' ? ('v4' as const) : ('v3' as const);
            const pool = pools.get(poolKey(venue, r.pool.toLowerCase()));
            if (!pool) return null;
            const a0 = BigInt(r.amount0);
            const a1 = BigInt(r.amount1);
            const data =
              '0x' + toWord(a0) + toWord(a1) + '00'.repeat(32 * 3);
            return { log: { ...asLog(r), data }, pool, venue };
          })
          .filter((x): x is NonNullable<typeof x> => x !== null);
        const transfers = transferRows.rows.map((r) => ({
          ...asLog(r),
          topics: [
            TOPICS.transfer,
            '0x' + '0'.repeat(24) + r.from_addr.slice(2),
            '0x' + '0'.repeat(24) + r.to_addr.slice(2),
          ],
          data: '0x' + toWord(BigInt(r.amount)),
        }));
        results.push(...verifyConventions(swaps, transfers, cfg, region.label));
      }

      const disagreeing = (results as { venue: string; region: string; convention: string; agreeing: number; tested: number }[])
        .filter((r) => r.tested > 0 && r.convention === 'undetermined');
      if (disagreeing.length > 0) {
        throw new Error(
          'sign conventions are not unanimous: ' +
            disagreeing.map((d) => `${d.venue}/${d.region} ${d.agreeing}/${d.tested}`).join(', ') +
            '. Direction is taken from the transfer, but a venue that does not agree ' +
            'with itself means the amounts cannot be trusted either.',
        );
      }
      return { report: { conventions: results } };
    });

    /* ---- 7. cohort ------------------------------------------ STOP ------ */
    await run('cohort', async (rpc, c) => {
      pools = pools.size ? pools : await loadPools(c, cfg.chain, cfg.token);
      const reports = [];
      for (const w of windows) {
        const r = await buildCohort(c, rpc, cfg, w, pools, exclusions);
        reports.push({ ...r, cohort: r.cohort.length, sample: r.cohort.slice(0, 3) });
        await c.query(
          `insert into token_intake_state (chain, token, phase, status, detail)
           values ($1,$2,$3,'complete',$4::jsonb)
           on conflict (chain, token, phase) do update set detail = excluded.detail`,
          [cfg.chain, cfg.token, `cohort:${w.label}`, JSON.stringify(r.cohort)],
        );
      }
      return { report: { windows: reports } };
    });

    /* ---- 7b. tags -- its own phase, so the log names what it writes ----- */
    await run('tags', async (_rpc, c) => {
      const written: Record<string, number> = {};
      for (const w of windows) {
        const stored = await c.query<{ detail: unknown }>(
          `select detail from token_intake_state where chain=$1 and token=$2 and phase=$3`,
          [cfg.chain, cfg.token, `cohort:${w.label}`],
        );
        const cohort = (stored.rows[0]?.detail ?? []) as string[];
        if (!Array.isArray(cohort) || cohort.length === 0) {
          throw new Error(
            `no stored cohort for window "${w.label}"; the cohort phase did not complete`,
          );
        }
        written[w.label] = await writeTags(c, cfg, w, cohort);
      }
      return { report: { tags_written: written } };
    });

    /* ---- 8. timestamps -------------------------------------------------- */
    await run('timestamps', async (rpc, c) => {
      const plan = await planTimestamps(c, cfg);
      log.info('timestamp work set, derived from the rows to be written', { ...plan });
      const result = await fetchTimestamps(c, rpc, cfg, cfg.ceilings.timestamps);
      return { report: { plan, ...result } };
    });

    /* ---- 8. prices ------------------------------------------ STOP ------ */
    await run('prices', async (_rpc, c) => {
      pools = pools.size ? pools : await loadPools(c, cfg.chain, cfg.token);
      const decimals = identity?.decimals ??
        (await c.query<{ decimals: number }>(`select decimals from tokens where mint=$1`, [cfg.token]))
          .rows[0]?.decimals;
      if (typeof decimals !== 'number') throw new Error('token decimals unknown');
      /*
       * THE SECOND HOP. Each bridge asset gets its own USD series first, from
       * swaps stored under ITS address, so the token's bridge-quoted pools can
       * be priced. Gaps stay gaps: a bucket with no bridge trade prices nothing.
       */
      const bridgeReport: Record<string, unknown> = {};
      for (const bridge of cfg.bridgeAssets) {
        const bridgePools = await loadPools(c, cfg.chain, bridge);
        if (bridgePools.size === 0) {
          bridgeReport[bridge] = 'NO IN-SCOPE POOLS STORED -- nothing derivable';
          continue;
        }
        const slice = await loadLegsInput(
          c, { ...cfg, token: bridge }, bridgePools, firstBlock, head,
        );
        const bdec = (await c.query<{ decimals: number }>(
          `select decimals from tokens where mint=$1`, [bridge])).rows[0]?.decimals ?? 18;
        const d = deriveBridgeUsd(slice.swaps, cfg, bdec, cfg.bucketOrigin);
        const written = await persistBridgeUsd(c, cfg, bridge, d.series);
        bridgeReport[bridge] = {
          buckets_with_ticks: d.buckets, buckets_priced: d.series.size,
          ticks_discarded_by_fence: d.discarded, ...written,
        };
      }

      const { series } = await derivePricesForLife(c, cfg, pools, decimals, firstBlock, head);
      const written = await persistAllPrices(c, cfg, series);
      const totals = series.reduce(
        (acc, s) => ({
          usdTicks: acc.usdTicks + s.stats.tokenUsdTicks,
          usdDiscarded: acc.usdDiscarded + s.stats.tokenUsdDiscarded,
          natTicks: acc.natTicks + s.stats.tokenNativeTicks,
          natDiscarded: acc.natDiscarded + s.stats.tokenNativeDiscarded,
          derived: acc.derived + s.stats.nativeDerived,
          nativeDiscarded: acc.nativeDiscarded + s.stats.nativeDiscarded,
          noUsdSide: acc.noUsdSide + s.stats.bucketsWithoutUsdSide,
          noNativeSide: acc.noNativeSide + s.stats.bucketsWithoutNativeSide,
        }),
        { usdTicks: 0, usdDiscarded: 0, natTicks: 0, natDiscarded: 0, derived: 0,
          nativeDiscarded: 0, noUsdSide: 0, noNativeSide: 0 },
      );
      return { report: { ...totals, written, bridges: bridgeReport } };
    });

    /* ---- 9. dry run ----------------------------------------- STOP ------ */
    await run('dryrun', async (_rpc, c) => {
      pools = pools.size ? pools : await loadPools(c, cfg.chain, cfg.token);
      const decimals = (await c.query<{ decimals: number }>(
        `select decimals from tokens where mint=$1`, [cfg.token])).rows[0]?.decimals;
      if (typeof decimals !== 'number') throw new Error('token decimals unknown');
      const cohortRows = await c.query<{ wallet: string }>(
        `select distinct wallet from wallet_tags where mint=$1`, [cfg.token]);
      const cohort = new Set(cohortRows.rows.map((r) => r.wallet.toLowerCase()));
      const bridgeUsd = await loadBridgeUsd(c, cfg);
      const { plan } = await planOrWrite(
        c, cfg, pools, decimals, cohort, excludedAddresses, firstBlock, head, false, bridgeUsd,
      );
      return { report: { DRY_RUN: true, cohort: cohort.size, ...plan } };
    });

    /* ---- 10. write ------------------------------------------------------ */
    await run('write', async (_rpc, c) => {
      pools = pools.size ? pools : await loadPools(c, cfg.chain, cfg.token);
      const decimals = (await c.query<{ decimals: number }>(
        `select decimals from tokens where mint=$1`, [cfg.token])).rows[0]?.decimals;
      if (typeof decimals !== 'number') throw new Error('token decimals unknown');
      const cohortRows = await c.query<{ wallet: string }>(
        `select distinct wallet from wallet_tags where mint=$1`, [cfg.token]);
      const cohort = new Set(cohortRows.rows.map((r) => r.wallet.toLowerCase()));
      const bridgeUsd = await loadBridgeUsd(c, cfg);
      const { plan, stored } = await planOrWrite(
        c, cfg, pools, decimals, cohort, excludedAddresses, firstBlock, head, true, bridgeUsd,
      );
      return { report: { ...plan, rows_stored: stored } };
    });

    log.info('intake complete', { token: cfg.token, ticker: cfg.ticker });
  } catch (err) {
    if (err instanceof Stop) {
      log.warn('STOPPED FOR REVIEW', {
        phase: err.phase,
        report: err.report,
        next: `review the numbers, then re-run with --continue to clear this stop`,
      });
      await app.pool.end();
      process.exit(0);
    }
    throw err;
  }

  await app.pool.end();
  process.exit(0);
}

/** Two's-complement 32-byte word, for reconstructing a log's data field. */
function toWord(v: bigint): string {
  const x = v < 0n ? (1n << 256n) + v : v;
  return x.toString(16).padStart(64, '0');
}

main().catch((err) => {
  log.error('intake failed', errorFields(err));
  process.exit(1);
});

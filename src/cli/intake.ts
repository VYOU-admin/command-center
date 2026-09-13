/**
 * The token intake runner: `npm run intake -- <config.yaml> [--continue]`
 *
 * docs/ROBINHOOD.md as code. The PONS intake was carried out by
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
import { requireMonitorFor } from '../intake/monitor-check.js';
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
import {
  TOPICS, addressTopic, decodeSwap, decodeTransfer, readDecimals,
} from '../adapters/token-updates/decode.js';
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
  checkPricesAgainstTicks,
  checkUsdTotal,
  persistBridgeUsd,
  planOrWrite,
  planTimestamps,
} from '../intake/write.js';
import { deriveBridgeUsd } from '../adapters/token-updates/prices.js';
import { compareToList, detectRouters, effectiveExclusions } from '../intake/routers.js';

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
  /*
   * `--redo <phase>` EXISTS BECAUSE THE DOCUMENT REQUIRES A PHASE TO BE RE-RUN.
   *
   * ROBINHOOD.md step 7: "ROUTER DETECTION MUST RUN AFTER THE SWEEP, NOT IN THE
   * SCOPE PHASE... Re-run scope after the sweep, or move detection to the cohort
   * step." Detection lives in `scope`, `scope` runs before `sweep`, and `run()`
   * returns immediately for any phase already stored `complete` -- so the
   * documented remedy had no way to be carried out through the runner, and the
   * alternative was a hand-written UPDATE outside every dry-run discipline here.
   *
   * CHUMP is why: its scope phase probed 0 candidates and persisted 0 routers,
   * which is indistinguishable from a token with none, and the cohort would then
   * have been built against config/infrastructure.yaml alone -- the exact defect
   * recorded against PONS's 13,095-wallet cohort.
   *
   * It clears the stored status for EXACTLY the named phase and nothing else, and
   * it reports the row it cleared rather than asserting it did.
   */
  const redoIdx = args.indexOf('--redo');
  const redoArg = redoIdx >= 0 ? args[redoIdx + 1] : undefined;
  if (redoIdx >= 0 && (!redoArg || redoArg.startsWith('--'))) {
    throw new Error(`--redo needs a phase name. One of: ${PHASES.join(', ')}`);
  }
  if (redoArg && !(PHASES as readonly string[]).includes(redoArg)) {
    throw new Error(`--redo "${redoArg}" is not a phase. One of: ${PHASES.join(', ')}`);
  }
  const redo = redoArg as Phase | undefined;
  if (!configPath) throw new Error('usage: intake <config.yaml> [--continue] [--redo <phase>]');

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

  /*
   * The redo is applied BEFORE the phase statuses are read, so the cleared phase
   * is simply not `complete` when `done` is computed. The previous report is not
   * discarded silently: it is copied to `<phase>:superseded` first, because the
   * state table is the only record of what a phase actually did and overwriting
   * it would destroy the very figure a re-run is meant to be compared against.
   */
  if (redo) {
    await withTransaction(app.pool, async (c) => {
      const before = await c.query<{ status: string; cu_spent: string }>(
        `select status, cu_spent::text from token_intake_state
          where chain = $1 and token = $2 and phase = $3`,
        [cfg.chain, cfg.token, redo],
      );
      if (before.rowCount === 0) {
        log.warn('--redo names a phase with NO STORED ROW; it would have run anyway', {
          phase: redo,
        });
        return;
      }
      await c.query(
        `insert into token_intake_state (chain, token, phase, status, detail, cu_spent)
         select chain, token, phase || ':superseded', status, detail, cu_spent
           from token_intake_state
          where chain = $1 and token = $2 and phase = $3
         on conflict (chain, token, phase) do update
           set status = excluded.status, detail = excluded.detail,
               cu_spent = excluded.cu_spent`,
        [cfg.chain, cfg.token, redo],
      );
      const cleared = await c.query(
        `update token_intake_state set status = 'redo-requested'
          where chain = $1 and token = $2 and phase = $3`,
        [cfg.chain, cfg.token, redo],
      );
      log.warn('PHASE CLEARED FOR RE-RUN', {
        phase: redo,
        previous_status: before.rows[0]!.status,
        previous_cu_spent: before.rows[0]!.cu_spent,
        rows_cleared: cleared.rowCount,
        previous_report_kept_as: `${redo}:superseded`,
      });
    });
  }

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
  /*
   * CLEARING A STOP MUST PERSIST IT, or the runner cannot cross two adjacent STOP
   * phases. `pools` and `scope` are adjacent, and this used to add the cleared
   * phase to `done` in memory only: the stored row stayed `stopped`, so the NEXT
   * invocation saw two stopped phases, took the later one (the loop above has no
   * break, so the last assignment wins), added only that to `done`, found the
   * earlier one neither complete nor cleared, re-ran it and stopped there again.
   * CHUMP deadlocked between pools and scope on every --continue.
   *
   * A phase that has produced its report and had its stop cleared is COMPLETE, and
   * the state table should say so -- it is the only record of what happened.
   */
  if (stoppedOn) {
    const cleared: Phase = stoppedOn;
    done.add(cleared);
    await withTransaction(app.pool, async (c) => {
      await c.query(
        `update token_intake_state set status = 'complete'
          where chain = $1 and token = $2 and phase = $3 and status = 'stopped'`,
        [cfg.chain, cfg.token, cleared],
      );
    });
    log.info('stop cleared and recorded complete', { phase: cleared });
  }

  /* Carried between phases within one invocation. */
  let identity: Awaited<ReturnType<typeof readIdentity>> | null = null;
  let head = 0;
  let firstBlock = 0;
  let pools = new Map<string, PoolRow>();
  const exclusions = await loadExclusions(INFRASTRUCTURE_PATH, cfg.chain);
  /*
   * Resolved per phase rather than once at startup: the scope phase is what
   * discovers the routers, so a phase running after it must pick them up.
   */
  const effective = async (c: PoolClient): Promise<Set<string>> => {
    const e = await effectiveExclusions(
      c, cfg.chain, cfg.token, exclusions.map((x) => x.address),
    );
    return e.addresses;
  };

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
    const win = await run('windows', async (rpc, c) => {
      if (!head) head = await rpc.blockNumber();
      const resolved = await resolveWindows(rpc, cfg, firstBlock || 1, head);
      /*
       * PERSISTED, because a later phase may run in a LATER INVOCATION. Every
       * STOP ends the process, so the phase after it starts with none of this
       * in memory -- and a window whose blocks are undefined silently became
       * `between 0 and 0` for router detection, which reported a clean pass
       * over a range containing nothing. See section 9.
       */
      await c.query(
        `insert into token_intake_state (chain, token, phase, status, detail)
         values ($1, $2, 'windows:resolved', 'complete', $3::jsonb)
         on conflict (chain, token, phase) do update set detail = excluded.detail`,
        [cfg.chain, cfg.token, JSON.stringify(resolved)],
      );
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
    /*
     * On a resumed run `win` is undefined because the phase was already
     * complete, so the resolved blocks are read back rather than falling back
     * to the raw config -- whose startBlock and endBlock are undefined.
     */
    let windows = win ?? cfg.windows;
    if (!win) {
      const stored = await withTransaction(app.pool, async (c) =>
        c.query<{ detail: unknown }>(
          `select detail from token_intake_state
            where chain = $1 and token = $2 and phase = 'windows:resolved'`,
          [cfg.chain, cfg.token],
        ));
      const detail = stored.rows[0]?.detail as typeof cfg.windows | undefined;
      if (detail?.length) windows = detail;
    }
    if (windows.some((w) => !w.startBlock || !w.endBlock)) {
      throw new Error(
        'window blocks are unresolved. Re-run the windows phase rather than '
          + 'continuing: a phase that filters on an unresolved window reads an '
          + 'empty range and reports a clean pass over nothing.',
      );
    }

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
      /*
       * ROBINHOOD.md step 3: if a token resolves to a very large number of
       * pools, stop and report rather than reading all of them. Cost is linear
       * in pools and the choice is the operator's. AI has 4,856.
       */
      if (found.candidates.length > cfg.maxPools) {
        throw new Error(
          `${cfg.ticker} resolved to ${found.candidates.length.toLocaleString()} pools, ` +
            `above the max_pools ceiling of ${cfg.maxPools.toLocaleString()}. Reading them ` +
            'all costs linearly in pools. Raise the ceiling deliberately or narrow the scope.',
        );
      }
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
          flow_probe_ran: found.flowProbeRan,
          v3_from_flow_probe: found.flowProbeRan
            ? found.v3FromFlowProbe
            : 'NOT RUN -- flow_probe is off for this token; v3 pools from '
              + 'factories other than the configured one were not looked for',
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
      if (!head) head = await rpc.blockNumber();
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
      for (const r of scope.rejected) {
        await c.query(
          `insert into pool_rejected
             (chain, token, venue, pool, counter, counter_sym, reason)
           values ($1,$2,$3,$4,$5,$6,$7)
           on conflict (chain, token, venue, pool) do update
             set reason = excluded.reason, counter_sym = excluded.counter_sym`,
          [cfg.chain, cfg.token, r.venue, r.pool, r.counter, r.symbol,
           r.symbolRead
             ? `counter ${r.symbol ?? r.counter} is not a recognised pricing or bridge asset`
             : `counter ${r.counter} is not a configured pricing or bridge asset; its `
               + 'symbol was NOT READ -- it fell outside scope_max_counter_reads'],
        );
      }

      /*
       * WHO IS A ROUTER, FROM BEHAVIOUR. Reported here rather than taken from
       * config/infrastructure.yaml, which is a list somebody noticed. Both
       * directions are reported: a router the list misses gets a trade
       * attributed to it instead of to the buyer, and a list entry behaviour
       * does not support is a claim nobody checked.
       */
      const v3Addrs = scope.inScope.filter((p) => p.venue === 'v3').map((p) => p.pool);
      // EVERY window, not just the first: a multi-window token routes
      // differently in each, and one window's behaviour is not the token's.
      const detectedAll: Awaited<ReturnType<typeof detectRouters>>['candidates'] = [];
      let probedTotal = 0;
      for (const w of windows) {
        const d = await detectRouters(
          c, rpc, cfg, v3Addrs, w.startBlock ?? firstBlock, w.endBlock ?? head, head,
        );
        probedTotal += d.probed;
        for (const cand of d.candidates) {
          if (!detectedAll.some((x) => x.address === cand.address)) detectedAll.push(cand);
        }
      }
      const detected = { candidates: detectedAll, probed: probedTotal };
      const versus = compareToList(detected.candidates, exclusions.map((e) => e.address));

      /*
       * ROBINHOOD.md step 7: routers are identified by BEHAVIOUR. The detected
       * set is persisted and merged into the exclusions the pipeline actually
       * applies, rather than only appearing in a report while the hand-typed
       * list does the work.
       */
      for (const cand of detected.candidates.filter((x) => x.isRouter)) {
        await c.query(
          `insert into token_intake_state (chain, token, phase, status, detail)
           values ($1,$2,$3,'complete',$4::jsonb)
           on conflict (chain, token, phase) do update set detail = excluded.detail`,
          [cfg.chain, cfg.token, `router:${cand.address}`, JSON.stringify(cand)],
        );
      }

      /*
       * ROBINHOOD.md step 4: if a token has no USD route at all -- no
       * stablecoin pool and no bridge -- report it and stop. Do not substitute
       * a rate from anywhere else.
       */
      if (scope.noUsdRoute && cfg.bridgeAssets.length === 0) {
        throw new Error(
          `${cfg.ticker} has no USD-quoted pool and no bridge asset configured. ` +
            'Every row would carry a null usd_amount. Configure a bridge whose own ' +
            'price is derivable on chain, or stop.',
        );
      }

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

      /*
       * NO PAYMENT SWEEP. This used to sweep `Transfer` on each pricing asset
       * with the pools as a topic array, to ask whether a wallet had sent one
       * to a pool. That question rejected 39 of 40 decoded buys, all of which
       * had paid. Payment is now proven per transaction from the receipt --
       * see intake/payment.ts, the single implementation -- and nothing reads
       * `token_payment_logs` any more. Its rows are kept; it is simply no
       * longer written.
       */

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
    await run('conventions', async (rpc, c) => {
      pools = pools.size ? pools : await loadPools(c, cfg.chain, cfg.token);
      /*
       * RESOLVED FROM STORED STATE, NOT FROM VARIABLES A RESUMED RUN NEVER SET.
       *
       * `head` and `firstBlock` are set by the phases that fetch them, and a
       * resumed run skips every one of those because they are already complete.
       * On CHUMP both were 0, so the after-window region came out as
       * `44,992,964..0`, failed `to <= from`, and was dropped in silence --
       * 262,954 swaps, 95.6% of the token's total, never verified. Step 7 has
       * said since AI that a STOP ends the process and anything a later phase
       * needs must be PERSISTED; this is its third appearance.
       */
      if (!head) head = await rpc.blockNumber();
      if (!firstBlock) {
        const idRow = await c.query<{ detail: { deployment_block?: number } }>(
          `select detail from token_intake_state
            where chain=$1 and token=$2 and phase='identity'`,
          [cfg.chain, cfg.token],
        );
        const stored = idRow.rows[0]?.detail?.deployment_block;
        if (typeof stored !== 'number') {
          throw new Error(
            'the conventions phase has no deployment block: it is not in memory and '
              + 'the stored identity report does not carry one. A region computed from '
              + 'an unset bound is dropped rather than checked, which reads as a pass.',
          );
        }
        firstBlock = stored;
      }

      const w0 = windows[0]!;
      const regions: { label: string; from: number; to: number }[] = [
        { label: 'in-window', from: w0.startBlock!, to: w0.endBlock! },
        { label: 'before-window', from: firstBlock, to: w0.startBlock! - 1 },
        { label: 'after-window', from: w0.endBlock! + 1, to: head },
      ];

      const results: unknown[] = [];
      const emptyRegions: Record<string, string> = {};
      for (const region of regions) {
        if (region.to < region.from) {
          /*
           * A region whose bounds are inverted is not an empty region, it is an
           * unresolved bound. Raising is the point: the old code skipped it.
           */
          throw new Error(
            `conventions region "${region.label}" is ${region.from}..${region.to}, `
              + 'which is inverted. That is an unresolved bound, not a quiet region, '
              + 'and skipping it reports a pass over data nobody looked at.',
          );
        }
        /*
         * PER VENUE. One `limit 800` shared by both venues samples whichever
         * venue trades earliest: CHUMP's first 800 in-window swaps are all v3,
         * so its 18 v4 swaps were never reached and `tested: 0` passed.
         */
        const present = await c.query<{ venue: string; n: string }>(
          `select venue, count(*)::text n from token_swap_logs
            where chain=$1 and token=$2 and block_number between $3 and $4
            group by venue`,
          [cfg.chain, cfg.token, region.from, region.to],
        );
        const counts = new Map(present.rows.map((r) => [r.venue, Number(r.n)]));
        if (counts.size === 0) {
          // A ZERO IS A RESULT. Printed, never omitted -- an omitted line is
          // indistinguishable from a check that never ran.
          emptyRegions[region.label] =
            `RETURNED NO ROWS -- ${region.from}..${region.to} holds no swap of this token`;
          continue;
        }
        const swapRows = await c.query<{
          venue: string; pool: string; block_number: number; log_index: number;
          tx_hash: string; amount0: string; amount1: string;
        }>(
          `select venue, pool, block_number, log_index, tx_hash, amount0::text, amount1::text
             from (
               select *, row_number() over (partition by venue order by block_number) rn
                 from token_swap_logs
                where chain=$1 and token=$2 and block_number between $3 and $4
             ) s
            where rn <= 800
            order by venue, block_number`,
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
        const regionResults = verifyConventions(swaps, transfers, cfg, region.label);
        /*
         * A VENUE PRESENT IN THE REGION WHOSE SAMPLE HOLDS NONE OF IT IS A DEFECT.
         *
         * Two different things look alike in a `tested: 0` and only one is a bug:
         * a sample that never REACHED the venue -- the CHUMP defect, where one
         * `limit 800` over the region returned 800 v3 rows and no v4 -- and a
         * sample that reached it where every swap was ambiguous, which is a real
         * property of the data. The first raises here. The second is reported,
         * and is caught at the end if the venue is established in no region at all.
         */
        const sampledPerVenue = new Map<string, number>();
        for (const r of swapRows.rows) {
          sampledPerVenue.set(r.venue, (sampledPerVenue.get(r.venue) ?? 0) + 1);
        }
        for (const r of regionResults) {
          const venueCount = counts.get(r.venue) ?? 0;
          const sampled = sampledPerVenue.get(r.venue) ?? 0;
          if (venueCount > 0 && sampled === 0) {
            throw new Error(
              `conventions: region "${region.label}" holds ${venueCount.toLocaleString()} `
                + `${r.venue} swaps and the sample contains NONE of them. That is a sample `
                + 'that never reached the venue, not a venue that agrees.',
            );
          }
        }
        results.push(...regionResults.map((r) => ({
          ...r,
          in_region: counts.get(r.venue) ?? 0,
          sampled: sampledPerVenue.get(r.venue) ?? 0,
        })));
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
      /*
       * EVERY VENUE THE TOKEN TRADES ON MUST HAVE BEEN TESTED SOMEWHERE. A token
       * with 10,722 v4 swaps whose v4 convention was never established anywhere
       * would have every v4 buy written as a sell if the assumption were wrong.
       */
      const tokenVenues = await c.query<{ venue: string; n: string }>(
        `select venue, count(*)::text n from token_swap_logs
          where chain=$1 and token=$2 group by venue`,
        [cfg.chain, cfg.token],
      );
      const tested = new Set(
        (results as { venue: string; tested: number }[])
          .filter((r) => r.tested > 0).map((r) => r.venue),
      );
      const untested = tokenVenues.rows.filter((v) => !tested.has(v.venue));
      if (untested.length > 0) {
        throw new Error(
          'conventions: '
            + untested.map((v) => `${v.venue} has ${Number(v.n).toLocaleString()} swaps`).join(', ')
            + ' and its convention was established in NO region. An untested venue is '
            + 'not a venue that agrees.',
        );
      }
      return {
        report: {
          conventions: results,
          regions_with_no_swaps: Object.keys(emptyRegions).length ? emptyRegions : 'none',
          venues_tested: [...tested].sort(),
        },
      };
    });

    /* ---- 7. cohort ------------------------------------------ STOP ------ */
    await run('cohort', async (rpc, c) => {
      pools = pools.size ? pools : await loadPools(c, cfg.chain, cfg.token);
      const reports = [];
      for (const w of windows) {
        const eff = await effectiveExclusions(
          c, cfg.chain, cfg.token, exclusions.map((x) => x.address),
        );
        const r = await buildCohort(c, rpc, cfg, w, pools, eff.addresses);
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
      const written: Record<string, unknown> = {};
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
        // Complete: the sweep gap-checked clean and the cohort phase finished,
        // both of which are prerequisites of reaching this phase at all.
        written[w.label] = await writeTags(c, cfg, w, cohort, true);
      }
      return { report: { tags_and_windows: written } };
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
        const firstComplete =
          cfg.bucketOrigin +
          Math.ceil((firstBlock - cfg.bucketOrigin) / cfg.bucketBlocks) * cfg.bucketBlocks;
        const d = deriveBridgeUsd(slice.swaps, cfg, bdec, firstComplete);
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
        c, cfg, pools, decimals, cohort, await effective(c),
        firstBlock, head, false, bridgeUsd,
      );
      return { report: { DRY_RUN: true, cohort: cohort.size, ...plan } };
    });

    /* ---- 10. write ------------------------------------------------------ */
    /*
     * A LOADED TOKEN WITHOUT A MONITOR MUST NOT LOOK COMPLETE. Checked before
     * the write so the failure lands while the operator is still here, not a
     * month later when the token has quietly stopped advancing.
     */
    await run('write', async (_rpc, c) => {
      const monitor = await requireMonitorFor('monitors', cfg.ticker, cfg.token, {
        bucketOrigin: cfg.bucketOrigin,
        bridgeAssets: cfg.bridgeAssets,
        tokenUsdTable: cfg.tokenUsdTable,
      });
      log.info('hourly monitor found', { id: monitor.id, file: monitor.file });
      pools = pools.size ? pools : await loadPools(c, cfg.chain, cfg.token);
      const decimals = (await c.query<{ decimals: number }>(
        `select decimals from tokens where mint=$1`, [cfg.token])).rows[0]?.decimals;
      if (typeof decimals !== 'number') throw new Error('token decimals unknown');
      const cohortRows = await c.query<{ wallet: string }>(
        `select distinct wallet from wallet_tags where mint=$1`, [cfg.token]);
      const cohort = new Set(cohortRows.rows.map((r) => r.wallet.toLowerCase()));
      const bridgeUsd = await loadBridgeUsd(c, cfg);
      /*
       * Dry-run counts before any delete, including the zeros. On a first run
       * the existing-row count is 0, and that zero is stated rather than
       * omitted -- an omitted line is indistinguishable from a check that never
       * ran.
       */
      const existing = Number((await c.query<{ n: string }>(
        `select count(*)::text n from wallet_transactions
          where chain=$1 and token=$2 and block_number between $3 and $4`,
        [cfg.chain, cfg.token, firstBlock, head])).rows[0]!.n);
      const reinsert = process.argv.includes('--reinsert');
      log.info('write pre-flight', {
        rows_already_present: existing,
        mode: reinsert ? 'DELETE AND REINSERT, scoped to this token and range'
                       : 'insert only; existing rows are left untouched',
      });
      if (existing > 0 && !reinsert) {
        throw new Error(
          `${existing.toLocaleString()} rows already exist for this token in ` +
            `${firstBlock}..${head}. Insert-only would leave them as they are. ` +
            'Pass --reinsert to delete and rewrite this range, or narrow the range.',
        );
      }

      const { plan, stored, deleted } = await planOrWrite(
        c, cfg, pools, decimals, cohort, await effective(c),
        firstBlock, head, true, bridgeUsd, reinsert,
      );

      const priceCheck = await checkPricesAgainstTicks(c, cfg);
      if (priceCheck.outside > 0) {
        throw new Error(
          `${priceCheck.outside} stored prices fall outside the range of the ticks ` +
            `they came from (ticks ${priceCheck.tickLo}..${priceCheck.tickHi}, stored ` +
            `${priceCheck.storedLo}..${priceCheck.storedHi}). That is a defect to explain.`,
        );
      }
      const supply = Number((await c.query<{ s: string }>(
        `select coalesce(max(total_supply),0)::text s from tokens where mint=$1`,
        [cfg.token]).catch(() => ({ rows: [{ s: '0' }] }))).rows[0]!.s);
      const usdCheck = checkUsdTotal(
        plan.totals.usd, plan.totals.tokenAmount, supply, cfg.impliedPriceCeiling,
      );
      if (usdCheck.absurd) throw new Error(`USD total sanity check failed: ${usdCheck.reason}`);

      return {
        report: {
          ...plan, rows_stored: stored, rows_deleted: deleted,
          rows_already_present_before: existing,
          price_range_check: priceCheck,
          usd_total_check: usdCheck,
        },
      };
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

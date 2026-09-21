/**
 * `npm run oneshot -- --live` — THE $1 PLUMBING TEST. ONE TRADE. NOTHING ELSE.
 *
 * **NO SELL HAS EVER BEEN BROADCAST IN THIS PROJECT.** Every exit figure in
 * `docs/LAUNCHBOT.md` comes from `eth_call` simulation. This file exists to answer one
 * question and no other: **does a sell broadcast, mine, and return ETH?**
 *
 * It is not a strategy test. The P&L of one $1 trade proves nothing about any rule, and
 * §6AC is explicit that the rules are not even implemented in the executing code.
 *
 * ===========================================================================
 * WHY THIS IS A SEPARATE CLI AND NOT A FLAG ON `launchbot`
 * ===========================================================================
 *
 * §6AC.2 measured `launchbot`'s rule rejecting **every** launch the collector rules
 * qualify, on all three of its checks: `LAUNCHPADS` names the v4 PositionManager rather
 * than the Pools.trade factory, `ALLOWED_FEES` excludes the observed tiers, and
 * `GAP_MIN_BLOCKS = 11` structurally excludes a population whose first swap is in the
 * SAME block as `Initialize`. Adding a flag would have meant editing the live rule under
 * an authorisation for a plumbing test, and `rule.ts` is the one file this project has
 * a standing prohibition on quietly re-pointing.
 *
 * So the entry decision here is **read from `bot_p13`**, the collector's own table, and
 * the four rules are exactly the columns it already stores. There is no second
 * implementation of a rule in this file — it does not decide what qualifies, it asks.
 *
 * ===========================================================================
 * THE HARD STOPS, WHICH ARE STRUCTURAL RATHER THAN CHECKED
 * ===========================================================================
 *
 * 1. **ONE TRADE.** The buy is outside any loop. There is no iteration over candidates
 *    and no counter to get wrong: the code path from candidate to exit runs once and the
 *    process ends. `launchbot`'s `MAX_TRADES_PER_RUN = 10` / `MAX_CONCURRENT = 5` cannot
 *    apply because there is nothing here to repeat.
 * 2. **THE HALT IS CHECKED IMMEDIATELY BEFORE THE BUY**, not only at startup, and again
 *    before the sell. An operator halting mid-wait must stop this.
 * 3. **THE POSITION IS `positionWei(ethUsd)`** — the one implementation, which divides
 *    `RAILS.MAX_POSITION_USD` by a live rate and raises on a missing one.
 * 4. **A BALANCE CEILING.** Refuses to start if the wallet holds more than
 *    `MAX_WALLET_ETH`, because this is instrumentation and a large balance behind it is
 *    an accident waiting to be a loss.
 * 5. **THE SELL BOUND IS REACHABLE.** §6A.3: `SWAP_EXACT_IN_SINGLE` checks
 *    `amountOutMinimum` INSIDE the swap action and reverts BEFORE `SETTLE_ALL` pulls the
 *    token, so an unreachable bound measures the pricing curve and never transfers. The
 *    bound comes from `minOut()` applied to a fresh quote taken at the exit block.
 * 6. **THE SELL AMOUNT IS THE CHAIN'S BALANCE**, read after the buy mined — never the
 *    quote. A quote is not a balance.
 *
 * ===========================================================================
 * WHAT IT DOES, IN ORDER
 * ===========================================================================
 *
 *   preflight  -> mode is live, key present, chain id 4663, halt clear, balance sane
 *   wait       -> poll `bot_p13` for a row qualifying under P11/P14a/P14b/P15 whose
 *                 entry block is not yet passed. NEVER relaxes a rule to find one.
 *   buy        -> at init+1150, broadcast, await receipt, MINED or stop
 *   balance    -> read the token balance from the chain
 *   approve    -> `ensureSellReadiness` for exactly that balance (two-step Permit2)
 *   sell       -> at init+2150, fresh quote, reachable bound, broadcast, await receipt
 *   report     -> every hash, block, gas, and the ETH delta, all re-read from chain
 *
 * Any failure stops. Nothing is retried blindly, and a second position is impossible.
 */
import { AbiCoder, id } from 'ethers';
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { RpcClient } from '../adapters/token-updates/rpc.js';
import { BroadcastRpc, ReadOnlyRpc } from '../bot/rpc.js';
import { resolveMode } from '../bot/mode.js';
import { createBroadcaster } from '../bot/signer.js';
import { ensureSellReadiness } from '../bot/approvals.js';
import { awaitReceipt } from '../bot/receipt.js';
import { buildSwap } from '../bot/calldata.js';
import { positionWei, minOut } from '../bot/rule.js';
import { isHalted } from '../bot/state.js';
import { simulateSellAt } from '../bot/sellability.js';
import {
  ENTRY_BLOCKS, EXIT_BLOCKS, findCanonicalLaunches, readEntryState, rollingCuts,
  scoreRules, type CanonicalLaunch,
} from '../bot/collector-rules.js';

const CHAIN = 'robinhood';
const RPC_URL = 'https://robinhood-mainnet.g.alchemy.com/v2/{key}';
const abi = AbiCoder.defaultAbiCoder();
const V4_TOO_LITTLE = id('V4TooLittleReceived(uint256,uint256)').slice(0, 10);
const UNREACHABLE = 1n << 127n;
/** Refuse to run behind a wallet larger than instrumentation needs. */
const MAX_WALLET_ETH = 0.05;
/**
 * How long to wait for a qualifying launch before giving up and saying so.
 *
 * **8 HOURS, RAISED FROM 90 MINUTES 2026-09-21.** §6AE measured qualifiers arriving
 * at ~5.4/day across all four rules, with gaps of up to 337,517 blocks (~9 h). At 90
 * minutes the chance of catching one was ~22% (Poisson), so the likely outcome was a
 * timeout that consumed an arming window and answered nothing.
 */
const WAIT_MINUTES = 480;
/**
 * **THE POLL INTERVAL IS A COST DECISION, NOT A LATENCY ONE.** Each poll costs about
 * 130 CU — `eth_blockNumber` plus the two `eth_getLogs` sweeps behind
 * `findCanonicalLaunches` — and that cost is per POLL, not per block scanned, because
 * the sweep covers `lastScan+1..head` whatever the gap. At the original 5 s over 8
 * hours that is 5,760 polls and **~749,000 CU, which blows the ceiling below AND the
 * operator's ~500,000 CU check-in threshold.** At 20 s it is ~187,000 CU.
 *
 * Nothing is missed by polling slower: the sweep is range-based, so a launch is merely
 * learned about up to 20 s late, against a 115-second runway to its entry block.
 */
const POLL_MS = 20_000;
const RECEIPT_TIMEOUT_MS = 120_000;
/* Sized for the 8-hour wait: ~187,000 CU of scanning, ~5,000 evaluating the launches
   seen, and ~30,000 for the round trip, with headroom. Deliberately below the
   operator's ~500,000 CU check-in threshold. */
const CU_CEILING = 400_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

interface Candidate {
  poolId: string; initBlock: number; token: string; rules: string;
}

/** Gas actually spent by a mined transaction, read from its receipt. */
async function gasOf(rpc: { call(m: string, p: unknown[]): Promise<unknown> }, hash: string):
Promise<{ gasUsed: bigint; effPrice: bigint; feeWei: bigint; block: number | null }> {
  const r = (await rpc.call('eth_getTransactionReceipt', [hash])) as
    { gasUsed?: string; effectiveGasPrice?: string; blockNumber?: string } | null;
  if (r === null) return { gasUsed: 0n, effPrice: 0n, feeWei: 0n, block: null };
  const g = BigInt(r.gasUsed ?? '0x0');
  const p = BigInt(r.effectiveGasPrice ?? '0x0');
  return { gasUsed: g, effPrice: p, feeWei: g * p,
    block: r.blockNumber === undefined ? null : Number(BigInt(r.blockNumber)) };
}

async function main(): Promise<void> {
  const mode = resolveMode(process.argv.slice(2), process.env);
  const key = process.env['ALCHEMY_API_KEY'];
  if (!key) throw new Error('ALCHEMY_API_KEY is not set');
  const app = await bootstrap();
  const c = await app.pool.connect();
  const inner = new RpcClient(RPC_URL.replace('{key}', key), 60_000, CU_CEILING);
  /* The read path refuses every signing method BY NAME, in every mode. */
  const rpc = new ReadOnlyRpc(inner);

  try {
    log.info('ONE-SHOT $1 PLUMBING TEST', {
      mode: mode.label,
      question: 'does a sell broadcast, mine, and return ETH',
      not_a_strategy_test: 'the P&L of one trade proves nothing about any rule',
      hard_stops: 'one trade (structural), halt re-checked before buy AND sell, '
        + `position = positionWei(live rate), wallet ceiling ${MAX_WALLET_ETH} ETH, `
        + 'reachable sell bound, sell amount = chain balance',
      wait_hours: WAIT_MINUTES / 60,
      poll_seconds: POLL_MS / 1000,
      cu_budget: `~${Math.round(WAIT_MINUTES * 60_000 / POLL_MS) * 130} scanning `
        + `+ ~35,000 evaluating and trading, ceiling ${CU_CEILING}`,
    });

    /* ---- PREFLIGHT ---------------------------------------------------- */
    if (!mode.live) {
      log.info('DRY RUN — nothing will be broadcast', {
        note: `pass --live deliberately to trade. Mode resolved as "${mode.label}".`,
      });
    }
    const halt0 = await isHalted(c, CHAIN, mode.label);
    if (halt0.halted) {
      log.error('REFUSING TO START: HALTED', { scope: halt0.scope, reason: halt0.reason });
      return;
    }
    const bcast = mode.live
      ? await createBroadcaster(mode, new BroadcastRpc(inner, mode)) : null;
    const owner = (bcast?.address
      ?? process.env['BOT_WALLET_ADDRESS']?.trim().toLowerCase() ?? '').toLowerCase();
    if (owner === '') throw new Error('no owner address: set BOT_WALLET_ADDRESS');

    const bal0 = BigInt(String(await rpc.call('eth_getBalance', [owner, 'latest'])));
    const ethUsdRow = await c.query<{ e: string | null }>(
      `select eth_usd::text e from native_usd_prices
        where chain = $1 order by block_number desc limit 1`, [CHAIN]);
    const ethUsd = Number(ethUsdRow.rows[0]?.e ?? NaN);
    const size = positionWei(ethUsd);   /* raises on a missing rate */
    if (Number(bal0) / 1e18 > MAX_WALLET_ETH) {
      log.error('REFUSING TO START: WALLET TOO LARGE FOR AN INSTRUMENTATION RUN', {
        balance_eth: (Number(bal0) / 1e18).toFixed(8), ceiling_eth: MAX_WALLET_ETH,
      });
      return;
    }
    if (bal0 <= size * 3n) {
      log.error('REFUSING TO START: BALANCE TOO SMALL FOR A ROUND TRIP PLUS GAS', {
        balance_wei: bal0.toString(), position_wei: size.toString(),
        note: 'needs the position plus buy gas plus sell gas plus approval gas',
      });
      return;
    }
    log.info('PREFLIGHT PASSED', {
      owner, balance_eth: (Number(bal0) / 1e18).toFixed(8),
      eth_usd: ethUsd.toFixed(2),
      position_wei: size.toString(),
      position_eth: (Number(size) / 1e18).toFixed(8),
      broadcaster: bcast === null ? 'NONE (dry run)' : 'present',
      nonce_tracked: bcast?.trackedNonce() ?? null,
    });

    /* ---- WAIT FOR ONE QUALIFYING LAUNCH ------------------------------- */
    /*
     * EVALUATED LIVE, THROUGH THE SHARED RULE MODULE.
     *
     * v1 queried `bot_p13` for a row whose entry block had not yet passed. That is
     * UNSATISFIABLE: the collector only processes launches whose EXIT has matured, so
     * every stored row's entry is at least 4,000 blocks in the past. v1 would have
     * waited its full window and reported "nothing traded", every time. The rules now
     * live in `bot/collector-rules.ts` and are imported by the collector AND by this
     * file, so evaluating them here is not a second implementation.
     *
     * A launch is a candidate only while its entry block is still AHEAD of head, and
     * the state is read at the block we have actually reached — never extrapolated.
     */
    const deadline = Date.now() + WAIT_MINUTES * 60_000;
    let cand: CanonicalLaunch | null = null;
    let rulesFired = '';
    let scanned = 0;
    let lastScan = Number(BigInt(String(await rpc.call('eth_blockNumber', [])))) - 400;
    let polls = 0;
    while (cand === null && Date.now() < deadline) {
      polls += 1;
      const head = Number(BigInt(String(await rpc.call('eth_blockNumber', []))));
      if (head <= lastScan) { await sleep(POLL_MS); continue; }
      let fresh: CanonicalLaunch[] = [];
      try {
        fresh = await findCanonicalLaunches(rpc, lastScan + 1, head,
          (data) => abi.decode(['uint24', 'int24', 'address', 'uint160', 'int24'], data) as
            unknown as [bigint, bigint, string, bigint, bigint]);
      } catch (err) {
        log.warn('launch scan failed, retrying', errorFields(err));
        await sleep(POLL_MS); continue;
      }
      lastScan = head;
      for (const L of fresh) {
        scanned += 1;
        /* Only usable if we can still reach its entry block. */
        if (L.initBlock + ENTRY_BLOCKS <= head) continue;
        /* Read what has happened SO FAR and score it. A launch that already fails a
           gate on partial data can only get worse for gate 2 and the sell count, so
           it is dropped; one that passes is re-scored at the entry block below. */
        const st = await readEntryState(rpc, L.poolId, L.initBlock, head);
        const cuts = await rollingCuts(c, CHAIN, L.initBlock);
        const v = scoreRules(st, cuts);
        log.info('launch seen', {
          pool_id: L.poolId, init_block: L.initBlock,
          blocks_to_entry: L.initBlock + ENTRY_BLOCKS - head,
          creator_share: st.creatorShare.toFixed(4), sold_90: st.sold90.toFixed(4),
          n_sells: st.nSells, eth_in: st.ethInTotal.toFixed(4),
          pool_eth: st.poolEth.toFixed(4),
          gate1: v.gate1, gate2: v.gate2, provisional_rules: v.which || 'none',
        });
        if (v.gate1 && v.gate2) { cand = L; break; }
      }
      if (cand === null && polls % 15 === 1) {
        log.info('waiting for a qualifying launch', {
          head, scanned, minutes_left: Math.round((deadline - Date.now()) / 60_000),
          note: 'NO RULE WILL BE RELAXED TO FIND ONE',
        });
      }
      if (cand === null) await sleep(POLL_MS);
    }
    if (cand === null) {
      log.info('NO QUALIFYING LAUNCH APPEARED — STOPPING, NOTHING TRADED', {
        waited_minutes: WAIT_MINUTES, polls, launches_scanned: scanned,
        note: 'a rule was NOT relaxed to force a trade. Re-run to wait again.',
      });
      return;
    }
    log.info('CANDIDATE PASSED BOTH GATES — holding to the entry block', {
      pool_id: cand.poolId, init_block: cand.initBlock, token: cand.token,
      entry_block: cand.initBlock + ENTRY_BLOCKS,
      exit_block: cand.initBlock + EXIT_BLOCKS,
    });

    /* Reconstruct the pool key from the Initialize log — never from a stored guess. */
    const { pool, zeroIsPricing, token } = cand;

    /* ---- WAIT FOR THE ENTRY BLOCK ------------------------------------- */
    const entryBlock = cand.initBlock + ENTRY_BLOCKS;
    for (;;) {
      const head = Number(BigInt(String(await rpc.call('eth_blockNumber', []))));
      if (head >= entryBlock) break;
      await sleep(Math.min(10_000, (entryBlock - head) * 100));
    }

    /*
     * THE DECISIVE EVALUATION, AT THE ENTRY BLOCK. The scan above admitted the launch
     * on PARTIAL data to avoid missing it; the rule is applied for real here, on the
     * full 0..+115 s window, and a launch that no longer qualifies is DROPPED rather
     * than traded on the earlier provisional verdict.
     */
    const stateNow = await readEntryState(rpc, cand.poolId, cand.initBlock);
    const cutsNow = await rollingCuts(c, CHAIN, cand.initBlock);
    const verdict = scoreRules(stateNow, cutsNow);
    log.info('RULE APPLIED AT THE ENTRY BLOCK', {
      pool_id: cand.poolId,
      creator_share: stateNow.creatorShare.toFixed(4),
      sold_90: stateNow.sold90.toFixed(4), n_sells: stateNow.nSells,
      eth_in_total: stateNow.ethInTotal.toFixed(4),
      pool_eth: stateNow.poolEth.toFixed(4),
      roll_72h: cutsNow.a === null ? 'below MIN_N' : cutsNow.a.toFixed(4),
      roll_12h: cutsNow.b === null ? 'below MIN_N' : cutsNow.b.toFixed(4),
      P11: verdict.p11, P14a: verdict.p14a, P14b: verdict.p14b, P15: verdict.p15,
      qualifies: verdict.any,
    });
    if (!verdict.any) {
      log.info('NO LONGER QUALIFIES AT THE ENTRY BLOCK — STOPPING, NOTHING TRADED', {
        pool_id: cand.poolId,
        note: 'the provisional verdict during the scan was on partial data. The rule '
          + 'is applied on the full window here and it does not fire. Not relaxed.',
      });
      return;
    }
    rulesFired = verdict.which;

    /* Quote at the entry block with an UNREACHABLE bound: this is a QUOTE, and the
       revert payload is the router's own output. It is never used as an exit price
       (§6A.3) — only to size our reachable bound for the buy. */
    let quoted: bigint | null = null;
    const probe = buildSwap({ pool, zeroForOne: zeroIsPricing, amountIn: size,
      amountOutMinimum: UNREACHABLE,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 600) });
    try {
      await rpc.call('eth_call', [{ from: owner, to: probe.to, data: probe.data,
        value: `0x${probe.value.toString(16)}` }, 'latest']);
    } catch (err) {
      const e2 = err as Error & { data?: unknown };
      const dd = typeof e2.data === 'string' ? e2.data : '';
      if (dd.startsWith(V4_TOO_LITTLE)) {
        const dec = abi.decode(['uint256', 'uint256'], `0x${dd.slice(10)}`) as unknown as bigint[];
        if ((dec[1] as bigint) > 0n) quoted = dec[1] as bigint;
      }
    }
    if (quoted === null || quoted <= 0n) {
      log.error('NO QUOTE AT THE ENTRY BLOCK — STOPPING, NOTHING TRADED',
        { pool_id: cand.poolId });
      return;
    }

    /* HALT RE-CHECKED IMMEDIATELY BEFORE THE BUY. */
    const halt1 = await isHalted(c, CHAIN, mode.label);
    if (halt1.halted) {
      log.error('HALTED WHILE WAITING — NOTHING TRADED',
        { scope: halt1.scope, reason: halt1.reason });
      return;
    }

    const buy = buildSwap({ pool, zeroForOne: zeroIsPricing, amountIn: size,
      amountOutMinimum: minOut(quoted),
      deadline: BigInt(Math.floor(Date.now() / 1000) + 600) });
    log.info('BUY — ABOUT TO BROADCAST', {
      pool_id: cand.poolId, token, entry_block: entryBlock,
      qualified_under: rulesFired,
      amount_in_wei: size.toString(), quoted_out: quoted.toString(),
      min_out: minOut(quoted).toString(),
      to: buy.to, value_wei: buy.value.toString(),
      will_broadcast: bcast !== null,
    });
    if (bcast === null) {
      log.info('DRY RUN COMPLETE — NOTHING WAS BROADCAST', {
        note: 'pass --live to execute. Every step above was real except the send.',
      });
      return;
    }

    /* ---- THE BUY ------------------------------------------------------ */
    const buyHash = await bcast.send({ to: buy.to, data: buy.data, value: buy.value,
      description: `oneshot buy ${token}` });
    log.info('BUY BROADCAST', { hash: buyHash, nonce: bcast.lastNonce() });
    const buyRec = await awaitReceipt(rpc, buyHash,
      { timeoutMs: RECEIPT_TIMEOUT_MS, pollMs: 1_000 });
    const buyGas = await gasOf(rpc, buyHash);
    log.info('BUY RECEIPT', { hash: buyHash, outcome: buyRec.outcome,
      block: buyRec.blockNumber, wait_ms: buyRec.waitMs, polls: buyRec.polls,
      gas_used: buyGas.gasUsed.toString(), fee_wei: buyGas.feeWei.toString() });
    if (buyRec.outcome !== 'mined') {
      log.error('BUY DID NOT MINE — STOPPING. NO SELL IS ATTEMPTED.', {
        hash: buyHash, outcome: buyRec.outcome,
        note: buyRec.outcome === 'unknown'
          ? 'THE TRANSACTION MAY STILL LAND. Do not send anything else with this '
            + 'wallet until it is reconciled against the chain.'
          : 'the buy reverted; nothing was bought and there is nothing to sell.',
      });
      return;
    }

    /* ---- THE BALANCE, FROM THE CHAIN ---------------------------------- */
    const balData = `0x70a08231${owner.slice(2).padStart(64, '0')}`;
    const heldRaw = String(await rpc.call('eth_call',
      [{ to: token, data: balData }, 'latest']));
    const held = BigInt(heldRaw);
    log.info('POSITION HELD, READ FROM CHAIN', {
      token, held_raw: held.toString(), quoted_out: quoted.toString(),
      fill_vs_quote: quoted > 0n ? (Number(held) / Number(quoted)).toFixed(4) : 'n/a',
    });
    if (held <= 0n) {
      log.error('BUY MINED BUT THE WALLET HOLDS NONE OF THE TOKEN — STOPPING', {
        token, note: 'the chain is asserting the position does not exist. Investigate '
          + 'before sending anything else.' });
      return;
    }

    /* ---- APPROVALS, FOR EXACTLY THE BALANCE --------------------------- */
    const plan = await ensureSellReadiness(
      { rpc, broadcaster: bcast, receiptTimeoutMs: RECEIPT_TIMEOUT_MS },
      { token, owner, amount: held });
    const apprGas: { hash: string; gasUsed: string; feeWei: string }[] = [];
    for (const s of plan.sent) {
      const g = await gasOf(rpc, s.hash);
      apprGas.push({ hash: s.hash, gasUsed: g.gasUsed.toString(),
        feeWei: g.feeWei.toString() });
    }
    log.info('APPROVALS', { ready: plan.ready, sent: plan.sent.length,
      steps: plan.steps.map((s) => `${s.label}: ${s.verdict}`), gas: apprGas });
    if (!plan.ready) {
      log.error('APPROVALS NOT READY — STOPPING WITH A POSITION OPEN', {
        token, held: held.toString(),
        note: 'the sell is not attempted because it would revert. THIS IS A STUCK '
          + 'POSITION; report it and do not open anything else.' });
      return;
    }

    /* ---- WAIT FOR THE EXIT BLOCK -------------------------------------- */
    const exitBlock = cand.initBlock + EXIT_BLOCKS;
    for (;;) {
      const head = Number(BigInt(String(await rpc.call('eth_blockNumber', []))));
      if (head >= exitBlock) break;
      await sleep(Math.min(10_000, (exitBlock - head) * 100));
    }

    /* SIMULATE FIRST, at a reachable bound, so the real send has a predicted value to
       be compared against. This is the first ever simulator-vs-reality check. */
    const sim = await simulateSellAt(rpc, { pool, token, owner, amount: held,
      zeroForOneBuy: zeroIsPricing, block: 'latest' });
    log.info('SELL SIMULATION AT THE EXIT BLOCK', {
      executes: sim.executes, eth_out: sim.ethOut === null ? null : sim.ethOut.toString(),
      detail: sim.detail ?? null });
    if (sim.executes !== true || sim.ethOut === null || sim.ethOut <= 0n) {
      log.error('THE SELL WILL NOT EXECUTE — NOT BROADCASTING IT', {
        detail: sim.detail ?? null,
        note: 'THIS IS THE ANSWER THE TEST EXISTS TO FIND. A position is open and '
          + 'cannot be closed at this block. Report it; do not retry blindly.' });
      return;
    }

    /* HALT RE-CHECKED IMMEDIATELY BEFORE THE SELL. */
    const halt2 = await isHalted(c, CHAIN, mode.label);
    if (halt2.halted) {
      log.error('HALTED BEFORE THE SELL — A POSITION IS OPEN AND WAS NOT CLOSED', {
        scope: halt2.scope, reason: halt2.reason, token, held: held.toString() });
      return;
    }

    const sell = buildSwap({ pool, zeroForOne: !zeroIsPricing, amountIn: held,
      amountOutMinimum: minOut(sim.ethOut),
      deadline: BigInt(Math.floor(Date.now() / 1000) + 600) });
    log.info('SELL — ABOUT TO BROADCAST', {
      token, exit_block: exitBlock, amount_in_raw: held.toString(),
      simulated_eth_out: sim.ethOut.toString(),
      min_out_REACHABLE: minOut(sim.ethOut).toString(), to: sell.to });
    const sellHash = await bcast.send({ to: sell.to, data: sell.data, value: sell.value,
      description: `oneshot sell ${token}` });
    log.info('SELL BROADCAST — THE FIRST IN THIS PROJECT', {
      hash: sellHash, nonce: bcast.lastNonce() });
    const sellRec = await awaitReceipt(rpc, sellHash,
      { timeoutMs: RECEIPT_TIMEOUT_MS, pollMs: 1_000 });
    const sellGas = await gasOf(rpc, sellHash);
    log.info('SELL RECEIPT', { hash: sellHash, outcome: sellRec.outcome,
      block: sellRec.blockNumber, wait_ms: sellRec.waitMs, polls: sellRec.polls,
      gas_used: sellGas.gasUsed.toString(), fee_wei: sellGas.feeWei.toString() });

    /* ---- THE RESULT, RE-READ FROM CHAIN ------------------------------- */
    const bal1 = BigInt(String(await rpc.call('eth_getBalance', [owner, 'latest'])));
    const held1 = BigInt(String(await rpc.call('eth_call',
      [{ to: token, data: balData }, 'latest'])));
    const gasTotal = buyGas.feeWei + sellGas.feeWei
      + apprGas.reduce((a, b) => a + BigInt(b.feeWei), 0n);
    log.info('*** ONE-SHOT RESULT — ALL MEASURED FROM CHAIN ***', {
      sell_outcome: sellRec.outcome,
      buy_hash: buyHash, buy_block: buyGas.block,
      sell_hash: sellHash, sell_block: sellGas.block,
      approval_txs: apprGas.length,
      tokens_received: held.toString(),
      tokens_remaining_AFTER_SELL: held1.toString(),
      position_fully_closed: held1 === 0n,
      simulated_eth_out: sim.ethOut.toString(),
      eth_before_wei: bal0.toString(), eth_after_wei: bal1.toString(),
      eth_delta_wei: (bal1 - bal0).toString(),
      eth_delta: (Number(bal1 - bal0) / 1e18).toFixed(8),
      usd_delta: ((Number(bal1 - bal0) / 1e18) * ethUsd).toFixed(4),
      gas_total_wei: gasTotal.toString(),
      gas_total_usd: ((Number(gasTotal) / 1e18) * ethUsd).toFixed(4),
      /* The ETH delta is net of gas already, so the trade's own result is the delta
         plus the gas paid. Both are reported rather than one derived figure. */
      trade_result_excl_gas_usd:
        (((Number(bal1 - bal0) + Number(gasTotal)) / 1e18) * ethUsd).toFixed(4),
      THE_QUESTION: sellRec.outcome === 'mined' && held1 === 0n
        ? 'YES — a sell broadcast, mined, and returned ETH'
        : `NO — sell outcome ${sellRec.outcome}, ${held1} tokens remain`,
      cu: inner.cuSpent,
    });
  } finally { c.release(); await app.pool.end(); }
}

void main().catch((e: unknown) => { log.error('oneshot failed', errorFields(e)); process.exit(1); });

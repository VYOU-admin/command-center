/**
 * `npm run exit-broadcast-drill -- [--commit]`
 *
 * EXERCISES THE EXIT'S BROADCAST PATH, WHICH NO KEY CAN REACH YET.
 *
 * docs/LAUNCHBOT.md section 2C. Threading the broadcaster through `exit-exec` added five
 * branches that only exist on a live path, and this project's standard is that **a path
 * nobody has run is not a path**. No key exists, so the only way to run them today is to
 * drive `executeExit` with a **TEST DOUBLE** in place of the real broadcaster.
 *
 * ---------------------------------------------------------------------------
 * WHAT A TEST DOUBLE PROVES AND WHAT IT DOES NOT — SAID FIRST
 * ---------------------------------------------------------------------------
 *
 * The double implements `{ address, send }` and records what it was asked to do. It does
 * NOT sign, does not reach a network, and is not obtainable from `createBroadcaster` —
 * which remains the only way to get a real one and still refuses outside live mode and
 * without a key. **So this proves the ORCHESTRATION: that a simulation runs before any
 * send, that only the accepted rung is sent, that a receipt decides the outcome, and that
 * an unconfirmed send stops the ladder.** It proves nothing about signing, gas estimation,
 * nonce handling or the chain's acceptance of our bytes, and those remain untested until
 * section 8 step 5.
 *
 * It also does not weaken the build gate: a double implementing an interface is not a
 * signer, reads no key, and names no broadcast method — `check-live-gate` still confines
 * all three to `bot/signer.ts` and `bot/rpc.ts`.
 *
 * IT RUNS ON `chain='drill'` so nothing it writes can reach the live dry run, and every
 * row is deleted and the deletion verified on a fresh connection.
 */
import { AbiCoder, id } from 'ethers';
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { BOT_SCHEMA } from '../bot/state.js';
import { executeExit } from '../bot/exit-exec.js';
import type { ExitRpc } from '../bot/exit-exec.js';
import { ExitUnrecoverableError } from '../bot/exit.js';
import { EXIT_RETRY, PERMIT2, UNIVERSAL_ROUTER } from '../bot/config.js';
import type { Broadcaster, UnsignedTx } from '../bot/signer.js';
import type { PoolClient } from '../store/db.js';

const CHAIN = 'drill';
const OURS = '0x00000000000000000000000000000000000d0011';
const OTHER = '0x00000000000000000000000000000000000d0022';
const TOKEN = '0x00000000000000000000000000000000000d7000';
const COUNTER = '0x0000000000000000000000000000000000000000';
const POOL = `0x${'ab'.repeat(32)}`;

/** A swap log shaped as the decoder expects: amount0, amount1 then the rest. */
function swapData(amount0: bigint, amount1: bigint): string {
  const w = (v: bigint): string => {
    const neg = v < 0n;
    const m = neg ? (1n << 256n) + v : v;
    return m.toString(16).padStart(64, '0');
  };
  return `0x${w(amount0)}${w(amount1)}${'0'.repeat(64 * 4)}`;
}

interface Script {
  /** What `eth_getTransactionReceipt` returns, in order. null = not yet mined. */
  receipts: Array<{ status?: string; blockNumber?: string } | null>;
  /** Make the SIMULATION fail with a decodable V4TooLittleReceived. */
  simulationFails?: boolean;
  /**
   * Allowances. `false` = short. Since 2026-09-16 `exit-exec` GRANTS rather than refusing
   * (LAUNCHBOT.md section 2D), so `grantLands` decides whether the grant it attempts
   * succeeds — which is the difference between "the exit was rescued" and "no bound fixes
   * this". Both are now cases.
   */
  allowanceOk?: boolean;
  /** When the allowances start short: does the grant land and cover them afterwards? */
  grantLands?: boolean;
  /** Make the broadcast itself reject. */
  sendRejects?: boolean;
  /**
   * THE DEADLOCK. Make the SWAP SIMULATION revert `Error("TRANSFER_FROM_FAILED")` until a
   * grant has landed, which is what a real missing allowance does. Before 2026-09-17 this
   * was unrecoverable by construction: the grant lived only AFTER the simulation, and the
   * simulation could not pass without the grant.
   */
  simFailsUntilGranted?: boolean;
  /** Make the first N receipt polls fail at the TRANSPORT, as a flaky endpoint does. */
  receiptThrowsFirst?: number;
}

/** COMPUTED, never looked up. */
const ERROR_STRING_SELECTOR = id('Error(string)').slice(0, 10);
function abiString(t: string): string {
  return AbiCoder.defaultAbiCoder().encode(['string'], [t]);
}

function fakeRpc(script: Script): { rpc: ExitRpc; calls: string[] } {
  const calls: string[] = [];
  let receiptIdx = 0;
  let thrown = 0;
  /* Flipped once a receipt has been served, so `grantLands` can make the RE-READ that
   * `ensureSellReadiness` performs come back covering. */
  let granted = false;
  const rpc: ExitRpc = {
    async call(method: string, params: unknown[]): Promise<unknown> {
      calls.push(method);
      if (method === 'eth_blockNumber') return '0x3e8';
      if (method === 'eth_getLogs') {
        /* One swap: 1e15 of the pricing side against 1e18 of the token. */
        return [{ blockNumber: '0x3e7', logIndex: '0x0',
          data: swapData(10n ** 18n, -(10n ** 15n)) }];
      }
      if (method === 'eth_getTransactionReceipt') {
        if (thrown < (script.receiptThrowsFirst ?? 0)) {
          thrown += 1;
          throw new Error('eth_getTransactionReceipt: response carried no result');
        }
        const r = script.receipts[Math.min(receiptIdx, script.receipts.length - 1)]
          ?? null;
        receiptIdx += 1;
        if (r?.status === '0x1') granted = true;
        return r;
      }
      if (method === 'eth_call') {
        const p = (params[0] ?? {}) as { to?: string; data?: string };
        const to = (p.to ?? '').toLowerCase();
        /* The allowance reads. Both are eth_call, distinguished by target. */
        if (to === PERMIT2) {
          /* (amount, expiration, nonce) — a live grant far in the future. */
          const short = script.allowanceOk === false && !(script.grantLands && granted);
          const amt = short ? 0n : (1n << 150n);
          return `0x${amt.toString(16).padStart(64, '0')}`
            + `${(9_999_999_999n).toString(16).padStart(64, '0')}`
            + `${'0'.repeat(64)}`;
        }
        if (to === TOKEN) {
          const short = script.allowanceOk === false && !(script.grantLands && granted);
          const amt = short ? 0n : (1n << 200n);
          return `0x${amt.toString(16).padStart(64, '0')}`;
        }
        /* The swap simulation against the router. */
        if (script.simFailsUntilGranted && !granted) {
          const err = new Error('execution reverted') as Error & { data?: string };
          /* Error(string) selector + an ABI-encoded "TRANSFER_FROM_FAILED". */
          err.data = ERROR_STRING_SELECTOR
            + abiString('TRANSFER_FROM_FAILED').slice(2);
          throw err;
        }
        if (script.simulationFails) {
          const err = new Error('execution reverted') as Error & { data?: string };
          /* keccak('V4TooLittleReceived(uint256,uint256)')[0:4] + two words. */
          err.data = '0x8b063d73'
            + (999n).toString(16).padStart(64, '0')
            + (1n).toString(16).padStart(64, '0');
          throw err;
        }
        return '0x01';
      }
      throw new Error(`fakeRpc: unexpected method ${method}`);
    },
  };
  return { rpc, calls };
}

function fakeBroadcaster(script: Script, address = OURS): {
  b: Broadcaster; sent: UnsignedTx[];
} {
  const sent: UnsignedTx[] = [];
  /* Mirrors the real signer: invalidated before the send, set after. */
  let nextNonce: number | null = 200;
  let lastUsed: number | null = null;
  return {
    sent,
    b: {
      address,
      resyncNonce(): void { nextNonce = null; },
      trackedNonce(): number | null { return nextNonce; },
      lastNonce(): number | null { return lastUsed; },
      async send(tx: UnsignedTx): Promise<string> {
        const nonce = nextNonce ?? 200;
        nextNonce = null;
        sent.push(tx);
        if (script.sendRejects) throw new Error('transport exploded after submission');
        nextNonce = nonce + 1;
        lastUsed = nonce;
        return `0x${'cd'.repeat(32)}`;
      },
    },
  };
}

interface Result { name: string; pass: boolean; detail: string }
const results: Result[] = [];

async function seed(c: PoolClient, id: string): Promise<void> {
  await c.query(
    `insert into bot_trades (chain,mode,pool_id,token,counter,status,fee,tick_spacing,
       hooks,position_usd,first_swap_block)
     values ($1,'drill',$2,$3,$4,'holding',500,10,'0x0000000000000000000000000000000000000000',
             10,999)
     on conflict (chain, mode, pool_id) do nothing`,
    [CHAIN, `${POOL.slice(0, 60)}${id.padStart(4, '0')}`, TOKEN, COUNTER]);
}

async function main(): Promise<void> {
  const commit = process.argv.includes('--commit');
  const app = await bootstrap();
  const c = await app.pool.connect();
  try {
    await c.query(BOT_SCHEMA);
    const pre = await c.query<{ n: string }>(
      'select count(*)::text n from bot_trades where chain = $1', [CHAIN]);
    log.info('DRY-RUN COUNTS BEFORE THE DRILL', {
      drill_rows_present: pre.rows[0]!.n, commit,
      ladder: EXIT_RETRY.BOUND_BPS, max_attempts: EXIT_RETRY.MAX_ATTEMPTS,
      note: 'must be 0; a non-zero count means a previous drill did not clean up',
    });
    if (!commit) {
      log.info('DRY RUN -- nothing written', { note: 'pass --commit to run the drill' });
      c.release(); await app.pool.end(); process.exit(0);
    }
    await c.query('delete from bot_trades where chain = $1', [CHAIN]);
    await c.query('delete from bot_exit_attempts where chain = $1', [CHAIN]);

    const base = {
      tradeId: '0', poolId: POOL, token: TOKEN, counter: COUNTER,
      fee: 500, tickSpacing: 10,
      hooks: '0x0000000000000000000000000000000000000000',
      amountIn: 10n ** 18n, firstSwapBlock: 1, sellFrom: OURS,
    };
    const ctxBase = {
      client: c, chain: CHAIN, wait: async (): Promise<void> => {},
      pollWait: async (): Promise<void> => {},
      receiptTimeoutMs: 0,
    };
    const record = (name: string, pass: boolean, detail: string): void => {
      results.push({ name, pass, detail });
      log[pass ? 'info' : 'error'](`${pass ? 'PASS' : 'FAIL'}  ${name}`, { detail });
    };

    /* ---- 1. NO BROADCASTER: SIMULATES AND SENDS NOTHING ------------------- */
    {
      const s: Script = { receipts: [] };
      const { rpc, calls } = fakeRpc(s);
      const { sent } = fakeBroadcaster(s);
      const out = await executeExit({ ...ctxBase, rpc, broadcaster: null }, base);
      record('no broadcaster -> simulated, NOTHING sent',
        out.filled && sent.length === 0
          && !calls.includes('eth_getTransactionReceipt'),
        `filled=${out.filled} sent=${sent.length} receipts_polled=`
        + `${calls.filter((x) => x === 'eth_getTransactionReceipt').length}`);
    }

    /* ---- 2. LIVE, SIMULATION FAILS: NOT SENT, LADDER CLIMBS AND EXHAUSTS -- */
    {
      const s: Script = { receipts: [], simulationFails: true };
      const { rpc } = fakeRpc(s);
      const { b, sent } = fakeBroadcaster(s);
      let raised = '';
      try {
        await executeExit({ ...ctxBase, rpc, broadcaster: b }, base);
      } catch (e) { raised = (e as Error).message; }
      record('live + simulation fails -> NOTHING sent, ladder exhausts',
        sent.length === 0 && raised.includes('EXIT EXHAUSTED')
          && !(raised.includes('UNKNOWN')),
        `sent=${sent.length} raised="${raised.slice(0, 70)}"`);
    }

    /* ---- 3. LIVE, SIMULATION PASSES: SENDS ONCE, RECEIPT 1 -> FILLED ------ */
    {
      const s: Script = { receipts: [{ status: '0x1', blockNumber: '0x3e9' }] };
      const { rpc } = fakeRpc(s);
      const { b, sent } = fakeBroadcaster(s);
      const out = await executeExit({ ...ctxBase, rpc, broadcaster: b }, base);
      record('live + simulation passes -> sent ONCE, receipt status 1 = FILLED',
        out.filled && sent.length === 1 && out.filledOn === 1,
        `filled=${out.filled} sent=${sent.length} on_attempt=${out.filledOn}`);
    }

    /* ---- 4. LIVE, RECEIPT STATUS 0: ORDINARY FAILURE, LADDER CONTINUES --- */
    {
      const s: Script = { receipts: [{ status: '0x0', blockNumber: '0x3e9' }] };
      const { rpc } = fakeRpc(s);
      const { b, sent } = fakeBroadcaster(s);
      let raised = '';
      try {
        await executeExit({ ...ctxBase, rpc, broadcaster: b }, base);
      } catch (e) { raised = (e as Error).message; }
      /* A mined revert is settled, so every rung is tried: one send per rung. */
      record('live + receipt status 0 -> ordinary failure, ladder RAN ALL RUNGS',
        sent.length === EXIT_RETRY.MAX_ATTEMPTS && raised.includes('EXIT EXHAUSTED'),
        `sent=${sent.length} of ${EXIT_RETRY.MAX_ATTEMPTS} rungs, `
        + `raised="${raised.slice(0, 60)}"`);
    }

    /* ---- 5. LIVE, NO RECEIPT: UNRECOVERABLE, LADDER STOPS AT ONE SEND ---- */
    {
      const s: Script = { receipts: [null] };
      const { rpc } = fakeRpc(s);
      const { b, sent } = fakeBroadcaster(s);
      let err: unknown = null;
      try {
        await executeExit({ ...ctxBase, rpc, broadcaster: b }, base);
      } catch (e) { err = e; }
      record('live + NO RECEIPT -> UNRECOVERABLE, exactly ONE send, ladder STOPPED',
        err instanceof ExitUnrecoverableError && sent.length === 1
          && (err as Error).message.includes('UNKNOWN'),
        `type=${(err as Error)?.name} sent=${sent.length} (a second send here would be a `
        + 'second sell of one position)');
    }

    /* ---- 6. LIVE, BROADCAST REJECTS: UNRECOVERABLE, NOT RETRIED ---------- */
    {
      const s: Script = { receipts: [], sendRejects: true };
      const { rpc } = fakeRpc(s);
      const { b, sent } = fakeBroadcaster(s);
      let err: unknown = null;
      try {
        await executeExit({ ...ctxBase, rpc, broadcaster: b }, base);
      } catch (e) { err = e; }
      record('live + broadcast rejects -> UNRECOVERABLE (a throw is not proof nothing '
        + 'was sent)',
      err instanceof ExitUnrecoverableError && sent.length === 1,
      `type=${(err as Error)?.name} attempted_sends=${sent.length}`);
    }

    /* ---- 6b. THE DEADLOCK: SIMULATION FAILS ON THE ALLOWANCE ------------ */
    /*
     * THE CASE THAT COULD NOT PASS BEFORE 2026-09-17. The allowances are short, so the
     * SIMULATION reverts `TRANSFER_FROM_FAILED` — and the grant used to live only after
     * the simulation returned, so it was never reached. The exit path could never
     * self-heal a missing approval, which is the one thing section 2D says it exists to
     * do. Here the grant must fire FROM the simulation's own failure, the simulation must
     * be retried, and exactly ONE sell must follow.
     */
    {
      const s: Script = {
        receipts: [{ status: '0x1', blockNumber: '0x3e8' }],
        allowanceOk: false, grantLands: true, simFailsUntilGranted: true,
      };
      const { rpc } = fakeRpc(s);
      const { b, sent } = fakeBroadcaster(s);
      let raised = '';
      try { await executeExit({ ...ctxBase, rpc, broadcaster: b }, base); }
      catch (e) { raised = (e as Error).message; }
      const approvals = sent.filter((t) => t.to.toLowerCase() !== UNIVERSAL_ROUTER).length;
      const sells = sent.filter((t) => t.to.toLowerCase() === UNIVERSAL_ROUTER).length;
      record('DEADLOCK: simulation fails on the ALLOWANCE -> grant fires, simulation '
        + 'RETRIED, ONE sell sent',
      approvals === 2 && sells === 1 && raised === '',
      `approvals=${approvals} sells=${sells} raised="${raised.slice(0, 50)}"`);
    }

    /* ---- 6c. THE SAME, BUT THE GRANT CANNOT BE MADE ---------------------- */
    {
      const s: Script = {
        receipts: [{ status: '0x0', blockNumber: '0x3e8' }],
        allowanceOk: false, grantLands: false, simFailsUntilGranted: true,
      };
      const { rpc } = fakeRpc(s);
      const { b, sent } = fakeBroadcaster(s);
      let err: unknown = null;
      try { await executeExit({ ...ctxBase, rpc, broadcaster: b }, base); }
      catch (e) { err = e; }
      const sells = sent.filter((t) => t.to.toLowerCase() === UNIVERSAL_ROUTER).length;
      record('DEADLOCK: the grant cannot be made -> UNRECOVERABLE, NO SELL sent',
        err instanceof ExitUnrecoverableError && sells === 0,
        `type=${(err as Error)?.name} sells=${sells}`);
    }

    /* ---- 6d. THE CONTROL: A POOL PROBLEM MUST NOT TRIGGER A GRANT -------- */
    /*
     * **THIS IS THE CASE THAT MAKES 6b MEAN SOMETHING.** A fix that granted on every
     * simulation failure would pass 6b and would spend gas on approvals for pools that
     * were never going to pay — the exact thing section 2D's ordering exists to avoid. So
     * the predicate must DISCRIMINATE: `V4TooLittleReceived` is the pool talking, the
     * allowances are short, and NOTHING may be granted.
     */
    {
      const s: Script = { receipts: [], simulationFails: true, allowanceOk: false };
      const { rpc } = fakeRpc(s);
      const { b, sent } = fakeBroadcaster(s);
      let raised = '';
      try { await executeExit({ ...ctxBase, rpc, broadcaster: b }, base); }
      catch (e) { raised = (e as Error).message; }
      record('CONTROL: V4TooLittleReceived with allowances short -> NO grant attempted',
        sent.length === 0 && raised.includes('EXIT EXHAUSTED'),
        `sent=${sent.length} (a grant here would be gas on a pool that pays nothing)`);
    }

    /* ---- 6e. A FLAKY RECEIPT POLL IS RETRIED, NOT TREATED AS A VERDICT --- */
    /*
     * **THIS ENDED THE FIRST 240-MINUTE LIVE RUN AFTER NINETY SECONDS.** Trade 706's
     * STEP 2 approval was broadcast and the next receipt poll answered
     * `response carried no result` — neither a receipt nor a null. That threw out of
     * `awaitReceipt`, the caller read it as an unresolved position, and the mode halted
     * with a real position open. The transaction was fine; one poll was not.
     *
     * The deadline is still the arbiter — a timeout that never reads a status still
     * returns `unknown` and is still unrecoverable — so this asserts only that a
     * TRANSIENT no longer decides.
     */
    {
      const s: Script = {
        receipts: [{ status: '0x1', blockNumber: '0x3e8' }], receiptThrowsFirst: 3,
      };
      const { rpc } = fakeRpc(s);
      const { b, sent } = fakeBroadcaster(s);
      let out: Awaited<ReturnType<typeof executeExit>> | null = null;
      let raised = '';
      /*
       * THIS CASE NEEDS A REAL DEADLINE AND THE OTHERS DO NOT. `ctxBase` carries
       * `receiptTimeoutMs: 0` so the NO-RECEIPT case resolves in one poll; with zero
       * there is no room for a retry to happen in, and this case would fail for the
       * drill's own reason rather than the code's. The poll wait stays a no-op, so it
       * spins through the three failures immediately rather than sleeping.
       */
      try {
        out = await executeExit(
          { ...ctxBase, receiptTimeoutMs: 5_000, rpc, broadcaster: b }, base);
      } catch (e) { raised = (e as Error).message; }
      record('a receipt poll that THROWS 3x is RETRIED -> the exit still FILLS',
        out?.filled === true && sent.length === 1 && raised === '',
        `filled=${String(out?.filled)} sends=${sent.length} raised="${raised.slice(0, 50)}" `
        + '(before this fix ONE flaky poll halted the mode with a position open)');
    }

    /* ---- 7. LIVE, ALLOWANCES SHORT AND UNGRANTABLE: NO SELL IS SENT ----- */
    /*
     * THIS CASE CHANGED ON 2026-09-16 AND THE CHANGE IS THE POINT. `exit-exec` used to
     * REFUSE when the allowances were short; it now GRANTS them through the same
     * `ensureSellReadiness` the loop uses, so a position whose inline grant failed can be
     * rescued by the boot sweep. What must still hold is that a grant which cannot be made
     * stops the ladder: **no bound fixes a missing allowance.**
     *
     * The assertion is therefore no longer "nothing was sent" — approvals are attempted,
     * which is the new behaviour — but **NO SELL WAS SENT**, which is the property that
     * matters. Asserting the old thing would have passed only by the exit having done
     * nothing, which is what this change exists to stop.
     */
    {
      const s: Script = { receipts: [], allowanceOk: false };
      const { rpc } = fakeRpc(s);
      const { b, sent } = fakeBroadcaster(s);
      let err: unknown = null;
      try {
        await executeExit({ ...ctxBase, rpc, broadcaster: b }, base);
      } catch (e) { err = e; }
      const sells = sent.filter((t) => t.to.toLowerCase() === UNIVERSAL_ROUTER);
      record('live + allowances short and UNGRANTABLE -> UNRECOVERABLE, NO SELL sent',
        err instanceof ExitUnrecoverableError && sells.length === 0
          && (err as Error).message.includes('could not be granted'),
        `type=${(err as Error)?.name} sells=${sells.length} total_sends=${sent.length}`);
    }

    /* ---- 7b. LIVE, ALLOWANCES SHORT BUT THE GRANT LANDS: THE SELL GOES -- */
    /*
     * THE CASE THAT PROVES THE CHANGE BOUGHT SOMETHING. A refusal-only path can be shown
     * to refuse; only this shows that a position which WAS unsellable becomes sellable.
     * Two approvals then the sell, in that order, each after the last one's receipt.
     */
    {
      const s: Script = {
        receipts: [{ status: '0x1' }], allowanceOk: false, grantLands: true,
      };
      const { rpc } = fakeRpc(s);
      const { b, sent } = fakeBroadcaster(s);
      let err: unknown = null;
      let outcome: Awaited<ReturnType<typeof executeExit>> | null = null;
      try {
        outcome = await executeExit({ ...ctxBase, rpc, broadcaster: b }, base);
      } catch (e) { err = e; }
      const sells = sent.filter((t) => t.to.toLowerCase() === UNIVERSAL_ROUTER);
      const approvals = sent.filter((t) => t.to.toLowerCase() !== UNIVERSAL_ROUTER);
      record('live + allowances short but the GRANT LANDS -> approvals then ONE sell',
        err === null && outcome?.filledOn === 1
          && approvals.length === 2 && sells.length === 1
          /* ORDER: both approvals precede the sell. */
          && sent.findIndex((t) => t.to.toLowerCase() === UNIVERSAL_ROUTER) === 2,
        `err=${(err as Error)?.message?.slice(0, 60) ?? 'none'} approvals=${approvals.length} `
        + `sells=${sells.length} filled_on=${outcome?.filledOn ?? 'null'}`);
    }

    /* ---- 8. LIVE, SELLER != SIGNER: REFUSED BEFORE ANYTHING ------------- */
    {
      const s: Script = { receipts: [{ status: '0x1' }] };
      const { rpc, calls } = fakeRpc(s);
      const { b, sent } = fakeBroadcaster(s, OURS);
      let err: unknown = null;
      try {
        await executeExit({ ...ctxBase, rpc, broadcaster: b },
          { ...base, sellFrom: OTHER });
      } catch (e) { err = e; }
      record('live + sellFrom is a BORROWED holder -> refused, nothing simulated or sent',
        err instanceof ExitUnrecoverableError && sent.length === 0 && calls.length === 0,
        `type=${(err as Error)?.name} sent=${sent.length} rpc_calls=${calls.length}`);
    }

    /* ---- 9. THE TEST CONTROL CANNOT REACH A LIVE PATH ------------------- */
    {
      const s: Script = { receipts: [{ status: '0x1' }] };
      const { rpc } = fakeRpc(s);
      const { b, sent } = fakeBroadcaster(s);
      let err: unknown = null;
      try {
        await executeExit({ ...ctxBase, rpc, broadcaster: b, forceOptimism: 1.3 }, base);
      } catch (e) { err = e; }
      record('live + forceOptimism -> refused (a control that makes rungs fail on '
        + 'purpose must not touch real money)',
      err instanceof ExitUnrecoverableError && sent.length === 0,
      `type=${(err as Error)?.name} sent=${sent.length}`);
    }

    /* ---- 10. THE ATTEMPT TRAIL IS PERSISTED, INCLUDING THE STOP --------- */
    {
      await seed(c, '1');
      const row = await c.query<{ id: string }>(
        'select id::text from bot_trades where chain = $1 limit 1', [CHAIN]);
      const tradeId = row.rows[0]!.id;
      const s: Script = { receipts: [null] };
      const { rpc } = fakeRpc(s);
      const { b } = fakeBroadcaster(s);
      try {
        await executeExit({ ...ctxBase, rpc, broadcaster: b },
          { ...base, tradeId });
      } catch { /* expected */ }
      const att = await c.query<{ n: string; ok: boolean; detail: string }>(
        `select count(*)::text n, bool_or(ok) ok, min(detail) detail
           from bot_exit_attempts where chain = $1 and trade_id = $2`,
        [CHAIN, tradeId]);
      const r = att.rows[0]!;
      record('the unrecoverable stop is RECORDED before it raises',
        Number(r.n) === 1 && r.ok === false && r.detail.includes('NO RECEIPT'),
        `attempts_recorded=${r.n} ok=${r.ok} detail="${String(r.detail).slice(0, 60)}"`);
    }

    await c.query('delete from bot_trades where chain = $1', [CHAIN]);
    await c.query('delete from bot_exit_attempts where chain = $1', [CHAIN]);
  } finally { c.release(); }

  /* ---- CLEANUP, VERIFIED ON A FRESH CONNECTION ------------------------- */
  const fresh = await app.pool.connect();
  let left = -1; let leftAtt = -1;
  try {
    left = Number((await fresh.query<{ n: string }>(
      'select count(*)::text n from bot_trades where chain = $1', [CHAIN])).rows[0]!.n);
    leftAtt = Number((await fresh.query<{ n: string }>(
      'select count(*)::text n from bot_exit_attempts where chain = $1',
      [CHAIN])).rows[0]!.n);
  } finally { fresh.release(); }

  const failed = results.filter((r) => !r.pass);
  log.info('EXIT BROADCAST DRILL COMPLETE', {
    cases: results.length, passed: results.length - failed.length, failed: failed.length,
    what_this_proves: 'the ORCHESTRATION: a simulation precedes every send, only the '
      + 'accepted rung is sent, a receipt decides, and an unconfirmed send stops the '
      + 'ladder at one transaction',
    what_it_does_NOT_prove: 'signing, gas estimation, nonce handling or the chain '
      + 'accepting our bytes — the broadcaster here is a TEST DOUBLE and no key exists',
    cleanup_verified_on_fresh_connection: { bot_trades: left, bot_exit_attempts: leftAtt },
    results: results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`),
  });
  await app.pool.end();
  if (failed.length > 0 || left !== 0 || leftAtt !== 0) {
    log.error('EXIT BROADCAST DRILL FAILED',
      { failed: failed.length, left, leftAtt });
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  log.error('exit-broadcast-drill failed', errorFields(e)); process.exit(1);
});

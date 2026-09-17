/**
 * `npm run approval-drill` — EXERCISE THE INLINE APPROVAL PATH. LAUNCHBOT.md section 2D.
 *
 * `ensureSellReadiness` decides what to approve, grants it, gates each send on its
 * receipt, and re-reads the chain afterwards. **A path nobody has run is not a path**, and
 * the branches that matter here are exactly the ones a live run must never reach: a grant
 * that reverts, a grant whose receipt never arrives, and an allowance that cannot be read.
 * None of those can be produced on demand against a real chain.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS PROVES AND WHAT IT DOES NOT
 * ---------------------------------------------------------------------------
 *
 * It uses a **TEST DOUBLE** for the broadcaster and a scripted RPC, and it says so in its
 * own output rather than leaving a reader to infer it. So:
 *
 *   PROVES   the ORDERING — that a second transaction is never sent before the first has
 *            a receipt, that MINED is the only outcome that continues, which steps are
 *            skipped, and that every refusal fires where it should.
 *   DOES NOT signing, gas estimation, nonce derivation, or the chain accepting our bytes.
 *            The two real approvals of 2026-09-16 are the evidence for those.
 *
 * ---------------------------------------------------------------------------
 * THE ORDERING IS ASSERTED FROM A RECORDED TRACE, NOT FROM A COUNT
 * ---------------------------------------------------------------------------
 *
 * A send count cannot distinguish "two sends, each confirmed" from "two sends fired back
 * to back" — and the second is the nonce hazard: `signer.send` reads the nonce as
 * `'pending'`, which equals `'latest'` on a node that does not track the mempool, so a
 * second send before the first is mined TAKES ITS NONCE AND REPLACES IT. So every send and
 * every receipt poll is appended to one trace, and the invariant is checked over the
 * sequence: **between any two SENDs there must be a RECEIPT.**
 *
 * It writes NOTHING to the database and touches no chain. That is deliberate:
 * `exit-broadcast-drill` wrote three orphan rows into the live measurement table on its
 * first run, and a drill that needs no rows should have none to leak.
 */
import { errorFields, log } from '../logger.js';
import { AbiCoder, id } from 'ethers';
import { ensureSellReadiness } from '../bot/approvals.js';
import { PERMIT2, UNIVERSAL_ROUTER } from '../bot/config.js';
import type { Broadcaster, UnsignedTx } from '../bot/signer.js';

const abi = AbiCoder.defaultAbiCoder();
const ERC20_ALLOWANCE = id('allowance(address,address)').slice(0, 10);
const PERMIT2_ALLOWANCE = id('allowance(address,address,address)').slice(0, 10);

const TOKEN = '0x00000000000000000000000000000000000000aa';
const OWNER = '0x00000000000000000000000000000000000000bb';
const AMOUNT = 1_000_000n;

/** One entry per observable event, in the order it happened. */
type Trace = string[];

interface Scripted {
  /** What the ERC-20 allowance reads back. `null` = `0x`, i.e. UNREADABLE. */
  erc20: bigint | null;
  /** What Permit2 reads back. */
  permit2: bigint | null;
  permit2Expiration: number;
  /** Per receipt poll, in order: what `eth_getTransactionReceipt` returns. */
  receipts: Array<'mined' | 'reverted' | 'absent'>;
  /** Allowances AFTER a successful grant — how the re-read answers. */
  afterErc20?: bigint | null;
  afterPermit2?: bigint | null;
  /**
   * The expiration the re-read reports after a grant. THE FIRST VERSION OF THIS DRILL HAD
   * NO SUCH FIELD and left it at the pre-grant value, so the "BOTH SHORT" case granted
   * both allowances and then RAISED — `ensureSellReadiness` re-read the chain, found a
   * non-zero Permit2 amount whose expiry had already passed, and correctly refused to call
   * it ready. That is the verify-by-re-reading rule catching a worthless grant, on a
   * fixture that did not intend to produce one. The fixture was wrong; the module was not.
   */
  afterPermit2Expiration?: number;
  /** Make the broadcaster itself throw. */
  sendThrows?: boolean;
}

/** A scripted transport. It answers only the calls this path actually makes. */
function makeRpc(sc: Scripted, trace: Trace): {
  call(m: string, p: unknown[]): Promise<unknown>;
} {
  let granted = false;
  let poll = 0;
  return {
    async call(method: string, params: unknown[]): Promise<unknown> {
      if (method === 'eth_call') {
        const data = String((params[0] as { data: string }).data);
        if (data.startsWith(ERC20_ALLOWANCE)) {
          const v = granted ? (sc.afterErc20 ?? sc.erc20) : sc.erc20;
          return v === null ? '0x' : abi.encode(['uint256'], [v]);
        }
        if (data.startsWith(PERMIT2_ALLOWANCE)) {
          const v = granted ? (sc.afterPermit2 ?? sc.permit2) : sc.permit2;
          if (v === null) return '0x';
          const exp = granted ? (sc.afterPermit2Expiration ?? sc.permit2Expiration)
            : sc.permit2Expiration;
          return abi.encode(['uint160', 'uint48', 'uint48'], [v, exp, 0]);
        }
        throw new Error(`unscripted eth_call ${data.slice(0, 10)}`);
      }
      if (method === 'eth_getTransactionReceipt') {
        const outcome = sc.receipts[poll] ?? 'absent';
        poll += 1;
        trace.push(`RECEIPT ${outcome}`);
        if (outcome === 'absent') return null;
        /* A mined grant is what makes the re-read succeed. */
        if (outcome === 'mined') granted = true;
        return { status: outcome === 'mined' ? '0x1' : '0x0', blockNumber: '0x64' };
      }
      throw new Error(`unscripted method ${method}`);
    },
  };
}

function makeBroadcaster(sc: Scripted, trace: Trace): Broadcaster {
  let n = 0;
  return {
    address: OWNER,
    async send(tx: UnsignedTx): Promise<string> {
      if (sc.sendThrows) {
        trace.push('SEND may-have-landed, then threw');
        throw new Error('simulated transport failure after the node may have accepted it');
      }
      n += 1;
      trace.push(`SEND ${tx.to.toLowerCase() === PERMIT2 ? 'permit2' : 'token'}`);
      return `0x${n.toString(16).padStart(64, '0')}`;
    },
  };
}

/**
 * THE INVARIANT: between any two SENDs there must be a RECEIPT.
 *
 * This is the nonce rule expressed over the trace rather than over a counter. It is what
 * distinguishes a confirmed chain of transactions from a batch that would replace itself.
 */
function orderingHolds(trace: Trace): { ok: boolean; why: string } {
  let sawSendSinceReceipt = false;
  for (const ev of trace) {
    if (ev.startsWith('SEND ')) {
      if (sawSendSinceReceipt) {
        return { ok: false,
          why: 'TWO SENDS WITH NO RECEIPT BETWEEN THEM — they would share a nonce' };
      }
      sawSendSinceReceipt = true;
    } else if (ev.startsWith('RECEIPT')) {
      sawSendSinceReceipt = false;
    }
  }
  return { ok: true, why: '' };
}

interface Case {
  name: string;
  sc: Scripted;
  live: boolean;
  amount?: bigint;
  /** 'ok' means it returned; otherwise the raise must contain this substring. */
  expect: 'ok' | string;
  /** How many SENDs must appear in the trace. */
  sends: number;
  check?: (plan: Awaited<ReturnType<typeof ensureSellReadiness>>) => string | null;
}

const NEVER_EXPIRES = 4_000_000_000;
/** The drill's injected clock, in seconds. A real epoch, so an expiry can sit behind it. */
const CLOCK_START_S = 1_780_000_000;

const CASES: Case[] = [
  {
    name: 'NO BROADCASTER -> the plan is built and NOTHING is sent',
    live: false, sends: 0, expect: 'ok',
    sc: { erc20: 0n, permit2: 0n, permit2Expiration: 0, receipts: [] },
    check: (p) => {
      if (!p.hypothetical) return 'not marked hypothetical';
      if (p.ready) return 'reported ready with no allowances';
      if (p.sent.length !== 0) return 'claims to have sent something';
      if (p.steps.filter((s) => s.verdict === 'SEND').length !== 2) {
        return 'did not plan both grants';
      }
      /* The calldata must be REAL, not a placeholder: the dry run's whole value is that
       * the path is constructed exactly as a live run would construct it. */
      if (!p.steps[0]!.tx.data.startsWith('0x095ea7b3')) return 'step 1 calldata is wrong';
      if (p.steps[1]!.tx.to.toLowerCase() !== PERMIT2) return 'step 2 is not addressed to Permit2';
      return null;
    },
  },
  {
    name: 'BOTH ALLOWANCES ALREADY COVER -> NOTHING sent, reported as SKIP',
    live: true, sends: 0, expect: 'ok',
    sc: { erc20: AMOUNT, permit2: AMOUNT, permit2Expiration: NEVER_EXPIRES, receipts: [] },
    check: (p) => {
      if (p.sent.length !== 0) return 'sent something that was already in place';
      if (!p.ready) return 'not ready despite covering allowances';
      if (p.steps.some((s) => s.verdict !== 'SKIP')) return 'did not report both as SKIP';
      return null;
    },
  },
  {
    name: 'ONLY STEP 1 SHORT -> exactly ONE send',
    live: true, sends: 1, expect: 'ok',
    sc: { erc20: 0n, permit2: AMOUNT, permit2Expiration: NEVER_EXPIRES,
      receipts: ['mined'], afterErc20: AMOUNT },
    check: (p) => (p.sent.length === 1 ? null : `sent ${p.sent.length}, expected 1`),
  },
  {
    name: 'BOTH SHORT -> TWO sends, IN ORDER, a receipt between them',
    live: true, sends: 2, expect: 'ok',
    sc: { erc20: 0n, permit2: 0n, permit2Expiration: 0,
      receipts: ['mined', 'mined'], afterErc20: AMOUNT, afterPermit2: AMOUNT,
      afterPermit2Expiration: NEVER_EXPIRES },
    check: (p) => {
      if (p.sent.length !== 2) return `sent ${p.sent.length}, expected 2`;
      if (!p.sent[0]!.label.startsWith('STEP 1')) return 'step 2 was sent first';
      return null;
    },
  },
  {
    name: 'PERMIT2 GRANT PRESENT BUT EXPIRED -> it is SENT, not skipped',
    live: true, sends: 1, expect: 'ok',
    /* The expiry must be past the DRILL'S CLOCK, which starts at a real epoch below.
     * The first version used `1` against a clock starting at 0, so the grant read as
     * unexpired and the case failed for want of a clock rather than for want of the rule. */
    sc: { erc20: AMOUNT, permit2: AMOUNT, permit2Expiration: CLOCK_START_S - 10,
      receipts: ['mined'], afterPermit2: AMOUNT,
      afterPermit2Expiration: NEVER_EXPIRES },
    check: (p) => {
      if (p.steps[1]!.verdict !== 'SEND') return 'an expired grant read as already granted';
      if (p.steps[0]!.verdict !== 'SKIP') return 'resent step 1 needlessly';
      return null;
    },
  },
  {
    name: 'STEP 1 MINED AND REVERTED -> step 2 is NOT sent',
    live: true, sends: 1, expect: 'MINED AND REVERTED',
    sc: { erc20: 0n, permit2: 0n, permit2Expiration: 0, receipts: ['reverted'] },
  },
  {
    name: 'STEP 1 NO RECEIPT -> step 2 is NOT sent (the nonce hazard)',
    live: true, sends: 1, expect: 'NO RECEIPT',
    sc: { erc20: 0n, permit2: 0n, permit2Expiration: 0,
      receipts: ['absent', 'absent', 'absent', 'absent'] },
  },
  {
    /*
     * `sends: 1` AND NOT 0, DELIBERATELY. A throw is not proof nothing was sent — a
     * transport error can arrive after the node accepted the transaction, which is exactly
     * what the raise says. Scoring it as zero sends would be the plausible-value-on-an-
     * error-path mistake inside the drill written to catch it. What matters is that
     * NOTHING FOLLOWS it, which the ordering invariant and the send count together assert.
     */
    name: 'THE BROADCAST ITSELF THROWS -> nothing further, outcome NOT established',
    live: true, sends: 1, expect: 'OUTCOME IS NOT ESTABLISHED',
    sc: { erc20: 0n, permit2: 0n, permit2Expiration: 0, receipts: [], sendThrows: true },
  },
  {
    name: 'AN UNREADABLE ALLOWANCE -> refuses WITHOUT sending (0x is not zero)',
    live: true, sends: 0, expect: 'UNKNOWN is not zero',
    sc: { erc20: null, permit2: 0n, permit2Expiration: 0, receipts: [] },
  },
  {
    name: 'AN UNREADABLE PERMIT2 ALLOWANCE -> the same refusal',
    live: true, sends: 0, expect: 'UNKNOWN is not zero',
    sc: { erc20: AMOUNT, permit2: null, permit2Expiration: 0, receipts: [] },
  },
  {
    name: 'AMOUNT ZERO -> refuses rather than approving nothing',
    live: true, sends: 0, amount: 0n, expect: 'grants nothing while reporting success',
    sc: { erc20: 0n, permit2: 0n, permit2Expiration: 0, receipts: [] },
  },
  {
    name: 'GRANTED BUT THE RE-READ STILL DOES NOT COVER -> raises',
    live: true, sends: 2, expect: 'DO NOT COVER THE POSITION AFTER GRANTING',
    sc: { erc20: 0n, permit2: 0n, permit2Expiration: 0,
      receipts: ['mined', 'mined'], afterErc20: AMOUNT, afterPermit2: 1n },
  },
];

async function main(): Promise<void> {
  let pass = 0; const failures: string[] = [];

  for (const c of CASES) {
    const trace: Trace = [];
    const rpc = makeRpc(c.sc, trace);
    const bcast = c.live ? makeBroadcaster(c.sc, trace) : null;
    let raised: string | null = null;
    let plan: Awaited<ReturnType<typeof ensureSellReadiness>> | null = null;
    try {
      plan = await ensureSellReadiness(
        {
          rpc, broadcaster: bcast,
          /* No real time anywhere: the receipt poll is driven by the script. */
          wait: async (): Promise<void> => {},
          receiptTimeoutMs: 30,
          now: ((): () => number => {
            let t = CLOCK_START_S * 1000;
            return (): number => { t += 20; return t; };
          })(),
        },
        { token: TOKEN, owner: OWNER, amount: c.amount ?? AMOUNT },
      );
    } catch (e) { raised = (e as Error).message; }

    const sends = trace.filter((t) => t.startsWith('SEND ')).length;
    const ord = orderingHolds(trace);
    const problems: string[] = [];

    if (c.expect === 'ok') {
      if (raised !== null) problems.push(`RAISED: ${raised.slice(0, 120)}`);
      else if (c.check) {
        const why = c.check(plan!);
        if (why) problems.push(why);
      }
    } else if (raised === null) {
      problems.push('DID NOT RAISE');
    } else if (!raised.includes(c.expect)) {
      problems.push(`raised the wrong thing: ${raised.slice(0, 120)}`);
    }
    if (sends !== c.sends) problems.push(`${sends} send(s), expected ${c.sends}`);
    if (!ord.ok) problems.push(ord.why);

    if (problems.length === 0) {
      pass += 1;
      log.info(`PASS  ${c.name}`, { sends, trace: trace.join(' -> ') || 'nothing' });
    } else {
      failures.push(`${c.name}: ${problems.join('; ')}`);
      log.error(`FAIL  ${c.name}`, { problems, trace: trace.join(' -> ') || 'nothing' });
    }
  }

  /*
   * THE ORDERING INVARIANT IS ALSO CHECKED AGAINST A TRACE THAT VIOLATES IT, so a pass
   * above cannot mean the checker never fires. A check nobody has made fail is not a check
   * — the standard this project applies to its own build gate.
   */
  const bad = orderingHolds(['SEND token', 'SEND permit2', 'RECEIPT mined']);
  const good = orderingHolds(['SEND token', 'RECEIPT mined', 'SEND permit2', 'RECEIPT mined']);
  if (bad.ok || !good.ok) {
    failures.push('THE ORDERING CHECKER ITSELF IS BROKEN — it accepted two consecutive '
      + 'sends, or rejected a correctly interleaved trace');
    log.error('FAIL  the ordering checker is proven able to fail', { bad, good });
  } else {
    pass += 1;
    log.info('PASS  the ordering checker is proven able to fail', {
      rejected: 'SEND -> SEND -> RECEIPT', accepted: 'SEND -> RECEIPT -> SEND -> RECEIPT',
    });
  }

  log.info('APPROVAL DRILL COMPLETE', {
    passed: pass, of: CASES.length + 1, failures,
    permit2: PERMIT2, router: UNIVERSAL_ROUTER,
    proves: 'the ORDERING and every refusal: a second transaction is never sent before the '
      + 'first has a receipt, MINED is the only outcome that continues, an unreadable '
      + 'allowance refuses without sending, and an already-granted allowance is SKIPPED',
    does_not_prove: 'signing, gas estimation, nonce derivation or the chain accepting our '
      + 'bytes — this uses a TEST DOUBLE for the broadcaster. The two real approvals of '
      + '2026-09-16 are the evidence for those.',
    wrote_to_database: 'NOTHING — this drill needs no rows, so it has none to leak',
  });
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((e) => { log.error('approval-drill failed', errorFields(e)); process.exit(1); });

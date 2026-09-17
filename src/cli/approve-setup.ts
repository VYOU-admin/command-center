/**
 * `npm run approve-setup -- --token 0x... [--amount raw] [--live --commit]`
 *
 * THE TWO SETUP TRANSACTIONS THE SELL LEG NEEDS. docs/LAUNCHBOT.md section 2 and 2B.
 *
 * Section 2 measured that a sell pulls the token through Permit2, which needs TWO grants:
 *
 *   1. ERC-20 -> Permit2      `approve(PERMIT2, amount)` on the token
 *   2. Permit2 -> router      `approve(token, ROUTER, amount, expiration)` on Permit2
 *
 * Both were measured over 40 real sells — 40 of 40 had a prior approval — and **neither
 * has ever been executed by this project**. Section 6 records that 9 of 14 dry-run exit
 * reverts were exactly this: a borrowed holder who had granted no approvals, so the exit
 * reverted for a reason that said nothing about the pool.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE CLI AND NOT PART OF THE BOT
 * ---------------------------------------------------------------------------
 *
 * So that **the first transaction this project ever signs is a bounded approval and not a
 * trade.** An approval for a stated amount to a named spender is the smallest, most
 * reversible, most inspectable thing the signing path can be pointed at; a trade commits
 * capital and depends on a quote, a rail, a pool and an exit. If the signer is wrong, this
 * is where it should be wrong.
 *
 * It is also why it lives outside `launchbot`: the bot's live loop will need these inline
 * per token, and that wiring is an OUTSTANDING PREREQUISITE in `bot/live-preflight.ts`.
 * This CLI is the one place the calldata and the allowance reads are implemented, so the
 * inline version imports it rather than growing a second copy.
 *
 * ---------------------------------------------------------------------------
 * EXACT AMOUNT, NOT UNLIMITED — AND THE MEASUREMENT CUTS THE OTHER WAY
 * ---------------------------------------------------------------------------
 *
 * Section 2 measured **46 approvals to a router for a FINITE amount against 19 to Permit2
 * for `uint256` MAX**. So unlimited is the norm for the Permit2 route specifically, which
 * is what Permit2 exists for: approve once, unlimited, and let the per-spender allowance
 * carry the bound and the expiry.
 *
 * **This approves an EXACT AMOUNT anyway, and the reason is not that the measurement is
 * wrong.** It is that the measurement describes traders whose position size is unbounded
 * and whose token set is stable. This bot's position is bounded at `MAX_POSITION_USD`
 * ($10) and **every token it touches is a launch minutes old from a launchpad it does not
 * control** — a contract nobody has read, which may have a transfer hook, a blacklist or
 * an owner-mint. An unlimited allowance to a token like that is an open-ended claim on
 * whatever balance the wallet ever holds of it, granted to a contract chosen by whoever
 * deployed the token. The cost of being wrong is bounded by the allowance, so the
 * allowance is bounded.
 *
 * **The price of that choice is stated rather than hidden**: an exact amount means one
 * pair of approvals PER TOKEN PER TRADE, which section 2 measured at $0.00751 each —
 * $0.015 per round trip, about 0.15% of a $10 position. That is inside the 1.8-1.9%
 * round-trip cost already recorded and it does not change any decision.
 *
 * ---------------------------------------------------------------------------
 * IT READS BEFORE IT WRITES, AND IT WRITES NOTHING BY DEFAULT
 * ---------------------------------------------------------------------------
 *
 * Existing allowances are read from the chain first and anything already granted is
 * SKIPPED — reported as skipped, never as done. Dry by default; `--commit` alone is not
 * enough, because broadcasting also requires `--live` and a key, neither of which exists
 * in this build. Afterwards the allowances are RE-READ from the chain, which is the
 * fresh-connection rule in its on-chain form: a transaction that was accepted is not
 * evidence the allowance is set.
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { AbiCoder, id } from 'ethers';
import { RpcClient } from '../adapters/token-updates/rpc.js';
import { BroadcastRpc, ReadOnlyRpc } from '../bot/rpc.js';
import { resolveMode } from '../bot/mode.js';
import { createBroadcaster } from '../bot/signer.js';
import { buildPermit2Approve, buildTokenApprove } from '../bot/calldata.js';
import { PERMIT2, RAILS, UNIVERSAL_ROUTER } from '../bot/config.js';
import { configuredWallet } from '../bot/wallet.js';
import { awaitReceipt } from '../bot/receipt.js';

const abi = AbiCoder.defaultAbiCoder();
const RPC_URL = 'https://robinhood-mainnet.g.alchemy.com/v2/{key}';
/* The same figures exit-exec uses, and derived there: receipt availability measured at
 * 60 of 60 on the first ask with a 36 ms maximum, against an inclusion half that could
 * not be measured without sending. These transactions are what measure it. */
const RECEIPT_TIMEOUT_MS = 60_000;
const RECEIPT_POLL_MS = 1_000;

/** Selectors COMPUTED from keccak, never transcribed. A wrong one returns `0x`. */
const ERC20_ALLOWANCE = id('allowance(address,address)').slice(0, 10);
const PERMIT2_ALLOWANCE = id('allowance(address,address,address)').slice(0, 10);

interface Read { raw: bigint | null; note: string }

/** ERC-20 `allowance(owner, PERMIT2)`. `0x` is UNKNOWN, never zero. */
async function erc20Allowance(
  rpc: ReadOnlyRpc, token: string, owner: string, spender: string,
): Promise<Read> {
  const data = ERC20_ALLOWANCE
    + owner.replace(/^0x/, '').toLowerCase().padStart(64, '0')
    + spender.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  const r = await rpc.call('eth_call', [{ to: token, data }, 'latest']);
  if (typeof r !== 'string' || r === '0x' || r === '') {
    return { raw: null, note: `allowance() returned ${JSON.stringify(r)} — UNKNOWN, `
      + 'not zero; refusing to treat an unreadable allowance as absent' };
  }
  return { raw: BigInt(r), note: 'read' };
}

/**
 * Permit2 `allowance(owner, token, spender)` -> `(uint160 amount, uint48 expiration,
 * uint48 nonce)`. The expiration is why this is not a plain ERC-20 allowance: a grant
 * that has expired reads as a non-zero amount and is worthless.
 */
async function permit2Allowance(
  rpc: ReadOnlyRpc, owner: string, token: string, spender: string,
): Promise<{ amount: bigint | null; expiration: number; note: string }> {
  const data = PERMIT2_ALLOWANCE
    + owner.replace(/^0x/, '').toLowerCase().padStart(64, '0')
    + token.replace(/^0x/, '').toLowerCase().padStart(64, '0')
    + spender.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  const r = await rpc.call('eth_call', [{ to: PERMIT2, data }, 'latest']);
  if (typeof r !== 'string' || r === '0x' || r === '') {
    return { amount: null, expiration: 0, note: `returned ${JSON.stringify(r)} — UNKNOWN` };
  }
  const [amount, expiration] = abi.decode(['uint160', 'uint48', 'uint48'], r) as
    unknown as [bigint, bigint, bigint];
  return { amount, expiration: Number(expiration), note: 'read' };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const mode = resolveMode(args, process.env);
  const commit = args.includes('--commit');

  const ti = args.indexOf('--token');
  const token = ti >= 0 ? String(args[ti + 1] ?? '').toLowerCase() : '';
  if (!/^0x[0-9a-f]{40}$/.test(token)) {
    throw new Error('--token must be a 20-byte hex address. There is nothing to approve '
      + 'without one and no default will be invented.');
  }
  const ai = args.indexOf('--amount');
  const amountArg = ai >= 0 ? String(args[ai + 1] ?? '') : '';
  if (ai >= 0 && !/^[0-9]+$/.test(amountArg)) {
    throw new Error(`--amount must be a raw integer token amount, got "${amountArg}"`);
  }

  const owner = configuredWallet();
  if (owner === null) {
    throw new Error('BOT_WALLET_ADDRESS is not set. An approval is granted BY an address, '
      + 'and this will not read an allowance for nobody.');
  }

  const app = await bootstrap();
  const key = process.env['ALCHEMY_API_KEY'];
  if (!key) throw new Error('ALCHEMY_API_KEY is not set');
  const inner = new RpcClient(RPC_URL.replace('{key}', key), 60000, 50_000);
  const rpc = new ReadOnlyRpc(inner);

  /* ---- 1. THE BALANCE DECIDES THE AMOUNT, IF NONE WAS GIVEN -------------- */
  /*
   * THE AMOUNT IS WHAT WE ACTUALLY HOLD, not the quote. The exit executor already works
   * this way — "the amount sold is the balance read from the chain, never the stored
   * quote" — and an allowance below the balance would leave part of the position
   * unsellable, which is the outcome all of this exists to avoid.
   */
  let amount: bigint;
  if (amountArg) {
    amount = BigInt(amountArg);
  } else {
    const balData = id('balanceOf(address)').slice(0, 10)
      + owner.replace(/^0x/, '').padStart(64, '0');
    const b = await rpc.call('eth_call', [{ to: token, data: balData }, 'latest']);
    if (typeof b !== 'string' || b === '0x') {
      throw new Error(`balanceOf returned ${JSON.stringify(b)} for ${token}: the balance `
        + 'is UNKNOWN, not zero, and an allowance will not be sized against an unknown.');
    }
    amount = BigInt(b);
    if (amount === 0n) {
      throw new Error(`the wallet holds NO ${token}. An approval for zero grants nothing, `
        + 'and sizing one against a zero balance would be approving a number rather than '
        + 'a position. Pass --amount explicitly to pre-approve.');
    }
  }

  /* ---- 2. READ WHAT IS ALREADY GRANTED ----------------------------------- */
  const a1 = await erc20Allowance(rpc, token, owner, PERMIT2);
  const a2 = await permit2Allowance(rpc, owner, token, UNIVERSAL_ROUTER);
  const now = Math.floor(Date.now() / 1000);
  const p2Live = a2.amount !== null && a2.amount > 0n && a2.expiration > now;

  const step1Needed = a1.raw === null ? 'UNREADABLE' : (a1.raw >= amount ? 'SKIP' : 'SEND');
  const step2Needed = a2.amount === null ? 'UNREADABLE'
    : (p2Live && a2.amount >= amount ? 'SKIP' : 'SEND');

  log.info('WHAT WILL BE APPROVED, TO WHOM, AND FOR HOW MUCH', {
    mode: mode.label, live: mode.live, commit,
    owner, token,
    amount_raw: amount.toString(),
    policy: 'EXACT AMOUNT, not unlimited — see the header. Section 2 measured 46 finite '
      + 'against 19 unlimited, and unlimited is the norm for the Permit2 route; this bot '
      + 'bounds it anyway because every token it touches is a launch minutes old from a '
      + 'contract nobody has read.',
    position_bound_usd: RAILS.MAX_POSITION_USD,
    step_1: {
      what: `${token} .approve(${PERMIT2}, ${amount})`,
      spender: PERMIT2, spender_is: 'Permit2',
      current_allowance: a1.raw === null ? a1.note : a1.raw.toString(),
      verdict: step1Needed,
    },
    step_2: {
      what: `Permit2.approve(${token}, ${UNIVERSAL_ROUTER}, ${amount}, <expiry>)`,
      spender: UNIVERSAL_ROUTER, spender_is: 'the Universal Router',
      current_amount: a2.amount === null ? a2.note : a2.amount.toString(),
      current_expiration: a2.expiration,
      expired: a2.amount !== null && a2.amount > 0n && a2.expiration <= now,
      verdict: step2Needed,
      note: 'a Permit2 grant carries an EXPIRY, so a non-zero amount that has expired is '
        + 'worthless and must not read as already granted',
    },
  });

  if (step1Needed === 'UNREADABLE' || step2Needed === 'UNREADABLE') {
    throw new Error('an allowance could not be read. UNKNOWN is not zero: refusing to '
      + 'send an approval against a state that could not be established.');
  }
  if (step1Needed === 'SKIP' && step2Needed === 'SKIP') {
    log.info('NOTHING TO DO — both allowances already cover this amount', {
      note: 'reported as SKIPPED, never as done. An approval that was already in place '
        + 'is a different fact from one this run granted.',
    });
    await app.pool.end(); process.exit(0);
  }

  if (!commit) {
    log.info('DRY RUN — NOTHING SENT', {
      note: 'pass --commit AND --live to broadcast; both are required and a key must '
        + 'exist, which it does not in this build',
      would_send: [step1Needed === 'SEND' ? 'step 1 (token -> Permit2)' : null,
        step2Needed === 'SEND' ? 'step 2 (Permit2 -> router)' : null].filter(Boolean),
    });
    await app.pool.end(); process.exit(0);
  }

  /* ---- 3. THE BROADCAST, WHICH CANNOT HAPPEN IN THIS BUILD --------------- */
  /*
   * `createBroadcaster` refuses outside live mode and refuses in live mode with no key.
   * Both refusals are exercised by `live-gate-drill`; this is the real call site and it
   * reaches the same function.
   */
  const bcast = await createBroadcaster(mode, rpc);
  const sender = new BroadcastRpc(inner, mode);
  const sent: string[] = [];

  /*
   * EACH STEP IS CONFIRMED BEFORE THE NEXT IS SENT, AND THAT IS NOT CAUTION FOR ITS OWN
   * SAKE — IT IS A NONCE HAZARD.
   *
   * `signer.send` reads the nonce per transaction as `'pending'`, deliberately, so a
   * replaced container cannot reuse one. On a node that does not track the mempool,
   * `'pending'` equals `'latest'` — and then sending step 2 before step 1 is mined gives
   * BOTH THE SAME NONCE, so the second either replaces the first or is refused as a
   * duplicate. Step 1 would silently never happen while the run reported two broadcasts.
   *
   * So: send, wait for the receipt, and only continue if it MINED. The wait is
   * `bot/receipt.ts`, shared with `exit-exec` rather than copied.
   */
  const send = async (label: string, tx: { to: string; data: string; value: bigint;
    description: string }): Promise<void> => {
    const hash = await bcast.send({ to: tx.to, data: tx.data, value: tx.value,
      description: tx.description });
    log.warn(`${label} BROADCAST`, { hash, what: tx.description });
    const rec = await awaitReceipt(rpc, hash, {
      timeoutMs: RECEIPT_TIMEOUT_MS, pollMs: RECEIPT_POLL_MS,
    });
    log.info(`${label} RECEIPT`, {
      hash, outcome: rec.outcome, block: rec.blockNumber,
      receipt_wait_ms: rec.waitMs, receipt_polls: rec.polls,
      note: 'the first real measurement of the inclusion half of the receipt wait — '
        + 'receipt-timing could only measure availability, because nothing could send',
    });
    sent.push(`${label} ${hash} ${rec.outcome} in block ${rec.blockNumber ?? '?'} `
      + `after ${rec.waitMs} ms / ${rec.polls} polls`);
    if (rec.outcome === 'reverted') {
      throw new Error(`${label} was MINED AND REVERTED (${hash}). Nothing further is `
        + 'sent: the allowance is not in place and a second transaction would be built '
        + 'against a state that does not exist.');
    }
    if (rec.outcome === 'unknown') {
      throw new Error(`${label} produced NO RECEIPT in ${rec.waitMs} ms (${hash}). It may `
        + 'still land, so NOTHING FURTHER IS SENT — a second transaction now could reuse '
        + 'its nonce and replace it. Read the allowances from the chain before retrying.');
    }
  };

  if (step1Needed === 'SEND') await send('STEP 1 token -> Permit2', buildTokenApprove(token, amount));
  if (step2Needed === 'SEND') {
    await send('STEP 2 Permit2 -> router',
      buildPermit2Approve(token, amount, now + 3600));
  }
  void sender;

  /* ---- 4. VERIFY BY RE-READING THE CHAIN --------------------------------- */
  /*
   * A transaction the node accepted is not an allowance that is set. This is the
   * fresh-connection rule in its on-chain form, and it is the same reason
   * `wallet_transactions` is re-counted after a write.
   */
  const v1 = await erc20Allowance(rpc, token, owner, PERMIT2);
  const v2 = await permit2Allowance(rpc, owner, token, UNIVERSAL_ROUTER);
  log.info('VERIFIED BY RE-READING THE CHAIN', {
    sent,
    step_1_allowance_now: v1.raw === null ? v1.note : v1.raw.toString(),
    step_2_amount_now: v2.amount === null ? v2.note : v2.amount.toString(),
    step_2_expiration_now: v2.expiration,
    covers_the_amount: v1.raw !== null && v2.amount !== null
      && v1.raw >= amount && v2.amount >= amount,
  });
  if (!(v1.raw !== null && v2.amount !== null && v1.raw >= amount && v2.amount >= amount)) {
    throw new Error('the allowances do NOT cover the amount after broadcasting. The '
      + 'transactions may be pending; do not sell against this state.');
  }

  await app.pool.end();
  process.exit(0);
}

main().catch((e) => { log.error('approve-setup failed', errorFields(e)); process.exit(1); });

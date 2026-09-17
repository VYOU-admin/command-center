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
 * **THE DECIDING, GRANTING AND VERIFYING NOW LIVE IN `bot/approvals.ts` AND THIS CALLS IT.**
 * They were implemented here first and proved by the first two real transactions; when the
 * loop needed the same thing inline per token (LAUNCHBOT.md section 2D), copying them would
 * have been the NINTH recorded instance of the two-implementations trap, in the worst place
 * for it. So `ensureSellReadiness` was EXTRACTED rather than reimplemented, and this file
 * keeps only what is genuinely a CLI's: argument parsing, the balance-sizing default, and
 * the report. The loop and this tool now run the same code.
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
import { RpcClient } from '../adapters/token-updates/rpc.js';
import { BroadcastRpc, ReadOnlyRpc } from '../bot/rpc.js';
import { resolveMode } from '../bot/mode.js';
import { createBroadcaster } from '../bot/signer.js';
import { PERMIT2, RAILS, UNIVERSAL_ROUTER } from '../bot/config.js';
import { configuredWallet } from '../bot/wallet.js';
import { readTokenBalance } from '../bot/allowance.js';
import { ensureSellReadiness } from '../bot/approvals.js';

const RPC_URL = 'https://robinhood-mainnet.g.alchemy.com/v2/{key}';

/*
 * THE ALLOWANCE READS USED TO BE DUPLICATED HERE, AND THAT WAS THE WORST PLACE FOR IT.
 *
 * `bot/allowance.ts` was extracted when `exit-exec` needed these reads, with a header
 * saying that the side which GRANTS an allowance and the side which CHECKS it disagreeing
 * about sufficiency "is how a bot sells into a revert it had already been told about" —
 * and then this file, the granting side, was left on its own copy. Two implementations of
 * the rule that decides what gets approved, in a tool about to sign a real transaction.
 *
 * Found by re-reading the path before the first real signature. Both sides now call
 * `readErc20Allowance` and `readPermit2Allowance`, so the pair cannot drift.
 */

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
    /* The balance read is `bot/allowance.ts`'s too — a third copy of `balanceOf` in this
     * file would have been the same defect one function along. */
    amount = await readTokenBalance(rpc, token, owner);
    if (amount === 0n) {
      throw new Error(`the wallet holds NO ${token}. An approval for zero grants nothing, `
        + 'and sizing one against a zero balance would be approving a number rather than '
        + 'a position. Pass --amount explicitly to pre-approve.');
    }
  }

  /* ---- 2. DECIDE, REPORT, AND ONLY THEN GRANT ---------------------------- */
  /*
   * ONE CALL. `ensureSellReadiness` reads both allowances through `bot/allowance.ts`,
   * skips what already covers the amount, refuses an unreadable one, honours the Permit2
   * expiry, sends each grant and confirms its receipt before the next, and re-reads the
   * chain afterwards. Every one of those rules was implemented here and is now shared
   * with the live loop, which is what stops the two sides drifting.
   *
   * WITHOUT A BROADCASTER IT SENDS NOTHING and returns the plan, which is exactly what a
   * dry run of this CLI is: the real allowances read from the real contracts, the real
   * calldata built, and no key so much as looked for.
   */
  const sender = commit ? new BroadcastRpc(inner, mode) : null;
  const bcast = sender === null ? null : await createBroadcaster(mode, sender);

  const plan = await ensureSellReadiness(
    { rpc, broadcaster: bcast }, { token, owner, amount });

  log.info('WHAT WAS APPROVED, TO WHOM, AND FOR HOW MUCH', {
    mode: mode.label, live: mode.live, commit,
    owner, token,
    amount_raw: amount.toString(),
    amount_from: amountArg ? '--amount, supplied' : 'the BALANCE read from the chain',
    policy: 'EXACT AMOUNT, not unlimited — see the header. Section 2 measured 46 finite '
      + 'against 19 unlimited, and unlimited is the norm for the Permit2 route; this bot '
      + 'bounds it anyway because every token it touches is a launch minutes old from a '
      + 'contract nobody has read.',
    position_bound_usd: RAILS.MAX_POSITION_USD,
    permit2: PERMIT2, router: UNIVERSAL_ROUTER,
    steps: plan.steps.map((st) => ({
      what: st.tx.description, verdict: st.verdict, current_allowance: st.current,
    })),
    sent: plan.sent.length === 0 ? 'NOTHING SENT' : plan.sent,
    ready: plan.ready,
    hypothetical: plan.hypothetical,
    note: plan.hypothetical
      ? 'DRY RUN — the allowances were READ from the chain and the calldata BUILT; pass '
        + '--commit AND --live to broadcast. A SKIP is reported as skipped, never as done.'
      : 'the allowances were re-read from the chain after granting; a transaction the node '
        + 'accepted is not an allowance that is set',
  });

  await app.pool.end();
  process.exit(0);
}

main().catch((e) => { log.error('approve-setup failed', errorFields(e)); process.exit(1); });

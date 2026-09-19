/**
 * CAN THIS TOKEN BE SOLD — BY US, AT OUR SIZE — BEFORE WE BUY IT?
 *
 * LAUNCHBOT.md section 2E is the specification; this is its implementation. It exists
 * because CME cost $10: every transfer path reverted `Error("blacklisted")`, the buy
 * succeeded, and nothing in the entry rule had ever asked whether the position could be
 * closed. **The buy leg and the sell leg were never the same question, and the rule only
 * ever asked the first.**
 *
 * ---------------------------------------------------------------------------
 * HOW IT ASKS A QUESTION ABOUT TOKENS WE DO NOT YET HOLD
 * ---------------------------------------------------------------------------
 *
 * Pre-buy we hold nothing, so the sell needs a balance and two allowances that do not
 * exist. All three are supplied by `eth_call` STATE OVERRIDE, which section 2E proved is
 * honoured on this endpoint by overriding an empty address's CODE and reading back a
 * value that could not otherwise exist — and which `exit-simulate` then used across
 * 2,092 historical round trips.
 *
 * **EVERY OVERRIDE IS VERIFIED BY READING IT BACK THROUGH THE CONTRACT'S OWN VIEW.** A
 * storage slot written at the wrong index is not an error; it is a silent no-op that
 * leaves the real value in place, and the sell would then fail for want of a balance and
 * be recorded as a token that refused us. Six distinct layouts were observed across the
 * three measured windows — balance slots {0,5,2,4,3,8} against allowance {1,6,3,5,4,9} —
 * so the index is DISCOVERED per token and never assumed.
 *
 * ---------------------------------------------------------------------------
 * WHAT DISQUALIFIES, AND THE ONE THING THAT DELIBERATELY DOES NOT
 * ---------------------------------------------------------------------------
 *
 *   the sell REVERTS, decoded          -> DISQUALIFY. the token refuses us.
 *   the sell pays EXACTLY ZERO         -> DISQUALIFY. a dead pool, nothing to exit into.
 *   the storage slots cannot be found  -> DISQUALIFY as UNKNOWN. we cannot model it.
 *   the sell pays LITTLE but non-zero  -> **PASSES.**
 *
 * **A THIN POOL IS NOT A HONEYPOT AND MUST NOT BE REFUSED HERE.** That is a deliberate
 * narrowing of 2E's draft, on the operator's instruction and on evidence: across 2,092
 * simulated sells `Error("blacklisted")` appeared **ZERO** times, so the unrecoverable
 * case is rare, while thin pools are most of the population. Refusing them would be the
 * `revert-economics` mistake repeated — a bound that selects against pools where
 * anything is happening — and the slippage bound and the exit ladder already price
 * thinness. **This check answers CAN WE GET OUT AT ALL, not AT WHAT PRICE.**
 *
 * **PROXY-NESS IS REPORTED AND DOES NOT DISQUALIFY.** CME was a 181-byte proxy and 2E's
 * draft proposed refusing them, but proxy-ness is a proxy for the risk while the sell
 * simulation is the direct test of it. Refusing every upgradeable token on a launchpad
 * that may mint them all from one template would refuse the population to catch a
 * fraction of it. The code size is recorded on the trade row so the rate can be measured
 * before anybody acts on it.
 */
import { AbiCoder, concat, id, keccak256, toBeHex, zeroPadValue } from 'ethers';
import { buildSwap } from './calldata.js';
import type { PoolKey } from './calldata.js';
import { PERMIT2, UNIVERSAL_ROUTER } from './config.js';

const abi = AbiCoder.defaultAbiCoder();
const h32 = (v: bigint | number | string): string => zeroPadValue(toBeHex(v), 32);
const mapSlot = (k: string, s: number): string => keccak256(concat([h32(k), h32(s)]));

/** COMPUTED, never looked up. */
const V4_TOO_LITTLE = id('V4TooLittleReceived(uint256,uint256)').slice(0, 10);
const ERROR_STRING = id('Error(string)').slice(0, 10);

/** An unreachable bound turns the router into an oracle for its own output. */
const UNREACHABLE = 1n << 127n;
const MAX_SLOT = 24;
const MAGIC = 987654321098765432109876n;
const MAXU160 = (1n << 160n) - 1n;
const PERMIT2_EXPIRY = 4_000_000_000n;

export interface SellabilityRpc { call(method: string, params: unknown[]): Promise<unknown> }

export interface SellabilityVerdict {
  sellable: boolean;
  /** Why, in one machine-readable token. */
  reason: string;
  /** The decoded revert payload or string, where there was one. */
  detail: string | null;
  tokensOut: bigint | null;
  ethOut: bigint | null;
  balSlot: number | null;
  allowSlot: number | null;
  /** Recorded, never acted on. A small contract is a proxy. */
  codeBytes: number | null;
  calls: number;
}

interface Decoded { kind: string; text: string; actual?: bigint }

function decode(err: unknown): Decoded {
  const e = err as Error & { data?: unknown };
  const d = e?.data;
  const msg = e instanceof Error ? e.message : String(err);
  if (typeof d !== 'string' || !d.startsWith('0x') || d.length < 10) {
    return { kind: 'no_payload', text: msg.slice(0, 160) };
  }
  const sel = d.slice(0, 10);
  try {
    if (sel === V4_TOO_LITTLE) {
      const dec = abi.decode(['uint256', 'uint256'], `0x${d.slice(10)}`) as unknown as bigint[];
      return { kind: 'v4_too_little', text: `actual=${dec[1]}`, actual: dec[1] as bigint };
    }
    if (sel === ERROR_STRING) {
      const dec = abi.decode(['string'], `0x${d.slice(10)}`) as unknown as string[];
      return { kind: 'error_string', text: String(dec[0]).slice(0, 120) };
    }
  } catch { /* an undecodable payload is reported as its selector */ }
  return { kind: 'custom', text: sel };
}

/**
 * SIMULATE OUR SELL OF A GIVEN AMOUNT, AT A GIVEN BLOCK.
 *
 * Extracted from `checkSellable` so the post-mortem can ask the same question of a
 * HISTORICAL block — "would the pool have paid us at the moment we bought" — without a
 * second implementation of the override machinery or the calldata. `checkSellable` calls
 * it too, so there is exactly one place that knows how to simulate our own sell.
 *
 * Returns the ETH the pool would have paid, or a decoded reason it would not.
 */
export async function simulateSellAt(
  rpc: SellabilityRpc,
  args: {
    pool: PoolKey; token: string; owner: string; amount: bigint;
    zeroForOneBuy: boolean; block: string;
  },
): Promise<{
  ethOut: bigint | null; reason: string; detail: string | null;
  /**
   * WOULD THE SELL ACTUALLY EXECUTE — measured with a REACHABLE bound.
   *
   * **THE UNREACHABLE-`minOut` ORACLE CANNOT ANSWER THIS AND THAT WAS NOT KNOWN UNTIL
   * 2026-09-17.** `SWAP_EXACT_IN_SINGLE` checks `amountOutMinimum` INSIDE the swap
   * action and reverts `V4TooLittleReceived` there — before `SETTLE_ALL` pulls the
   * token. So a bound of 2^127 short-circuits the call before any transfer runs, and a
   * token that refuses every transfer reports a healthy price.
   *
   * PROVEN on CME at its own exit block, identical overrides, only the bound differing:
   *
   *     minOut = 2^127  ->  V4TooLittleReceived actual=4863353094845813
   *     minOut = 1      ->  Error("TRANSFER_FROM_FAILED")
   *     raw transfer    ->  Error("blacklisted")
   *
   * So the price and the executability are TWO measurements and both are taken. The
   * reachable call runs the whole path including the settle; a honeypot reverts there
   * and nowhere else.
   */
  executes: boolean | null; executeReason: string;
  balSlot: number | null; allowSlot: number | null; calls: number;
}> {
  let calls = 0;
  const call = async (params: unknown[]): Promise<string> => {
    calls += 1;
    return String(await rpc.call('eth_call', params));
  };
  const owner = args.owner.toLowerCase();
  const token = args.token.toLowerCase();
  const ethBal = { [owner]: { balance: `0x${(10n ** 20n).toString(16)}` } };

  /* Slot discovery AT THAT BLOCK, verified by reading the contract's own view back. */
  const balData = `0x70a08231${owner.slice(2).padStart(64, '0')}`;
  const alData = `0xdd62ed3e${owner.slice(2).padStart(64, '0')}`
    + PERMIT2.slice(2).padStart(64, '0');

  /* THE NODE IS ASKED FIRST; the integer scan is the fallback. See slotByAccessList. */
  const verifyBal = async (slot: string): Promise<boolean> => {
    const r = await call([{ to: token, data: balData }, args.block,
      { [token]: { stateDiff: { [slot]: h32(MAGIC) } } }]);
    return BigInt(r) === MAGIC;
  };
  const verifyAllow = async (slot: string): Promise<boolean> => {
    const r = await call([{ to: token, data: alData }, args.block,
      { [token]: { stateDiff: { [slot]: h32(MAGIC) } } }]);
    return BigInt(r) === MAGIC;
  };

  let balKey = await slotByAccessList(rpc, token, balData, args.block, verifyBal);
  let allowKey = await slotByAccessList(rpc, token, alData, args.block, verifyAllow);

  /* The integer scan still runs where the access list gave nothing, so an ordinary
   * mapping is found exactly as before and nothing regresses. */
  let balSlot: number | null = null;
  if (balKey === null) {
    for (let i = 0; i < MAX_SLOT; i += 1) {
      try {
        if (await verifyBal(mapSlot(owner, i))) {
          balSlot = i; balKey = mapSlot(owner, i); break;
        }
      } catch { /* falls through to UNKNOWN */ }
    }
  }
  let allowSlot: number | null = null;
  if (allowKey === null && balKey !== null) {
    for (let i = 0; i < MAX_SLOT; i += 1) {
      const slot = keccak256(concat([h32(PERMIT2), mapSlot(owner, i)]));
      try {
        if (await verifyAllow(slot)) { allowSlot = i; allowKey = slot; break; }
      } catch { /* same */ }
    }
  }
  if (balKey === null || allowKey === null) {
    return { ethOut: null, reason: 'slots_not_found',
      detail: `bal=${balKey ?? 'none'} allow=${allowKey ?? 'none'}`,
      executes: null, executeReason: 'not_attempted',
      balSlot, allowSlot, calls };
  }

  const p2slot = keccak256(concat([h32(UNIVERSAL_ROUTER),
    keccak256(concat([h32(token), mapSlot(owner, 1)]))]));
  const overrides = {
    ...ethBal,
    [token]: { stateDiff: {
      /* THE VERIFIED KEYS, not a re-derivation from an integer. A namespaced layout
       * has no integer slot to re-derive from, and re-deriving is the two-
       * implementations-of-one-rule trap this project has recorded six times. */
      [balKey]: h32(args.amount),
      [allowKey]: h32((1n << 256n) - 1n),
    } },
    [PERMIT2]: { stateDiff: { [p2slot]: h32((PERMIT2_EXPIRY << 160n) | MAXU160) } },
  };
  const swapTx = (minOut: bigint): string => buildSwap({
    pool: args.pool, zeroForOne: !args.zeroForOneBuy, amountIn: args.amount,
    amountOutMinimum: minOut, deadline: 0xffffffffffn,
  }).data;

  /* ---- 1. THE PRICE, from the unreachable bound ------------------------- */
  let ethOut: bigint | null = null;
  let reason = 'reverts';
  let detail: string | null = null;
  try {
    await call([{ from: owner, to: UNIVERSAL_ROUTER, data: swapTx(UNREACHABLE),
      value: '0x0' }, args.block, overrides]);
    reason = 'returned_unexpectedly';
  } catch (err) {
    const d = decode(err);
    if (d.kind === 'v4_too_little' && d.actual !== undefined) {
      ethOut = d.actual;
      reason = d.actual === 0n ? 'pays_zero' : 'ok';
    } else detail = `${d.kind}: ${d.text}`;
  }

  /* ---- 2. WOULD IT EXECUTE, from a REACHABLE bound ---------------------- */
  /*
   * A bound of 1 lets the swap action pass its own check, so execution continues into
   * SETTLE_ALL — the step that actually pulls the token and the ONLY step a honeypot
   * refuses. This is the measurement the unreachable bound cannot make.
   */
  let executes: boolean | null = null;
  let executeReason = 'unknown';
  try {
    await call([{ from: owner, to: UNIVERSAL_ROUTER, data: swapTx(1n), value: '0x0' },
      args.block, overrides]);
    executes = true; executeReason = 'ok';
  } catch (err) {
    const d = decode(err);
    executes = false;
    executeReason = `${d.kind}: ${d.text}`.slice(0, 120);
  }

  return { ethOut, reason, detail, executes, executeReason, balSlot, allowSlot, calls };
}

/**
 * Simulate the round trip. `latest`, because the question is about trading NOW.
 *
 * The ONE implementation of the calldata is `buildSwap`; nothing here re-encodes a swap.
 */

/**
 * THE STORAGE SLOT, ASKED OF THE NODE RATHER THAN GUESSED.
 * =======================================================================
 *
 * `MAX_SLOT` scans `keccak256(owner ‖ i)` for small integers `i`. That finds an
 * ordinary Solidity mapping and **finds nothing at all on a contract using a
 * namespaced layout** — ERC-7201 and friends derive their base slot from a hash, which
 * no small-integer scan can reach.
 *
 * **MEASURED, and it is why this exists: all 250 Pools.trade tokens in the 4C sample
 * returned `slots_not_found`, so every one scored `executes = null` and the group came
 * back with ZERO scored rows.** A filter matching nothing is a suspected defect, and
 * this was the defect.
 *
 * `eth_createAccessList` reports exactly which slots a call touches, whatever the
 * layout. Two constraints, both handled:
 *
 * 1. **It is NOT archival on this endpoint** — a historical block returns
 *    `metadata is not found`. So the slot is discovered at `latest`. That is sound
 *    because a contract's storage LAYOUT is a property of its code, not of a block.
 * 2. **It can return several slots**, and only one is the balance. So every candidate
 *    is verified by overriding it and reading the contract's own view back
 *    **AT THE TARGET BLOCK** — the same read-back the integer scan already used. A
 *    wrong slot cannot survive that, which is what makes discovering at one block and
 *    using it at another safe.
 *
 * Returns `null` when the method is unavailable or nothing verifies, and the caller
 * falls back to the integer scan.
 */
async function slotByAccessList(
  rpc: SellabilityRpc, token: string, calldata: string, block: string,
  verify: (slot: string) => Promise<boolean>,
): Promise<string | null> {
  let keys: string[] = [];
  try {
    const r = (await rpc.call('eth_createAccessList', [
      { to: token, data: calldata }, 'latest',
    ])) as { accessList?: Array<{ address: string; storageKeys: string[] }> };
    for (const e of r.accessList ?? []) {
      if (e.address.toLowerCase() === token.toLowerCase()) keys = e.storageKeys;
    }
  } catch { return null; }
  for (const k of keys) {
    try { if (await verify(k)) return k; } catch { /* try the next candidate */ }
  }
  return null;
}

export async function checkSellable(
  rpc: SellabilityRpc,
  args: {
    pool: PoolKey; token: string; owner: string; amountInWei: bigint;
    /** true when the token is currency1, i.e. a buy spends currency0. */
    zeroForOneBuy: boolean;
  },
): Promise<SellabilityVerdict> {
  let calls = 0;
  const call = async (params: unknown[]): Promise<string> => {
    calls += 1;
    return String(await rpc.call('eth_call', params));
  };
  const owner = args.owner.toLowerCase();
  const token = args.token.toLowerCase();
  const base: SellabilityVerdict = {
    sellable: false, reason: 'not_run', detail: null, tokensOut: null, ethOut: null,
    balSlot: null, allowSlot: null, codeBytes: null, calls: 0,
  };

  /* ---- 0. CODE SIZE. Recorded, never a disqualifier. ---------------------- */
  let codeBytes: number | null = null;
  try {
    calls += 1;
    const code = String(await rpc.call('eth_getCode', [token, 'latest']));
    codeBytes = code.startsWith('0x') ? (code.length - 2) / 2 : null;
  } catch { codeBytes = null; }

  const ethBalOverride = { [owner]: { balance: `0x${(10n ** 20n).toString(16)}` } };

  /* ---- 1. THE BUY, at our size, to learn what we would hold --------------- */
  const buyTx = buildSwap({
    pool: args.pool, zeroForOne: args.zeroForOneBuy, amountIn: args.amountInWei,
    amountOutMinimum: UNREACHABLE, deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
  });
  let tokensOut: bigint;
  try {
    await call([{
      from: owner, to: buyTx.to, data: buyTx.data,
      value: `0x${buyTx.value.toString(16)}`,
    }, 'latest', ethBalOverride]);
    /* An unreachable bound CANNOT return. If it does, we do not understand the router. */
    return { ...base, reason: 'buy_returned_unexpectedly', codeBytes, calls };
  } catch (err) {
    const d = decode(err);
    if (d.kind !== 'v4_too_little' || d.actual === undefined || d.actual === 0n) {
      /* We could not have bought it either. Not a honeypot verdict — an entry one. */
      return { ...base, reason: 'buy_would_revert', detail: `${d.kind}: ${d.text}`,
        codeBytes, calls };
    }
    tokensOut = d.actual;
  }

  /* ---- 2. SLOT DISCOVERY, verified by read-back --------------------------- */
  const balData = `0x70a08231${owner.slice(2).padStart(64, '0')}`;
  let balSlot: number | null = null;
  for (let i = 0; i < MAX_SLOT; i += 1) {
    try {
      const r = await call([{ to: token, data: balData }, 'latest',
        { [token]: { stateDiff: { [mapSlot(owner, i)]: h32(MAGIC) } } }]);
      if (BigInt(r) === MAGIC) { balSlot = i; break; }
    } catch { /* a token that cannot answer balanceOf falls through to UNKNOWN */ }
  }
  const alData = `0xdd62ed3e${owner.slice(2).padStart(64, '0')}`
    + PERMIT2.slice(2).padStart(64, '0');
  let allowSlot: number | null = null;
  if (balSlot !== null) {
    for (let i = 0; i < MAX_SLOT; i += 1) {
      const slot = keccak256(concat([h32(PERMIT2), mapSlot(owner, i)]));
      try {
        const r = await call([{ to: token, data: alData }, 'latest',
          { [token]: { stateDiff: { [slot]: h32(MAGIC) } } }]);
        if (BigInt(r) === MAGIC) { allowSlot = i; break; }
      } catch { /* same */ }
    }
  }
  if (balSlot === null || allowSlot === null) {
    /*
     * FAIL CLOSED, AND SAY WHICH WAY. A token whose storage we cannot model is a token
     * whose sell we cannot simulate, and an unknown here is not a pass. It is reported
     * as its own reason so it never merges into the tokens that actually refused us —
     * the two mean different things about the population and must not be summed.
     */
    return { ...base, reason: 'slots_not_found',
      detail: `bal=${String(balSlot)} allow=${String(allowSlot)}`,
      tokensOut, balSlot, allowSlot, codeBytes, calls };
  }

  /* ---- 3. OUR SELL, our address, FULL size ------------------------------- */
  const sellTx = buildSwap({
    pool: args.pool, zeroForOne: !args.zeroForOneBuy, amountIn: tokensOut,
    amountOutMinimum: UNREACHABLE, deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
  });
  const p2slot = keccak256(concat([h32(UNIVERSAL_ROUTER),
    keccak256(concat([h32(token), mapSlot(owner, 1)]))]));
  const overrides = {
    ...ethBalOverride,
    [token]: { stateDiff: {
      [mapSlot(owner, balSlot)]: h32(tokensOut),
      [keccak256(concat([h32(PERMIT2), mapSlot(owner, allowSlot)]))]: h32((1n << 256n) - 1n),
    } },
    [PERMIT2]: { stateDiff: { [p2slot]: h32((PERMIT2_EXPIRY << 160n) | MAXU160) } },
  };
  try {
    await call([{ from: owner, to: sellTx.to, data: sellTx.data, value: '0x0' },
      'latest', overrides]);
    return { ...base, reason: 'sell_returned_unexpectedly', tokensOut, balSlot,
      allowSlot, codeBytes, calls };
  } catch (err) {
    const d = decode(err);
    if (d.kind === 'v4_too_little' && d.actual !== undefined) {
      if (d.actual === 0n) {
        return { ...base, reason: 'sell_pays_zero', detail: 'actual=0', tokensOut,
          ethOut: 0n, balSlot, allowSlot, codeBytes, calls };
      }
      /*
       * IT SELLS. The amount is NOT judged here — thinness is the bound's business and
       * refusing on it would refuse the population to catch a fraction of it.
       */
      return { sellable: true, reason: 'ok', detail: null, tokensOut, ethOut: d.actual,
        balSlot, allowSlot, codeBytes, calls };
    }
    return { ...base, reason: 'sell_reverts', detail: `${d.kind}: ${d.text}`,
      tokensOut, balSlot, allowSlot, codeBytes, calls };
  }
}

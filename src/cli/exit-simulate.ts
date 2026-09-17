/**
 * `npm run exit-simulate` — WOULD *OUR* SELL HAVE EXECUTED, AT OUR SIZE, AT OUR HORIZON?
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS: `realised-backtest` LEFT A BRACKET IT COULD NOT CLOSE
 * ---------------------------------------------------------------------------
 *
 * That binary inferred our exit from whether SOMEBODY ELSE sold after the horizon.
 * Bounded to the bot's real 10 s ladder the recent-era median came out at 0.000; allowed
 * to wait 300 s for another trader it came out at +0.21..+0.30. **Neither is the
 * question.** The absence of somebody else's sell is not proof that we could not sell —
 * we would have been the seller — and waiting for one is not the strategy.
 *
 * This replaces the inference with a simulation of OUR OWN round trip:
 *
 *     BUY   at first_swap + 150  (+15 s), our address, our size, at that block
 *     SELL  at first_swap + 1050 (+90 s), our address, the tokens the buy produced
 *
 * ---------------------------------------------------------------------------
 * THE ORACLE: AN UNREACHABLE BOUND MAKES THE ROUTER REPORT ITS OWN OUTPUT
 * ---------------------------------------------------------------------------
 *
 * `V4TooLittleReceived(uint256,uint256)` carries `(minAmountOutReceived, amountReceived)`.
 * Setting `amountOutMinimum` to 2^127 therefore turns a 26-CU `eth_call` into an exact
 * read of what the swap would have paid, at our size and at that block, **with no
 * modelling anywhere.** The selector is COMPUTED by keccak, never looked up —
 * `ROBINHOOD.md` records a fabricated hash shipping here once.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS ALREADY INSIDE THE NUMBER, SO IT IS NOT SUBTRACTED TWICE
 * ---------------------------------------------------------------------------
 *
 * The router's reported output is what the POOL would actually have paid. It is
 * therefore **already net of the LP fee on that leg and already net of our own price
 * impact at our own size.** Subtracting section 1's measured slippage or the fee tier
 * on top of these figures would double-count both. **The only cost left to take off is
 * GAS**, which is charged in ETH outside the swap.
 *
 * That is also why BOTH position sizes are run rather than one scaled: impact is the
 * only term that differs between $10 and $5, and it is the term the router prices for us.
 *
 * ---------------------------------------------------------------------------
 * THE THREE OVERRIDES, AND WHY EACH IS VERIFIED RATHER THAN ASSUMED
 * ---------------------------------------------------------------------------
 *
 * Pre-buy we hold nothing, so the sell needs a balance and two allowances. All three are
 * supplied by `eth_call` state override, which section 2E proved is honoured on this
 * endpoint by overriding an empty address's CODE and reading back a value that can only
 * exist if the override applied.
 *
 *   1. our ETH balance          — a plain `balance` override, no slot needed
 *   2. the token balance        — slot DISCOVERED, verified by reading `balanceOf` back
 *   3. the token -> Permit2 allowance — slot DISCOVERED, verified by reading `allowance` back
 *   4. the Permit2 -> router allowance — slot 1, the canonical layout, verified once per run
 *
 * **THE ETH BALANCE IS OVERRIDDEN DELIBERATELY.** Our wallet's real balance at a block
 * in 2026-08 is a fact about the operator's spending, not about the pool. Leaving it
 * unoverridden would make the measurement depend on our own transaction history.
 *
 * **A STORAGE SLOT WRITTEN AT THE WRONG INDEX IS NOT AN ERROR — IT IS A SILENT NO-OP.**
 * The real value stays, the sell then fails for want of a balance, and it would be
 * recorded as a pool that would not pay. So each index is probed with a magic value and
 * the contract is asked what it now believes; a token where no index reads back is
 * recorded as SLOTS_NOT_FOUND and counted separately, never folded into the failures.
 *
 * ---------------------------------------------------------------------------
 * WHAT EACH OUTCOME MEANS, STATED BEFORE THE RUN
 * ---------------------------------------------------------------------------
 *
 *   buy reverts        -> we could never have entered. Return 0: no position, no loss.
 *   sell reverts       -> a FAILED EXIT. Return -1.0, with the reason DECODED.
 *   sell pays 0        -> a failed exit. Return -1.0.
 *   slots not found    -> UNKNOWN. Counted on its own line and never silently merged.
 *
 * Every revert reason is decoded: `Error(string)` unwrapped, and four-byte custom
 * selectors matched against a keccak-computed table. A bare `execution reverted` with no
 * payload is recorded as exactly that — a failure we cannot name is not one to ignore.
 */
import { ethers } from 'ethers';
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { RpcClient, RpcError } from '../adapters/token-updates/rpc.js';
import { buildSwap } from '../bot/calldata.js';

const RPC_URL = 'https://robinhood-mainnet.g.alchemy.com/v2/{key}';
const PRICING = [
  '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
  '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
  '0x0000000000000000000000000000000000000000',
];
const NATIVE = '0x0000000000000000000000000000000000000000';
const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3';
const UNIVERSAL_ROUTER = '0x8876789976decbfcbbbe364623c63652db8c0904';

/** 0.1 s per block, measured. */
const BPS = 10;
const ENTRY_OFF = 15 * BPS;
const HOLD = 90 * BPS;          // EXIT_DELAY_BLOCKS as the bot ships it
const RULE_FEES = [500, 10000];
const GAP_MIN = 11;
const GAP_MAX = 600;
const SIZES_USD = [10, 5];

/** The corpus era is the anomaly; these are the three the operator asked for. */
const WINDOWS = [
  { name: 'MIDPOINT', from: 52200000, to: 53200000 },
  { name: 'CALM', from: 60700000, to: 61700000 },
  { name: 'SELLOFF', from: 63216393, to: 64216393 },
];

/** Set BEFORE the first request, per the standing rule. */
const CU_CEILING = 600_000;
const MAX_SLOT = 24;
const CONCURRENCY = 8;

const abi = ethers.AbiCoder.defaultAbiCoder();
const h32 = (v: bigint | number | string): string =>
  ethers.zeroPadValue(ethers.toBeHex(v), 32);
const mapSlot = (k: string, s: number): string =>
  ethers.keccak256(ethers.concat([h32(k), h32(s)]));

/** COMPUTED, never looked up. */
const SEL = {
  v4TooLittle: ethers.id('V4TooLittleReceived(uint256,uint256)').slice(0, 10),
  errorString: ethers.id('Error(string)').slice(0, 10),
  allowanceExpired: ethers.id('AllowanceExpired(uint256)').slice(0, 10),
  panic: ethers.id('Panic(uint256)').slice(0, 10),
  deadline: ethers.id('TransactionDeadlinePassed()').slice(0, 10),
} as const;

interface Decoded { kind: string; reason: string; actual?: bigint }

function decodeRevert(err: unknown): Decoded {
  const data = err instanceof RpcError ? err.data : undefined;
  const msg = err instanceof Error ? err.message : String(err);
  if (typeof data !== 'string' || !data.startsWith('0x') || data.length < 10) {
    /* NO PAYLOAD. Recorded as exactly that -- never guessed at. */
    return { kind: 'no_payload', reason: msg.slice(0, 180) };
  }
  const sel = data.slice(0, 10);
  const body = `0x${data.slice(10)}`;
  try {
    if (sel === SEL.v4TooLittle) {
      const dec = abi.decode(['uint256', 'uint256'], body) as unknown as bigint[];
      const actual = dec[1] as bigint;
      return { kind: 'v4_too_little', reason: `actual=${actual}`, actual };
    }
    if (sel === SEL.errorString) {
      const dec = abi.decode(['string'], body) as unknown as string[];
      return { kind: 'error_string', reason: String(dec[0]).slice(0, 120) };
    }
    if (sel === SEL.allowanceExpired) return { kind: 'allowance_expired', reason: sel };
    if (sel === SEL.panic) return { kind: 'panic', reason: sel };
    if (sel === SEL.deadline) return { kind: 'deadline_passed', reason: sel };
  } catch { /* fall through: an undecodable payload is reported as its selector */ }
  return { kind: 'custom', reason: sel };
}

interface Launch {
  pool_id: string; currency0: string; currency1: string;
  fee: number; tick_spacing: number; hooks: string; first_swap: number;
}

async function main(): Promise<void> {
  const key = process.env['ALCHEMY_API_KEY'];
  if (!key) throw new Error('ALCHEMY_API_KEY is not set');
  const app = await bootstrap();
  const c = await app.pool.connect();
  const rpc = new RpcClient(RPC_URL.replace('{key}', key), 60000, CU_CEILING);
  const t0 = Date.now();

  /* THE ADDRESS IS OURS, READ FROM THE ENVIRONMENT, NEVER TYPED HERE. */
  const US = (process.env['BOT_WALLET_ADDRESS'] ?? '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(US)) {
    throw new Error('BOT_WALLET_ADDRESS must be set: the whole point is OUR address');
  }

  const ethCall = async (
    tx: Record<string, unknown>, block: number, overrides?: unknown,
  ): Promise<string> => {
    const params: unknown[] = [tx, `0x${block.toString(16)}`];
    if (overrides) params.push(overrides);
    return String(await rpc.raw('eth_call', params));
  };

  try {
    await c.query('set statement_timeout = 0');
    await c.query(`create table if not exists bot_exit_sim (
      window_name text not null, pool_id text not null, size_usd numeric not null,
      token text, first_swap bigint, entry_block bigint, exit_block bigint,
      amount_in_wei numeric, tokens_out numeric, eth_out numeric,
      buy_status text, buy_reason text, sell_status text, sell_reason text,
      bal_slot int, allow_slot int, eth_usd numeric,
      primary key (window_name, pool_id, size_usd))`);

    /*
     * THE PERMIT2 LAYOUT IS VERIFIED ONCE PER RUN, NOT ASSUMED PER TOKEN.
     * Permit2 is one canonical contract, so its allowance mapping sits at a fixed slot;
     * reading it back through its own view is what turns that from a claim into a fact.
     */
    const probeTok = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
    const p2slot = ethers.keccak256(ethers.concat([h32(UNIVERSAL_ROUTER),
      ethers.keccak256(ethers.concat([h32(probeTok), mapSlot(US, 1)]))]));
    const MAXU160 = (1n << 160n) - 1n;
    const packed = (4000000000n << 160n) | MAXU160;
    const p2read = `0x927da105${US.slice(2).padStart(64, '0')}`
      + `${probeTok.slice(2).padStart(64, '0')}${UNIVERSAL_ROUTER.slice(2).padStart(64, '0')}`;
    const head = await rpc.blockNumber();
    const p2got = await ethCall({ to: PERMIT2, data: p2read }, head,
      { [PERMIT2]: { stateDiff: { [p2slot]: h32(packed) } } });
    const p2ok = BigInt(`0x${p2got.slice(2, 66)}`) === MAXU160;
    log.info('PERMIT2 SLOT 1, READ BACK THROUGH ITS OWN allowance()',
      { verified: p2ok, at_block: head });
    if (!p2ok) throw new Error('Permit2 slot 1 did not read back: refusing to simulate');

    /* Slots already seen, tried first. A launchpad template shares one layout. */
    const seenBal: number[] = [];
    const seenAllow: number[] = [];
    const order = (seen: number[]): number[] => {
      const rest: number[] = [];
      for (let i = 0; i < MAX_SLOT; i++) if (!seen.includes(i)) rest.push(i);
      return [...seen, ...rest];
    };

    for (const w of WINDOWS) {
      const lr = await c.query<Launch>(`
        select i.pool_id, i.currency0, i.currency1, i.fee::int, i.tick_spacing::int,
               i.hooks, f.fb::bigint as first_swap
          from v4_pool_init i
          join (select pool_id, min(block_number) fb from v4_swaps_all
                 where block_number between ${w.from} and ${w.to} group by 1) f
            on f.pool_id = i.pool_id
         where i.block_number between ${w.from} and ${w.to}
           and ((i.currency0 = any($1)) <> (i.currency1 = any($1)))
           and i.fee = any($2)
           and (f.fb - i.block_number) between ${GAP_MIN} and ${GAP_MAX}
           and f.fb + ${ENTRY_OFF + HOLD} <= ${w.to}
         order by i.pool_id`, [PRICING, RULE_FEES]);
      const launches = lr.rows.map((r) => ({ ...r, first_swap: Number(r.first_swap) }));

      const pr = await c.query(`select percentile_cont(0.5) within group (order by eth_usd) p
        from native_usd_prices where chain='robinhood' and block_number between $1 and $2`,
      [w.from, w.to]);
      const ethUsd = Number(pr.rows[0]?.p);
      if (!Number.isFinite(ethUsd) || ethUsd <= 0) {
        throw new Error(`${w.name}: no ETH/USD in range -- refusing to size a position`);
      }
      const sizes = SIZES_USD.map((usd) => ({
        usd, wei: BigInt(Math.round((usd / ethUsd) * 1e18)),
      }));

      log.info(`${w.name} WORK SET, BEFORE THE FIRST PAID CALL`, {
        rule_launches: launches.length, eth_usd: ethUsd.toFixed(2),
        sizes: sizes.map((s) => `$${s.usd}=${s.wei}wei`),
        calls_if_every_slot_hits_first: launches.length * (2 * SIZES_USD.length + 2),
        calls_worst_case: launches.length * (2 * SIZES_USD.length + 2 * MAX_SLOT),
        cu_spent_so_far: rpc.cuSpent, ceiling: CU_CEILING,
      });

      let done = 0;
      const runOne = async (l: Launch): Promise<void> => {
        const entry = l.first_swap + ENTRY_OFF;
        const exit = entry + HOLD;
        const tokenIsC1 = !PRICING.includes(l.currency0.toLowerCase())
          ? false : true;
        /* The token is the side that is NOT a pricing asset. */
        const token = PRICING.includes(l.currency0.toLowerCase())
          ? l.currency1 : l.currency0;
        const zeroForOneBuy = PRICING.includes(l.currency0.toLowerCase());
        const pool = {
          currency0: l.currency0, currency1: l.currency1, fee: l.fee,
          tickSpacing: l.tick_spacing, hooks: l.hooks,
        };
        void tokenIsC1;

        const row: Record<string, unknown> = {
          window_name: w.name, pool_id: l.pool_id, token,
          first_swap: l.first_swap, entry_block: entry, exit_block: exit,
          eth_usd: ethUsd, bal_slot: null, allow_slot: null,
        };

        /* ---- 1. THE BUY, at the entry block, at each size ---- */
        const bought = new Map<number, bigint>();
        const buyFail = new Map<number, Decoded>();
        for (const s of sizes) {
          const tx = buildSwap({
            pool, zeroForOne: zeroForOneBuy, amountIn: s.wei,
            amountOutMinimum: (1n << 127n), deadline: 0xffffffffffn,
          });
          try {
            await ethCall({
              from: US, to: tx.to, data: tx.data, value: `0x${tx.value.toString(16)}`,
            }, entry, { [US]: { balance: `0x${(10n ** 18n).toString(16)}` } });
            /* An unreachable bound CANNOT return. If it does, something is wrong. */
            buyFail.set(s.usd, { kind: 'returned_unexpectedly', reason: 'no revert' });
          } catch (err) {
            const d = decodeRevert(err);
            if (d.kind === 'v4_too_little' && d.actual && d.actual > 0n) {
              bought.set(s.usd, d.actual);
            } else buyFail.set(s.usd, d);
          }
        }

        /* ---- 2. SLOT DISCOVERY, only if a buy produced tokens ---- */
        let balSlot: number | null = null;
        let allowSlot: number | null = null;
        if (bought.size > 0) {
          const MAGIC = 987654321098765432109876n;
          const balData = `0x70a08231${US.slice(2).padStart(64, '0')}`;
          for (const i of order(seenBal)) {
            try {
              const r = await ethCall({ to: token, data: balData }, exit,
                { [token]: { stateDiff: { [mapSlot(US, i)]: h32(MAGIC) } } });
              if (BigInt(r) === MAGIC) { balSlot = i; break; }
            } catch { /* a token that cannot answer balanceOf is handled below */ }
          }
          const alData = `0xdd62ed3e${US.slice(2).padStart(64, '0')}`
            + PERMIT2.slice(2).padStart(64, '0');
          if (balSlot !== null) {
            for (const i of order(seenAllow)) {
              const slot = ethers.keccak256(ethers.concat([h32(PERMIT2), mapSlot(US, i)]));
              try {
                const r = await ethCall({ to: token, data: alData }, exit,
                  { [token]: { stateDiff: { [slot]: h32(MAGIC) } } });
                if (BigInt(r) === MAGIC) { allowSlot = i; break; }
              } catch { /* same */ }
            }
          }
          if (balSlot !== null && !seenBal.includes(balSlot)) seenBal.push(balSlot);
          if (allowSlot !== null && !seenAllow.includes(allowSlot)) seenAllow.push(allowSlot);
        }
        row['bal_slot'] = balSlot;
        row['allow_slot'] = allowSlot;

        /* ---- 3. THE SELL, at the exit block, from OUR address, at FULL size ---- */
        for (const s of sizes) {
          const r: Record<string, unknown> = { ...row, size_usd: s.usd, amount_in_wei: s.wei.toString() };
          const tok = bought.get(s.usd);
          if (tok === undefined) {
            const d = buyFail.get(s.usd);
            r['buy_status'] = 'reverted';
            r['buy_reason'] = `${d?.kind}: ${d?.reason ?? ''}`.slice(0, 200);
            r['sell_status'] = 'not_attempted';
            r['sell_reason'] = 'the buy could not have executed';
          } else if (balSlot === null || allowSlot === null) {
            r['buy_status'] = 'ok'; r['tokens_out'] = tok.toString();
            r['sell_status'] = 'slots_not_found';
            r['sell_reason'] = `bal=${String(balSlot)} allow=${String(allowSlot)}`;
          } else {
            r['buy_status'] = 'ok'; r['tokens_out'] = tok.toString();
            const p2s = ethers.keccak256(ethers.concat([h32(UNIVERSAL_ROUTER),
              ethers.keccak256(ethers.concat([h32(token), mapSlot(US, 1)]))]));
            const alSlotKey = ethers.keccak256(
              ethers.concat([h32(PERMIT2), mapSlot(US, allowSlot)]));
            const tx = buildSwap({
              pool, zeroForOne: !zeroForOneBuy, amountIn: tok,
              amountOutMinimum: (1n << 127n), deadline: 0xffffffffffn,
            });
            const ov = {
              [US]: { balance: `0x${(10n ** 18n).toString(16)}` },
              [token]: { stateDiff: {
                [mapSlot(US, balSlot)]: h32(tok),
                [alSlotKey]: h32((1n << 256n) - 1n),
              } },
              [PERMIT2]: { stateDiff: { [p2s]: h32(packed) } },
            };
            try {
              await ethCall({ from: US, to: tx.to, data: tx.data, value: '0x0' }, exit, ov);
              r['sell_status'] = 'returned_unexpectedly';
              r['sell_reason'] = 'an unreachable bound returned';
            } catch (err) {
              const d = decodeRevert(err);
              if (d.kind === 'v4_too_little' && d.actual !== undefined) {
                r['sell_status'] = d.actual > 0n ? 'ok' : 'pays_zero';
                r['eth_out'] = d.actual.toString();
                r['sell_reason'] = null;
              } else {
                r['sell_status'] = 'reverted';
                r['sell_reason'] = `${d.kind}: ${d.reason}`.slice(0, 200);
              }
            }
          }
          await c.query(`insert into bot_exit_sim
            (window_name,pool_id,size_usd,token,first_swap,entry_block,exit_block,
             amount_in_wei,tokens_out,eth_out,buy_status,buy_reason,sell_status,sell_reason,
             bal_slot,allow_slot,eth_usd)
            values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
            on conflict (window_name,pool_id,size_usd) do update set
              tokens_out=excluded.tokens_out, eth_out=excluded.eth_out,
              buy_status=excluded.buy_status, buy_reason=excluded.buy_reason,
              sell_status=excluded.sell_status, sell_reason=excluded.sell_reason,
              bal_slot=excluded.bal_slot, allow_slot=excluded.allow_slot`,
          [w.name, l.pool_id, s.usd, token, l.first_swap, entry, exit,
            r['amount_in_wei'], r['tokens_out'] ?? null, r['eth_out'] ?? null,
            r['buy_status'], r['buy_reason'] ?? null, r['sell_status'],
            r['sell_reason'] ?? null, balSlot, allowSlot, ethUsd]);
        }
        done += 1;
        if (done % 50 === 0) {
          log.info(`${w.name} progress`, {
            done, of: launches.length, cu: rpc.cuSpent,
            slots_seen: { bal: seenBal, allow: seenAllow },
            elapsed_s: ((Date.now() - t0) / 1000).toFixed(0),
          });
        }
      };

      /* A small worker pool: 15.3 calls/s at concurrency 8, measured, 0 refusals. */
      let idx = 0;
      const worker = async (): Promise<void> => {
        for (;;) {
          const i = idx; idx += 1;
          if (i >= launches.length) return;
          const l = launches[i];
          if (!l) return;
          try { await runOne(l); } catch (err) {
            log.error('launch failed', { pool: l.pool_id, ...errorFields(err) });
            throw err;
          }
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

      log.info(`${w.name} COMPLETE`, {
        launches: launches.length, cu_spent: rpc.cuSpent,
        slots_seen: { bal: seenBal, allow: seenAllow },
      });
    }

    log.info('TOTAL RPC', { cu_spent: rpc.cuSpent, ceiling: CU_CEILING,
      wall_clock_s: ((Date.now() - t0) / 1000).toFixed(0) });
  } catch (err) {
    log.error('exit-simulate failed', { ...errorFields(err), cu_spent: rpc.cuSpent });
    process.exitCode = 1;
  } finally {
    c.release();
    await app.pool.end();
  }
}

void main();

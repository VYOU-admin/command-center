/**
 * `npm run observation-window` — 3A.vii, MEASURED RATHER THAN ARGUED.
 *
 * The claim: *"Other bots wait up to 90 SECONDS observing before buying, not 15. Stated
 * tradeoff: more tape, less edge on speed."*
 *
 * **THE TRADEOFF AS STATED IS NOT THE TRADEOFF THIS CHAIN OFFERS, AND THAT IS TESTABLE.**
 * `decay-trajectory` measured all twelve live positions from their buy block outward and
 * found 11 of 12 became UNSELLABLE within 20 seconds. If that generalises, waiting 90
 * seconds does not cost "edge on speed" — it costs the ability to sell at all, which is
 * a different and much larger cost.
 *
 * Twelve positions is not a population, so this tests it on the corpus: for a sample of
 * launches, does our own sell still EXECUTE at +15 s (where we buy today) and at +90 s
 * (where the claim says to buy)?
 *
 * **BOTH POINTS ARE MEASURED ON THE SAME POOLS**, so the comparison is paired and a
 * pool that was never sellable cannot make the later window look worse than it is.
 * **A REACHABLE BOUND** is used at both, for the reason section 6A.3 exists.
 *
 * WHAT WOULD PROVE THE CONCLUSION WRONG: a sellable share at +90 s that is the same as
 * at +15 s. That would mean the decay measured on the twelve live positions is peculiar
 * to them and the observation window is genuinely free.
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { RpcClient } from '../adapters/token-updates/rpc.js';
import { ReadOnlyRpc } from '../bot/rpc.js';
import { simulateSellAt } from '../bot/sellability.js';
import { poolIdOf } from '../bot/pool-state.js';

const CHAIN = 'robinhood';
const RPC_URL = 'https://robinhood-mainnet.g.alchemy.com/v2/{key}';
const CU_CEILING = 400_000;
/** ROBINHOOD.md section 3: ~0.1 s per block, measured over 935,564 blocks. */
const BLOCKS_PER_SECOND = 10;
const SAMPLE = 150;

async function main(): Promise<void> {
  const key = process.env['ALCHEMY_API_KEY'];
  if (!key) throw new Error('ALCHEMY_API_KEY is not set');
  const owner = process.env['BOT_WALLET_ADDRESS']?.trim().toLowerCase();
  if (!owner) throw new Error('BOT_WALLET_ADDRESS must be set');
  const app = await bootstrap();
  const c = await app.pool.connect();
  const inner = new RpcClient(RPC_URL.replace('{key}', key), 60_000, CU_CEILING);
  const rpc = new ReadOnlyRpc(inner);

  try {
    /* A DETERMINISTIC sample -- `order by pool_id` rather than random, so the run is
     * reproducible and a second pass measures the same pools. */
    const rows = (await c.query<{
      pool_id: string; token: string; first_swap: string; tokens_out: string;
      amount_in_wei: string; fee: number; tick_spacing: number; hooks: string;
      currency0: string; currency1: string; window_name: string;
    }>(
      `select e.pool_id, lower(e.token) as token, e.first_swap::text,
              e.tokens_out::text, e.amount_in_wei::text,
              i.fee::int, i.tick_spacing::int, i.hooks,
              lower(i.currency0) as currency0, lower(i.currency1) as currency1,
              e.window_name
         from bot_exit_sim e
         join v4_pool_init i on i.chain = $1 and i.pool_id = e.pool_id
        where e.size_usd::numeric = 10 and e.buy_status = 'ok'
          and e.tokens_out is not null
        order by e.pool_id limit $2`, [CHAIN, SAMPLE])).rows;

    log.info('BEFORE THE FIRST PAID CALL', {
      sample: rows.length,
      points_per_pool: 2,
      estimate_cu: rows.length * 2 * 20 * 26,
      ceiling_cu: CU_CEILING,
    });

    let ok15 = 0; let ok90 = 0; let both = 0; let unread = 0;
    let diedBetween = 0;
    const examples: string[] = [];

    for (const r of rows) {
      const pool = {
        currency0: r.currency0, currency1: r.currency1,
        fee: r.fee, tickSpacing: r.tick_spacing, hooks: r.hooks,
      };
      if (poolIdOf(pool).toLowerCase() !== r.pool_id.toLowerCase()) continue;
      const first = Number(r.first_swap);
      const at = async (secs: number): Promise<boolean | null> => {
        try {
          const s = await simulateSellAt(rpc, {
            pool, token: r.token, owner, amount: BigInt(r.tokens_out),
            zeroForOneBuy: !(r.token === r.currency0),
            block: `0x${(first + secs * BLOCKS_PER_SECOND).toString(16)}`,
          });
          return s.executes;
        } catch { return null; }
      };
      const a = await at(15);
      const b = await at(90);
      if (a === null || b === null) { unread += 1; continue; }
      if (a) ok15 += 1;
      if (b) ok90 += 1;
      if (a && b) both += 1;
      if (a && !b) {
        diedBetween += 1;
        if (examples.length < 8) {
          examples.push(`${r.window_name} ${r.pool_id.slice(0, 18)} token=${r.token.slice(0, 12)} `
            + `sellable at +15s, NOT at +90s`);
        }
      }
    }

    const n = rows.length - unread;
    const p = (x: number): string => n === 0 ? 'n/a' : `${(100 * x / n).toFixed(1)}%`;
    log.info('3A.vii  DOES A 90-SECOND OBSERVATION WINDOW COST SPEED, OR THE SELL?', {
      sampled: rows.length,
      probe_unreadable_EXCLUDED: unread,
      measured_on: n,
      sellable_at_PLUS_15s_where_we_buy_today: `${ok15} (${p(ok15)})`,
      sellable_at_PLUS_90s_where_the_claim_says_to_buy: `${ok90} (${p(ok90)})`,
      sellable_at_BOTH: `${both} (${p(both)})`,
      SELLABLE_AT_15_BUT_DEAD_BY_90: `${diedBetween} (${p(diedBetween)})`,
      what_would_refute_the_conclusion:
        'the two shares being equal — that would mean the decay seen on the twelve '
        + 'live positions is peculiar to them and the observation window is free',
      examples,
      cu: inner.cuSpent,
    });
  } finally { c.release(); await app.pool.end(); }
}

void main().catch((e: unknown) => { log.error('observation-window failed', errorFields(e)); process.exit(1); });

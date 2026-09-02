/**
 * Solana token balance readings, and the token's price and market cap.
 *
 * MIRRORS token-balance-scan's CONTRACT, not its mechanics. Same guarantees:
 * append-only, a failed read is never written as zero, a wallet that was not
 * attempted gets no row. What differs is forced by the chain, not chosen.
 *
 * ONE getProgramAccounts CALL, NOT DERIVED ATAs. Deliberate, and it is the more
 * correct read as well as the cheaper one:
 *   - MOS is TOKEN-2022, not the legacy SPL Token program. Measured: filtering
 *     the legacy program returns 0 accounts. Token-2022 ATAs derive against a
 *     different program id, so ATA math aimed at the wrong program would have
 *     produced addresses that simply do not exist and reported every wallet as
 *     no_account.
 *   - Token-2022 accounts carry extensions, so they are NOT all 165 bytes.
 *     Measured: a dataSize:165 filter returns 21 accounts; dropping it returns
 *     6,154. A size filter would have silently hidden 99.7% of holders.
 *   - A wallet may hold the mint in more than one token account. ATA-only
 *     derivation reads one and would understate the rest as though the balance
 *     were smaller, not as though it were unknown.
 * Measured cost: 6,154 accounts in one call, 0.2 s. Deriving 854 ATAs would
 * have been 9 getMultipleAccounts calls and still wrong on all three counts.
 *
 * NO CURSOR, DELIBERATELY. One call covers every wallet, so there is nothing to
 * resume. A cursor here would be machinery with no work to do.
 *
 * withContext:true so the SLOT comes back with the data. Reading the slot in a
 * second call would stamp the rows with a moment that is not the moment they
 * describe.
 */
import type { AdapterContext, SourceAdapter } from './types.js';
import { requireString } from './types.js';
import type { PoolClient } from '../store/db.js';
import { migrate } from './solana-balance-scan/schema.js';
import { compare, renderChangeAlert, type Comparison } from './solana-balance-scan/changes.js';

interface Reading {
  wallet: string; balanceRaw: string | null; status: string; accounts: number;
}
interface RunResult {
  token: string; chain: string; mint: string; slot: number; readAt: Date;
  readings: Reading[];
  price: { usd: number | null; supply: number | null; pair: string | null };
  decimals: number | null;
  comparison: Comparison | null;
  parts: string[];
  stats: Record<string, number | string | null>;
}

const num = (o: Record<string, unknown>, k: string, d: number): number => {
  const v = o[k]; return typeof v === 'number' && Number.isFinite(v) ? v : d;
};

const adapter: SourceAdapter<RunResult> = {
  type: 'solana-balance-scan',
  validate(o, id) {
    requireString(o, 'token', id);
    requireString(o, 'mint', id);
    requireString(o, 'token_program', id);
    requireString(o, 'rpc_url', id);
    requireString(o, 'dexscreener_pair', id);
  },
  migrate,

  async fetch(ctx: AdapterContext): Promise<RunResult[]> {
    const o = ctx.options;
    const token = String(o.token), mint = String(o.mint);
    const url = String(o.rpc_url), prog = String(o.token_program);
    const started = Date.now();
    let requests = 0;

    // ---- every token account for this mint, in one call -------------------
    requests++;
    const res = await fetch(url, { method: 'POST', signal: ctx.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getProgramAccounts',
        params: [prog, { encoding: 'jsonParsed', withContext: true,
          filters: [{ memcmp: { offset: 0, bytes: mint } }] }] }) });
    if (!res.ok) throw new Error(`getProgramAccounts HTTP ${res.status}`);
    const body = await res.json() as { result?: { context?: { slot?: number }; value?: unknown[] };
      error?: { message?: string } };
    if (body.error) throw new Error(`getProgramAccounts: ${body.error.message}`);
    const slot = Number(body.result?.context?.slot);
    const accounts = (body.result?.value ?? []) as Record<string, unknown>[];
    if (!Number.isFinite(slot)) throw new Error('no slot in getProgramAccounts context');
    // AN EMPTY RESULT IS NOT A ZERO BALANCE FOR EVERYONE. If the mint filter
    // returns nothing the read has failed in a way that would otherwise write
    // 854 confident no_account rows, so refuse rather than record it.
    if (!accounts.length) throw new Error(`getProgramAccounts returned 0 accounts for ${mint}`);

    let decimals: number | null = null;
    const byOwner = new Map<string, { amount: bigint; n: number }>();
    for (const a of accounts) {
      const info = ((a.account as Record<string, unknown>)?.data as Record<string, unknown>)
        ?.parsed as Record<string, unknown> | undefined;
      const i = info?.info as Record<string, unknown> | undefined;
      if (!i?.owner) continue;
      const ta = i.tokenAmount as Record<string, unknown> | undefined;
      if (decimals === null && ta?.decimals !== undefined) decimals = Number(ta.decimals);
      const amt = BigInt(String(ta?.amount ?? '0'));
      const e = byOwner.get(String(i.owner));
      if (e) { e.amount += amt; e.n++; } else byOwner.set(String(i.owner), { amount: amt, n: 1 });
    }

    // ---- the wallets we track, read as-is: base58 is case-sensitive -------
    const ws = await ctx.db.query(
      `select wallet from wallet_pnl where token = $1 and chain = 'solana' order by wallet`, [token]);
    const wallets = (ws.rows as Record<string, unknown>[]).map((r) => String(r.wallet));
    if (!wallets.length) throw new Error(`no wallets in wallet_pnl for token ${token}`);

    let okNonZero = 0, okZero = 0, noAccount = 0;
    const readings: Reading[] = wallets.map((w) => {
      const e = byOwner.get(w);
      if (e === undefined) { noAccount++; return { wallet: w, balanceRaw: null, status: 'no_account', accounts: 0 }; }
      if (e.amount === 0n) okZero++; else okNonZero++;
      return { wallet: w, balanceRaw: e.amount.toString(), status: 'ok', accounts: e.n };
    });

    // ---- price and market cap, same pass ----------------------------------
    // Robinhood tokens have NO refresh cadence: price_usd there is a snapshot
    // written once by the pipeline loader. This is a real hourly reading, which
    // is a deliberate difference rather than a mirror of that.
    let price: RunResult['price'] = { usd: null, supply: null, pair: null };
    try {
      requests++;
      const dr = await fetch(
        `https://api.dexscreener.com/latest/dex/pairs/solana/${String(o.dexscreener_pair)}`,
        { signal: ctx.signal });
      if (dr.ok) {
        const dj = await dr.json() as { pairs?: Record<string, unknown>[]; pair?: Record<string, unknown> };
        const p = dj.pairs?.[0] ?? dj.pair;
        if (p) {
          const usd = Number(p.priceUsd);
          const fdv = Number(p.fdv);
          price = { usd: Number.isFinite(usd) ? usd : null,
            // supply implied by the venue's own fdv, not a second source to
            // disagree with. Null rather than 0 when either side is missing.
            supply: Number.isFinite(fdv) && Number.isFinite(usd) && usd > 0 ? fdv / usd : null,
            pair: String(p.pairAddress ?? '') || null };
        }
      }
    } catch { /* a price miss must not lose the balances; left null, never 0 */ }

    // ---- Group 1 balance changes against the previous scan ---------------
    // Groups live in mos_wallet_groups, this monitor's own table. Wallets are
    // read as-is: base58 is case-sensitive.
    let comparison: Comparison | null = null;
    let parts: string[] = [];
    const g1rows = await ctx.db.query(
      `select wallet from mos_wallet_groups where token = $1 and group_no = 1 order by wallet`, [token]);
    const group1 = (g1rows.rows as Record<string, unknown>[]).map((r) => String(r.wallet));
    if (group1.length) {
      // The latest row per wallet from BEFORE this pass. distinct on + order by
      // scanned_at desc gives the previous reading; this pass has not been
      // written yet, so nothing here can compare a reading against itself.
      const pr = await ctx.db.query(
        `select distinct on (wallet) wallet, balance_raw::text balance_raw, status
           from solana_balance_scans where token = $1
          order by wallet, scanned_at desc`, [token]);
      const previous = new Map((pr.rows as Record<string, unknown>[]).map((r) => [String(r.wallet),
        { wallet: String(r.wallet),
          balanceRaw: r.balance_raw == null ? null : String(r.balance_raw),
          status: String(r.status) }]));
      const bq = await ctx.db.query(
        `select wallet, tokens_bought from wallet_pnl where token = $1 and chain = 'solana'`, [token]);
      const bought = new Map((bq.rows as Record<string, unknown>[]).map((r) =>
        [String(r.wallet), Number(r.tokens_bought ?? 0)]));
      const curMap = new Map(readings.map((r) => [r.wallet, r]));
      comparison = compare(group1, curMap, previous, bought, Math.pow(10, decimals ?? 9));
      parts = renderChangeAlert(comparison);
      ctx.log.info('group1 balance changes', { group1: comparison.group1,
        compared: comparison.compared, changed: comparison.changed,
        unchanged: comparison.unchanged, noPrior: comparison.noPrior,
        accountClosed: comparison.accountClosed, parts: parts.length });
    }

    const readAt = new Date();
    ctx.log.info('solana balance scan', { token, mint, slot, accountsSeen: accounts.length,
      owners: byOwner.size, wallets: wallets.length, okNonZero, okZero, noAccount,
      priceUsd: price.usd, supply: price.supply, requests, durationMs: Date.now() - started });

    return [{ token, chain: 'solana', mint, slot, readAt, readings, price, decimals,
      comparison, parts,
      stats: { accountsSeen: accounts.length, wallets: wallets.length, okNonZero, okZero,
        noAccount, failed: 0, requests, durationMs: Date.now() - started } }];
  },

  async persist(ctx, client: PoolClient, records): Promise<number> {
    const r = records[0];
    if (!r) return 0;
    let n = 0;
    for (let i = 0; i < r.readings.length; i += 200) {
      const b = r.readings.slice(i, i + 200);
      // APPEND ONLY: plain insert, no on-conflict clause anywhere.
      const res = await client.query(
        `insert into solana_balance_scans
           (token, chain, mint, wallet, slot, read_at, balance_raw, status, accounts)
         select * from unnest($1::text[],$2::text[],$3::text[],$4::text[],$5::bigint[],
                              $6::timestamptz[],$7::numeric[],$8::text[],$9::int[])`,
        [b.map(() => r.token), b.map(() => r.chain), b.map(() => r.mint),
         b.map((x) => x.wallet), b.map(() => r.slot), b.map(() => r.readAt),
         b.map((x) => x.balanceRaw), b.map((x) => x.status), b.map((x) => x.accounts)]);
      n += res.rowCount ?? 0;
    }

    // Price row. Written only when a price actually came back; a failed lookup
    // leaves the previous reading in place rather than nulling a good one.
    // Conflict target is (token, chain) -- the actual primary key. Naming just
    // (token) failed the whole persist transaction and took the 854 balance
    // rows down with it, because persist is one transaction by design.
    if (r.price.usd !== null) {
      await client.query(
        `insert into wallet_pnl_tokens (token, chain, token_address, quote_asset,
           price_usd, total_supply, price_slot, price_read_at, token_decimals, updated_at)
         values ($1,'solana',$2,'USDC',$3,$4,$5,$6,$7, now())
         on conflict (token, chain) do update set
           price_usd = excluded.price_usd, total_supply = excluded.total_supply,
           price_slot = excluded.price_slot, price_read_at = excluded.price_read_at,
           token_decimals = coalesce(excluded.token_decimals, wallet_pnl_tokens.token_decimals),
           updated_at = now()`,
        [r.token, r.mint, r.price.usd, r.price.supply, r.slot, r.readAt, r.decimals]);
    }

    await client.query(
      `insert into solana_scan_stats (ran_at, token, slot, accounts_seen, wallets,
         ok_nonzero, ok_zero, no_account, failed, price_usd, total_supply, duration_ms, requests)
       values (now(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [r.token, r.slot, r.stats.accountsSeen, r.stats.wallets, r.stats.okNonZero,
       r.stats.okZero, r.stats.noAccount, r.stats.failed, r.price.usd, r.price.supply,
       r.stats.durationMs, r.stats.requests]);

    // Queued, not sent: the spine flushes alerts after the transaction commits.
    // Nothing changed sends nothing at all -- no empty alert.
    const sendAlerts = ctx.options.send_alerts !== false;
    if (r.parts.length && sendAlerts) {
      for (const p of r.parts)
        ctx.queueAlert({ level: 'warning', title: 'MOS Group 1 balance changes', description: p });
    }
    ctx.log.info('solana balance scan written', { rows: n, priceWritten: r.price.usd !== null,
      changed: r.comparison?.changed ?? 0, alertParts: r.parts.length,
      queued: r.parts.length > 0 && sendAlerts });
    return n;
  },
};
export default adapter;

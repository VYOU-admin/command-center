# MOS (Solana) — backfill, 2026-08-31 16:00 UTC to 2026-09-02 ~20:00 UTC

Mint `4ChT49V1iazP2XUGtycGkEsS6pRMqvGfUbqvRC9Z91ZT`. Fixed window, backfill only —
nothing here runs on a schedule.

## Venue

Five MOS pools exist. One carries essentially everything:

| pair | dex | quote | liquidity | vol 24h | txns 24h |
|---|---|---|---|---|---|
| **gjL62zuUAdJm7cZhrWtnBoCGN31kSFyWHScEYfTWiWh** | **meteora DYN2** | **USDC** | **$324,365** | **$638,567** | **1,810** |
| c3LcmVLPLTR53hkj9YL6Y5W141WoAD3FdY8sMBFwK11 | meteora DLMM | SOL | $429 | $58 | 32 |
| DGEuHdW9344dQ1FWeSrafyqwKavixyxw95dnoiJ1k9Eu | meteora DLMM | SOL | $408 | $19 | 15 |
| 2BWyaXjNPxhbYAY6rfhzAH5U4YTiyipYrtuLg4UZ7rid | meteora DLMM | SOL | $120 | $10 | 2 |
| EVw13whn1d8dy1fggVFkeaeVgAWNnemFf6fMgtJM9ZDQ | orca wp | WAIFU | $0 | $0 | 59 |

**Picked the DYN2 pool: 99.7% of all MOS liquidity.** The three DLMM pools quote
$0.0000009, $0.0019 and $0.0008 on ~$400 of liquidity between them — noise, not a
second venue.

**The quote is USDC, not SOL.** CATE and CYBERLEEK both had to convert SOL to USD;
MOS does not. There is no SOL price series to source or align, and no conversion
error to carry.

## Decode path

**No Meteora code existed.** CATE was pump.fun bonding curve, CYBERLEEK was
Raydium CPMM, and `helius_recon.py` knows only the three Raydium program IDs.

**Almost none of that mattered**, because both existing decoders work from
BALANCE DELTAS rather than instruction layouts. From `cyberleek_stage1.py`:

> a transaction counts as a swap if the two vault balances moved in opposite
> directions, which is true at any call depth

So swap detection, call-depth independence (aggregators CPI into the pool),
wallet attribution via `postTokenBalances.owner` rather than the token account,
and price from the pool's own vault deltas all carried over untouched. The only
genuinely new problem was **which two accounts are the vaults**.

## Vault identification — empirical, no layout parsed

CYBERLEEK found its vaults by parsing the Raydium CPMM `PoolState` account
layout. That is venue-specific and would be silently wrong applied to a Meteora
account, so it was not used here.

Instead: over the 3,372 in-window pool transactions, count how many transactions
each MOS and USDC token account moves in. The vaults are the accounts that move
in almost all of them.

```
MOS token accounts, by transactions moved in:
  Bb8mfjRUvStYCaAKiafprpYyU4tfUKabAtfCSgp7Laam  owner HLnpSz9h2S4h…  2431
  CWUUnrjUkUU4KhtweEr3WpCgngZwBrak4YC1uACumnws  owner 511BDEyri4LK…   279
USDC token accounts:
  AT53Vqxth8RKxEBiNeJMCcuhzyiZBHDPT7bjk6TJYkiS  owner HLnpSz9h2S4h…  2829
  HrTf9CzXR1dRH4Sof5QrpmGWwpwAf3qZzwCsEjQpXcSq  owner R4rNJHaffSUo…   730
```

**The check that makes this safe rather than merely plausible: both winners share
the same owner, `HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC`** — the pool
authority. Two independently-ranked accounts landing on one owner is not
something a wrong guess produces. Decimals were read from the balances
themselves: MOS 9, USDC 6.

A swap is then any transaction where both vaults moved in **opposite**
directions. Direction follows the MOS vault: MOS out of the vault is a buy.

## What was pulled, and what was excluded

| | count |
|---|---|
| in-window pool transactions | 3,372 |
| decoded as swaps | **2,429** (1,478 buys, 951 sells) |
| touched the pool but not a swap | **610** — liquidity adds/removes and fee claims |
| swaps with no attributable wallet | **0** |
| distinct wallets trading | 854 |
| slot range | 443,192,932 .. 443,782,422 |
| time range | 2026-08-31T16:08:04Z .. 2026-09-02T19:58:20Z |

**Coverage is complete, not partial.** The pull walked back to 2026-08-31T15:31:38Z
— 28 minutes before the window opens — so no in-window slot is missing. The first
decoded trade at 16:08:04Z is simply the first swap after the window opened, not a
truncation. The 610 non-swap transactions are excluded as observations, never
counted as zero-value swaps.

For the transfer pass, 3,914 in-window transactions reference the mint; 1,149 were
not pool swaps, 407 of those carried a MOS outflow, and **336 failed transactions
were skipped rather than read as no-op transfers**.

## PnL

FIFO, matching CATE and CYBERLEEK exactly: **unsold inventory is valued at ZERO for
realized PnL** and surfaced through `tokens_still_held`. Unrealized is reported
separately at the last decoded trade price ($0.0014094 USDC per MOS) and never
folded into realized — marking to market would blend a measurement with a forecast.

One case the convention does not cover: a wallet selling more than it bought inside
the window has no in-window cost basis for the excess. That excess is **left out of
realized** rather than given a basis of zero, which would invent profit. 170 of the
854 wallets are sell-only and fall into this class.

## Groups

Own table `mos_wallet_groups`. **`wallet_groups` is not touched** — that table is
owned by `run_token.py`, which rewrites it wholesale per token.

| group | definition | wallets |
|---|---|---|
| 1 | bought, no sells, no transfers out | 267 |
| 2 | bought and sold to the pool | 406 |
| 3 | bought and transferred out | 21 |

In both 2 and 3: 10. In no group: 0. Reconciles exactly: 267 + 406 + 21 − 10 + 0 =
684 buyers.

**Limitation on Group 3.** "Transferred to a plain address" is implemented as
"MOS left this wallet in a transaction that was not a pool swap, to an owner other
than the pool authority". The destination is **not** verified to be a system-owned
wallet rather than a program account, so a transfer into some other protocol would
currently be counted as Group 3. Establishing that needs an `getAccountInfo` owner
check per destination, which was not done.

## Credits

| phase | calls | credits |
|---|---|---|
| recon and venue probes | 6 | 150 |
| pool signature census | 4 | 40 |
| pool full pull | 34 | 3,400 |
| mint signature census | 4 | 40 |
| mint full pull | 40 | 4,000 |
| **total** | **88** | **~7,630** |

**The per-call figure is an unverified constant.** `CREDITS_PER_SIGNATURES_CALL = 10`
and `credits=100` are values written into `helius_recon.py`; Helius did not report
them. I probed for confirmation and found **no credit, quota or usage headers on any
response**, and `/v0/usage`, `/v0/credits` and `/v0/health` all return
`Method not found`. So ~7,630 is arithmetic against our own prior assumption, and
current usage against the 1M/month tier **could not be read at all** — that needs
the Helius dashboard.

## Measurements that changed a decision

- **`transactionDetails: "full"` works at `limit: 100`.** `helius_recon.py` pairs
  its 100-credit constant with `limit: 20`. Using 100 made the pool pull 34 calls
  instead of ~169 — if the cost is per call, five times cheaper.
- **History depth was measured before committing.** The pool's signatures reach
  back to 2026-08-30T19:46:49Z, about 20 hours past the window start, so the fixed
  window was reachable rather than hoped for.
- **The vault owner match** turned an empirical ranking into a verified
  identification, and cost nothing.

---

# Balance scanner, price and market cap (added 2026-09-02)

Monitor `solana-balance-scan`, hourly, MOS only. It does **not** touch
`token-balance-scan`, which stays EVM-only.

## The read: one call, not derived ATAs

The brief said derive ATAs and batch `getMultipleAccounts`. Measurement changed
that, and the alternative is both cheaper and more correct:

- **MOS is TOKEN-2022**, not the legacy SPL Token program — verified by reading
  the mint account's owning program rather than assuming from the ticker.
  Filtering the legacy program returns **0 accounts**. ATA math aimed at the
  legacy program id would have produced addresses that do not exist and reported
  all 854 wallets as `no_account` — a confident, uniform, wrong answer.
- **Token-2022 accounts carry extensions and are not all 165 bytes.** A
  `dataSize:165` filter returns **21** accounts; dropping it returns **6,154**.
  A size filter would have hidden 99.7% of holders.
- **A wallet may hold the mint in more than one account.** ATA-only reads one and
  understates the rest as a *smaller balance* rather than an unknown.

`getProgramAccounts` on Token-2022, filtered only on the mint at offset 0:
**6,154–6,183 accounts in one call, 0.2–0.3 s.** `withContext: true` so the slot
arrives with the data rather than from a second call describing a different
moment.

**No cursor.** One call covers all 854 wallets; there is nothing to resume.

## Four states, stored distinctly

| state | `balance_raw` | `status` |
|---|---|---|
| read, non-zero | the amount | `ok` |
| read, genuinely zero | `0` | `ok` |
| no token account exists | `null` | `no_account` |
| read failed | `null` | the error text |
| never attempted | *no row* | — |

`no_account` has no EVM equivalent: on Solana an absent token account is a real
answer, and folding it into `0` would claim a measurement where there was none.
An empty `getProgramAccounts` result **throws** rather than writing 854 confident
`no_account` rows.

Own table `solana_balance_scans`, not a chain column on `token_balance_scans`:
that table's `block` is an EVM block number, its scope comes from `window_close`
rows MOS has none of, and every consumer of it assumes EVM semantics.

## First scan

```
slot 443,795,257   accounts seen 6,183   owners 6,171
wallets 854 = 403 ok non-zero + 340 ok zero + 111 no account + 0 failed
2 requests, 300 ms
```

Counts sum to 854. Rows carrying a balance while `status <> 'ok'`: **0**.

## Price and market cap

There is **no Robinhood cadence to mirror**: nothing in `src/adapters/` writes
`wallet_pnl_tokens.price_usd`. It is a snapshot written once by the pipeline
loader, which is why PONS still shows a price from its run. This is a genuine
hourly reading, recorded as a deliberate difference rather than a match.

`price_block` is an EVM block number and stays null for Solana. **In its place:
`price_slot` (the chain-native read point) and `price_read_at` (a timestamp, what
the card actually renders and chain-agnostic).** Both added with
`alter table ... add column if not exists`.

## Buy mcap: dropped, and why

Supply is reachable — one `getAccountInfo`, `945,568,521.071`, mint authority
revoked, and DexScreener's fdv/price implies the same within 1%. But supply at
*first-buy time* is not: burns can still reduce it, and standard RPC gives
current mint state only. Applying today's supply to a trade two days ago yields a
number that looks measured and is not. `first_buy_mcap_usd` stays null and the
column stays off the MOS page.

## Three defects this shipped through, all caught by the DOM check

1. **`ON CONFLICT (token)`** — `wallet_pnl_tokens` is keyed `(token, chain)`. The
   first run failed and, because `persist` is one transaction, took all 854
   balance rows with it. The scan itself had worked.
2. **`price_slot` / `price_read_at` mapped but not selected** — the query lists
   columns explicitly, so both were undefined and the card would have read
   `unknown` regardless of what the scanner wrote.
3. **Hardcoded `1e18`** — the page divided every raw balance by the EVM scale.
   MOS has 9 decimals, so a real 10,558,384 MOS holding became 0.0105 and printed
   as **"0"**: a wrong number wearing the shape of a right one, on the very
   column whose job is to distinguish zero from not-read. 255 of 267 group-1
   wallets rendered as zero. The scanner was correct throughout — live
   `getTokenAccountsByOwner` reads matched its stored values exactly, and the
   non-zero accounts sum to 945,705,616 against a supply of 945,568,521.
   `token_decimals` now travels with the token.

All three passed `tsc`, passed the build, and deployed green.

---

# Group 1 balance-change alert (added 2026-09-02)

Fires from `solana-balance-scan` after each hourly pass, comparing every Group 1
wallet against its previous reading in `solana_balance_scans`. Channel
`newtoken`, shared with the two new-token alerts.

## What counts as a delta, and what does not

**A delta needs two good readings.** Only a pair where BOTH sides are
`status = 'ok'` produces one.

| prior state | treatment |
|---|---|
| `ok` → `ok` | compared; a difference is a change |
| missing / failed / `no_account` prior | **noPrior** — excluded |
| `ok` → `no_account` | **accountClosed** — excluded, see below |

A missing, failed or `no_account` prior **is not a balance of zero**. Subtracting
from it would manufacture a change the size of the entire holding out of an
absence of data — on the exact table built to keep those apart.

## An account that closed is not a sale

A wallet going from a real balance to `no_account` means its token account no
longer exists. The tokens may have been sold, transferred out, or the account
emptied and closed in one instruction, and **nothing in a balance reading
distinguishes those**. Reporting it as `-full balance` would assert a movement
that has not been observed.

**Chosen: counted separately as `accountClosed` and left out of the alert.**
Confirming what actually happened needs the transfer history, which this scanner
does not read. It is reported in the run counts so it is visible rather than
silently dropped.

## Message

Header names both the token and the fact that this is a balance move, because
the two new-token alerts share this channel and announce *buys of newly launched
tokens* — a different thing entirely:

```
**MOS · GROUP 1 BALANCE CHANGES · 18 wallets**
[Ffzt…S7qu](https://solscan.io/account/Ffzt…) · bought 5,299,979 · now 8,073,051 · -2,691,017
[3xEd…WTvc](https://solscan.io/account/3xEd…) · bought 3,315,974 · now 0 · -2,000,000
```

Sorted by absolute delta, largest first. Zero changes sends **nothing** — no
empty alert. Parts split at 1,900 characters rather than truncating, the same
way the group1 new-token alert does.

## Verification

Against the 21:05 and 21:56 scans, with nothing sent:

```
group 1 total     : 267
compared          : 253   (both readings status ok)
  changed         : 18
  unchanged       : 235
no prior reading  : 12
account closed    : 2
SUM = 267 -> EXACT     compared = changed + unchanged = 253 -> consistent
message: 2 parts, 1,887 and 355 chars, both inside the 2,000 cap
```

A second run through the adapter itself (send_alerts=false) confirmed the wiring:
267 = 4 changed + 249 unchanged + 13 no prior + 1 account closed, one alert part
rendered, `queueAlert` called 0 times.

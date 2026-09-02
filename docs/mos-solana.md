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

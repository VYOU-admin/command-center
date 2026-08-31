# AI (Artificial Inu) run state — reported, NOT loaded

Nothing written to `wallet_pnl` or `wallet_clusters`. PONS, NTF, CATE and
CYBERLEEK were not touched.

## Supplied inputs

    --token           0x2E8c31162b855A2ffa90F6F8634643Ad6F111e18
    --pool            0xcbdfea90430a30ee4469c9902e120a77e7c7e4711d5643671c1d1957f2f1ce27
    --mcap-threshold  2000000
    --window-hours    4

## Tokens — decimals READ, never assumed

| | AI | NVDA |
|---|---|---|
| address | 0x2e8c…1e18 | 0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec |
| name | Artificial Inu | NVIDIA • Robinhood Token |
| **decimals** | **18** | **18** |
| venue | uniswap **v4**, PoolManager 0x8366a39c… | — |

currency0 = AI, currency1 = NVDA (address order).

## Quote pricing — the generalised step (`scripts/pipeline/quote_pricing.py`)

NTF quoted in native ETH and PONS in WETH, so both reached USD in one hop.
NVDA has no CoinGecko path, so the quote asset is now resolved by SEARCHING FOR
A ROUTE, in tiers: stablecoin -> 1.0; native/wrapped native -> ETH/USD; anything
else -> price it on-chain against a tier-0/1 asset.

**The trap this step exists to avoid:** a reference pool must PREDATE the window.
NVDA's deepest USD pool by current liquidity ($5.2M NVDA/USDG) was created
6.7 days AFTER the AI window closed. Ranking on depth alone would have priced the
window from a pool that did not yet exist. Candidates are therefore filtered on
creation time BEFORE being ranked on depth.

Chosen route: **NVDA/USDG, uniswap v3, pool 0xB944cec3…**, created 2.1 days
before the window. USDG is a USD stablecoin. **USDG decimals read as 6, not 18** —
assuming 18 would have made every NVDA price wrong by a factor of 10^12.

- granularity: 430 reference swaps pulled, 408 inside the window, **5/5 hours covered**
- NVDA moved **3.17%** across the 4h window ($209.24–$215.95), under the 5% bar
- method: **constant $212.10/NVDA**
- cross-check against an independent route (NVDA/ETH v4 -> ETH/USD): median
  $214.61 vs $212.10, **agreement 1.18%**. Reported and not refined further.

That cross-check also caught a real decoder bug: V4 `int128` amounts are ABI
sign-extended into 32-byte words and must be masked to 128 bits before the sign
test. Without the mask a negative amount decodes as ~10^60.

## Supply — reconciled, not read

totalSupply() at the first and boundary blocks, plus every mint/burn Transfer
inside the window; the two must agree.

    supply at first block  9,721,980 : 1,000,000,000
    supply at boundary     9,865,781 : 1,000,000,000
    supply-changing events in window : 0 mints, 0 burns
    reconciliation                   : AGREES exactly

Supply is flat *in this window*. It is not flat overall — the current read is
991,630,644, so ~8.4M was burned after the window closed.

## Window

| | |
|---|---|
| first swap block | 9,721,980 (2026-07-14T17:49:26Z) |
| boundary block | 9,865,781 (2026-07-14T21:49:26Z) |
| span | 143,801 blocks |
| swaps in window | 5,725 |
| unique transactions | 3,585 |
| fully covered | yes — pulled first block to boundary inclusive |

Boundary found by binary search on actual block timestamps.

## Fee — measured

    buy   1.0000%   n=2,099   median ratio 0.990000, p99 0.990000
    sell  0.0000%   n=1,457   median ratio 1.000000

A 1% token-side hook fee. p1 on buys is 0.9801 = 0.99², i.e. orders that pay the
fee twice across two hops.

## THE CIRCULAR-ARB RULE MUST BE APPLIED PER SWAP, NOT PER TRANSACTION

The V4 rule is "the PoolManager both sends and receives the token in one
transaction". On AI that fires on **2,135 of 3,585 transactions (59.6%)** because
of the 1% hook fee: the PoolManager pays the fee out to recipient addresses, one
of which immediately dumps its cut back into the pool as a second swap. 59.7% of
transactions contain exactly this buy + fee-dump pair.

Excluding whole transactions **discarded 2,122 genuine buys** and left zero
single-swap buys in the data — the tell that something was wrong.

The fix: identify ROUND-TRIPPERS — wallets that both receive from and send to the
PoolManager within one transaction — and refuse to attribute any swap to them.
There are exactly **2** such addresses on AI. The buyer in the same transaction is
untouched. 2,159 swaps (37.7%) are excluded this way; 3,566 trades survive.

## Results

- trades decoded **3,566**, wallets attributed **1,181**
- mcap at first buy: min $20,796, median $281,775, **max $459,433**
- **threshold_binding = false**: $2,000,000 admits 1,173 of 1,173 (100%); the
  ceiling is 4.4x above the highest value anyone actually bought at
- cohort **1,163** (1,173 sub-threshold buyers minus 18 excess sellers, 8 overlap)
- realized $69,116 total, median $0.00, 408 winners / 406 losers
- 97 still holding, $8,512,139 unrealized, 54.8% of it in one wallet

### Balance validation at the boundary block

| Check | Result |
|---|---|
| implied == on-chain, all wallets | 995/1,163 (85.6%) |
| wallets with a nonzero boundary balance | 360/412 (87.4%) |
| **pool-only subset** | **318/324 (98.1%)** |
| ... of those with a nonzero balance | 70/76 (92.1%) |
| mismatches having off-pool activity | 162 of 168 |

`|delta|` p50 0, p75 1.2e-10, p90 4,478, p99 87,853, max 567,397.
By attribution path: multiswap 285/349 (81.7%), multiswap+single 710/814 (87.2%).

**Caveat on `has_off_pool_activity`.** It means "had an AI transfer whose
counterparty was not the PoolManager", which includes router intermediation —
0xb92fe925… alone accounts for 1,634 transfers and 1.06B AI. It therefore
overstates genuine off-venue activity, and the pool-only subset (324) is
conservative rather than complete.

The 6 pool-only mismatches all cluster on ~1% effects consistent with hook-fee
accounting; at 0.5% of the cohort they are recorded, not chased.

## DEFECT FOUND IN ALREADY-LOADED PONS DATA

The **Uniswap V4 PoolManager `0x8366a39c…` is in the loaded PONS cohort as if it
were a trader**, holding 6,089,012 PONS = **$1,560,779, which is 19.8% of the
$7,868,329 PONS unrealized total**. Its realized PnL is $8, so realized figures
are essentially unaffected; the unrealized total is materially overstated.

PONS is a v3 pool, so the v4 PoolManager was not excluded as venue infrastructure
the way it is on a v4 run. The AI cohort is clean — PoolManager, zero address and
round-trippers are all excluded from attribution candidates.

Not corrected without instruction. The general fix is an infrastructure exclusion
list applied to every token regardless of the venue being indexed.

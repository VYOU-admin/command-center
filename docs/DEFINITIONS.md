# Definitions

What each term means, exactly, with the evidence behind it. `docs/ROBINHOOD-TOKEN-INTAKE.md`
covers *how* the work is done; this covers *what* the words mean.

This file exists because two definitions turned out to be wrong or unproven, and
both times a rebuild was nearly started on them. Every entry below states four
things: **the rule as implemented today**, **the evidence it rests on**,
**transactions that demonstrate it**, and **what would falsify it**.

Where a definition is known to be wrong, it says so at the top of the entry
rather than reading as settled.

---

## 1. Buyer

**Rule today.** A wallet is a buyer of a token in a transaction when an ERC-20
`Transfer` of that token moves *to* it and *from* an in-scope pool counterparty
— a v3 pool address, or the v4 PoolManager — inside a transaction that contains
a `Swap` event on an in-scope pool.

**It does NOT require the wallet to give up value in the same transaction.**
That is not implemented today, it has never been implemented, and it is the
single biggest open question in this file.

**Evidence.** Direction is taken from the transfer, never from the swap's sign,
because the two venues use opposite conventions. Measured on PONS across three
separate regions, unanimously:

```
          in-window    before window   after window
v3        394/394      299/299         290/290       POOL perspective
v4        164/164      294/294         154/154       SWAPPER perspective
```

**Demonstrating transactions.**

- `0x2dbe2e74f24aa04b16766d3b2911746f4c1c2d492f9899b96928122b0281f3b2`
  (block 15,257,506). `0x874fa415…` pays 661.015389 USDG to a router and
  receives 24,818.149587 PONS back from it. This **is** a buy by any reading,
  and today's rule misses it, because the wallet's counterparty is the router
  rather than the pool.
- `0x7486261e4304bc2b778420b28e31282bad8accc5c4f3b7ac80baa8f33d08e746`
  (block 21,334,470). `0x1f790b71…` receives 67.095913 PONS and gives up
  **nothing**. The USDG is paid by `0xf70da97812cb96acdf810712aa562db8dfa3dbef`,
  a plain EOA that funds this pattern repeatedly. Is that wallet a buyer?
  Economically someone bought for it. Under "gave up value in the same
  transaction" it is not.

**Measured frequency.** On 40 router-fed recipients sampled evenly across the
whole population, **2 gave up value in the same transaction and 38 did not**.
96% of those recipients are EIP-7702 delegated accounts.

**What would falsify it.** A wallet counted as a buyer that received nothing of
value; a routed buy where payer and recipient are the same address and we still
miss it; or a venue where the transfer direction disagrees with the economics.

**Open.** Whether a custodially-funded receipt into a user's own account is a
buy. This decides roughly 29,542 PONS addresses and has not been settled.

---

## 2. Seller

**Rule today.** The mirror of buyer: an ERC-20 `Transfer` of the token moves
*from* the wallet *to* an in-scope pool counterparty, inside a transaction
containing a `Swap`.

**Demonstrating transaction.**
`0x0cece371f4b494015f14c23a43cd3f52310d5d1acd03b85c33978bb22fc53170`
(block 15,115,364). `0x2aa8fc18…` sends 372.810724 PONS to the router; the
router delivers it to the PoolManager; the PoolManager pays 7.649537 USDG out,
which the router forwards to `0x4cd00e38…`. The seller and the payee are
different addresses, and the pool's transfer counterparty is the router.

**What would falsify it.** A sale where the wallet's tokens reach the pool
without a `Transfer` from the wallet — for example if v4 ERC-6909 accounting
were used instead of a token transfer.

**Known asymmetry.** Routed sells are why an aggregate over "who received the
token from a non-pool address" counted the PoolManager as a wallet: in a routed
sell the router sends the token *to* the pool. 22,904 of one router's 150,027
PONS sends went to the PoolManager.

---

## 3. Pool, and what is not a pool

**Rule today.**

- **v3**: a contract that answers both `token0()` (`0x0dfe1681`) and `token1()`
  (`0xd21220a7`). A revert is the answer "not a pool", not a failure to retry.
  Discovered from the factory's `PoolCreated` and from a flow probe.
- **v4**: a 32-byte pool id from the PoolManager's `Initialize` event. **A v4
  pool has no contract of its own at all** — the PoolManager singleton holds
  every pool's reserves — so it can never be found by probing an address, and it
  is never a transfer counterparty. The PoolManager is.

**Not a pool:** routers, aggregators, hook contracts, the token contract itself,
and the launchpad. A hook is attached *to* a pool and is not one.

**Evidence.** AI has 4,856 pools: 4,840 v4 (from `Initialize`) and 16 v3 (from
`PoolCreated`). 4,465 of the v4 pools carry a non-zero hooks address and the
PoolManager still emits its own `Swap` for every one of them — verified on three
hooked pools with 9,175, 5 and 132 Swap events, not assumed from source. No hook
emits the `Swap` topic itself.

**What would falsify it.** A swap on a pool id that never appeared in an
`Initialize` event; a v3 pool that does not answer `token0()`; or a hook that
emits swaps the PoolManager does not.

---

## 4. Router and infrastructure

**Rule today.** A hand-maintained list of 6 addresses in
`config/infrastructure.yaml`, applied at the candidate stage so an excluded
address never becomes a row. **That list is a guess, not an enumeration**, and
it has never been derived from behaviour.

**How one should be identified.** Three measurable properties together:

1. it is a deployed contract,
2. it sends the token to many distinct recipients,
3. **a high share of its sends sit inside a transaction that contains a swap.**

Property 3 is the discriminator, and it separates cleanly:

```
0xb92fe925…  36,850 recipients  150,347 sends   75.6% in a swap tx   router
0x39b38686…   2,308             95,715         88.4%                router
0xb477751b…   2,189             25,754         88.2%                router
0x8876789976  1,714             12,468         98.3%                router
0x1d4b8649…   1,558             50,387         72.5%                router
0x6a37f719…   2,181             50,303          0.0%                NOT a router
0xa1d65242…   1,444              8,613          0.0%                NOT a router
0x73991a25…   1,097              6,467          0.0%                NOT a router
```

The three at 0.0% are the control: they move volume to many wallets and are
distributors, not routers. Only two of the five real routers above are on the
list today.

**What would falsify it.** An address with a high in-swap-transaction share that
is not a router — an aggregator settling its own inventory would look similar,
and `0x000000000097266…` in transaction `0xe5643f70…` is exactly that shape.

---

## 5. Wallet versus contract — **THIS RULE IS WRONG TODAY**

**Rule today (wrong).** `eth_getCode(address, block) !== '0x'` means "contract",
and the address is excluded from the cohort.

**Correct rule.** An **EIP-7702 delegated account** has *exactly 23 bytes* of
code: `0xef0100` followed by a 20-byte delegate address. That is a **wallet** —
a user account that has delegated its execution — not a deployed contract. Any
*other* non-empty code is a deployed contract.

**Evidence, read at the head block:**

```
0x874fa415…      23 bytes  0xef010000…   delegate -> 0x0000009b1d0af20d8c6d0a44e162d11f9b8f00
0x0644cf85…      23 bytes  0xef0100e6…   delegate -> 0xcae83bde06e4c305530e199d7217f42808555b
0x0c7e8fe0…      23 bytes  0xef0100e6…   delegate -> 0xcae83bde06e4c305530e199d7217f42808555b
0x12abb130…      23 bytes  0xef0100e6…   delegate -> 0xcae83bde06e4c305530e199d7217f42808555b

v4 PoolManager   24,009 bytes  0x60a08060   deployed contract
router b92fe925   4,720 bytes  0x60806040   deployed contract
launchpad hook   25,533 bytes  0x61052060   deployed contract
PONS token        5,274 bytes  0x60806040   deployed contract
funding EOA           0 bytes               EOA
```

Three of the four delegated accounts share one delegate implementation, which is
what a wallet provider's smart-account rollout looks like.

**Impact, measured at the PONS window-end block 42,691,407.** Of 3,275
candidates excluded by the code check:

```
  811  EOA                            (excluded for some other reason)
2,001  EIP-7702 delegated account     WRONGLY EXCLUDED -- these are wallets
  463  deployed contract              correctly excluded
```

The PONS cohort would be **15,096 instead of 13,095, a 15.3% increase.**

The 811 EOAs are a caveat on that figure: an address with no code cannot have
been excluded *by a code check*, so the candidate set reconstructed here
over-includes relative to whatever the original scripts did. 2,001 is therefore
an upper estimate of the delegated accounts wrongly excluded, not an exact count.

**What would falsify it.** A 23-byte `0xef0100` address that behaves as protocol
infrastructure rather than as a user account.

---

## 6. Cohort member

**Rule today.** A wallet that (a) received the token from an in-scope pool
counterparty inside the window's blocks, (b) is not on the infrastructure list,
(c) is not a round-tripper, and (d) had **no code at the window's END block** —
not at `latest`.

**Why the end block.** An address that was an ordinary wallet when it bought is
a buyer whatever it became afterwards. Checking at `latest` cost 581 PONS
wallets to delegations adopted later, and wrongly *included* six that held a
delegation during the window and revoked it after. It was wrong in both
directions.

**Two defects, both live.**

1. **The runner's round-tripper rule is window-level, and should be
   per-transaction.** `src/intake/cohort.ts` groups by wallet across the whole
   window, so any wallet that bought and later sold is classed as a round-tripper.
   Measured on PONS: the window-level rule flags 10,389 wallets and would drop
   **8,220 of the 13,095 genuine cohort members**. The per-transaction rule flags
   512 and would drop **3**. The documented rule is per-transaction — "wallets
   that both receive from and send to the pool inside one transaction".
2. **Criterion (d) is wrong**, per definition 5.

**Reproducibility.** The scripts that selected the 13,095 no longer exist; they
lived in a scratchpad and the container recycled. `cohort.ts` is a later
reimplementation from the prose and has never run. Reconstructing the selection
does not reconcile: it yields 16,881 candidates against 13,095 tagged, with 811
code-less addresses among the excluded. **The current cohort cannot be exactly
reproduced from code that exists.**

**Verified property.** All 13,095 tagged wallets did receive PONS from a pool
inside the window. Wallets tagged without such a receipt: **0**.

---

## 7. In scope / out of scope for pricing

**Rule today.** A pool is in scope only when the counter side is a recognised
pricing asset — WETH, USDG, or native ETH — and the rule is applied **once, to
both venues**. Applying it to v3 only left PONS/NVDA and PONS/STONKBROKER in the
v4 set, pricing a memecoin against a tokenised equity through an unverified
oracle.

Decimals are read from each counter contract. **USDG has 6, not 18**; assuming
18 inflates every USDG-quoted figure by 10^12, and USDG was the counter on 238
of PONS's 381 in-scope pools.

**Known limitation.** There is no second pricing hop. A token whose main market
is against a non-pricing asset loses that market entirely rather than being
priced through it. AI is the case: its charted AI/NVDA pool is **56% of its
swaps and 59% of its window activity**, and NVDA is itself priceable on-chain
(512 NVDA pools against pricing assets, 226,454 swaps) — so the price exists and
we do not use it.

**What would falsify it.** A counter asset in the pricing set whose own USD
price is unsound; or a token where excluding non-pricing pools drops the
majority of genuine buyers, which AI demonstrates.

---

## 8. Transfer versus trade

**Transfer**: any ERC-20 `Transfer` log for the token. Neutral about intent.

**Trade**: a transfer whose counterparty is an in-scope pool, inside a
transaction containing a `Swap` on that pool. Direction from the transfer.

**"Was present in a transaction containing a swap" is not "traded."** A
transaction contains many transfers, most of them intermediate hops. That
conflation produced a wrong count of 34,744.

**Today only `buy` and `sell` are ever written.** The schema permits
`transfer_in` and `transfer_out` and **0 rows of either exist for any token**.
Every position figure therefore assumes all acquisition was on-market, which is
untested: 2,682 PONS cohort wallets have a negative position, meaning they sold
more than they bought.

**What would falsify it.** A trade with no `Transfer` log — v4 ERC-6909
accounting can move value inside the PoolManager without one.

---

## 9. What a null means, per field

**A null is never a zero.** Zero is a measurement; null is the absence of one.
Writing zero for an unknown produces a plausible number that nothing flags.

| field | null means | why not zero |
|---|---|---|
| `wallet_transactions.usd_amount` | the swap's price bucket had no derivable rate | $0.00 claims the trade was worthless |
| `wallet_transactions.price_usd` | same | a price of zero is a different claim |
| `wallet_transactions.counterparty` | not recorded — **all 179,736 PONS rows** | not "traded with nobody" |
| `wallet_scores.score` | every one of the eight metrics was null | zero would rank it below a wallet that did nothing |
| `wallet_scores.weight_used = 0` | paired with a null score: unscored | it is a real zero, and the score beside it is null |
| a metric inside `metrics.raw` | uncomputable for this wallet | it drops out of the weighted sum, and the remaining weights are renormalised |
| `native_usd_prices` missing bucket | no trade on both sides in that bucket | gaps stay gaps; nothing is interpolated or carried forward |
| `pons_usd_prices` missing bucket | no USDG-quoted trade in that bucket | same |

`block_time` and `token_amount` are `NOT NULL`: a row that cannot state when it
happened or how much moved is not a row.

**A filter that matches nothing is a suspected defect, not a clean pass**, and
must be reported as "RETURNED NO ROWS" rather than omitted.

# Parameterized wallet pipeline

    python3 scripts/run_pipeline.py \
        --name CATE \
        --address Ai66LHZG9MCzg1WKdawwqduVAXpNDUuV8M3uyq5ppump \
        --chain solana \
        --mcap-threshold 100000 \
        [--cached-trades data/cate_wallet_trades.csv] \
        [--compare] [--write]

Writes nothing unless `--write`. `--compare` checks the result against
`wallet_pnl` and never writes.

## Locked constraints, carried in from the per-token scripts

These were expensive to find and are encoded in code, not left to a future
reader to rediscover. Each lives next to the logic it constrains.

| Constraint | Where | Why |
|---|---|---|
| Decode from balance deltas at ANY call depth | `chains/solana.py` | Aggregators CPI into the AMM; a top-level check found 0 of 20 CATE swaps |
| `tx.from` is the trader only ~46% of the time | `chains/evm.py` | Smart accounts and ERC-4337 bundlers make the signer a relayer |
| Router order-splitting: use the swap's own pool amount minus its own fee | `chains/evm.py:trader_amount` | A wallet's net across a split order inflated attribution by up to 1381x |
| Circular arb: exclude where PoolManager both sends and receives | `chains/evm.py:is_circular` | The attributed wallet is a tip recipient, not the trader (5.2% of NTF rows) |
| Fee rate is measured, never assumed | `pricing.py:measure_fee_rate` | NTF was exactly 2% on buys and 0% on sells — a property of that hook, not the venue |
| Supply is not flat | `pricing.py:SupplyCurve` | NTF burned 4.9% of supply mid-window |
| Quote asset is detected | both chain modules | NTF's quote was native ETH, not WETH |
| FIFO, not net flow; unsold valued at zero | `pnl.py:fifo_wallet` | CATE originally stored net flow; the two diverge wherever a sell precedes its buy |
| Deterministic tie-break `(block_time, signature)` | `pnl.py:fifo_wallet` | Same-second trades otherwise reorder between runs and change which lots are consumed |
| Retry non-JSON and truncated bodies | `rpc.py` | An HTML error page raises a parser error that looks like a decoder bug; it killed a 4,851-page pull |

## What the pipeline decides itself

- **USD pricing method.** Measured from the token's own window: if the quote
  moved more than 5% the pipeline prices per-trade hourly, otherwise it uses a
  constant. CATE 39% over 31 days -> per-trade. NTF 0.8% over 6 hours ->
  constant. The rule is a measurement, not a preference.
- **Quote asset**, from the pool's currency pair.
- **Supply curve**, from mint/burn events.
- **Fee rate**, from unambiguous single-swap trades.
- **Which wallets are flagged** as having a pre-window entry.
- **Whether your mcap threshold is sensible.** Under 3% or over 40% of wallets
  is flagged with nearby alternatives — and then it runs with your number.

## What still needs a person

- **The mcap threshold.** The pipeline reports the distribution and flags an
  extreme, but the choice is yours. $60k was right for CATE and wrong for NTF.
- **Whether a venue misclassification matters.** See the known defect below.
- **Whether to accept zero-basis-sell wallets** in the cohort, or exclude them.
- **Approving a live pull's credit cost** before it runs.
- **Any recompute that changes stored native values.** The byte-identical check
  exists to stop that happening silently.

## Known defects in this build — do not use unattended

1. **Venue detection misclassifies graduated pump.fun tokens.** CATE is a
   pump.fun token that graduated to PumpSwap; discovery inspects only recent
   signatures, sees `pAMMBay6…` rather than the bonding-curve program, and
   reports `raydium_cpmm`. It must inspect the token's OLDEST transactions, or
   derive and probe the bonding-curve PDA, before the venue is trustworthy.
2. **Live pull is not wired.** `--cached-trades` is required. Phase 2 raises
   rather than pretending.
3. **Cohort filters are not parameterized.** Circular-arb exclusion and
   excess-seller exclusion exist in `chains/evm.py` but are not applied by the
   runner, so NTF yields 4,660 wallets where `wallet_pnl` holds 511.
4. **Phases 5-7 (load, cluster, dashboard) are not implemented.** The modules
   they would use exist; the orchestration does not.

## Test results

Both tokens reproduce their stored PnL exactly through the parameterized FIFO:

| Token | Compared | Matching within 1e-6 | Differing |
|---|---|---|---|
| CATE | 556 | **556** | **0** |
| NTF | 511 | **511** | **0** |

NTF additionally produced 4,149 wallets not in `wallet_pnl`, because defect 3
above means the cohort filters did not run. The PnL maths is confirmed; the
cohort selection is not.

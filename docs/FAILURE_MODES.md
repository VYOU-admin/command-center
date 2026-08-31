# Standing failure-mode list

Defects this project has actually shipped, kept because each one recurred after
being fixed once. Read this before trusting a clean run.

The ordering is deliberate: the first family is the most dangerous, because in
every case the wrong answer looked exactly like the right one.

---

## 1. An error path that emits a plausible value instead of failing

**The worst pattern on this project.** A crash is loud and points at its cause.
A believable wrong number silently becomes evidence, and everything downstream
inherits it.

- **PONS `balanceOf` reader, 2026-08-31.** Any absent RPC `result` was mapped to
  `0.0`. 490 of 1,046 batched reads came back HTTP 429 and every one became a
  zero balance. Zero is a perfectly plausible token balance, so nothing looked
  broken. It manufactured a decode crisis that did not exist — hundreds of
  wallets appearing to hold tokens on our books but nothing on chain — and the
  off-pool volume it implied exceeded total supply, which is the only reason it
  was caught. Corrected counts: nonzero balances 44 -> 382, still_holding
  117 -> 170.

**Rules.** Never substitute a default for a value that could not be obtained;
raise or retry. A reader fetching a set of values must confirm every requested
item came back and abort rather than emit a partial result. Inspect **per
response** errors: batched JSON-RPC returns per-item failures inside an HTTP 200,
so neither the status code nor a clean exit tells you anything. Preserve the
difference between NULL and 0 all the way into the database and the UI — "never
measured" is not "measured as nothing".

## 2. A filter, constant or gate that matches nothing, and so looks like a pass

Zero matches is a **suspected defect** until proven otherwise. Report it plainly
every time; never let it stand as confirmation that the data was clean.

- **Fabricated `Transfer` topic hash, 2026-08-31.** A hallucinated tail on the
  ERC-20 `Transfer` topic0 matched zero logs across 100,000 blocks. The pull
  "succeeded" and returned nothing. Caught only because zero transfers over a
  range containing thousands of known swaps is impossible. Constants like topic
  hashes must be copied from working code, never recalled.
- **`early_snapshots` retention gate.** Matched 1 of 16,173 tokens; contributed
  to filling the volume.
- **NUL bytes in group keys.** `${chain}\x00${...}` made every prior-count lookup
  miss, silently disabling the per-collection cap.
- **Circular-arb rule on V3.** Written for V4's PoolManager singleton; on PONS it
  caught 1 transaction of 5,657. Reported as a count, not as a pass.
- **`same_transaction` clustering on PONS.** Produced 0 clusters. Genuine and
  explained — 5,657 transactions for 5,662 swaps, so almost no transaction held
  two cohort wallets, unlike NTF's batched flow — but stated as a zero rather
  than quietly omitted.

## 3. A build that succeeds while the page is broken

`tsc` cannot see inside a template literal, so client JS built as a server-side
string is unchecked.

- **`/cate` blank for multiple commits.** `\n` inside a template literal was
  consumed at build time and emitted a real newline into a regex, so the entire
  script failed to parse. Header rendered, everything below was empty.
  `\d` similarly degrades to `d`.

**Rule.** A page is verified only when the **served** page has been executed in a
DOM and its rendered rows counted. `scripts/check-pages.mjs` parses every emitted
script block at build time; that is a floor, not proof.

## 4. A writer that reports success it did not achieve

- **Chunked SQL loader.** Its glob matched nothing so the loop ran zero times,
  and `split` put `begin;` in one chunk and `commit;` in another, rolling back 39
  of 70 inserts. It exited 0 and printed success. Found only by querying the
  table.

**Rule.** Verify writes with live queries against the database afterwards, from a
fresh connection. Dry-run counts before the write, read counts back inside the
transaction, and read them again after commit.

## 5. Attribution that is confidently wrong

- **`tx.from` is the trader only ~46% of the time** on chain 4663; smart accounts
  and ERC-4337 bundlers make the signer a relayer. Decode from balance deltas at
  any call depth.
- **Router order-splitting** inflated NTF by up to 1381x. Use the swap's own pool
  amount minus its own measured fee, never the wallet's whole net.
- **Measure the fee rate**, never assume it. NTF was 2% from a V4 hook; PONS was
  0% because V3 takes its fee in pool accounting.
- **Temporal grouping is chance-level.** 129 CATE groups against ~646 colliding
  pairs expected at random; 73 of 75 NTF temporal groups shared no signer.

## 6. False alarms from hardcoded expectations

Several "failures" were assertions hardcoding label text that had legitimately
changed (`Total PnL USD ▼`, `PnL SOL`, `SOL + ETH` vs `ETH + SOL`). The code was
correct every time. Assert on structure and counts, not on rendered strings.

## 7. An exclusion rule applied at the wrong granularity

A rule can be correct and still destroy the data if it fires on the wrong unit.

- **Circular-arb on AI, 2026-08-31.** The V4 rule "the PoolManager both sends and
  receives the token in one transaction" was applied per TRANSACTION. AI charges
  a 1% token-side hook fee, so the PoolManager pays a fee recipient which dumps
  its cut back into the pool in the same transaction — the signature fires on
  59.6% of transactions. Excluding those transactions **discarded 2,122 genuine
  buys** and left zero single-swap buys, which was the only visible tell.
  Corrected by excluding the ROUND-TRIPPER wallet's swap rather than the whole
  transaction, leaving the buyer in that transaction intact.

**Rule.** Before applying an exclusion, check what fraction of the data it
removes and what the removed rows actually contain. An exclusion that fires on a
majority of transactions is a finding to investigate, not a filter to apply. The
same discipline as a filter that matches nothing, in the opposite direction.

## 8. Infrastructure addresses entering a cohort as traders

- **PONS.** The Uniswap V4 PoolManager sits in the loaded PONS cohort as a
  trader, holding 19.8% of that token's unrealized total. PONS is a v3 pool, so
  the v4 PoolManager was not on any exclusion list for that run, yet routers hop
  through it and it accumulates balances.

**Rule.** Exclude venue infrastructure — pool managers, routers, fee recipients,
the zero address — from attribution candidates on EVERY token, not only when the
address happens to be the venue being indexed.

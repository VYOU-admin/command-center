# group1-new-token: why three fixes failed, and what the measurements actually said

Written 2026-09-02, after four wrong diagnoses in a row. The point of this
document is not the monitor; it is the instrumentation defect that made every
diagnosis wrong, and the discipline that would have caught it on the first one.

## The monitor

Mirrors `group2-new-token` for the other population: every Group 1 wallet
("bought and never sold") across the six Robinhood tokens, deduplicated at read
time to **2,956** — not the 2,991 the per-token counts sum to, because 35
wallets sit in two cohorts. No PnL threshold: Group 1's realized PnL is zero by
definition, so filtering on it would empty the list.

It is 8.5x group2's transfer-scan cost: 2,956 wallets is 15 chunks against
group2's 2.

## The instrumentation defect

`ABORT.transferReq` and `ABORT.sweepReq` were assigned **after** their loops
completed:

```ts
for (let i = 0; i < addrs.length; i += chunkSize) {
  transfers.push(...(await rpc.logsRange(...)));   // 30+ requests happen HERE
}
mark('transfers', rpc.requests - progress.sweep!);  // only reached AFTER the loop
ABORT.transferReq = rpc.requests - ABORT.sweepReq;
```

A cycle aborted mid-loop therefore wrote `phase_transfer_req = 0`. Not "no
requests were issued" — "the loop did not finish". The stats row said the
transfer phase had never started while the cycle had spent four minutes inside
it.

`phase_sweep_req` was wrong in the opposite direction: it recorded the
*cumulative* request counter at the sweep mark, so it silently included the head
and timestamp calls, and everything issued afterwards was invisible.

**One wrong number, four wrong diagnoses.** Every zero in the funnel was read as
a finding rather than as an absence of measurement.

## The four wrong diagnoses

1. **"The 3h bootstrap range is too wide."** Changed `bootstrap_hours` 3 -> 1.
   The next cycle aborted at 300.0s. The change was harmless but irrelevant.
2. **"A 20,000-block PoolManager query does not return on this endpoint."**
   Changed `sweep_block_window` 20000 -> 5000, and wrote that claim into the
   config as justification. Measured later: **0.3 s**. Flatly false.
3. **"It died in the Initialize sweep"** — asserted three times, on the strength
   of `phase_transfer_req = 0` alone.
4. **"The sweep finished in ~8 seconds; it's into the transfer scan now."** Read
   from log ordering during a live run. The watchlist load is a database query
   that happens after the sweep loop begins, so the ordering meant nothing.

Diagnoses 1 and 2 each produced a config change deployed to production on the
strength of an inference from request counts and elapsed time. Neither was
measured first. Both were wrong.

## The measurement that should have come first

A single `eth_getLogs` for the PoolManager `Initialize` topic, 5 attempts per
range, no pacing, `PublicRpc` bypassed so its retry could not fire:

| span | n | median | max | errors | error rate | median logs |
|---|---|---|---|---|---|---|
| 20,000 | 5 | **0.3 s** | 0.4 s | 0 | 0% | 614 |
| 5,000 | 5 | **0.3 s** | 0.3 s | 0 | 0% | 150 |
| 1,000 | 5 | **0.3 s** | 0.3 s | 0 | 0% | 29 |

15 of 15 returned. Zero errors, zero timeouts. **Latency is flat in block
range** — 1.26x for a 20x range increase — while log counts scale linearly
(614/150/29), so the endpoint returns proportionally more data in the same time.
All 15 attempts together took 4.5 seconds.

This took about a minute to run and would have killed diagnosis 2 outright.

## The per-chunk timeline, cycle 2026-09-02T19:27:08Z

Aborted at 311.1 s. Phases: sweep 7, transfers 26, receipts 0; 36 requests total.

| idx | wallets | reqs | expected | splits | retries | elapsed | cum logs |
|---|---|---|---|---|---|---|---|
| 0 | 200 | 2 | 2 | 0 | 0 | 8.0 s | 1,426 |
| 1 | 200 | 2 | 2 | 0 | 0 | 8.0 s | 1,858 |
| 2 | 200 | 2 | 2 | 0 | 0 | 8.0 s | 2,206 |
| 3 | 200 | 2 | 2 | 0 | 0 | 8.0 s | 2,520 |
| 4 | 200 | 2 | 2 | 0 | 0 | 8.1 s | 2,816 |
| 5 | 200 | 2 | 2 | 0 | 0 | 7.9 s | 3,053 |
| 6 | 200 | 2 | 2 | 0 | 0 | 8.0 s | 3,209 |
| 7 | 200 | 2 | 2 | 0 | 0 | 8.0 s | 3,421 |
| **8** | 200 | **~10** | 2 | ? | ? | **~207 s** | never completed |

**Eight of fifteen chunks are perfectly clean**: exactly 2 requests each, exactly
the expected window count, zero splits, zero retries, 8.0 s each — which is
precisely 2 requests x 4,000 ms of pacing and nothing else. Pacing accounts for
64.0 s of the 64.0 s those eight consumed. There is no per-chunk overhead, no
hidden cost in the wallet array, and no drift.

**The ninth chunk consumed the rest.** Its numbers are derived, not recorded:
the transfers phase reports 26 requests and the eight completed chunks account
for 16, so chunk 8 issued ~10 requests against an expected 2. Elapsed is
311.1 s total, minus ~40 s for overhead-plus-sweep and 64 s for the eight clean
chunks, leaving **~207 s in one chunk**. Ten requests at 4,000 ms pacing is 40 s,
so **~167 s was not pacing.**

## What that points at, and what is still not measured

`PublicRpc.call()` retries on any non-abort error with `3000 * (attempt + 1) ** 2`
backoff. Seven attempts is 3 + 12 + 27 + 45 + 45 + 45 = **177 s**, plus seven
paced requests. That matches ~207 s closely.

It is also what the code's own comment says it was written to avoid:

> RATE LIMITING IS RETRYABLE; A QUERY THAT IS TOO BIG IS NOT. Retrying an
> oversized getLogs just times out again... Throw instead, so logs() splits
> immediately.

The `throw` intended to trigger that split is **inside the try block**, so the
catch below it retries the error it was meant to propagate.

**This remains inference.** The measured facts are the request count and the
elapsed time for chunk 8. The split/retry breakdown for it was not captured, for
two reasons — both the same class of defect as the original one:

1. The per-chunk record is pushed **after** the chunk completes, so the only
   chunk that matters is the one with no record.
2. `rpc_splits` and `rpc_retries` were wired into the success insert only, so
   they are null on exactly the path where they would settle the question.

## The rule this cost us

Four diagnoses, two production config changes, and roughly two hours, all from
trusting a zero that meant "not measured" rather than "measured as none".

- A counter assigned after a loop measures nothing about a cycle that dies
  inside the loop.
- A zero from an instrument is not a finding until the instrument is known to
  have run.
- When a request count and an elapsed time disagree with a hypothesis, measure
  the single request before changing config. It took one minute and would have
  prevented both changes.

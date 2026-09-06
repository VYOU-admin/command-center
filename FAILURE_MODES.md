# Standing failure-mode list

Defects this project has actually shipped. Each one is here because it recurred
after being fixed once, or because it cost a full debugging session before the
real cause surfaced. Read this before trusting a clean run.

The examples are stated in general terms on purpose. The specific monitors,
tables and tokens that produced them have been removed; the mistakes have not.

---

## 1. Never map an error to zero

When a value cannot be obtained, raise or retry. Never substitute a default.

A batched balance reader mapped any absent RPC `result` to `0.0`. Hundreds of
those reads came back HTTP 429, and every one silently became a zero balance.
Zero is a completely plausible balance, so nothing looked broken — it instead
manufactured a false crisis in which wallets appeared to hold nothing while
holding plenty on chain, and cost a full investigation before the transport was
suspected. A crash would have been strictly better, because it would have
pointed at the transport immediately.

A reader that fetches a set of values must verify that every requested item came
back and abort rather than emit a partial result. Prefer per-response error
inspection over trusting an HTTP status: a batched JSON-RPC call returns
per-item errors inside a `200`.

The same rule covers display values. If a figure is unknown, omit it or render
it as unknown; never print `0`, because a reader cannot tell a measured zero
from an absent measurement.

## 2. A filter, gate or lookup that matches nothing looks exactly like a pass

Zero matches is a result, and it must be reported as one. Treat it as a
suspected defect until proven otherwise, never as confirmation that the data was
clean.

This has appeared as a fabricated event-topic hash that matched zero logs across
100,000 blocks, as an exclusion list scoped to the wrong venue, and as the
timestamp bug in §3. In each case the run completed, reported success, and
produced nothing — which is indistinguishable from "there was nothing to find".

Two further instances, both from the first EVM intake. A pricing-quote set held
only Solana mints, so every pool on a new chain was rejected, no pool was
eligible, and the token was never priced while the monitor reported success. And
a cohort query filtered on pool *addresses*, which on Uniswap v4 do not exist —
the singleton PoolManager is the counterparty — so an entire venue matched
nothing and 23.5% of the eventual cohort was invisible. **When a query returns
nothing from a population you expect to be active, suspect the query before
concluding the population is idle.**

The defensive form is to refuse to run rather than run empty: a filter built from
a list must assert the list is non-empty before it is used, because an empty
filter matches nothing and completes cleanly.

## 3. Never pass a Postgres timestamp through a JS Date and back as a lookup key

JavaScript `Date` holds milliseconds. Postgres `timestamptz` stores
microseconds. The truncated value is still a valid timestamp, so
`where col = $1` runs without error and matches zero rows.

Two forms, both seen here:

- `new Date(String(pgDate))` — `String()` renders a Date with no milliseconds at
  all, so `03:54:32.373Z` reparses as `03:54:32.000Z`.
- Passing the `Date` object straight back as a query parameter — silently drops
  the microseconds, so `12:58:10.239372` goes back as `12:58:10.239`.

Keep the comparison inside SQL: `lag()` or another window function, a self-join,
or selecting by rank over `order by <timestamp> desc`. Do not select a
timestamp, hand it to application code, and send it back.

It has caused three separate failures here, including a diff that reported zero
changes for four consecutive cycles while real changes were occurring, and a
diagnostic query that reported a cycle as empty when it had sixteen changed
rows — a wrong finding stated out loud before it was caught.

## 4. Never lowercase a blockchain address

Solana addresses are base58 and case-sensitive. EVM addresses are hex and
conventionally lowercased, and that habit leaks.

This recurred **four separate times**: on a read path, on a write path, in a
shared helper reused across chains, and in an API response field. Each time the
address was silently corrupted into something that matched nothing, so rows were
written and then permanently invisible, or a page rendered zero results with no
error anywhere.

When a helper is shared between an EVM chain and a non-EVM chain, check what it
does to case before reusing it. Normalising case is a chain-specific decision,
not a generic one.

## 5. Dry-run counts before any delete or update, and report zeros explicitly

Before any insert, delete or update, run the counts the write is supposed to
produce and report them beside the live figures they must reconcile against. If
they do not reconcile, stop and report rather than adjusting the numbers to fit.

Report every count including zeros. Never omit a line because its count was
zero — "RETURNED NO ROWS" is a result and must be stated. This matters most for
safety checks, where zero is the passing answer and an omitted line is
indistinguishable from a check that was never run.

## 6. Verify with live queries on a fresh connection, not script exit codes

A script that finished without throwing is not evidence that the write landed.
Re-query on a new connection afterwards and report what that query returned.

The same applies to deploys and builds. `tsc` clean, a successful build, and a
green deploy each prove only that the code compiles and ships. Establish success
from observable state — a changed boot timestamp, the migrated column actually
existing, rows actually present — not from a tool printing "complete".

For anything with a rendered output, execute the served page and count what it
renders. A page can be structurally valid and display nothing.

Show the check rather than asserting it: print the query alongside its result,
so the claim can be audited instead of taken on trust.

## 7. Write the cycle stats row at cycle START, not on completion

Instrumentation that writes after the fact cannot describe a run that was
aborted. A run killed by a timeout guard never reaches its persist step, so the
worst runs — the ones you most need to understand — leave no evidence at all.

Insert the row when the cycle begins, with a `completed = false` flag, and
update it on success. Assign counters as they are measured, not after the loop
that produces them: a counter still holding its initial value means *not
measured*, which is not the same as *measured as zero*, and reading it as zero
produced four consecutive wrong diagnoses on one occasion.

## 8. Pair figures from the same baseline

Every number shown together must be measured against the same reference, and the
reference the difference is taken against must itself be visible.

A display once paired a frozen lifetime total with a live current balance and
showed the delta between the live value and a third figure that never appeared
on screen. The result was deltas larger than the stated holding — arithmetically
impossible on their face, and correct only once you knew that two of the three
numbers came from different sources with different time bases.

If two figures cannot share a baseline, do not put them on the same line.

## 9. `create table if not exists` is a no-op on an existing table

Adding a column by editing the original `create table` statement silently does
nothing once the table exists. The deploy succeeds, the column is absent, and
every write to it fails or is dropped.

Every column added after a table's first release must come through
`alter table ... add column if not exists`.

## 10. Check SQL parameter arity before deploying

Placeholder-versus-argument mismatches (`$32` against 37 arguments) fail the
whole transaction at runtime, taking unrelated writes in the same transaction
down with them. Count placeholders against arguments as a mechanical check
before shipping any statement long enough that you cannot see both ends at once.

Confirm the conflict target of an upsert matches the table's actual constraint.
An `on conflict (a)` against a real primary key of `(a, b)` throws and aborts
the transaction.

## 11. A documented guarantee the code did not implement

When a comment or a doc states an invariant, check the code enforces it. Several
defects here were introduced by trusting a header comment that described what
the author intended rather than what the function did — including a "both reads
must succeed" rule that was actually implemented as "at least one read
succeeded".

## 12. A failed edit that does not stop the command depending on it

A patch step that aborts does not, on its own, prevent the next command in the
same shell invocation from running against the unpatched file. Seen twice in one
session: an empty schema string that `client.query('')` executed and reported as
applied while creating nothing, and a re-run that silently used the code path
being replaced.

Chain dependent steps with `&&` rather than `;` or separate lines, and have the
consuming step validate its own input rather than trusting that the producer
succeeded — a script that is handed SQL should confirm the SQL contains what it
expects before executing it.

## 13. A value that is zero in arithmetic but not in floating point

A quantity summed from signed components can be genuinely zero and still test as
positive. Netting a wallet's token transfers left `2.8e-14` where exact
arithmetic gives `0`, and the filter `if (got <= 0) continue` let it through as a
real purchase. 89 such rows entered storage, and 10 wallets had no other rows —
they were tagged into cohorts as buyers who never bought.

Compare against a domain floor, never against zero. Here that is one raw unit of
the token (`1 / 10^decimals`); for a currency it is the smallest representable
amount. Guarding one side of a calculation is not enough: this code already had a
dust floor on the amount paid, and lacked one on the amount received.

Note how it stayed hidden, because that generalises. The rows carried `$0.000000`,
so every total looked correct. A later repair pass recomputed the affected column
from a clean source, which replaced the absurd values with plausible ones and
removed the only visible symptom while leaving the cause in place. **A repair that
overwrites a derived column can erase the evidence of the defect that produced
it** — after any such repair, check that the inputs still explain the outputs.

The check that found it: a derived column's stored range must fall inside the
range of the inputs it was computed from. Prices spanning `1.2e-14 .. 0.25` could
not have come from ticks spanning `0.065 .. 0.102`, and that mismatch is the
whole detection.

## 14. A failed read recorded as absent data

Batched JSON-RPC returns per-item errors *inside* an HTTP 200 response. When the
request rate is too high, individual sub-calls come back carrying a rate-limit
error while the batch itself succeeds. Code that checks the HTTP status and then
skips items lacking a result converts "I could not read this" into "this does not
exist".

A block-timestamp fetch lost **42% of its blocks** this way and reported the loss
as a shortfall rather than as a failure. The same shape appeared twice more in
the same session, in a pool classifier and in a cohort builder, each time in code
written after the previous one had been fixed.

Inspect every item of a batch response. Retry the ones carrying transport-shaped
errors, and report anything still failing **with its error text**. A read that
did not happen is never data.

The sibling rule: distinguish an error from an answer. A reverted `token0()` call
means "this contract is not a pool", which is a result and must not be retried;
a rate-limited call means nothing at all and must be. Treating both as failures
cost five retry rounds over 1,664 settled questions; treating both as answers
loses real data.

## 15. Rate, size, and result-cap refusals need opposite responses

Three refusals look similar and demand different actions:

- **429 / "compute units per second"** — asked too *often*. Back off in time and
  hold the request size. Narrowing it means more requests, which is more of
  exactly what was refused.
- **"query timed out"** — asked for too many blocks at once. Narrow the span;
  leave the pacing alone.
- **"logs matched by query exceeds limit"** — the node answered and refused
  because the *answer* was too large. Narrow the span, and be able to go
  arbitrarily small.

Conflating the first two doubled a sweep's cost twice in one session, in
opposite directions. Conflating the third with a timeout produced a livelock: the
span floor was 2,000 blocks, the region returned more than 10,000 logs in 2,000
blocks, and the sweep re-asked the same impossible range every 30 seconds while
looking healthy. **A floor that cannot go low enough is a livelock, not a safety
limit** — and a job that cannot satisfy a request must stop and say so rather
than repeat it.

## 16. A spend cap and a throughput throttle both return 429

They need opposite responses. A per-second throttle lifts in seconds, so backing
off and continuing is right. A monthly spend cap does not lift by waiting, so
backing off is an infinite polite retry against a wall, and the job sits there
making no progress while appearing healthy.

Nothing in the response distinguishes them. **Probe: issue one cheap call.** If
the endpoint answers, the account is live and this was throughput — back off and
continue. If the probe also refuses, the account is cut off and stopping is
correct. Without the probe a hard stop kills recoverable jobs, and without a hard
stop a capped job runs forever.

## 17. A work set derived from the wrong population

Before spending on an external API, derive what to fetch from **the rows that
will actually be written**, not from the superset that contains them.

A timestamp fetch was scoped to every distinct block in a swap table — 1,379,236
blocks — when the rows being written needed 144,073, of which 92,598 were already
stored. 51,475 were genuinely required. The **9.6× overshoot cost roughly 7
million compute units**, a large fraction of a monthly budget, and was caught by
the user watching a dashboard rather than by anything in the job.

State the derivation and the count before the first request. A plan that says
"1.3 million" when the output needs 51 thousand is obviously wrong to anyone who
knows the output size, and invisible to anyone who does not.

## 18. A paid job without a ceiling inside it

An account-level cap protects the budget. Only a counter inside the job protects
against a job whose scope was wrong from the first request — the account cap
stops it after the money is gone, having spent it on the wrong thing.

Every paid or rate-limited job states its expected call count, sub-call count and
cost before starting, checks that against the remaining budget, and stops at a
stated ceiling regardless of progress, reporting where it stopped. The corrected
timestamp fetch used 51,475 of a 60,000 sub-call ceiling and reported both.

## 19. A guard that checks only what is easy to count

A pre-flight printed `amount0=0 and amount1=0 : 480924` — every row apparently
zero — and the write committed anyway, because the transaction's guards checked
only row counts. The alarm turned out to be false (the query had lost its
`filter` clause and was counting every row), but **a real zero-amount catastrophe
would have committed identically**.

A guard must cover the property that would make the write wrong, not only the
one that is easy to count. If a check is worth printing, it is worth aborting on.

## 20. A monitor where one item failing still reports success

A price monitor priced two tokens of three and recorded `success`, because a
single token failing was designed not to fail the run. The third token went
unpriced for hours behind a green monitor and an empty column on the dashboard.

Partial success is a legitimate design — one bad source should not stop the
others storing. But it must be *visible*: alert on the first failure rather than
the third, log at error level, and fail the run once an item has failed
repeatedly, so a permanent failure eventually turns the monitor red. "Some of it
worked" and "all of it worked" must not look the same.

## 21. A paid endpoint chosen before the free ones were tested

Before committing to a metered API, test the free alternatives and report what
each can and cannot do. The measurement takes minutes; the assumption costs
whatever the job costs.

A block-timestamp fetch was queued as ~13,000 Alchemy calls without either
alternative having been tried. Tested afterwards, the **public RPC served the
same batched `eth_getBlockByNumber` perfectly — 100 blocks per request, HTTP 200,
448 ms — for free**, needing only slower pacing. The block explorer, by contrast,
returned HTTP 403 behind a Cloudflare interstitial on every endpoint and was not
usable at all. Neither fact was known when the paid job was planned, and only one
of them would have been guessed correctly.

Report the alternatives as measurements with their limits — throughput, span,
availability — so the choice between paying and waiting is made on numbers. Free
and slow is often the right answer for work that runs unattended.

## 22. A field that is correct on one endpoint and silently zero on another

`eth_getLogs` returns a `blockTimestamp` on every log on Robinhood Chain. On
Alchemy it is the real block time: measured across 5,758 logs, **0 missing, 0
equal to `0x0`, 0 non-monotonic**, and an exact match against
`eth_getBlockByNumber` on every block spot-checked. On the **public RPC the same
field is `0x0` on every log** — 708 of 708 in the sample, against a true
`0x6a9d1a6c` for the same block.

`0x0` is a well-formed hex timestamp. Nothing errors, nothing is absent, and the
value parses cleanly to 1970-01-01. A job that read timestamps from logs and was
pointed at the free endpoint — as a fallback, a cost saving, or a copied snippet
— would stamp every row with the epoch and report success.

This is the endpoint-specific form of the standing rule that an error path must
never emit a plausible value. The defence is not to prefer one endpoint but to
**refuse the value**: a timestamp that is absent or zero is a failed read and
must throw, naming the endpoint as the likely cause. Two endpoints answering the
same JSON-RPC method are not interchangeable just because both return HTTP 200
and a well-formed body.

The same shape should be assumed for any optional enrichment field — effective
gas price, log `removed`, trace data — whenever an endpoint is swapped.

## 23. A secret reported as wiped when it was never looked for correctly

A probe on the Railway host printed `ALCHEMY_API_KEY MISSING`, and that was
reported as the key having been destroyed by a redeploy. It had not. The key was
in the project's local `.env` the whole time, and every earlier command had
carried it explicitly:

```
set -a; . ./.env; set +a
railway ssh -- "ALCHEMY_API_KEY=$ALCHEMY_API_KEY node /app/script.mjs"
```

The tool shell does not keep state between invocations, so the `set -a` line has
to be repeated every time. One command omitted it, the remote process got an
empty value, and the probe faithfully reported the truth about *that command's
environment* — which said nothing at all about the project. The wrong conclusion
was then stated to the user as fact.

**An absent value is evidence about the lookup, not only about the thing looked
for.** Before reporting that something is gone, check where it is supposed to
live: `railway variables` for a service variable, the `.env` file for a local
one, the transcript for how it was previously supplied. All three were available
and none had been consulted.

This is the same shape as a filter that matches nothing being read as a clean
pass. Zero results is a question, not an answer.

(`ALCHEMY_API_KEY` is now a service variable as well, because the hourly
`token-updates` monitor runs inside the container and cannot see a per-command
variable. The lesson stands for the next secret.)

## 24. The same count in floats and in numeric, differing by 28%

A wallet's position is `bought - sold`, over token amounts carrying 18 decimals.
Counted in JavaScript doubles it gave **2,101 wallets with a negative position**;
counted in Postgres `numeric` it gave **2,682**. Reproducing the double-precision
sum inside Postgres returned 2,098, which confirms the arithmetic rather than the
query as the cause. The first figure had already been reported as fact.

A double holds about 16 significant digits. A wallet that bought and sold
7,000,000.123456789012345678 tokens nets to exactly zero in `numeric` and to
something near ±1e-9 in a double, and the sign it lands on is arbitrary. 587
wallets sat in that gap.

The same rounding runs the other way. Of the 2,682 exact negatives, **589 are
negative by less than a millionth of a token and the smallest by 3e-18 — one
wei** — which is allocation residue, not an off-market purchase. A threshold of
`< 0` would have flagged all of them; the materiality floor of `-0.001`, the
same one the row writer already applies to a token amount, leaves 2,088.

Two rules follow:

**Compute counts and thresholds in SQL, in `numeric`.** Not in the application,
and never in double precision, whenever the quantity carries more significant
digits than a double holds. `sum(x) filter (where ...)` in Postgres is exact for
`numeric` and it is also faster than pulling 182,202 rows into a process to add
them up.

**A materiality floor is part of the definition, not a refinement of it.**
"Negative position" without one counts float residue as evidence of off-market
acquisition. State the floor, say what it excludes, and reuse the floor the
pipeline already applies elsewhere rather than inventing a second one.

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

"""
The locked constraints, enforced by code rather than by the operator remembering.

Every constraint in docs/PIPELINE_SPEC.md section 4 must be explicitly recorded
as satisfied. A constraint that is never recorded is treated as SKIPPED and the
run aborts before reporting -- silence is not evidence.
"""
from __future__ import annotations

REQUIRED = [
    "quote_detected",
    "decimals_read",
    "window_binary_search",
    "supply_reconciled",
    "fee_measured",
    "attribution_balance_delta",
    "router_split_own_amount",
    "circular_arb_applied",
    "infrastructure_excluded",
    "fifo_not_netflow",
]


class Ledger:
    def __init__(self):
        self.rows = {}

    def record(self, name: str, detail: str, ok: bool = True):
        self.rows[name] = (ok, detail)

    def fail(self, name: str, detail: str):
        self.record(name, detail, ok=False)

    def report(self) -> str:
        out = ["LOCKED CONSTRAINTS (docs/PIPELINE_SPEC.md section 4)"]
        for n in REQUIRED:
            if n not in self.rows:
                out.append(f"  SKIPPED  {n}")
                continue
            ok, detail = self.rows[n]
            out.append(f"  {'ok      ' if ok else 'FAILED  '}{n}: {detail}")
        for n, (ok, detail) in self.rows.items():
            if n not in REQUIRED:
                out.append(f"  {'ok      ' if ok else 'FAILED  '}{n}: {detail}")
        return "\n".join(out)

    def enforce(self):
        missing = [n for n in REQUIRED if n not in self.rows]
        failed = [n for n, (ok, _) in self.rows.items() if not ok]
        if missing or failed:
            raise SystemExit(
                "REFUSING TO REPORT.\n"
                + (f"  constraints never checked: {', '.join(missing)}\n" if missing else "")
                + (f"  constraints failed: {', '.join(failed)}\n" if failed else "")
                + "  A constraint that was skipped is not a constraint that passed.")

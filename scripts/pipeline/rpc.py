"""
Shared JSON-RPC with the retry behaviour every per-token script had to learn.

TRANSPORT FAILURES WEAR DISGUISES. A public RPC under load answers with an HTML
error page, and json() then raises a parser error that reads like a decoder bug.
That killed a 4,851-page pull once and failed three of the first twenty
nft-mints runs. A truncated body does the same. Both are retryable; treating
either as fatal loses the whole run.

RATE LIMITING IS COST-BASED on the endpoints here, not request-count: cheap
calls pass freely while consecutive heavy getLogs calls return 429. So pacing is
per-call and backoff is quadratic.
"""
from __future__ import annotations

import json
import re
import time
from typing import Any

import requests


class Rpc:
    def __init__(self, url: str, rate_per_sec: float = 10.0, secret: str | None = None):
        self._url = url
        self._gap = 1.0 / rate_per_sec if rate_per_sec > 0 else 0.0
        self._last = 0.0
        self._secret = secret
        self.calls = 0

    def scrub(self, s: Any) -> str:
        """Never let an API key reach a log line, even via an exception."""
        t = str(s)
        return re.sub(re.escape(self._secret), "<KEY>", t) if self._secret else t

    def call(self, method: str, params: Any, tries: int = 5, timeout: int = 120):
        """Returns (result, error_message). error_message is None on success."""
        for attempt in range(tries):
            wait = self._last + self._gap - time.time()
            if wait > 0:
                time.sleep(wait)
            self._last = time.time()
            self.calls += 1
            try:
                r = requests.post(self._url, json={"jsonrpc": "2.0", "id": "1",
                                                   "method": method, "params": params},
                                  timeout=timeout)
            except requests.RequestException as e:
                if attempt == tries - 1:
                    return None, f"transport: {self.scrub(e)[:120]}"
                time.sleep(0.4 * (attempt + 1) ** 2)
                continue
            if r.status_code == 429 or r.status_code >= 500:
                time.sleep(0.8 * (attempt + 1) ** 2)
                continue
            try:
                j = r.json()
            except ValueError:
                # HTML error page or truncated body — transport, not decoding
                time.sleep(0.4 * (attempt + 1) ** 2)
                continue
            if "error" in j:
                msg = self.scrub(j["error"].get("message", ""))
                if "Too Many" in msg:
                    time.sleep(1.2 * (attempt + 1) ** 2)
                    continue
                # A params error is a bug; retrying only bills for it again.
                if "invalid params" in msg.lower():
                    raise SystemExit(f"{method}: {msg}")
                return None, msg
            return j.get("result"), None
        return None, "exhausted retries"

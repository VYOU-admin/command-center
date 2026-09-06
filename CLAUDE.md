# command-center

A monitoring spine on Node 22 / Postgres / Railway. Monitors are YAML configs
paired with adapters under `src/adapters/`; the scheduler runs them, the Discord
sink alerts, the dashboard shows their state.

## Read this first

`FAILURE_MODES.md` at the repo root is the standing failure-mode list — defects
this project has actually shipped, each one kept because it recurred after being
fixed once. Read it before trusting a clean run, and before writing any code
that reads a value, deletes a row, or reports success.

## Token intake

Two standing procedures, one per chain. Read the one for the chain you are
working on before collecting anything:

- `docs/SOLANA-TOKEN-INTAKE.md` — Solana (MOS, USELESS)
- `docs/ROBINHOOD-TOKEN-INTAKE.md` — Robinhood Chain, EVM (PONS)

They share their reporting discipline and verification requirements; what differs
is the chain. Neither is a narrative — both are procedures to follow.

## Measured ceilings — do not re-derive these

Every figure below was measured on this project. Re-deriving them costs money
and time; treat them as inputs.

**Alchemy, Pay As You Go, chain 4663**

```
eth_getLogs span        100,000 blocks succeeds; 250,000 refused with
                        "Log response size exceeded" (the error text quotes a
                        5,000-block limit that does not match observed behaviour)
eth_getLogs cost        ~60 CU per call, flat -- a 100,000-block request costs
                        the same as a 10-block one, so sweep at the widest span
eth_getBlockByNumber    ~20 CU per sub-call, batched 100 per request
throughput              15.3 calls/s at concurrency 8 with zero refusals
per-item errors begin   ~13 requests/s x 100 sub-calls. At 2.4-2.5 req/s with
                        batch 100, 51,475 sub-calls returned zero errors
archival                yes -- eth_getCode at historical blocks works here and
                        errors "metadata is not found" on the public RPC
tier limit              free tier caps eth_getLogs at a 10-block range
```

**Public RPC, https://rpc.mainnet.chain.robinhood.com**

```
eth_getLogs span   50,000 blocks works (2.2s); 100,000 times out
pacing             4,000 ms between calls gave 0/20 refusals; 800 ms gave 15/20;
                   batches 1 second apart were refused outright
eth_getBlockByNumber   batched 100 per request, HTTP 200 in 448 ms, free
state              NOT archival -- historical eth_getCode errors
```

**Blockscout** (`robinhoodchain.blockscout.com`) returns HTTP 403 behind a
Cloudflare interstitial on every API path tested. It is a link target, not a
data source.

**Helius, Solana**: batch ceiling between 28 and 32 sub-calls; no usage API, so
credit figures must come from the dashboard rather than from arithmetic against
constants in this repository.

## Secrets

`ALCHEMY_API_KEY` is a **Railway service variable**. It is also in the local
`.env`, and the two must stay in agreement.

It was deliberately kept off the service for the whole PONS intake and passed
per command instead (`set -a; . ./.env; set +a` locally, then
`railway ssh -- "ALCHEMY_API_KEY=$ALCHEMY_API_KEY node ..."`), so that reading
the chain never required a redeploy. That stopped working once the work had to
run on a schedule: the `token-updates` monitor runs inside the container, and a
per-command variable is invisible to it. The variable was set deliberately, with
the redeploy it causes accepted.

Two consequences:

- **Do not conclude the key was wiped** because a probe reports it missing.
  Check `railway variables` first. A remote command that did not source `.env`
  produces an empty value that looks identical to a wiped one — that mistake has
  already been made once here and led to a wrong report.
- **Never interpolate a key into monitor YAML.** The registry persists a
  monitor's options into `monitors.config`, so a key in YAML becomes a key in
  the database. Adapters read allow-listed secrets through
  `AdapterContext.configVars` instead.

## archive/

Do not read anything under archive/ unless I explicitly ask for it by
filename. It describes a torn-down system and will mislead you about what
currently exists.

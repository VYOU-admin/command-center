# command-center

A monitoring spine on Node 22 / Postgres / Railway. Monitors are YAML configs
paired with adapters under `src/adapters/`; the scheduler runs them, the Discord
sink alerts, the dashboard shows their state. On top of that sits the token
pipeline, which loads a token's buyer cohort and scores it.

## One document per chain

**Robinhood Chain: `docs/ROBINHOOD.md`.** It is the only document for that
chain — definitions, procedure, failure modes, measured constants and per-token
findings, in one file, in the order the work happens.

**Solana: `docs/SOLANA-TOKEN-INTAKE.md`.** A different chain, its own procedure.

Four rules keep them true, and they are repeated at the top of `ROBINHOOD.md`:

1. **The chain's document is read in full before any token work begins.** Not
   skimmed, not searched — read. Then say what in it applies to the token in
   front of you.
2. **Any bug, workaround or measurement updates the document first and the code
   second.** The document is the specification; the code implements it.
3. **A rule in the document that the code does not implement is a defect in the
   code.** Always, and in that direction. The code is never the authority.
4. **Nothing gets its own new document.** If it matters, it goes in the chain's
   document.

These exist because the documents were originally written after the code, from
what the code happened to do. That is backwards, and it is why they drifted:
twice a definition was found to be wrong or unproven only after work had been
built on it. `ROBINHOOD.md` ends with the running list of rules the code does
not yet implement — read it before assuming the code is right.

## Never write collection code to a scratchpad

Every script that does real work goes in the repository, committed, *before* it
runs. The first PONS intake was carried out by scratchpad scripts; a container
recycle destroyed them, and its 13,095-wallet cohort can no longer be reproduced
from any code that exists. A throwaway query for a one-off count is fine.
Anything that sweeps, decides membership, or writes a row is not.

## No definition changes on a claim

Any proposed change to what a term means must first be proven on individual
decoded transactions, with hashes the user can open, counter-examples included.
An aggregate query is a hypothesis. Twice an aggregate pointed at a large
conclusion and decoding twenty transactions settled it the other way in minutes.

## Secrets

`ALCHEMY_API_KEY` is a Railway service variable and is also in the local `.env`;
the two must stay in agreement. It was deliberately kept off the service for the
whole first intake and passed per command, which stopped working once the hourly
`token-updates` monitor had to run inside the container.

- **Do not conclude the key was wiped** because a probe reports it missing.
  Check `railway variables` first. A remote command that did not source `.env`
  produces an empty value that looks identical to a wiped one.
- **Never interpolate a key into monitor YAML.** The registry persists a
  monitor's options into `monitors.config`, so a key in YAML becomes a key in the
  database. Adapters read allow-listed secrets through
  `AdapterContext.configVars`.

## archive/

Do not read anything under archive/ unless I explicitly ask for it by
filename. It describes a torn-down system and will mislead you about what
currently exists.

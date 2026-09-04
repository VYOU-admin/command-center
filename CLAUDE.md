# command-center

A monitoring spine on Node 22 / Postgres / Railway. Monitors are YAML configs
paired with adapters under `src/adapters/`; the scheduler runs them, the Discord
sink alerts, the dashboard shows their state.

## Read this first

`FAILURE_MODES.md` at the repo root is the standing failure-mode list — defects
this project has actually shipped, each one kept because it recurred after being
fixed once. Read it before trusting a clean run, and before writing any code
that reads a value, deletes a row, or reports success.

## archive/

Do not read anything under archive/ unless I explicitly ask for it by
filename. It describes a torn-down system and will mislead you about what
currently exists.

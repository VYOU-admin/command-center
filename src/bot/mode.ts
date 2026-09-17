/**
 * THE ONE PLACE THE BOT'S MODE IS DECIDED.
 *
 * `LAUNCHBOT.md` section 2A. Everything that behaves differently between a simulation and
 * a real transaction asks THIS module and nothing else. A second place that decides
 * whether we are live is the two-implementations trap with money attached, and this
 * project has recorded that failure seven times.
 *
 * ---------------------------------------------------------------------------
 * LIVE IS OFF BY DEFAULT AND ONLY AN EXPLICIT FLAG TURNS IT ON
 * ---------------------------------------------------------------------------
 *
 * `--live` on the command line, and nothing else. Specifically NOT:
 *
 *   - an environment variable. `ROBINHOOD.md` records that a Railway variable change
 *     silently replaces the container, so an env var is a value that can appear without
 *     anyone typing it on the machine that runs.
 *   - a config file or monitor YAML. `monitors.config` persists options into Postgres, so
 *     a YAML value is a database value and editable by anything holding a connection —
 *     the same reason every safety rail is hard-coded.
 *   - a default. The absence of an answer is never "yes" to spending money.
 *
 * **AN ENV VAR THAT LOOKS LIKE AN ATTEMPT TO GO LIVE RAISES RATHER THAN BEING IGNORED.**
 * Silently ignoring it would leave an operator believing the bot is live when it is not,
 * which is the `bridge_assets` failure this project already records: an option that is
 * accepted and does nothing is worse than one that is refused.
 */

export interface BotMode {
  /** The only field anything should branch on. */
  readonly live: boolean;
  /** The value written to `bot_trades.mode`. Always contains 'live' or 'dry-run'. */
  readonly label: string;
}

/** Env vars that a reasonable person might expect to enable live mode. None of them do. */
const IMPOSTOR_ENV = [
  'BOT_LIVE', 'LAUNCHBOT_LIVE', 'BOT_MODE', 'LAUNCHBOT_MODE', 'LIVE', 'BOT_GO_LIVE',
];

export const LIVE_FLAG = '--live';

/**
 * Resolve the mode from the command line, refusing anything ambiguous.
 *
 * Pure, so the gate can be exercised without a process — and the drill does exactly that.
 */
export function resolveMode(argv: readonly string[], env: NodeJS.ProcessEnv): BotMode {
  const wantsLive = argv.includes(LIVE_FLAG);

  /*
   * THE IMPOSTOR CHECK RUNS WHETHER OR NOT THE FLAG IS PRESENT. An operator who set
   * BOT_LIVE=1 and did not pass the flag must be told, not quietly run in dry-run; and
   * one who set it AND passed the flag must be told the variable did nothing, so nobody
   * later believes the variable is what controls this.
   */
  for (const k of IMPOSTOR_ENV) {
    const v = env[k];
    if (v !== undefined && v !== '') {
      throw new Error(`${k} is set to "${v}", and it does NOT control live mode. Only the `
        + `explicit ${LIVE_FLAG} flag does. Unset ${k} and pass ${LIVE_FLAG} if you mean `
        + 'to trade with real money; this raises rather than ignoring it so nobody '
        + 'believes a variable is the control.');
    }
  }

  const i = argv.indexOf('--run-label');
  const rawLabel = i >= 0 ? String(argv[i + 1] ?? '') : '';
  if (i >= 0 && !/^[a-z0-9-]{1,24}$/.test(rawLabel)) {
    throw new Error(`--run-label must match [a-z0-9-]{1,24}, got "${rawLabel}"`);
  }

  if (!wantsLive) {
    /* A label only ever SUFFIXES 'dry-run', so no argument can produce a live label. */
    return { live: false, label: rawLabel ? `dry-run-${rawLabel}` : 'dry-run' };
  }

  /*
   * A LIVE RUN MAY NOT CARRY A TEST LABEL. `--run-label` exists to give a test run its
   * own `MAX_TRADES_PER_DAY` budget, which is exactly the wrong thing to hand a live run:
   * it would let a second live run spend a second day's allowance on the same day.
   */
  if (rawLabel) {
    throw new Error(`${LIVE_FLAG} cannot be combined with --run-label. A label gives a run `
      + 'its own MAX_TRADES_PER_DAY budget, and two live runs must share one budget rather '
      + 'than each getting a fresh day.');
  }
  return { live: true, label: 'live' };
}

/** The dry-run mode, for callers that have no argv and must not be able to be live. */
export const DRY_RUN: BotMode = { live: false, label: 'dry-run' };

/**
 * True when a stored mode string denotes a simulation. ONE predicate, used by the
 * `/trades` banner, its totals blocks and its row chips — which is why those three
 * cannot disagree, after a run labelled `dry-run-r3` was banded "THIS PAGE CONTAINS LIVE
 * TRADES" by an exact-string test.
 */
export function isDryRunMode(mode: string): boolean {
  return mode === 'dry-run' || mode.startsWith('dry-run-');
}

/**
 * Structured line logging to stdout. Railway captures stdout/stderr, so JSON
 * lines here are greppable in the deploy logs without any extra wiring.
 */

export type Level = 'debug' | 'info' | 'warn' | 'error';

const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const configured = (process.env.LOG_LEVEL ?? 'info').toLowerCase() as Level;
const MIN = RANK[configured] ?? RANK.info;

export type Fields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
  child(bound: Fields): Logger;
}

function emit(level: Level, bound: Fields, msg: string, fields?: Fields): void {
  if (RANK[level] < MIN) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...bound,
    ...fields,
  });
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

function make(bound: Fields): Logger {
  return {
    debug: (m, f) => emit('debug', bound, m, f),
    info: (m, f) => emit('info', bound, m, f),
    warn: (m, f) => emit('warn', bound, m, f),
    error: (m, f) => emit('error', bound, m, f),
    child: (extra) => make({ ...bound, ...extra }),
  };
}

export const log: Logger = make({});

/** Errors do not survive JSON.stringify; flatten one into loggable fields. */
/**
 * Flatten an error and its cause chain into one line.
 *
 * This matters more than it looks. Node's fetch reports every network problem
 * as a bare "TypeError: fetch failed" and hides the real reason — ENOTFOUND,
 * ECONNREFUSED, a TLS failure — in `err.cause`. An alert that says "fetch
 * failed" tells an operator nothing, so the chain is unwrapped here rather than
 * thrown away.
 */
function describe(err: unknown, maxDepth = 4): string {
  const parts: string[] = [];
  let current: unknown = err;

  for (let depth = 0; depth < maxDepth && current !== undefined && current !== null; depth += 1) {
    if (current instanceof Error) {
      parts.push(`${current.name}: ${current.message}`);
      current = current.cause;
    } else {
      parts.push(String(current));
      break;
    }
  }

  return parts.join(' <- ') || String(err);
}

export function errorFields(err: unknown): Fields {
  if (err instanceof Error) {
    return {
      error: describe(err),
      error_type: err.name,
      ...(err.cause ? { cause: describe(err.cause) } : {}),
      stack: err.stack,
    };
  }
  return { error: String(err) };
}

/** Short human-readable form, safe to store in Postgres and post to Discord. */
export function errorMessage(err: unknown): string {
  const raw = describe(err);
  return raw.length > 900 ? `${raw.slice(0, 897)}...` : raw;
}

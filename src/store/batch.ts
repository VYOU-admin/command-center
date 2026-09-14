/**
 * BATCHED INSERTS. One statement per 500 rows instead of one per row.
 *
 * docs/ROBINHOOD.md section 7: one row per statement pinned the ETH/USD market
 * sweep at ~185 rows/second under autocommit, and the intake sweep -- inside a
 * transaction, so no per-row fsync -- still only managed 1,248 rows/second on
 * CASHCAT: 14,957,528 rows in 199.8 minutes, with `pg_stat_activity` showing the
 * backend in `ClientRead` between sub-second inserts. The bottleneck was the
 * round trip, not the endpoint and not the disk.
 *
 * THE DE-DUPLICATION TRAP IS THE PART THAT BITES. Two rows with the same key in
 * ONE multi-row `VALUES` statement RAISE; `on conflict do nothing` does not help,
 * because the conflict is inside the statement rather than against the table.
 * `block_times` is keyed (chain, block_number) and TEN CONSECUTIVE BLOCKS SHARE A
 * TIMESTAMP on this chain, so a batch of logs routinely carries many rows for one
 * block. The first occurrence of each key in a batch wins; duplicates ACROSS
 * batches are separate statements and `on conflict` handles them.
 *
 * This does NOT restore progressive commit where the caller holds one
 * transaction open for a whole phase -- the runner does exactly that, and that is
 * a separate open defect in section 9. Batching buys throughput only.
 */
import type { PoolClient } from './db.js';

export const DEFAULT_BATCH_ROWS = 500;

export interface BatchedInsert<T> {
  /** Table name. Interpolated, so it must be a literal in the calling code. */
  table: string;
  columns: string[];
  /** One array of bound values per row, in `columns` order. */
  toValues: (row: T) => unknown[];
  /**
   * The row's UNIQUE KEY, as a string, for de-duplication WITHIN a batch.
   * Omit only for a table with no unique constraint the batch could violate.
   */
  keyOf?: (row: T) => string;
  batchRows?: number;
}

/**
 * Insert `rows` in batches, `on conflict do nothing`.
 *
 * Returns the number of rows actually inserted, summed over the batches, so a
 * caller reporting "stored" reports what the database accepted rather than what
 * it was handed.
 */
export async function insertBatched<T>(
  client: PoolClient,
  rows: T[],
  spec: BatchedInsert<T>,
): Promise<number> {
  if (rows.length === 0) return 0;
  const size = spec.batchRows ?? DEFAULT_BATCH_ROWS;
  const cols = spec.columns.join(', ');
  let inserted = 0;

  for (let i = 0; i < rows.length; i += size) {
    const slice = rows.slice(i, i + size);

    /* De-duplicate WITHIN the batch. See the header: this is not optional. */
    let batch = slice;
    if (spec.keyOf) {
      const seen = new Set<string>();
      batch = [];
      for (const r of slice) {
        const k = spec.keyOf(r);
        if (seen.has(k)) continue;
        seen.add(k);
        batch.push(r);
      }
    }
    if (batch.length === 0) continue;

    const params: unknown[] = [];
    const tuples: string[] = [];
    for (const r of batch) {
      const vals = spec.toValues(r);
      if (vals.length !== spec.columns.length) {
        throw new Error(
          `insertBatched into ${spec.table}: ${spec.columns.length} columns but a row `
            + `produced ${vals.length} values. A mismatch here is a runtime error on a `
            + 'path that may not run for hours.',
        );
      }
      tuples.push('(' + vals.map((_, j) => `$${params.length + j + 1}`).join(', ') + ')');
      params.push(...vals);
    }

    const res = await client.query(
      `insert into ${spec.table} (${cols}) values ${tuples.join(', ')}
       on conflict do nothing`,
      params,
    );
    inserted += res.rowCount ?? 0;
  }
  return inserted;
}

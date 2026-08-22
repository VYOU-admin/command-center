/**
 * Normalized record storage, shared by every source. Dedupe lives here so no
 * adapter has to think about it.
 */

import type { NormalizedRecord } from '../adapters/types.js';
import type { Pool, PoolClient } from './db.js';

export interface StoredRecord {
  id: number;
  monitorId: string;
  monitorName: string;
  externalId: string;
  title: string;
  url: string | null;
  publishedAt: Date | null;
  summary: string | null;
  firstSeenAt: Date;
}

/**
 * Insert a batch, ignoring anything already seen for this monitor.
 * Returns the number of genuinely new rows — that is the "new records" figure
 * on the dashboard, and 0 new on a rerun is the proof dedupe is working.
 */
export async function insertRecords(
  client: PoolClient,
  monitorId: string,
  records: NormalizedRecord[],
): Promise<number> {
  if (records.length === 0) return 0;

  // De-duplicate within the batch too: a feed occasionally repeats a guid, and
  // ON CONFLICT cannot resolve two conflicting rows in the same statement.
  const unique = new Map<string, NormalizedRecord>();
  for (const record of records) unique.set(record.externalId, record);

  let inserted = 0;
  for (const record of unique.values()) {
    const result = await client.query(
      `insert into records
         (monitor_id, external_id, title, url, published_at, summary, payload)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (monitor_id, external_id) do nothing`,
      [
        monitorId,
        record.externalId,
        record.title,
        record.url,
        record.publishedAt,
        record.summary,
        JSON.stringify(record.payload ?? {}),
      ],
    );
    inserted += result.rowCount ?? 0;
  }

  return inserted;
}

/**
 * Recent records for the dashboard, newest first.
 *
 * Ordered by published time where the source gave one, falling back to when we
 * first saw it, so a feed with missing dates still lands somewhere sensible.
 */
export async function getRecentRecords(
  pool: Pool,
  options: { hours: number; monitorId?: string; limit?: number },
): Promise<StoredRecord[]> {
  const params: unknown[] = [options.hours, options.limit ?? 200];
  let filter = '';
  if (options.monitorId) {
    params.push(options.monitorId);
    filter = `and r.monitor_id = $${params.length}`;
  }

  const result = await pool.query(
    `select r.id, r.monitor_id, m.name as monitor_name, r.external_id, r.title,
            r.url, r.published_at, r.summary, r.first_seen_at
       from records r
       join monitors m on m.id = r.monitor_id
      where coalesce(r.published_at, r.first_seen_at) > now() - ($1 || ' hours')::interval
        ${filter}
      order by coalesce(r.published_at, r.first_seen_at) desc
      limit $2`,
    params,
  );

  return result.rows.map((row: any) => ({
    id: Number(row.id),
    monitorId: row.monitor_id,
    monitorName: row.monitor_name,
    externalId: row.external_id,
    title: row.title,
    url: row.url,
    publishedAt: row.published_at,
    summary: row.summary,
    firstSeenAt: row.first_seen_at,
  }));
}

export async function countRecords(pool: Pool, monitorId: string): Promise<number> {
  const result = await pool.query('select count(*)::bigint as n from records where monitor_id = $1', [
    monitorId,
  ]);
  return Number(result.rows[0]?.n ?? 0);
}

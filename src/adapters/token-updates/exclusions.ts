/**
 * Addresses that must never be attributed a trade.
 *
 * Read from `config/infrastructure.yaml` rather than hard-coded, because that
 * file is the standing list and is edited to add a router without touching
 * decode code. It is applied at the CANDIDATE stage, before cohort membership
 * and before any row is built, so an excluded address never becomes a row
 * rather than being filtered out afterwards.
 *
 * An entry that matches nothing is REPORTED, not dropped. On the PONS intake 4
 * of 6 entries matched and the 2 that did not were stated explicitly -- a list
 * entry silently matching nothing is indistinguishable from a check that never
 * ran.
 */

import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';

export interface ExclusionEntry {
  address: string;
  label: string;
}

export async function loadExclusions(
  path: string,
  chain: string,
): Promise<ExclusionEntry[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    // A missing exclusion list is not an empty exclusion list. Proceeding
    // without it would attribute the PoolManager's own flow to a trader.
    throw new Error(
      `could not read the infrastructure exclusion list at "${path}": ` +
        `${(err as Error).message}`,
    );
  }
  const doc = parseYaml(text) as { chains?: Record<string, unknown> } | null;
  const forChain = doc?.chains?.[chain];
  if (!Array.isArray(forChain)) {
    throw new Error(
      `${path} has no exclusion list for chain "${chain}". An absent list is a ` +
        'configuration gap, not a licence to attribute infrastructure addresses.',
    );
  }
  return forChain.map((raw, i) => {
    const entry = raw as { address?: unknown; label?: unknown };
    if (typeof entry.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(entry.address)) {
      throw new Error(`${path}: chains.${chain}[${i}].address is not an EVM address`);
    }
    return {
      address: entry.address.toLowerCase(),
      label: typeof entry.label === 'string' ? entry.label : `entry-${i}`,
    };
  });
}

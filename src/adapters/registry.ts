/**
 * Adapter discovery.
 *
 * Every .ts file in this directory other than types.ts and registry.ts is
 * treated as a source adapter and must default-export a SourceAdapter. That is
 * what keeps the promise that adding a source means adding one adapter file and
 * one config file — there is no list to remember to update.
 */

import { readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import type { SourceAdapter } from './types.js';

const NOT_ADAPTERS = new Set(['types.js', 'registry.js']);

function isAdapter(value: unknown): value is SourceAdapter {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as SourceAdapter).type === 'string' &&
    typeof (value as SourceAdapter).fetch === 'function' &&
    typeof (value as SourceAdapter).validate === 'function'
  );
}

export async function loadAdapters(): Promise<Map<string, SourceAdapter>> {
  const dir = import.meta.dirname;
  const files = (await readdir(dir))
    .filter((f) => f.endsWith('.js') && !NOT_ADAPTERS.has(f))
    .sort();

  const adapters = new Map<string, SourceAdapter>();

  for (const file of files) {
    const module: Record<string, unknown> = await import(
      pathToFileURL(join(dir, file)).href
    );
    const candidate = module['default'];
    if (!isAdapter(candidate)) {
      throw new Error(
        `Adapter file "${file}" must default-export a SourceAdapter ` +
          '({ type, validate, fetch }).',
      );
    }
    const existing = adapters.get(candidate.type);
    if (existing) {
      throw new Error(`Two adapters both claim source type "${candidate.type}".`);
    }
    adapters.set(candidate.type, candidate);
  }

  if (adapters.size === 0) {
    throw new Error(`No source adapters found in ${dir}.`);
  }

  return adapters;
}

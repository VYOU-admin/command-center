/**
 * Raw integer amounts to decimal.
 *
 * Token amounts are stored EXACTLY, as a decimal string built from the bigint,
 * never via a JavaScript number. A uint256 balance routinely exceeds 2^53, and
 * the underlying quantities are the part of this pipeline where exactness is
 * still expected -- the tolerance for approximation applies to dollar figures,
 * not to on-chain amounts.
 *
 * `toNumber` exists for pricing arithmetic only, where a few parts per billion
 * of error changes no decision.
 */

export function formatUnits(raw: bigint, decimals: number): string {
  if (decimals < 0 || !Number.isInteger(decimals)) {
    throw new Error(`decimals must be a non-negative integer, got ${decimals}`);
  }
  const negative = raw < 0n;
  const digits = (negative ? -raw : raw).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = decimals === 0 ? '' : digits.slice(digits.length - decimals).replace(/0+$/, '');
  return (negative ? '-' : '') + whole + (fraction ? '.' + fraction : '');
}

export function toNumber(raw: bigint, decimals: number): number {
  return Number(formatUnits(raw, decimals));
}

export const abs = (v: bigint): bigint => (v < 0n ? -v : v);

/** Median of a non-empty list. Returns null for an empty one rather than 0. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

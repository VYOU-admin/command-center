/**
 * THE ONE IMPLEMENTATION OF THE TWO PRICE CONVENTIONS, AND OF WHICH IS WHICH.
 *
 * A v4 Swap log carries two signed amounts and nothing that says which way round to
 * read them. Two different quantities are wanted from the same pair, they are exact
 * reciprocals, and both are legitimate:
 *
 *   quoteRate   TOKENS PER PRICING UNIT -- what `expectedOut` needs to size a buy.
 *   tokenPrice  PRICING UNITS PER TOKEN -- a price that rises when the token rises,
 *               and the convention every measurement in ROBINHOOD.md uses.
 *
 * THEY WERE IMPLEMENTED SEPARATELY AND DRIFTED, exactly as this project has recorded
 * five times before. `launchbot` stored its quote rate in `entry_price`; the price
 * backfill computed a token price; the exit grid divided one by the other and reported
 * a median return of -1.0000 with best equal to worst across all four horizons. That
 * is a ratio of about 1e-30 presented as "the position lost everything", and it was
 * only obvious because -1.0000 exactly, with no spread at all, is not a thing a market
 * does. A subtler mismatch would have been believed.
 *
 * Nothing else in the bot may convert a swap into a price.
 */

/** Two's-complement decode of one 32-byte word of a Swap log's data. */
export function signedWord(word: string): bigint {
  const v = BigInt(`0x${word}`);
  return v >= (1n << 255n) ? v - (1n << 256n) : v;
}

export interface SwapAmounts { amount0: bigint; amount1: bigint }

/** The two amounts of a v4 Swap, from the log's first 64 data bytes. */
export function swapAmounts(data: string): SwapAmounts | null {
  const d = data.startsWith('0x') ? data.slice(2) : data;
  if (d.length < 128) return null;
  const amount0 = signedWord(d.slice(0, 64));
  const amount1 = signedWord(d.slice(64, 128));
  /* A zero leg cannot produce a ratio. Null, never a substituted 1 or 0. */
  if (amount0 === 0n || amount1 === 0n) return null;
  return { amount0, amount1 };
}

const abs = (x: bigint): bigint => (x < 0n ? -x : x);

/**
 * PRICING UNITS PER TOKEN. Rises when the token rises. This is the number every
 * return, grid and median in the chain documents is computed from.
 */
export function tokenPrice(a: SwapAmounts, tokenIsCurrency0: boolean): number {
  return tokenIsCurrency0
    ? Number(abs(a.amount1)) / Number(abs(a.amount0))
    : Number(abs(a.amount0)) / Number(abs(a.amount1));
}

/**
 * TOKENS PER PRICING UNIT -- the reciprocal, and the only thing a buy quote can use.
 * Kept as its own named function rather than an inline `1 /` so that a reader of the
 * call site can see which convention is in play without deriving it.
 */
export function quoteRate(a: SwapAmounts, tokenIsCurrency0: boolean): number {
  return 1 / tokenPrice(a, tokenIsCurrency0);
}

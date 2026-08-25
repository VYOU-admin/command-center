/**
 * Per-wallet activity in a token's first ten minutes.
 *
 * WHY THIS EXISTS. The tracker already sees every wallet that touches a token —
 * `TradeEvent` carries the trader on every trade — but until now it kept only
 * `.size` and threw the addresses away at the ten-minute decision. That made
 * "which wallets are good at this" unanswerable from stored data, because
 * nothing linked a wallet to a token.
 *
 * BUYS AND SELLS BOTH. A wallet that buys early and dumps into the pump is a
 * different animal from one that buys early and holds, and the two are
 * indistinguishable from buy data alone. Each row therefore carries both sides,
 * with the second each first occurred, so "bought at 40s, sold at 90s" is
 * legible without joining anything.
 *
 * ONE ROW PER (TOKEN, WALLET), not per trade. A wallet that makes forty buys in
 * ten minutes is one row with buy_count = 40. Per-trade rows would multiply
 * volume by roughly the trade count for no analytical gain at this resolution.
 *
 * LOSERS ARE THE POINT. Rows are written for every token, not only the ones
 * that did well. A wallet in three winners and two hundred failures is a bot,
 * and that is only visible if the two hundred were recorded. Measured, this
 * costs little: 83% of all buyers already sit in the 7% of tokens that clear
 * the activity floor, so restricting capture to "interesting" tokens would save
 * ~8% of the storage while discarding 88% of the tokens.
 */

/** Running per-wallet state for one token, held only for the first ten minutes. */
export interface WalletActivity {
  buys: number;
  buySol: number;
  firstBuySeconds: number | null;
  sells: number;
  sellSol: number;
  firstSellSeconds: number | null;
}

/** A row to be written when the ten-minute decision is made. */
export interface WalletCapture {
  mint: string;
  wallet: string;
  firstSeenSeconds: number;
  buyCount: number;
  buySol: number;
  firstBuySeconds: number | null;
  sellCount: number;
  sellSol: number;
  firstSellSeconds: number | null;
}

export function newActivity(): WalletActivity {
  return {
    buys: 0,
    buySol: 0,
    firstBuySeconds: null,
    sells: 0,
    sellSol: 0,
    firstSellSeconds: null,
  };
}

/**
 * Fold one trade into a wallet's running state. Returns which side was seen for
 * the first time, so the caller can maintain unique-wallet counters without
 * rescanning the map on every snapshot — at 15-second marks across thousands of
 * tracked tokens, an O(wallets) scan per snapshot would dominate the tick.
 */
export function applyToWallet(
  a: WalletActivity,
  isBuy: boolean,
  solAmount: number,
  seconds: number,
): { firstBuy: boolean; firstSell: boolean } {
  if (isBuy) {
    const firstBuy = a.buys === 0;
    a.buys++;
    a.buySol += solAmount;
    if (firstBuy) a.firstBuySeconds = seconds;
    return { firstBuy, firstSell: false };
  }
  const firstSell = a.sells === 0;
  a.sells++;
  a.sellSol += solAmount;
  if (firstSell) a.firstSellSeconds = seconds;
  return { firstBuy: false, firstSell };
}

export function toCaptures(mint: string, wallets: Map<string, WalletActivity>): WalletCapture[] {
  const out: WalletCapture[] = [];
  for (const [wallet, a] of wallets) {
    const first = [a.firstBuySeconds, a.firstSellSeconds].filter(
      (v): v is number => v !== null,
    );
    if (first.length === 0) continue;
    out.push({
      mint,
      wallet,
      firstSeenSeconds: Math.min(...first),
      buyCount: a.buys,
      buySol: a.buySol,
      firstBuySeconds: a.firstBuySeconds,
      sellCount: a.sells,
      sellSol: a.sellSol,
      firstSellSeconds: a.firstSellSeconds,
    });
  }
  return out;
}

/**
 * Current-price history, one row per token per successful observation.
 *
 * APPEND-ONLY, AND DELIBERATELY SO. The dashboard only needs the latest price,
 * but holding "the latest price" as mutable state means a failed read has
 * somewhere to write a wrong answer. An append-only series has no such slot:
 * a cycle that cannot price a token writes nothing, the previous row stands,
 * and the row carries its own `observed_at` so the page can show how old it is.
 * A stale price that says it is stale is safe; a zero written by a failed read
 * is indistinguishable from a real collapse in value.
 *
 * `pool` and `source` are stored per row rather than assumed, because the pool
 * a price came from is chosen per cycle by liquidity and genuinely moves. A
 * price of 0.2470 means nothing without knowing which of a token's 28 pools
 * produced it — they spanned 0.2351 to 0.2494 on the day this was written.
 *
 * The history is free, and worth having: it is the only record of what a token
 * was worth at a moment we looked, independent of any pool's own chart.
 */
export const SCHEMA = `
create table if not exists token_prices (
  id          bigserial   primary key,
  mint        text        not null references tokens(mint),
  price_usd   numeric     not null,
  pool        text        not null,
  source      text        not null,
  observed_at timestamptz not null default now()
);

create index if not exists token_prices_mint_observed_idx
  on token_prices (mint, observed_at desc);
`;

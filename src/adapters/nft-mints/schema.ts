/**
 * Tables for the NFT mint collector.
 *
 * APPEND-ONLY, with identity carried by the chain's own notion of a mint:
 *   Solana  -> the mint address is unique on its own
 *   EVM     -> (collection_address, token_id) is unique per chain
 * A single primary key over (chain, collection_address, token_id, mint_address)
 * covers both without a nullable-key problem: EVM rows carry '' for
 * mint_address and Solana rows carry '' for token_id.
 *
 * nft_mint_filter_stats exists because of a specific past failure. A retention
 * gate on early_snapshots matched almost nothing for days while reporting
 * success, and the table grew until the volume filled. The lesson is that a
 * filter which silently drops everything and a filter which silently drops
 * nothing look identical from the outside unless the rejections are counted.
 * So every rule records what it rejected, per day and per chain, as AGGREGATE
 * COUNTS ONLY — no rejected rows are stored, which would defeat the filtering.
 */

export const SCHEMA = `
create table if not exists nft_mints (
  chain              text        not null,
  collection_address text        not null,
  collection_name    text,
  token_id           text        not null default '',
  mint_address       text        not null default '',
  minter_wallet      text        not null,
  block_time         timestamptz not null,
  mint_price         numeric,
  price_currency     text,
  tx_hash            text        not null,
  compressed         boolean     not null default false,
  is_known_wallet    boolean     not null default false,
  collected_at       timestamptz not null default now(),
  primary key (chain, collection_address, token_id, mint_address)
);

create index if not exists nft_mints_time_idx
  on nft_mints (block_time desc);
create index if not exists nft_mints_chain_time_idx
  on nft_mints (chain, block_time desc);
create index if not exists nft_mints_wallet_idx
  on nft_mints (minter_wallet);
-- the digest reads "known wallets first", so this stays cheap as the table grows
create index if not exists nft_mints_known_idx
  on nft_mints (is_known_wallet, block_time desc) where is_known_wallet;

-- Per-day, per-chain, per-rule rejection counts. Counts only, never rows.
create table if not exists nft_mint_filter_stats (
  day        date not null,
  chain      text not null,
  rule       text not null,
  rejected   bigint not null default 0,
  primary key (day, chain, rule)
);

-- Daily aggregates that survive after full detail is purged.
create table if not exists nft_mint_daily (
  day                date not null,
  chain              text not null,
  collection_address text not null,
  collection_name    text,
  mints              bigint not null,
  distinct_minters   bigint not null,
  known_wallet_mints bigint not null default 0,
  primary key (day, chain, collection_address)
);

-- Where each chain's cursor sits, so a restart resumes instead of rescanning.
create table if not exists nft_mint_cursor (
  monitor_id text not null,
  chain      text not null,
  cursor_val text not null,
  updated_at timestamptz not null default now(),
  primary key (monitor_id, chain)
);
`;

/**
 * Storage for wallet scores.
 *
 * The score is stored ALONGSIDE its inputs, not on its own. A bare number
 * cannot be audited later: `metrics` holds the raw value and the normalised
 * value of every one of the seven metrics, plus the weights in force when it
 * was computed, so a score can always be taken apart into what produced it.
 */
export const SCORES_SCHEMA = `
/*
 * Dated events a token's metrics are measured against -- pump points today.
 *
 * The instant is stored as timestamptz from an offset-qualified literal. A pump
 * given as "08-07 04:00 Eastern" is a different moment from "08-07 04:00 UTC"
 * by four hours in August, and metrics 5 and 6 both key off a 48-hour window
 * and a linear distance to this instant, so the offset is not cosmetic.
 */
create table if not exists token_events (
  id           bigserial primary key,
  chain        text        not null,
  token        text        not null,
  kind         text        not null,
  event_at     timestamptz not null,
  block_number bigint,
  label        text,
  note         text,
  created_at   timestamptz not null default now()
);

create unique index if not exists token_events_unique_idx
  on token_events (chain, token, kind, event_at);

create table if not exists wallet_scores (
  chain       text        not null,
  token       text        not null,
  tag         text        not null,
  wallet      text        not null,
  -- Null is a real answer: every metric was null for this wallet. It is NOT a
  -- score of zero, which would rank a wallet with no data below one that
  -- genuinely did nothing.
  score       numeric,
  weight_used numeric     not null default 0,
  metrics     jsonb       not null default '{}'::jsonb,
  computed_at timestamptz not null default now(),
  primary key (chain, token, tag, wallet)
);

create index if not exists wallet_scores_rank_idx
  on wallet_scores (chain, token, tag, score desc nulls last);

/*
 * SCORE-QUALITY FLAGS. Deliberately here and NOT in wallet_tags: those are
 * cohort membership, these are statements about how much the score can be
 * trusted, and mixing them would force every tag query to know which kind it
 * was reading.
 *
 * An array because a wallet can carry several. DERIVED ON EVERY SCORING RUN,
 * never accumulated: the writer replaces the whole array, so a flag whose
 * condition no longer holds disappears by itself. That is what makes the
 * inflated-pnl flag self-clearing once transfer rows are collected.
 */
alter table wallet_scores add column if not exists flags text[] not null default '{}';
create index if not exists wallet_scores_flags_idx on wallet_scores using gin (flags);
`;

/** A wallet's score rests on too little of the weight to be comparable. */
export const FLAG_LOW_WEIGHT = 'low-weight';
/** The wallet sold more than it bought, so its PnL counts sales it never paid for. */
export const FLAG_INFLATED_PNL = 'inflated-pnl';

-- Create games table
create table if not exists public.games (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  status text not null default 'lobby_open',
  home_team_name text default 'Home',
  away_team_name text default 'Away',
  created_at timestamptz not null default now()
);

-- Create players table
create table if not exists public.players (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games(id) on delete cascade,
  display_name text not null,
  role text not null default 'player',
  side text check (side in ('home', 'away')) default null,
  ready boolean not null default false,
  created_at timestamptz not null default now()
);

-- Enforce unique display names per game
alter table public.players
  add constraint if not exists unique_game_display_name unique (game_id, display_name);

-- Allow lobby lock and host tracking
alter table public.games add column if not exists lobby_locked boolean default false;
alter table public.games add column if not exists host_player_id uuid;

-- Game state columns
alter table public.games add column if not exists quarter int default 1;
alter table public.games add column if not exists clock_seconds int default 900; -- seconds remaining in quarter
alter table public.games add column if not exists play_clock_seconds int default 40;
alter table public.games add column if not exists possession_side text check (possession_side in ('home','away'));
alter table public.games add column if not exists down int default 1;
alter table public.games add column if not exists distance int default 10;
alter table public.games add column if not exists yard_line int default 25;
alter table public.games add column if not exists score_home int default 0;
alter table public.games add column if not exists score_away int default 0;
alter table public.games add column if not exists phase text default 'lobby'; -- lobby, coin_toss, kickoff, drive, finished
alter table public.games add column if not exists play_subphase text; -- play_call, question, rolls, resolve
alter table public.games add column if not exists offense_side text check (offense_side in ('home','away'));
alter table public.games add column if not exists defense_side text check (defense_side in ('home','away'));
alter table public.games add column if not exists last_play_id uuid;
alter table public.games add column if not exists toss_result text;
alter table public.games add column if not exists toss_winner_side text check (toss_winner_side in ('home','away'));
alter table public.games add column if not exists toss_choice text check (toss_choice in ('receive','kick','defer'));
alter table public.games add column if not exists second_half_kickoff_side text check (second_half_kickoff_side in ('home','away'));
alter table public.games add column if not exists current_play_seq int default 1;

-- Useful indexes
create index if not exists idx_games_code on public.games (code);
create index if not exists idx_players_game_id on public.players (game_id);

-- Plays log
create table if not exists public.plays (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games(id) on delete cascade,
  seq int,
  offense_side text check (offense_side in ('home','away')),
  defense_side text check (defense_side in ('home','away')),
  call_offense text,
  call_defense text,
  difficulty text,
  question_id uuid,
  offense_roll int,
  defense_roll int,
  offense_correct boolean,
  defense_correct boolean,
  yards int,
  turnover boolean default false,
  result_text text,
  created_at timestamptz not null default now()
);

create index if not exists idx_plays_game_id on public.plays (game_id);
create index if not exists idx_plays_seq on public.plays (game_id, seq);

-- Game events timeline
create table if not exists public.game_events (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games(id) on delete cascade,
  type text not null,
  payload jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_game_events_game_id on public.game_events (game_id);

-- Play calls (per play sequence)
create table if not exists public.play_calls (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  side text check (side in ('home','away')),
  role text, -- offense or defense
  play_call text,
  difficulty text,
  seq int,
  answer boolean,
  roll int,
  ready_after_roll boolean default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_play_calls_game_seq on public.play_calls (game_id, seq);
alter table public.play_calls
  add constraint if not exists unique_play_call_seq unique (game_id, player_id, seq);

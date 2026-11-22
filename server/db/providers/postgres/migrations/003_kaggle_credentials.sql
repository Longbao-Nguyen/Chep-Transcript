create table if not exists user_kaggle_credentials (
  user_id text primary key references users(id) on delete cascade,
  auth_mode text not null default 'api_token' check (auth_mode in ('api_token', 'oauth2')),
  kaggle_username text,
  encrypted_token text not null,
  token_iv text not null,
  token_auth_tag text not null,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

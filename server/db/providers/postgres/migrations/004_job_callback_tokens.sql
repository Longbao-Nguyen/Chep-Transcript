alter table jobs
  add column if not exists callback_token_hash text,
  add column if not exists callback_token_expires_at timestamptz,
  add column if not exists kaggle_kernel_ref text,
  add column if not exists storage_cleaned_at timestamptz;

create index if not exists jobs_cleanup_idx on jobs (status, updated_at);

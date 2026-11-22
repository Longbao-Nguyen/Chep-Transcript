alter table jobs
  add column if not exists srt_object_key text,
  add column if not exists kaggle_shard1_ref text,
  add column if not exists dual_mode boolean not null default false,
  add column if not exists shard0_done boolean not null default false,
  add column if not exists shard1_done boolean not null default false;

alter table user_queue_state
  add column if not exists pause_after_current boolean not null default false;

alter table user_kaggle_credentials
  add column if not exists gpu_status text not null default 'unchecked'
    check (gpu_status in ('unchecked', 'checking', 'ready', 'error')),
  add column if not exists gpu_message text,
  add column if not exists gpu_checked_at timestamptz,
  add column if not exists gpu_probe_ref text;

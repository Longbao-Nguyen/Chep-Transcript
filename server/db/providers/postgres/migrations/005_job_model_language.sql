alter table jobs
  add column if not exists model_id text not null default 'bofenghuang/whisper-large-v3-french-distil-dec16',
  add column if not exists language text not null default 'fr';

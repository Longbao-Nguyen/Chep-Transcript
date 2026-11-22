import assert from 'node:assert/strict';
import test from 'node:test';

import { loadMigrations, migrationChecksum } from '../../scripts/migrate';
import { shouldMigrateDuringBuild } from '../../scripts/migrate-deploy';

test('migrations preserve existing job data and add expected tables and columns', async () => {
  const migrations = await loadMigrations();
  assert.deepEqual(migrations.map(({ filename }) => filename), [
    '001_initial.sql',
    '002_queue_cancellation.sql',
    '003_kaggle_credentials.sql',
    '004_job_callback_tokens.sql',
    '005_job_model_language.sql',
    '006_web_feature_parity.sql',
  ]);

  const migrationSql = migrations.map(({ sql }) => sql).join('\n');
  const createdTables = [...migrationSql.matchAll(/create table if not exists\s+([a-z_]+)/gi)]
    .map((match) => match[1]);

  assert.deepEqual(createdTables, ['users', 'jobs', 'user_queue_state', 'user_kaggle_credentials']);
  assert.doesNotMatch(migrationSql, /\b(?:drop table|truncate|delete from jobs)\b/i);
  assert.match(migrationSql, /worker_run_id text/i);
  assert.match(migrationSql, /callback_token_hash text/i);
  assert.match(migrationSql, /callback_token_expires_at timestamptz/i);
  assert.match(migrationSql, /kaggle_kernel_ref text/i);
  assert.match(migrationSql, /storage_cleaned_at timestamptz/i);
  assert.match(migrationSql, /model_id text/i);
  assert.match(migrationSql, /language text/i);
  assert.match(migrationSql, /srt_object_key text/i);
  assert.match(migrationSql, /pause_after_current boolean/i);
  assert.match(migrationSql, /gpu_status text/i);
  assert.match(migrationSql, /'CANCEL_REQUESTED'/);
  assert.match(migrationSql, /'PAUSED'/);
  assert.doesNotMatch(migrationSql, /references\s+worker_runs/i);
});

test('database migrations have stable versions and checksums', async () => {
  const migrations = await loadMigrations();
  for (const migration of migrations) {
    assert.match(migration.version, /^\d+$/);
    assert.match(migration.checksum, /^[a-f0-9]{64}$/);
  }
  assert.equal(migrationChecksum('select 1;\r\n'), migrationChecksum('select 1;\n'));
});

test('deployment migration runs only for the production target', () => {
  assert.equal(shouldMigrateDuringBuild('production'), true);
  assert.equal(shouldMigrateDuringBuild('preview'), false);
  assert.equal(shouldMigrateDuringBuild(undefined), false);
});

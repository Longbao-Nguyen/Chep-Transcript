import type { Sql } from 'postgres';

import { createId } from '../../ids.js';
import {
  TERMINAL_JOB_STATUSES,
  type CancellationResult,
  type Job,
  type JobPatch,
  type JobRepository,
  type KaggleAuthMode,
  type KaggleCredentialsRecord,
  type KaggleCredentialsRepository,
  type KaggleGpuStatus,
  type ListJobOptions,
  type NewJob,
  type QueueRepository,
  type QueueState,
  type Repositories,
  type UpsertGoogleUserInput,
  type UpsertKaggleCredentialsInput,
  type User,
  type UserRepository,
  type UserSettings,
  type UserSettingsRepository,
  type WorkerRepository,
  type WorkerState,
} from '../../interface.js';
import { getPostgresClient } from './client.js';

type Row = Record<string, unknown>;

function asDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function asNullableDate(value: unknown): Date | null {
  return value == null ? null : asDate(value);
}

function mapUser(row: Row): User {
  return {
    id: String(row.id),
    email: String(row.email),
    displayName: row.display_name == null ? null : String(row.display_name),
    imageUrl: row.image_url == null ? null : String(row.image_url),
    createdAt: asDate(row.created_at),
    updatedAt: asDate(row.updated_at),
  };
}

function mapJob(row: Row): Job {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    originalFilename: String(row.original_filename),
    sourceObjectKey: String(row.source_object_key),
    outputObjectKey: row.output_object_key == null ? null : String(row.output_object_key),
    srtObjectKey: row.srt_object_key == null ? null : String(row.srt_object_key),
    contentType: String(row.content_type),
    fileSizeBytes: Number(row.file_size_bytes),
    modelId: row.model_id == null ? 'bofenghuang/whisper-large-v3-french-distil-dec16' : String(row.model_id),
    language: row.language == null ? 'fr' : String(row.language),
    status: row.status as Job['status'],
    progress: row.progress == null ? null : Number(row.progress),
    durationSec: row.duration_sec == null ? null : Number(row.duration_sec),
    processedAudioSec: row.processed_audio_sec == null ? null : Number(row.processed_audio_sec),
    errorCode: row.error_code == null ? null : String(row.error_code),
    errorMessage: row.error_message == null ? null : String(row.error_message),
    createdAt: asDate(row.created_at),
    updatedAt: asDate(row.updated_at),
    uploadCompletedAt: asNullableDate(row.upload_completed_at),
    startedAt: asNullableDate(row.started_at),
    completedAt: asNullableDate(row.completed_at),
    expiresAt: asNullableDate(row.expires_at),
    workerRunId: row.worker_run_id == null ? null : String(row.worker_run_id),
    callbackTokenHash: row.callback_token_hash == null ? null : String(row.callback_token_hash),
    callbackTokenExpiresAt: asNullableDate(row.callback_token_expires_at),
    kaggleKernelRef: row.kaggle_kernel_ref == null ? null : String(row.kaggle_kernel_ref),
    kaggleShard1Ref: row.kaggle_shard1_ref == null ? null : String(row.kaggle_shard1_ref),
    dualMode: Boolean(row.dual_mode),
    shard0Done: Boolean(row.shard0_done),
    shard1Done: Boolean(row.shard1_done),
    storageCleanedAt: asNullableDate(row.storage_cleaned_at),
  };
}

function mapKaggleCredentials(row: Row): KaggleCredentialsRecord {
  return {
    userId: String(row.user_id),
    authMode: row.auth_mode as KaggleAuthMode,
    kaggleUsername: row.kaggle_username == null ? null : String(row.kaggle_username),
    encryptedToken: String(row.encrypted_token),
    tokenIv: String(row.token_iv),
    tokenAuthTag: String(row.token_auth_tag),
    gpuStatus: (row.gpu_status ?? 'unchecked') as KaggleGpuStatus,
    gpuMessage: row.gpu_message == null ? null : String(row.gpu_message),
    gpuCheckedAt: asNullableDate(row.gpu_checked_at),
    gpuProbeRef: row.gpu_probe_ref == null ? null : String(row.gpu_probe_ref),
    connectedAt: asDate(row.connected_at),
    updatedAt: asDate(row.updated_at),
  };
}

class PostgresUserRepository implements UserRepository {
  constructor(private readonly sql: Sql) {}

  async getById(id: string): Promise<User | null> {
    const rows = await this.sql`select * from users where id = ${id} limit 1`;
    return rows[0] ? mapUser(rows[0] as Row) : null;
  }

  async getByEmail(email: string): Promise<User | null> {
    const rows = await this.sql`select * from users where lower(email) = lower(${email}) limit 1`;
    return rows[0] ? mapUser(rows[0] as Row) : null;
  }

  async upsertGoogleUser(input: UpsertGoogleUserInput): Promise<User> {
    const id = createId('usr');
    const rows = await this.sql`
      insert into users (id, email, google_subject, display_name, image_url)
      values (${id}, ${input.email.toLowerCase()}, ${input.googleSubject}, ${input.displayName ?? null}, ${input.imageUrl ?? null})
      on conflict (email) do update set
        google_subject = excluded.google_subject,
        display_name = excluded.display_name,
        image_url = excluded.image_url,
        updated_at = now()
      returning *
    `;
    return mapUser(rows[0] as Row);
  }

  async getOrCreateAnonymousUser(id: string): Promise<User> {
    const email = `${id}@anonymous.chep.local`;
    const googleSubject = `anon:${id}`;
    const rows = await this.sql`
      insert into users (id, email, google_subject, display_name, image_url)
      values (${id}, ${email}, ${googleSubject}, 'Anonymous Guest', null)
      on conflict (id) do update set
        updated_at = now()
      returning *
    `;
    return mapUser(rows[0] as Row);
  }
}

const PATCH_COLUMNS: Record<keyof JobPatch, string> = {
  status: 'status',
  progress: 'progress',
  durationSec: 'duration_sec',
  processedAudioSec: 'processed_audio_sec',
  outputObjectKey: 'output_object_key',
  srtObjectKey: 'srt_object_key',
  errorCode: 'error_code',
  errorMessage: 'error_message',
  uploadCompletedAt: 'upload_completed_at',
  startedAt: 'started_at',
  completedAt: 'completed_at',
  expiresAt: 'expires_at',
  workerRunId: 'worker_run_id',
  callbackTokenHash: 'callback_token_hash',
  callbackTokenExpiresAt: 'callback_token_expires_at',
  kaggleKernelRef: 'kaggle_kernel_ref',
  kaggleShard1Ref: 'kaggle_shard1_ref',
  dualMode: 'dual_mode',
  shard0Done: 'shard0_done',
  shard1Done: 'shard1_done',
  storageCleanedAt: 'storage_cleaned_at',
};

class PostgresJobRepository implements JobRepository {
  constructor(private readonly sql: Sql) {}

  async create(input: NewJob): Promise<Job> {
    const rows = await this.sql`
      insert into jobs (
        id, user_id, original_filename, source_object_key, content_type,
        file_size_bytes, model_id, language, status, progress
      ) values (
        ${input.id}, ${input.userId}, ${input.originalFilename}, ${input.sourceObjectKey},
        ${input.contentType}, ${input.fileSizeBytes}, ${input.modelId}, ${input.language}, ${input.status}, 0
      )
      returning *
    `;
    return mapJob(rows[0] as Row);
  }

  async getById(jobId: string): Promise<Job | null> {
    const rows = await this.sql`select * from jobs where id = ${jobId} limit 1`;
    return rows[0] ? mapJob(rows[0] as Row) : null;
  }

  async getByIdForUser(jobId: string, userId: string): Promise<Job | null> {
    const rows = await this.sql`select * from jobs where id = ${jobId} and user_id = ${userId} limit 1`;
    return rows[0] ? mapJob(rows[0] as Row) : null;
  }

  async listForUser(userId: string, options: ListJobOptions = {}): Promise<Job[]> {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 200);
    const rows = options.activeAndRecent === false
      ? await this.sql`select * from jobs where user_id = ${userId} order by created_at desc limit ${limit}`
      : await this.sql`
          select * from jobs
          where user_id = ${userId}
            and (
              status in ('CREATED', 'UPLOADING', 'QUEUED', 'PROCESSING', 'WORKER_STARTING', 'PREPROCESSING', 'TRANSCRIBING', 'FINALIZING', 'CANCEL_REQUESTED')
              or created_at >= now() - interval '7 days'
            )
          order by created_at desc
          limit ${limit}
        `;
    return rows.map((row) => mapJob(row as Row));
  }

  async updateForUser(jobId: string, userId: string, patch: JobPatch, expectedStatus?: Job['status']): Promise<Job | null> {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined) as [keyof JobPatch, unknown][];
    if (entries.length === 0) return this.getByIdForUser(jobId, userId);

    const update = Object.fromEntries(entries.map(([key, value]) => [PATCH_COLUMNS[key], value]));
    if (patch.status && TERMINAL_JOB_STATUSES.includes(patch.status)) {
      update.callback_token_hash = null;
      update.callback_token_expires_at = null;
    }
    update.updated_at = new Date();

    const rows = expectedStatus
      ? await this.sql`update jobs set ${this.sql(update)} where id = ${jobId} and user_id = ${userId} and status = ${expectedStatus} returning *`
      : await this.sql`update jobs set ${this.sql(update)} where id = ${jobId} and user_id = ${userId} returning *`;
    return rows[0] ? mapJob(rows[0] as Row) : null;
  }

  async claimNextQueuedJob(userId: string, workerRunId: string): Promise<Job | null> {
    return this.sql.begin(async (transaction) => {
      await transaction`insert into user_queue_state (user_id) values (${userId}) on conflict do nothing`;
      const queue = await transaction`select state from user_queue_state where user_id = ${userId} for update`;
      if (queue[0]?.state !== 'RUNNING') return null;
      const rows = await transaction`
        update jobs set
          status = 'WORKER_STARTING',
          worker_run_id = ${workerRunId},
          started_at = coalesce(started_at, now()),
          updated_at = now()
        where id = (
          select id from jobs
          where user_id = ${userId} and status = 'QUEUED'
          order by created_at asc
          for update skip locked
          limit 1
        )
        returning *
      `;
      return rows[0] ? mapJob(rows[0] as Row) : null;
    });
  }

  async startQueueAndClaimNextJob(userId: string, workerRunId: string): Promise<Job | null> {
    return this.sql.begin(async (transaction) => {
      await transaction`insert into user_queue_state (user_id) values (${userId}) on conflict do nothing`;
      const queue = await transaction`select state from user_queue_state where user_id = ${userId} for update`;
      const state = (queue[0]?.state ?? 'IDLE') as QueueState;
      if (state !== 'IDLE' && state !== 'PAUSED') return null;

      const rows = await transaction`
        update jobs set
          status = 'WORKER_STARTING',
          worker_run_id = ${workerRunId},
          started_at = coalesce(started_at, now()),
          updated_at = now()
        where id = (
          select id from jobs
          where user_id = ${userId} and status = 'QUEUED'
          order by created_at asc
          for update skip locked
          limit 1
        )
        returning *
      `;
      if (!rows[0]) return null;

      await transaction`
        update user_queue_state set state = 'RUNNING', updated_at = now()
        where user_id = ${userId}
      `;
      return mapJob(rows[0] as Row);
    });
  }

  async listStalledKaggleJobs(olderThan: Date): Promise<Job[]> {
    const rows = await this.sql`
      select * from jobs
      where status in ('WORKER_STARTING', 'PROCESSING', 'PREPROCESSING', 'TRANSCRIBING', 'FINALIZING', 'CANCEL_REQUESTED')
        and updated_at < ${olderThan}
        and kaggle_kernel_ref is not null
      order by updated_at asc
      limit 100
    `;
    return rows.map((row) => mapJob(row as Row));
  }

  async listAbandonedUploads(olderThan: Date): Promise<Job[]> {
    const rows = await this.sql`
      select * from jobs
      where status in ('CREATED', 'UPLOADING')
        and updated_at < ${olderThan}
        and storage_cleaned_at is null
      order by updated_at asc
      limit 100
    `;
    return rows.map((row) => mapJob(row as Row));
  }

  async listRetentionExpiredJobs(retentionCutoff: Date, now: Date): Promise<Job[]> {
    const rows = await this.sql`
      select * from jobs
      where storage_cleaned_at is null
        and (
          (status = 'COMPLETED' and ((expires_at is not null and expires_at <= ${now}) or coalesce(completed_at, updated_at) < ${retentionCutoff}))
          or (status in ('CANCELLED', 'EXPIRED', 'FAILED_UPLOAD', 'FAILED_WORKER_START', 'FAILED_MEDIA', 'FAILED_INFERENCE', 'FAILED_OUTPUT') and coalesce(completed_at, updated_at) < ${retentionCutoff})
        )
      order by updated_at asc
      limit 100
    `;
    return rows.map((row) => mapJob(row as Row));
  }

  async updateProgressForWorker(
    jobId: string,
    userId: string,
    workerRunId: string,
    patch: {
      status: 'PREPROCESSING' | 'TRANSCRIBING' | 'FINALIZING';
      progress?: number | null;
      durationSec?: number | null;
      processedAudioSec?: number | null;
    },
  ): Promise<Job | null> {
    const rows = await this.sql`
      update jobs set
        status = ${patch.status},
        progress = coalesce(${patch.progress ?? null}, progress),
        duration_sec = coalesce(${patch.durationSec ?? null}, duration_sec),
        processed_audio_sec = coalesce(${patch.processedAudioSec ?? null}, processed_audio_sec),
        updated_at = now()
      where id = ${jobId}
        and user_id = ${userId}
        and worker_run_id = ${workerRunId}
        and status in ('WORKER_STARTING', 'PROCESSING', 'PREPROCESSING', 'TRANSCRIBING', 'FINALIZING')
      returning *
    `;
    return rows[0] ? mapJob(rows[0] as Row) : null;
  }

  async failForWorker(
    jobId: string,
    userId: string,
    workerRunId: string,
    errorCode: 'FAILED_WORKER_START' | 'FAILED_MEDIA' | 'FAILED_INFERENCE' | 'FAILED_OUTPUT',
    errorMessage: string,
  ): Promise<Job | null> {
    return this.sql.begin(async (transaction) => {
      const queueRows = await transaction`select state from user_queue_state where user_id = ${userId} for update`;
      const rows = await transaction`
        update jobs set
          status = ${errorCode},
          error_code = ${errorCode},
          error_message = ${errorMessage},
          completed_at = now(),
          callback_token_hash = null,
          callback_token_expires_at = null,
          updated_at = now()
        where id = ${jobId}
          and user_id = ${userId}
          and worker_run_id = ${workerRunId}
          and status in ('WORKER_STARTING', 'PROCESSING', 'PREPROCESSING', 'TRANSCRIBING', 'FINALIZING', 'CANCEL_REQUESTED')
        returning *
      `;
      if (!rows[0]) return null;
      if (queueRows[0]?.state === 'RUNNING' || queueRows[0]?.state === 'PAUSING') {
        const queued = await transaction`select count(*)::int as count from jobs where user_id = ${userId} and status = 'QUEUED'`;
        const nextState: QueueState = Number(queued[0].count) > 0 ? 'PAUSED' : 'IDLE';
        await transaction`update user_queue_state set state = ${nextState}, pause_after_current = false, updated_at = now() where user_id = ${userId}`;
      }
      return mapJob(rows[0] as Row);
    });
  }

  async cancelForUser(jobId: string, userId: string): Promise<CancellationResult | null> {
    return this.sql.begin(async (transaction) => {
      await transaction`insert into user_queue_state (user_id) values (${userId}) on conflict do nothing`;
      const queueRows = await transaction`select state from user_queue_state where user_id = ${userId} for update`;
      const rows = await transaction`select * from jobs where id = ${jobId} and user_id = ${userId} for update`;
      if (!rows[0]) return null;
      const job = mapJob(rows[0] as Row);
      const queueState = queueRows[0].state as QueueState;
      if (job.status === 'CANCELLED' || job.status === 'CANCEL_REQUESTED') return { job, queueState };
      if (job.status === 'QUEUED') {
        const updated = await transaction`
          update jobs set
            status = 'CANCELLED',
            completed_at = now(),
            callback_token_hash = null,
            callback_token_expires_at = null,
            updated_at = now()
          where id = ${jobId}
          returning *
        `;
        return { job: mapJob(updated[0] as Row), queueState };
      }
      if (['PROCESSING', 'WORKER_STARTING', 'PREPROCESSING', 'TRANSCRIBING', 'FINALIZING'].includes(job.status)) {
        if (queueState !== 'RUNNING') throw new Error('Active job has no running queue.');
        const updated = await transaction`update jobs set status = 'CANCEL_REQUESTED', updated_at = now() where id = ${jobId} returning *`;
        await transaction`update user_queue_state set state = 'PAUSING', pause_after_current = false, updated_at = now() where user_id = ${userId}`;
        return { job: mapJob(updated[0] as Row), queueState: 'PAUSING' };
      }
      return { job, queueState };
    });
  }

  async retryForUser(jobId: string, userId: string): Promise<Job | null> {
    const rows = await this.sql`
      update jobs set
        status = 'QUEUED',
        progress = 0,
        duration_sec = null,
        processed_audio_sec = null,
        output_object_key = null,
        srt_object_key = null,
        error_code = null,
        error_message = null,
        started_at = null,
        completed_at = null,
        expires_at = null,
        worker_run_id = null,
        callback_token_hash = null,
        callback_token_expires_at = null,
        kaggle_kernel_ref = null,
        kaggle_shard1_ref = null,
        dual_mode = false,
        shard0_done = false,
        shard1_done = false,
        updated_at = now()
      where id = ${jobId}
        and user_id = ${userId}
        and status in ('FAILED_UPLOAD', 'FAILED_WORKER_START', 'FAILED_MEDIA', 'FAILED_INFERENCE', 'FAILED_OUTPUT', 'CANCELLED')
      returning *
    `;
    return rows[0] ? mapJob(rows[0] as Row) : null;
  }

  async deleteForUser(jobId: string, userId: string): Promise<Job | null> {
    const rows = await this.sql`
      delete from jobs
      where id = ${jobId}
        and user_id = ${userId}
        and status in ('COMPLETED', 'FAILED_UPLOAD', 'FAILED_WORKER_START', 'FAILED_MEDIA', 'FAILED_INFERENCE', 'FAILED_OUTPUT', 'CANCELLED', 'EXPIRED')
      returning *
    `;
    return rows[0] ? mapJob(rows[0] as Row) : null;
  }

  async acknowledgeCancellation(jobId: string, userId: string, workerRunId: string): Promise<CancellationResult | null> {
    return this.sql.begin(async (transaction) => {
      const queueRows = await transaction`select state from user_queue_state where user_id = ${userId} for update`;
      const rows = await transaction`select * from jobs where id = ${jobId} and user_id = ${userId} for update`;
      if (!rows[0]) return null;
      const job = mapJob(rows[0] as Row);
      const queueState = (queueRows[0]?.state ?? 'IDLE') as QueueState;
      if (job.workerRunId !== workerRunId || !workerRunId) return { job, queueState };
      if (job.status === 'CANCEL_REQUESTED' && queueState === 'PAUSING') {
        const updated = await transaction`
          update jobs set
            status = 'CANCELLED',
            completed_at = now(),
            callback_token_hash = null,
            callback_token_expires_at = null,
            updated_at = now()
          where id = ${jobId}
          returning *
        `;
        await transaction`update user_queue_state set state = 'PAUSED', pause_after_current = false, updated_at = now() where user_id = ${userId}`;
        return { job: mapJob(updated[0] as Row), queueState: 'PAUSED' };
      }
      return { job, queueState };
    });
  }

  async recordShardForWorker(
    jobId: string,
    userId: string,
    workerRunId: string,
    shardIndex: 0 | 1,
    durationSec?: number | null,
  ): Promise<Job | null> {
    return this.sql.begin(async (transaction) => {
      const rows = await transaction`
        update jobs set
          shard0_done = case when ${shardIndex} = 0 then true else shard0_done end,
          shard1_done = case when ${shardIndex} = 1 then true else shard1_done end,
          duration_sec = coalesce(${durationSec ?? null}, duration_sec),
          status = 'FINALIZING',
          progress = 0.96,
          updated_at = now()
        where id = ${jobId}
          and user_id = ${userId}
          and worker_run_id = ${workerRunId}
          and status in ('WORKER_STARTING', 'PROCESSING', 'PREPROCESSING', 'TRANSCRIBING', 'FINALIZING')
        returning *
      `;
      return rows[0] ? mapJob(rows[0] as Row) : null;
    });
  }

  async completeForWorker(
    jobId: string,
    userId: string,
    workerRunId: string,
    outputObjectKey: string,
    options?: {
      srtObjectKey?: string | null;
      expiresAt?: Date;
      durationSec?: number | null;
      processedAudioSec?: number | null;
    },
  ): Promise<Job | null> {
    return this.sql.begin(async (transaction) => {
      const queueRows = await transaction`select state, pause_after_current from user_queue_state where user_id = ${userId} for update`;
      if (queueRows[0]?.state !== 'RUNNING') return null;
      const pauseAfterCurrent = Boolean(queueRows[0]?.pause_after_current);
      const expiresAt = options?.expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000);
      const rows = await transaction`
        update jobs set
          status = 'COMPLETED',
          output_object_key = ${outputObjectKey},
          srt_object_key = ${options?.srtObjectKey ?? null},
          progress = 1,
          duration_sec = coalesce(${options?.durationSec ?? null}, duration_sec),
          processed_audio_sec = coalesce(${options?.processedAudioSec ?? null}, processed_audio_sec),
          completed_at = now(),
          expires_at = ${expiresAt},
          callback_token_hash = null,
          callback_token_expires_at = null,
          updated_at = now()
        where id = ${jobId} and user_id = ${userId} and worker_run_id = ${workerRunId}
          and status = 'FINALIZING'
        returning *
      `;
      if (!rows[0]) return null;
      const queued = await transaction`select count(*)::int as count from jobs where user_id = ${userId} and status = 'QUEUED'`;
      const queuedCount = Number(queued[0].count);
      if (pauseAfterCurrent || queuedCount === 0) {
        const nextState: QueueState = queuedCount > 0 ? 'PAUSED' : 'IDLE';
        await transaction`update user_queue_state set state = ${nextState}, pause_after_current = false, updated_at = now() where user_id = ${userId}`;
      }
      return mapJob(rows[0] as Row);
    });
  }
}

class PostgresQueueRepository implements QueueRepository {
  constructor(private readonly sql: Sql) {}

  async getStateForUser(userId: string): Promise<QueueState> {
    const rows = await this.sql`select state from user_queue_state where user_id = ${userId}`;
    return (rows[0]?.state ?? 'IDLE') as QueueState;
  }

  async setQueueState(userId: string, state: QueueState): Promise<void> {
    await this.sql`
      insert into user_queue_state (user_id, state)
      values (${userId}, ${state})
      on conflict (user_id) do update set
        state = excluded.state,
        updated_at = now()
    `;
  }

  async getPauseAfterCurrent(userId: string): Promise<boolean> {
    const rows = await this.sql`select pause_after_current from user_queue_state where user_id = ${userId}`;
    return Boolean(rows[0]?.pause_after_current);
  }

  async setPauseAfterCurrent(userId: string, value: boolean): Promise<boolean> {
    const rows = await this.sql`
      insert into user_queue_state (user_id, pause_after_current)
      values (${userId}, ${value})
      on conflict (user_id) do update set
        pause_after_current = excluded.pause_after_current,
        updated_at = now()
      returning pause_after_current
    `;
    return Boolean(rows[0]?.pause_after_current);
  }

  async countQueuedForUser(userId: string): Promise<number> {
    const rows = await this.sql`select count(*)::int as count from jobs where user_id = ${userId} and status = 'QUEUED'`;
    return Number(rows[0].count);
  }
}

class PostgresWorkerRepository implements WorkerRepository {
  constructor(private readonly sql: Sql) {}

  async getForUser(userId: string): Promise<WorkerState | null> {
    const rows = await this.sql`
      select * from worker_runs where user_id = ${userId} order by started_at desc limit 1
    `;
    const row = rows[0] as Row | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      userId: String(row.user_id),
      kaggleRunIdentifier: row.kaggle_run_identifier == null ? null : String(row.kaggle_run_identifier),
      status: String(row.status),
      startedAt: asDate(row.started_at),
      lastHeartbeatAt: asNullableDate(row.last_heartbeat_at),
      completedAt: asNullableDate(row.completed_at),
      errorMessage: row.error_message == null ? null : String(row.error_message),
    };
  }

  async upsertForUser(userId: string, state: WorkerState): Promise<void> {
    await this.sql`
      insert into worker_runs (
        id, user_id, kaggle_run_identifier, status, started_at,
        last_heartbeat_at, completed_at, error_message
      ) values (
        ${state.id}, ${userId}, ${state.kaggleRunIdentifier}, ${state.status}, ${state.startedAt},
        ${state.lastHeartbeatAt}, ${state.completedAt}, ${state.errorMessage}
      )
      on conflict (id) do update set
        kaggle_run_identifier = excluded.kaggle_run_identifier,
        status = excluded.status,
        last_heartbeat_at = excluded.last_heartbeat_at,
        completed_at = excluded.completed_at,
        error_message = excluded.error_message
    `;
  }
}

class PostgresUserSettingsRepository implements UserSettingsRepository {
  constructor(private readonly sql: Sql) {}

  async getForUser(userId: string): Promise<UserSettings> {
    const rows = await this.sql`
      insert into user_settings (user_id) values (${userId})
      on conflict (user_id) do update set user_id = excluded.user_id
      returning *
    `;
    return {
      userId,
      autoDownloadEnabled: Boolean(rows[0].auto_download_enabled),
      updatedAt: asDate(rows[0].updated_at),
    };
  }

  async updateForUser(userId: string, patch: Pick<UserSettings, 'autoDownloadEnabled'>): Promise<UserSettings> {
    const rows = await this.sql`
      insert into user_settings (user_id, auto_download_enabled)
      values (${userId}, ${patch.autoDownloadEnabled})
      on conflict (user_id) do update set
        auto_download_enabled = excluded.auto_download_enabled,
        updated_at = now()
      returning *
    `;
    return {
      userId,
      autoDownloadEnabled: Boolean(rows[0].auto_download_enabled),
      updatedAt: asDate(rows[0].updated_at),
    };
  }
}

class PostgresKaggleCredentialsRepository implements KaggleCredentialsRepository {
  constructor(private readonly sql: Sql) {}

  async getKaggleCredentials(userId: string): Promise<KaggleCredentialsRecord | null> {
    const rows = await this.sql`
      select * from user_kaggle_credentials where user_id = ${userId} limit 1
    `;
    return rows[0] ? mapKaggleCredentials(rows[0] as Row) : null;
  }

  async upsertKaggleCredentials(input: UpsertKaggleCredentialsInput): Promise<KaggleCredentialsRecord> {
    const rows = await this.sql`
      insert into user_kaggle_credentials (
        user_id, auth_mode, kaggle_username, encrypted_token, token_iv, token_auth_tag,
        gpu_status, gpu_message, gpu_checked_at, gpu_probe_ref
      ) values (
        ${input.userId}, ${input.authMode}, ${input.kaggleUsername},
        ${input.encryptedToken}, ${input.tokenIv}, ${input.tokenAuthTag},
        'unchecked', null, null, null
      )
      on conflict (user_id) do update set
        auth_mode = excluded.auth_mode,
        kaggle_username = excluded.kaggle_username,
        encrypted_token = excluded.encrypted_token,
        token_iv = excluded.token_iv,
        token_auth_tag = excluded.token_auth_tag,
        gpu_status = 'unchecked',
        gpu_message = null,
        gpu_checked_at = null,
        gpu_probe_ref = null,
        updated_at = now()
      returning *
    `;
    return mapKaggleCredentials(rows[0] as Row);
  }

  async updateGpuCheck(
    userId: string,
    patch: {
      gpuStatus: KaggleGpuStatus;
      gpuMessage: string | null;
      gpuCheckedAt?: Date | null;
      gpuProbeRef?: string | null;
    },
  ): Promise<KaggleCredentialsRecord | null> {
    const rows = await this.sql`
      update user_kaggle_credentials set
        gpu_status = ${patch.gpuStatus},
        gpu_message = ${patch.gpuMessage},
        gpu_checked_at = ${patch.gpuCheckedAt ?? null},
        gpu_probe_ref = ${patch.gpuProbeRef ?? null},
        updated_at = now()
      where user_id = ${userId}
      returning *
    `;
    return rows[0] ? mapKaggleCredentials(rows[0] as Row) : null;
  }

  async deleteKaggleCredentials(userId: string): Promise<void> {
    await this.sql`delete from user_kaggle_credentials where user_id = ${userId}`;
  }
}

export function createPostgresRepositories(sql = getPostgresClient()): Repositories {
  return {
    users: new PostgresUserRepository(sql),
    jobs: new PostgresJobRepository(sql),
    queue: new PostgresQueueRepository(sql),
    workers: new PostgresWorkerRepository(sql),
    settings: new PostgresUserSettingsRepository(sql),
    kaggleCredentials: new PostgresKaggleCredentialsRepository(sql),
  };
}

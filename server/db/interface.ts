export const JOB_STATUSES = [
  'CREATED',
  'UPLOADING',
  'QUEUED',
  'PROCESSING',
  'WORKER_STARTING',
  'PREPROCESSING',
  'TRANSCRIBING',
  'FINALIZING',
  'CANCEL_REQUESTED',
  'COMPLETED',
  'FAILED_UPLOAD',
  'FAILED_WORKER_START',
  'FAILED_MEDIA',
  'FAILED_INFERENCE',
  'FAILED_OUTPUT',
  'CANCELLED',
  'EXPIRED',
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];
export type QueueState = 'IDLE' | 'RUNNING' | 'PAUSING' | 'PAUSED';
export type KaggleAuthMode = 'api_token' | 'oauth2';
export type KaggleGpuStatus = 'unchecked' | 'checking' | 'ready' | 'error';
export interface CancellationResult { job: Job; queueState: QueueState; }

export const ACTIVE_JOB_STATUSES: readonly JobStatus[] = [
  'CREATED',
  'UPLOADING',
  'QUEUED',
  'PROCESSING',
  'WORKER_STARTING',
  'PREPROCESSING',
  'TRANSCRIBING',
  'FINALIZING',
  'CANCEL_REQUESTED',
];

export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = [
  'COMPLETED',
  'FAILED_UPLOAD',
  'FAILED_WORKER_START',
  'FAILED_MEDIA',
  'FAILED_INFERENCE',
  'FAILED_OUTPUT',
  'CANCELLED',
  'EXPIRED',
];

export interface User {
  id: string;
  email: string;
  displayName: string | null;
  imageUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertGoogleUserInput {
  email: string;
  googleSubject: string;
  displayName?: string | null;
  imageUrl?: string | null;
}

export interface Job {
  id: string;
  userId: string;
  originalFilename: string;
  sourceObjectKey: string;
  outputObjectKey: string | null;
  srtObjectKey: string | null;
  contentType: string;
  fileSizeBytes: number;
  modelId: string;
  language: string;
  status: JobStatus;
  progress: number | null;
  durationSec: number | null;
  processedAudioSec: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
  uploadCompletedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  expiresAt: Date | null;
  workerRunId: string | null;
  callbackTokenHash: string | null;
  callbackTokenExpiresAt: Date | null;
  kaggleKernelRef: string | null;
  kaggleShard1Ref: string | null;
  dualMode: boolean;
  shard0Done: boolean;
  shard1Done: boolean;
  storageCleanedAt: Date | null;
}

export interface NewJob {
  id: string;
  userId: string;
  originalFilename: string;
  sourceObjectKey: string;
  contentType: string;
  fileSizeBytes: number;
  modelId: string;
  language: string;
  status: 'CREATED' | 'UPLOADING';
}

export interface JobPatch {
  status?: JobStatus;
  progress?: number | null;
  durationSec?: number | null;
  processedAudioSec?: number | null;
  outputObjectKey?: string | null;
  srtObjectKey?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  uploadCompletedAt?: Date | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
  expiresAt?: Date | null;
  workerRunId?: string | null;
  callbackTokenHash?: string | null;
  callbackTokenExpiresAt?: Date | null;
  kaggleKernelRef?: string | null;
  kaggleShard1Ref?: string | null;
  dualMode?: boolean;
  shard0Done?: boolean;
  shard1Done?: boolean;
  storageCleanedAt?: Date | null;
}

export interface ListJobOptions {
  limit?: number;
  activeAndRecent?: boolean;
}

export interface WorkerState {
  id: string;
  userId: string;
  kaggleRunIdentifier: string | null;
  status: string;
  startedAt: Date;
  lastHeartbeatAt: Date | null;
  completedAt: Date | null;
  errorMessage: string | null;
}

export interface UserSettings {
  userId: string;
  autoDownloadEnabled: boolean;
  updatedAt: Date;
}

export interface KaggleCredentialsRecord {
  userId: string;
  authMode: KaggleAuthMode;
  kaggleUsername: string | null;
  encryptedToken: string;
  tokenIv: string;
  tokenAuthTag: string;
  gpuStatus: KaggleGpuStatus;
  gpuMessage: string | null;
  gpuCheckedAt: Date | null;
  gpuProbeRef: string | null;
  connectedAt: Date;
  updatedAt: Date;
}

export interface UpsertKaggleCredentialsInput {
  userId: string;
  authMode: KaggleAuthMode;
  kaggleUsername: string | null;
  encryptedToken: string;
  tokenIv: string;
  tokenAuthTag: string;
}

export interface UserRepository {
  getById(id: string): Promise<User | null>;
  getByEmail(email: string): Promise<User | null>;
  upsertGoogleUser(input: UpsertGoogleUserInput): Promise<User>;
  getOrCreateAnonymousUser(id: string): Promise<User>;
}

export interface JobRepository {
  create(input: NewJob): Promise<Job>;
  getById(jobId: string): Promise<Job | null>;
  getByIdForUser(jobId: string, userId: string): Promise<Job | null>;
  listForUser(userId: string, options?: ListJobOptions): Promise<Job[]>;
  updateForUser(jobId: string, userId: string, patch: JobPatch, expectedStatus?: JobStatus): Promise<Job | null>;
  claimNextQueuedJob(userId: string, workerRunId: string): Promise<Job | null>;
  startQueueAndClaimNextJob(userId: string, workerRunId: string): Promise<Job | null>;
  listStalledKaggleJobs(olderThan: Date): Promise<Job[]>;
  listAbandonedUploads(olderThan: Date): Promise<Job[]>;
  listRetentionExpiredJobs(retentionCutoff: Date, now: Date): Promise<Job[]>;
  updateProgressForWorker(
    jobId: string,
    userId: string,
    workerRunId: string,
    patch: {
      status: 'PREPROCESSING' | 'TRANSCRIBING' | 'FINALIZING';
      progress?: number | null;
      durationSec?: number | null;
      processedAudioSec?: number | null;
    },
  ): Promise<Job | null>;
  failForWorker(
    jobId: string,
    userId: string,
    workerRunId: string,
    errorCode: 'FAILED_WORKER_START' | 'FAILED_MEDIA' | 'FAILED_INFERENCE' | 'FAILED_OUTPUT',
    errorMessage: string,
  ): Promise<Job | null>;
  cancelForUser(jobId: string, userId: string): Promise<CancellationResult | null>;
  retryForUser(jobId: string, userId: string): Promise<Job | null>;
  deleteForUser(jobId: string, userId: string): Promise<Job | null>;
  acknowledgeCancellation(jobId: string, userId: string, workerRunId: string): Promise<CancellationResult | null>;
  recordShardForWorker(
    jobId: string,
    userId: string,
    workerRunId: string,
    shardIndex: 0 | 1,
    durationSec?: number | null,
  ): Promise<Job | null>;
  completeForWorker(
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
  ): Promise<Job | null>;
}

export interface QueueRepository {
  getStateForUser(userId: string): Promise<QueueState>;
  setQueueState(userId: string, state: QueueState): Promise<void>;
  getPauseAfterCurrent(userId: string): Promise<boolean>;
  setPauseAfterCurrent(userId: string, value: boolean): Promise<boolean>;
  countQueuedForUser(userId: string): Promise<number>;
}

export interface WorkerRepository {
  getForUser(userId: string): Promise<WorkerState | null>;
  upsertForUser(userId: string, state: WorkerState): Promise<void>;
}

export interface UserSettingsRepository {
  getForUser(userId: string): Promise<UserSettings>;
  updateForUser(userId: string, patch: Pick<UserSettings, 'autoDownloadEnabled'>): Promise<UserSettings>;
}

export interface KaggleCredentialsRepository {
  getKaggleCredentials(userId: string): Promise<KaggleCredentialsRecord | null>;
  upsertKaggleCredentials(input: UpsertKaggleCredentialsInput): Promise<KaggleCredentialsRecord>;
  updateGpuCheck(
    userId: string,
    patch: {
      gpuStatus: KaggleGpuStatus;
      gpuMessage: string | null;
      gpuCheckedAt?: Date | null;
      gpuProbeRef?: string | null;
    },
  ): Promise<KaggleCredentialsRecord | null>;
  deleteKaggleCredentials(userId: string): Promise<void>;
}

export interface Repositories {
  users: UserRepository;
  jobs: JobRepository;
  queue: QueueRepository;
  workers: WorkerRepository;
  settings: UserSettingsRepository;
  kaggleCredentials: KaggleCredentialsRepository;
}

import { requireUser } from '../../../server/auth/session.js';
import { getRepositories } from '../../../server/db/index.js';
import type { JobStatus } from '../../../server/db/interface.js';
import { HttpError, extractPathId, jsonResponse, route } from '../../../server/http/responses.js';
import { finalizeJobCancellation } from '../../../server/jobs/cancel.js';
import { toClientJob } from '../../../server/jobs/public.js';
import { getKaggleAuthContextForUser } from '../../../server/kaggle/auth.js';
import { deleteKernel } from '../../../server/kaggle/client.js';
import { attachmentContentDisposition, createDownloadFilename } from '../../../server/storage/downloads.js';
import { getObjectStorage } from '../../../server/storage/index.js';
import { deleteSourceMedia } from '../../../server/storage/job-objects.js';

const RETRYABLE_STATUSES = new Set<JobStatus>([
  'FAILED_UPLOAD',
  'FAILED_WORKER_START',
  'FAILED_MEDIA',
  'FAILED_INFERENCE',
  'FAILED_OUTPUT',
  'CANCELLED',
]);

const MAX_PREVIEW_BYTES = 5 * 1024 * 1024;

async function readStreamText(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (total + value.byteLength > maxBytes) {
        const remaining = maxBytes - total;
        if (remaining > 0) chunks.push(value.subarray(0, remaining));
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks));
}

export const POST = route(async (request) => {
  const user = await requireUser(request);
  const pathname = new URL(request.url).pathname;
  const repositories = await getRepositories();

  if (pathname.endsWith('/cancel')) {
    const jobId = extractPathId(pathname, '/api/jobs/', '/cancel');
    const result = await repositories.jobs.cancelForUser(jobId, user.id);
    if (!result) throw new HttpError(404, 'Job not found.', 'JOB_NOT_FOUND');
    if (result.job.status === 'COMPLETED') {
      throw new HttpError(409, 'This job has already completed.', 'JOB_ALREADY_COMPLETED');
    }
    if (result.job.status !== 'CANCELLED' && result.job.status !== 'CANCEL_REQUESTED') {
      throw new HttpError(409, 'This job cannot be cancelled.', 'JOB_NOT_CANCELLABLE');
    }
    if (result.job.status === 'CANCELLED') {
      await deleteSourceMedia(result.job);
    } else if (result.job.status === 'CANCEL_REQUESTED') {
      let allStopped = false;
      const refs = [result.job.kaggleKernelRef, result.job.kaggleShard1Ref].filter(
        (ref): ref is string => Boolean(ref),
      );
      if (refs.length === 0) {
        allStopped = true;
      } else {
        try {
          const auth = await getKaggleAuthContextForUser(user.id, repositories);
          const outcomes = await Promise.all(
            refs.map(async (ref) => {
              try {
                await deleteKernel(auth.headers, ref, { fallbackOwner: auth.username });
                return true;
              } catch {
                return false;
              }
            }),
          );
          allStopped = outcomes.every(Boolean);
        } catch {
          // Durable cancellation state remains recorded even if remote stop cannot be reached immediately.
        }
      }

      if (allStopped) {
        const finalized = await finalizeJobCancellation(result.job, user.id, repositories);
        return jsonResponse({ jobId, status: finalized.status, queueState: finalized.queueState });
      }
    }
    return jsonResponse({ jobId, status: result.job.status, queueState: result.queueState });
  }

  if (pathname.endsWith('/retry')) {
    const jobId = extractPathId(pathname, '/api/jobs/', '/retry');
    const job = await repositories.jobs.getByIdForUser(jobId, user.id);
    if (!job) throw new HttpError(404, 'Job not found.', 'JOB_NOT_FOUND');
    if (!RETRYABLE_STATUSES.has(job.status)) {
      throw new HttpError(409, 'Only failed or cancelled jobs can be retried.', 'JOB_NOT_RETRYABLE');
    }

    const sourceExists = await getObjectStorage().headObject(job.sourceObjectKey);
    if (!sourceExists) {
      throw new HttpError(
        409,
        'The uploaded source audio has already been cleaned up. Please upload the file again.',
        'SOURCE_MEDIA_EXPIRED',
      );
    }

    const retried = await repositories.jobs.retryForUser(jobId, user.id);
    if (!retried) {
      throw new HttpError(409, 'Job could not be queued for retry.', 'JOB_NOT_RETRYABLE');
    }
    return jsonResponse({ job: toClientJob(retried) });
  }

  throw new HttpError(404, 'Job action not found.', 'NOT_FOUND');
});

export const GET = route(async (request) => {
  const user = await requireUser(request);
  const url = new URL(request.url);
  const pathname = url.pathname;
  const repositories = await getRepositories();

  if (pathname.endsWith('/preview')) {
    const jobId = extractPathId(pathname, '/api/jobs/', '/preview');
    const job = await repositories.jobs.getByIdForUser(jobId, user.id);
    if (!job) throw new HttpError(404, 'Job not found.', 'JOB_NOT_FOUND');
    if (job.status === 'EXPIRED' || (job.expiresAt && job.expiresAt.getTime() <= Date.now())) {
      throw new HttpError(410, 'This transcript has expired.', 'TRANSCRIPT_EXPIRED');
    }
    if (job.status !== 'COMPLETED' || !job.outputObjectKey) {
      throw new HttpError(409, 'Transcript is not ready for preview.', 'TRANSCRIPT_NOT_READY');
    }
    const object = await getObjectStorage().getPrivateObject(job.outputObjectKey);
    if (!object) throw new HttpError(404, 'Transcript file was not found.', 'TRANSCRIPT_NOT_FOUND');
    const text = await readStreamText(object.stream, MAX_PREVIEW_BYTES);
    return jsonResponse({
      jobId: job.id,
      filename: job.originalFilename,
      text,
      truncated: object.size > MAX_PREVIEW_BYTES,
      hasSrt: Boolean(job.srtObjectKey),
    });
  }

  if (pathname.endsWith('/download')) {
    const jobId = extractPathId(pathname, '/api/jobs/', '/download');
    const formatParam = url.searchParams.get('format')?.toLowerCase();
    const format: 'txt' | 'srt' = formatParam === 'srt' ? 'srt' : 'txt';
    if (formatParam && formatParam !== 'txt' && formatParam !== 'srt') {
      throw new HttpError(400, 'Unsupported download format. Use txt or srt.', 'INVALID_FORMAT');
    }

    const job = await repositories.jobs.getByIdForUser(jobId, user.id);
    if (!job) throw new HttpError(404, 'Job not found.', 'JOB_NOT_FOUND');
    if (job.status === 'EXPIRED' || (job.expiresAt && job.expiresAt.getTime() <= Date.now())) {
      throw new HttpError(410, 'This transcript has expired.', 'TRANSCRIPT_EXPIRED');
    }
    const objectKey = format === 'srt' ? job.srtObjectKey : job.outputObjectKey;
    if (job.status !== 'COMPLETED' || !objectKey) {
      throw new HttpError(
        format === 'srt' ? 404 : 409,
        format === 'srt' ? 'SRT subtitle file is not available for this job.' : 'Transcript is not ready for download.',
        format === 'srt' ? 'SUBTITLE_NOT_AVAILABLE' : 'TRANSCRIPT_NOT_READY',
      );
    }

    const object = await getObjectStorage().getPrivateObject(objectKey);
    if (!object) throw new HttpError(404, 'Transcript file was not found.', 'TRANSCRIPT_NOT_FOUND');

    return new Response(object.stream, {
      status: 200,
      headers: {
        'Cache-Control': 'private, no-store, max-age=0',
        'Content-Disposition': attachmentContentDisposition(createDownloadFilename(job.originalFilename, format)),
        'Content-Length': String(object.size),
        'Content-Type': object.contentType || 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }

  throw new HttpError(404, 'Job action not found.', 'NOT_FOUND');
});

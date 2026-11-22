import { requireUser } from '../../server/auth/session.js';
import { getRepositories } from '../../server/db/index.js';
import { TERMINAL_JOB_STATUSES } from '../../server/db/interface.js';
import { HttpError, extractPathId, jsonResponse, route } from '../../server/http/responses.js';
import { toClientJob } from '../../server/jobs/public.js';
import { deleteSourceMedia, deleteTranscriptArtifact } from '../../server/storage/job-objects.js';

export const GET = route(async (request) => {
  const user = await requireUser(request);
  const jobId = extractPathId(new URL(request.url).pathname, '/api/jobs/');
  const repositories = await getRepositories();
  const job = await repositories.jobs.getByIdForUser(jobId, user.id);
  if (!job) throw new HttpError(404, 'Job not found.', 'JOB_NOT_FOUND');
  return jsonResponse({ job: toClientJob(job) });
});

export const DELETE = route(async (request) => {
  const user = await requireUser(request);
  const jobId = extractPathId(new URL(request.url).pathname, '/api/jobs/');
  const repositories = await getRepositories();
  const job = await repositories.jobs.getByIdForUser(jobId, user.id);
  if (!job) throw new HttpError(404, 'Job not found.', 'JOB_NOT_FOUND');
  if (!TERMINAL_JOB_STATUSES.includes(job.status)) {
    throw new HttpError(409, 'Active jobs must be cancelled before deletion.', 'JOB_STILL_ACTIVE');
  }

  await deleteSourceMedia(job).catch(() => undefined);
  await deleteTranscriptArtifact(job).catch(() => undefined);

  const deleted = await repositories.jobs.deleteForUser(jobId, user.id);
  if (!deleted) {
    throw new HttpError(409, 'Job could not be deleted in its current state.', 'JOB_NOT_DELETABLE');
  }
  return jsonResponse({ deleted: true, jobId });
});

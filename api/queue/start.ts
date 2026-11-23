import { requireUser } from '../../server/auth/session.js';
import { getRepositories } from '../../server/db/index.js';
import { HttpError, jsonResponse, readJson, route } from '../../server/http/responses.js';
import { dispatchNextQueuedJob, resolveCallbackBaseUrl } from '../../server/jobs/dispatcher.js';
import { getObjectStorage } from '../../server/storage/index.js';

export const POST = route(async (request) => {
  const user = await requireUser(request);
  const repositories = await getRepositories();
  const [state, count] = await Promise.all([
    repositories.queue.getStateForUser(user.id),
    repositories.queue.countQueuedForUser(user.id),
  ]);

  if (state === 'PAUSING') throw new HttpError(409, 'Stopping current worker.', 'QUEUE_PAUSING');
  if (state === 'RUNNING') throw new HttpError(409, 'Queue is already running.', 'QUEUE_RUNNING');
  if (count === 0) throw new HttpError(409, 'No queued jobs remain.', 'QUEUE_EMPTY');

  const callbackBaseUrl = resolveCallbackBaseUrl(request.url);
  const result = await dispatchNextQueuedJob({
    userId: user.id,
    repositories,
    storage: getObjectStorage(),
    callbackBaseUrl,
  });

  if (result) {
    console.info('kaggle_job_dispatched', {
      jobId: result.jobId,
      kernelRef: result.kernelRef,
      callbackBaseUrl,
    });
  }

  return jsonResponse({
    ...result,
    queueState: 'RUNNING',
  });
});

export const PATCH = route(async (request) => {
  const user = await requireUser(request);
  const body = await readJson<{ pauseAfterCurrent?: unknown }>(request);
  if (typeof body.pauseAfterCurrent !== 'boolean') {
    throw new HttpError(400, 'pauseAfterCurrent must be a boolean.', 'INVALID_PAUSE_SETTING');
  }
  const repositories = await getRepositories();
  const pauseAfterCurrent = await repositories.queue.setPauseAfterCurrent(user.id, body.pauseAfterCurrent);
  return jsonResponse({ pauseAfterCurrent });
});

import { requireUser } from '../../server/auth/session.js';
import { createId } from '../../server/db/ids.js';
import { getRepositories } from '../../server/db/index.js';
import { HttpError, extractPathId, jsonResponse, readJson, route } from '../../server/http/responses.js';
import { assertJobTransition } from '../../server/jobs/state.js';
import { getObjectStorage } from '../../server/storage/index.js';
import { createSourceObjectPathname } from '../../server/storage/pathnames.js';
import { createDirectUploadGrant, getRequestedUploadJobId } from '../../server/uploads/direct-upload.js';
import { validateUploadInit } from '../../server/uploads/validation.js';

export const POST = route(async (request) => {
  const action = extractPathId(new URL(request.url).pathname, '/api/uploads/');

  if (action === 'init') {
    const user = await requireUser(request);
    const input = validateUploadInit(await readJson<unknown>(request));
    const jobId = createId('job');
    const sourceObjectKey = createSourceObjectPathname(user.id, jobId, input.filename);
    const repositories = await getRepositories();

    const job = await repositories.jobs.create({
      id: jobId,
      userId: user.id,
      originalFilename: input.filename,
      sourceObjectKey,
      contentType: input.contentType,
      fileSizeBytes: input.size,
      modelId: input.modelId,
      language: input.language,
      status: 'CREATED',
    });

    try {
      getObjectStorage().assertConfigured();
      assertJobTransition(job.status, 'UPLOADING');
      await repositories.jobs.updateForUser(jobId, user.id, { status: 'UPLOADING' });
      return jsonResponse({ jobId, uploadPathname: sourceObjectKey }, { status: 201 });
    } catch {
      assertJobTransition(job.status, 'FAILED_UPLOAD');
      await repositories.jobs.updateForUser(jobId, user.id, {
        status: 'FAILED_UPLOAD',
        errorCode: 'UPLOAD_INIT_FAILED',
        errorMessage: 'Could not prepare object storage upload.',
      });
      throw new HttpError(503, 'Could not prepare the upload. Please retry.', 'UPLOAD_INIT_FAILED');
    }
  }

  if (action === 'blob' || action === 'direct') {
    const body = await readJson<unknown>(request);
    const storage = getObjectStorage();
    const result = await storage.handleDirectUploadRequest(body, async (uploadRequest) => {
      const user = await requireUser(request);
      const jobId = getRequestedUploadJobId(uploadRequest.clientPayload);
      const repositories = await getRepositories();
      const job = await repositories.jobs.getByIdForUser(jobId, user.id);
      if (!job) throw new HttpError(404, 'Job not found.', 'JOB_NOT_FOUND');
      return createDirectUploadGrant(uploadRequest, job, user.id);
    });

    return jsonResponse(result);
  }

  throw new HttpError(404, 'Upload endpoint not found.', 'NOT_FOUND');
});

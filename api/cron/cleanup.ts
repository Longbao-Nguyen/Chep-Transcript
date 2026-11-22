import { getRepositories } from '../../server/db/index.js';
import { jsonResponse, route } from '../../server/http/responses.js';
import { runCleanupJob, verifyCronAuthorization } from '../../server/jobs/cleanup.js';
import { getObjectStorage } from '../../server/storage/index.js';

export const GET = route(async (request) => {
  verifyCronAuthorization(request);
  const [repositories, storage] = await Promise.all([
    getRepositories(),
    Promise.resolve(getObjectStorage()),
  ]);
  const summary = await runCleanupJob({ repositories, storage });
  return jsonResponse(summary);
});

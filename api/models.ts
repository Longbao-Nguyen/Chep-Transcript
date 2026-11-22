import { jsonResponse, route } from '../server/http/responses.js';
import { getPublicModelCatalog } from '../server/models/catalog.js';

export const GET = route(async () => {
  return jsonResponse(getPublicModelCatalog());
});

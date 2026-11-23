import { HttpError } from '../http/responses.js';

const DEFAULT_KAGGLE_API_BASE_URL = 'https://www.kaggle.com/api/v1';

export interface KaggleClientOptions {
  fetchFn?: typeof fetch;
  baseUrl?: string;
  fallbackOwner?: string | null;
}

export interface VerifyCredentialsResult {
  valid: boolean;
  username: string | null;
  error?: string;
}

export interface PushKernelInput {
  slug: string;
  title?: string;
  notebook: Record<string, unknown>;
  datasetDataSources?: string[];
  enableGpu?: boolean;
  enableInternet?: boolean;
  accelerator?: string;
}

export interface PushKernelResult {
  ref: string;
  url: string | null;
  versionNumber: number | null;
}

export type NormalizedKernelStatus =
  | 'queued'
  | 'running'
  | 'complete'
  | 'error'
  | 'cancelAcknowledged'
  | 'unknown';

export interface KernelStatusResult {
  status: NormalizedKernelStatus;
  rawStatus: string | null;
  failureMessage: string | null;
}

export interface CancelKernelResult {
  cancelled: boolean;
  method: 'cancel' | 'delete';
}

export interface DeleteKernelResult {
  deleted: boolean;
}

function splitKernelRef(kernelRef: string, fallbackOwner?: string | null): { owner: string; slug: string } {
  let normalized = kernelRef.trim();
  normalized = normalized.replace(/^https?:\/\/(?:www\.)?kaggle\.com\//i, '');
  normalized = normalized.replace(/^\/+|\/+$/g, '');
  normalized = normalized.replace(/^(?:code|kernels)\//i, '');

  const parts = normalized.split('/').filter(Boolean);
  let owner: string;
  let slug: string;
  if (parts.length === 1 && fallbackOwner && /^[a-zA-Z0-9_-]+$/.test(fallbackOwner.trim())) {
    owner = fallbackOwner.trim();
    slug = parts[0];
  } else if (parts.length === 2) {
    [owner, slug] = parts;
  } else {
    throw new HttpError(400, 'Invalid Kaggle kernel reference.', 'INVALID_KERNEL_REF');
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(owner) || !/^[a-zA-Z0-9_-]+$/.test(slug)) {
    throw new HttpError(400, 'Invalid Kaggle kernel reference.', 'INVALID_KERNEL_REF');
  }
  return { owner, slug };
}

function getFetch(options: KaggleClientOptions): typeof fetch {
  return options.fetchFn ?? globalThis.fetch;
}

function getBaseUrl(options: KaggleClientOptions): string {
  return (options.baseUrl ?? DEFAULT_KAGGLE_API_BASE_URL).replace(/\/+$/, '');
}

async function readJsonSafe(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function extractSafeKaggleError(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const candidate = payload as { message?: unknown; error?: unknown };
  const raw = typeof candidate.message === 'string'
    ? candidate.message
    : typeof candidate.error === 'string'
      ? candidate.error
      : '';
  const cleaned = raw.replace(/[\r\n\t]+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, 200) : null;
}

function extractUsernameFromPayload(payload: unknown): string | null {
  if (!payload) return null;
  if (Array.isArray(payload)) {
    if (payload.length === 0) return null;
    const first = payload[0] as { ref?: unknown; author?: unknown };
    if (typeof first.ref === 'string' && first.ref.includes('/')) {
      const owner = first.ref.split('/')[0]?.trim();
      if (owner) return owner;
    }
    if (typeof first.author === 'string' && first.author.trim()) {
      return first.author.trim();
    }
    return null;
  }
  if (typeof payload === 'object') {
    const obj = payload as { userName?: unknown; username?: unknown; user_name?: unknown };
    for (const candidate of [obj.userName, obj.username, obj.user_name]) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim();
      }
    }
  }
  return null;
}

export function normalizeKaggleKernelStatus(raw: unknown): NormalizedKernelStatus {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    if (raw === 1) return 'queued';
    if (raw === 2) return 'running';
    if (raw === 3) return 'complete';
    if (raw === 4) return 'error';
    if (raw === 6) return 'cancelAcknowledged';
    return 'unknown';
  }
  if (typeof raw !== 'string' || !raw.trim()) return 'unknown';
  const cleaned = raw
    .trim()
    .replace(/^KernelWorkerStatus\./i, '')
    .replace(/^KERNEL_WORKER_STATUS_/i, '')
    .toLowerCase();
  if (cleaned === 'queued' || cleaned === 'pending') return 'queued';
  if (cleaned === 'running') return 'running';
  if (cleaned === 'complete' || cleaned === 'completed') return 'complete';
  if (cleaned === 'error' || cleaned === 'failed') return 'error';
  if (
    cleaned === 'cancelacknowledged'
    || cleaned === 'cancel_acknowledged'
    || cleaned === 'cancelled'
    || cleaned === 'canceled'
  ) {
    return 'cancelAcknowledged';
  }
  return 'unknown';
}

export async function verifyCredentials(
  headers: Record<string, string>,
  expectedUsername?: string | null,
  options: KaggleClientOptions = {},
): Promise<VerifyCredentialsResult> {
  const fetchFn = getFetch(options);
  const baseUrl = getBaseUrl(options);
  const helloUrl = `${baseUrl}/hello`;

  let helloResponse: Response;
  try {
    helloResponse = await fetchFn(helloUrl, {
      method: 'GET',
      headers: { ...headers, Accept: 'application/json' },
    });
  } catch {
    throw new HttpError(502, 'Could not reach Kaggle API to verify credentials.', 'KAGGLE_API_UNAVAILABLE');
  }

  if (helloResponse.status === 401 || helloResponse.status === 403) {
    return {
      valid: false,
      username: null,
      error: 'Kaggle rejected these API credentials. Check your token and try again.',
    };
  }

  if (helloResponse.ok) {
    const payload = await readJsonSafe(helloResponse);
    let inferredUsername: string | null = expectedUsername ?? extractUsernameFromPayload(payload);

    if (!inferredUsername) {
      try {
        const listResponse = await fetchFn(`${baseUrl}/kernels/list?group=profile&pageSize=1`, {
          method: 'GET',
          headers: { ...headers, Accept: 'application/json' },
        });
        if (listResponse.ok) {
          inferredUsername = extractUsernameFromPayload(await readJsonSafe(listResponse));
        }
      } catch {
        // Best-effort secondary username lookup; /hello already authenticated the token.
      }
    }

    return {
      valid: true,
      username: inferredUsername,
    };
  }

  if (helloResponse.status !== 404 && helloResponse.status !== 405) {
    const detail = extractSafeKaggleError(await readJsonSafe(helloResponse));
    throw new HttpError(
      502,
      detail
        ? `Kaggle API returned status ${helloResponse.status}: ${detail}`
        : `Kaggle API returned status ${helloResponse.status}.`,
      'KAGGLE_API_UNAVAILABLE',
    );
  }

  let listResponse: Response;
  try {
    listResponse = await fetchFn(`${baseUrl}/kernels/list?group=profile&pageSize=1`, {
      method: 'GET',
      headers: { ...headers, Accept: 'application/json' },
    });
  } catch {
    throw new HttpError(502, 'Could not reach Kaggle API to verify credentials.', 'KAGGLE_API_UNAVAILABLE');
  }

  if (listResponse.status === 401 || listResponse.status === 403) {
    return {
      valid: false,
      username: null,
      error: 'Kaggle rejected these API credentials. Check your token and try again.',
    };
  }

  if (!listResponse.ok) {
    const detail = extractSafeKaggleError(await readJsonSafe(listResponse));
    throw new HttpError(
      502,
      detail
        ? `Kaggle API returned status ${listResponse.status}: ${detail}`
        : `Kaggle API returned status ${listResponse.status}.`,
      'KAGGLE_API_UNAVAILABLE',
    );
  }

  const listPayload = await readJsonSafe(listResponse);
  return {
    valid: true,
    username: expectedUsername ?? extractUsernameFromPayload(listPayload),
  };
}

export async function pushKernel(
  headers: Record<string, string>,
  input: PushKernelInput,
  options: KaggleClientOptions = {},
): Promise<PushKernelResult> {
  const { owner: inputOwner, slug: shortSlug } = splitKernelRef(input.slug, options.fallbackOwner);
  const fetchFn = getFetch(options);
  const url = `${getBaseUrl(options)}/kernels/push`;

  let response: Response;
  try {
    response = await fetchFn(url, {
      method: 'POST',
      headers: {
        ...headers,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        slug: input.slug,
        newTitle: input.title ?? shortSlug,
        text: JSON.stringify(input.notebook),
        language: 'python',
        kernelType: 'notebook',
        isPrivate: true,
        enableGpu: input.enableGpu ?? true,
        enableTpu: false,
        enableInternet: input.enableInternet ?? true,
        datasetDataSources: input.datasetDataSources ?? [],
        competitionDataSources: [],
        kernelDataSources: [],
        modelDataSources: [],
        accelerator: input.accelerator ?? 'NvidiaTeslaT4',
      }),
    });
  } catch {
    throw new HttpError(502, 'Could not reach Kaggle API to start the notebook.', 'KAGGLE_PUSH_FAILED');
  }

  const payload = (await readJsonSafe(response)) as {
    ref?: unknown;
    url?: unknown;
    versionNumber?: unknown;
    error?: unknown;
    message?: unknown;
  } | null;

  if (response.status === 401 || response.status === 403) {
    throw new HttpError(
      401,
      'Kaggle rejected notebook creation. Check your API credentials and phone verification.',
      'KAGGLE_AUTH_REJECTED',
    );
  }
  if (response.status === 429) {
    throw new HttpError(429, 'Kaggle quota or rate limit was reached. Try again later.', 'KAGGLE_RATE_LIMITED');
  }
  if (!response.ok || (payload && typeof payload.error === 'string' && payload.error)) {
    const detail = extractSafeKaggleError(payload);
    throw new HttpError(
      502,
      detail
        ? `Kaggle could not start the notebook (HTTP ${response.status}): ${detail}`
        : `Kaggle could not start the notebook (HTTP ${response.status}).`,
      'KAGGLE_PUSH_FAILED',
    );
  }

  let resolvedRef = `${inputOwner}/${shortSlug}`;
  if (typeof payload?.ref === 'string' && payload.ref.trim()) {
    try {
      const parsed = splitKernelRef(payload.ref, inputOwner);
      resolvedRef = `${parsed.owner}/${parsed.slug}`;
    } catch {
      // Keep canonical requested owner/slug when Kaggle omits or formats ref unexpectedly.
    }
  }
  return {
    ref: resolvedRef,
    url: typeof payload?.url === 'string' ? payload.url : null,
    versionNumber: typeof payload?.versionNumber === 'number' ? payload.versionNumber : null,
  };
}

export async function getKernelStatus(
  headers: Record<string, string>,
  kernelRef: string,
  options: KaggleClientOptions = {},
): Promise<KernelStatusResult> {
  const { owner, slug } = splitKernelRef(kernelRef, options.fallbackOwner);
  const fetchFn = getFetch(options);
  const url = `${getBaseUrl(options)}/kernels/status?userName=${encodeURIComponent(owner)}&kernelSlug=${encodeURIComponent(slug)}`;

  let response: Response;
  try {
    response = await fetchFn(url, {
      method: 'GET',
      headers: { ...headers, Accept: 'application/json' },
    });
  } catch {
    throw new HttpError(502, 'Could not reach Kaggle API for kernel status.', 'KAGGLE_API_UNAVAILABLE');
  }

  if (response.status === 401 || response.status === 403) {
    throw new HttpError(401, 'Kaggle API credentials were rejected while checking kernel status.', 'KAGGLE_AUTH_REJECTED');
  }
  if (response.status === 404) {
    return { status: 'error', rawStatus: 'NOT_FOUND', failureMessage: 'Kaggle kernel no longer exists.' };
  }
  if (!response.ok) {
    throw new HttpError(502, `Kaggle status check failed with HTTP ${response.status}.`, 'KAGGLE_API_UNAVAILABLE');
  }

  const payload = (await readJsonSafe(response)) as {
    status?: unknown;
    statusNullable?: unknown;
    Status?: unknown;
    StatusNullable?: unknown;
    failureMessage?: unknown;
    failureMessageNullable?: unknown;
    FailureMessage?: unknown;
    FailureMessageNullable?: unknown;
  } | null;

  const statusValue =
    payload?.status
    ?? payload?.statusNullable
    ?? payload?.Status
    ?? payload?.StatusNullable
    ?? null;
  const failureValue =
    payload?.failureMessage
    ?? payload?.failureMessageNullable
    ?? payload?.FailureMessage
    ?? payload?.FailureMessageNullable
    ?? null;
  const rawStatus =
    typeof statusValue === 'string' || typeof statusValue === 'number'
      ? String(statusValue)
      : null;
  const normalized = normalizeKaggleKernelStatus(statusValue);
  if (normalized === 'unknown') {
    console.warn('kaggle_kernel_status_unknown', {
      keys: payload && typeof payload === 'object' ? Object.keys(payload) : [],
      rawStatus,
    });
  }
  return {
    status: normalized,
    rawStatus,
    failureMessage: typeof failureValue === 'string' && failureValue.trim()
      ? failureValue.trim()
      : null,
  };
}

export async function deleteKernel(
  headers: Record<string, string>,
  kernelRef: string,
  options: KaggleClientOptions = {},
): Promise<DeleteKernelResult> {
  const { owner, slug } = splitKernelRef(kernelRef, options.fallbackOwner);
  const fetchFn = getFetch(options);
  const baseUrl = getBaseUrl(options);

  let response: Response;
  try {
    response = await fetchFn(
      `${baseUrl}/kernels/delete/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}`,
      {
        method: 'DELETE',
        headers: {
          ...headers,
          Accept: 'application/json',
        },
      },
    );
  } catch {
    throw new HttpError(502, 'Could not reach Kaggle API to remove the notebook.', 'KAGGLE_API_UNAVAILABLE');
  }

  if (response.ok || response.status === 404) {
    return { deleted: true };
  }
  if (response.status === 401 || response.status === 403) {
    throw new HttpError(401, 'Kaggle API credentials were rejected while removing the notebook.', 'KAGGLE_AUTH_REJECTED');
  }
  throw new HttpError(502, `Kaggle notebook delete failed with HTTP ${response.status}.`, 'KAGGLE_API_UNAVAILABLE');
}

export async function cancelKernel(
  headers: Record<string, string>,
  kernelRef: string,
  options: KaggleClientOptions = {},
): Promise<CancelKernelResult> {
  const { owner, slug } = splitKernelRef(kernelRef, options.fallbackOwner);
  const fetchFn = getFetch(options);
  const baseUrl = getBaseUrl(options);

  let response: Response;
  try {
    response = await fetchFn(`${baseUrl}/kernels/cancel`, {
      method: 'POST',
      headers: {
        ...headers,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ userName: owner, kernelSlug: slug }),
    });
  } catch {
    throw new HttpError(502, 'Could not reach Kaggle API to cancel the notebook.', 'KAGGLE_API_UNAVAILABLE');
  }

  if (response.ok) {
    return { cancelled: true, method: 'cancel' };
  }

  if (response.status === 404 || response.status === 405) {
    await deleteKernel(headers, `${owner}/${slug}`, options);
    return { cancelled: true, method: 'delete' };
  }

  if (response.status === 401 || response.status === 403) {
    throw new HttpError(401, 'Kaggle API credentials were rejected while cancelling the notebook.', 'KAGGLE_AUTH_REJECTED');
  }

  throw new HttpError(502, `Kaggle notebook cancel failed with HTTP ${response.status}.`, 'KAGGLE_API_UNAVAILABLE');
}

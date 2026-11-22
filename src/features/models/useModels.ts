import { useCallback, useEffect, useState } from 'react';
import type { ModelCatalogResponse, TranscriptionModelSummary } from '../../../shared/models';

const FALLBACK_MODELS: TranscriptionModelSummary[] = [
  {
    language: 'fr',
    label: 'French',
    modelId: 'bofenghuang/whisper-large-v3-french-distil-dec16',
    displayName: 'Whisper Large v3 French (Distil)',
    description: 'Fast, accurate distilled French Whisper large-v3',
    gpuRequired: true,
    accelerator: 'NvidiaTeslaT4',
    license: 'mit',
  },
];

export function formatJobModelLabel(
  job: { language: string; modelId: string },
  models: TranscriptionModelSummary[],
): string {
  const match = models.find((item) => item.language === job.language && item.modelId === job.modelId)
    ?? models.find((item) => item.modelId === job.modelId)
    ?? models.find((item) => item.language === job.language);
  if (match) {
    return `${match.label} · ${match.displayName}`;
  }
  return `${job.language.toUpperCase()} · ${job.modelId}`;
}

export function useModels() {
  const [models, setModels] = useState<TranscriptionModelSummary[]>(FALLBACK_MODELS);
  const [defaultLanguage, setDefaultLanguage] = useState('fr');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadModels = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const response = await fetch('/api/models', { credentials: 'same-origin', signal });
      if (!response.ok) throw new Error('Could not load transcription models.');
      const payload = await response.json() as Partial<ModelCatalogResponse>;
      if (!Array.isArray(payload.models) || payload.models.length === 0) {
        throw new Error('Model catalog is empty.');
      }
      if (!signal?.aborted) {
        setModels(payload.models);
        if (typeof payload.defaultLanguage === 'string' && payload.defaultLanguage) {
          setDefaultLanguage(payload.defaultLanguage);
        }
        setError(null);
      }
    } catch (cause) {
      if (!signal?.aborted) {
        setError(cause instanceof Error ? cause.message : 'Could not load transcription models.');
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadModels(controller.signal);
    return () => controller.abort();
  }, [loadModels]);

  return { models, defaultLanguage, loading, error };
}

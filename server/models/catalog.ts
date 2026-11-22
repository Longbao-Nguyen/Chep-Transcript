import { readFileSync } from 'node:fs';

import type { ModelCatalogResponse, TranscriptionModelSummary } from '../../shared/models.js';
import { HttpError } from '../http/responses.js';
import type { NotebookModelConfig } from '../kaggle/notebook-builder.js';

export interface ModelFileSpec {
  size: number;
  sha256: string;
}

export interface RawTranscriptionModelEntry {
  label: string;
  model: string;
  display_name: string;
  description: string;
  ct2_model: string;
  kaggle_dataset: string;
  revision: string;
  backend: string;
  license: string;
  gpu_required: boolean;
  accelerator: string;
  chunk_seconds: number;
  sweet_spot: {
    compute_type: string;
    concurrency: number;
  };
  transcribe: {
    beam_size: number;
    vad_filter: boolean;
    condition_on_previous_text: boolean;
  };
  files: Record<string, ModelFileSpec>;
}

export interface RawModelCatalog {
  schema_version: number;
  default_language: string;
  languages: Record<string, RawTranscriptionModelEntry>;
}

export interface TranscriptionModelEntry extends RawTranscriptionModelEntry {
  language: string;
}

let cachedCatalog: {
  defaultLanguage: string;
  entriesByLanguage: Map<string, TranscriptionModelEntry>;
  entriesByModelId: Map<string, TranscriptionModelEntry>;
  list: TranscriptionModelEntry[];
} | undefined;

function loadAndValidateCatalog() {
  if (cachedCatalog) return cachedCatalog;

  const rawText = readFileSync(new URL('../../config/transcription_models.json', import.meta.url), 'utf8');
  const parsed = JSON.parse(rawText) as RawModelCatalog;
  if (parsed.schema_version !== 1 || !parsed.languages || typeof parsed.languages !== 'object') {
    throw new Error('Invalid transcription_models.json schema version or structure.');
  }

  const entriesByLanguage = new Map<string, TranscriptionModelEntry>();
  const entriesByModelId = new Map<string, TranscriptionModelEntry>();
  const list: TranscriptionModelEntry[] = [];

  for (const [language, cfg] of Object.entries(parsed.languages)) {
    if (
      cfg.backend !== 'ctranslate2'
      || !cfg.model
      || !cfg.ct2_model
      || !/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\/[1-9][0-9]*$/.test(cfg.kaggle_dataset)
      || !Number.isInteger(cfg.chunk_seconds)
      || cfg.chunk_seconds < 1
      || cfg.chunk_seconds > 60
      || !cfg.sweet_spot?.compute_type
      || ![1, 2, 4, 8].includes(cfg.sweet_spot.concurrency)
    ) {
      throw new Error(`Invalid model catalog configuration for language: ${language}`);
    }

    const fileEntries = Object.entries(cfg.files || {});
    if (fileEntries.length === 0) {
      throw new Error(`Model catalog entry ${language} has no file manifest.`);
    }
    for (const [name, meta] of fileEntries) {
      if (
        !name
        || name.includes('/')
        || name.includes('\\')
        || !Number.isSafeInteger(meta.size)
        || meta.size <= 0
        || !/^[a-f0-9]{64}$/.test(meta.sha256)
      ) {
        throw new Error(`Invalid artifact manifest ${name} for language: ${language}`);
      }
    }

    const entry: TranscriptionModelEntry = { ...cfg, language };
    entriesByLanguage.set(language, entry);
    entriesByModelId.set(cfg.model, entry);
    list.push(entry);
  }

  if (!entriesByLanguage.has(parsed.default_language)) {
    throw new Error(`Default language ${parsed.default_language} does not exist in model catalog.`);
  }

  cachedCatalog = {
    defaultLanguage: parsed.default_language,
    entriesByLanguage,
    entriesByModelId,
    list,
  };
  return cachedCatalog;
}

export function getModelCatalog(): TranscriptionModelEntry[] {
  return [...loadAndValidateCatalog().list];
}

export function getDefaultModel(): TranscriptionModelEntry {
  const catalog = loadAndValidateCatalog();
  return catalog.entriesByLanguage.get(catalog.defaultLanguage)!;
}

export function getModelByLanguage(language: string): TranscriptionModelEntry | null {
  return loadAndValidateCatalog().entriesByLanguage.get(language) ?? null;
}

export function getModelById(modelId: string): TranscriptionModelEntry | null {
  return loadAndValidateCatalog().entriesByModelId.get(modelId) ?? null;
}

export function toPublicModelSummary(entry: TranscriptionModelEntry): TranscriptionModelSummary {
  return {
    language: entry.language,
    label: entry.label,
    modelId: entry.model,
    displayName: entry.display_name,
    description: entry.description,
    gpuRequired: entry.gpu_required,
    accelerator: entry.accelerator,
    license: entry.license,
  };
}

export function getPublicModelCatalog(): ModelCatalogResponse {
  const catalog = loadAndValidateCatalog();
  return {
    defaultLanguage: catalog.defaultLanguage,
    models: catalog.list.map(toPublicModelSummary),
  };
}

export function resolveModelAndLanguage(input: { modelId?: unknown; language?: unknown } = {}): {
  language: string;
  modelId: string;
  entry: TranscriptionModelEntry;
} {
  const rawLang = input.language === undefined || input.language === null ? '' : String(input.language).trim().toLowerCase();
  const rawModel = input.modelId === undefined || input.modelId === null ? '' : String(input.modelId).trim();

  if (input.language !== undefined && input.language !== null && typeof input.language !== 'string') {
    throw new HttpError(400, 'Language must be a string.', 'INVALID_LANGUAGE');
  }
  if (input.modelId !== undefined && input.modelId !== null && typeof input.modelId !== 'string') {
    throw new HttpError(400, 'modelId must be a string.', 'INVALID_MODEL_ID');
  }

  if (!rawLang && !rawModel) {
    const fallback = getDefaultModel();
    return { language: fallback.language, modelId: fallback.model, entry: fallback };
  }

  const byLang = rawLang ? getModelByLanguage(rawLang) : null;
  if (rawLang && !byLang) {
    throw new HttpError(400, `Unsupported transcription language: ${rawLang}`, 'INVALID_LANGUAGE');
  }

  const byModel = rawModel ? getModelById(rawModel) : null;
  if (rawModel && !byModel) {
    throw new HttpError(400, `Unsupported transcription model: ${rawModel}`, 'INVALID_MODEL_ID');
  }

  if (byLang && byModel && byLang.model !== byModel.model) {
    throw new HttpError(400, 'Selected model does not match selected language.', 'MODEL_LANGUAGE_MISMATCH');
  }

  const resolved = byModel ?? byLang!;
  return {
    language: resolved.language,
    modelId: resolved.model,
    entry: resolved,
  };
}

export function toNotebookModelConfig(entry: TranscriptionModelEntry): NotebookModelConfig {
  return {
    model: entry.model,
    ct2Model: entry.ct2_model,
    kaggleDataset: entry.kaggle_dataset,
    revision: entry.revision,
    chunkSeconds: entry.chunk_seconds,
    sweetSpot: {
      computeType: entry.sweet_spot.compute_type,
      concurrency: entry.sweet_spot.concurrency,
    },
    transcribe: {
      beamSize: entry.transcribe.beam_size,
      vadFilter: entry.transcribe.vad_filter,
      conditionOnPreviousText: entry.transcribe.condition_on_previous_text,
    },
    files: entry.files,
  };
}

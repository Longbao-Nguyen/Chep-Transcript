export interface TranscriptionModelSummary {
  language: string;
  label: string;
  modelId: string;
  displayName: string;
  description: string;
  gpuRequired: boolean;
  accelerator: string;
  license: string;
}

export interface ModelCatalogResponse {
  defaultLanguage: string;
  models: TranscriptionModelSummary[];
}

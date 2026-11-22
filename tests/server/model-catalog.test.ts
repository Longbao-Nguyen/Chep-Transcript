import assert from 'node:assert/strict';
import test from 'node:test';

import { GET } from '../../api/models';
import { HttpError } from '../../server/http/responses';
import {
  getDefaultModel,
  getModelCatalog,
  getPublicModelCatalog,
  resolveModelAndLanguage,
} from '../../server/models/catalog';

test('model catalog loads and validates fr, en, es, vi models from config/transcription_models.json', () => {
  const catalog = getModelCatalog();
  assert.deepEqual(catalog.map((entry) => entry.language).sort(), ['en', 'es', 'fr', 'vi']);
  for (const entry of catalog) {
    assert.ok(entry.kaggle_dataset.startsWith('french-transcript/'));
    assert.ok(Object.keys(entry.files).includes('model.bin'));
  }

  const defaultModel = getDefaultModel();
  assert.equal(defaultModel.language, 'fr');
  assert.equal(defaultModel.model, 'bofenghuang/whisper-large-v3-french-distil-dec16');
});

test('resolveModelAndLanguage resolves defaults, language/model pairs, and rejects invalid inputs with 400', () => {
  const def = resolveModelAndLanguage();
  assert.equal(def.language, 'fr');
  assert.equal(def.modelId, 'bofenghuang/whisper-large-v3-french-distil-dec16');

  const viByLang = resolveModelAndLanguage({ language: 'vi' });
  assert.equal(viByLang.language, 'vi');
  assert.equal(viByLang.modelId, 'vinai/PhoWhisper-medium');

  const enByModel = resolveModelAndLanguage({ modelId: 'distil-whisper/distil-large-v3.5-ct2' });
  assert.equal(enByModel.language, 'en');

  assert.throws(
    () => resolveModelAndLanguage({ language: 'xx' }),
    (error: unknown) => error instanceof HttpError && error.status === 400 && error.code === 'INVALID_LANGUAGE',
  );
  assert.throws(
    () => resolveModelAndLanguage({ modelId: 'unknown/model' }),
    (error: unknown) => error instanceof HttpError && error.status === 400 && error.code === 'INVALID_MODEL_ID',
  );
  assert.throws(
    () => resolveModelAndLanguage({ language: 'fr', modelId: 'vinai/PhoWhisper-medium' }),
    (error: unknown) => error instanceof HttpError && error.status === 400 && error.code === 'MODEL_LANGUAGE_MISMATCH',
  );
});

test('GET /api/models returns public catalog without internal file hashes', async () => {
  const response = await GET(new Request('https://example.test/api/models'));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload, getPublicModelCatalog());
  assert.equal(payload.defaultLanguage, 'fr');
  assert.equal(payload.models.length, 4);
  assert.equal('files' in payload.models[0], false);
});

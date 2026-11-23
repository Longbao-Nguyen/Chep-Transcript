import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { buildTranscriptionNotebook } from '../../server/kaggle/notebook-builder';
import { resolveCallbackBaseUrl } from '../../server/jobs/dispatcher';
import { resolveModelAndLanguage, toNotebookModelConfig } from '../../server/models/catalog';

test('buildTranscriptionNotebook emits valid Python syntax without raw JS booleans and preserves signed URL queries', () => {
  const resolved = resolveModelAndLanguage({ language: 'fr' });
  const model = toNotebookModelConfig(resolved.entry);
  const signedAudioUrl = 'https://blob.vercel-storage.com/uploads/usr_1/job_1/audio.mp3?token=abc&sig=xyz/';

  const notebook = buildTranscriptionNotebook({
    jobId: 'job_123',
    workerRunId: 'run_456',
    language: 'fr',
    model,
    audioDownloadUrl: signedAudioUrl,
    callbackBaseUrl: 'https://chep.example.com/',
    callbackToken: 'cb_token_789',
    shardIndex: 0,
    span: [0, 700.5],
  }) as { cells: Array<{ source: string[] }> };

  const source = notebook.cells[0].source.join('');
  assert.equal(source.startsWith('import json\n'), true);
  assert.match(source, /TRANSCRIBE_OPTS = json\.loads\(/);
  assert.match(source, /MODEL_FILES = json\.loads\(/);
  assert.match(source, /SPAN = json\.loads\(/);
  assert.equal(source.includes(`AUDIO_DOWNLOAD_URL = ${JSON.stringify(signedAudioUrl)}`), true);
  assert.equal(source.includes('CALLBACK_BASE_URL = "https://chep.example.com"'), true);
  assert.equal(source.includes('"av"'), false);

  const pythonCheck = spawnSync(
    'python',
    [
      '-c',
      [
        'import sys',
        'src = sys.stdin.read()',
        'compile(src, "<notebook>", "exec")',
        'header = src.split("import hashlib", 1)[0]',
        'ns = {}',
        'exec(header, ns)',
        'assert ns["TRANSCRIBE_OPTS"]["vadFilter"] is False',
        'assert ns["TRANSCRIBE_OPTS"]["conditionOnPreviousText"] is True',
        'assert ns["SPAN"] == [0, 700.5]',
        'assert ns["SHARD_INDEX"] == 0',
      ].join('\n'),
    ],
    { input: source, encoding: 'utf8' },
  );

  if (!pythonCheck.error) {
    assert.equal(pythonCheck.status, 0, pythonCheck.stderr || pythonCheck.stdout);
  }
});

test('resolveCallbackBaseUrl ignores stale *.vercel.app APP_BASE_URL on Vercel while keeping custom domains and local URLs', () => {
  const prevVercel = process.env.VERCEL;
  const prevProdUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  const prevAppBase = process.env.APP_BASE_URL;

  try {
    process.env.VERCEL = '1';
    process.env.VERCEL_PROJECT_PRODUCTION_URL = 'chep-transcript.vercel.app';
    process.env.APP_BASE_URL = 'https://french-transcript.vercel.app';
    assert.equal(
      resolveCallbackBaseUrl('https://chep-transcript.vercel.app/api/queue/start'),
      'https://chep-transcript.vercel.app',
    );

    process.env.APP_BASE_URL = 'https://chep.example.com/';
    assert.equal(
      resolveCallbackBaseUrl('https://chep-transcript.vercel.app/api/queue/start'),
      'https://chep.example.com',
    );

    delete process.env.VERCEL;
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    process.env.APP_BASE_URL = 'http://localhost:3000';
    assert.equal(
      resolveCallbackBaseUrl('http://localhost:5173/api/queue/start'),
      'http://localhost:3000',
    );
  } finally {
    if (prevVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = prevVercel;
    if (prevProdUrl === undefined) delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    else process.env.VERCEL_PROJECT_PRODUCTION_URL = prevProdUrl;
    if (prevAppBase === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = prevAppBase;
  }
});

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

interface VercelConfig {
  crons?: Array<{ path: string; schedule: string }>;
  rewrites?: Array<{ source: string; destination: string }>;
}

function findTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const pathname = join(directory, entry.name);
    if (entry.isDirectory()) return findTypeScriptFiles(pathname);
    return entry.isFile() && entry.name.endsWith('.ts') ? [pathname] : [];
  });
}

test('Vercel sends all Auth.js routes to the serverless handler before the SPA fallback', () => {
  const config = JSON.parse(
    readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8'),
  ) as VercelConfig;
  const rewrites = config.rewrites ?? [];
  const authRewriteIndex = rewrites.findIndex(({ source }) => source === '/api/auth/:path*');
  const spaRewriteIndex = rewrites.findIndex(({ destination }) => destination === '/index.html');

  assert.notEqual(authRewriteIndex, -1);
  assert.equal(rewrites[authRewriteIndex]?.destination, '/api/auth/[...auth]');
  assert.equal(rewrites[spaRewriteIndex]?.source, '/:path((?!api(?:/|$)).*)');
  assert.equal(authRewriteIndex < spaRewriteIndex, true);
});

test('Vercel backend uses Node ESM-resolvable relative import specifiers', () => {
  const backendFiles = [
    ...findTypeScriptFiles(fileURLToPath(new URL('../../api', import.meta.url))),
    ...findTypeScriptFiles(fileURLToPath(new URL('../../server', import.meta.url))),
  ];
  const relativeImport = /(?:from\s+|import\s*\()\s*['"](\.{1,2}\/[^'"]+)['"]/g;

  for (const pathname of backendFiles) {
    const source = readFileSync(pathname, 'utf8');
    for (const match of source.matchAll(relativeImport)) {
      assert.match(match[1], /\.js$/, `${pathname} has a Node ESM-incompatible import: ${match[1]}`);
    }
  }
});

test('Kaggle routes use api/kaggle/[action], cleanup cron is configured, and deployment stays within twelve functions', () => {
  const config = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8')) as VercelConfig;
  const apiFiles = findTypeScriptFiles(fileURLToPath(new URL('../../api', import.meta.url)));
  assert.ok(apiFiles.some((pathname) => pathname.endsWith(join('kaggle', '[action].ts'))));
  assert.ok(apiFiles.some((pathname) => pathname.endsWith(join('cron', 'cleanup.ts'))));
  assert.ok(config.crons?.some((cron) => cron.path === '/api/cron/cleanup'));
  assert.ok(apiFiles.length <= 12);
});

test('storage provider implementation is only imported through server/storage/index.ts', () => {
  const backendFiles = [
    ...findTypeScriptFiles(fileURLToPath(new URL('../../api', import.meta.url))),
    ...findTypeScriptFiles(fileURLToPath(new URL('../../server', import.meta.url))),
  ];
  const storageIndex = fileURLToPath(new URL('../../server/storage/index.ts', import.meta.url));
  const vercelBlobProvider = fileURLToPath(new URL('../../server/storage/providers/vercel-blob.ts', import.meta.url));
  for (const pathname of backendFiles) {
    if (pathname === storageIndex || pathname === vercelBlobProvider) continue;
    const source = readFileSync(pathname, 'utf8');
    assert.equal(
      source.includes('providers/vercel-blob'),
      false,
      `${pathname} should use server/storage/index.ts instead of importing vercel-blob directly`,
    );
  }
});

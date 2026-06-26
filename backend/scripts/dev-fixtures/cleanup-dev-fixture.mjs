#!/usr/bin/env node

import {
  loadDevFixtureConfig,
  normalizeFixtureTag,
  parseArgs,
} from './lib/dev-fixture-guard.mjs';
import { readManifest, writeManifest } from './lib/dev-fixture-manifest.mjs';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    console.log('Usage: node backend/scripts/dev-fixtures/cleanup-dev-fixture.mjs --tag CODEX_DEV_FIXTURE_...');
    return;
  }

  const tag = normalizeFixtureTag(args.tag);
  const config = loadDevFixtureConfig(args);
  const { manifest, manifestPath } = readManifest(config, tag);
  const { cleanupFixture } = await import('./lib/dev-fixture-scenarios.mjs');
  const result = await cleanupFixture(config, { tag, manifest });
  const updatedManifest = {
    ...(manifest || {
      tag,
      scenario: '',
      createdAt: '',
      projectRef: config.projectRef,
      orgId: config.orgId,
      ids: result.ids,
    }),
    cleanedAt: new Date().toISOString(),
    cleanup: {
      ok: result.ok,
      before: result.before,
      deleted: result.deleted,
      after: result.after,
    },
  };
  writeManifest(config, updatedManifest);

  console.log(JSON.stringify({
    ok: result.ok,
    action: 'cleanup',
    projectRef: config.projectRef,
    tag: result.tag,
    manifestFound: Boolean(manifest),
    manifestPath: manifestPath.replace(/\\/g, '/'),
    before: result.before,
    deleted: result.deleted,
    after: result.after,
  }, null, 2));

  if (!result.ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

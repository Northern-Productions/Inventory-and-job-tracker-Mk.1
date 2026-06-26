#!/usr/bin/env node

import {
  loadDevFixtureConfig,
  normalizeFixtureTag,
  parseArgs,
} from './lib/dev-fixture-guard.mjs';
import { readManifest } from './lib/dev-fixture-manifest.mjs';

function integer(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

function totalCount(counts = {}) {
  return Object.values(counts).reduce((sum, value) => sum + integer(value), 0);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    console.log('Usage: node backend/scripts/dev-fixtures/verify-dev-fixture.mjs --tag CODEX_DEV_FIXTURE_... [--expect-clean]');
    return;
  }

  const tag = normalizeFixtureTag(args.tag);
  const config = loadDevFixtureConfig(args);
  const { manifest, manifestPath } = readManifest(config, tag);
  const { verifyFixture } = await import('./lib/dev-fixture-scenarios.mjs');
  const result = await verifyFixture(config, { tag, manifest });
  const expectClean = Boolean(args['expect-clean']);
  const remainingCount = totalCount(result.counts);
  const ok = expectClean ? remainingCount === 0 : result.ok;

  console.log(JSON.stringify({
    ok,
    action: 'verify',
    expectClean,
    projectRef: config.projectRef,
    tag: result.tag,
    manifestFound: Boolean(manifest),
    manifestPath: manifestPath.replace(/\\/g, '/'),
    ids: result.ids,
    counts: result.counts,
    remainingCount,
    boxStates: result.boxStates,
  }, null, 2));

  if (!ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

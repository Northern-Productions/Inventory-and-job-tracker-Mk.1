#!/usr/bin/env node

import {
  loadDevFixtureConfig,
  normalizeFixtureTag,
  parseArgs,
  requireScenario,
} from './lib/dev-fixture-guard.mjs';
import { writeManifest } from './lib/dev-fixture-manifest.mjs';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    console.log(`Usage: node backend/scripts/dev-fixtures/create-dev-fixture.mjs --scenario <checked-out-box-job|allocation-eligibility|atomic-transfer-assisted-allocation|allocation-timeout-remediation> [--tag CODEX_DEV_FIXTURE_...] [--safe-output]`);
    return;
  }

  const scenario = requireScenario(args.scenario);
  const tag = normalizeFixtureTag(args.tag, scenario);
  const config = loadDevFixtureConfig(args);
  const { createFixture } = await import('./lib/dev-fixture-scenarios.mjs');
  const manifest = await createFixture(config, { scenario, tag });
  const written = writeManifest(config, manifest);
  const safeOutput = args['safe-output'] === true || String(args['safe-output']).toLowerCase() === 'true';
  const idCounts = Object.fromEntries(
    Object.entries(written.manifest.ids || {}).map(([key, values]) => [
      key,
      Array.isArray(values) ? values.length : 0,
    ])
  );

  console.log(JSON.stringify({
    ok: true,
    action: 'create',
    projectRef: config.projectRef,
    tag: written.manifest.tag,
    scenario: written.manifest.scenario,
    manifestPath: written.manifestPath.replace(/\\/g, '/'),
    fixtureDealerTracked: Boolean(written.manifest.fixtureDealer?.id),
    ...(safeOutput
      ? { idCounts }
      : {
          ids: written.manifest.ids,
          routes: written.manifest.routes,
          summary: written.manifest.summary,
        }),
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

#!/usr/bin/env node

const PENDING_TRANSFER_CHECKOUT_SCENARIO = 'pending-transfer-checkout-denial';

function preparseOption(argv, name) {
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index]);
    if (token === `--${name}`) {
      const next = argv[index + 1];
      return next !== undefined && !String(next).startsWith('--') ? String(next) : true;
    }
    if (token.startsWith(`--${name}=`)) {
      return token.slice(name.length + 3);
    }
  }
  return undefined;
}

function preparseArgs(argv = []) {
  const help = argv.some((token) => token === '--help' || token === '-h');
  const scenario = preparseOption(argv, 'scenario');
  const env = preparseOption(argv, 'env');
  const runtimeStage = preparseOption(argv, 'record-runtime-stage');
  return {
    help,
    action: runtimeStage === undefined ? 'create' : 'record_runtime_stage',
    scenario: typeof scenario === 'string' ? scenario.trim() : '',
    env,
  };
}

function printUsage(scenario = '') {
  if (scenario !== PENDING_TRANSFER_CHECKOUT_SCENARIO) {
    console.log('Usage: node backend/scripts/dev-fixtures/create-dev-fixture.mjs --scenario <checked-out-box-job|allocation-eligibility|atomic-transfer-assisted-allocation|allocation-timeout-remediation> [--tag CODEX_DEV_FIXTURE_...] [--safe-output]');
    return;
  }
  console.log(`Usage: node backend/scripts/dev-fixtures/create-dev-fixture.mjs --scenario pending-transfer-checkout-denial --env <synthetic-local-env> --tag <run-namespace>

The runtime allocation stage accepts its private identity only through
--allocation-id-stdin.`);
}

function assertPreparseSafety(preparsed) {
  if (
    preparsed.scenario === PENDING_TRANSFER_CHECKOUT_SCENARIO &&
    !preparsed.help &&
    (typeof preparsed.env !== 'string' || preparsed.env.trim().length === 0)
  ) {
    const error = new Error('The pending-transfer fixture requires an explicit nonblank --env argument.');
    error.code = 'EXPLICIT_ENV_REQUIRED';
    throw error;
  }
}

async function runV3Action({ args, config, guard, scenarioTools }) {
  if (!args.tag || args.tag === true) {
    throw new guard.FixtureSafetyError(
      'V3_TAG_REQUIRED',
      'The pending-transfer fixture requires an explicit run namespace.'
    );
  }
  const tag = guard.normalizeFixtureTag(args.tag, PENDING_TRANSFER_CHECKOUT_SCENARIO);
  const stage = String(args['record-runtime-stage'] || '').trim();
  let allocationId = '';
  try {
    if (stage) {
      if (stage === 'allocation-applied') {
        if (args['allocation-id-stdin'] !== true) {
          throw new guard.FixtureSafetyError(
            'PRIVATE_INPUT_REQUIRED',
            'The allocation stage requires private stdin input.'
          );
        }
        allocationId = await guard.readAllocationIdFromStdin();
      } else if (args['allocation-id-stdin'] !== undefined) {
        throw new guard.FixtureSafetyError(
          'PRIVATE_INPUT_UNEXPECTED',
          'Private allocation input is not accepted for this stage.'
        );
      }
      const result = await scenarioTools.recordPendingTransferRuntimeStage(config, {
        tag,
        stage,
        allocationId,
      });
      console.log(JSON.stringify({
        ok: true,
        action: 'record_runtime_stage',
        scenario: PENDING_TRANSFER_CHECKOUT_SCENARIO,
        stage: result.runtimeStage,
        lifecycle: result.lifecycle,
        counts: result.counts,
        baselineDigest: result.baselineDigest,
      }, null, 2));
      return;
    }

    const manifest = await scenarioTools.createFixture(config, {
      scenario: PENDING_TRANSFER_CHECKOUT_SCENARIO,
      tag,
    });
    console.log(JSON.stringify({
      ok: true,
      action: 'create',
      scenario: PENDING_TRANSFER_CHECKOUT_SCENARIO,
      lifecycle: manifest.state,
      counts: manifest.budgets,
      baselineDigest: manifest.baselineDigest,
    }, null, 2));
  } finally {
    allocationId = '';
  }
}

async function main() {
  const preparsed = preparseArgs(process.argv.slice(2));
  if (preparsed.help) {
    printUsage(preparsed.scenario);
    return;
  }
  assertPreparseSafety(preparsed);

  const guard = await import('./lib/dev-fixture-guard.mjs');
  const manifestTools = await import('./lib/dev-fixture-manifest.mjs');
  const args = guard.parseArgs(process.argv.slice(2));
  const scenario = guard.requireScenario(args.scenario);
  guard.assertExplicitPendingTransferEnv(args);
  const tag = guard.normalizeFixtureTag(args.tag, scenario);
  const config = guard.loadDevFixtureConfig(args);
  const scenarioTools = await import('./lib/dev-fixture-scenarios.mjs');

  if (scenario === PENDING_TRANSFER_CHECKOUT_SCENARIO) {
    await runV3Action({ args, config, guard, scenarioTools });
    return;
  }

  const manifest = await scenarioTools.createFixture(config, { scenario, tag });
  const written = manifestTools.writeManifest(config, manifest);
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

const preparsedForErrors = preparseArgs(process.argv.slice(2));
main().catch((error) => {
  if (preparsedForErrors.scenario === PENDING_TRANSFER_CHECKOUT_SCENARIO) {
    console.error(JSON.stringify({
      ok: false,
      code: typeof error?.code === 'string' ? error.code : 'V3_OPERATION_FAILED',
      error: 'Pending-transfer fixture operation failed.',
    }));
  } else {
    console.error(error instanceof Error ? error.message : error);
  }
  process.exit(1);
});

export { assertPreparseSafety, preparseArgs };

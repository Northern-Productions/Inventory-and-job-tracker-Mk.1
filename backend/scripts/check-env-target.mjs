#!/usr/bin/env node

import {
  buildMutationTargetReport,
  buildTargetEnvReport,
  formatTargetEnvReport,
  loadEnvFile
} from './lib/target-env-guards.mjs';

function parseArgs(argv = []) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      continue;
    }

    const [rawKey, rawValue] = token.slice(2).split('=', 2);
    const key = String(rawKey || '').trim();
    if (!key) {
      continue;
    }

    if (rawValue !== undefined) {
      options[key] = rawValue;
      continue;
    }

    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      options[key] = true;
      continue;
    }

    options[key] = next;
    index += 1;
  }
  return options;
}

function printUsage() {
  console.log(`Usage: node scripts/check-env-target.mjs --env <path> [--expect dev|sandbox|prod|ref] [--allow-prod]

Read-only env target check. Prints variable names and project refs only; never env values.

Add --mutating to perform a fail-closed mutation preflight. Mutation preflight requires an
explicit --expect dev|sandbox|prod and rejects --linked usage; use explicit target configuration.

Defaults:
  --expect dev
  --env .env.dev

Examples:
  node scripts/check-env-target.mjs --env .env.dev --expect dev
  node scripts/check-env-target.mjs --env .env.sandbox --expect sandbox
  node scripts/check-env-target.mjs --env ../.secrets/prod.env --expect prod --allow-prod
  node scripts/check-env-target.mjs --mutating --env .env.dev --expect dev`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || options.h) {
    printUsage();
    return;
  }

  const mutating = options.mutating === true || String(options.mutating || '').toLowerCase() === 'true';
  const explicitExpect = String(options.expect || '').trim().toLowerCase();
  if (mutating && !explicitExpect) {
    console.error('[target-env-check] Mutating commands require an explicit --expect target.');
    process.exitCode = 1;
    return;
  }
  const expect = explicitExpect || 'dev';
  const defaultEnvPath =
    expect === 'prod' ? '../.secrets/prod.env' : expect === 'sandbox' ? '.env.sandbox' : '.env.dev';
  const envPath = String(options.env || defaultEnvPath).trim();
  const allowProd = options['allow-prod'] === true || String(options['allow-prod'] || '').toLowerCase() === 'true';

  let loaded;
  try {
    loaded = loadEnvFile(envPath);
  } catch (error) {
    console.error(`[target-env-check] ${error.message}`);
    process.exitCode = 1;
    return;
  }

  let report;
  try {
    report = mutating
      ? buildMutationTargetReport({
          envPath: loaded.path,
          envValues: loaded.values,
          requestedTarget: expect,
          allowProd,
          linked: options.linked === true || String(options.linked || '').toLowerCase() === 'true',
          linkedRef: String(options['linked-ref'] || '')
        })
      : buildTargetEnvReport({
          envPath: loaded.path,
          envValues: loaded.values,
          expect,
          allowProd
        });
  } catch (error) {
    console.error(`[target-env-check] ${error.message}`);
    process.exitCode = 1;
    return;
  }

  console.log(formatTargetEnvReport(report));
  if (!report.ok) {
    process.exitCode = 1;
  }
}

main();

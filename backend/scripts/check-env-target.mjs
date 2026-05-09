#!/usr/bin/env node

import {
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
  console.log(`Usage: node scripts/check-env-target.mjs --env <path> [--expect dev|prod|ref] [--allow-prod]

Read-only env target check. Prints variable names and project refs only; never env values.

Defaults:
  --expect dev
  --env .env.dev

Examples:
  node scripts/check-env-target.mjs --env .env.dev --expect dev
  node scripts/check-env-target.mjs --env ../.secrets/prod.env --expect prod --allow-prod`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || options.h) {
    printUsage();
    return;
  }

  const expect = String(options.expect || 'dev').trim().toLowerCase();
  const envPath = String(options.env || (expect === 'prod' ? '../.secrets/prod.env' : '.env.dev')).trim();
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
    report = buildTargetEnvReport({
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

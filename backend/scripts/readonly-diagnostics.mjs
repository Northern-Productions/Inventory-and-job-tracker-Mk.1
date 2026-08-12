#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import {
  formatDiagnosticReport,
  READONLY_DIAGNOSTIC_PASSED,
  runReadonlyDiagnostic,
  serializeDiagnosticReport,
  validateDiagnosticInventory
} from './lib/readonly-diagnostics.mjs';

function parseArgs(argv) {
  const options = {};
  const supported = new Set([
    'inventory', 'target', 'connection-env', 'params-env', 'expected-target-env',
    'json', 'help', 'dry-validate', 'allow-dev', 'allow-prod'
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error('CLI_ARGUMENT_INVALID');
    const key = token.slice(2);
    if (!supported.has(key) || Object.hasOwn(options, key)) throw new Error('CLI_ARGUMENT_INVALID');
    if (['json', 'help', 'dry-validate', 'allow-dev', 'allow-prod'].includes(key)) {
      options[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error('CLI_ARGUMENT_VALUE_MISSING');
    options[key] = value;
    index += 1;
  }
  return options;
}

function usage() {
  console.log(`Usage: node scripts/readonly-diagnostics.mjs --inventory <json> --target <local|dev|prod>
  --connection-env <VARIABLE> [--params-env <VARIABLE>] [--expected-target-env <VARIABLE>]
  [--allow-dev|--allow-prod] [--json] [--dry-validate]

Inventories are validated before a client is constructed. This command never loads
an env file and never grants DEV/PROD authorization; repository approval rules still apply.`);
}

function readInventory(filePath) {
  const bytes = fs.readFileSync(path.resolve(filePath));
  if (bytes.length > 1024 * 1024) throw new Error('CLI_INVENTORY_TOO_LARGE');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

function projectIdentityFromUrl(url) {
  const parsed = new URL(url);
  const hostParts = parsed.hostname.toLowerCase().split('.');
  if (hostParts[0] === 'db' && hostParts.length > 2) return hostParts[1];
  if (parsed.username.includes('.')) return decodeURIComponent(parsed.username).split('.').at(-1);
  if (hostParts.at(-2) === 'supabase' && hostParts.length > 2) return hostParts[0];
  return '';
}

function targetFor(options, connectionUrl) {
  const category = options.target;
  if (!['local', 'dev', 'prod'].includes(category)) throw new Error('CLI_TARGET_REQUIRED');
  const parsed = new URL(connectionUrl);
  if (category === 'local') return { category, host: parsed.hostname };
  if (category === 'dev' && !options['allow-dev']) throw new Error('CLI_DEV_CONFIRMATION_REQUIRED');
  if (category === 'prod' && !options['allow-prod']) throw new Error('CLI_PROD_CONFIRMATION_REQUIRED');
  const expectedVariable = options['expected-target-env'];
  const expectedIdentity = expectedVariable ? String(process.env[expectedVariable] || '').trim() : '';
  return { category, expectedIdentity, actualIdentity: projectIdentityFromUrl(connectionUrl) };
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    if (options.help) {
      usage();
      return;
    }
    if (!options.inventory) throw new Error('CLI_INVENTORY_REQUIRED');
    const inventory = readInventory(options.inventory);
    validateDiagnosticInventory(inventory);
    if (!['local', 'dev', 'prod'].includes(options.target) || options.target !== inventory.target.category) {
      throw new Error('CLI_TARGET_MISMATCH');
    }
    if (options['dry-validate']) {
      const output = {
        classification: READONLY_DIAGNOSTIC_PASSED,
        inventory: { name: inventory.name, version: inventory.version, identity: inventory.inventoryIdentity },
        validation: 'PASSED',
        databaseClientConstructed: false
      };
      process.stdout.write(options.json ? `${JSON.stringify(output, null, 2)}\n` : '[readonly-diagnostic] inventory validation passed; no client was constructed\n');
      return;
    }

    const connectionVariable = options['connection-env'];
    if (!connectionVariable) throw new Error('CLI_CONNECTION_ENV_REQUIRED');
    const connectionString = String(process.env[connectionVariable] || '').trim();
    if (!connectionString) throw new Error('CLI_CONNECTION_VALUE_MISSING');
    const target = targetFor(options, connectionString);
    const paramsVariable = options['params-env'];
    const parameters = paramsVariable ? JSON.parse(String(process.env[paramsVariable] || '{}')) : {};
    const { Client } = await import('pg');
    const report = await runReadonlyDiagnostic({
      inventory,
      client: new Client({ connectionString, application_name: 'readonly-diagnostics' }),
      target,
      parameters
    });
    process.stdout.write(options.json ? serializeDiagnosticReport(report) : `${formatDiagnosticReport(report)}\n`);
    if (![READONLY_DIAGNOSTIC_PASSED].includes(report.classification)) process.exitCode = 1;
  } catch (error) {
    const candidate = String(error?.code || error?.message || 'CLI_FAILED');
    const safeCode = /^[A-Z][A-Z0-9_]{2,63}$/.test(candidate) ? candidate : 'CLI_FAILED';
    console.error(`[readonly-diagnostic] ${safeCode}`);
    process.exitCode = 1;
  }
}

await main();

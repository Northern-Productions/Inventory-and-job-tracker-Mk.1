#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

import pg from 'pg';

import {
  buildTargetEnvReport,
  loadEnvFile
} from './lib/target-env-guards.mjs';
import { TARGET_DATABASE_VARIABLES } from './lib/environment-sync/constants.mjs';
import {
  captureEnvironmentInventory,
  fetchEdgeHealth,
  fetchManagementSummary
} from './lib/environment-sync/inventory.mjs';

const { Client } = pg;

function options(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    values[key] = !next || next.startsWith('--') ? true : next;
    if (values[key] !== true) index += 1;
  }
  return values;
}

function databaseUrl(envValues, target) {
  const entries = TARGET_DATABASE_VARIABLES[target]
    .map((name) => ({ name, value: String(envValues[name] || '').trim() }))
    .filter((entry) => entry.value);
  if (entries.length === 0) throw new Error('No reviewed database connection variable is available.');
  const unique = new Set(entries.map((entry) => entry.value));
  if (unique.size !== 1) throw new Error('Database connection variables disagree.');
  return entries[0].value;
}

function gitCommit() {
  return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

async function main() {
  const args = options(process.argv.slice(2));
  if (args.help || args.h) {
    console.log('Usage: npm --prefix backend run env:inventory -- --target dev|prod|sandbox --env <path> [--allow-prod]');
    return;
  }
  const target = String(args.target || '').trim().toLowerCase();
  if (!['dev', 'prod', 'sandbox'].includes(target)) throw new Error('An explicit inventory target is required.');
  const envPath = String(args.env || '').trim();
  if (!envPath) throw new Error('An explicit environment file is required.');
  const loaded = loadEnvFile(envPath);
  const guard = buildTargetEnvReport({
    envPath: loaded.path,
    envValues: loaded.values,
    expect: target,
    allowProd: args['allow-prod'] === true
  });
  if (!guard.ok) throw new Error('Environment target guard failed.');

  const connectionString = databaseUrl(loaded.values, target);
  const managementToken = String(process.env.SUPABASE_ACCESS_TOKEN || loaded.values.SUPABASE_ACCESS_TOKEN || '');
  const supabaseUrl = String(loaded.values.SUPABASE_URL || loaded.values.VITE_SUPABASE_URL || '');
  const [management, edgeHealth] = await Promise.all([
    fetchManagementSummary({ projectRef: guard.expected.ref, accessToken: managementToken }),
    fetchEdgeHealth({ supabaseUrl })
  ]);
  const client = new Client({ connectionString, application_name: 'environment-inventory-readonly' });
  let began = false;
  try {
    await client.connect();
    await client.query('begin isolation level repeatable read read only');
    began = true;
    await client.query("set local time zone 'UTC'");
    const inventory = await captureEnvironmentInventory({
      client,
      target,
      projectRef: guard.expected.ref,
      envValues: loaded.values,
      management,
      edgeHealth,
      source: { gitCommit: gitCommit() }
    });
    await client.query('rollback');
    began = false;
    console.log(JSON.stringify(inventory, null, 2));
  } finally {
    if (began) {
      try { await client.query('rollback'); } catch {}
    }
    await client.end().catch(() => {});
  }
}

main().catch((error) => {
  console.error(`[env-inventory] ${String(error?.message || 'INVENTORY_FAILED').replace(/(?:postgres(?:ql)?:\/\/|https?:\/\/)[^\s]+/gi, '[redacted]')}`);
  process.exitCode = 1;
});

#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

const DEFAULT_PROJECT = 'inventory-and-job-tracker-mk-1';

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

function runVercelList(project) {
  const args = [
    'vercel',
    'list',
    project,
    '--environment=production',
    '--format=json',
    '--status=READY'
  ];

  if (process.platform === 'win32') {
    return execFileSync('cmd.exe', ['/c', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
  }

  return execFileSync(args[0], args.slice(1), {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function normalizeDeploymentList(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (Array.isArray(payload?.deployments)) {
    return payload.deployments;
  }
  if (Array.isArray(payload?.items)) {
    return payload.items;
  }
  return [];
}

function extractCommit(deployment) {
  const candidates = [
    deployment?.meta?.githubCommitSha,
    deployment?.meta?.githubCommitSHA,
    deployment?.meta?.githubCommitRef,
    deployment?.gitSource?.sha,
    deployment?.source?.sha,
    deployment?.git?.sha,
    deployment?.commit?.sha
  ];
  return String(candidates.find((candidate) => String(candidate || '').trim()) || '').trim();
}

function extractReadyDeployment(payload) {
  const deployments = normalizeDeploymentList(payload);
  return deployments.find((deployment) => {
    const state = String(deployment?.readyState || deployment?.state || deployment?.status || '').toUpperCase();
    const target = String(deployment?.target || deployment?.environment || '').toLowerCase();
    return (!state || state === 'READY') && (!target || target === 'production');
  });
}

function commitMatches(actual, expected) {
  const normalizedActual = String(actual || '').trim().toLowerCase();
  const normalizedExpected = String(expected || '').trim().toLowerCase();
  if (!normalizedActual || !normalizedExpected) {
    return false;
  }
  return normalizedActual === normalizedExpected || normalizedActual.startsWith(normalizedExpected) || normalizedExpected.startsWith(normalizedActual);
}

function printUsage() {
  console.log(`Usage: node scripts/verify-vercel-production-status.mjs [--project <name>] [--expected-commit <sha>]

Read-only Vercel production READY deployment status check. This script never deploys.`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || options.h) {
    printUsage();
    return;
  }

  const project = String(options.project || DEFAULT_PROJECT).trim();
  const expectedCommit = String(options['expected-commit'] || '').trim();
  if (!project) {
    console.error('[vercel-prod-status] --project is required.');
    process.exitCode = 1;
    return;
  }

  let rawOutput;
  try {
    rawOutput = runVercelList(project);
  } catch (error) {
    const stderr = String(error?.stderr || '').trim();
    const message = stderr || error.message || 'Unable to run Vercel CLI.';
    console.error(`[vercel-prod-status] Failed to read Vercel production status: ${message}`);
    console.error('[vercel-prod-status] Confirm Vercel CLI is installed and authenticated. No deploy was attempted.');
    process.exitCode = 1;
    return;
  }

  let payload;
  try {
    payload = JSON.parse(rawOutput);
  } catch (_error) {
    console.error('[vercel-prod-status] Vercel CLI did not return JSON. No deploy was attempted.');
    process.exitCode = 1;
    return;
  }

  const deployment = extractReadyDeployment(payload);
  if (!deployment) {
    console.error(`[vercel-prod-status] No READY production deployment found for ${project}.`);
    process.exitCode = 1;
    return;
  }

  const commit = extractCommit(deployment);
  const url = String(deployment.url || deployment.alias?.[0] || '').trim();
  const createdAt = deployment.createdAt || deployment.created || deployment.createdAtMs || '';

  console.log('[vercel-prod-status]');
  console.log(`project: ${project}`);
  console.log(`deployment: ${deployment.name || deployment.uid || deployment.id || '<unknown>'}`);
  console.log(`url: ${url || '<unavailable>'}`);
  console.log(`commit: ${commit || '<unavailable>'}`);
  console.log(`createdAt: ${createdAt || '<unavailable>'}`);

  if (expectedCommit) {
    if (!commitMatches(commit, expectedCommit)) {
      console.error(`[vercel-prod-status] Expected commit ${expectedCommit}, received ${commit || '<unavailable>'}.`);
      process.exitCode = 1;
      return;
    }
    console.log(`expectedCommit: ${expectedCommit}`);
    console.log('result: ok');
    return;
  }

  console.log('result: ok');
}

main();

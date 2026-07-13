#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  classifyChangedFiles,
  formatClassificationReport,
  getChangedFiles,
  getRepoRoot
} from './lib/codex-change-classifier.mjs';

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

function runGit(args, { allowFailure = false, cwd = process.cwd() } = {}) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    if (allowFailure) {
      return '';
    }
    throw error;
  }
}

function commitMatches(actual, expected) {
  const normalizedActual = String(actual || '').trim().toLowerCase();
  const normalizedExpected = String(expected || '').trim().toLowerCase();
  return Boolean(
    normalizedActual &&
      normalizedExpected &&
      (normalizedActual === normalizedExpected ||
        normalizedActual.startsWith(normalizedExpected) ||
        normalizedExpected.startsWith(normalizedActual))
  );
}

function printUsage() {
  console.log(`Usage: node scripts/release-doctor.mjs --mode preflight|post [--base origin/main] [--head HEAD] [--expected-commit <sha>] [--expected-prod-ref <ref>]

Read-only release checklist helper. This script does not deploy, apply
migrations, mutate data, or print secrets.`);
}

function printForbiddenActions() {
  console.log('forbiddenWithoutExplicitApproval:');
  console.log('  - PROD migrations');
  console.log('  - PROD data mutation');
  console.log('  - Supabase Edge/API deploy');
  console.log('  - Vercel manual deploy');
  console.log('  - git push main');
  console.log('  - branch deletion or cleanup');
  console.log('  - raw SQL writes');
  console.log('  - env/secrets changes');
  console.log('  - npm audit fix');
}

function printEnvHints(expectedProdRef, repoRoot) {
  const prodEnvPath = path.resolve(repoRoot, '.secrets', 'prod.env');
  const backendProdEnvPath = path.resolve(repoRoot, 'backend', '.env.prod');
  console.log('prodEnvReadiness:');
  console.log(`  - .secrets/prod.env: ${fs.existsSync(prodEnvPath) ? 'present' : 'missing'}`);
  console.log(`  - backend/.env.prod: ${fs.existsSync(backendProdEnvPath) ? 'present' : 'missing'}`);
  if (expectedProdRef) {
    console.log(`  - expected PROD ref: ${expectedProdRef}`);
    console.log('  - run npm --prefix backend run env:check:prod before any approved PROD operation');
  }
}

function printPreflight({ base, head, expectedProdRef }) {
  const repoRoot = getRepoRoot();
  const changedFiles = getChangedFiles({ base, head, cwd: repoRoot });
  const classification = classifyChangedFiles(changedFiles);
  const statusShort = runGit(['status', '--short'], { allowFailure: true, cwd: repoRoot });
  const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { allowFailure: true, cwd: repoRoot }) || '<unknown>';
  const headSha = runGit(['rev-parse', 'HEAD'], { allowFailure: true, cwd: repoRoot }) || '<unknown>';
  const originMain = runGit(['rev-parse', 'origin/main'], { allowFailure: true, cwd: repoRoot }) || '<unavailable>';

  console.log('[release-doctor:preflight]');
  console.log(`branch: ${branch}`);
  console.log(`head: ${headSha}`);
  console.log(`originMain: ${originMain}`);
  console.log(`workingTree: ${statusShort ? 'dirty' : 'clean'}`);
  console.log('');
  console.log(formatClassificationReport(classification, { base, head }));
  console.log('');
  printEnvHints(expectedProdRef, repoRoot);
  console.log('');
  console.log('preflightChecklist:');
  console.log('  - confirm release approval is explicit');
  console.log('  - confirm release branch and commit match the approved prompt');
  console.log('  - run all required checks listed above before merge/push/deploy');
  console.log('  - create a read-only release:integrity pre snapshot before the first approved release action');
  console.log('  - verify DEV/local fixture workflow before releasing mutation behavior');
  console.log('  - verify migrations are mirrored and applied only after target guard and approval');
  console.log('  - verify Edge/API deploy is needed before deploying only intended functions');
  console.log('  - verify frontend production commit after main push and Vercel deployment');
  console.log('  - perform read-only PROD smoke unless an approved fixture mutation is available');
  console.log('');
  printForbiddenActions();
}

function printPost({ expectedCommit, expectedProdRef }) {
  const repoRoot = getRepoRoot();
  const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { allowFailure: true, cwd: repoRoot }) || '<unknown>';
  const headSha = runGit(['rev-parse', 'HEAD'], { allowFailure: true, cwd: repoRoot }) || '<unknown>';
  const originMain = runGit(['rev-parse', 'origin/main'], { allowFailure: true, cwd: repoRoot }) || '<unavailable>';
  const statusShort = runGit(['status', '--short'], { allowFailure: true, cwd: repoRoot });

  console.log('[release-doctor:post]');
  console.log(`branch: ${branch}`);
  console.log(`head: ${headSha}`);
  console.log(`originMain: ${originMain}`);
  console.log(`workingTree: ${statusShort ? 'dirty' : 'clean'}`);
  if (expectedCommit) {
    console.log(`expectedCommit: ${expectedCommit}`);
    console.log(`localHeadMatchesExpected: ${commitMatches(headSha, expectedCommit) ? 'yes' : 'no'}`);
    console.log(`originMainMatchesExpected: ${commitMatches(originMain, expectedCommit) ? 'yes' : 'no'}`);
  }
  console.log('');
  printEnvHints(expectedProdRef, repoRoot);
  console.log('');
  console.log('postReleaseChecklist:');
  console.log('  - confirm origin/main contains the released commit');
  console.log('  - confirm migration history is aligned if migrations were approved');
  console.log('  - confirm Edge /health reports the released apiBuildSha when Edge deployed');
  console.log('  - confirm Vercel production deployment is READY at the released commit');
  console.log('  - create and compare the release:integrity post snapshot before sign-off');
  console.log('  - confirm production app shell loads and bundle/config points to PROD, not DEV/local');
  console.log('  - run safe unauthenticated route smokes for touched routes');
  console.log('  - report authenticated PROD mutation checks as skipped unless approved fixture data exists');
  console.log('  - confirm final git status is clean');
  console.log('');
  printForbiddenActions();
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || options.h) {
    printUsage();
    return;
  }

  const mode = String(options.mode || 'preflight').trim().toLowerCase();
  const base = String(options.base || 'origin/main').trim();
  const head = String(options.head || 'HEAD').trim();
  const expectedCommit = String(options['expected-commit'] || '').trim();
  const expectedProdRef = String(options['expected-prod-ref'] || '').trim();

  if (mode === 'preflight') {
    printPreflight({ base, head, expectedProdRef });
    return;
  }

  if (mode === 'post') {
    printPost({ expectedCommit, expectedProdRef });
    return;
  }

  console.error(`[release-doctor] Unsupported --mode ${mode}. Use preflight or post.`);
  process.exitCode = 1;
}

main();

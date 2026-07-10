#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
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

function printUsage() {
  console.log(`Usage: node scripts/codex-task-refresh.mjs [--base origin/main] [--head HEAD]

Read-only task-start refresh. This script prints repo state, initial task tier
classification, and safety reminders. It does not deploy, apply migrations,
mutate data, or read secrets.`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || options.h) {
    printUsage();
    return;
  }

  const base = String(options.base || 'origin/main').trim();
  const head = String(options.head || 'HEAD').trim();
  const repoRoot = getRepoRoot();
  const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { allowFailure: true, cwd: repoRoot }) || '<unknown>';
  const headSha = runGit(['rev-parse', 'HEAD'], { allowFailure: true, cwd: repoRoot }) || '<unknown>';
  const originMain = runGit(['rev-parse', 'origin/main'], { allowFailure: true, cwd: repoRoot }) || '<unavailable>';
  const statusShort = runGit(['status', '--short'], { allowFailure: true, cwd: repoRoot });
  const isClean = statusShort.length === 0;

  let changedFiles = [];
  let classification;
  let classificationError = '';
  try {
    changedFiles = getChangedFiles({ base, head, cwd: repoRoot });
    classification = classifyChangedFiles(changedFiles);
  } catch (error) {
    classificationError = error.message || String(error);
  }

  console.log('[codex-refresh]');
  console.log(`branch: ${branch}`);
  console.log(`head: ${headSha}`);
  console.log(`originMain: ${originMain}`);
  console.log(`workingTree: ${isClean ? 'clean' : 'dirty'}`);
  console.log('gitStatusShort:');
  if (statusShort) {
    console.log(statusShort);
  } else {
    console.log('  <clean>');
  }

  if (classificationError) {
    console.log(`[codex-refresh] classification unavailable: ${classificationError}`);
  } else {
    console.log('');
    console.log(formatClassificationReport(classification, { base, head }));
  }

  console.log('');
  console.log('taskStartReminders:');
  console.log('  - read AGENTS.md');
  console.log('  - read docs/automation/codex-operating-manual.md');
  console.log('  - read docs/automation/task-tiers.md');
  console.log('  - read docs/automation/release-doctor.md for release work');
  console.log('  - read docs/automation/sage-codex-workflow.md');
  console.log('  - classify the task tier before choosing checks');
  console.log('  - Rob is product owner, Sage is technical lead/safety gate, Codex is implementation worker');
  console.log('  - read docs/material-flow-rules.md before inventory/material/caulk/film-order/check-in/check-out changes');
  console.log('  - use DEV fixture/browser verification for protected workflow mutations');
  console.log('  - DEV proves changes; PROD requires explicit release approval');
  console.log('  - no PROD mutation, migration, Edge deploy, Vercel deploy, main push, branch cleanup, env changes, raw SQL writes, or npm audit fix without explicit approval');
  console.log('  - never print secrets, tokens, auth headers, DB URLs, or full env files');
}

main();

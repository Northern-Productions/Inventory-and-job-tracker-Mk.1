#!/usr/bin/env node

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

function printUsage() {
  console.log(`Usage: node scripts/codex-classify-changes.mjs [--base origin/main] [--head HEAD] [--json]

Read-only changed-files task tier classifier. This script does not deploy,
apply migrations, mutate data, or read secrets.`);
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
  const changedFiles = getChangedFiles({ base, head, cwd: repoRoot });
  const report = classifyChangedFiles(changedFiles);

  if (options.json) {
    console.log(JSON.stringify({ base, head, ...report }, null, 2));
    return;
  }

  console.log(formatClassificationReport(report, { base, head }));
}

main();

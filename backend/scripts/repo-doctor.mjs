#!/usr/bin/env node

import {
  formatRepositoryDoctorReport,
  REPOSITORY_UNSAFE_FOR_CODEX,
  runRepositoryDoctor
} from './lib/repo-doctor.mjs';

function printUsage() {
  console.log(`Usage: node scripts/repo-doctor.mjs [--json]

Read-only repository foundation check. It reports unsafe Git metadata,
worktree, ref, object, policy, and toolchain conditions. It never repairs,
prunes, switches branches, or changes repository metadata.`);
}

function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--help') || args.has('-h')) {
    printUsage();
    return;
  }
  const unsupported = [...args].filter((arg) => arg !== '--json');
  if (unsupported.length) {
    console.error('[repo-doctor] Unsupported option. Use --help for usage.');
    process.exitCode = 1;
    return;
  }

  const report = runRepositoryDoctor();
  console.log(args.has('--json') ? JSON.stringify(report, null, 2) : formatRepositoryDoctorReport(report));
  if (report.overall === REPOSITORY_UNSAFE_FOR_CODEX) process.exitCode = 1;
}

main();

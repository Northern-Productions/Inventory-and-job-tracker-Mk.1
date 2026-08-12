#!/usr/bin/env node

import {
  buildMigrationRegistry,
  formatMigrationRegistryReport,
  MIGRATION_REGISTRY_INCOHERENT,
  serializeMigrationRegistry
} from './lib/migration-registry.mjs';

function printUsage() {
  console.log(`Usage: node scripts/migration-registry.mjs [--check] [--json]

Derives canonical migration metadata from staged/index Git blobs. Worktree-only
migration changes are rejected. --check exits nonzero when the modern mirror
chain is incoherent; legacy structural exceptions remain visible warnings.`);
}

function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--help') || args.has('-h')) {
    printUsage();
    return;
  }
  const unsupported = [...args].filter((arg) => !['--check', '--json'].includes(arg));
  if (unsupported.length) {
    console.error('[migration-registry] Unsupported option. Use --help for usage.');
    process.exitCode = 1;
    return;
  }

  try {
    const registry = buildMigrationRegistry();
    process.stdout.write(args.has('--json') ? serializeMigrationRegistry(registry) : `${formatMigrationRegistryReport(registry)}\n`);
    if (registry.overall === MIGRATION_REGISTRY_INCOHERENT) process.exitCode = 1;
  } catch (error) {
    console.error(`[migration-registry] ${error?.code || 'MIGRATION_REGISTRY_FAILED'}`);
    process.exitCode = 1;
  }
}

main();

#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildEdgeDeploymentProvenance,
  writeProvenanceManifest
} from './lib/edge-deployment-provenance.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = path.resolve(path.dirname(scriptPath), '../..');

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redactRunPaths(message, argv) {
  const values = [defaultRepoRoot];
  for (const key of ['--repo', '--source', '--manifest']) {
    const index = argv.indexOf(key);
    if (index >= 0 && argv[index + 1]) {
      values.push(path.resolve(argv[index + 1]));
    }
  }
  return values
    .sort((left, right) => right.length - left.length)
    .reduce((result, value) => {
      const variants = [value, value.replaceAll('\\', '/')];
      return variants.reduce(
        (current, variant) =>
          current.replace(new RegExp(escapeRegExp(variant), 'gi'), '<materialized-source>'),
        result
      );
    }, String(message));
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      throw new Error(`Unexpected argument: ${token}.`);
    }
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}.`);
    }
    options[key] = value;
    index += 1;
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const sourceRoot = options.source;
  const commit = options.commit;
  const manifestPath = options.manifest;
  if (!sourceRoot || !commit || !manifestPath) {
    throw new Error('--source, --commit, and --manifest are required.');
  }
  const expectedLocalModules = options['expect-local-modules']
    ? Number(options['expect-local-modules'])
    : undefined;
  if (
    expectedLocalModules !== undefined &&
    (!Number.isInteger(expectedLocalModules) || expectedLocalModules < 1)
  ) {
    throw new Error('--expect-local-modules must be a positive integer.');
  }

  const manifest = buildEdgeDeploymentProvenance({
    repoRoot: path.resolve(options.repo || defaultRepoRoot),
    sourceRoot: path.resolve(sourceRoot),
    commit,
    entrypoint: options.entry || 'supabase/functions/api/index.ts',
    expectedLocalModules
  });
  writeProvenanceManifest(manifestPath, manifest);

  console.log('[edge-deployment-provenance]');
  console.log(`commit: ${manifest.commitSha}`);
  console.log(`archiveFiles: ${manifest.archive.fileCount}`);
  console.log(`archiveDigest: ${manifest.archive.digest}`);
  console.log(`localModules: ${manifest.localModules.length}`);
  console.log(`externalSpecifiers: ${manifest.externalSpecifiers.length}`);
  console.log(`npmPackages: ${manifest.npmPackages.length}`);
  console.log(`lockfileVersion: ${manifest.deno.lockfileVersion}`);
  console.log(`completeGraphDigest: ${manifest.completeGraphDigest}`);
  console.log('result: ok');
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    `[edge-deployment-provenance] ${redactRunPaths(message, process.argv.slice(2))}`
  );
  process.exitCode = 1;
}

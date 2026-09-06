#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

function preparse(argv) {
  const help = argv.includes('--help') || argv.includes('-h');
  const required = ['--env', '--authority-key', '--retained-root', '--output-dir'];
  if (!help && required.some((name) => {
    const index = argv.indexOf(name);
    return index < 0 || !String(argv[index + 1] || '').trim() || argv[index + 1].startsWith('--');
  })) throw Object.assign(new Error('DEV_REFRESH_PREPARATION_ARGUMENT_MISSING'), { code: 'DEV_REFRESH_PREPARATION_ARGUMENT_MISSING' });
  return { help };
}

function parse(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw Object.assign(new Error('DEV_REFRESH_PREPARATION_ARGUMENT_INVALID'), { code: 'DEV_REFRESH_PREPARATION_ARGUMENT_INVALID' });
    const key = token.slice(2);
    const next = argv[index + 1];
    result[key] = !next || next.startsWith('--') ? true : next;
    if (result[key] !== true) index += 1;
  }
  return result;
}

async function main() {
  const argv = process.argv.slice(2);
  const initial = preparse(argv);
  if (initial.help) {
    console.log('Usage: npm --prefix backend run env:prepare-dev-refresh-certified -- --env <guarded-dev-env> --authority-key <private-key> --retained-root <retained-sync-root> --output-dir <new-private-output> [--disposable] [--postgres-bin <bin>] [--side-effect-certificate <private-json> --edge-certificate <private-json>]');
    return;
  }
  const options = parse(argv);
  const { prepareCertifiedDevRefresh } = await import('./lib/environment-sync/dev-certified-preparation.mjs');
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const result = await prepareCertifiedDevRefresh({
    repoRoot,
    envFilePath: path.resolve(String(options.env)),
    authorityKeyPath: path.resolve(String(options['authority-key'])),
    retainedRoot: path.resolve(String(options['retained-root'])),
    outputDirectory: path.resolve(String(options['output-dir'])),
    disposable: options.disposable === true,
    sideEffectCertificatePath: options['side-effect-certificate'] || '',
    edgeCertificatePath: options['edge-certificate'] || '',
    postgresBin: options['postgres-bin'] || ''
  });
  console.log(JSON.stringify({
    classification: result.classification,
    target: result.target,
    realStageCount: result.realStageCount,
    syntheticWorkerAbsent: result.syntheticWorkerAbsent,
    disposable: result.disposable
  }));
}

main().catch((error) => {
  const code = String(error?.code || error?.message || 'DEV_REFRESH_PREPARATION_FAILED')
    .replace(/[^A-Z0-9_]/gi, '_').slice(0, 120);
  console.error(`[dev-certified-preparation] ${code}`);
  process.exitCode = 1;
});

#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

function requiredValue(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 && String(argv[index + 1] || '').trim() && !argv[index + 1].startsWith('--');
}

function preparse(argv) {
  const help = argv.includes('--help') || argv.includes('-h');
  const required = [
    '--env', '--authority-key', '--original-contract', '--original-preparation',
    '--failed-state-dir', '--expected-original-attempt', '--expected-original-y2', '--output-dir',
    '--side-effect-certificate', '--edge-certificate'
  ];
  if (!help && required.some((name) => !requiredValue(argv, name))) {
    throw Object.assign(new Error('DEV_REMEDIATION_PREPARATION_ARGUMENT_MISSING'), {
      code: 'DEV_REMEDIATION_PREPARATION_ARGUMENT_MISSING'
    });
  }
  return { help };
}

function parse(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw Object.assign(new Error('DEV_REMEDIATION_PREPARATION_ARGUMENT_INVALID'), { code: 'DEV_REMEDIATION_PREPARATION_ARGUMENT_INVALID' });
    const key = token.slice(2);
    if (Object.hasOwn(result, key)) throw Object.assign(new Error('DEV_REMEDIATION_PREPARATION_ARGUMENT_DUPLICATE'), { code: 'DEV_REMEDIATION_PREPARATION_ARGUMENT_DUPLICATE' });
    const next = argv[index + 1];
    result[key] = !next || next.startsWith('--') ? true : next;
    if (result[key] !== true) index += 1;
  }
  return result;
}

async function main() {
  const argv = process.argv.slice(2);
  if (preparse(argv).help) {
    console.log('Usage: npm --prefix backend run env:prepare-dev-recovery-remediation-certified -- --env <guarded-dev-env> --authority-key <private-key> --original-contract <private-contract> --original-preparation <private-preparation> --failed-state-dir <failed-state> --expected-original-attempt <attempt-id> --expected-original-y2 <y2-id> --output-dir <new-private-output> --side-effect-certificate <private-json> --edge-certificate <private-json> [--postgres-bin <bin>]');
    return;
  }
  const options = parse(argv);
  const { prepareDevRecoveryRemediation } = await import('./lib/environment-sync/dev-recovery-remediation-preparation.mjs');
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const result = await prepareDevRecoveryRemediation({
    repoRoot,
    envFilePath: path.resolve(String(options.env)),
    authorityKeyPath: path.resolve(String(options['authority-key'])),
    originalContractPath: path.resolve(String(options['original-contract'])),
    originalPreparationPath: path.resolve(String(options['original-preparation'])),
    failedStateDirectory: path.resolve(String(options['failed-state-dir'])),
    expectedRefreshAttemptId: String(options['expected-original-attempt']),
    expectedY2RecoveryId: String(options['expected-original-y2']),
    outputDirectory: path.resolve(String(options['output-dir'])),
    sideEffectCertificatePath: options['side-effect-certificate'] || '',
    edgeCertificatePath: options['edge-certificate'] || '',
    postgresBin: options['postgres-bin'] || ''
  });
  console.log(JSON.stringify({
    classification: result.classification,
    target: result.target,
    realStageCount: result.realStageCount,
    syntheticWorkerAbsent: result.syntheticWorkerAbsent,
    r3Created: result.r3Created,
    sharedMutations: result.sharedMutations
  }));
}

main().catch((error) => {
  const code = String(error?.code || error?.message || 'DEV_REMEDIATION_PREPARATION_FAILED')
    .replace(/[^A-Z0-9_]/gi, '_').slice(0, 160);
  console.error(`[dev-recovery-remediation-preparation] ${code}`);
  process.exitCode = 1;
});

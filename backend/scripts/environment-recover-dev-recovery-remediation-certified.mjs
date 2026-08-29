#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

function preparse(argv) {
  const help = argv.includes('--help') || argv.includes('-h');
  const required = ['--env', '--authority-key', '--preparation', '--contract', '--operation-inventory', '--state-dir', '--evidence-dir'];
  const missing = required.some((name) => {
    const index = argv.indexOf(name);
    return index < 0 || !String(argv[index + 1] || '').trim() || argv[index + 1].startsWith('--');
  });
  if (!help && (missing || !argv.includes('--apply') || !argv.includes('--quiet-window-active') || !argv.includes('--remediation-recovery-authorized'))) {
    throw Object.assign(new Error('DEV_REMEDIATION_RECOVERY_REQUIRED_ARGUMENT_MISSING'), { code: 'DEV_REMEDIATION_RECOVERY_REQUIRED_ARGUMENT_MISSING' });
  }
  return { help };
}

async function main() {
  const args = process.argv.slice(2);
  if (preparse(args).help) {
    console.log('Usage: npm --prefix backend run env:recover-dev-recovery-remediation-certified -- --apply --quiet-window-active --remediation-recovery-authorized --env <guarded-dev-env> --authority-key <private-key> --preparation <same-signed-preparation> --contract <same-signed-contract> --operation-inventory <same-signed-inventory> --state-dir <existing-remediation-state> --evidence-dir <new-private-recovery-evidence>');
    return;
  }
  const { runDevRecoveryRemediationCli } = await import('./lib/environment-sync/dev-recovery-remediation-cli.mjs');
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  console.log(JSON.stringify(await runDevRecoveryRemediationCli('recover', args, repoRoot)));
}

main().catch((error) => {
  const code = String(error?.code || error?.message || 'DEV_REMEDIATION_RECOVERY_FAILED')
    .replace(/[^A-Z0-9_]/gi, '_').slice(0, 160);
  console.error(`[dev-recovery-remediation-recovery] ${code}`);
  process.exitCode = 1;
});

#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

function preparse(argv) {
  const help = argv.includes('--help') || argv.includes('-h');
  const required = ['--env', '--authority-key', '--contract', '--operation-inventory', '--state-dir', '--evidence-dir'];
  const missingValue = required.some((name) => {
    const index = argv.indexOf(name);
    return index < 0 || !String(argv[index + 1] || '').trim() || argv[index + 1].startsWith('--');
  });
  if (!help && (
    missingValue || !argv.includes('--apply') || !argv.includes('--quiet-window-active') ||
    !argv.includes('--recovery-authorized')
  )) {
    const error = new Error('DEV_REFRESH_RECOVERY_REQUIRED_ARGUMENT_MISSING');
    error.code = 'DEV_REFRESH_RECOVERY_REQUIRED_ARGUMENT_MISSING';
    throw error;
  }
  return { help };
}

async function main() {
  const args = process.argv.slice(2);
  const parsed = preparse(args);
  if (parsed.help) {
    console.log('Usage: npm --prefix backend run env:recover-dev-certified -- --apply --quiet-window-active --recovery-authorized --env <guarded-dev-env> --authority-key <private-key> --contract <signed-contract> --operation-inventory <signed-inventory> --state-dir <existing-private-state-dir> --evidence-dir <new-private-recovery-evidence-dir>');
    return;
  }
  const { runDevCertifiedCli } = await import('./lib/environment-sync/dev-certified-cli.mjs');
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const result = await runDevCertifiedCli('recover', args, repoRoot);
  console.log(JSON.stringify(result));
}

main().catch((error) => {
  const code = String(error?.code || error?.message || 'DEV_REFRESH_RECOVERY_FAILED')
    .replace(/[^A-Z0-9_]/gi, '_').slice(0, 120);
  console.error(`[dev-certified-recovery] ${code}`);
  process.exitCode = 1;
});

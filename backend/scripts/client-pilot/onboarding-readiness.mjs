#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildTargetEnvReport,
  formatTargetEnvReport,
  loadEnvFile,
} from '../lib/target-env-guards.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendDir = path.resolve(__dirname, '..', '..');
const repoRoot = path.resolve(backendDir, '..');

const APPROVAL_GATES = Object.freeze([
  'create production client organization',
  'create or invite production users',
  'approve access requests',
  'assign owner/admin/member roles',
  'change feature permissions',
  'create warehouses',
  'create owner companies',
  'import or add starting inventory',
  'create starting jobs or film orders',
  'create Rob/client support account',
  'disable, deny, or remove user access',
  'export client data',
  'archive, delete, or purge client data',
  'run any production SQL, RPC, script apply mode, or Supabase Auth admin operation',
]);

const FORBIDDEN_WITHOUT_APPROVAL = Object.freeze([
  'PROD data mutation',
  'PROD organization creation',
  'PROD user creation or approval',
  'Supabase auth setting changes',
  'migrations',
  'Supabase Edge/API deploy',
  'manual Vercel deploy',
  'branch cleanup',
  'npm audit fix',
]);

function asTrimmedString(value) {
  return String(value ?? '').trim();
}

function parseArgs(argv = []) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      continue;
    }
    const key = token.slice(2);
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

function resolveRepoPath(value, fallback) {
  const raw = asTrimmedString(value || fallback);
  if (!raw) {
    return '';
  }
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(repoRoot, raw);
}

function runGit(args) {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (_error) {
    return '';
  }
}

function getGitSummary() {
  return {
    branch: runGit(['rev-parse', '--abbrev-ref', 'HEAD']),
    head: runGit(['rev-parse', 'HEAD']),
    statusShort: runGit(['status', '--short']),
  };
}

function buildReadinessReport({
  target = 'prod',
  envPath = '',
  allowProdRead = false,
  expectedMain = '',
  gitSummary = getGitSummary(),
} = {}) {
  const normalizedTarget = asTrimmedString(target || 'prod').toLowerCase();
  const defaultEnvPath = normalizedTarget === 'prod' ? 'backend/.env.prod' : 'backend/.env.dev';
  const resolvedEnvPath = resolveRepoPath(envPath, defaultEnvPath);
  const loadedEnv = loadEnvFile(resolvedEnvPath);
  const targetReport = buildTargetEnvReport({
    envPath: loadedEnv.path,
    envValues: loadedEnv.values,
    expect: normalizedTarget,
    allowProd: normalizedTarget === 'prod' && allowProdRead,
  });

  const issues = [];
  if (normalizedTarget === 'prod' && !allowProdRead) {
    issues.push('Pass --allow-prod-read to make the read-only PROD target check explicit.');
  }
  if (!targetReport.ok) {
    issues.push(...targetReport.errors);
  }
  if (asTrimmedString(gitSummary.statusShort)) {
    issues.push('Working tree is not clean.');
  }
  const expectedMainSha = asTrimmedString(expectedMain);
  const headMatchesExpectedMain = expectedMainSha
    ? asTrimmedString(gitSummary.head) === expectedMainSha
    : null;
  if (expectedMainSha && !headMatchesExpectedMain) {
    issues.push(`HEAD does not match expected main ${expectedMainSha}.`);
  }

  return {
    mode: 'read-only-client-pilot-readiness',
    target: normalizedTarget,
    envReport: targetReport,
    git: {
      branch: asTrimmedString(gitSummary.branch),
      head: asTrimmedString(gitSummary.head),
      workingTreeClean: !asTrimmedString(gitSummary.statusShort),
      expectedMain: expectedMainSha,
      headMatchesExpectedMain,
    },
    approvalGates: [...APPROVAL_GATES],
    forbiddenWithoutApproval: [...FORBIDDEN_WITHOUT_APPROVAL],
    issues,
    ok: issues.length === 0,
  };
}

function formatReadinessReport(report) {
  const lines = [];
  lines.push('[client-pilot-readiness]');
  lines.push(`mode: ${report.mode}`);
  lines.push(`target: ${report.target}`);
  lines.push(`branch: ${report.git.branch || '<unknown>'}`);
  lines.push(`head: ${report.git.head || '<unknown>'}`);
  lines.push(`workingTree: ${report.git.workingTreeClean ? 'clean' : 'dirty'}`);
  if (report.git.expectedMain) {
    lines.push(`expectedMain: ${report.git.expectedMain}`);
    lines.push(`headMatchesExpectedMain: ${report.git.headMatchesExpectedMain ? 'yes' : 'no'}`);
  }
  lines.push('');
  lines.push(formatTargetEnvReport(report.envReport));
  lines.push('');
  lines.push('approvalGates:');
  for (const gate of report.approvalGates) {
    lines.push(`  - ${gate}`);
  }
  lines.push('');
  lines.push('forbiddenWithoutApproval:');
  for (const action of report.forbiddenWithoutApproval) {
    lines.push(`  - ${action}`);
  }
  if (report.issues.length > 0) {
    lines.push('');
    lines.push('issues:');
    for (const issue of report.issues) {
      lines.push(`  - ${issue}`);
    }
  }
  lines.push('');
  lines.push(`result: ${report.ok ? 'ok' : 'attention_required'}`);
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const target = asTrimmedString(args.target || 'prod').toLowerCase();
  const report = buildReadinessReport({
    target,
    envPath: args.env,
    allowProdRead: args['allow-prod-read'] === true,
    expectedMain: args['expected-main'],
  });

  console.log(formatReadinessReport(report));
  process.exitCode = report.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((error) => {
    console.error(error?.message || error);
    process.exitCode = 1;
  });
}

export {
  APPROVAL_GATES,
  FORBIDDEN_WITHOUT_APPROVAL,
  buildReadinessReport,
  formatReadinessReport,
  parseArgs,
};

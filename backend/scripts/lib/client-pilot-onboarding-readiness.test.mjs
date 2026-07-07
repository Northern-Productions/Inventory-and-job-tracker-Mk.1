import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  APPROVAL_GATES,
  buildReadinessReport,
  formatReadinessReport,
  parseArgs,
} from '../client-pilot/onboarding-readiness.mjs';

const DEV_REF = 'uxiltcpbhthhinonttrc';
const PROD_REF = 'tiwpulgvxtwlmqdnyuzd';

function writeTempEnv(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'client-pilot-readiness-'));
  const envPath = path.join(dir, '.env.test');
  fs.writeFileSync(envPath, contents, 'utf8');
  return envPath;
}

test('parseArgs handles flags and values', () => {
  assert.deepEqual(
    parseArgs(['--target', 'prod', '--allow-prod-read', '--expected-main', 'abc']),
    {
      target: 'prod',
      'allow-prod-read': true,
      'expected-main': 'abc',
    }
  );
});

test('prod readiness requires explicit read-only prod acknowledgement', () => {
  const envPath = writeTempEnv(`SUPABASE_URL=https://${PROD_REF}.supabase.co\n`);
  const report = buildReadinessReport({
    target: 'prod',
    envPath,
    allowProdRead: false,
    gitSummary: {
      branch: 'main',
      head: 'abc',
      statusShort: '',
    },
  });

  assert.equal(report.ok, false);
  assert.match(report.issues.join('\n'), /--allow-prod-read/);
});

test('prod readiness report is ok for clean git and guarded prod env', () => {
  const envPath = writeTempEnv(`SUPABASE_URL=https://${PROD_REF}.supabase.co\nDATABASE_URL=postgres://placeholder@db.${PROD_REF}.supabase.co/postgres\n`);
  const report = buildReadinessReport({
    target: 'prod',
    envPath,
    allowProdRead: true,
    expectedMain: 'abc',
    gitSummary: {
      branch: 'main',
      head: 'abc',
      statusShort: '',
    },
  });

  assert.equal(report.ok, true);
  assert.equal(report.envReport.expected.ref, PROD_REF);
  assert.equal(report.git.headMatchesExpectedMain, true);
});

test('dev readiness supports guarded dev env without prod acknowledgement', () => {
  const envPath = writeTempEnv(`SUPABASE_URL=https://${DEV_REF}.supabase.co\n`);
  const report = buildReadinessReport({
    target: 'dev',
    envPath,
    gitSummary: {
      branch: 'ops/client-pilot-onboarding-runbook',
      head: 'abc',
      statusShort: '',
    },
  });

  assert.equal(report.ok, true);
  assert.equal(report.envReport.expected.ref, DEV_REF);
});

test('formatted readiness output omits env values and lists approval gates', () => {
  const envPath = writeTempEnv(`SUPABASE_URL=https://${PROD_REF}.supabase.co\nSECRET_VALUE=do-not-print-me\n`);
  const report = buildReadinessReport({
    target: 'prod',
    envPath,
    allowProdRead: true,
    gitSummary: {
      branch: 'main',
      head: 'abc',
      statusShort: '',
    },
  });
  const formatted = formatReadinessReport(report);

  assert.match(formatted, /approvalGates:/);
  assert.ok(APPROVAL_GATES.includes('create production client organization'));
  assert.doesNotMatch(formatted, /do-not-print-me/);
  assert.match(formatted, new RegExp(PROD_REF));
});

test('dirty git state blocks readiness', () => {
  const envPath = writeTempEnv(`SUPABASE_URL=https://${PROD_REF}.supabase.co\n`);
  const report = buildReadinessReport({
    target: 'prod',
    envPath,
    allowProdRead: true,
    gitSummary: {
      branch: 'main',
      head: 'abc',
      statusShort: ' M docs/example.md',
    },
  });

  assert.equal(report.ok, false);
  assert.match(report.issues.join('\n'), /Working tree is not clean/);
});

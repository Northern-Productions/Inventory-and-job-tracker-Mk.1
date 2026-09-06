import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEV_PROJECT_REF,
  PROD_PROJECT_REF,
  SANDBOX_PROJECT_REF_VARIABLE,
  buildMutationTargetReport,
  buildTargetEnvReport,
  extractDbProjectRef,
  extractSupabaseProjectRef,
  formatTargetEnvReport,
  loadEnvFile,
  parseEnvContents
} from './target-env-guards.mjs';

const SANDBOX_PROJECT_REF = 'sandboxref0000000001';

test('target env guard accepts expected DEV refs', () => {
  const envValues = parseEnvContents(`
SUPABASE_URL=https://${DEV_PROJECT_REF}.supabase.co
DATABASE_URL=postgresql://postgres:secret@db.${DEV_PROJECT_REF}.supabase.co:5432/postgres
`);

  const report = buildTargetEnvReport({ envValues, expect: 'dev' });

  assert.equal(report.ok, true);
  assert.equal(report.expected.ref, DEV_PROJECT_REF);
  assert.equal(report.refs.length, 1);
  assert.equal(report.refs[0].target, 'dev');
});

test('target env guard rejects PROD refs when checking DEV', () => {
  const envValues = parseEnvContents(`
SUPABASE_URL=https://${PROD_PROJECT_REF}.supabase.co
DATABASE_URL=postgresql://postgres:secret@db.${PROD_PROJECT_REF}.supabase.co:5432/postgres
`);

  const report = buildTargetEnvReport({ envValues, expect: 'dev' });

  assert.equal(report.ok, false);
  assert.match(report.errors.join(' '), /PROD project ref/);
  assert.match(report.errors.join(' '), /Expected dev project ref/);
});

test('target env guard allows PROD only when explicitly expected and allowed', () => {
  const envValues = parseEnvContents(`
SUPABASE_URL=https://${PROD_PROJECT_REF}.supabase.co
SUPABASE_DB_URL=postgresql://postgres:secret@db.${PROD_PROJECT_REF}.supabase.co:5432/postgres
`);

  const blocked = buildTargetEnvReport({ envValues, expect: 'prod' });
  assert.equal(blocked.ok, false);
  assert.match(blocked.errors.join(' '), /--allow-prod/);

  const allowed = buildTargetEnvReport({ envValues, expect: 'prod', allowProd: true });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.refs[0].target, 'prod');
});

test('target env guard accepts a configured future SANDBOX ref and refuses an unset ref', () => {
  assert.throws(
    () => buildTargetEnvReport({ envValues: {}, expect: 'sandbox' }),
    new RegExp(SANDBOX_PROJECT_REF_VARIABLE)
  );

  const envValues = parseEnvContents(`
${SANDBOX_PROJECT_REF_VARIABLE}=${SANDBOX_PROJECT_REF}
SUPABASE_URL=https://${SANDBOX_PROJECT_REF}.supabase.co
SANDBOX_DATABASE_URL=postgresql://postgres:secret@db.${SANDBOX_PROJECT_REF}.supabase.co:5432/postgres
`);
  const report = buildTargetEnvReport({ envValues, expect: 'sandbox' });

  assert.equal(report.ok, true);
  assert.equal(report.expected.ref, SANDBOX_PROJECT_REF);
  assert.equal(report.refs[0].target, 'sandbox');
});

test('mutation target guard requires an explicit known target', () => {
  assert.throws(() => buildMutationTargetReport({}), /explicit target/);
  assert.throws(
    () => buildMutationTargetReport({ requestedTarget: 'mystery' }),
    /Unknown mutation target/
  );
});

test('mutation target guard rejects every cross-target credential combination', () => {
  const devValues = parseEnvContents(`SUPABASE_URL=https://${DEV_PROJECT_REF}.supabase.co`);
  const prodValues = parseEnvContents(`SUPABASE_URL=https://${PROD_PROJECT_REF}.supabase.co`);
  const sandboxValues = parseEnvContents(`
${SANDBOX_PROJECT_REF_VARIABLE}=${SANDBOX_PROJECT_REF}
SUPABASE_URL=https://${SANDBOX_PROJECT_REF}.supabase.co
`);

  assert.equal(
    buildMutationTargetReport({ envValues: devValues, requestedTarget: 'dev' }).ok,
    true
  );
  assert.equal(
    buildMutationTargetReport({
      envValues: prodValues,
      requestedTarget: 'prod',
      allowProd: true
    }).ok,
    true
  );
  assert.equal(
    buildMutationTargetReport({ envValues: sandboxValues, requestedTarget: 'sandbox' }).ok,
    true
  );

  for (const [envValues, requestedTarget] of [
    [devValues, 'prod'],
    [devValues, 'sandbox'],
    [prodValues, 'dev'],
    [prodValues, 'sandbox'],
    [sandboxValues, 'dev'],
    [sandboxValues, 'prod']
  ]) {
    let report;
    try {
      report = buildMutationTargetReport({
        envValues,
        requestedTarget,
        allowProd: requestedTarget === 'prod'
      });
    } catch (error) {
      assert.match(error.message, /SANDBOX project ref is unset/);
      continue;
    }
    assert.equal(report.ok, false);
  }
});

test('mutation target guard rejects all linked mutation configuration', () => {
  const envValues = parseEnvContents(`SUPABASE_URL=https://${DEV_PROJECT_REF}.supabase.co`);

  const ambiguous = buildMutationTargetReport({
    envValues,
    requestedTarget: 'dev',
    linked: true
  });
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.errors.join(' '), /Mutating --linked usage is forbidden/);

  const matching = buildMutationTargetReport({
    envValues,
    requestedTarget: 'dev',
    linked: true,
    linkedRef: DEV_PROJECT_REF
  });
  assert.equal(matching.ok, false);
  assert.match(matching.errors.join(' '), /Mutating --linked usage is forbidden/);

  const stale = buildMutationTargetReport({
    envValues,
    requestedTarget: 'dev',
    linked: true,
    linkedRef: PROD_PROJECT_REF
  });
  assert.equal(stale.ok, false);
  assert.match(stale.errors.join(' '), /Mutating --linked usage is forbidden/);
});

test('target env guard extracts refs from Supabase URLs and DB URLs', () => {
  assert.equal(extractSupabaseProjectRef(`https://${DEV_PROJECT_REF}.supabase.co`), DEV_PROJECT_REF);
  assert.equal(
    extractDbProjectRef(`postgresql://postgres:secret@db.${PROD_PROJECT_REF}.supabase.co:5432/postgres`),
    PROD_PROJECT_REF
  );
});

test('target env guard extracts refs from Supabase pooler usernames', () => {
  assert.equal(
    extractDbProjectRef(
      `postgresql://postgres.${DEV_PROJECT_REF}:secret@aws-0-us-east-1.pooler.supabase.com:6543/postgres`
    ),
    DEV_PROJECT_REF
  );
});

test('target env guard reports explicit ref variables', () => {
  const envValues = parseEnvContents(`
DEV_PROJECT_REF=${DEV_PROJECT_REF}
`);

  const report = buildTargetEnvReport({ envValues, expect: 'dev' });

  assert.equal(report.ok, true);
  assert.deepEqual(report.refs[0].variables, ['DEV_PROJECT_REF']);
  assert.deepEqual(report.refs[0].sources, ['explicit-ref']);
});

test('target env guard output is redacted and does not include secret values', () => {
  const secretPassword = 'super-secret-password';
  const envValues = parseEnvContents(`
SUPABASE_URL=https://${DEV_PROJECT_REF}.supabase.co
DATABASE_URL=postgresql://postgres:${secretPassword}@db.${DEV_PROJECT_REF}.supabase.co:5432/postgres
SUPABASE_SERVICE_ROLE_KEY=service-role-secret-value
`);

  const reportText = formatTargetEnvReport(buildTargetEnvReport({ envValues, expect: 'dev' }));

  assert.equal(reportText.includes(secretPassword), false);
  assert.equal(reportText.includes('service-role-secret-value'), false);
  assert.match(reportText, /DATABASE_URL/);
  assert.match(reportText, new RegExp(DEV_PROJECT_REF));
});

test('target env guard gives useful non-secret errors for missing files and missing refs', () => {
  const missingPath = path.join(os.tmpdir(), `missing-env-${Date.now()}.env`);
  assert.throws(() => loadEnvFile(missingPath), /Env file not found/);

  const report = buildTargetEnvReport({
    envValues: parseEnvContents('SMOKE_USER_PASSWORD=do-not-print-me'),
    expect: 'dev'
  });
  const reportText = formatTargetEnvReport(report);

  assert.equal(report.ok, false);
  assert.match(report.errors.join(' '), /No Supabase project refs/);
  assert.equal(reportText.includes('do-not-print-me'), false);
});

test('target env guard loads dotenv files without dependencies', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'target-env-'));
  const envPath = path.join(dir, '.env.dev');
  fs.writeFileSync(envPath, `export SUPABASE_URL="https://${DEV_PROJECT_REF}.supabase.co"\n`, 'utf8');

  const loaded = loadEnvFile(envPath);

  assert.equal(loaded.values.SUPABASE_URL, `https://${DEV_PROJECT_REF}.supabase.co`);
});

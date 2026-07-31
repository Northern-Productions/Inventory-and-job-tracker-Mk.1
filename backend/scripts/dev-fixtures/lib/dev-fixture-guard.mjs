import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  DEV_PROJECT_REF,
  buildTargetEnvReport,
  formatTargetEnvReport,
  loadEnvFile,
} from '../../lib/target-env-guards.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const BACKEND_DIR = path.resolve(REPO_ROOT, 'backend');
const DEFAULT_ENV_PATH = path.resolve(BACKEND_DIR, '.env.dev');
const DEFAULT_APP_URL = 'http://127.0.0.1:5173';
const TAG_PREFIX = 'CODEX_DEV_FIXTURE';

function asText(value) {
  return String(value ?? '').trim();
}

function normalizeTagPart(value) {
  return asText(value).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function randomDigits(length = 10) {
  let value = '';
  while (value.length < length) {
    value += Math.floor(Math.random() * 10).toString();
  }
  return value.slice(0, length);
}

function parseArgs(argv = []) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!String(token).startsWith('--')) {
      continue;
    }

    const [rawKey, rawValue] = token.slice(2).split('=', 2);
    const key = asText(rawKey);
    if (!key) {
      continue;
    }

    if (rawValue !== undefined) {
      args[key] = rawValue;
      continue;
    }

    const next = argv[index + 1];
    if (!next || String(next).startsWith('--')) {
      args[key] = true;
      continue;
    }

    args[key] = next;
    index += 1;
  }
  return args;
}

function requireScenario(value) {
  const scenario = asText(value);
  if (!scenario) {
    throw new Error('--scenario is required.');
  }
  if (![
    'checked-out-box-job',
    'allocation-eligibility',
    'atomic-transfer-assisted-allocation',
    'allocation-timeout-remediation',
  ].includes(scenario)) {
    throw new Error(`Unsupported fixture scenario: ${scenario}`);
  }
  return scenario;
}

function normalizeFixtureTag(value, scenario = '') {
  const tag = asText(value);
  if (!tag) {
    return buildFixtureTag(scenario);
  }

  const normalized = normalizeTagPart(tag);
  if (!normalized.startsWith(`${TAG_PREFIX}_`)) {
    throw new Error(`Fixture tag must start with ${TAG_PREFIX}_.`);
  }
  if (normalized.length < `${TAG_PREFIX}_X_0000`.length) {
    throw new Error('Fixture tag is too short to be safe.');
  }
  return normalized;
}

function buildFixtureTag(scenario = '') {
  const scenarioPart = normalizeTagPart(scenario || 'GENERAL') || 'GENERAL';
  return `${TAG_PREFIX}_${scenarioPart}_${randomDigits(11)}`;
}

function buildFixtureDealerIdentity(tag) {
  const normalizedTag = normalizeFixtureTag(tag);
  const name = `Codex Fixture Dealer ${normalizedTag}`;
  return {
    code: name.toLowerCase(),
    name,
  };
}

function assertFixtureDealerAvailable({ codeMatches = 0, nameMatches = 0 } = {}) {
  const exactCodeMatches = Number(codeMatches);
  const exactNameMatches = Number(nameMatches);
  if (!Number.isInteger(exactCodeMatches) || !Number.isInteger(exactNameMatches)) {
    throw new Error('Fixture dealer collision counts must be integers.');
  }
  if (exactCodeMatches !== 0 || exactNameMatches !== 0) {
    throw new Error('Tagged fixture dealer identity already exists; use a fresh fixture tag.');
  }
  return true;
}

function isUuidLike(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(asText(value));
}

function assertRepoRelativePath(filePath, label = 'path') {
  const resolved = path.resolve(filePath);
  const relative = path.relative(REPO_ROOT, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside the repository workspace.`);
  }
  return resolved;
}

function assertNotRunlogPath(filePath) {
  const relative = path.relative(REPO_ROOT, path.resolve(filePath)).replace(/\\/g, '/');
  if (relative === '.codex-runlogs' || relative.startsWith('.codex-runlogs/')) {
    throw new Error('Fixture manifests must not be written under .codex-runlogs.');
  }
}

function assertIgnoredPath(filePath) {
  const resolved = assertRepoRelativePath(filePath, 'ignored path');
  const relative = path.relative(REPO_ROOT, resolved).replace(/\\/g, '/');
  try {
    execFileSync('git', ['check-ignore', '-q', '--', relative], {
      cwd: REPO_ROOT,
      stdio: 'ignore',
    });
  } catch (_error) {
    throw new Error(`Refusing to use ${relative} because it is not gitignored.`);
  }
  return resolved;
}

function loadDevFixtureConfig(options = {}) {
  const envPath = path.resolve(BACKEND_DIR, asText(options.env || '.env.dev'));
  assertRepoRelativePath(envPath, 'env path');
  if (path.basename(envPath).toLowerCase().includes('prod')) {
    throw new Error('Refusing to load a PROD-looking env file for DEV fixtures.');
  }

  const loaded = loadEnvFile(envPath);
  const report = buildTargetEnvReport({
    envPath: loaded.path,
    envValues: loaded.values,
    expect: 'dev',
    allowProd: false,
  });
  if (!report.ok) {
    throw new Error(`DEV fixture target guard failed.\n${formatTargetEnvReport(report)}`);
  }

  const databaseUrl = asText(loaded.values.DEV_DATABASE_URL || loaded.values.DATABASE_URL);
  if (!databaseUrl) {
    throw new Error('DEV_DATABASE_URL or DATABASE_URL is required in backend/.env.dev.');
  }

  const orgId = asText(options['org-id'] || loaded.values.DEFAULT_ORG_ID);
  if (!isUuidLike(orgId)) {
    throw new Error('DEFAULT_ORG_ID or --org-id must be a UUID.');
  }

  for (const [key, value] of Object.entries(loaded.values)) {
    process.env[key] = value;
  }
  process.env.DATABASE_URL = databaseUrl;
  process.env.DEFAULT_ORG_ID = orgId;

  const manifestDir = assertIgnoredPath(
    path.resolve(REPO_ROOT, asText(options['manifest-dir'] || '.secrets/dev-fixtures'))
  );
  assertNotRunlogPath(manifestDir);

  return {
    repoRoot: REPO_ROOT,
    backendDir: BACKEND_DIR,
    envPath: loaded.path,
    projectRef: DEV_PROJECT_REF,
    orgId,
    databaseUrl,
    smokeUserEmail: asText(loaded.values.SMOKE_USER_EMAIL),
    manifestDir,
    appUrl: asText(options['app-url'] || DEFAULT_APP_URL).replace(/\/+$/g, ''),
    guardReport: report,
  };
}

export {
  DEV_PROJECT_REF,
  REPO_ROOT,
  TAG_PREFIX,
  asText,
  assertIgnoredPath,
  assertNotRunlogPath,
  assertRepoRelativePath,
  assertFixtureDealerAvailable,
  buildFixtureDealerIdentity,
  buildFixtureTag,
  isUuidLike,
  loadDevFixtureConfig,
  normalizeFixtureTag,
  parseArgs,
  requireScenario,
};

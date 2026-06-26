#!/usr/bin/env node

import '../load-env.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  DEV_PROJECT_REF,
  buildTargetEnvReport,
  formatTargetEnvReport,
  loadEnvFile
} from './lib/target-env-guards.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');
const BACKEND_ENV_PATH = path.resolve(REPO_ROOT, 'backend/.env');
const FRONTEND_ENV_PATH = path.resolve(REPO_ROOT, 'frontend/.env');
const DEFAULT_OUTPUT_PATH = path.resolve(REPO_ROOT, '.secrets/playwright/dev-storage-state.json');
const DEFAULT_APP_ORIGIN = 'http://127.0.0.1:5173';

function asTrimmedString(value) {
  return String(value || '').trim();
}

function parseArgs(argv = []) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      continue;
    }

    const [rawKey, rawValue] = token.slice(2).split('=', 2);
    const key = asTrimmedString(rawKey);
    if (!key) {
      continue;
    }

    if (rawValue !== undefined) {
      options[key] = rawValue;
      continue;
    }

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

function printUsage() {
  console.log(`Usage: node scripts/create-dev-browser-auth-state.mjs [--out <path>] [--app-url <url>]

Creates an ignored Playwright storage-state file for authenticated DEV browser checks.
The file contains auth material and must stay local/secret.

Defaults:
  --out .secrets/playwright/dev-storage-state.json
  --app-url http://127.0.0.1:5173`);
}

function assertDevEnv(envPath, label) {
  const loaded = loadEnvFile(envPath);
  const report = buildTargetEnvReport({
    envPath: loaded.path,
    envValues: loaded.values,
    expect: 'dev',
    allowProd: false
  });

  if (!report.ok) {
    throw new Error(`${label} target guard failed.\n${formatTargetEnvReport(report)}`);
  }

  return report;
}

function normalizeOutputPath(value) {
  const candidate = asTrimmedString(value);
  return candidate ? path.resolve(REPO_ROOT, candidate) : DEFAULT_OUTPUT_PATH;
}

function normalizeAppOrigin(value) {
  const raw = asTrimmedString(value) || DEFAULT_APP_ORIGIN;
  const parsed = new URL(raw);
  return parsed.origin;
}

function assertIgnoredPath(filePath) {
  const relativePath = path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');
  try {
    execFileSync('git', ['check-ignore', '-q', '--', relativePath], {
      cwd: REPO_ROOT,
      stdio: 'ignore'
    });
  } catch (_error) {
    throw new Error(
      `Refusing to write auth storage state because ${relativePath} is not gitignored.`
    );
  }
}

function assertOutputNotInRunlogs(filePath) {
  const relativePath = path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');
  if (relativePath === '.codex-runlogs' || relativePath.startsWith('.codex-runlogs/')) {
    throw new Error('Refusing to write browser auth state under .codex-runlogs.');
  }
}

function buildStoredAuthSession(session) {
  const user = session.user || {};
  const email = asTrimmedString(user.email);
  const userMetadata = user.user_metadata && typeof user.user_metadata === 'object'
    ? user.user_metadata
    : {};
  const profileName =
    asTrimmedString(userMetadata.full_name) ||
    asTrimmedString(userMetadata.name) ||
    deriveNameFromEmail(email);
  const expiresAtSeconds = Number(session.expires_at) || Math.floor(Date.now() / 1000) + Number(session.expires_in || 3600);

  return {
    token: session.access_token,
    user: {
      email,
      hasProfileName: true,
      name: profileName,
      picture: asTrimmedString(userMetadata.avatar_url),
      sub: asTrimmedString(user.id)
    },
    issuedAt: Date.now(),
    expiresAt: expiresAtSeconds * 1000
  };
}

function deriveNameFromEmail(email) {
  const localPart = String(email || '').split('@')[0] || '';
  const sanitized = localPart.replace(/[._-]+/g, ' ').trim();
  return sanitized || 'Inventory User';
}

function requireSmokeCredentials() {
  const email = asTrimmedString(process.env.SMOKE_USER_EMAIL);
  const password = asTrimmedString(process.env.SMOKE_USER_PASSWORD);
  if (!email || !password) {
    throw new Error(
      'SMOKE_USER_EMAIL and SMOKE_USER_PASSWORD are required in backend/.env. ' +
      'Run npm --prefix backend run smoke:provision-user against DEV, then retry.'
    );
  }
  return { email, password };
}

async function signInSmokeUser({ email, password }) {
  const supabaseUrl = asTrimmedString(process.env.SUPABASE_URL).replace(/\/+$/g, '');
  const anonKey = asTrimmedString(process.env.SUPABASE_ANON_KEY);
  if (!supabaseUrl || !anonKey) {
    throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY are required in backend/.env.');
  }

  const response = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: anonKey
    },
    body: JSON.stringify({ email, password })
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch (_error) {
    payload = null;
  }

  if (!response.ok) {
    const detail = asTrimmedString(
      payload?.msg || payload?.error_description || payload?.error || payload?.message
    );
    throw new Error(`Unable to sign in DEV smoke user.${detail ? ` ${detail}` : ''}`.trim());
  }

  if (!payload?.access_token || !payload?.refresh_token || !payload?.user?.id) {
    throw new Error('Supabase Auth did not return a complete session for the DEV smoke user.');
  }

  return payload;
}

function buildStorageState({ appOrigin, projectRef, session }) {
  const supabaseStorageKey = `sb-${projectRef}-auth-token`;
  return {
    cookies: [],
    origins: [
      {
        origin: appOrigin,
        localStorage: [
          {
            name: supabaseStorageKey,
            value: JSON.stringify(session)
          },
          {
            name: 'inventory-auth-session',
            value: JSON.stringify(buildStoredAuthSession(session))
          }
        ]
      }
    ]
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || options.h) {
    printUsage();
    return;
  }

  const outputPath = normalizeOutputPath(options.out);
  const appOrigin = normalizeAppOrigin(options['app-url']);

  const backendReport = assertDevEnv(BACKEND_ENV_PATH, 'Backend env');
  assertDevEnv(FRONTEND_ENV_PATH, 'Frontend env');
  assertOutputNotInRunlogs(outputPath);
  assertIgnoredPath(outputPath);

  const credentials = requireSmokeCredentials();
  const session = await signInSmokeUser(credentials);
  const storageState = buildStorageState({
    appOrigin,
    projectRef: DEV_PROJECT_REF,
    session
  });

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(storageState, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });

  console.log('DEV guard passed.');
  console.log(`DEV project ref verified: ${backendReport.expected.ref}`);
  console.log('Smoke user sign-in succeeded.');
  console.log(`Browser auth storage state written to ignored path: ${path.relative(REPO_ROOT, outputPath).replace(/\\/g, '/')}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

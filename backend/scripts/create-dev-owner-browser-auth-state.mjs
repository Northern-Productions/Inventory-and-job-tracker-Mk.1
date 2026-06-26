#!/usr/bin/env node

import '../load-env.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import {
  DEV_PROJECT_REF,
  buildTargetEnvReport,
  formatTargetEnvReport,
  loadEnvFile
} from './lib/target-env-guards.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');
const BACKEND_DEV_ENV_PATH = path.resolve(REPO_ROOT, 'backend/.env.dev');
const FRONTEND_ENV_PATH = path.resolve(REPO_ROOT, 'frontend/.env');
const DEFAULT_OUTPUT_PATH = path.resolve(REPO_ROOT, '.secrets/playwright/dev-owner-storage-state.json');
const DEFAULT_MANIFEST_PATH = path.resolve(REPO_ROOT, '.secrets/playwright/dev-owner-browser-auth.json');
const DEFAULT_APP_ORIGIN = 'http://127.0.0.1:5173';

function asTrimmedString(value) {
  return String(value || '').trim();
}

function parseArgs(argv = []) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!String(token).startsWith('--')) {
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
    if (!next || String(next).startsWith('--')) {
      options[key] = true;
      continue;
    }
    options[key] = next;
    index += 1;
  }
  return options;
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

  return { loaded, report };
}

function assertIgnoredPath(filePath) {
  const relativePath = path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');
  try {
    execFileSync('git', ['check-ignore', '-q', '--', relativePath], {
      cwd: REPO_ROOT,
      stdio: 'ignore'
    });
  } catch (_error) {
    throw new Error(`Refusing to write ${relativePath} because it is not gitignored.`);
  }
}

function assertNotRunlogPath(filePath) {
  const relativePath = path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');
  if (relativePath === '.codex-runlogs' || relativePath.startsWith('.codex-runlogs/')) {
    throw new Error('Refusing to write browser auth artifacts under .codex-runlogs.');
  }
}

function normalizeRepoPath(value, fallback) {
  const candidate = asTrimmedString(value);
  return candidate ? path.resolve(REPO_ROOT, candidate) : fallback;
}

function normalizeAppOrigin(value) {
  const raw = asTrimmedString(value) || DEFAULT_APP_ORIGIN;
  return new URL(raw).origin;
}

function normalizeTag(value) {
  const tag = asTrimmedString(value).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!tag.startsWith('CODEX_OWNER_BROWSER_')) {
    throw new Error('Owner browser auth tag must start with CODEX_OWNER_BROWSER_.');
  }
  if (tag.length < 'CODEX_OWNER_BROWSER_0000'.length) {
    throw new Error('Owner browser auth tag is too short to be safe.');
  }
  return tag;
}

function buildTag() {
  return `CODEX_OWNER_BROWSER_${Date.now()}_${crypto.randomInt(100000, 999999)}`;
}

function buildEmail(tag) {
  const safe = tag.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `codex-owner-browser+${safe}@example.com`;
}

function buildPassword() {
  return `Owner!${crypto.randomBytes(18).toString('hex')}`;
}

function deriveNameFromEmail(email) {
  const localPart = String(email || '').split('@')[0] || '';
  return localPart.replace(/[._-]+/g, ' ').trim() || 'Inventory Owner';
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

function buildStorageState({ appOrigin, projectRef, session }) {
  return {
    cookies: [],
    origins: [
      {
        origin: appOrigin,
        localStorage: [
          {
            name: `sb-${projectRef}-auth-token`,
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

async function fetchJson(response) {
  try {
    return await response.json();
  } catch (_error) {
    return null;
  }
}

function getConfig(envValues) {
  const supabaseUrl = asTrimmedString(envValues.SUPABASE_URL).replace(/\/+$/g, '');
  const anonKey = asTrimmedString(envValues.SUPABASE_ANON_KEY);
  const serviceRoleKey =
    asTrimmedString(process.env.SUPABASE_SERVICE_ROLE_KEY) ||
    asTrimmedString(process.env.SUPABASE_SERVICE_KEY) ||
    asTrimmedString(envValues.SUPABASE_SERVICE_ROLE_KEY) ||
    asTrimmedString(envValues.SUPABASE_SERVICE_KEY);
  const databaseUrl = asTrimmedString(envValues.DEV_DATABASE_URL || envValues.DATABASE_URL);
  const orgId = asTrimmedString(envValues.DEFAULT_ORG_ID);

  if (!supabaseUrl || !anonKey || !serviceRoleKey || !databaseUrl || !orgId) {
    throw new Error('DEV owner browser auth requires SUPABASE_URL, SUPABASE_ANON_KEY, a service role key, DATABASE_URL, and DEFAULT_ORG_ID.');
  }

  return { supabaseUrl, anonKey, serviceRoleKey, databaseUrl, orgId };
}

function buildDatabaseClient(databaseUrl) {
  return new Client({
    connectionString: databaseUrl,
    ssl: /localhost|127\.0\.0\.1/i.test(databaseUrl) ? undefined : { rejectUnauthorized: false }
  });
}

async function createAuthUser({ supabaseUrl, serviceRoleKey, email, password, tag }) {
  const response = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`
    },
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        name: 'Codex Owner Browser',
        full_name: 'Codex Owner Browser',
        fixture_tag: tag
      }
    })
  });
  const payload = await fetchJson(response);
  if (!response.ok) {
    const detail = asTrimmedString(payload?.msg || payload?.error_description || payload?.message || payload?.error);
    throw new Error(`Unable to create DEV owner auth user.${detail ? ` ${detail}` : ''}`.trim());
  }
  const userId = asTrimmedString(payload?.id || payload?.user?.id);
  if (!userId) {
    throw new Error('DEV owner auth user create response did not include a user id.');
  }
  return userId;
}

async function deleteAuthUser({ supabaseUrl, serviceRoleKey, userId }) {
  if (!userId) {
    return false;
  }
  const response = await fetch(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: 'DELETE',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`
    }
  });
  return response.ok || response.status === 404;
}

async function signIn({ supabaseUrl, anonKey, email, password }) {
  const response = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: anonKey
    },
    body: JSON.stringify({ email, password })
  });
  const payload = await fetchJson(response);
  if (!response.ok) {
    const detail = asTrimmedString(payload?.msg || payload?.error_description || payload?.message || payload?.error);
    throw new Error(`Unable to sign in DEV owner auth user.${detail ? ` ${detail}` : ''}`.trim());
  }
  if (!payload?.access_token || !payload?.refresh_token || !payload?.user?.id) {
    throw new Error('Supabase Auth did not return a complete owner browser session.');
  }
  return payload;
}

async function ensureOwnerMembership({ databaseUrl, orgId, userId, tag }) {
  const client = buildDatabaseClient(databaseUrl);
  await client.connect();
  try {
    await client.query(
      `
        insert into app.organization_members (org_id, user_id, role, created_at)
        values ($1::uuid, $2::uuid, 'owner', now())
        on conflict (org_id, user_id) do update
        set role = 'owner'
      `,
      [orgId, userId]
    );
    await client.query(
      `
        delete from app.access_requests
        where org_id = $1::uuid
          and user_id = $2::uuid
      `,
      [orgId, userId]
    );
    return { ok: true, tag };
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function cleanupOwnerArtifacts({ databaseUrl, supabaseUrl, serviceRoleKey, orgId, manifestPath, tag }) {
  let manifest = null;
  if (fs.existsSync(manifestPath)) {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  }
  const userId = asTrimmedString(manifest?.userId);
  const storageStatePath = normalizeRepoPath(manifest?.storageStatePath, DEFAULT_OUTPUT_PATH);

  const deleted = {
    ownerNotificationPreferences: 0,
    accessRequests: 0,
    organizationMembers: 0,
    authUser: false,
    storageState: false,
    manifest: false
  };

  if (userId) {
    const client = buildDatabaseClient(databaseUrl);
    await client.connect();
    try {
      const prefs = await client.query(
        `
          delete from app.owner_notification_preferences
          where org_id = $1::uuid
            and owner_user_id = $2::uuid
        `,
        [orgId, userId]
      );
      const access = await client.query(
        `
          delete from app.access_requests
          where org_id = $1::uuid
            and user_id = $2::uuid
        `,
        [orgId, userId]
      );
      const members = await client.query(
        `
          delete from app.organization_members
          where org_id = $1::uuid
            and user_id = $2::uuid
            and lower(role) = 'owner'
        `,
        [orgId, userId]
      );
      deleted.ownerNotificationPreferences = prefs.rowCount || 0;
      deleted.accessRequests = access.rowCount || 0;
      deleted.organizationMembers = members.rowCount || 0;
    } finally {
      await client.end().catch(() => undefined);
    }
    deleted.authUser = await deleteAuthUser({ supabaseUrl, serviceRoleKey, userId });
  }

  if (fs.existsSync(storageStatePath)) {
    fs.unlinkSync(storageStatePath);
    deleted.storageState = true;
  }
  if (fs.existsSync(manifestPath)) {
    fs.unlinkSync(manifestPath);
    deleted.manifest = true;
  }

  console.log('DEV owner browser auth cleanup complete.');
  console.log(`Auth tag: ${tag || asTrimmedString(manifest?.tag) || 'unknown'}`);
  console.log(`Organization membership rows deleted: ${deleted.organizationMembers}`);
  console.log(`Auth user deleted or absent: ${deleted.authUser ? 'yes' : userId ? 'no' : 'not-created'}`);
  console.log(`Storage state removed: ${deleted.storageState ? 'yes' : 'not-present'}`);
  console.log(`Manifest removed: ${deleted.manifest ? 'yes' : 'not-present'}`);
  return deleted;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const tag = normalizeTag(options.tag || buildTag());
  const outputPath = normalizeRepoPath(options.out, DEFAULT_OUTPUT_PATH);
  const manifestPath = normalizeRepoPath(options.manifest, DEFAULT_MANIFEST_PATH);
  const appOrigin = normalizeAppOrigin(options['app-url']);

  assertNotRunlogPath(outputPath);
  assertNotRunlogPath(manifestPath);
  assertIgnoredPath(outputPath);
  assertIgnoredPath(manifestPath);

  const { loaded: backendDevEnv, report: backendReport } = assertDevEnv(BACKEND_DEV_ENV_PATH, 'Backend DEV env');
  assertDevEnv(FRONTEND_ENV_PATH, 'Frontend env');
  const config = getConfig({ ...process.env, ...backendDevEnv.values });

  if (options.cleanup) {
    await cleanupOwnerArtifacts({ ...config, manifestPath, tag });
    return;
  }

  const email = buildEmail(tag);
  const password = buildPassword();
  let userId = '';
  try {
    userId = await createAuthUser({ ...config, email, password, tag });
    await ensureOwnerMembership({ ...config, userId, tag });
    const session = await signIn({ ...config, email, password });
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
    fs.writeFileSync(
      manifestPath,
      `${JSON.stringify({
        tag,
        projectRef: DEV_PROJECT_REF,
        userId,
        storageStatePath: path.relative(REPO_ROOT, outputPath).replace(/\\/g, '/'),
        createdAt: new Date().toISOString()
      }, null, 2)}\n`,
      {
        encoding: 'utf8',
        mode: 0o600
      }
    );

    console.log('DEV guard passed.');
    console.log(`DEV project ref verified: ${backendReport.expected.ref}`);
    console.log(`Owner browser auth tag: ${tag}`);
    console.log('Temporary owner membership created.');
    console.log(`Owner browser auth storage state written to ignored path: ${path.relative(REPO_ROOT, outputPath).replace(/\\/g, '/')}`);
    console.log(`Owner auth manifest written to ignored path: ${path.relative(REPO_ROOT, manifestPath).replace(/\\/g, '/')}`);
  } catch (error) {
    if (userId) {
      await cleanupOwnerArtifacts({ ...config, manifestPath, tag }).catch(() => undefined);
    }
    throw error;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

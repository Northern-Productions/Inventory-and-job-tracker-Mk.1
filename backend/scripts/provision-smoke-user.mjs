import '../load-env.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

function asTrimmedString(value) {
  return String(value || '').trim();
}

function buildDatabaseClient() {
  return new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: /localhost|127\.0\.0\.1/i.test(process.env.DATABASE_URL || '')
      ? undefined
      : { rejectUnauthorized: false }
  });
}

function buildDefaultSmokeEmail() {
  const supabaseUrl = asTrimmedString(process.env.SUPABASE_URL);
  if (!supabaseUrl) {
    return 'inventory-smoke@example.com';
  }

  const projectRef = new URL(supabaseUrl).hostname.split('.')[0] || 'inventory';
  return `smoke+${projectRef}@example.com`;
}

function buildDefaultSmokePassword() {
  return `Smoke!${crypto.randomBytes(16).toString('hex')}`;
}

async function readJson(response) {
  try {
    return await response.json();
  } catch (_error) {
    return null;
  }
}

async function signInWithPassword(supabaseUrl, anonKey, email, password) {
  const response = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: anonKey
    },
    body: JSON.stringify({ email, password })
  });
  const payload = await readJson(response);

  return {
    ok: response.ok,
    payload
  };
}

async function signUpWithPassword(supabaseUrl, anonKey, email, password) {
  const response = await fetch(`${supabaseUrl}/auth/v1/signup`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: anonKey
    },
    body: JSON.stringify({
      email,
      password,
      data: {
        name: 'Smoke User',
        full_name: 'Smoke User'
      }
    })
  });
  const payload = await readJson(response);

  return {
    ok: response.ok,
    payload
  };
}

async function ensureMembership(userId, orgId) {
  const client = buildDatabaseClient();
  await client.connect();
  try {
    await client.query(
      `
        insert into app.organization_members (
          org_id,
          user_id,
          role,
          created_at
        )
        values ($1::uuid, $2::uuid, 'member', now())
        on conflict (org_id, user_id) do nothing
      `,
      [orgId, userId]
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}

function upsertEnvValue(contents, key, value) {
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  const line = `${key}=${value}`;
  if (pattern.test(contents)) {
    return contents.replace(pattern, line);
  }

  return `${contents.replace(/\s*$/g, '')}\n${line}\n`;
}

function persistSmokeCredentials(email, password) {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const envPath = path.resolve(__dirname, '../.env');
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8').replace(/^\uFEFF/, '') : '';
  let next = existing;

  next = upsertEnvValue(next, 'SMOKE_AUTH_TOKEN', '');
  next = upsertEnvValue(next, 'SMOKE_USER_EMAIL', email);
  next = upsertEnvValue(next, 'SMOKE_USER_PASSWORD', password);

  fs.writeFileSync(envPath, next, 'utf8');
}

async function main() {
  const supabaseUrl = asTrimmedString(process.env.SUPABASE_URL).replace(/\/+$/g, '');
  const supabaseAnonKey = asTrimmedString(process.env.SUPABASE_ANON_KEY);
  const orgId = asTrimmedString(process.env.DEFAULT_ORG_ID);

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY are required.');
  }
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required.');
  }
  if (!orgId) {
    throw new Error('DEFAULT_ORG_ID is required.');
  }

  const email = asTrimmedString(process.env.SMOKE_USER_EMAIL) || buildDefaultSmokeEmail();
  const password = asTrimmedString(process.env.SMOKE_USER_PASSWORD) || buildDefaultSmokePassword();

  let authResult = await signInWithPassword(supabaseUrl, supabaseAnonKey, email, password);
  if (!authResult.ok) {
    const signUpResult = await signUpWithPassword(supabaseUrl, supabaseAnonKey, email, password);
    if (!signUpResult.ok) {
      const detail =
        asTrimmedString(signUpResult.payload?.msg) ||
        asTrimmedString(signUpResult.payload?.error_description) ||
        asTrimmedString(signUpResult.payload?.error) ||
        asTrimmedString(signUpResult.payload?.message);
      throw new Error(`Unable to provision smoke user ${email}.${detail ? ` ${detail}` : ''}`.trim());
    }

    authResult = await signInWithPassword(supabaseUrl, supabaseAnonKey, email, password);
    if (!authResult.ok) {
      const detail =
        asTrimmedString(authResult.payload?.msg) ||
        asTrimmedString(authResult.payload?.error_description) ||
        asTrimmedString(authResult.payload?.error) ||
        asTrimmedString(authResult.payload?.message);
      throw new Error(`Smoke user ${email} was created but sign-in still failed.${detail ? ` ${detail}` : ''}`.trim());
    }
  }

  const userId = asTrimmedString(authResult.payload?.user?.id);
  const accessToken = asTrimmedString(authResult.payload?.access_token);
  if (!userId || !accessToken) {
    throw new Error('Smoke user sign-in succeeded without a user id or access token.');
  }

  await ensureMembership(userId, orgId);
  persistSmokeCredentials(email, password);

  console.log(`Smoke user ready: ${email}`);
  console.log('Stored SMOKE_USER_EMAIL and SMOKE_USER_PASSWORD in backend/.env.');
  console.log('Future smoke scripts will mint fresh SMOKE_AUTH_TOKEN values automatically.');
}

main().catch((error) => {
  console.error('Smoke user provisioning failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});

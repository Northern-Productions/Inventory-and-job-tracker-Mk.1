// Purpose: Verify the live Supabase Edge runtime version and one authenticated job summary end-to-end.
import '../load-env.mjs';
import { execSync } from 'node:child_process';

function asTrimmedString(value) {
  return String(value || '').trim();
}

function integerEnv(name, fallback) {
  const raw = asTrimmedString(process.env[name]);
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number.`);
  }

  return Math.trunc(parsed);
}

function resolveExpectedBuildSha() {
  const explicit = asTrimmedString(process.env.EXPECTED_API_BUILD_SHA || process.env.API_BUILD_SHA);
  if (explicit) {
    return explicit;
  }

  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch (_error) {
    return '';
  }
}

function resolveApiBaseUrl() {
  const explicit = asTrimmedString(
    process.env.VERIFY_EDGE_URL || process.env.EDGE_API_BASE_URL || process.env.VITE_API_BASE_URL
  );
  if (explicit) {
    return explicit.replace(/\/+$/g, '');
  }

  const supabaseUrl = asTrimmedString(process.env.SUPABASE_URL).replace(/\/+$/g, '');
  if (supabaseUrl) {
    return `${supabaseUrl}/functions/v1/api`;
  }

  throw new Error('VERIFY_EDGE_URL, EDGE_API_BASE_URL, VITE_API_BASE_URL, or SUPABASE_URL is required.');
}

function buildUrl(baseUrl, logicalPath, query = {}) {
  const url = new URL(baseUrl);
  url.searchParams.set('path', logicalPath);
  Object.entries(query).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') {
      return;
    }
    url.searchParams.set(key, String(value));
  });
  return url;
}

async function fetchEnvelope(baseUrl, logicalPath, query = {}, token = '') {
  const headers = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(buildUrl(baseUrl, logicalPath, query), {
    method: 'GET',
    headers
  });

  let payload;
  try {
    payload = await response.json();
  } catch (_error) {
    const text = await response.text();
    throw new Error(`${logicalPath}: expected JSON response, received: ${text.slice(0, 200)}`);
  }

  if (!response.ok || !payload?.ok) {
    throw new Error(`${logicalPath}: ${payload?.error || `HTTP ${response.status}`}`);
  }

  return payload.data;
}

function assertJobSummary(label, summary, expected) {
  if (!summary || typeof summary !== 'object') {
    throw new Error(`${label}: missing summary object`);
  }

  const actual = {
    status: asTrimmedString(summary.status),
    requiredFeet: Number(summary.requiredFeet || 0),
    allocatedFeet: Number(summary.allocatedFeet || 0),
    remainingFeet: Number(summary.remainingFeet || 0)
  };

  if (actual.status !== expected.status) {
    throw new Error(`${label}: expected status ${expected.status}, received ${actual.status}`);
  }
  if (actual.requiredFeet !== expected.requiredFeet) {
    throw new Error(`${label}: expected requiredFeet ${expected.requiredFeet}, received ${actual.requiredFeet}`);
  }
  if (actual.allocatedFeet !== expected.allocatedFeet) {
    throw new Error(
      `${label}: expected allocatedFeet ${expected.allocatedFeet}, received ${actual.allocatedFeet}`
    );
  }
  if (actual.remainingFeet !== expected.remainingFeet) {
    throw new Error(
      `${label}: expected remainingFeet ${expected.remainingFeet}, received ${actual.remainingFeet}`
    );
  }
}

async function main() {
  const apiBaseUrl = resolveApiBaseUrl();
  const token = asTrimmedString(process.env.SMOKE_AUTH_TOKEN);
  const expectedBuildSha = resolveExpectedBuildSha();
  const jobNumber = asTrimmedString(process.env.VERIFY_EDGE_JOB_NUMBER || '18959');
  const expected = {
    status: asTrimmedString(process.env.VERIFY_EDGE_EXPECTED_STATUS || 'ALLOCATE'),
    requiredFeet: integerEnv('VERIFY_EDGE_EXPECTED_REQUIRED_FEET', 34),
    allocatedFeet: integerEnv('VERIFY_EDGE_EXPECTED_ALLOCATED_FEET', 32),
    remainingFeet: integerEnv('VERIFY_EDGE_EXPECTED_REMAINING_FEET', 2)
  };

  if (!token) {
    throw new Error('SMOKE_AUTH_TOKEN is required.');
  }
  if (!jobNumber) {
    throw new Error('VERIFY_EDGE_JOB_NUMBER is required.');
  }
  if (!expectedBuildSha) {
    throw new Error('EXPECTED_API_BUILD_SHA or a readable git HEAD is required.');
  }

  const health = await fetchEnvelope(apiBaseUrl, '/health');
  if (asTrimmedString(health.apiBuildSha) !== expectedBuildSha) {
    throw new Error(
      `/health: expected apiBuildSha ${expectedBuildSha}, received ${asTrimmedString(health.apiBuildSha)}`
    );
  }
  if (!asTrimmedString(health.apiBuiltAt)) {
    throw new Error('/health: apiBuiltAt must be non-empty.');
  }

  const jobDetail = await fetchEnvelope(apiBaseUrl, '/jobs/get', { jobNumber }, token);
  assertJobSummary('/jobs/get', jobDetail.summary, expected);

  const jobsList = await fetchEnvelope(
    apiBaseUrl,
    '/jobs/list',
    { limit: 100, lifecycleStatus: 'ACTIVE' },
    token
  );
  const entries = Array.isArray(jobsList.entries) ? jobsList.entries : [];
  const jobEntry = entries.find((entry) => asTrimmedString(entry?.jobNumber) === jobNumber);
  if (!jobEntry) {
    throw new Error(`/jobs/list: unable to find job ${jobNumber} in active entries.`);
  }
  assertJobSummary('/jobs/list', jobEntry, expected);

  console.log(
    `Live Edge verification passed for ${jobNumber}: ${expected.status} ${expected.requiredFeet}/${expected.allocatedFeet}/${expected.remainingFeet}`
  );
}

main().catch((error) => {
  console.error('Live Edge verification failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});

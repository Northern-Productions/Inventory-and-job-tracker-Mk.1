import fs from 'node:fs';
import path from 'node:path';

const DEV_PROJECT_REF = 'uxiltcpbhthhinonttrc';
const PROD_PROJECT_REF = 'tiwpulgvxtwlmqdnyuzd';
const SANDBOX_PROJECT_REF_VARIABLE = 'SANDBOX_SUPABASE_PROJECT_REF';

const TARGET_REFS = Object.freeze({
  dev: DEV_PROJECT_REF,
  prod: PROD_PROJECT_REF
});

const EXPLICIT_REF_KEYS = new Set([
  'DEV_PROJECT_REF',
  'DEV_REF',
  'PROD_PROJECT_REF',
  'PROD_REF',
  SANDBOX_PROJECT_REF_VARIABLE,
  'SANDBOX_PROJECT_REF',
  'SANDBOX_REF',
  'SUPABASE_PROJECT_REF',
  'PROJECT_REF',
  'TARGET_PROJECT_REF'
]);

function asTrimmedString(value) {
  return String(value ?? '').trim();
}

function normalizeEnvValue(rawValue) {
  const trimmed = asTrimmedString(rawValue);
  if (!trimmed) {
    return '';
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function normalizeRef(value) {
  return asTrimmedString(value).toLowerCase();
}

function isLikelyProjectRef(value) {
  return /^[a-z0-9]{10,40}$/.test(normalizeRef(value));
}

function uniqueByRefAndSource(entries) {
  const seen = new Set();
  const unique = [];
  for (const entry of entries) {
    const key = `${entry.ref}\0${entry.variable}\0${entry.source}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(entry);
  }
  return unique;
}

function configuredSandboxRef(envValues = {}, explicitSandboxRef = '') {
  return normalizeRef(
    explicitSandboxRef ||
      envValues[SANDBOX_PROJECT_REF_VARIABLE] ||
      envValues.SANDBOX_PROJECT_REF ||
      envValues.SANDBOX_REF
  );
}

function classifyProjectRef(ref, { sandboxRef = '' } = {}) {
  const normalized = normalizeRef(ref);
  if (normalized === DEV_PROJECT_REF) {
    return 'dev';
  }
  if (normalized === PROD_PROJECT_REF) {
    return 'prod';
  }
  if (sandboxRef && normalized === normalizeRef(sandboxRef)) {
    return 'sandbox';
  }
  return 'unknown';
}

function parseEnvContents(contents = '') {
  const values = {};
  for (const rawLine of String(contents || '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const normalized = line.startsWith('export ') ? line.slice(7).trim() : line;
    const separatorIndex = normalized.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const key = normalized.slice(0, separatorIndex).trim();
    if (!key) {
      continue;
    }

    values[key] = normalizeEnvValue(normalized.slice(separatorIndex + 1));
  }
  return values;
}

function loadEnvFileText(envPath) {
  const resolvedPath = path.resolve(envPath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Env file not found: ${resolvedPath}`);
  }
  return {
    path: resolvedPath,
    contents: fs.readFileSync(resolvedPath, 'utf8')
  };
}

function loadEnvFile(envPath) {
  const loaded = loadEnvFileText(envPath);
  return {
    path: loaded.path,
    values: parseEnvContents(loaded.contents)
  };
}

function extractSupabaseProjectRef(value) {
  const normalized = asTrimmedString(value);
  if (!normalized) {
    return '';
  }
  try {
    const parsed = new URL(normalized);
    const match = parsed.hostname.match(/^([a-z0-9-]+)\.supabase\.co$/i);
    return normalizeRef(match?.[1]);
  } catch (_error) {
    const match = normalized.match(/https?:\/\/([a-z0-9-]+)\.supabase\.co\b/i);
    return normalizeRef(match?.[1]);
  }
}

function extractDbProjectRef(value) {
  const normalized = asTrimmedString(value);
  if (!normalized) {
    return '';
  }
  try {
    const parsed = new URL(normalized);
    const match = parsed.hostname.match(/^db\.([a-z0-9-]+)\.supabase\.co$/i);
    if (match?.[1]) {
      return normalizeRef(match[1]);
    }

    const username = decodeURIComponent(parsed.username || '');
    const pooledMatch = username.match(/(?:^|\.)([a-z0-9]{10,40})$/i);
    if (pooledMatch?.[1] && /\.pooler\.supabase\.com$/i.test(parsed.hostname)) {
      return normalizeRef(pooledMatch[1]);
    }
  } catch (_error) {
    // Fall through to regex extraction.
  }

  const hostMatch = normalized.match(/\bdb\.([a-z0-9-]+)\.supabase\.co\b/i);
  if (hostMatch?.[1]) {
    return normalizeRef(hostMatch[1]);
  }

  const pooledMatch = normalized.match(
    /postgres(?:ql)?:\/\/[^:@/]+\.([a-z0-9]{10,40})(?::[^@/]*)?@[^/]*\.pooler\.supabase\.com\b/i
  );
  if (pooledMatch?.[1]) {
    return normalizeRef(pooledMatch[1]);
  }

  const queryMatch = normalized.match(/[?&](?:project|project_ref|ref)=([a-z0-9]{10,40})\b/i);
  return normalizeRef(queryMatch?.[1]);
}

function extractRefsFromValue(value, variable = '') {
  const refs = [];
  const supabaseRef = extractSupabaseProjectRef(value);
  if (supabaseRef) {
    refs.push({ ref: supabaseRef, variable, source: 'supabase-url' });
  }

  const dbRef = extractDbProjectRef(value);
  if (dbRef) {
    refs.push({ ref: dbRef, variable, source: 'database-url' });
  }

  const normalizedVariable = asTrimmedString(variable).toUpperCase();
  const explicitValue = normalizeRef(value);
  if (EXPLICIT_REF_KEYS.has(normalizedVariable) && isLikelyProjectRef(explicitValue)) {
    refs.push({ ref: explicitValue, variable, source: 'explicit-ref' });
  }

  return uniqueByRefAndSource(refs);
}

function extractLikelySupabaseRefs(envValues = {}, { sandboxRef = '' } = {}) {
  const resolvedSandboxRef = configuredSandboxRef(envValues, sandboxRef);
  const refs = [];
  for (const [variable, value] of Object.entries(envValues || {})) {
    refs.push(...extractRefsFromValue(value, variable));
  }
  return uniqueByRefAndSource(refs).map((entry) => ({
    ...entry,
    target: classifyProjectRef(entry.ref, { sandboxRef: resolvedSandboxRef })
  }));
}

function groupRefs(refEntries = [], { sandboxRef = '' } = {}) {
  const grouped = new Map();
  for (const entry of refEntries) {
    const existing =
      grouped.get(entry.ref) ||
      {
        ref: entry.ref,
        target: classifyProjectRef(entry.ref, { sandboxRef }),
        variables: new Set(),
        sources: new Set()
      };
    if (entry.variable) {
      existing.variables.add(entry.variable);
    }
    if (entry.source) {
      existing.sources.add(entry.source);
    }
    grouped.set(entry.ref, existing);
  }

  return Array.from(grouped.values()).map((entry) => ({
    ref: entry.ref,
    target: entry.target,
    variables: Array.from(entry.variables).sort(),
    sources: Array.from(entry.sources).sort()
  }));
}

function resolveExpectedRef(expect, { envValues = {}, sandboxRef = '' } = {}) {
  const normalized = normalizeRef(expect || 'dev');
  if (normalized === 'sandbox') {
    const resolvedSandboxRef = configuredSandboxRef(envValues, sandboxRef);
    if (!isLikelyProjectRef(resolvedSandboxRef)) {
      throw new Error(
        `SANDBOX project ref is unset. Define ${SANDBOX_PROJECT_REF_VARIABLE} before using SANDBOX.`
      );
    }
    return { target: 'sandbox', ref: resolvedSandboxRef };
  }
  if (TARGET_REFS[normalized]) {
    return {
      target: normalized,
      ref: TARGET_REFS[normalized]
    };
  }
  if (isLikelyProjectRef(normalized)) {
    return {
      target: classifyProjectRef(normalized, {
        sandboxRef: configuredSandboxRef(envValues, sandboxRef)
      }),
      ref: normalized
    };
  }
  throw new Error(
    `Unknown expected target "${expect}". Use "dev", "sandbox", "prod", or a Supabase project ref.`
  );
}

function buildTargetEnvReport({
  envPath = '',
  envValues = {},
  expect = 'dev',
  allowProd = false,
  sandboxRef = ''
} = {}) {
  const resolvedSandboxRef = configuredSandboxRef(envValues, sandboxRef);
  const expected = resolveExpectedRef(expect, { envValues, sandboxRef: resolvedSandboxRef });
  const refEntries = extractLikelySupabaseRefs(envValues, { sandboxRef: resolvedSandboxRef });
  const groupedRefs = groupRefs(refEntries, { sandboxRef: resolvedSandboxRef });
  const foundRefs = new Set(groupedRefs.map((entry) => entry.ref));
  const errors = [];
  const warnings = [];

  if (groupedRefs.length === 0) {
    errors.push('No Supabase project refs were found in the env file.');
  }

  if (expected.target === 'prod' && !allowProd) {
    errors.push('PROD checks require --allow-prod.');
  }

  const prodRefs = groupedRefs.filter((entry) => entry.ref === PROD_PROJECT_REF);
  if (prodRefs.length > 0 && !(expected.ref === PROD_PROJECT_REF && allowProd)) {
    errors.push(`PROD project ref ${PROD_PROJECT_REF} is present but PROD was not explicitly allowed.`);
  }

  if (foundRefs.size > 0 && !foundRefs.has(expected.ref)) {
    errors.push(`Expected ${expected.target} project ref ${expected.ref}, but it was not found.`);
  }

  const unexpectedRefs = groupedRefs.filter((entry) => entry.ref !== expected.ref);
  if (unexpectedRefs.length > 0) {
    errors.push(
      `Unexpected project refs found: ${unexpectedRefs
        .map((entry) => `${entry.ref} (${entry.target})`)
        .join(', ')}.`
    );
  }

  if (expected.target === 'unknown') {
    warnings.push(`Expected project ref ${expected.ref} is not one of the known DEV/PROD refs.`);
  }

  return {
    ok: errors.length === 0,
    envPath: envPath ? path.resolve(envPath) : '',
    expected,
    allowProd: Boolean(allowProd),
    refs: groupedRefs,
    errors,
    warnings
  };
}

function buildMutationTargetReport({
  envPath = '',
  envValues = {},
  requestedTarget = '',
  allowProd = false,
  sandboxRef = '',
  linked = false,
  linkedRef = ''
} = {}) {
  const target = normalizeRef(requestedTarget);
  if (!target) {
    throw new Error('Mutating commands require an explicit target: dev, sandbox, or prod.');
  }
  if (!['dev', 'sandbox', 'prod'].includes(target)) {
    throw new Error(`Unknown mutation target "${requestedTarget}". Use dev, sandbox, or prod.`);
  }

  const report = buildTargetEnvReport({
    envPath,
    envValues,
    expect: target,
    allowProd,
    sandboxRef
  });
  const errors = [...report.errors];
  const normalizedLinkedRef = normalizeRef(linkedRef);

  if (linked || normalizedLinkedRef) {
    errors.push('Mutating --linked usage is forbidden; use explicit target and project-ref configuration.');
  }

  return {
    ...report,
    ok: errors.length === 0,
    mode: 'mutation-guard',
    requestedTarget: target,
    linked: Boolean(linked),
    linkedRefMatches: null,
    errors
  };
}

function formatTargetEnvReport(report) {
  const lines = [];
  lines.push('[target-env-check]');
  if (report.envPath) {
    lines.push(`env: ${report.envPath}`);
  }
  lines.push(`expected: ${report.expected.target} (${report.expected.ref})`);
  lines.push(`allowProd: ${report.allowProd ? 'true' : 'false'}`);
  if (report.refs.length === 0) {
    lines.push('refs: none found');
  } else {
    lines.push('refs:');
    for (const entry of report.refs) {
      const variables = entry.variables.length ? entry.variables.join(', ') : '<unknown variable>';
      const sources = entry.sources.length ? entry.sources.join(', ') : '<unknown source>';
      lines.push(`  - ${entry.ref} (${entry.target}); variables: ${variables}; sources: ${sources}`);
    }
  }
  for (const warning of report.warnings) {
    lines.push(`warning: ${warning}`);
  }
  for (const error of report.errors) {
    lines.push(`error: ${error}`);
  }
  lines.push(`result: ${report.ok ? 'ok' : 'failed'}`);
  return lines.join('\n');
}

export {
  DEV_PROJECT_REF,
  PROD_PROJECT_REF,
  SANDBOX_PROJECT_REF_VARIABLE,
  TARGET_REFS,
  buildMutationTargetReport,
  buildTargetEnvReport,
  classifyProjectRef,
  configuredSandboxRef,
  extractDbProjectRef,
  extractLikelySupabaseRefs,
  extractRefsFromValue,
  extractSupabaseProjectRef,
  formatTargetEnvReport,
  loadEnvFile,
  loadEnvFileText,
  parseEnvContents,
  resolveExpectedRef
};

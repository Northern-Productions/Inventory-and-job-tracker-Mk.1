import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DEV_PROJECT_REF = "uxiltcpbhthhinonttrc";
const PROD_PROJECT_REF = "tiwpulgvxtwlmqdnyuzd";
const MUTATION_CONFIRMATION = "RUN_DEV_PERF_TIMING_AUDIT";
const DEFAULT_ALLOWED_DIRTY_PATHS = Object.freeze([
  "docs/performance/dev-timing-audit-plan.md",
  "backend/scripts/dev-timing-audit.mjs",
  "backend/scripts/lib/dev-timing-audit-helpers.mjs",
  "backend/scripts/lib/dev-timing-audit-helpers.test.mjs",
  "backend/scripts/lib/reports-summary-box-reuse.test.mjs",
  "backend/src/app/handlers/readHandlers.mjs",
  "backend/src/app/services/runtime/runtimeAllocationViews.mjs",
  "backend/src/app/services/runtime/runtimeJobsRead.mjs",
  "backend/src/app/services/runtime/runtimeReports.mjs",
  "backend/src/db/client.mjs",
  "supabase/functions/_shared/api-handler.ts",
  "backend/migration-dry-runs/performance/dev-timing-audit.json",
  "backend/package.json",
  "backend/package-lock.json",
  "frontend/package.json",
  "frontend/package-lock.json",
  "package.json",
  "package-lock.json"
]);

const PERFORMANCE_BUDGETS = Object.freeze([
  {
    category: "Auth/context",
    key: "auth",
    goodUnderMs: 250,
    warningUnderMs: 500,
    badUnderMs: 1000,
    criticalDescription: ">=1000ms or auth timeout"
  },
  {
    category: "Simple list/search",
    key: "simple_read",
    goodUnderMs: 500,
    warningUnderMs: 1500,
    badUnderMs: 3000,
    criticalDescription: ">=3000ms or timeout"
  },
  {
    category: "Complex job/detail",
    key: "complex_detail",
    goodUnderMs: 800,
    warningUnderMs: 2000,
    badUnderMs: 5000,
    criticalDescription: ">=5000ms or timeout"
  },
  {
    category: "Reports/summary",
    key: "reports",
    goodUnderMs: 1000,
    warningUnderMs: 3000,
    badUnderMs: 8000,
    criticalDescription: ">=8000ms or timeout"
  },
  {
    category: "General mutations",
    key: "mutation",
    goodUnderMs: 1000,
    warningUnderMs: 3000,
    badUnderMs: 10000,
    criticalDescription: ">=10000ms or timeout"
  },
  {
    category: "/jobs/complete",
    key: "jobs_complete",
    goodUnderMs: 1500,
    warningUnderMs: 5000,
    badUnderMs: 15000,
    criticalDescription: ">=15000ms, statement timeout, or 30s transaction risk"
  }
]);

const TOKEN_LIKE_PATTERNS = Object.freeze([
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{10,}\b/g,
  /\b(?:postgres|postgresql):\/\/[^\s"']+/gi
]);

const SECRET_KEY_PATTERN = /(?:TOKEN|KEY|SECRET|PASSWORD|DATABASE_URL|DB_URL|JWT|SERVICE_ROLE)/i;

/**
 * PURPOSE:
 * Provides testable safety, timing, sanitization, and report helpers for the
 * DEV performance audit runner without reading secrets or mutating data.
 *
 * AFFECTS:
 * backend/scripts/dev-timing-audit.mjs, audit report shape, and helper tests.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * docs/performance/dev-timing-audit-plan.md, runner safety gates, and report
 * sanitization tests.
 *
 * COMMON FAILURE MODES:
 * Budget gaps, leaked tokens, over-strict dirty file checks, or mixing measured
 * timings with unavailable backend/RPC sub-timings.
 */

function asTrimmedString(value) {
  return String(value ?? "").trim();
}

function normalizePathForGit(value) {
  return asTrimmedString(value).replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function parseArgs(argv = []) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }

    const [rawKey, rawValue] = token.slice(2).split("=", 2);
    const key = asTrimmedString(rawKey);
    if (!key) {
      continue;
    }

    if (rawValue !== undefined) {
      options[key] = rawValue;
      continue;
    }

    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }

    options[key] = next;
    index += 1;
  }
  return options;
}

function normalizeEnvValue(rawValue) {
  const trimmed = asTrimmedString(rawValue);
  if (!trimmed) {
    return "";
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseEnvContents(contents = "") {
  const values = {};
  for (const rawLine of String(contents || "").replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separatorIndex = normalized.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = normalized.slice(0, separatorIndex).trim();
    if (key) {
      values[key] = normalizeEnvValue(normalized.slice(separatorIndex + 1));
    }
  }
  return values;
}

function readEnvFile(envPath) {
  const resolvedPath = path.resolve(envPath);
  return {
    path: resolvedPath,
    values: parseEnvContents(fs.readFileSync(resolvedPath, "utf8"))
  };
}

function extractSupabaseProjectRef(supabaseUrl) {
  const value = asTrimmedString(supabaseUrl);
  if (!value) {
    return "";
  }
  try {
    const parsed = new URL(value);
    const match = parsed.hostname.match(/^([a-z0-9-]+)\.supabase\.co$/i);
    return asTrimmedString(match?.[1]).toLowerCase();
  } catch {
    return "";
  }
}

function extractDbProjectRef(connectionString) {
  const value = asTrimmedString(connectionString);
  if (!value) {
    return "";
  }
  try {
    const parsed = new URL(value);
    const match = parsed.hostname.match(/^db\.([a-z0-9-]+)\.supabase\.co$/i);
    return asTrimmedString(match?.[1]).toLowerCase();
  } catch {
    return "";
  }
}

function envContainsProjectRef(values, projectRef) {
  const needle = asTrimmedString(projectRef).toLowerCase();
  if (!needle) {
    return false;
  }
  return Object.values(values || {}).some((value) => asTrimmedString(value).toLowerCase().includes(needle));
}

function validateProjectRefs({ envValues, expectedProjectRef, rejectProjectRef }) {
  const expected = asTrimmedString(expectedProjectRef || DEV_PROJECT_REF).toLowerCase();
  const rejected = asTrimmedString(rejectProjectRef || PROD_PROJECT_REF).toLowerCase();
  const supabaseProjectRef = extractSupabaseProjectRef(envValues?.SUPABASE_URL);
  const dbProjectRef = extractDbProjectRef(envValues?.DEV_DATABASE_URL || envValues?.DATABASE_URL);
  const prodRefDetected = envContainsProjectRef(envValues, rejected);
  const envPointsToDev = supabaseProjectRef === expected && !prodRefDetected;
  const errors = [];

  if (!expected) {
    errors.push("Expected DEV project ref is required.");
  }
  if (expected === rejected) {
    errors.push("Expected and rejected project refs must differ.");
  }
  if (prodRefDetected) {
    errors.push(`Rejected project ref ${rejected} detected in env values.`);
  }
  if (supabaseProjectRef !== expected) {
    errors.push(`SUPABASE_URL project ref mismatch. Expected ${expected}, found ${supabaseProjectRef || "<none>"}.`);
  }
  if (dbProjectRef && dbProjectRef !== expected) {
    errors.push(`Database project ref mismatch. Expected ${expected}, found ${dbProjectRef}.`);
  }

  return {
    expectedProjectRef: expected,
    rejectedProjectRef: rejected,
    supabaseProjectRef,
    databaseProjectRef: dbProjectRef || null,
    envPointsToDev,
    prodRefDetected,
    ok: errors.length === 0,
    errors
  };
}

function buildTokenFileCheck({ path: tokenPath, exists, gitignored, tracked }) {
  const errors = [];
  if (!exists) {
    errors.push(`Auth token file was not found: ${tokenPath}`);
  }
  if (exists && !gitignored) {
    errors.push(`Auth token file is not gitignored: ${tokenPath}`);
  }
  if (exists && tracked) {
    errors.push(`Auth token file is tracked: ${tokenPath}`);
  }
  return {
    path: tokenPath,
    exists: Boolean(exists),
    gitignored: Boolean(gitignored),
    tracked: Boolean(tracked),
    ok: errors.length === 0,
    errors
  };
}

function parseGitStatusPorcelain(output = "") {
  const entries = [];
  for (const rawLine of String(output || "").split(/\r?\n/)) {
    if (!rawLine.trim()) {
      continue;
    }
    const status = rawLine.slice(0, 2);
    let filePath = rawLine.slice(3).trim();
    if (filePath.includes(" -> ")) {
      filePath = filePath.split(" -> ").pop().trim();
    }
    filePath = filePath.replace(/^"|"$/g, "");
    entries.push({
      raw: rawLine,
      status,
      path: normalizePathForGit(filePath)
    });
  }
  return entries;
}

function classifyGitStatus(output = "", allowedPaths = DEFAULT_ALLOWED_DIRTY_PATHS) {
  const allowedSet = new Set((allowedPaths || []).map(normalizePathForGit));
  const entries = parseGitStatusPorcelain(output);
  const allowedDirty = [];
  const unexpectedDirty = [];

  for (const entry of entries) {
    const isAllowed =
      allowedSet.has(entry.path) ||
      Array.from(allowedSet).some((allowedPath) => allowedPath.startsWith(entry.path.replace(/\/?$/, "/")));
    if (isAllowed) {
      allowedDirty.push(entry);
    } else {
      unexpectedDirty.push(entry);
    }
  }

  return {
    clean: entries.length === 0,
    entries,
    allowedDirty,
    unexpectedDirty,
    ok: unexpectedDirty.length === 0
  };
}

function budgetForCategory(categoryKeyOrName) {
  const normalized = asTrimmedString(categoryKeyOrName).toLowerCase();
  return (
    PERFORMANCE_BUDGETS.find((entry) => entry.key.toLowerCase() === normalized) ||
    PERFORMANCE_BUDGETS.find((entry) => entry.category.toLowerCase() === normalized) ||
    PERFORMANCE_BUDGETS.find((entry) => entry.key === "simple_read")
  );
}

function classifyTimingSeverity(categoryKeyOrName, durationMs, flags = {}) {
  const budget = budgetForCategory(categoryKeyOrName);
  const duration = Number(durationMs);
  if (
    flags.timeout ||
    flags.authTimeout ||
    flags.statementTimeout ||
    flags.transactionRisk30s ||
    !Number.isFinite(duration)
  ) {
    return "critical";
  }
  if (duration < budget.goodUnderMs) {
    return "good";
  }
  if (duration < budget.warningUnderMs) {
    return "warning";
  }
  if (duration < budget.badUnderMs) {
    return "bad";
  }
  return "critical";
}

function nearestRankPercentile(values = [], percentile = 50) {
  const sorted = values
    .map(Number)
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  if (!sorted.length) {
    return null;
  }
  const p = Math.min(100, Math.max(0, Number(percentile)));
  if (p === 0) {
    return sorted[0];
  }
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

function mean(values = []) {
  const numeric = values.map(Number).filter((value) => Number.isFinite(value));
  if (!numeric.length) {
    return null;
  }
  return numeric.reduce((sum, value) => sum + value, 0) / numeric.length;
}

function standardDeviation(values = []) {
  const numeric = values.map(Number).filter((value) => Number.isFinite(value));
  if (numeric.length <= 1) {
    return 0;
  }
  const avg = mean(numeric);
  const variance = numeric.reduce((sum, value) => sum + (value - avg) ** 2, 0) / numeric.length;
  return Math.sqrt(variance);
}

function roundMetric(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return null;
  }
  return Math.round(Number(value) * 100) / 100;
}

function p95Confidence(sampleCount) {
  return Number(sampleCount) >= 20 ? "standard" : "low_confidence";
}

function summarizeDurations(samples = []) {
  const measured = samples
    .filter((sample) => !sample.warmup && Number.isFinite(Number(sample.duration_ms)))
    .map((sample) => Number(sample.duration_ms));
  const timeoutCount = samples.filter((sample) => !sample.warmup && sample.timeout).length;
  const failureCount = samples.filter((sample) => !sample.warmup && sample.ok === false).length;
  return {
    count: measured.length,
    min: roundMetric(nearestRankPercentile(measured, 0)),
    p50: roundMetric(nearestRankPercentile(measured, 50)),
    p75: roundMetric(nearestRankPercentile(measured, 75)),
    p95: roundMetric(nearestRankPercentile(measured, 95)),
    max: roundMetric(nearestRankPercentile(measured, 100)),
    mean: roundMetric(mean(measured)),
    standardDeviation: roundMetric(standardDeviation(measured)),
    timeoutCount,
    failureCount,
    p95Confidence: p95Confidence(measured.length),
    percentileMethod: "nearest_rank"
  };
}

function normalizeMeasurementType(value) {
  const normalized = asTrimmedString(value).toLowerCase();
  if (normalized === "estimated" || normalized === "unavailable") {
    return normalized;
  }
  return "measured";
}

function redactTokenLikeStrings(value) {
  let text = String(value ?? "");
  for (const pattern of TOKEN_LIKE_PATTERNS) {
    text = text.replace(pattern, "[REDACTED]");
  }
  return text;
}

function collectSecretValues(envValues = {}) {
  const secrets = [];
  for (const [key, value] of Object.entries(envValues || {})) {
    const normalizedValue = asTrimmedString(value);
    if (SECRET_KEY_PATTERN.test(key) && normalizedValue.length >= 6) {
      secrets.push(normalizedValue);
    }
  }
  return secrets;
}

function redactSecretValues(value, secretValues = []) {
  let text = redactTokenLikeStrings(value);
  for (const secret of secretValues || []) {
    const normalizedSecret = asTrimmedString(secret);
    if (normalizedSecret.length >= 6) {
      text = text.split(normalizedSecret).join("[REDACTED]");
    }
  }
  return text;
}

function sanitizeString(value, secretValues = []) {
  return redactSecretValues(value, secretValues).slice(0, 1000);
}

function sanitizeReportValue(value, secretValues = []) {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    return sanitizeString(value, secretValues);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeReportValue(entry, secretValues));
  }
  if (typeof value === "object") {
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
      if (/authorization|authHeader|token|password|secret/i.test(key) && typeof entry === "string") {
        result[key] = "[REDACTED]";
      } else {
        result[key] = sanitizeReportValue(entry, secretValues);
      }
    }
    return result;
  }
  return value;
}

function valueShape(value) {
  if (Array.isArray(value)) {
    return "array";
  }
  if (value === null) {
    return "null";
  }
  return typeof value;
}

function sanitizedRequestShape({ query = {}, body = {} } = {}) {
  const queryShape = {};
  for (const [key, value] of Object.entries(query || {})) {
    queryShape[key] = Array.isArray(value) ? "array" : valueShape(value);
  }
  const bodyShape = {};
  if (body && typeof body === "object" && !Array.isArray(body)) {
    for (const [key, value] of Object.entries(body)) {
      if (/token|password|secret|auth/i.test(key)) {
        bodyShape[key] = "[REDACTED]";
      } else {
        bodyShape[key] = valueShape(value);
      }
    }
  }
  return {
    queryKeys: Object.keys(queryShape).sort(),
    queryShape,
    bodyKeys: Object.keys(bodyShape).sort(),
    bodyShape
  };
}

function shapeCreatedArtifactInventory(created = {}) {
  const shaped = {};
  for (const [key, value] of Object.entries(created || {})) {
    const entries = Array.isArray(value) ? value : value instanceof Set ? Array.from(value) : [];
    shaped[key] = {
      count: entries.length,
      ids: entries.map((entry) => asTrimmedString(entry)).filter(Boolean)
    };
  }
  return shaped;
}

function createBeforeAfterComparisonFields() {
  return {
    baselineReportId: null,
    baselineReportPath: null,
    comparisons: [],
    supportedFields: [
      "routeKey",
      "beforeDurationMs",
      "afterDurationMs",
      "improvementPercent",
      "regressions",
      "remainingBottlenecks",
      "timeoutCountDelta",
      "payloadBytesDelta",
      "apiCallCountDelta",
      "p50Delta",
      "p95Delta",
      "maxDelta"
    ]
  };
}

function buildPerformanceBudgetReport() {
  return PERFORMANCE_BUDGETS.map((entry) => ({
    category: entry.category,
    key: entry.key,
    good: `<${entry.goodUnderMs}ms`,
    warning: `${entry.goodUnderMs}-${entry.warningUnderMs}ms`,
    bad: `${entry.warningUnderMs}-${entry.badUnderMs}ms`,
    critical: entry.criticalDescription
  }));
}

function buildReportSkeleton({
  expectedProjectRef = DEV_PROJECT_REF,
  rejectedProjectRef = PROD_PROJECT_REF,
  orgId = "",
  runMode = "preflight",
  runId = null,
  gitStatusBefore = null
} = {}) {
  const reportId = `dev-timing-audit-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomInt(1000, 10000)}`;
  return {
    metadata: {
      reportId,
      generatedAt: new Date().toISOString(),
      environment: "development",
      expectedProjectRef,
      rejectedProjectRef,
      orgId,
      nodeVersion: process.version,
      scriptVersion: "",
      runMode,
      runId
    },
    executiveSummary: {
      topBottlenecks: [],
      highestRiskRoute: null,
      fastestLowRiskFutureFixCandidate: null,
      likelyCauses: [],
      prodTimeoutRisk: "low",
      confidenceLevel: "low",
      nextRecommendedInvestigationStep: "",
      auditOutcome: "partial_success"
    },
    safety: {
      envFileChecked: "",
      envPointsToDev: false,
      prodRefDetected: false,
      tokenFileExists: false,
      tokenFileGitignored: false,
      tokenFileTracked: false,
      authUserPassed: false,
      authContextPassed: false,
      devPermissionCheck: {
        passed: false,
        depth: "unavailable",
        reason: ""
      },
      gitStatusBefore,
      gitStatusAfter: null,
      allowedDirtyPaths: [],
      unexpectedDirtyPaths: [],
      stopConditionTriggered: false,
      stopConditionReason: ""
    },
    performanceBudgets: buildPerformanceBudgetReport(),
    methodology: {
      warmupRuns: 2,
      normalReadRuns: 10,
      hotReadRuns: 20,
      mutationRuns: 3,
      timeoutMs: 30000,
      percentileMethod: "nearest_rank",
      p95ConfidenceRules: "p95 is low_confidence when measured sample count is below 20.",
      coldVsWarmPolicy: "Warmups are excluded from measured stats; first measured sample is marked coldRun.",
      concurrencyPolicy: "Read-only routes only; mutation concurrency is disallowed.",
      mutationSafetyPolicy: "Mutation support is gated and not executed in this pass."
    },
    testDataSelection: {
      selectedInputs: {},
      skippedInputs: [],
      confidence: "low"
    },
    routeMap: [],
    readOnlyTimings: {
      samples: [],
      summaries: [],
      concurrency: []
    },
    mutationTimings: {
      executed: false,
      supported: true,
      reason: "Mutation timing is intentionally not executed in this pass.",
      samples: []
    },
    statisticalSummary: [],
    payloadAnalysis: [],
    frontendRouteAnalysis: {
      status: "unavailable",
      reason: "Browser/page timing was not run.",
      pages: []
    },
    apiCallCounts: [],
    dbInvestigation: {
      status: "unavailable",
      reason: "",
      metadataOnly: false,
      tables: [],
      indexes: [],
      functions: [],
      statementTimeout: null
    },
    queryPlanFindings: [],
    rankings: [],
    recommendations: [],
    fixQueue: [],
    beforeAfterComparisonSupport: createBeforeAfterComparisonFields(),
    created: {
      runId: runId || null,
      artifacts: shapeCreatedArtifactInventory({})
    },
    cleanupStatus: {
      attempted: false,
      status: "not_needed",
      reason: "No mutation timing executed in this pass."
    },
    prodRealismWarning: {
      message:
        "DEV timing does not prove PROD performance unless schema, functions, indexes, data volume, compute, timeout settings, and concurrency are similar. No PROD access or PROD mutation was performed."
    },
    reportSanitization: {
      tokensRedacted: true,
      authHeadersIncluded: false,
      sensitiveBodiesIncluded: false,
      secretEnvValuesIncluded: false
    },
    timingMeasurementTypes: {
      measured: "Directly measured by the runner or safe instrumentation.",
      estimated: "Derived from explicit safe approximation and clearly marked.",
      unavailable: "Not exposed safely."
    },
    auditOutcome: {
      status: "partial_success",
      reasons: []
    },
    gitStatus: {
      before: gitStatusBefore,
      after: null
    }
  };
}

function classifyAuditOutcome({
  safetyFailed = false,
  reportWriteFailed = false,
  secretsDetected = false,
  readOnlyRan = false,
  mutationRan = false,
  browserUnavailable = false,
  dbUnavailable = false,
  skippedRoutes = 0,
  routeFailures = 0,
  preflightOnly = false
} = {}) {
  const reasons = [];
  if (safetyFailed) {
    reasons.push("Safety/auth validation failed.");
  }
  if (reportWriteFailed) {
    reasons.push("Report could not be written.");
  }
  if (secretsDetected) {
    reasons.push("Secret-like content was detected in report output.");
  }
  if (safetyFailed || reportWriteFailed || secretsDetected) {
    return { status: "failure", reasons };
  }

  if (preflightOnly) {
    reasons.push("Preflight-only run completed.");
    return { status: "partial_success", reasons };
  }
  if (!readOnlyRan) {
    reasons.push("Read-only timing did not run.");
  }
  if (!mutationRan) {
    reasons.push("Mutation timing was skipped by design.");
  }
  if (browserUnavailable) {
    reasons.push("Browser/page timing unavailable.");
  }
  if (dbUnavailable) {
    reasons.push("DB investigation unavailable or partial.");
  }
  if (skippedRoutes > 0) {
    reasons.push(`${skippedRoutes} route(s) skipped.`);
  }
  if (routeFailures > 0) {
    reasons.push(`${routeFailures} route sample(s) failed.`);
  }

  if (reasons.length > 0) {
    return { status: "partial_success", reasons };
  }
  return { status: "full_success", reasons: [] };
}

function detectSecretLeak(value, secretValues = []) {
  const text = JSON.stringify(value);
  if (/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/.test(text)) {
    return true;
  }
  return (secretValues || []).some((secret) => {
    const normalizedSecret = asTrimmedString(secret);
    return normalizedSecret.length >= 12 && text.includes(normalizedSecret);
  });
}

function buildMutationGate({ includeDevMutations, confirmation, preflightPassed, readOnlyPassed }) {
  const errors = [];
  if (!includeDevMutations) {
    return {
      allowed: false,
      reason: "Mutation timing not requested.",
      errors
    };
  }
  if (confirmation !== MUTATION_CONFIRMATION) {
    errors.push(`Mutation confirmation must be exactly ${MUTATION_CONFIRMATION}.`);
  }
  if (!preflightPassed) {
    errors.push("Preflight must pass before mutation timing.");
  }
  if (!readOnlyPassed) {
    errors.push("Read-only timing must pass before mutation timing.");
  }
  return {
    allowed: errors.length === 0,
    reason: errors.length ? errors.join(" ") : "Mutation timing gates passed.",
    errors
  };
}

export {
  DEFAULT_ALLOWED_DIRTY_PATHS,
  DEV_PROJECT_REF,
  MUTATION_CONFIRMATION,
  PERFORMANCE_BUDGETS,
  PROD_PROJECT_REF,
  asTrimmedString,
  buildMutationGate,
  buildPerformanceBudgetReport,
  buildReportSkeleton,
  buildTokenFileCheck,
  classifyAuditOutcome,
  classifyGitStatus,
  classifyTimingSeverity,
  collectSecretValues,
  createBeforeAfterComparisonFields,
  detectSecretLeak,
  envContainsProjectRef,
  extractDbProjectRef,
  extractSupabaseProjectRef,
  nearestRankPercentile,
  normalizeMeasurementType,
  normalizePathForGit,
  p95Confidence,
  parseArgs,
  parseEnvContents,
  parseGitStatusPorcelain,
  readEnvFile,
  redactSecretValues,
  redactTokenLikeStrings,
  sanitizeReportValue,
  sanitizedRequestShape,
  shapeCreatedArtifactInventory,
  standardDeviation,
  summarizeDurations,
  validateProjectRefs
};

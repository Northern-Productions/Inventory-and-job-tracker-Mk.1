import test from "node:test";
import assert from "node:assert/strict";
import {
  DEV_PROJECT_REF,
  MUTATION_CONFIRMATION,
  PROD_PROJECT_REF,
  buildMutationGate,
  buildReportSkeleton,
  buildTokenFileCheck,
  classifyAuditOutcome,
  classifyGitStatus,
  classifyTimingSeverity,
  collectSecretValues,
  createBeforeAfterComparisonFields,
  detectSecretLeak,
  nearestRankPercentile,
  normalizeMeasurementType,
  parseArgs,
  parseEnvContents,
  p95Confidence,
  redactSecretValues,
  redactTokenLikeStrings,
  sanitizeReportValue,
  sanitizedRequestShape,
  shapeCreatedArtifactInventory,
  summarizeDurations,
  validateProjectRefs
} from "./dev-timing-audit-helpers.mjs";

test("parseArgs supports boolean, spaced, and equals flags", () => {
  assert.deepEqual(parseArgs(["--read-only", "--env", "backend/.env.dev", "--timeout-ms=30000"]), {
    "read-only": true,
    env: "backend/.env.dev",
    "timeout-ms": "30000"
  });
});

test("env guard accepts expected DEV ref", () => {
  const envValues = parseEnvContents(`
SUPABASE_URL=https://${DEV_PROJECT_REF}.supabase.co
DEV_DATABASE_URL=postgresql://postgres:pw@db.${DEV_PROJECT_REF}.supabase.co:5432/postgres
`);
  const result = validateProjectRefs({
    envValues,
    expectedProjectRef: DEV_PROJECT_REF,
    rejectProjectRef: PROD_PROJECT_REF
  });
  assert.equal(result.ok, true);
  assert.equal(result.envPointsToDev, true);
  assert.equal(result.prodRefDetected, false);
});

test("env guard rejects PROD ref", () => {
  const envValues = parseEnvContents(`
SUPABASE_URL=https://${PROD_PROJECT_REF}.supabase.co
DEV_DATABASE_URL=postgresql://postgres:pw@db.${PROD_PROJECT_REF}.supabase.co:5432/postgres
`);
  const result = validateProjectRefs({
    envValues,
    expectedProjectRef: DEV_PROJECT_REF,
    rejectProjectRef: PROD_PROJECT_REF
  });
  assert.equal(result.ok, false);
  assert.equal(result.prodRefDetected, true);
  assert.match(result.errors.join(" "), /Rejected project ref/);
});

test("token file check rejects missing, tracked, or not ignored states", () => {
  assert.equal(buildTokenFileCheck({ path: ".secrets/token", exists: false, gitignored: false, tracked: false }).ok, false);
  assert.equal(buildTokenFileCheck({ path: ".secrets/token", exists: true, gitignored: false, tracked: false }).ok, false);
  assert.equal(buildTokenFileCheck({ path: ".secrets/token", exists: true, gitignored: true, tracked: true }).ok, false);
  assert.equal(buildTokenFileCheck({ path: ".secrets/token", exists: true, gitignored: true, tracked: false }).ok, true);
});

test("git status parser separates allowed and unexpected dirty paths", () => {
  const output = [
    " M docs/performance/dev-timing-audit-plan.md",
    "?? docs/performance/",
    "?? backend/scripts/dev-timing-audit.mjs",
    " M frontend/src/App.tsx"
  ].join("\n");
  const result = classifyGitStatus(output, [
    "docs/performance/dev-timing-audit-plan.md",
    "backend/scripts/dev-timing-audit.mjs"
  ]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.allowedDirty.map((entry) => entry.path), [
    "docs/performance/dev-timing-audit-plan.md",
    "docs/performance/",
    "backend/scripts/dev-timing-audit.mjs"
  ]);
  assert.deepEqual(result.unexpectedDirty.map((entry) => entry.path), ["frontend/src/App.tsx"]);
});

test("performance budget classification is continuous at boundaries", () => {
  assert.equal(classifyTimingSeverity("auth", 249), "good");
  assert.equal(classifyTimingSeverity("auth", 250), "warning");
  assert.equal(classifyTimingSeverity("auth", 500), "bad");
  assert.equal(classifyTimingSeverity("auth", 1000), "critical");
  assert.equal(classifyTimingSeverity("simple_read", 2999), "bad");
  assert.equal(classifyTimingSeverity("simple_read", 3000), "critical");
  assert.equal(classifyTimingSeverity("jobs_complete", 14999), "bad");
  assert.equal(classifyTimingSeverity("jobs_complete", 15000), "critical");
});

test("timeouts and statement timeouts are always critical", () => {
  assert.equal(classifyTimingSeverity("auth", 1, { timeout: true }), "critical");
  assert.equal(classifyTimingSeverity("jobs_complete", 1, { statementTimeout: true }), "critical");
  assert.equal(classifyTimingSeverity("jobs_complete", 1, { transactionRisk30s: true }), "critical");
});

test("nearest-rank percentiles and summary stats are stable", () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(nearestRankPercentile(values, 50), 5);
  assert.equal(nearestRankPercentile(values, 75), 8);
  assert.equal(nearestRankPercentile(values, 95), 10);

  const samples = values.map((duration_ms, index) => ({
    duration_ms,
    runIndex: index,
    warmup: false,
    ok: true,
    timeout: false
  }));
  const summary = summarizeDurations(samples);
  assert.equal(summary.count, 10);
  assert.equal(summary.p50, 5);
  assert.equal(summary.p75, 8);
  assert.equal(summary.p95, 10);
  assert.equal(summary.p95Confidence, "low_confidence");
});

test("p95 confidence requires at least 20 measured samples", () => {
  assert.equal(p95Confidence(19), "low_confidence");
  assert.equal(p95Confidence(20), "standard");
});

test("measurement type normalization allows only known labels", () => {
  assert.equal(normalizeMeasurementType("estimated"), "estimated");
  assert.equal(normalizeMeasurementType("unavailable"), "unavailable");
  assert.equal(normalizeMeasurementType("anything"), "measured");
});

test("sanitized request shape records keys and types without values", () => {
  const shape = sanitizedRequestShape({
    query: { jobNumber: "123456", q: "secret customer", limit: 25 },
    body: { authToken: "token", notes: "private", count: 1 }
  });
  assert.deepEqual(shape.queryKeys, ["jobNumber", "limit", "q"]);
  assert.equal(shape.queryShape.q, "string");
  assert.equal(shape.bodyShape.authToken, "[REDACTED]");
  assert.equal(shape.bodyShape.notes, "string");
});

test("redaction removes token-like and secret env values", () => {
  const jwt = "eyJaaaaaaaaaaaa.eyJbbbbbbbbbbbb.cccccccccccccccc";
  assert.equal(redactTokenLikeStrings(`Bearer ${jwt}`).includes(jwt), false);
  const envValues = {
    SUPABASE_ANON_KEY: "super-secret-value",
    PUBLIC_VALUE: "keep"
  };
  const secrets = collectSecretValues(envValues);
  assert.equal(redactSecretValues(`x ${envValues.SUPABASE_ANON_KEY} y`, secrets), "x [REDACTED] y");
});

test("report sanitization redacts sensitive fields and detects leaks", () => {
  const secret = "very-secret-value";
  const report = sanitizeReportValue({
    token: "abc",
    tokenFileExists: true,
    nested: {
      Authorization: "Bearer eyJaaaaaaaaaaaa.eyJbbbbbbbbbbbb.cccccccccccccccc",
      safe: "ok",
      secret
    }
  }, [secret]);
  assert.equal(report.token, "[REDACTED]");
  assert.equal(report.tokenFileExists, true);
  assert.equal(report.nested.Authorization, "[REDACTED]");
  assert.equal(report.nested.secret, "[REDACTED]");
  assert.equal(detectSecretLeak(report, [secret]), false);
});

test("created artifact inventory and before/after comparison fields are shaped", () => {
  const inventory = shapeCreatedArtifactInventory({
    boxIds: new Set(["IL1-1"]),
    jobNumbers: ["123456"]
  });
  assert.equal(inventory.boxIds.count, 1);
  assert.deepEqual(inventory.jobNumbers.ids, ["123456"]);
  assert.ok(createBeforeAfterComparisonFields().supportedFields.includes("p95Delta"));
});

test("report skeleton contains required high-level fields", () => {
  const report = buildReportSkeleton({ orgId: "org", runMode: "read_only" });
  for (const key of [
    "metadata",
    "executiveSummary",
    "safety",
    "performanceBudgets",
    "methodology",
    "testDataSelection",
    "routeMap",
    "readOnlyTimings",
    "mutationTimings",
    "dbInvestigation",
    "fixQueue",
    "auditOutcome",
    "gitStatus"
  ]) {
    assert.ok(Object.prototype.hasOwnProperty.call(report, key), key);
  }
});

test("mutation gate requires explicit confirmation and prior phases", () => {
  assert.equal(buildMutationGate({ includeDevMutations: false }).allowed, false);
  assert.equal(buildMutationGate({
    includeDevMutations: true,
    confirmation: "wrong",
    preflightPassed: true,
    readOnlyPassed: true
  }).allowed, false);
  assert.equal(buildMutationGate({
    includeDevMutations: true,
    confirmation: MUTATION_CONFIRMATION,
    preflightPassed: true,
    readOnlyPassed: true
  }).allowed, true);
});

test("audit outcome classifies success, partial, and failure", () => {
  assert.equal(classifyAuditOutcome({ safetyFailed: true }).status, "failure");
  assert.equal(classifyAuditOutcome({ readOnlyRan: true, mutationRan: false }).status, "partial_success");
  assert.equal(classifyAuditOutcome({ readOnlyRan: true, mutationRan: true }).status, "full_success");
});

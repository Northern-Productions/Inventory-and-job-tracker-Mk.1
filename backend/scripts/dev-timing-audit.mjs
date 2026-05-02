#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  DEFAULT_ALLOWED_DIRTY_PATHS,
  DEV_PROJECT_REF,
  MUTATION_CONFIRMATION,
  PROD_PROJECT_REF,
  asTrimmedString,
  buildMutationGate,
  buildReportSkeleton,
  buildTokenFileCheck,
  classifyAuditOutcome,
  classifyGitStatus,
  classifyTimingSeverity,
  collectSecretValues,
  detectSecretLeak,
  readEnvFile,
  sanitizeReportValue,
  sanitizedRequestShape,
  shapeCreatedArtifactInventory,
  summarizeDurations,
  validateProjectRefs
} from "./lib/dev-timing-audit-helpers.mjs";

const SCRIPT_NAME = "dev-timing-audit";
const DEFAULT_OUT = path.join("backend", "migration-dry-runs", "performance", "dev-timing-audit.json");
const REQUIRED_WRITE_FEATURES = Object.freeze(["inventory", "allocations", "jobs", "film_orders"]);
const OPTIONAL_READ_ROUTES = new Set([
  "/allocations/by-job",
  "/audit/by-box",
  "/allocations/by-box",
  "/roll-history/by-box",
  "/owner/reports/asset-total-cost",
  "/admin/access/requests",
  "/admin/username-requests",
  "/admin/member-permissions"
]);

/**
 * PURPOSE:
 * Runs a DEV-only timing audit through existing read-only API surfaces while
 * preserving safety gates and avoiding any performance behavior changes.
 *
 * AFFECTS:
 * DEV smoke/timing reports only; this script must not alter app route logic,
 * SQL behavior, migrations, indexes, production, or mutation state in this pass.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * docs/performance/dev-timing-audit-plan.md, helper tests, token/report
 * sanitization, and the explicit no-mutation execution rule.
 *
 * COMMON FAILURE MODES:
 * Accidentally accepting a PROD ref, leaking token-like strings, treating
 * optional DB metadata as a hard failure, or running mutation timing too early.
 */

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

function integerOption(options, key, fallback) {
  const parsed = Number(options[key]);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(0, Math.trunc(parsed));
}

function runGit(args) {
  return execFileSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function getGitStatus() {
  return classifyGitStatus(runGit(["status", "--porcelain"]), DEFAULT_ALLOWED_DIRTY_PATHS);
}

function getGitCommit() {
  try {
    return asTrimmedString(runGit(["rev-parse", "--short", "HEAD"]));
  } catch {
    return "";
  }
}

function gitCheckIgnore(filePath) {
  try {
    execFileSync("git", ["check-ignore", "-q", "--", filePath], { cwd: process.cwd(), stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function gitIsTracked(filePath) {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "--", filePath], { cwd: process.cwd(), stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function checkTokenFile(tokenPath) {
  const resolvedPath = path.resolve(tokenPath);
  const exists = fs.existsSync(resolvedPath);
  return buildTokenFileCheck({
    path: tokenPath,
    exists,
    gitignored: exists ? gitCheckIgnore(tokenPath) : false,
    tracked: exists ? gitIsTracked(tokenPath) : false
  });
}

function applyEnvValues(values) {
  for (const [key, value] of Object.entries(values || {})) {
    process.env[key] = value;
  }
  if (values.DEV_DATABASE_URL) {
    process.env.DATABASE_URL = values.DEV_DATABASE_URL;
  }
}

function buildRequestUrl(logicalPath, query = {}) {
  const url = new URL("http://localhost/api");
  url.searchParams.set("path", logicalPath);
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (entry !== undefined && entry !== null && entry !== "") {
          url.searchParams.append(key, String(entry));
        }
      }
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  return url;
}

function payloadSizeBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
  } catch {
    return 0;
  }
}

function deriveRowCount(data) {
  if (Array.isArray(data)) {
    return data.length;
  }
  if (Array.isArray(data?.entries)) {
    return data.entries.length;
  }
  if (Array.isArray(data?.requirements)) {
    return data.requirements.length;
  }
  return null;
}

function detectStatementTimeout(errorText) {
  const normalized = asTrimmedString(errorText).toLowerCase();
  return normalized.includes("statement timeout") || normalized.includes("canceling statement due to statement timeout");
}

function nowMs() {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

async function withTimeout(promise, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }
  let timeoutId;
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve({ __timedOut: true }), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchJsonWithTimeout(url, { headers = {}, timeoutMs = 30000 } = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { parseError: true };
    }
    return { response, payload, text };
  } finally {
    clearTimeout(timeoutId);
  }
}

function safeErrorMessage(error) {
  return asTrimmedString(error instanceof Error ? error.message : error).slice(0, 500);
}

function buildSample({
  feature,
  frontendRoute = null,
  backendRoute,
  method,
  query = {},
  body = {},
  status = 0,
  durationMs = null,
  payloadBytes = 0,
  rowCount = null,
  ok = false,
  timeout = false,
  error = "",
  warningsCount = 0,
  runIndex = 0,
  warmup = false,
  coldRun = false,
  concurrencyMode = "sequential",
  category = "simple_read",
  measurementType = "measured",
  createdIds = [],
  cleanupStatus = null
}) {
  const statementTimeout = detectStatementTimeout(error);
  return {
    feature,
    frontendRoute,
    backendRoute,
    method,
    sanitizedRequestShape: sanitizedRequestShape({ query, body }),
    status,
    duration_ms: durationMs === null ? null : Math.round(Number(durationMs) * 100) / 100,
    measurementType,
    payloadBytes,
    rowCount,
    timeout: Boolean(timeout),
    statementTimeout,
    error: error ? safeErrorMessage(error) : "",
    warningsCount,
    runIndex,
    warmup: Boolean(warmup),
    coldRun: Boolean(coldRun),
    concurrencyMode,
    severity: classifyTimingSeverity(category, durationMs, { timeout, statementTimeout }),
    p95Confidence: null,
    ok: Boolean(ok),
    createdIds,
    cleanupStatus
  };
}

async function runAuthUserSample({ envValues, token, timeoutMs, runIndex = 0, warmup = false }) {
  const startedAt = nowMs();
  const supabaseUrl = asTrimmedString(envValues.SUPABASE_URL).replace(/\/+$/g, "");
  const anonKey = asTrimmedString(envValues.SUPABASE_ANON_KEY);
  try {
    const result = await fetchJsonWithTimeout(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: anonKey
      },
      timeoutMs
    });
    const durationMs = nowMs() - startedAt;
    const error =
      result.response.ok
        ? ""
        : asTrimmedString(result.payload?.msg || result.payload?.error_description || result.payload?.error || result.payload?.message);
    return buildSample({
      feature: "Auth user verification",
      backendRoute: "/auth/v1/user",
      method: "GET",
      status: result.response.status,
      durationMs,
      payloadBytes: Buffer.byteLength(result.text || "", "utf8"),
      rowCount: null,
      ok: result.response.ok,
      timeout: false,
      error,
      runIndex,
      warmup,
      coldRun: runIndex === 0 && !warmup,
      category: "auth"
    });
  } catch (error) {
    return buildSample({
      feature: "Auth user verification",
      backendRoute: "/auth/v1/user",
      method: "GET",
      status: 0,
      durationMs: nowMs() - startedAt,
      ok: false,
      timeout: error?.name === "AbortError",
      error: safeErrorMessage(error),
      runIndex,
      warmup,
      coldRun: runIndex === 0 && !warmup,
      category: "auth"
    });
  }
}

async function runBackendSample({ handleSupabaseRequest, token, route, timeoutMs, runIndex = 0, warmup = false }) {
  const startedAt = nowMs();
  const responsePromise = handleSupabaseRequest({
    method: route.method,
    logicalPath: route.path,
    requestUrl: buildRequestUrl(route.path, route.query || {}),
    bodyJson: route.method === "POST" ? route.body || {} : null,
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  const timedResult = await withTimeout(responsePromise, timeoutMs);
  if (timedResult?.__timedOut) {
    return buildSample({
      feature: route.feature,
      frontendRoute: route.frontendRoute || null,
      backendRoute: route.path,
      method: route.method,
      query: route.query || {},
      body: route.body || {},
      status: 0,
      durationMs: nowMs() - startedAt,
      ok: false,
      timeout: true,
      error: "Request timed out.",
      runIndex,
      warmup,
      coldRun: runIndex === 0 && !warmup,
      category: route.category
    });
  }

  const durationMs = nowMs() - startedAt;
  const payload = timedResult?.payload || {};
  const data = payload.data;
  return buildSample({
    feature: route.feature,
    frontendRoute: route.frontendRoute || null,
    backendRoute: route.path,
    method: route.method,
    query: route.query || {},
    body: route.body || {},
    status: timedResult?.statusCode || 0,
    durationMs,
    payloadBytes: payloadSizeBytes(payload),
    rowCount: deriveRowCount(data),
    ok: timedResult?.statusCode >= 200 && timedResult.statusCode < 300 && payload.ok === true,
    timeout: false,
    error: payload.ok === false ? asTrimmedString(payload.error) : "",
    warningsCount: Array.isArray(payload.warnings) ? payload.warnings.length : 0,
    runIndex,
    warmup,
    coldRun: runIndex === 0 && !warmup,
    category: route.category
  });
}

function routeKey(sample) {
  return `${sample.method} ${sample.backendRoute}`;
}

function summarizeSamples(samples) {
  const grouped = new Map();
  for (const sample of samples) {
    const key = routeKey(sample);
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key).push(sample);
  }

  return Array.from(grouped.entries()).map(([key, entries]) => {
    const stats = summarizeDurations(entries);
    const measured = entries.filter((entry) => !entry.warmup);
    const payloadValues = measured.map((entry) => entry.payloadBytes).filter((value) => Number.isFinite(value));
    const worstSeverity = ["critical", "bad", "warning", "good"].find((severity) =>
      measured.some((entry) => entry.severity === severity)
    ) || "good";
    return {
      routeKey: key,
      feature: entries[0]?.feature || "",
      backendRoute: entries[0]?.backendRoute || "",
      method: entries[0]?.method || "",
      category: entries[0]?.category || "",
      sampleCount: stats.count,
      stats,
      payloadBytes: {
        min: payloadValues.length ? Math.min(...payloadValues) : null,
        max: payloadValues.length ? Math.max(...payloadValues) : null
      },
      rowCounts: Array.from(new Set(measured.map((entry) => entry.rowCount).filter((value) => value !== null))),
      severity: worstSeverity
    };
  });
}

function pickJobComplexityScore(job) {
  return (
    Number(job?.requiredFeet || 0) +
    Number(job?.allocatedFeet || 0) +
    Number(job?.requiredTubes || 0) * 10 +
    Number(job?.allocatedTubes || 0) * 10 +
    (job?.hasOrderedAllocations ? 100 : 0)
  );
}

function selectJob(entries, predicate, sortDescending = false) {
  const candidates = (entries || []).filter(predicate);
  if (!candidates.length) {
    return null;
  }
  if (sortDescending) {
    candidates.sort((left, right) => pickJobComplexityScore(right) - pickJobComplexityScore(left));
  }
  return candidates[0] || null;
}

async function requestData(handleSupabaseRequest, token, route, timeoutMs) {
  const sample = await runBackendSample({
    handleSupabaseRequest,
    token,
    route,
    timeoutMs,
    runIndex: 0,
    warmup: true
  });
  if (!sample.ok) {
    return { sample, data: null };
  }
  const response = await handleSupabaseRequest({
    method: route.method,
    logicalPath: route.path,
    requestUrl: buildRequestUrl(route.path, route.query || {}),
    bodyJson: route.method === "POST" ? route.body || {} : null,
    headers: { Authorization: `Bearer ${token}` }
  });
  return { sample, data: response?.payload?.data || null };
}

function sanitizedSearchLabel(label, value) {
  if (!asTrimmedString(value)) {
    return null;
  }
  return {
    label,
    value: `[${label}]`,
    actualValueAvailable: true
  };
}

async function selectTestData({ handleSupabaseRequest, token, timeoutMs }) {
  const skippedInputs = [];
  const selectedInputs = {};

  const activeJobs = (await requestData(handleSupabaseRequest, token, {
    feature: "Test data active jobs",
    method: "GET",
    path: "/jobs/list",
    query: { limit: 50, lifecycleStatus: "ACTIVE" },
    category: "simple_read"
  }, timeoutMs)).data?.entries || [];

  const completedJobs = (await requestData(handleSupabaseRequest, token, {
    feature: "Test data completed jobs",
    method: "GET",
    path: "/jobs/list",
    query: { limit: 25, lifecycleStatus: "COMPLETED" },
    category: "simple_read"
  }, timeoutMs)).data?.entries || [];

  const allocationJobs = (await requestData(handleSupabaseRequest, token, {
    feature: "Test data allocation jobs",
    method: "GET",
    path: "/allocations/jobs",
    query: {},
    category: "simple_read"
  }, timeoutMs)).data?.entries || [];

  const filmOrders = (await requestData(handleSupabaseRequest, token, {
    feature: "Test data film orders",
    method: "GET",
    path: "/film-orders/list",
    query: {},
    category: "simple_read"
  }, timeoutMs)).data?.entries || [];

  const boxDataResponse = await requestData(handleSupabaseRequest, token, {
    feature: "Test data inventory boxes",
    method: "GET",
    path: "/boxes/search",
    query: { warehouse: "IL1" },
    category: "simple_read"
  }, timeoutMs);
  let boxes = Array.isArray(boxDataResponse.data) ? boxDataResponse.data : [];
  if (!boxes.length) {
    boxes = ((await requestData(handleSupabaseRequest, token, {
      feature: "Test data inventory boxes fallback",
      method: "GET",
      path: "/boxes/search",
      query: { warehouse: "ALL" },
      category: "simple_read"
    }, timeoutMs)).data) || [];
  }

  const simpleActiveJob = selectJob(activeJobs, (entry) => entry.lifecycleStatus === "ACTIVE");
  const complexActiveJob = selectJob(activeJobs, (entry) => entry.lifecycleStatus === "ACTIVE", true);
  const completedJob = selectJob(completedJobs, () => true);
  const allocationJob =
    selectJob(activeJobs, (entry) => Number(entry.allocatedFeet || 0) > 0 || entry.hasOrderedAllocations) ||
    selectJob(allocationJobs, () => true);
  const filmOrderJobNumber = asTrimmedString(filmOrders.find((entry) => entry.jobNumber)?.jobNumber);
  const filmOrderJob = filmOrderJobNumber
    ? activeJobs.find((entry) => asTrimmedString(entry.jobNumber) === filmOrderJobNumber) || { jobNumber: filmOrderJobNumber }
    : null;
  const safeBox = boxes.find((entry) => asTrimmedString(entry.boxId)) || null;
  const commonTerm = asTrimmedString(safeBox?.manufacturer || "").split(/\s+/)[0] || "";
  const rareTerm = asTrimmedString(safeBox?.boxId).slice(-4) || "";
  const noMatchTerm = "PERF_TIMING_NO_MATCH";

  function setOrSkip(key, value, reason) {
    if (value) {
      selectedInputs[key] = value;
    } else {
      skippedInputs.push({ key, reason });
    }
  }

  setOrSkip("simpleActiveJob", simpleActiveJob ? { jobNumber: simpleActiveJob.jobNumber, confidence: "medium" } : null, "No active jobs found.");
  setOrSkip("complexActiveJob", complexActiveJob ? { jobNumber: complexActiveJob.jobNumber, confidence: "medium" } : null, "No complex active job candidate found.");
  setOrSkip("completedJob", completedJob ? { jobNumber: completedJob.jobNumber, confidence: "medium" } : null, "No completed jobs found.");
  setOrSkip("jobWithAllocations", allocationJob ? { jobNumber: allocationJob.jobNumber, confidence: "medium" } : null, "No job with allocations found.");
  setOrSkip("jobWithFilmOrderBoxRelationships", filmOrderJob ? { jobNumber: filmOrderJob.jobNumber, confidence: "low" } : null, "No film-order job relationship found.");
  setOrSkip("safeBox", safeBox ? { boxId: safeBox.boxId, warehouse: safeBox.warehouse, widthIn: safeBox.widthIn, confidence: "medium" } : null, "No safe box found.");
  setOrSkip("commonBoxSearchTerm", sanitizedSearchLabel("common_box_search_term", commonTerm), "No common box search term available.");
  setOrSkip("rareBoxSearchTerm", sanitizedSearchLabel("rare_box_search_term", rareTerm), "No rare box search term available.");
  selectedInputs.noMatchSearchTerm = sanitizedSearchLabel("no_match_search_term", noMatchTerm);
  selectedInputs.reportsFilters = { warehouse: safeBox?.warehouse || "ALL", confidence: safeBox ? "medium" : "low" };
  selectedInputs.rowCounts = {
    activeJobs: activeJobs.length,
    completedJobs: completedJobs.length,
    allocationJobs: allocationJobs.length,
    filmOrders: filmOrders.length,
    boxes: boxes.length
  };

  return {
    selectedInputs,
    skippedInputs,
    confidence: skippedInputs.length ? "low" : "medium",
    raw: {
      simpleActiveJob,
      complexActiveJob,
      completedJob,
      allocationJob,
      filmOrderJob,
      safeBox,
      commonTerm,
      rareTerm,
      noMatchTerm
    }
  };
}

function buildReadOnlyRoutes(testData) {
  const raw = testData.raw || {};
  const safeBox = raw.safeBox;
  const simpleJobNumber = asTrimmedString(raw.simpleActiveJob?.jobNumber);
  const complexJobNumber = asTrimmedString(raw.complexActiveJob?.jobNumber);
  const completedJobNumber = asTrimmedString(raw.completedJob?.jobNumber);
  const allocationJobNumber = asTrimmedString(raw.allocationJob?.jobNumber || simpleJobNumber);
  const filmOrderJobNumber = asTrimmedString(raw.filmOrderJob?.jobNumber);
  const boxId = asTrimmedString(safeBox?.boxId);
  const warehouse = asTrimmedString(safeBox?.warehouse || "IL1").toUpperCase();
  const widthIn = Number(safeBox?.widthIn || 36);
  const commonTerm = raw.commonTerm;
  const rareTerm = raw.rareTerm;

  const routes = [
    { feature: "Auth context", method: "GET", path: "/auth/context", query: {}, category: "auth" },
    { feature: "Jobs list", method: "GET", path: "/jobs/list", query: { limit: 25, lifecycleStatus: "ACTIVE" }, category: "simple_read", hot: true, frontendRoute: "#/allocations" },
    { feature: "Jobs search", method: "GET", path: "/jobs/search", query: simpleJobNumber ? { query: simpleJobNumber.slice(-4), limit: 25, lifecycleStatus: "ACTIVE" } : null, category: "simple_read", hot: true, frontendRoute: "#/allocations" },
    { feature: "Jobs calendar", method: "GET", path: "/jobs/calendar", query: { view: "month", anchorDate: new Date().toISOString().slice(0, 10), lifecycleStatus: "ACTIVE" }, category: "simple_read", frontendRoute: "#/allocations" },
    { feature: "Simple job detail", method: "GET", path: "/jobs/get", query: simpleJobNumber ? { jobNumber: simpleJobNumber } : null, category: "complex_detail", frontendRoute: "#/allocations/:jobNumber" },
    { feature: "Complex job detail", method: "GET", path: "/jobs/get", query: complexJobNumber ? { jobNumber: complexJobNumber } : null, category: "complex_detail", frontendRoute: "#/allocations/:jobNumber" },
    { feature: "Completed job detail", method: "GET", path: "/jobs/get", query: completedJobNumber ? { jobNumber: completedJobNumber } : null, category: "complex_detail", frontendRoute: "#/allocations/:jobNumber" },
    { feature: "Allocation jobs", method: "GET", path: "/allocations/jobs", query: {}, category: "simple_read", frontendRoute: "#/allocations" },
    { feature: "Allocation by job", method: "GET", path: "/allocations/by-job", query: allocationJobNumber ? { jobNumber: allocationJobNumber } : null, category: "complex_detail", optional: true },
    {
      feature: "Allocation preview",
      method: "GET",
      path: "/allocations/preview",
      query: boxId && allocationJobNumber ? {
        boxId,
        jobNumber: allocationJobNumber,
        requestedFeet: 1,
        requestedWidthIn: widthIn,
        jobWarehouse: warehouse,
        crossWarehouse: false
      } : null,
      category: "simple_read",
      hot: true,
      frontendRoute: "#/allocations/:jobNumber"
    },
    { feature: "Boxes search common", method: "GET", path: "/boxes/search", query: { warehouse, q: commonTerm || "" }, category: "simple_read", hot: true, frontendRoute: "#/" },
    { feature: "Boxes search rare", method: "GET", path: "/boxes/search", query: rareTerm ? { warehouse, q: rareTerm } : null, category: "simple_read", frontendRoute: "#/" },
    { feature: "Boxes search no match", method: "GET", path: "/boxes/search", query: { warehouse, q: raw.noMatchTerm || "PERF_TIMING_NO_MATCH" }, category: "simple_read", frontendRoute: "#/" },
    { feature: "Box detail", method: "GET", path: "/boxes/get", query: boxId ? { boxId } : null, category: "complex_detail", frontendRoute: "#/inventory/:boxId" },
    { feature: "Audit by box", method: "GET", path: "/audit/by-box", query: boxId ? { boxId } : null, category: "simple_read", optional: true, frontendRoute: "#/inventory/:boxId" },
    { feature: "Allocations by box", method: "GET", path: "/allocations/by-box", query: boxId ? { boxId } : null, category: "simple_read", optional: true, frontendRoute: "#/inventory/:boxId" },
    { feature: "Roll history by box", method: "GET", path: "/roll-history/by-box", query: boxId ? { boxId } : null, category: "simple_read", optional: true, frontendRoute: "#/inventory/:boxId" },
    { feature: "Film orders list", method: "GET", path: "/film-orders/list", query: {}, category: "simple_read", frontendRoute: "#/film-orders" },
    { feature: "Film catalog", method: "GET", path: "/film-data/catalog", query: {}, category: "simple_read", frontendRoute: "#/film-orders" },
    { feature: "Reports summary", method: "GET", path: "/reports/summary", query: { warehouse }, category: "reports", hot: true, frontendRoute: "#/reports" },
    { feature: "Owner asset report", method: "GET", path: "/owner/reports/asset-total-cost", query: { warehouse }, category: "reports", optional: true, frontendRoute: "#/reports" },
    { feature: "Admin access requests", method: "GET", path: "/admin/access/requests", query: {}, category: "simple_read", optional: true, frontendRoute: "#/admin/access" },
    { feature: "Admin username requests", method: "GET", path: "/admin/username-requests", query: {}, category: "simple_read", optional: true, frontendRoute: "#/admin/access" },
    { feature: "Admin member permissions", method: "GET", path: "/admin/member-permissions", query: {}, category: "simple_read", optional: true, frontendRoute: "#/admin/access" }
  ];

  if (filmOrderJobNumber && filmOrderJobNumber !== allocationJobNumber) {
    routes.push({
      feature: "Film-order job detail",
      method: "GET",
      path: "/jobs/get",
      query: { jobNumber: filmOrderJobNumber },
      category: "complex_detail",
      frontendRoute: "#/allocations/:jobNumber"
    });
  }

  return routes;
}

async function timeRoute({ handleSupabaseRequest, token, route, warmupRuns, measuredRuns, timeoutMs }) {
  if (!route.query) {
    return {
      skipped: true,
      reason: "Required stable DEV input was unavailable.",
      samples: []
    };
  }

  if (route.optional || OPTIONAL_READ_ROUTES.has(route.path)) {
    const probe = await runBackendSample({ handleSupabaseRequest, token, route, timeoutMs, runIndex: -1, warmup: true });
    if (probe.status === 404) {
      return { skipped: true, reason: "Route absent or not implemented.", samples: [probe] };
    }
    if (probe.status === 403) {
      return { skipped: true, reason: "Token is not authorized for this optional route.", samples: [probe] };
    }
  }

  const samples = [];
  for (let index = 0; index < warmupRuns; index += 1) {
    samples.push(await runBackendSample({ handleSupabaseRequest, token, route, timeoutMs, runIndex: index, warmup: true }));
  }
  for (let index = 0; index < measuredRuns; index += 1) {
    samples.push(await runBackendSample({ handleSupabaseRequest, token, route, timeoutMs, runIndex: index, warmup: false }));
  }
  return { skipped: false, reason: "", samples };
}

async function runReadOnlyTimings({ handleSupabaseRequest, token, routes, warmupRuns, normalReadRuns, hotReadRuns, timeoutMs }) {
  const samples = [];
  const skipped = [];

  for (const route of routes) {
    const measuredRuns = route.hot ? hotReadRuns : normalReadRuns;
    const result = await timeRoute({
      handleSupabaseRequest,
      token,
      route,
      warmupRuns,
      measuredRuns,
      timeoutMs
    });
    samples.push(...result.samples);
    if (result.skipped) {
      skipped.push({
        feature: route.feature,
        route: `${route.method} ${route.path}`,
        reason: result.reason
      });
    }
  }

  const summaries = summarizeSamples(samples);
  for (const sample of samples) {
    const summary = summaries.find((entry) => entry.routeKey === routeKey(sample));
    sample.p95Confidence = summary?.stats?.p95Confidence || null;
  }
  return { samples, summaries, skipped };
}

async function runReadOnlyConcurrency({ handleSupabaseRequest, token, routes, timeoutMs }) {
  const allowedPaths = new Set(["/auth/context", "/jobs/list", "/jobs/search", "/boxes/search", "/film-orders/list", "/reports/summary", "/jobs/get"]);
  const candidates = routes
    .filter((route) => route.query && allowedPaths.has(route.path))
    .filter((route, index, array) => array.findIndex((entry) => entry.path === route.path) === index)
    .slice(0, 7);
  const results = [];

  for (const route of candidates) {
    for (const concurrency of [1, 3, 5]) {
      const startedAt = nowMs();
      const batch = await Promise.all(
        Array.from({ length: concurrency }, (_, index) =>
          runBackendSample({
            handleSupabaseRequest,
            token,
            route,
            timeoutMs,
            runIndex: index,
            warmup: false
          })
        )
      );
      results.push({
        route: `${route.method} ${route.path}`,
        feature: route.feature,
        concurrency,
        duration_ms: Math.round((nowMs() - startedAt) * 100) / 100,
        statuses: batch.map((sample) => sample.status),
        failureCount: batch.filter((sample) => !sample.ok).length,
        timeoutCount: batch.filter((sample) => sample.timeout).length,
        slowestCallMs: Math.max(...batch.map((sample) => Number(sample.duration_ms || 0))),
        severity: classifyTimingSeverity(route.category, Math.max(...batch.map((sample) => Number(sample.duration_ms || 0))), {
          timeout: batch.some((sample) => sample.timeout)
        })
      });
    }
  }

  return results;
}

async function runDbInvestigation({ envValues, orgId, skipDbInspection }) {
  if (skipDbInspection) {
    return {
      status: "unavailable",
      reason: "DB inspection skipped by flag.",
      metadataOnly: false,
      tables: [],
      indexes: [],
      functions: [],
      statementTimeout: null,
      queryPlans: []
    };
  }

  const connectionString = asTrimmedString(envValues.DEV_DATABASE_URL || envValues.DATABASE_URL);
  if (!connectionString) {
    return {
      status: "unavailable",
      reason: "DEV database URL was not available.",
      metadataOnly: false,
      tables: [],
      indexes: [],
      functions: [],
      statementTimeout: null,
      queryPlans: []
    };
  }

  try {
    const { Client } = await import("pg");
    const client = new Client({
      connectionString,
      ssl: /localhost|127\.0\.0\.1/i.test(connectionString) ? undefined : { rejectUnauthorized: false },
      application_name: SCRIPT_NAME
    });
    await client.connect();
    try {
      const statementTimeout = await client.query("show statement_timeout");
      const tables = await client.query(`
        select
          schemaname,
          relname as table_name,
          n_live_tup::bigint as approximate_rows,
          pg_total_relation_size(format('%I.%I', schemaname, relname)::regclass)::bigint as total_bytes
        from pg_stat_user_tables
        where schemaname = 'app'
        order by total_bytes desc, relname asc
        limit 40
      `);
      const indexes = await client.query(`
        select
          i.schemaname,
          i.tablename,
          i.indexname,
          pg_relation_size(format('%I.%I', i.schemaname, i.indexname)::regclass)::bigint as index_bytes,
          i.indexdef
        from pg_indexes i
        where i.schemaname = 'app'
          and i.tablename in (
            'jobs', 'boxes', 'allocations', 'job_requirements', 'film_orders',
            'film_order_box_links', 'roll_weight_log', 'caulk_job_allocations',
            'caulk_job_checkouts'
          )
        order by i.tablename, i.indexname
      `);
      const functions = await client.query(`
        select
          p.oid::regprocedure::text as signature,
          md5(pg_get_functiondef(p.oid)) as definition_checksum,
          length(pg_get_functiondef(p.oid)) as definition_bytes
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('app_api', 'public')
          and p.proname in (
            'reconcile_auto_planned_allocations',
            'auto_planner_scope_job_numbers',
            'api_acl_reconcile_auto_planned_allocations',
            'api_acl_boxes_set_status',
            'api_acl_jobs_update'
          )
        order by signature
      `);
      const queryPlans = [];
      const planQueries = [
        {
          label: "jobs_active_recent",
          sql: "explain (format json) select j.id from app.jobs j where j.org_id = $1::uuid and j.lifecycle_status = 'ACTIVE' order by j.created_at desc limit 25",
          params: [orgId]
        },
        {
          label: "boxes_by_org_warehouse",
          sql: "explain (format json) select b.id from app.boxes b where b.org_id = $1::uuid and upper(coalesce(b.warehouse::text, '')) = 'IL1' limit 25",
          params: [orgId]
        },
        {
          label: "allocations_active_by_org",
          sql: "explain (format json) select a.allocation_id from app.allocations a where a.org_id = $1::uuid and a.status = 'ACTIVE' limit 25",
          params: [orgId]
        }
      ];
      for (const planQuery of planQueries) {
        try {
          const plan = await client.query(planQuery.sql, planQuery.params);
          queryPlans.push({ label: planQuery.label, measurementType: "measured", plan: plan.rows?.[0]?.["QUERY PLAN"] || null });
        } catch (error) {
          queryPlans.push({ label: planQuery.label, measurementType: "unavailable", error: safeErrorMessage(error) });
        }
      }
      return {
        status: "partial",
        reason: "Direct DEV DB metadata is metadata_only and may not represent app-route execution context.",
        metadataOnly: true,
        tables: tables.rows,
        indexes: indexes.rows,
        functions: functions.rows,
        statementTimeout: statementTimeout.rows?.[0]?.statement_timeout || null,
        queryPlans
      };
    } finally {
      await client.end().catch(() => {});
    }
  } catch (error) {
    return {
      status: "unavailable",
      reason: `DB inspection unavailable: ${safeErrorMessage(error)}`,
      metadataOnly: false,
      tables: [],
      indexes: [],
      functions: [],
      statementTimeout: null,
      queryPlans: []
    };
  }
}

function buildRouteMap(routes) {
  return routes.map((route) => ({
    feature: route.feature,
    frontendRoute: route.frontendRoute || null,
    backendRoute: route.path,
    method: route.method,
    category: route.category,
    hotPath: Boolean(route.hot),
    optional: Boolean(route.optional)
  }));
}

function buildPayloadAnalysis(samples) {
  return summarizeSamples(samples).map((summary) => ({
    routeKey: summary.routeKey,
    payloadBytes: summary.payloadBytes,
    rowCounts: summary.rowCounts,
    note:
      summary.payloadBytes.max && summary.payloadBytes.max > 500_000
        ? "Large payload candidate; inspect returned shape and pagination opportunities."
        : "Payload size captured."
  }));
}

function buildApiCallCounts(routes, concurrencyResults) {
  const byFrontendRoute = new Map();
  for (const route of routes) {
    const frontendRoute = route.frontendRoute || "backend-only";
    if (!byFrontendRoute.has(frontendRoute)) {
      byFrontendRoute.set(frontendRoute, []);
    }
    byFrontendRoute.get(frontendRoute).push(`${route.method} ${route.path}`);
  }
  return Array.from(byFrontendRoute.entries()).map(([frontendRoute, calls]) => ({
    frontendRoute,
    backendCallCount: calls.length,
    backendCalls: Array.from(new Set(calls)),
    repeatedAuthContextCalls: calls.filter((entry) => entry.endsWith("/auth/context")).length,
    duplicateCalls: calls.length - new Set(calls).size,
    concurrencyEvidence: concurrencyResults.filter((entry) => calls.includes(entry.route)).length
  }));
}

function buildRankings(summaries) {
  return [...summaries]
    .filter((summary) => summary.sampleCount > 0)
    .sort((left, right) => {
      const leftScore = Number(left.stats.p95 ?? left.stats.max ?? 0);
      const rightScore = Number(right.stats.p95 ?? right.stats.max ?? 0);
      return rightScore - leftScore;
    })
    .map((summary, index) => ({
      rank: index + 1,
      routeKey: summary.routeKey,
      feature: summary.feature,
      p50: summary.stats.p50,
      p75: summary.stats.p75,
      p95: summary.stats.p95,
      max: summary.stats.max,
      severity: summary.severity,
      p95Confidence: summary.stats.p95Confidence
    }));
}

function hypothesisForRoute(routeKey) {
  if (routeKey.includes("/jobs/list")) {
    return "Full-org job aggregation and broad related-table reads may dominate.";
  }
  if (routeKey.includes("/jobs/search")) {
    return "Search may be doing broad matching before limiting results.";
  }
  if (routeKey.includes("/jobs/get")) {
    return "Job detail may spend time in pooled related reads and nested payload assembly.";
  }
  if (routeKey.includes("/boxes/search")) {
    return "Inventory search may return large result sets or broad filters.";
  }
  if (routeKey.includes("/reports/summary")) {
    return "Report aggregation may scan wide inventory, job, and audit slices.";
  }
  if (routeKey.includes("/allocations/preview")) {
    return "Allocation preview may scan compatible inventory and planner context.";
  }
  return "Route requires follow-up inspection if it exceeds its budget.";
}

function buildFixQueue(rankings) {
  const top = rankings.slice(0, 5);
  const queue = top.map((entry, index) => ({
    priority: index + 1,
    route: entry.routeKey,
    evidence: `p50=${entry.p50}ms p95=${entry.p95}ms max=${entry.max}ms severity=${entry.severity}`,
    suspectedCause: hypothesisForRoute(entry.routeKey),
    recommendedFutureChange: futureChangeForRoute(entry.routeKey),
    riskLevel: entry.routeKey.includes("/jobs/complete") ? "medium" : "low",
    expectedImpact: "Reduce p95 and max latency for the measured route if hypothesis is confirmed.",
    validationTest: "Run this audit before and after the change and compare p50/p95/max, payload bytes, timeout count, and route errors.",
    confidence: entry.p95Confidence === "standard" ? "medium" : "low"
  }));

  if (!queue.some((entry) => entry.route.includes("/jobs/complete"))) {
    queue.push({
      priority: queue.length + 1,
      route: "POST /jobs/complete",
      evidence: "Mutation timing was not executed in this pass; known code path includes completion, detail reload, and org-wide planner reconciliation.",
      suspectedCause: "Org-wide `app_api.reconcile_auto_planned_allocations({})` inside the mutation transaction may create timeout risk.",
      recommendedFutureChange: "Add DEV-only sub-timing instrumentation before running the separately approved mutation audit.",
      riskLevel: "low",
      expectedImpact: "Improves diagnosis without changing performance behavior.",
      validationTest: "Future mutation audit captures completeJob, detail reload, planner duration, and total route duration.",
      confidence: "medium"
    });
  }
  return queue;
}

function futureChangeForRoute(routeKey) {
  if (routeKey.includes("/jobs/list")) {
    return "Evaluate narrower list payloads, pagination, or scoped aggregation after confirming query/payload evidence.";
  }
  if (routeKey.includes("/jobs/search")) {
    return "Evaluate search-specific indexes or reduced payload response after confirming EXPLAIN/payload evidence.";
  }
  if (routeKey.includes("/boxes/search")) {
    return "Evaluate inventory search pagination, narrower filters, or payload trimming after confirming result size.";
  }
  if (routeKey.includes("/reports/summary")) {
    return "Evaluate report pre-aggregation or narrower report queries after confirming plan evidence.";
  }
  if (routeKey.includes("/allocations/preview")) {
    return "Evaluate planner scope and compatible inventory scan reduction after confirming route and DB evidence.";
  }
  return "Inspect route-specific query and payload evidence before choosing a fix.";
}

function updateExecutiveSummary(report) {
  const rankings = report.rankings || [];
  const topBottlenecks = rankings.slice(0, 5);
  const highestRisk = rankings.find((entry) => entry.severity === "critical") || rankings[0] || null;
  const fixQueue = report.fixQueue || [];
  report.executiveSummary = {
    topBottlenecks,
    highestRiskRoute: highestRisk ? highestRisk.routeKey : null,
    fastestLowRiskFutureFixCandidate: fixQueue.find((entry) => entry.riskLevel === "low") || null,
    likelyCauses: topBottlenecks.map((entry) => hypothesisForRoute(entry.routeKey)),
    prodTimeoutRisk: highestRisk?.severity === "critical" ? "high" : highestRisk?.severity === "bad" ? "medium" : "low",
    confidenceLevel: topBottlenecks.some((entry) => entry.p95Confidence === "standard") ? "medium" : "low",
    nextRecommendedInvestigationStep:
      "Review top ranked route payload/query evidence, then run separately approved tagged DEV mutation timing for /jobs/complete if still needed.",
    auditOutcome: report.auditOutcome.status
  };
}

async function writeReport(report, outPath, secretValues) {
  const sanitized = sanitizeReportValue(report, secretValues);
  if (detectSecretLeak(sanitized, secretValues)) {
    throw new Error("Refusing to write report because secret-like content remained after sanitization.");
  }
  const resolvedPath = path.resolve(outPath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  fs.writeFileSync(resolvedPath, `${JSON.stringify(sanitized, null, 2)}\n`, "utf8");
  return resolvedPath;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const envPath = asTrimmedString(options.env || path.join("backend", ".env.dev"));
  const expectedProjectRef = asTrimmedString(options["expected-project-ref"] || DEV_PROJECT_REF);
  const rejectedProjectRef = asTrimmedString(options["reject-project-ref"] || PROD_PROJECT_REF);
  const orgId = asTrimmedString(options["org-id"]);
  const tokenFile = asTrimmedString(options["auth-token-file"] || path.join(".secrets", "smoke-user-token.txt"));
  const outPath = asTrimmedString(options.out || DEFAULT_OUT);
  const preflightOnly = options["preflight-only"] === true;
  const readOnlyMode = options["read-only"] === true;
  const includeDevMutations = options["include-dev-mutations"] === true;
  const warmupRuns = integerOption(options, "warmup-runs", 2);
  const normalReadRuns = integerOption(options, "normal-read-runs", 10);
  const hotReadRuns = integerOption(options, "hot-read-runs", 20);
  const mutationRuns = integerOption(options, "mutation-runs", 3);
  const timeoutMs = integerOption(options, "timeout-ms", 30000);
  const skipDbInspection = options["skip-db-inspection"] === true;
  const skipConcurrency = options["skip-concurrency"] === true;
  const runMode = includeDevMutations ? "mutation" : readOnlyMode ? "read_only" : "preflight";
  const runId = includeDevMutations
    ? `PERF_TIMING_${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}_${crypto.randomInt(1000, 10000)}`
    : null;

  const gitStatusBefore = getGitStatus();
  const report = buildReportSkeleton({
    expectedProjectRef,
    rejectedProjectRef,
    orgId,
    runMode,
    runId,
    gitStatusBefore
  });
  report.metadata.scriptVersion = getGitCommit();
  report.methodology.warmupRuns = warmupRuns;
  report.methodology.normalReadRuns = normalReadRuns;
  report.methodology.hotReadRuns = hotReadRuns;
  report.methodology.mutationRuns = mutationRuns;
  report.methodology.timeoutMs = timeoutMs;
  report.safety.gitStatusBefore = gitStatusBefore;
  report.safety.allowedDirtyPaths = gitStatusBefore.allowedDirty.map((entry) => entry.path);
  report.safety.unexpectedDirtyPaths = gitStatusBefore.unexpectedDirty.map((entry) => entry.path);
  report.gitStatus.before = gitStatusBefore;

  let env = { path: path.resolve(envPath), values: {} };
  let secretValues = [];
  let reportWriteFailed = false;
  let safetyFailed = false;
  let readOnlyRan = false;
  let browserUnavailable = true;
  let dbUnavailable = true;
  let routeFailures = 0;
  let skippedRoutes = 0;

  try {
    if (!gitStatusBefore.ok) {
      throw new Error(`Unexpected dirty files before audit: ${gitStatusBefore.unexpectedDirty.map((entry) => entry.path).join(", ")}`);
    }

    env = readEnvFile(envPath);
    secretValues = collectSecretValues(env.values);
    report.safety.envFileChecked = env.path;
    const projectCheck = validateProjectRefs({
      envValues: env.values,
      expectedProjectRef,
      rejectProjectRef: rejectedProjectRef
    });
    report.safety.envPointsToDev = projectCheck.envPointsToDev;
    report.safety.prodRefDetected = projectCheck.prodRefDetected;
    report.metadata.expectedProjectRef = projectCheck.expectedProjectRef;
    report.metadata.rejectedProjectRef = projectCheck.rejectedProjectRef;
    if (!projectCheck.ok) {
      throw new Error(projectCheck.errors.join(" "));
    }

    const currentEnvPath = path.join("backend", ".env");
    if (fs.existsSync(currentEnvPath)) {
      const currentEnv = readEnvFile(currentEnvPath);
      const currentCheck = validateProjectRefs({
        envValues: currentEnv.values,
        expectedProjectRef,
        rejectProjectRef: rejectedProjectRef
      });
      if (currentCheck.prodRefDetected) {
        throw new Error("backend/.env contains the rejected PROD project ref.");
      }
    }

    const tokenCheck = checkTokenFile(tokenFile);
    report.safety.tokenFileExists = tokenCheck.exists;
    report.safety.tokenFileGitignored = tokenCheck.gitignored;
    report.safety.tokenFileTracked = tokenCheck.tracked;
    if (!tokenCheck.ok) {
      throw new Error(tokenCheck.errors.join(" "));
    }

    const token = asTrimmedString(fs.readFileSync(path.resolve(tokenFile), "utf8"));
    if (!token) {
      throw new Error("Auth token file is empty.");
    }

    applyEnvValues(env.values);
    process.env.DEFAULT_ORG_ID = orgId;

    const authSample = await runAuthUserSample({ envValues: env.values, token, timeoutMs, runIndex: 0, warmup: false });
    report.readOnlyTimings.samples.push(authSample);
    report.safety.authUserPassed = authSample.ok;
    if (!authSample.ok) {
      throw new Error(`DEV /auth/v1/user verification failed: ${authSample.error || authSample.status}`);
    }

    const { handleSupabaseRequest } = await import("../supabase-backend.mjs");
    const authContextSample = await runBackendSample({
      handleSupabaseRequest,
      token,
      route: { feature: "Auth context", method: "GET", path: "/auth/context", query: {}, category: "auth" },
      timeoutMs,
      runIndex: 0,
      warmup: false
    });
    report.readOnlyTimings.samples.push(authContextSample);
    report.safety.authContextPassed = authContextSample.ok;
    if (!authContextSample.ok) {
      throw new Error(`DEV /auth/context verification failed: ${authContextSample.error || authContextSample.status}`);
    }

    const authContextResponse = await handleSupabaseRequest({
      method: "GET",
      logicalPath: "/auth/context",
      requestUrl: buildRequestUrl("/auth/context", {}),
      bodyJson: null,
      headers: { Authorization: `Bearer ${token}` }
    });
    const context = authContextResponse?.payload?.data || {};
    const role = asTrimmedString(context.role).toLowerCase();
    const permissions = context.permissions && typeof context.permissions === "object" ? context.permissions : null;
    const orgMatches = asTrimmedString(context.orgId) === orgId;
    const approved = context.accessStatus === "approved";
    const roleImpliesAccess = role === "owner" || role === "admin";
    const missingWrites = permissions
      ? REQUIRED_WRITE_FEATURES.filter((feature) => permissions?.[feature]?.write !== true)
      : [];
    const permissionPassed = approved && orgMatches && (roleImpliesAccess || (permissions && missingWrites.length === 0));
    report.safety.devPermissionCheck = {
      passed: Boolean(permissionPassed),
      depth: permissions ? "permissions_field" : roleImpliesAccess ? "role_only" : "unavailable",
      role: role || "",
      accessStatus: context.accessStatus || "",
      orgMatches,
      missingWritePermissions: missingWrites,
      reason: permissions
        ? "Permission fields were available."
        : roleImpliesAccess
          ? "Permission map unavailable; owner/admin role accepted for basic DEV audit access."
          : "Permission map unavailable and role did not imply access."
    };
    if (!permissionPassed) {
      throw new Error("DEV token did not resolve to approved access with required org/role/permissions.");
    }

    const mutationGate = buildMutationGate({
      includeDevMutations,
      confirmation: options["confirm-dev-mutation"],
      preflightPassed: true,
      readOnlyPassed: readOnlyMode
    });
    report.mutationTimings.gate = mutationGate;
    if (includeDevMutations) {
      if (!mutationGate.allowed) {
        throw new Error(mutationGate.reason);
      }
      report.mutationTimings.reason = "Mutation timing support is gated, but this pass must not execute mutation timing.";
      throw new Error("Mutation timing is intentionally disabled for this pass. Re-run only after separate explicit approval.");
    }

    if (preflightOnly) {
      report.auditOutcome = classifyAuditOutcome({ preflightOnly: true });
      report.executiveSummary.auditOutcome = report.auditOutcome.status;
      return;
    }

    if (readOnlyMode) {
      const testData = await selectTestData({ handleSupabaseRequest, token, timeoutMs });
      report.testDataSelection = {
        selectedInputs: testData.selectedInputs,
        skippedInputs: testData.skippedInputs,
        confidence: testData.confidence
      };
      const routes = buildReadOnlyRoutes(testData);
      report.routeMap = buildRouteMap(routes);
      const readOnly = await runReadOnlyTimings({
        handleSupabaseRequest,
        token,
        routes,
        warmupRuns,
        normalReadRuns,
        hotReadRuns,
        timeoutMs
      });
      report.readOnlyTimings.samples.push(...readOnly.samples);
      report.readOnlyTimings.summaries = summarizeSamples(report.readOnlyTimings.samples);
      report.statisticalSummary = report.readOnlyTimings.summaries;
      report.rankings = buildRankings(report.readOnlyTimings.summaries);
      report.payloadAnalysis = buildPayloadAnalysis(report.readOnlyTimings.samples);
      skippedRoutes = readOnly.skipped.length;
      routeFailures = report.readOnlyTimings.samples.filter((sample) => !sample.warmup && sample.ok === false).length;
      report.recommendations = readOnly.skipped.map((entry) => ({
        type: "skipped_route",
        route: entry.route,
        reason: entry.reason
      }));

      if (!skipConcurrency) {
        report.readOnlyTimings.concurrency = await runReadOnlyConcurrency({
          handleSupabaseRequest,
          token,
          routes,
          timeoutMs
        });
      }
      report.apiCallCounts = buildApiCallCounts(routes, report.readOnlyTimings.concurrency);

      const db = await runDbInvestigation({ envValues: env.values, orgId, skipDbInspection });
      report.dbInvestigation = {
        status: db.status,
        reason: db.reason,
        metadataOnly: db.metadataOnly,
        tables: db.tables,
        indexes: db.indexes,
        functions: db.functions,
        statementTimeout: db.statementTimeout
      };
      report.queryPlanFindings = db.queryPlans || [];
      dbUnavailable = db.status === "unavailable";
      report.frontendRouteAnalysis = {
        status: "unavailable",
        reason: "Browser/page timing was not run because no safe app base URL/browser execution was requested.",
        pages: []
      };
      report.fixQueue = buildFixQueue(report.rankings);
      updateExecutiveSummary(report);
      readOnlyRan = true;
      browserUnavailable = true;
    }
  } catch (error) {
    safetyFailed = !report.safety.authUserPassed || !report.safety.authContextPassed || report.safety.prodRefDetected || !report.safety.envPointsToDev;
    report.safety.stopConditionTriggered = true;
    report.safety.stopConditionReason = safeErrorMessage(error);
    report.recommendations.push({
      type: "stop_condition",
      reason: safeErrorMessage(error)
    });
  } finally {
    const gitStatusAfter = getGitStatus();
    report.safety.gitStatusAfter = gitStatusAfter;
    report.gitStatus.after = gitStatusAfter;
    report.gitStatus.before = report.gitStatus.before || gitStatusBefore;
    report.created.artifacts = shapeCreatedArtifactInventory({});
    report.auditOutcome = classifyAuditOutcome({
      safetyFailed: safetyFailed || report.safety.stopConditionTriggered && !preflightOnly && !readOnlyRan,
      reportWriteFailed,
      readOnlyRan,
      mutationRan: false,
      browserUnavailable,
      dbUnavailable,
      skippedRoutes,
      routeFailures,
      preflightOnly
    });
    report.executiveSummary.auditOutcome = report.auditOutcome.status;
    if (!report.fixQueue.length) {
      report.fixQueue = buildFixQueue(report.rankings || []);
    }
    updateExecutiveSummary(report);
    try {
      await writeReport(report, outPath, secretValues);
    } catch (error) {
      reportWriteFailed = true;
      // eslint-disable-next-line no-console
      console.error(`[${SCRIPT_NAME}] failed to write sanitized report: ${safeErrorMessage(error)}`);
      process.exitCode = 1;
      return;
    }

    const summary = {
      auditOutcome: report.auditOutcome.status,
      reportPath: path.resolve(outPath),
      preflightPassed: report.safety.authUserPassed && report.safety.authContextPassed && report.safety.envPointsToDev && !report.safety.prodRefDetected,
      readOnlyRan,
      mutationTimingExecuted: false,
      topBottlenecks: (report.rankings || []).slice(0, 5),
      skippedRoutes,
      routeFailures
    };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(summary, null, 2));
  }
}

await main();

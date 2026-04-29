#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { Client } from "pg";
import {
  DEV_PROJECT_REF,
  PROD_PROJECT_REF,
  extractDbProjectRef,
  extractSupabaseProjectRef,
  parseArgs,
  writeJson
} from "./lib/legacy-reconciliation-dry-run.mjs";
import { resolveSmokeAuthToken } from "./lib/smoke-auth.mjs";
import {
  deriveCoreWeightLbs,
  normalizeCoreType
} from "../src/app/core/helpers.mjs";

const SCRIPT_NAME = "smoke-box-checkin-reconciliation-flow";
const CONFIRM_DEV_MUTATION = "RUN_DEV_BOX_CHECKIN_RECONCILIATION_SMOKE";
const DEFAULT_ENV_PATH = path.join("backend", ".env.dev");
const DEFAULT_OUT_DIR = path.join("backend", "migration-dry-runs", "smoke");
const DEFAULT_AUTH_TOKEN_ENV = "SMOKE_USER_ACCESS_TOKEN";
const DEFAULT_WAREHOUSE = "IL1";
const CHECKIN_REMAINING_RATIO = 0.4;
const CORE_TYPE = "White plastic";
const LF_WEIGHT_LBS_PER_FT = 0.1;

function asTrimmedString(value) {
  return String(value ?? "").trim();
}

function asUpperTrimmedString(value) {
  return asTrimmedString(value).toUpperCase();
}

function maskEmail(email) {
  const trimmed = asTrimmedString(email);
  const atIndex = trimmed.indexOf("@");
  if (atIndex <= 1) {
    return trimmed || "<unset>";
  }
  return `${trimmed.slice(0, 1)}***${trimmed.slice(atIndex)}`;
}

function integerOrZero(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.max(Math.trunc(parsed), 0);
}

function numericOrNull(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function roundUpToDecimals(value, places = 2) {
  const factor = 10 ** places;
  return Math.ceil(Number(value || 0) * factor) / factor;
}

function assertOk(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
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

function readEnvFile(envPath) {
  const resolvedPath = path.resolve(envPath);
  const contents = fs.readFileSync(resolvedPath, "utf8").replace(/^\uFEFF/, "");
  const values = {};

  for (const rawLine of contents.split(/\r?\n/)) {
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
    if (!key) {
      continue;
    }

    values[key] = normalizeEnvValue(normalized.slice(separatorIndex + 1));
  }

  return { path: resolvedPath, values };
}

function applyEnvValues(values) {
  for (const [key, value] of Object.entries(values || {})) {
    process.env[key] = value;
  }
}

function resolveSmokeConfig(options) {
  if (options.help || options.h) {
    return { help: true };
  }

  const authOnly = options["auth-only"] === true || asTrimmedString(options["auth-only"]).toLowerCase() === "true";

  if (options.apply || asTrimmedString(options.mode).toLowerCase() === "apply") {
    throw new Error("This smoke script is an explicit DEV mutation flow; do not pass --apply.");
  }

  const expectedEnvPath = path.resolve(DEFAULT_ENV_PATH);
  const envPath = path.resolve(asTrimmedString(options.env || DEFAULT_ENV_PATH));
  if (path.normalize(envPath).toLowerCase() !== path.normalize(expectedEnvPath).toLowerCase()) {
    throw new Error(`Refusing to load env file outside the canonical DEV path ${expectedEnvPath}: ${envPath}`);
  }
  const envBaseName = path.basename(envPath).toLowerCase();
  if (envBaseName !== ".env.dev") {
    throw new Error(`Refusing to load non-DEV env file for ${SCRIPT_NAME}: ${envPath}`);
  }
  if (/\.prod(?:\.|$)/i.test(envBaseName) || /prod/i.test(envBaseName)) {
    throw new Error(`Refusing to load PROD-looking env file for ${SCRIPT_NAME}: ${envPath}`);
  }

  const expectedProjectRef = asTrimmedString(options["expected-project-ref"] || DEV_PROJECT_REF).toLowerCase();
  if (!expectedProjectRef) {
    throw new Error("--expected-project-ref is required.");
  }
  if (expectedProjectRef === PROD_PROJECT_REF) {
    throw new Error("Refusing to use the PROD project ref as --expected-project-ref.");
  }
  if (expectedProjectRef !== DEV_PROJECT_REF) {
    throw new Error(`Refusing to run against non-DEV project ref ${expectedProjectRef}.`);
  }

  if (!authOnly && asTrimmedString(options["confirm-dev-mutation"]) !== CONFIRM_DEV_MUTATION) {
    throw new Error(`DEV smoke mutation requires --confirm-dev-mutation ${CONFIRM_DEV_MUTATION}.`);
  }

  const env = readEnvFile(envPath);
  const supabaseProjectRef = extractSupabaseProjectRef(env.values.SUPABASE_URL);
  if (!supabaseProjectRef) {
    throw new Error(`SUPABASE_URL with a Supabase project ref is required in ${env.path}.`);
  }
  if (supabaseProjectRef === PROD_PROJECT_REF) {
    throw new Error(`Refusing to run against PROD Supabase project ref ${PROD_PROJECT_REF}.`);
  }
  if (supabaseProjectRef !== expectedProjectRef) {
    throw new Error(`Supabase project ref mismatch. Expected ${expectedProjectRef}, found ${supabaseProjectRef}.`);
  }

  const databaseUrlVar = asTrimmedString(options["database-url-var"] || "DEV_DATABASE_URL");
  if (!databaseUrlVar || /prod/i.test(databaseUrlVar)) {
    throw new Error("Refusing to use a PROD-looking database URL variable.");
  }
  const databaseUrl = asTrimmedString(env.values[databaseUrlVar] || env.values.DATABASE_URL);
  if (!databaseUrl) {
    throw new Error(`${databaseUrlVar} or DATABASE_URL is required in ${env.path}.`);
  }

  const databaseProjectRef = extractDbProjectRef(databaseUrl);
  if (databaseProjectRef === PROD_PROJECT_REF) {
    throw new Error(`Refusing to connect to PROD database project ref ${PROD_PROJECT_REF}.`);
  }
  if (databaseProjectRef && databaseProjectRef !== expectedProjectRef) {
    throw new Error(`Database project ref mismatch. Expected ${expectedProjectRef}, found ${databaseProjectRef}.`);
  }

  const orgId = asTrimmedString(options["org-id"]);
  if (!orgId) {
    throw new Error("--org-id is required; this smoke script will not guess the organization.");
  }

  const runTag = asTrimmedString(options["run-tag"]) || buildRunTag();
  const shortTag = buildShortTag(runTag);
  const outPath = asTrimmedString(options.out)
    ? path.resolve(options.out)
    : path.resolve(DEFAULT_OUT_DIR, `${SCRIPT_NAME}-${shortTag}.json`);

  return {
    env,
    envPath: env.path,
    expectedProjectRef,
    supabaseProjectRef,
    databaseProjectRef: databaseProjectRef || null,
    databaseUrl,
    databaseUrlVar,
    orgId,
    runTag,
    shortTag,
    outPath,
    warehouse: asUpperTrimmedString(options.warehouse || DEFAULT_WAREHOUSE),
    frontendUrl: asTrimmedString(options["frontend-url"] || env.values.SMOKE_FRONTEND_URL || "http://127.0.0.1:5173"),
    authTokenEnvName: asTrimmedString(options["auth-token-env"] || DEFAULT_AUTH_TOKEN_ENV),
    authTokenFilePath: asTrimmedString(options["auth-token-file"]),
    allowPasswordLogin: options["allow-password-login"] === true || asTrimmedString(options["allow-password-login"]).toLowerCase() === "true",
    allowOwnerSmokeRun: options["allow-owner-smoke-run"] === true || asTrimmedString(options["allow-owner-smoke-run"]).toLowerCase() === "true",
    expectedSmokeUserId: asTrimmedString(options["expected-smoke-user-id"] || env.values.SMOKE_USER_ID),
    expectedSmokeEmail: asTrimmedString(
      options["expected-smoke-email"] ||
      env.values.SMOKE_USER_EMAIL ||
      buildDefaultSmokeUserEmail(supabaseProjectRef)
    ),
    authOnly
  };
}

function buildRunTag() {
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  return `SMOKE_RECON_${stamp}_${crypto.randomInt(1000, 10_000)}`;
}

function buildShortTag(runTag) {
  const normalized = asUpperTrimmedString(runTag).replace(/[^A-Z0-9]/g, "");
  return normalized.slice(-10) || crypto.randomInt(100000, 999999).toString();
}

function buildDefaultSmokeUserEmail(projectRef) {
  return `smoke+${asTrimmedString(projectRef).toLowerCase()}@example.com`;
}

function todayDateString() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function buildJobNumbers(shortTag) {
  const numeric = shortTag.replace(/\D/g, "").slice(-6).padStart(6, "0");
  return {
    editableCheckout: `91${numeric}`,
    editableTarget: `92${numeric}`,
    onWayCheckout: `93${numeric}`,
    onWayTarget: `94${numeric}`,
    receiveTarget: `95${numeric}`,
    onWayCancellation: `96${numeric}`,
    cancellationCheckout: `97${numeric}`,
    cancellationPreserved: `98${numeric}`,
    cancellationReduced: `99${numeric}`
  };
}

function buildBoxIds(warehouse, shortTag) {
  const suffix = shortTag.slice(-8);
  return {
    editable: `${warehouse}-SMRE-${suffix}-A`,
    onWay: `${warehouse}-SMRE-${suffix}-B`,
    cancellation: `${warehouse}-SMRE-${suffix}-C`,
    receiveOrdered: `${warehouse}-SMRE-${suffix}-O`
  };
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

function assertTokenEnvNameSafe(tokenEnvName) {
  const normalized = asTrimmedString(tokenEnvName);
  if (!normalized) {
    throw new Error("--auth-token-env must name a non-empty environment variable.");
  }
  if (!/^[A-Z_][A-Z0-9_]*$/i.test(normalized)) {
    throw new Error(`Invalid --auth-token-env value: ${normalized}`);
  }
  if (/prod/i.test(normalized)) {
    throw new Error("Refusing to read an auth token from a PROD-looking environment variable.");
  }
}

function assertTokenFileIsLocalAndUntracked(tokenFilePath) {
  const resolvedPath = path.resolve(tokenFilePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Auth token file was not found: ${resolvedPath}`);
  }

  const repoRoot = path.resolve(".");
  const relativePath = path.relative(repoRoot, resolvedPath);
  if (!relativePath.startsWith("..") && !path.isAbsolute(relativePath)) {
    try {
      execFileSync("git", ["ls-files", "--error-unmatch", relativePath], {
        cwd: repoRoot,
        stdio: "ignore"
      });
      throw new Error(`Refusing to read auth token from a tracked file: ${resolvedPath}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Refusing to read auth token")) {
        throw error;
      }
    }

    try {
      execFileSync("git", ["check-ignore", "-q", relativePath], {
        cwd: repoRoot,
        stdio: "ignore"
      });
    } catch {
      throw new Error(`Refusing to read auth token from a repo-local file that is not git-ignored: ${resolvedPath}`);
    }
  }

  return resolvedPath;
}

function readAuthTokenFile(tokenFilePath) {
  const resolvedPath = assertTokenFileIsLocalAndUntracked(tokenFilePath);
  const token = asTrimmedString(fs.readFileSync(resolvedPath, "utf8"));
  if (!token) {
    throw new Error(`Auth token file is empty: ${resolvedPath}`);
  }
  return token;
}

async function resolveSmokeAccessToken(config) {
  assertTokenEnvNameSafe(config.authTokenEnvName);

  const envToken = asTrimmedString(process.env[config.authTokenEnvName]);
  if (envToken) {
    return {
      token: envToken,
      source: `env:${config.authTokenEnvName}`,
      passwordLoginUsed: false
    };
  }

  if (config.authTokenFilePath) {
    return {
      token: readAuthTokenFile(config.authTokenFilePath),
      source: "file",
      passwordLoginUsed: false
    };
  }

  if (config.allowPasswordLogin) {
    const resolved = await resolveSmokeAuthToken({
      required: true,
      requiredFor: "box check-in reconciliation smoke test"
    });
    return {
      token: resolved.token,
      source: resolved.source === "SMOKE_USER_EMAIL" ? "password-login:SMOKE_USER_EMAIL" : resolved.source,
      passwordLoginUsed: resolved.source === "SMOKE_USER_EMAIL"
    };
  }

  throw new Error(
    `Smoke auth requires a DEV access token. Set ${config.authTokenEnvName}, pass --auth-token-file <ignored-local-file>, or explicitly pass --allow-password-login true.`
  );
}

async function fetchDevAuthUserIdentity(config, token) {
  const supabaseUrl = asTrimmedString(config.env.values.SUPABASE_URL).replace(/\/+$/g, "");
  const anonKey = asTrimmedString(config.env.values.SUPABASE_ANON_KEY);
  if (!supabaseUrl || !anonKey) {
    throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY are required to verify the DEV access token.");
  }

  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: anonKey
    }
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const detail =
      asTrimmedString(payload?.msg) ||
      asTrimmedString(payload?.error_description) ||
      asTrimmedString(payload?.error) ||
      asTrimmedString(payload?.message);
    throw new Error(`DEV access token failed Supabase user verification.${detail ? ` ${detail}` : ""}`);
  }

  const userId = asTrimmedString(payload?.id);
  const email = asTrimmedString(payload?.email);
  if (!userId || !email) {
    throw new Error("DEV access token verification returned no user id/email.");
  }

  return {
    userId,
    email
  };
}

function createApiClient({ handleSupabaseRequest, token, steps }) {
  async function request(method, logicalPath, { query = {}, body = {}, label = logicalPath } = {}) {
    const response = await handleSupabaseRequest({
      method,
      logicalPath,
      requestUrl: buildRequestUrl(logicalPath, query),
      bodyJson: method === "GET" ? null : body,
      headers: {
        Authorization: `Bearer ${token}`
      }
    });
    const warnings = Array.isArray(response?.payload?.warnings) ? response.payload.warnings : [];
    steps.push({
      label,
      method,
      path: logicalPath,
      statusCode: response?.statusCode || 0,
      ok: response?.payload?.ok === true,
      warningCount: warnings.length,
      warnings
    });
    if (response?.statusCode !== 200 || response?.payload?.ok !== true) {
      throw new Error(
        `${label} failed with HTTP ${response?.statusCode || 0}: ${asTrimmedString(response?.payload?.error) || "unknown error"}`
      );
    }
    return {
      data: response.payload.data,
      warnings
    };
  }

  return {
    get: (logicalPath, query = {}, label = logicalPath) => request("GET", logicalPath, { query, label }),
    post: (logicalPath, body = {}, label = logicalPath) => request("POST", logicalPath, { body, label })
  };
}

async function fetchSchemaPreflight(client) {
  const result = await client.query(`
    select jsonb_build_object(
      'filmOrdersRequirementId', exists (
        select 1
        from information_schema.columns
        where table_schema = 'app'
          and table_name = 'film_orders'
          and column_name = 'requirement_id'
      ),
      'filmOrderMatchesRequirement', to_regprocedure('app_api.film_order_matches_requirement(uuid, uuid, text, text, numeric, uuid, text, text, numeric)') is not null,
      'reconcileBoxCheckinAllocations', to_regprocedure('app_api.reconcile_box_checkin_allocations(uuid, text, text, integer)') is not null,
      'reconcileExistingFilmOrderNeedForRequirement', to_regprocedure('app_api.reconcile_existing_film_order_need_for_requirement(uuid, text, uuid)') is not null,
      'boxPhysicalFeetAvailable', to_regprocedure('app_api.box_physical_feet_available(app.boxes)') is not null
    ) as checks
  `);
  return result.rows[0]?.checks || {};
}

function requireSchemaPreflight(checks) {
  const missing = Object.entries(checks)
    .filter(([, value]) => value !== true)
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(`DEV schema preflight failed. Missing: ${missing.join(", ")}.`);
  }
}

async function assertNoExistingSmokeTag(client, orgId, runTag, boxIds, jobNumbers) {
  const result = await client.query(
    `
      select jsonb_build_object(
        'boxes', (
          select count(*)::integer
          from app.boxes
          where org_id = $1::uuid
            and (
              box_id = any($2::text[])
              or notes ilike '%' || $4::text || '%'
            )
        ),
        'jobs', (
          select count(*)::integer
          from app.jobs
          where org_id = $1::uuid
            and (
              job_number = any($3::text[])
              or notes ilike '%' || $4::text || '%'
            )
        ),
        'filmOrders', (
          select count(*)::integer
          from app.film_orders
          where org_id = $1::uuid
            and (
              job_number = any($3::text[])
              or notes ilike '%' || $4::text || '%'
            )
        )
      ) as existing
    `,
    [orgId, Object.values(boxIds), Object.values(jobNumbers), runTag]
  );
  const existing = result.rows[0]?.existing || {};
  const total = integerOrZero(existing.boxes) + integerOrZero(existing.jobs) + integerOrZero(existing.filmOrders);
  if (total > 0) {
    throw new Error(
      `Smoke tag ${runTag} is not unique. Existing rows: boxes=${existing.boxes}, jobs=${existing.jobs}, filmOrders=${existing.filmOrders}.`
    );
  }
}

function requireFeatureWrite(context, feature) {
  const permission = context?.permissions?.[feature];
  if (!permission?.write) {
    throw new Error(`Smoke User is missing ${feature}.write permission in DEV.`);
  }
}

function resolveSmokeUserMatch(config, tokenIdentity) {
  const expectedUserId = asTrimmedString(config.expectedSmokeUserId);
  const expectedEmail = asTrimmedString(config.expectedSmokeEmail).toLowerCase();
  const tokenUserId = asTrimmedString(tokenIdentity?.userId);
  const tokenEmail = asTrimmedString(tokenIdentity?.email).toLowerCase();
  const userIdMatched = Boolean(expectedUserId && tokenUserId && tokenUserId === expectedUserId);
  const emailMatched = Boolean(expectedEmail && tokenEmail && tokenEmail === expectedEmail);

  return {
    userIdMatched,
    emailMatched,
    matched: expectedUserId ? userIdMatched : emailMatched,
    expectedSmokeEmailMasked: maskEmail(config.expectedSmokeEmail),
    expectedSmokeUserId: expectedUserId
  };
}

async function assertSmokeAccess(api, config, tokenSource, tokenIdentity) {
  assertOk(
    config.supabaseProjectRef === DEV_PROJECT_REF,
    `Smoke auth context must resolve through DEV project ${DEV_PROJECT_REF}; found ${config.supabaseProjectRef}.`
  );
  const context = (await api.get("/auth/context", {}, "GET /auth/context")).data || {};
  assertOk(context.orgId === config.orgId, `Smoke User org mismatch. Expected ${config.orgId}, found ${context.orgId}.`);
  assertOk(context.accessStatus === "approved", `Smoke User is not approved in DEV: ${context.accessStatus || "<empty>"}.`);
  assertOk(context.role === "admin" || context.role === "owner", `Smoke User role must be admin or owner; found ${context.role || "<empty>"}.`);
  for (const feature of ["inventory", "allocations", "jobs", "film_orders"]) {
    requireFeatureWrite(context, feature);
  }
  const smokeUserMatch = resolveSmokeUserMatch(config, tokenIdentity);
  const ownerOverrideUsed = !smokeUserMatch.matched;
  if (ownerOverrideUsed && !config.allowOwnerSmokeRun) {
    throw new Error(
      `DEV access token user ${maskEmail(tokenIdentity?.email)} does not match intended Smoke User ${smokeUserMatch.expectedSmokeEmailMasked}. Pass --allow-owner-smoke-run to use an approved owner/admin token.`
    );
  }
  if (ownerOverrideUsed) {
    assertOk(
      context.role === "admin" || context.role === "owner",
      "--allow-owner-smoke-run requires an approved owner/admin token."
    );
  }

  return {
    tokenSource: tokenSource.source,
    passwordLoginUsed: Boolean(tokenSource.passwordLoginUsed),
    userId: tokenIdentity?.userId || "",
    maskedEmail: maskEmail(tokenIdentity?.email),
    intendedSmokeEmailMasked: smokeUserMatch.expectedSmokeEmailMasked,
    intendedSmokeUserId: smokeUserMatch.expectedSmokeUserId,
    smokeUserMatched: smokeUserMatch.matched,
    smokeUserEmailMatched: smokeUserMatch.emailMatched,
    smokeUserIdMatched: smokeUserMatch.userIdMatched,
    ownerOverrideAllowed: Boolean(config.allowOwnerSmokeRun),
    ownerOverrideUsed,
    authRunMode: ownerOverrideUsed ? "owner-override" : "smoke-user",
    role: context.role,
    accessStatus: context.accessStatus,
    isAdminConsoleAllowed: Boolean(context.isAdminConsoleAllowed),
    projectRef: config.supabaseProjectRef,
    smokeEmailContainsProdRef: asTrimmedString(process.env.SMOKE_USER_EMAIL).includes(PROD_PROJECT_REF)
  };
}

function rememberFromJobDetail(created, detail) {
  const jobNumber = asTrimmedString(detail?.summary?.jobNumber);
  if (jobNumber) {
    created.jobNumbers.add(jobNumber);
  }
  for (const requirement of detail?.requirements || []) {
    const requirementId = asTrimmedString(requirement.requirementId);
    if (requirementId) {
      created.requirementIds.add(requirementId);
    }
  }
  for (const allocation of detail?.allocations || []) {
    const allocationId = asTrimmedString(allocation.allocationId);
    if (allocationId) {
      created.allocationIds.add(allocationId);
    }
  }
  for (const order of detail?.filmOrders || []) {
    const filmOrderId = asTrimmedString(order.filmOrderId);
    if (filmOrderId) {
      created.filmOrderIds.add(filmOrderId);
    }
  }
}

function rememberFromBoxMutation(created, result) {
  const boxId = asUpperTrimmedString(result?.box?.boxId || result?.boxId);
  if (boxId) {
    created.boxIds.add(boxId);
  }
  const logId = asTrimmedString(result?.logId);
  if (logId) {
    created.auditLogIds.add(logId);
  }
}

function rememberFromAllocationResult(created, result) {
  for (const allocation of result?.allocations || []) {
    const allocationId = asTrimmedString(allocation.allocationId);
    if (allocationId) {
      created.allocationIds.add(allocationId);
    }
  }
}

function rememberFilmOrder(created, order) {
  const filmOrderId = asTrimmedString(order?.filmOrderId);
  if (filmOrderId) {
    created.filmOrderIds.add(filmOrderId);
  }
}

async function tagCreatedRowsWithRunTag(client, orgId, created, runTag) {
  const allocationIds = Array.from(created.allocationIds);
  if (allocationIds.length > 0) {
    await client.query(
      `
        update app.allocations
        set notes = case
          when coalesce(notes, '') ilike '%' || $3::text || '%' then notes
          else trim(concat_ws(' ', nullif(notes, ''), $3::text || ': DEV smoke allocation.'))
        end
        where org_id = $1::uuid
          and allocation_id = any($2::text[])
      `,
      [orgId, allocationIds, runTag]
    );
  }

  const filmOrderIds = Array.from(created.filmOrderIds);
  if (filmOrderIds.length > 0) {
    await client.query(
      `
        update app.film_orders
        set notes = case
          when coalesce(notes, '') ilike '%' || $3::text || '%' then notes
          else trim(concat_ws(' ', nullif(notes, ''), $3::text || ': DEV smoke film order.'))
        end
        where org_id = $1::uuid
          and film_order_id = any($2::text[])
      `,
      [orgId, filmOrderIds, runTag]
    );
  }
}

async function buildEntityTaggingReport(client, orgId, created, runTag) {
  const boxIds = Array.from(created.boxIds);
  const jobNumbers = Array.from(created.jobNumbers);
  const requirementIds = Array.from(created.requirementIds);
  const allocationIds = Array.from(created.allocationIds);
  const filmOrderIds = Array.from(created.filmOrderIds);
  const auditLogIds = Array.from(created.auditLogIds);

  const [boxes, jobs, allocations, filmOrders, filmOrderLinks, auditLogs] = await Promise.all([
    boxIds.length
      ? client.query(
          `
            select box_id, notes, lot_run
            from app.boxes
            where org_id = $1::uuid
              and box_id = any($2::text[])
            order by box_id
          `,
          [orgId, boxIds]
        )
      : { rows: [] },
    jobNumbers.length
      ? client.query(
          `
            select job_number, notes
            from app.jobs
            where org_id = $1::uuid
              and job_number = any($2::text[])
            order by job_number
          `,
          [orgId, jobNumbers]
        )
      : { rows: [] },
    allocationIds.length
      ? client.query(
          `
            select allocation_id, box_id, job_number, requirement_id::text as requirement_id, notes
            from app.allocations
            where org_id = $1::uuid
              and allocation_id = any($2::text[])
            order by allocation_id
          `,
          [orgId, allocationIds]
        )
      : { rows: [] },
    filmOrderIds.length
      ? client.query(
          `
            select film_order_id, job_number, requirement_id::text as requirement_id, notes
            from app.film_orders
            where org_id = $1::uuid
              and film_order_id = any($2::text[])
            order by film_order_id
          `,
          [orgId, filmOrderIds]
        )
      : { rows: [] },
    filmOrderIds.length
      ? client.query(
          `
            select film_order_id, box_id
            from app.film_order_box_links
            where org_id = $1::uuid
              and film_order_id = any($2::text[])
            order by film_order_id, box_id
          `,
          [orgId, filmOrderIds]
        )
      : { rows: [] },
    auditLogIds.length
      ? client.query(
          `
            select log_id, action, box_id, notes
            from app.audit_log
            where org_id = $1::uuid
              and log_id = any($2::text[])
            order by log_id
          `,
          [orgId, auditLogIds]
        )
      : { rows: [] }
  ]);

  const hasTag = (value) => asTrimmedString(value).includes(runTag);
  const boxSet = new Set(boxIds.map(asUpperTrimmedString));
  const jobSet = new Set(jobNumbers.map(asTrimmedString));
  const requirementSet = new Set(requirementIds.map(asTrimmedString));
  const filmOrderSet = new Set(filmOrderIds.map(asTrimmedString));

  const taggedBoxes = boxes.rows.map((entry) => ({
    boxId: asUpperTrimmedString(entry.box_id),
    directTagged: hasTag(entry.notes) || hasTag(entry.lot_run)
  }));
  const taggedJobs = jobs.rows.map((entry) => ({
    jobNumber: asTrimmedString(entry.job_number),
    directTagged: hasTag(entry.notes)
  }));
  const taggedAllocations = allocations.rows.map((entry) => ({
    allocationId: asTrimmedString(entry.allocation_id),
    directTagged: hasTag(entry.notes),
    parentBoxTagged: boxSet.has(asUpperTrimmedString(entry.box_id)),
    parentJobTagged: jobSet.has(asTrimmedString(entry.job_number)),
    parentRequirementTagged: !asTrimmedString(entry.requirement_id) || requirementSet.has(asTrimmedString(entry.requirement_id))
  }));
  const taggedFilmOrders = filmOrders.rows.map((entry) => ({
    filmOrderId: asTrimmedString(entry.film_order_id),
    directTagged: hasTag(entry.notes),
    parentJobTagged: jobSet.has(asTrimmedString(entry.job_number)),
    parentRequirementTagged: !asTrimmedString(entry.requirement_id) || requirementSet.has(asTrimmedString(entry.requirement_id))
  }));
  const taggedFilmOrderLinks = filmOrderLinks.rows.map((entry) => ({
    filmOrderId: asTrimmedString(entry.film_order_id),
    boxId: asUpperTrimmedString(entry.box_id),
    directTagged: false,
    parentFilmOrderTagged: filmOrderSet.has(asTrimmedString(entry.film_order_id)),
    parentBoxTagged: boxSet.has(asUpperTrimmedString(entry.box_id))
  }));
  const taggedAuditLogs = auditLogs.rows.map((entry) => ({
    logId: asTrimmedString(entry.log_id),
    action: asTrimmedString(entry.action),
    boxId: asUpperTrimmedString(entry.box_id),
    directTagged: hasTag(entry.notes),
    parentBoxTagged: boxSet.has(asUpperTrimmedString(entry.box_id)),
    parentOnlyReason: hasTag(entry.notes) ? "" : "Audit note format may be workflow-sensitive; row is tied to a tagged box."
  }));

  const directlyTaggableFailures = [
    ...taggedBoxes.filter((entry) => !entry.directTagged).map((entry) => ({ type: "box", id: entry.boxId })),
    ...taggedJobs.filter((entry) => !entry.directTagged).map((entry) => ({ type: "job", id: entry.jobNumber })),
    ...taggedAllocations.filter((entry) => !entry.directTagged).map((entry) => ({ type: "allocation", id: entry.allocationId })),
    ...taggedFilmOrders.filter((entry) => !entry.directTagged).map((entry) => ({ type: "filmOrder", id: entry.filmOrderId }))
  ];
  const parentTaggingFailures = [
    ...taggedAllocations
      .filter((entry) => !entry.parentBoxTagged || !entry.parentJobTagged || !entry.parentRequirementTagged)
      .map((entry) => ({ type: "allocation", id: entry.allocationId, entry })),
    ...taggedFilmOrders
      .filter((entry) => !entry.parentJobTagged || !entry.parentRequirementTagged)
      .map((entry) => ({ type: "filmOrder", id: entry.filmOrderId, entry })),
    ...taggedFilmOrderLinks
      .filter((entry) => !entry.parentFilmOrderTagged || !entry.parentBoxTagged)
      .map((entry) => ({ type: "filmOrderLink", id: `${entry.filmOrderId}:${entry.boxId}`, entry })),
    ...taggedAuditLogs
      .filter((entry) => !entry.directTagged && !entry.parentBoxTagged)
      .map((entry) => ({ type: "auditLog", id: entry.logId, entry }))
  ];

  return {
    boxes: taggedBoxes,
    jobs: taggedJobs,
    allocations: taggedAllocations,
    filmOrders: taggedFilmOrders,
    filmOrderLinks: taggedFilmOrderLinks,
    auditLogs: taggedAuditLogs,
    directlyTaggableFailures,
    parentTaggingFailures
  };
}

function serializeCreated(created) {
  return Object.fromEntries(
    Object.entries(created).map(([key, value]) => [key, Array.from(value).sort()])
  );
}

function buildTargetRollWeightLbs({ coreWeightLbs, lfWeightLbsPerFt, targetFeet, boxId, context }) {
  const normalizedTargetFeet = integerOrZero(targetFeet);
  if (normalizedTargetFeet <= 0) {
    return 0;
  }

  assertOk(
    coreWeightLbs !== null && coreWeightLbs !== undefined && Number(coreWeightLbs) >= 0,
    `${context} ${boxId} requires coreWeightLbs to calculate a target roll weight.`
  );
  assertOk(
    lfWeightLbsPerFt !== null && lfWeightLbsPerFt !== undefined && Number(lfWeightLbsPerFt) > 0,
    `${context} ${boxId} requires lfWeightLbsPerFt to calculate a target roll weight.`
  );

  const exactRollWeightLbs = Number(coreWeightLbs) + normalizedTargetFeet * Number(lfWeightLbsPerFt);
  const rollWeightLbs = roundUpToDecimals(exactRollWeightLbs, 2);
  const derivedFeetFromSubmittedWeight = Math.floor(
    (rollWeightLbs - Number(coreWeightLbs)) / Number(lfWeightLbsPerFt)
  );
  assertOk(
    derivedFeetFromSubmittedWeight >= normalizedTargetFeet,
    `${context} ${boxId} would derive ${derivedFeetFromSubmittedWeight} LF from ${rollWeightLbs} lbs, below intended ${normalizedTargetFeet} LF.`
  );

  return rollWeightLbs;
}

function physicalFeetFromBox(box, label) {
  const physicalFeet = integerOrZero(
    box?.physicalFeetAvailable ??
    box?.physical_feet_available ??
    box?.feetAvailable ??
    box?.feet_available
  );
  assertOk(physicalFeet > 0, `${label} must have positive app-derived physical LF.`);
  return physicalFeet;
}

function buildReceivedBoxPayload({ boxId, warehouse, manufacturer, filmName, widthIn, initialFeet, runTag, filmOrderId = "" }) {
  const today = todayDateString();
  const normalizedCoreType = normalizeCoreType(CORE_TYPE);
  const coreWeightLbs = deriveCoreWeightLbs(normalizedCoreType, widthIn);
  const initialRollWeightLbs = buildTargetRollWeightLbs({
    coreWeightLbs,
    lfWeightLbsPerFt: LF_WEIGHT_LBS_PER_FT,
    targetFeet: initialFeet,
    boxId,
    context: "received box"
  });
  return {
    boxId,
    warehouse,
    dealer: "Smoke Test Dealer",
    manufacturer,
    filmName,
    widthIn,
    initialFeet,
    feetAvailable: initialFeet,
    orderDate: today,
    receivedDate: today,
    lotRun: runTag,
    initialWeightLbs: initialRollWeightLbs,
    lastRollWeightLbs: initialRollWeightLbs,
    lastWeighedDate: today,
    coreType: normalizedCoreType,
    coreWeightLbs,
    lfWeightLbsPerFt: LF_WEIGHT_LBS_PER_FT,
    notes: `${runTag}: DEV smoke reconciliation received box.`,
    auditNote: `${runTag}: create received smoke box.`,
    ...(filmOrderId ? { filmOrderId } : {})
  };
}

function buildOrderedBoxPayload({ boxId, warehouse, manufacturer, filmName, widthIn, initialFeet, runTag, filmOrderId }) {
  return {
    boxId,
    warehouse,
    dealer: "Smoke Test Dealer",
    manufacturer,
    filmName,
    widthIn,
    initialFeet,
    feetAvailable: 0,
    orderDate: todayDateString(),
    receivedDate: "",
    lotRun: runTag,
    notes: `${runTag}: DEV smoke ordered box linked to film order ${filmOrderId}.`,
    auditNote: `${runTag}: create ordered smoke box linked to film order ${filmOrderId}.`,
    filmOrderId
  };
}

function buildJobPayload({ jobNumber, warehouse, installDate, crewLeader, manufacturer, filmName, widthIn, requiredFeet, runTag }) {
  return {
    jobNumber,
    warehouse,
    installDate,
    crewLeader,
    lifecycleStatus: "ACTIVE",
    notes: `${runTag}: DEV smoke job for box check-in reconciliation.`,
    requirements: [
      {
        manufacturer,
        filmName,
        widthIn,
        requiredFeet
      }
    ],
    caulkRequirements: []
  };
}

function rebuildJobUpdatePayload(detail, overrides = {}) {
  return {
    jobNumber: detail.summary.jobNumber,
    warehouse: overrides.warehouse ?? detail.summary.warehouse,
    installDate: overrides.installDate ?? detail.summary.installDate,
    crewLeader: overrides.crewLeader ?? detail.summary.crewLeader,
    lifecycleStatus: "ACTIVE",
    notes: overrides.notes ?? detail.summary.notes,
    requirements: (detail.requirements || []).map((entry) => ({
      manufacturer: entry.manufacturer,
      filmName: entry.filmName,
      widthIn: entry.widthIn,
      requiredFeet: entry.requiredFeet
    })),
    caulkRequirements: detail.caulkRequirements || []
  };
}

function findSingleRequirement(detail, label) {
  const requirements = detail?.requirements || [];
  assertOk(requirements.length === 1, `${label} expected exactly one film requirement, found ${requirements.length}.`);
  return requirements[0];
}

function activeRequirementAllocations(detail, boxId, requirementId = "") {
  const normalizedBoxId = asUpperTrimmedString(boxId);
  const normalizedRequirementId = asTrimmedString(requirementId);
  return (detail?.allocations || []).filter((entry) => {
    if (asUpperTrimmedString(entry.boxId) !== normalizedBoxId) {
      return false;
    }
    if (asUpperTrimmedString(entry.status) !== "ACTIVE") {
      return false;
    }
    if (normalizedRequirementId && asTrimmedString(entry.requirementId) !== normalizedRequirementId) {
      return false;
    }
    return true;
  });
}

function sumAllocatedFeet(entries) {
  return (Array.isArray(entries) ? entries : []).reduce((total, entry) => total + integerOrZero(entry.allocatedFeet), 0);
}

function sumCoveredFeet(entries) {
  return (Array.isArray(entries) ? entries : []).reduce((total, entry) => total + integerOrZero(entry.coveredFeet), 0);
}

async function getJob(api, created, jobNumber, label = "GET /jobs/get") {
  const detail = (await api.get("/jobs/get", { jobNumber }, label)).data;
  rememberFromJobDetail(created, detail);
  return detail;
}

async function getBox(api, created, boxId, label = "GET /boxes/get") {
  const result = (await api.get("/boxes/get", { boxId }, label)).data;
  rememberFromBoxMutation(created, { box: result });
  return result;
}

async function listFilmOrders(api, label = "GET /film-orders/list") {
  return ((await api.get("/film-orders/list", {}, label)).data?.entries || []);
}

async function createJob(api, created, payload, label) {
  const detail = (await api.post("/jobs/create", payload, label)).data;
  rememberFromJobDetail(created, detail);
  return detail;
}

async function updateJob(api, created, payload, label) {
  const detail = (await api.post("/jobs/update", payload, label)).data;
  rememberFromJobDetail(created, detail);
  return detail;
}

async function addBox(api, created, payload, label) {
  const result = (await api.post("/boxes/add", payload, label)).data;
  rememberFromBoxMutation(created, result);
  return result;
}

async function setBoxStatus(api, created, payload, label) {
  const response = await api.post("/boxes/set-status", payload, label);
  const result = {
    ...(response.data || {}),
    warnings: response.warnings
  };
  rememberFromBoxMutation(created, result);
  return result;
}

async function receiveOrderedBox(api, created, payload, label) {
  const result = (await api.post("/boxes/receive", payload, label)).data;
  rememberFromBoxMutation(created, result);
  return result;
}

async function createFilmOrder(api, created, payload, label) {
  const order = (await api.post("/film-orders/create", payload, label)).data;
  rememberFilmOrder(created, order);
  return order;
}

async function ensureAllocationFromBox(api, created, params) {
  let detail = await getJob(api, created, params.jobNumber, `${params.label}: reload before allocation`);
  const requirement = findSingleRequirement(detail, `${params.label}: requirement`);
  const beforeAllocations = activeRequirementAllocations(detail, params.boxId, requirement.requirementId);
  if (sumAllocatedFeet(beforeAllocations) <= 0) {
    const result = (await api.post(
      "/allocations/apply",
      {
        boxId: params.boxId,
        jobNumber: params.jobNumber,
        installDate: params.installDate,
        crewLeader: params.crewLeader,
        requestedFeet: params.requestedFeet,
        requestedWidthIn: params.widthIn,
        requirementId: requirement.requirementId,
        selectedSuggestionBoxIds: [params.boxId],
        crossWarehouse: false,
        jobWarehouse: params.warehouse
      },
      `${params.label}: POST /allocations/apply`
    )).data;
    rememberFromAllocationResult(created, result);
    detail = await getJob(api, created, params.jobNumber, `${params.label}: reload after allocation`);
  }
  return detail;
}

function chooseDynamicCheckinPhysicalFeet(activeOtherAllocations, options = {}) {
  const allocations = (Array.isArray(activeOtherAllocations) ? activeOtherAllocations : [])
    .map((entry) => ({
      allocationId: asTrimmedString(entry.allocation_id || entry.allocationId),
      allocatedFeet: integerOrZero(entry.allocated_feet ?? entry.allocatedFeet),
      createdAt: asTrimmedString(entry.created_at || entry.createdAt)
    }))
    .filter((entry) => entry.allocatedFeet > 0)
    .sort((left, right) => {
      if (left.createdAt !== right.createdAt) {
        return left.createdAt < right.createdAt ? -1 : 1;
      }
      return left.allocationId < right.allocationId ? -1 : left.allocationId > right.allocationId ? 1 : 0;
    });
  const reserved = allocations.reduce((total, entry) => total + entry.allocatedFeet, 0);
  if (reserved <= 1) {
    return 0;
  }

  if (options.forceFullCancellation && allocations.length > 1) {
    const newestAllocation = allocations[allocations.length - 1];
    const earlierReservedFeet = reserved - newestAllocation.allocatedFeet;
    if (earlierReservedFeet > 1) {
      return Math.max(0, earlierReservedFeet - Math.min(5, earlierReservedFeet - 1));
    }
    return 0;
  }

  const candidate = Math.floor(reserved * CHECKIN_REMAINING_RATIO);
  return Math.max(0, Math.min(candidate, reserved - 1));
}

function buildCheckinPayload(persistedBox, targetCurrentFeetOnRoll, runTag) {
  const boxId = asUpperTrimmedString(persistedBox?.boxId ?? persistedBox?.box_id);
  const coreWeightLbs = numericOrNull(persistedBox?.coreWeightLbs ?? persistedBox?.core_weight_lbs);
  const lfWeightLbsPerFt = numericOrNull(persistedBox?.lfWeightLbsPerFt ?? persistedBox?.lf_weight_lbs_per_ft);
  const coreType = asTrimmedString(persistedBox?.coreType ?? persistedBox?.core_type) || CORE_TYPE;

  assertOk(boxId, "Check-in payload requires a persisted box id.");
  assertOk(coreWeightLbs !== null && coreWeightLbs >= 0, `Check-in payload requires persisted coreWeightLbs for ${boxId}.`);
  assertOk(
    lfWeightLbsPerFt !== null && lfWeightLbsPerFt > 0,
    `Check-in payload requires persisted lfWeightLbsPerFt for ${boxId}.`
  );

  const lastRollWeightLbs = buildTargetRollWeightLbs({
    coreWeightLbs,
    lfWeightLbsPerFt,
    targetFeet: targetCurrentFeetOnRoll,
    boxId,
    context: "check-in payload"
  });

  return {
    boxId,
    status: "IN_STOCK",
    lastRollWeightLbs,
    currentFeetOnRoll: targetCurrentFeetOnRoll,
    coreType,
    auditNote: `${runTag}: check in with dynamic ${targetCurrentFeetOnRoll} LF remaining.`
  };
}

async function fetchBoxInvariant(client, orgId, boxId) {
  const result = await client.query(
    `
      select
        b.box_id,
        b.status,
        b.feet_available,
        app_api.box_physical_feet_available(b) as physical_lf,
        app_api.box_allocatable_now_feet(b) as allocatable_now_lf,
        coalesce(active_allocations.active_reserved_lf, 0)::integer as active_reserved_lf,
        coalesce(active_allocations.active_covered_lf, 0)::integer as active_covered_lf
      from app.boxes b
      left join lateral (
        select
          coalesce(sum(a.allocated_feet), 0)::integer as active_reserved_lf,
          coalesce(sum(a.covered_feet), 0)::integer as active_covered_lf
        from app.allocations a
        where a.org_id = b.org_id
          and a.box_id = b.box_id
          and a.status = 'ACTIVE'
          and app_api.film_allocation_reserves_capacity(a, b.status::text)
      ) active_allocations on true
      where b.org_id = $1::uuid
        and upper(b.box_id) = upper($2::text)
    `,
    [orgId, boxId]
  );
  return result.rows[0] || null;
}

async function fetchActiveAllocationsForBox(client, orgId, boxId) {
  const result = await client.query(
    `
      select
        allocation_id,
        box_id,
        job_number,
        requirement_id::text as requirement_id,
        film_order_id,
        status,
        allocation_kind,
        allocation_source,
        allocated_feet,
        covered_feet,
        created_at
      from app.allocations
      where org_id = $1::uuid
        and upper(box_id) = upper($2::text)
        and status = 'ACTIVE'
      order by created_at asc, allocation_id asc
    `,
    [orgId, boxId]
  );
  return result.rows;
}

async function fetchCreatedUnexpectedStates(client, orgId, created) {
  const boxIds = Array.from(created.boxIds);
  const jobNumbers = Array.from(created.jobNumbers);
  const allocationIds = Array.from(created.allocationIds);
  const unexpected = [];

  if (boxIds.length > 0) {
    const overReserved = await client.query(
      `
        select *
        from (
          select
            b.box_id,
            b.status,
            app_api.box_physical_feet_available(b) as physical_lf,
            coalesce(active_allocations.active_reserved_lf, 0)::integer as active_reserved_lf
          from app.boxes b
          left join lateral (
            select coalesce(sum(a.allocated_feet), 0)::integer as active_reserved_lf
            from app.allocations a
            where a.org_id = b.org_id
              and a.box_id = b.box_id
              and a.status = 'ACTIVE'
              and app_api.film_allocation_reserves_capacity(a, b.status::text)
          ) active_allocations on true
          where b.org_id = $1::uuid
            and b.box_id = any($2::text[])
        ) candidate
        where active_reserved_lf > physical_lf
      `,
      [orgId, boxIds]
    );
    for (const row of overReserved.rows) {
      unexpected.push({ type: "BOX_OVER_RESERVED", ...row });
    }

    const negativeBoxes = await client.query(
      `
        select
          box_id,
          initial_feet,
          feet_available,
          last_roll_weight_lbs,
          core_weight_lbs,
          lf_weight_lbs_per_ft
        from app.boxes
        where org_id = $1::uuid
          and box_id = any($2::text[])
          and (
            coalesce(initial_feet, 0) < 0
            or coalesce(feet_available, 0) < 0
            or coalesce(last_roll_weight_lbs, 0) < 0
            or coalesce(core_weight_lbs, 0) < 0
            or coalesce(lf_weight_lbs_per_ft, 0) < 0
          )
      `,
      [orgId, boxIds]
    );
    for (const row of negativeBoxes.rows) {
      unexpected.push({ type: "NEGATIVE_BOX_LF", ...row });
    }
  }

  if (allocationIds.length > 0) {
    const invalidAllocations = await client.query(
      `
        select allocation_id, box_id, job_number, allocated_feet, covered_feet, status
        from app.allocations
        where org_id = $1::uuid
          and allocation_id = any($2::text[])
          and (allocated_feet < 0 or covered_feet < 0)
      `,
      [orgId, allocationIds]
    );
    for (const row of invalidAllocations.rows) {
      unexpected.push({ type: "NEGATIVE_ALLOCATION", ...row });
    }

    const orphanAllocations = await client.query(
      `
        select
          allocation_id,
          box_id,
          job_number,
          requirement_id::text as requirement_id,
          film_order_id,
          status
        from app.allocations
        where org_id = $1::uuid
          and allocation_id = any($2::text[])
          and (
            not (box_id = any($3::text[]))
            or not (job_number = any($4::text[]))
            or (
              requirement_id is not null
              and not (requirement_id::text = any($5::text[]))
            )
          )
      `,
      [orgId, allocationIds, boxIds, jobNumbers, Array.from(created.requirementIds)]
    );
    for (const row of orphanAllocations.rows) {
      unexpected.push({ type: "ORPHAN_CREATED_ALLOCATION", ...row });
    }
  }

  if (created.filmOrderIds.size > 0) {
    const filmOrderIds = Array.from(created.filmOrderIds);
    const invalidFilmOrderFeet = await client.query(
      `
        select
          film_order_id,
          job_number,
          requirement_id::text as requirement_id,
          requested_feet,
          covered_feet,
          ordered_feet,
          remaining_to_order_feet,
          status
        from app.film_orders
        where org_id = $1::uuid
          and film_order_id = any($2::text[])
          and (
            coalesce(requested_feet, 0) < 0
            or coalesce(covered_feet, 0) < 0
            or coalesce(ordered_feet, 0) < 0
            or coalesce(remaining_to_order_feet, 0) < 0
          )
      `,
      [orgId, filmOrderIds]
    );
    for (const row of invalidFilmOrderFeet.rows) {
      unexpected.push({ type: "NEGATIVE_FILM_ORDER_LF", ...row });
    }

    const orphanFilmOrders = await client.query(
      `
        select
          film_order_id,
          job_number,
          requirement_id::text as requirement_id,
          status
        from app.film_orders
        where org_id = $1::uuid
          and film_order_id = any($2::text[])
          and (
            not (job_number = any($3::text[]))
            or (
              requirement_id is not null
              and not (requirement_id::text = any($4::text[]))
            )
          )
      `,
      [orgId, filmOrderIds, jobNumbers, Array.from(created.requirementIds)]
    );
    for (const row of orphanFilmOrders.rows) {
      unexpected.push({ type: "ORPHAN_CREATED_FILM_ORDER", ...row });
    }

    const orphanFilmOrderLinks = await client.query(
      `
        select film_order_id, box_id
        from app.film_order_box_links
        where org_id = $1::uuid
          and film_order_id = any($2::text[])
          and (
            not (film_order_id = any($2::text[]))
            or not (box_id = any($3::text[]))
          )
      `,
      [orgId, filmOrderIds, boxIds]
    );
    for (const row of orphanFilmOrderLinks.rows) {
      unexpected.push({ type: "ORPHAN_CREATED_FILM_ORDER_LINK", ...row });
    }
  }

  if (jobNumbers.length > 0) {
    const unknownStatusOrders = await client.query(
      `
        select film_order_id, job_number, requirement_id::text as requirement_id, status
        from app.film_orders
        where org_id = $1::uuid
          and job_number = any($2::text[])
          and coalesce(status::text, '') not in ('FILM_ORDER', 'FILM_ON_THE_WAY', 'FULFILLED', 'CANCELLED')
      `,
      [orgId, jobNumbers]
    );
    for (const row of unknownStatusOrders.rows) {
      unexpected.push({ type: "UNKNOWN_FILM_ORDER_STATUS", ...row });
    }
  }

  return unexpected;
}

function pushInvariant(invariants, name, condition, details = {}) {
  invariants.push({
    name,
    ok: Boolean(condition),
    details
  });
  assertOk(condition, `${name} failed: ${JSON.stringify(details)}`);
}

async function assertBoxReservationInvariant(client, orgId, invariants, boxId, label) {
  const invariant = await fetchBoxInvariant(client, orgId, boxId);
  pushInvariant(
    invariants,
    `${label}: active reserved LF does not exceed physical LF`,
    invariant && integerOrZero(invariant.active_reserved_lf) <= integerOrZero(invariant.physical_lf),
    invariant || { boxId }
  );
  pushInvariant(
    invariants,
    `${label}: allocatable LF matches physical LF minus active reservations`,
    invariant &&
      integerOrZero(invariant.allocatable_now_lf) ===
        Math.max(integerOrZero(invariant.physical_lf) - integerOrZero(invariant.active_reserved_lf), 0),
    invariant || { boxId }
  );
  pushInvariant(
    invariants,
    `${label}: stored feet_available is non-negative`,
    invariant && integerOrZero(invariant.feet_available) >= 0,
    invariant || { boxId }
  );
  return invariant;
}

async function runPartialAllocationPair({ api, client, config, created, invariants, scenario, makeTargetOrderOnWay }) {
  const today = todayDateString();
  const checkoutInstallDate = addDays(today, scenario.installOffsetDays);
  const targetInstallDate = addDays(today, scenario.installOffsetDays + 1);
  const earlierTargetInstallDate = addDays(today, scenario.installOffsetDays - 2);
  const primaryFilm = `Smoke Recon ${scenario.name} ${config.shortTag}`;
  const manufacturer = "Smoke Test Film";
  const widthIn = 60;
  const checkoutRequiredFeet = 75;
  const targetRequiredFeet = 50;
  const cancellationRequiredFeet = scenario.includeCancellationReservation ? 15 : 0;
  const targetRequestedFeet = scenario.includeCancellationReservation ? 25 : targetRequiredFeet;
  const initialFeet = scenario.includeCancellationReservation
    ? checkoutRequiredFeet + targetRequestedFeet + cancellationRequiredFeet + 15
    : 100;

  await addBox(
    api,
    created,
    buildReceivedBoxPayload({
      boxId: scenario.boxId,
      warehouse: config.warehouse,
      manufacturer,
      filmName: primaryFilm,
      widthIn,
      initialFeet,
      runTag: config.runTag
    }),
    `${scenario.name}: create primary received box`
  );
  const persistedPrimaryBox = await getBox(
    api,
    created,
    scenario.boxId,
    `${scenario.name}: reload primary box after create`
  );
  const primaryPhysicalFeet = physicalFeetFromBox(persistedPrimaryBox, `${scenario.name}: primary box`);
  const expectedTargetAllocatedBefore = Math.min(
    scenario.includeCancellationReservation ? targetRequestedFeet : targetRequiredFeet,
    Math.max(0, primaryPhysicalFeet - checkoutRequiredFeet)
  );
  if (scenario.includeCancellationReservation) {
    pushInvariant(
      invariants,
      `${scenario.name}: primary box has capacity for lower-priority reservation setup`,
      primaryPhysicalFeet >= checkoutRequiredFeet + expectedTargetAllocatedBefore + 1,
      {
        primaryPhysicalFeet,
        checkoutRequiredFeet,
        expectedTargetAllocatedBefore,
        requiredForPositiveLowerPriorityReservation: checkoutRequiredFeet + expectedTargetAllocatedBefore + 1
      }
    );
  }

  let checkoutJob = await createJob(
    api,
    created,
    buildJobPayload({
      jobNumber: scenario.checkoutJobNumber,
      warehouse: config.warehouse,
      installDate: checkoutInstallDate,
      crewLeader: `${scenario.name} Crew A`,
      manufacturer,
      filmName: primaryFilm,
      widthIn,
      requiredFeet: checkoutRequiredFeet,
      runTag: config.runTag
    }),
    `${scenario.name}: create checkout job`
  );
  checkoutJob = await ensureAllocationFromBox(api, created, {
    label: `${scenario.name}: checkout job`,
    boxId: scenario.boxId,
    jobNumber: scenario.checkoutJobNumber,
    installDate: checkoutInstallDate,
    crewLeader: `${scenario.name} Crew A`,
    requestedFeet: checkoutRequiredFeet,
    widthIn,
    warehouse: config.warehouse
  });
  const checkoutRequirement = findSingleRequirement(checkoutJob, `${scenario.name}: checkout job`);
  const checkoutAllocations = activeRequirementAllocations(checkoutJob, scenario.boxId, checkoutRequirement.requirementId);
  pushInvariant(
    invariants,
    `${scenario.name}: first reservation receives full LF`,
    sumAllocatedFeet(checkoutAllocations) === checkoutRequiredFeet && checkoutJob.summary.status === "READY",
    {
      jobNumber: scenario.checkoutJobNumber,
      allocatedFeet: sumAllocatedFeet(checkoutAllocations),
      status: checkoutJob.summary.status
    }
  );

  await new Promise((resolve) => setTimeout(resolve, 25));

  let targetJob = await createJob(
    api,
    created,
    buildJobPayload({
      jobNumber: scenario.targetJobNumber,
      warehouse: config.warehouse,
      installDate: scenario.includeCancellationReservation ? "" : targetInstallDate,
      crewLeader: `${scenario.name} Crew B`,
      manufacturer,
      filmName: primaryFilm,
      widthIn,
      requiredFeet: targetRequiredFeet,
      runTag: config.runTag
    }),
    `${scenario.name}: create target job`
  );
  targetJob = await ensureAllocationFromBox(api, created, {
    label: `${scenario.name}: target job`,
    boxId: scenario.boxId,
    jobNumber: scenario.targetJobNumber,
    installDate: targetInstallDate,
    crewLeader: `${scenario.name} Crew B`,
    requestedFeet: targetRequestedFeet,
    widthIn,
    warehouse: config.warehouse
  });

  const targetRequirement = findSingleRequirement(targetJob, `${scenario.name}: target job`);
  const targetAllocationsBefore = activeRequirementAllocations(targetJob, scenario.boxId, targetRequirement.requirementId);
  const targetAllocatedBefore = sumAllocatedFeet(targetAllocationsBefore);
  const targetMissingBefore = integerOrZero(targetRequirement.remainingFeet);
  pushInvariant(
    invariants,
    `${scenario.name}: second reservation receives only remaining LF`,
    targetAllocatedBefore === expectedTargetAllocatedBefore &&
      targetMissingBefore === targetRequiredFeet - targetAllocatedBefore &&
      targetJob.summary.status === "FILM_ORDER",
    {
      jobNumber: scenario.targetJobNumber,
      primaryPhysicalFeet,
      allocatedFeet: targetAllocatedBefore,
      expectedAllocatedFeet: expectedTargetAllocatedBefore,
      missingFeet: targetMissingBefore,
      status: targetJob.summary.status
    }
  );

  let cancellationJob = null;
  let cancellationRequirement = null;
  let cancellationAllocatedBefore = 0;
  if (scenario.includeCancellationReservation) {
    const beforeCancellationInvariant = await fetchBoxInvariant(client, config.orgId, scenario.boxId);
    pushInvariant(
      invariants,
      `${scenario.name}: allocatable LF remains before lower-priority reservation`,
      integerOrZero(beforeCancellationInvariant?.allocatable_now_lf) > 0,
      beforeCancellationInvariant || { boxId: scenario.boxId }
    );

    await new Promise((resolve) => setTimeout(resolve, 25));
    cancellationJob = await createJob(
      api,
      created,
      buildJobPayload({
        jobNumber: scenario.cancellationJobNumber,
        warehouse: config.warehouse,
        installDate: addDays(today, scenario.installOffsetDays + 2),
        crewLeader: `${scenario.name} Crew C`,
        manufacturer,
        filmName: primaryFilm,
        widthIn,
        requiredFeet: cancellationRequiredFeet,
        runTag: config.runTag
      }),
      `${scenario.name}: create cancellation-priority job`
    );
    cancellationJob = await ensureAllocationFromBox(api, created, {
      label: `${scenario.name}: cancellation-priority job`,
      boxId: scenario.boxId,
      jobNumber: scenario.cancellationJobNumber,
      installDate: addDays(today, scenario.installOffsetDays + 2),
      crewLeader: `${scenario.name} Crew C`,
      requestedFeet: cancellationRequiredFeet,
      widthIn,
      warehouse: config.warehouse
    });
    cancellationRequirement = findSingleRequirement(cancellationJob, `${scenario.name}: cancellation-priority job`);
    cancellationAllocatedBefore = sumAllocatedFeet(
      activeRequirementAllocations(cancellationJob, scenario.boxId, cancellationRequirement.requirementId)
    );
    pushInvariant(
      invariants,
      `${scenario.name}: lower-priority reservation is established before check-in`,
      cancellationAllocatedBefore > 0,
      {
        jobNumber: scenario.cancellationJobNumber,
        allocatedFeet: cancellationAllocatedBefore,
        requiredFeet: cancellationRequiredFeet,
        status: cancellationJob.summary.status
      }
    );
  }

  const checkoutAllocationsBeforeScheduleChange = activeRequirementAllocations(
    await getJob(api, created, scenario.checkoutJobNumber, `${scenario.name}: reload checkout before install-date check`),
    scenario.boxId,
    checkoutRequirement.requirementId
  );
  const targetAllocationsBeforeScheduleChange = targetAllocationsBefore;
  targetJob = await updateJob(
    api,
    created,
    rebuildJobUpdatePayload(targetJob, {
      installDate: earlierTargetInstallDate,
      notes: `${config.runTag}: target job install date moved earlier; reservation order must not reshuffle.`
    }),
    `${scenario.name}: move target install date earlier`
  );
  const checkoutAfterScheduleChange = await getJob(
    api,
    created,
    scenario.checkoutJobNumber,
    `${scenario.name}: reload checkout after install-date check`
  );
  const targetAfterScheduleChange = await getJob(
    api,
    created,
    scenario.targetJobNumber,
    `${scenario.name}: reload target after install-date check`
  );
  pushInvariant(
    invariants,
    `${scenario.name}: install date does not steal existing reservations`,
    sumAllocatedFeet(activeRequirementAllocations(checkoutAfterScheduleChange, scenario.boxId, checkoutRequirement.requirementId)) ===
      sumAllocatedFeet(checkoutAllocationsBeforeScheduleChange) &&
      sumAllocatedFeet(activeRequirementAllocations(targetAfterScheduleChange, scenario.boxId, targetRequirement.requirementId)) ===
        sumAllocatedFeet(targetAllocationsBeforeScheduleChange),
    {
      checkoutAllocatedBefore: sumAllocatedFeet(checkoutAllocationsBeforeScheduleChange),
      checkoutAllocatedAfter: sumAllocatedFeet(activeRequirementAllocations(checkoutAfterScheduleChange, scenario.boxId, checkoutRequirement.requirementId)),
      targetAllocatedBefore: sumAllocatedFeet(targetAllocationsBeforeScheduleChange),
      targetAllocatedAfter: sumAllocatedFeet(activeRequirementAllocations(targetAfterScheduleChange, scenario.boxId, targetRequirement.requirementId))
    }
  );

  const filmOrderBefore = await createFilmOrder(
    api,
    created,
    {
      jobNumber: scenario.targetJobNumber,
      requirementId: targetRequirement.requirementId,
      warehouse: config.warehouse,
      manufacturer,
      filmName: primaryFilm,
      widthIn,
      requestedFeet: targetMissingBefore
    },
    `${scenario.name}: create manual film order`
  );

  let onWayBoxId = "";
  let targetAfterOnWay = null;
  if (makeTargetOrderOnWay) {
    onWayBoxId = `${scenario.boxId}-OW`;
    await addBox(
      api,
      created,
      buildOrderedBoxPayload({
        boxId: onWayBoxId,
        warehouse: config.warehouse,
        manufacturer,
        filmName: primaryFilm,
        widthIn,
        initialFeet: targetMissingBefore,
        runTag: config.runTag,
        filmOrderId: filmOrderBefore.filmOrderId
      }),
      `${scenario.name}: link ordered box to manual film order`
    );
    targetAfterOnWay = await getJob(
      api,
      created,
      scenario.targetJobNumber,
      `${scenario.name}: reload target after on-way order link`
    );
  }

  const watchedFilmOrderJobNumbers = [
    scenario.targetJobNumber,
    scenario.includeCancellationReservation ? scenario.cancellationJobNumber : ""
  ].filter(Boolean);
  const filmOrdersBeforeCheckin = (await listFilmOrders(api, `${scenario.name}: list film orders before check-in`))
    .filter((entry) => watchedFilmOrderJobNumbers.includes(asTrimmedString(entry.jobNumber)));
  const orderBeforeCheckin = filmOrdersBeforeCheckin.find((entry) => entry.filmOrderId === filmOrderBefore.filmOrderId);
  if (makeTargetOrderOnWay) {
    pushInvariant(
      invariants,
      `${scenario.name}: fully covered on-the-way shortage derives ORDERED before check-in`,
      targetAfterOnWay?.summary?.status === "ORDERED" &&
        orderBeforeCheckin?.status === "FILM_ON_THE_WAY" &&
        integerOrZero(orderBeforeCheckin.orderedFeet) >= targetMissingBefore,
      {
        jobNumber: scenario.targetJobNumber,
        jobStatus: targetAfterOnWay?.summary?.status,
        orderStatus: orderBeforeCheckin?.status,
        targetMissingBefore,
        orderedFeet: orderBeforeCheckin?.orderedFeet
      }
    );
  }

  await setBoxStatus(
    api,
    created,
    {
      boxId: scenario.boxId,
      status: "CHECKED_OUT",
      auditNote: `Checked out for job ${scenario.checkoutJobNumber}`
    },
    `${scenario.name}: check out primary box`
  );
  const persistedBoxBeforeCheckin = await getBox(
    api,
    created,
    scenario.boxId,
    `${scenario.name}: reload primary box before check-in`
  );

  const activeOtherAllocationsBeforeCheckin = (await fetchActiveAllocationsForBox(client, config.orgId, scenario.boxId))
    .filter((entry) => asTrimmedString(entry.job_number) !== scenario.checkoutJobNumber);
  const activeOtherReservedBeforeCheckin = activeOtherAllocationsBeforeCheckin.reduce(
    (total, entry) => total + integerOrZero(entry.allocated_feet),
    0
  );
  const dynamicPhysicalFeetAfter = chooseDynamicCheckinPhysicalFeet(activeOtherAllocationsBeforeCheckin, {
    forceFullCancellation: Boolean(scenario.includeCancellationReservation)
  });
  pushInvariant(
    invariants,
    `${scenario.name}: dynamic check-in LF is lower than other active reservations`,
    dynamicPhysicalFeetAfter < activeOtherReservedBeforeCheckin,
    { dynamicPhysicalFeetAfter, activeOtherReservedBeforeCheckin }
  );

  const checkinResult = await setBoxStatus(
    api,
    created,
    buildCheckinPayload(persistedBoxBeforeCheckin, dynamicPhysicalFeetAfter, config.runTag),
    `${scenario.name}: check in primary box with dynamic LF`
  );
  const checkinWarnings = checkinResult?.warnings || [];

  await assertBoxReservationInvariant(client, config.orgId, invariants, scenario.boxId, `${scenario.name}: post check-in`);

  const targetAfterCheckin = await getJob(
    api,
    created,
    scenario.targetJobNumber,
    `${scenario.name}: reload target after reconciliation`
  );
  const targetRequirementAfter = findSingleRequirement(targetAfterCheckin, `${scenario.name}: target after check-in`);
  const targetAllocationsAfter = activeRequirementAllocations(
    targetAfterCheckin,
    scenario.boxId,
    targetRequirementAfter.requirementId
  );
  const targetAllocatedAfter = sumAllocatedFeet(targetAllocationsAfter);
  const targetCoveredAfter = sumCoveredFeet(targetAllocationsAfter);
  const targetMissingAfter = integerOrZero(targetRequirementAfter.remainingFeet);
  const expectedTargetAllocatedAfter = Math.min(targetAllocatedBefore, dynamicPhysicalFeetAfter);
  pushInvariant(
    invariants,
    `${scenario.name}: downstream allocation reduced to physical reality`,
    targetAllocatedAfter === expectedTargetAllocatedAfter &&
      targetCoveredAfter === expectedTargetAllocatedAfter &&
      targetMissingAfter === targetRequiredFeet - expectedTargetAllocatedAfter,
    {
      targetAllocatedBefore,
      targetAllocatedAfter,
      targetCoveredAfter,
      targetMissingAfter,
      dynamicPhysicalFeetAfter,
      expectedTargetAllocatedAfter
    }
  );

  let cancellationAfter = null;
  if (scenario.includeCancellationReservation) {
    cancellationAfter = await getJob(
      api,
      created,
      scenario.cancellationJobNumber,
      `${scenario.name}: reload cancellation-priority job after reconciliation`
    );
    const cancellationRequirementAfter = findSingleRequirement(
      cancellationAfter,
      `${scenario.name}: cancellation-priority after check-in`
    );
    const cancellationAllocatedAfter = sumAllocatedFeet(
      activeRequirementAllocations(cancellationAfter, scenario.boxId, cancellationRequirementAfter.requirementId)
    );
    pushInvariant(
      invariants,
      `${scenario.name}: lower-priority reservation is fully cancelled`,
      cancellationAllocatedBefore > 0 &&
        cancellationAllocatedAfter === 0 &&
        integerOrZero(cancellationRequirementAfter.remainingFeet) === cancellationRequiredFeet,
      {
        jobNumber: scenario.cancellationJobNumber,
        allocatedBefore: cancellationAllocatedBefore,
        allocatedAfter: cancellationAllocatedAfter,
        remainingFeet: cancellationRequirementAfter.remainingFeet,
        status: cancellationAfter.summary.status
      }
    );
  }

  const filmOrdersAfterCheckin = (await listFilmOrders(api, `${scenario.name}: list film orders after check-in`))
    .filter((entry) => watchedFilmOrderJobNumbers.includes(asTrimmedString(entry.jobNumber)));
  const orderAfterCheckin = filmOrdersAfterCheckin.find((entry) => entry.filmOrderId === filmOrderBefore.filmOrderId);
  pushInvariant(
    invariants,
    `${scenario.name}: reconciliation does not auto-create film orders`,
    filmOrdersAfterCheckin.length === filmOrdersBeforeCheckin.length,
    {
      beforeCount: filmOrdersBeforeCheckin.length,
      afterCount: filmOrdersAfterCheckin.length
    }
  );

  if (makeTargetOrderOnWay) {
    pushInvariant(
      invariants,
      `${scenario.name}: FILM_ON_THE_WAY order is not silently increased`,
      orderAfterCheckin?.status === "FILM_ON_THE_WAY" &&
        integerOrZero(orderAfterCheckin.requestedFeet) === integerOrZero(orderBeforeCheckin?.requestedFeet) &&
        integerOrZero(orderAfterCheckin.orderedFeet) === integerOrZero(orderBeforeCheckin?.orderedFeet) &&
        targetAfterCheckin.summary.status === "FILM_ORDER",
      {
        orderBefore: {
          status: orderBeforeCheckin?.status,
          requestedFeet: orderBeforeCheckin?.requestedFeet,
          orderedFeet: orderBeforeCheckin?.orderedFeet
        },
        orderAfter: {
          status: orderAfterCheckin?.status,
          requestedFeet: orderAfterCheckin?.requestedFeet,
          orderedFeet: orderAfterCheckin?.orderedFeet
        },
        resultingJobStatus: targetAfterCheckin.summary.status
      }
    );
  } else {
    pushInvariant(
      invariants,
      `${scenario.name}: editable FILM_ORDER updates to new shortage`,
      orderAfterCheckin?.status === "FILM_ORDER" &&
        integerOrZero(orderAfterCheckin.requestedFeet) === targetMissingAfter &&
        targetAfterCheckin.summary.status === "FILM_ORDER",
      {
        orderBefore: {
          status: orderBeforeCheckin?.status,
          requestedFeet: orderBeforeCheckin?.requestedFeet
        },
        orderAfter: {
          status: orderAfterCheckin?.status,
          requestedFeet: orderAfterCheckin?.requestedFeet
        },
        targetMissingAfter,
        resultingJobStatus: targetAfterCheckin.summary.status
      }
    );
  }

  return {
    name: scenario.name,
    boxId: scenario.boxId,
    checkoutJobNumber: scenario.checkoutJobNumber,
    targetJobNumber: scenario.targetJobNumber,
    targetRequirementId: targetRequirement.requirementId,
    filmOrderId: filmOrderBefore.filmOrderId,
    onWayBoxId,
    before: {
      targetAllocatedFeet: targetAllocatedBefore,
      targetMissingFeet: targetMissingBefore,
      targetStatus: targetJob.summary.status,
      filmOrderStatus: orderBeforeCheckin?.status || ""
    },
    reconciliation: {
      activeOtherReservedBeforeCheckin,
      dynamicPhysicalFeetAfter,
      targetAllocatedAfter,
      targetMissingAfter,
      cancellationJobNumber: scenario.includeCancellationReservation ? scenario.cancellationJobNumber : "",
      cancellationAllocatedBefore,
      cancellationStatusAfter: cancellationAfter?.summary?.status || "",
      targetStatusAfter: targetAfterCheckin.summary.status,
      warnings: checkinWarnings
    },
    filmOrderAfter: orderAfterCheckin
      ? {
          filmOrderId: orderAfterCheckin.filmOrderId,
          status: orderAfterCheckin.status,
          requestedFeet: orderAfterCheckin.requestedFeet,
          orderedFeet: orderAfterCheckin.orderedFeet,
          remainingToOrderFeet: orderAfterCheckin.remainingToOrderFeet
        }
      : null
  };
}

async function runFullCancellationScenario({ api, client, config, created, invariants, scenario }) {
  const today = todayDateString();
  const manufacturer = "Smoke Test Film";
  const filmName = `Smoke Recon ${scenario.name} ${config.shortTag}`;
  const widthIn = 60;
  const checkoutRequiredFeet = 75;
  const preservedRequiredFeet = 20;
  const preferredCancellationFeet = 15;
  const initialFeet = checkoutRequiredFeet + preservedRequiredFeet + preferredCancellationFeet + 5;

  await addBox(
    api,
    created,
    buildReceivedBoxPayload({
      boxId: scenario.boxId,
      warehouse: config.warehouse,
      manufacturer,
      filmName,
      widthIn,
      initialFeet,
      runTag: config.runTag
    }),
    `${scenario.name}: create primary received box`
  );
  const persistedPrimaryBox = await getBox(
    api,
    created,
    scenario.boxId,
    `${scenario.name}: reload primary box after create`
  );
  const primaryPhysicalFeet = physicalFeetFromBox(persistedPrimaryBox, `${scenario.name}: primary box`);
  pushInvariant(
    invariants,
    `${scenario.name}: primary box has room for preserved and lower-priority reservations`,
    primaryPhysicalFeet >= checkoutRequiredFeet + preservedRequiredFeet + 1,
    {
      primaryPhysicalFeet,
      checkoutRequiredFeet,
      preservedRequiredFeet
    }
  );

  let checkoutJob = await createJob(
    api,
    created,
    buildJobPayload({
      jobNumber: scenario.checkoutJobNumber,
      warehouse: config.warehouse,
      installDate: addDays(today, scenario.installOffsetDays),
      crewLeader: `${scenario.name} Crew A`,
      manufacturer,
      filmName,
      widthIn,
      requiredFeet: checkoutRequiredFeet,
      runTag: config.runTag
    }),
    `${scenario.name}: create checkout job`
  );
  checkoutJob = await ensureAllocationFromBox(api, created, {
    label: `${scenario.name}: checkout job`,
    boxId: scenario.boxId,
    jobNumber: scenario.checkoutJobNumber,
    installDate: addDays(today, scenario.installOffsetDays),
    crewLeader: `${scenario.name} Crew A`,
    requestedFeet: checkoutRequiredFeet,
    widthIn,
    warehouse: config.warehouse
  });
  const checkoutRequirement = findSingleRequirement(checkoutJob, `${scenario.name}: checkout job`);
  const checkoutAllocatedBefore = sumAllocatedFeet(
    activeRequirementAllocations(checkoutJob, scenario.boxId, checkoutRequirement.requirementId)
  );
  pushInvariant(
    invariants,
    `${scenario.name}: checkout reservation receives full LF`,
    checkoutAllocatedBefore === checkoutRequiredFeet && checkoutJob.summary.status === "READY",
    {
      jobNumber: scenario.checkoutJobNumber,
      allocatedFeet: checkoutAllocatedBefore,
      status: checkoutJob.summary.status
    }
  );

  await new Promise((resolve) => setTimeout(resolve, 25));
  let preservedJob = await createJob(
    api,
    created,
    buildJobPayload({
      jobNumber: scenario.preservedJobNumber,
      warehouse: config.warehouse,
      installDate: addDays(today, scenario.installOffsetDays + 1),
      crewLeader: `${scenario.name} Crew B`,
      manufacturer,
      filmName,
      widthIn,
      requiredFeet: preservedRequiredFeet,
      runTag: config.runTag
    }),
    `${scenario.name}: create preserved-priority job`
  );
  preservedJob = await ensureAllocationFromBox(api, created, {
    label: `${scenario.name}: preserved-priority job`,
    boxId: scenario.boxId,
    jobNumber: scenario.preservedJobNumber,
    installDate: addDays(today, scenario.installOffsetDays + 1),
    crewLeader: `${scenario.name} Crew B`,
    requestedFeet: preservedRequiredFeet,
    widthIn,
    warehouse: config.warehouse
  });
  const preservedRequirement = findSingleRequirement(preservedJob, `${scenario.name}: preserved-priority job`);
  const preservedAllocatedBefore = sumAllocatedFeet(
    activeRequirementAllocations(preservedJob, scenario.boxId, preservedRequirement.requirementId)
  );
  pushInvariant(
    invariants,
    `${scenario.name}: preserved-priority reservation receives full LF`,
    preservedAllocatedBefore === preservedRequiredFeet && preservedJob.summary.status === "READY",
    {
      jobNumber: scenario.preservedJobNumber,
      allocatedFeet: preservedAllocatedBefore,
      status: preservedJob.summary.status
    }
  );

  const beforeCancellationInvariant = await fetchBoxInvariant(client, config.orgId, scenario.boxId);
  const cancellationRequiredFeet = Math.min(
    preferredCancellationFeet,
    integerOrZero(beforeCancellationInvariant?.allocatable_now_lf)
  );
  pushInvariant(
    invariants,
    `${scenario.name}: allocatable LF remains before lower-priority reservation`,
    cancellationRequiredFeet > 0,
    {
      ...(beforeCancellationInvariant || { boxId: scenario.boxId }),
      cancellationRequiredFeet
    }
  );

  await new Promise((resolve) => setTimeout(resolve, 25));
  let cancellationJob = await createJob(
    api,
    created,
    buildJobPayload({
      jobNumber: scenario.cancellationJobNumber,
      warehouse: config.warehouse,
      installDate: addDays(today, scenario.installOffsetDays + 2),
      crewLeader: `${scenario.name} Crew C`,
      manufacturer,
      filmName,
      widthIn,
      requiredFeet: cancellationRequiredFeet,
      runTag: config.runTag
    }),
    `${scenario.name}: create lower-priority job`
  );
  cancellationJob = await ensureAllocationFromBox(api, created, {
    label: `${scenario.name}: lower-priority job`,
    boxId: scenario.boxId,
    jobNumber: scenario.cancellationJobNumber,
    installDate: addDays(today, scenario.installOffsetDays + 2),
    crewLeader: `${scenario.name} Crew C`,
    requestedFeet: cancellationRequiredFeet,
    widthIn,
    warehouse: config.warehouse
  });
  const cancellationRequirement = findSingleRequirement(cancellationJob, `${scenario.name}: lower-priority job`);
  const cancellationAllocatedBefore = sumAllocatedFeet(
    activeRequirementAllocations(cancellationJob, scenario.boxId, cancellationRequirement.requirementId)
  );
  pushInvariant(
    invariants,
    `${scenario.name}: lower-priority reservation is established before check-in`,
    cancellationAllocatedBefore > 0,
    {
      jobNumber: scenario.cancellationJobNumber,
      allocatedFeet: cancellationAllocatedBefore,
      requiredFeet: cancellationRequiredFeet,
      status: cancellationJob.summary.status
    }
  );

  await setBoxStatus(
    api,
    created,
    {
      boxId: scenario.boxId,
      status: "CHECKED_OUT",
      auditNote: `Checked out for job ${scenario.checkoutJobNumber}`
    },
    `${scenario.name}: check out primary box`
  );
  const persistedBoxBeforeCheckin = await getBox(
    api,
    created,
    scenario.boxId,
    `${scenario.name}: reload primary box before check-in`
  );

  const checkinResult = await setBoxStatus(
    api,
    created,
    buildCheckinPayload(persistedBoxBeforeCheckin, preservedAllocatedBefore, config.runTag),
    `${scenario.name}: check in primary box to cancel lower-priority reservation`
  );
  await assertBoxReservationInvariant(client, config.orgId, invariants, scenario.boxId, `${scenario.name}: post check-in`);

  preservedJob = await getJob(
    api,
    created,
    scenario.preservedJobNumber,
    `${scenario.name}: reload preserved-priority job after check-in`
  );
  const preservedRequirementAfter = findSingleRequirement(
    preservedJob,
    `${scenario.name}: preserved-priority after check-in`
  );
  const preservedAllocatedAfter = sumAllocatedFeet(
    activeRequirementAllocations(preservedJob, scenario.boxId, preservedRequirementAfter.requirementId)
  );
  pushInvariant(
    invariants,
    `${scenario.name}: preserved-priority reservation remains after check-in`,
    preservedAllocatedAfter === preservedAllocatedBefore,
    {
      jobNumber: scenario.preservedJobNumber,
      allocatedBefore: preservedAllocatedBefore,
      allocatedAfter: preservedAllocatedAfter,
      status: preservedJob.summary.status
    }
  );

  cancellationJob = await getJob(
    api,
    created,
    scenario.cancellationJobNumber,
    `${scenario.name}: reload lower-priority job after check-in`
  );
  const cancellationRequirementAfter = findSingleRequirement(
    cancellationJob,
    `${scenario.name}: lower-priority after check-in`
  );
  const cancellationAllocatedAfter = sumAllocatedFeet(
    activeRequirementAllocations(cancellationJob, scenario.boxId, cancellationRequirementAfter.requirementId)
  );
  pushInvariant(
    invariants,
    `${scenario.name}: lower-priority reservation is fully cancelled`,
    cancellationAllocatedAfter === 0 &&
      integerOrZero(cancellationRequirementAfter.remainingFeet) === cancellationRequiredFeet,
    {
      jobNumber: scenario.cancellationJobNumber,
      allocatedBefore: cancellationAllocatedBefore,
      allocatedAfter: cancellationAllocatedAfter,
      remainingFeet: cancellationRequirementAfter.remainingFeet,
      status: cancellationJob.summary.status,
      warnings: checkinResult?.warnings || []
    }
  );

  return {
    name: scenario.name,
    boxId: scenario.boxId,
    checkoutJobNumber: scenario.checkoutJobNumber,
    preservedJobNumber: scenario.preservedJobNumber,
    cancellationJobNumber: scenario.cancellationJobNumber,
    physicalFeetBefore: primaryPhysicalFeet,
    physicalFeetAfter: preservedAllocatedBefore,
    preservedAllocatedBefore,
    cancellationAllocatedBefore,
    cancellationAllocatedAfter,
    warnings: checkinResult?.warnings || []
  };
}

async function runReceiveScenario({ api, config, created, invariants, scenario }) {
  const manufacturer = "Smoke Test Film";
  const filmName = `Smoke Recon Receive ${config.shortTag}`;
  const widthIn = 60;
  const requiredFeet = 40;
  const installDate = addDays(todayDateString(), 21);

  let job = await createJob(
    api,
    created,
    buildJobPayload({
      jobNumber: scenario.jobNumber,
      warehouse: config.warehouse,
      installDate,
      crewLeader: "Smoke Receive Crew",
      manufacturer,
      filmName,
      widthIn,
      requiredFeet,
      runTag: config.runTag
    }),
    "receive: create short job"
  );
  job = await getJob(api, created, scenario.jobNumber, "receive: reload short job");
  const requirement = findSingleRequirement(job, "receive: short job");
  pushInvariant(
    invariants,
    "receive: job starts as FILM_ORDER with no matching inventory",
    job.summary.status === "FILM_ORDER" && integerOrZero(requirement.remainingFeet) === requiredFeet,
    {
      jobNumber: scenario.jobNumber,
      status: job.summary.status,
      remainingFeet: requirement.remainingFeet
    }
  );

  const filmOrder = await createFilmOrder(
    api,
    created,
    {
      jobNumber: scenario.jobNumber,
      requirementId: requirement.requirementId,
      warehouse: config.warehouse,
      manufacturer,
      filmName,
      widthIn,
      requestedFeet: requiredFeet
    },
    "receive: create manual film order"
  );

  await addBox(
    api,
    created,
    buildOrderedBoxPayload({
      boxId: scenario.orderedBoxId,
      warehouse: config.warehouse,
      manufacturer,
      filmName,
      widthIn,
      initialFeet: requiredFeet,
      runTag: config.runTag,
      filmOrderId: filmOrder.filmOrderId
    }),
    "receive: add ordered box linked to film order"
  );

  job = await getJob(api, created, scenario.jobNumber, "receive: reload after ordered box link");
  const orderOnWay = (await listFilmOrders(api, "receive: list after ordered link"))
    .find((entry) => entry.filmOrderId === filmOrder.filmOrderId);
  pushInvariant(
    invariants,
    "receive: fully covered on-the-way shortage derives ORDERED",
    job.summary.status === "ORDERED" &&
      orderOnWay?.status === "FILM_ON_THE_WAY" &&
      integerOrZero(orderOnWay.orderedFeet) === requiredFeet,
    {
      jobNumber: scenario.jobNumber,
      jobStatus: job.summary.status,
      orderStatus: orderOnWay?.status,
      orderedFeet: orderOnWay?.orderedFeet
    }
  );

  await receiveOrderedBox(
    api,
    created,
    {
      boxId: scenario.orderedBoxId,
      receivedWeightLbs: buildTargetRollWeightLbs({
        coreWeightLbs: deriveCoreWeightLbs(normalizeCoreType(CORE_TYPE), widthIn),
        lfWeightLbsPerFt: LF_WEIGHT_LBS_PER_FT,
        targetFeet: requiredFeet,
        boxId: scenario.orderedBoxId,
        context: "receive ordered box"
      }),
      lotRun: config.runTag
    },
    "receive: receive ordered box"
  );
  await getBox(api, created, scenario.orderedBoxId, "receive: reload ordered box after receipt");

  job = await getJob(api, created, scenario.jobNumber, "receive: reload after receipt");
  const requirementAfter = findSingleRequirement(job, "receive: after receipt");
  const orderAfter = (await listFilmOrders(api, "receive: list after receipt"))
    .find((entry) => entry.filmOrderId === filmOrder.filmOrderId);
  pushInvariant(
    invariants,
    "receive: received order allocates and job becomes READY",
    job.summary.status === "READY" &&
      integerOrZero(requirementAfter.allocatedFeet) === requiredFeet &&
      integerOrZero(requirementAfter.remainingFeet) === 0 &&
      orderAfter?.status === "FULFILLED",
    {
      jobNumber: scenario.jobNumber,
      jobStatus: job.summary.status,
      allocatedFeet: requirementAfter.allocatedFeet,
      remainingFeet: requirementAfter.remainingFeet,
      orderStatus: orderAfter?.status
    }
  );

  return {
    name: "receive",
    jobNumber: scenario.jobNumber,
    requirementId: requirement.requirementId,
    filmOrderId: filmOrder.filmOrderId,
    orderedBoxId: scenario.orderedBoxId,
    finalStatus: job.summary.status,
    finalRequirement: {
      requiredFeet: requirementAfter.requiredFeet,
      allocatedFeet: requirementAfter.allocatedFeet,
      remainingFeet: requirementAfter.remainingFeet
    },
    finalFilmOrder: orderAfter
      ? {
          status: orderAfter.status,
          requestedFeet: orderAfter.requestedFeet,
          orderedFeet: orderAfter.orderedFeet,
          coveredFeet: orderAfter.coveredFeet,
          remainingToOrderFeet: orderAfter.remainingToOrderFeet
        }
      : null
  };
}

function printUsage() {
  // eslint-disable-next-line no-console
  console.log(`Usage:
node backend/scripts/smoke-box-checkin-reconciliation-flow.mjs \\
  --env backend/.env.dev \\
  --expected-project-ref ${DEV_PROJECT_REF} \\
  --org-id <DEV_ORG_UUID> \\
  --auth-token-env ${DEFAULT_AUTH_TOKEN_ENV} \\
  --confirm-dev-mutation ${CONFIRM_DEV_MUTATION} \\
  --out backend/migration-dry-runs/smoke/box-checkin-reconciliation.json

Or, read the token from an ignored local file:
node backend/scripts/smoke-box-checkin-reconciliation-flow.mjs \\
  --env backend/.env.dev \\
  --expected-project-ref ${DEV_PROJECT_REF} \\
  --org-id <DEV_ORG_UUID> \\
  --auth-token-file .codex-secrets/dev-smoke-access-token.txt \\
  --confirm-dev-mutation ${CONFIRM_DEV_MUTATION}

Auth-only verification, with no smoke data creation:
node backend/scripts/smoke-box-checkin-reconciliation-flow.mjs \\
  --env backend/.env.dev \\
  --expected-project-ref ${DEV_PROJECT_REF} \\
  --org-id <DEV_ORG_UUID> \\
  --auth-token-file .secrets/smoke-user-token.txt \\
  --auth-only

Owner/admin override, only when intentionally not using the Smoke User token:
node backend/scripts/smoke-box-checkin-reconciliation-flow.mjs \\
  --env backend/.env.dev \\
  --expected-project-ref ${DEV_PROJECT_REF} \\
  --org-id <DEV_ORG_UUID> \\
  --auth-token-file .secrets/owner-token.txt \\
  --allow-owner-smoke-run \\
  --auth-only

This script intentionally mutates DEV smoke data, refuses PROD refs/env files, and never prints the access token.`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = resolveSmokeConfig(options);
  if (config.help) {
    printUsage();
    return;
  }

  applyEnvValues(config.env.values);
  process.env.DATABASE_URL = config.databaseUrl;
  process.env.DEFAULT_ORG_ID = config.orgId;

  if (config.authOnly) {
    const { handleSupabaseRequest } = await import("../supabase-backend.mjs");
    const tokenSource = await resolveSmokeAccessToken(config);
    const tokenIdentity = await fetchDevAuthUserIdentity(config, tokenSource.token);
    const steps = [];
    const api = createApiClient({
      handleSupabaseRequest,
      token: tokenSource.token,
      steps
    });
    const smokeAccess = await assertSmokeAccess(api, config, tokenSource, tokenIdentity);

    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      success: true,
      mode: "auth-only",
      projectRef: config.supabaseProjectRef,
      orgId: config.orgId,
      envPath: config.envPath,
      smokeAccess,
      steps: steps.map((entry) => ({
        label: entry.label,
        method: entry.method,
        path: entry.path,
        statusCode: entry.statusCode,
        ok: entry.ok,
        warningCount: entry.warningCount
      }))
    }, null, 2));
    return;
  }

  const created = {
    boxIds: new Set(),
    jobNumbers: new Set(),
    requirementIds: new Set(),
    allocationIds: new Set(),
    filmOrderIds: new Set(),
    auditLogIds: new Set()
  };
  const steps = [];
  const invariants = [];
  const scenarios = [];
  const report = {
    metadata: {
      generatedAt: new Date().toISOString(),
      script: SCRIPT_NAME,
      envPath: config.envPath,
      projectRef: config.supabaseProjectRef,
      databaseProjectRef: config.databaseProjectRef,
      orgId: config.orgId,
      runTag: config.runTag,
      warehouse: config.warehouse,
      frontendUrl: config.frontendUrl,
      confirmation: CONFIRM_DEV_MUTATION,
      mutatesDevData: true
    },
    smokeAccess: null,
    schemaPreflight: null,
    created: {},
    steps,
    scenarios,
    invariants,
    entityTagging: null,
    unexpectedStates: [],
    summary: {},
    success: false
  };

  const jobNumbers = buildJobNumbers(config.shortTag);
  const boxIds = buildBoxIds(config.warehouse, config.shortTag);
  const client = new Client({
    application_name: SCRIPT_NAME,
    connectionString: config.databaseUrl,
    ssl: /localhost|127\.0\.0\.1/i.test(config.databaseUrl) ? undefined : { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    await assertNoExistingSmokeTag(client, config.orgId, config.runTag, boxIds, jobNumbers);

    const schemaPreflight = await fetchSchemaPreflight(client);
    report.schemaPreflight = schemaPreflight;
    requireSchemaPreflight(schemaPreflight);

    const { handleSupabaseRequest } = await import("../supabase-backend.mjs");
    const tokenSource = await resolveSmokeAccessToken(config);
    const tokenIdentity = await fetchDevAuthUserIdentity(config, tokenSource.token);
    const api = createApiClient({
      handleSupabaseRequest,
      token: tokenSource.token,
      steps
    });
    report.smokeAccess = await assertSmokeAccess(api, config, tokenSource, tokenIdentity);

    scenarios.push(
      await runPartialAllocationPair({
        api,
        client,
        config,
        created,
        invariants,
        scenario: {
          name: "editable-order",
          boxId: boxIds.editable,
          checkoutJobNumber: jobNumbers.editableCheckout,
          targetJobNumber: jobNumbers.editableTarget,
          installOffsetDays: 7
        },
        makeTargetOrderOnWay: false
      })
    );

    scenarios.push(
      await runPartialAllocationPair({
        api,
        client,
        config,
        created,
        invariants,
        scenario: {
          name: "on-way-order",
          boxId: boxIds.onWay,
          checkoutJobNumber: jobNumbers.onWayCheckout,
          targetJobNumber: jobNumbers.onWayTarget,
          installOffsetDays: 14
        },
        makeTargetOrderOnWay: true
      })
    );

    scenarios.push(
      await runFullCancellationScenario({
        api,
        client,
        config,
        created,
        invariants,
        scenario: {
          name: "full-cancellation",
          boxId: boxIds.cancellation,
          checkoutJobNumber: jobNumbers.cancellationCheckout,
          preservedJobNumber: jobNumbers.cancellationPreserved,
          cancellationJobNumber: jobNumbers.cancellationReduced,
          installOffsetDays: 28
        }
      })
    );

    scenarios.push(
      await runReceiveScenario({
        api,
        config,
        created,
        invariants,
        scenario: {
          jobNumber: jobNumbers.receiveTarget,
          orderedBoxId: boxIds.receiveOrdered
        }
      })
    );

    await tagCreatedRowsWithRunTag(client, config.orgId, created, config.runTag);
    report.entityTagging = await buildEntityTaggingReport(client, config.orgId, created, config.runTag);
    pushInvariant(
      invariants,
      "directly taggable created entities include the runTag",
      report.entityTagging.directlyTaggableFailures.length === 0,
      { failures: report.entityTagging.directlyTaggableFailures }
    );
    pushInvariant(
      invariants,
      "created child entities are tied to tagged parent records",
      report.entityTagging.parentTaggingFailures.length === 0,
      { failures: report.entityTagging.parentTaggingFailures }
    );

    report.unexpectedStates = await fetchCreatedUnexpectedStates(client, config.orgId, created);
    pushInvariant(
      invariants,
      "final unexpected-state validation is clean",
      report.unexpectedStates.length === 0,
      { unexpectedStates: report.unexpectedStates }
    );

    report.success = true;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    report.created = serializeCreated(created);
    report.summary = {
      success: report.success,
      stepCount: steps.length,
      invariantCount: invariants.length,
      failedInvariantCount: invariants.filter((entry) => !entry.ok).length,
      scenarioCount: scenarios.length,
      createdCounts: Object.fromEntries(
        Object.entries(report.created).map(([key, entries]) => [key, entries.length])
      ),
      directlyTaggableFailureCount: report.entityTagging?.directlyTaggableFailures?.length || 0,
      parentTaggingFailureCount: report.entityTagging?.parentTaggingFailures?.length || 0,
      unexpectedStateCount: report.unexpectedStates.length
    };
    writeJson(config.outPath, report);
    await client.end().catch(() => {});

    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      success: report.success,
      reportPath: config.outPath,
      projectRef: config.supabaseProjectRef,
      orgId: config.orgId,
      runTag: config.runTag,
      summary: report.summary,
      created: report.created,
      scenarios: scenarios.map((entry) => ({
        name: entry.name,
        boxId: entry.boxId || entry.orderedBoxId,
        targetJobNumber: entry.targetJobNumber || entry.jobNumber,
        finalStatus: entry.reconciliation?.targetStatusAfter || entry.finalStatus,
        filmOrderId: entry.filmOrderId
      }))
    }, null, 2));
  }
}

await main();

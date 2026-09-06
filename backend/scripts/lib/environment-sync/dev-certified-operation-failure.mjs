import { sanitizePostgresDiagnostic } from './private-diagnostics.mjs';

const OPERATION_FAILURE_FORMAT = 'dev-certified-operation-failure-v1';
const OPERATION_CAUSE_FORMAT = 'dev-certified-operation-cause-v1';
const OPERATION_CAUSE_FORMAT_V2 = 'dev-certified-operation-cause-v2';
const SAFE_TOKEN_PATTERN = /^[A-Z][A-Z0-9_]{0,159}$/;
const SAFE_SIGNAL_PATTERN = /^(?:SIG)?[A-Z0-9]{1,24}$/;
const TRANSACTION_OUTCOMES = new Set(['not_started', 'committed', 'rolled_back', 'ambiguous']);

function safeToken(value, fallback) {
  const normalized = String(value || '').trim().toUpperCase().replace(/[^A-Z0-9_]+/g, '_');
  return SAFE_TOKEN_PATTERN.test(normalized) ? normalized : fallback;
}

function publicFailureCategory(originalCategory) {
  if (/^DEV_REFRESH_[A-Z0-9_]{1,180}$/.test(originalCategory)) return originalCategory;
  const category = `DEV_REFRESH_REAL_STAGE_${originalCategory}`;
  return /^DEV_REFRESH_[A-Z0-9_]{1,180}$/.test(category)
    ? category
    : 'DEV_REFRESH_REAL_STAGE_UNCLASSIFIED_STAGE_FAILURE';
}

function normalizeSafeDiagnostic(value) {
  if (!value || typeof value !== 'object') return null;
  const sanitized = sanitizePostgresDiagnostic(value.excerpt);
  const exitCode = value.exitCode === null || value.exitCode === undefined
    ? null
    : Number(value.exitCode);
  return {
    classification: safeToken(value.classification || sanitized.classification, 'POSTGRES_CHILD_FAILED'),
    sqlState: /^(?:|[0-9A-Z]{5})$/.test(String(value.sqlState || '')) ? String(value.sqlState || '') : '',
    statementCategory: safeToken(value.statementCategory, 'UNCLASSIFIED_STATEMENT'),
    exitCode: Number.isSafeInteger(exitCode) && exitCode >= 0 && exitCode <= 255 ? exitCode : null,
    signal: SAFE_SIGNAL_PATTERN.test(String(value.signal || '')) ? String(value.signal) : '',
    overflow: value.overflow === true,
    excerpt: sanitized.excerpt
  };
}

function buildOperationFailure({ stage, attemptId, target, projectRef, contractDigest, error } = {}) {
  const originalCategory = safeToken(
    error?.code || error?.message,
    'UNCLASSIFIED_STAGE_FAILURE'
  );
  return {
    format: OPERATION_FAILURE_FORMAT,
    stage: String(stage || ''),
    attemptId: String(attemptId || ''),
    target: String(target || ''),
    projectRef: String(projectRef || ''),
    contractDigest: String(contractDigest || ''),
    category: publicFailureCategory(originalCategory),
    cause: {
      format: OPERATION_CAUSE_FORMAT_V2,
      category: originalCategory,
      substep: safeToken(error?.failureSubstep, 'STAGE_EXECUTION'),
      transactionOutcome: TRANSACTION_OUTCOMES.has(error?.transactionOutcome)
        ? error.transactionOutcome
        : 'not_started',
      diagnostic: normalizeSafeDiagnostic(error?.safeDiagnostic)
    }
  };
}

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function verifySafeDiagnostic(value) {
  if (value === null) return true;
  if (!exactKeys(value, [
    'classification', 'sqlState', 'statementCategory', 'exitCode', 'signal', 'overflow', 'excerpt'
  ])) return false;
  if (
    !SAFE_TOKEN_PATTERN.test(value.classification) ||
    !/^(?:|[0-9A-Z]{5})$/.test(value.sqlState) ||
    !SAFE_TOKEN_PATTERN.test(value.statementCategory) ||
    !(value.exitCode === null || (
      Number.isSafeInteger(value.exitCode) && value.exitCode >= 0 && value.exitCode <= 255
    )) ||
    !(value.signal === '' || SAFE_SIGNAL_PATTERN.test(value.signal)) ||
    typeof value.overflow !== 'boolean' ||
    typeof value.excerpt !== 'string' || value.excerpt.length < 1 || value.excerpt.length > 8192
  ) return false;
  return sanitizePostgresDiagnostic(value.excerpt).excerpt === value.excerpt;
}

function verifyOperationFailure(failure, expected = {}) {
  const legacy = exactKeys(failure, [
    'format', 'stage', 'attemptId', 'target', 'projectRef', 'contractDigest', 'category'
  ]);
  const withCause = exactKeys(failure, [
    'format', 'stage', 'attemptId', 'target', 'projectRef', 'contractDigest', 'category', 'cause'
  ]);
  if (!legacy && !withCause) return null;
  if (
    failure.format !== OPERATION_FAILURE_FORMAT ||
    failure.stage !== expected.stage ||
    failure.attemptId !== expected.attemptId ||
    failure.target !== expected.target ||
    failure.projectRef !== expected.projectRef ||
    failure.contractDigest !== expected.contractDigest ||
    !/^DEV_REFRESH_[A-Z0-9_]{1,180}$/.test(failure.category)
  ) return null;
  if (legacy) return failure;
  const cause = failure.cause;
  const causeV1 = exactKeys(cause, ['format', 'category', 'substep', 'diagnostic']) &&
    cause.format === OPERATION_CAUSE_FORMAT;
  const causeV2 = exactKeys(cause, [
    'format', 'category', 'substep', 'transactionOutcome', 'diagnostic'
  ]) && cause.format === OPERATION_CAUSE_FORMAT_V2 &&
    TRANSACTION_OUTCOMES.has(cause.transactionOutcome);
  if (
    (!causeV1 && !causeV2) ||
    !SAFE_TOKEN_PATTERN.test(cause.category) ||
    !SAFE_TOKEN_PATTERN.test(cause.substep) ||
    !verifySafeDiagnostic(cause.diagnostic) ||
    failure.category !== publicFailureCategory(cause.category)
  ) return null;
  return failure;
}

export {
  OPERATION_CAUSE_FORMAT,
  OPERATION_CAUSE_FORMAT_V2,
  OPERATION_FAILURE_FORMAT,
  TRANSACTION_OUTCOMES,
  buildOperationFailure,
  verifyOperationFailure
};

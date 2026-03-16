import crypto from 'node:crypto';
import { BOX_STATUSES, CORE_WEIGHT_AT_REFERENCE_WIDTH_LBS, CORE_WEIGHT_REFERENCE_WIDTH_IN, DEFAULT_ORG_ID, LOW_STOCK_THRESHOLD_LF, MEMBER_FEATURE_AREAS, ADMIN_FEATURE_AREAS, SUPABASE_ANON_KEY, SUPABASE_URL, UUID_PATTERN, ZEROED_BOX_AUTO_CANCEL_NOTE } from '../config/runtime.mjs';
import { ensureConfigured, queryRow, queryRows, withMutation, withReadClient } from '../db/client.mjs';
import { HttpError, ok } from '../lib/http.mjs';
import { routeParams } from '../routes/params.mjs';
import { READ_PATHS } from '../routes/readPaths.mjs';
import { authIdentityCache } from '../state/authIdentityCache.mjs';

function asTrimmedString(value) {
  if (value === null || value === undefined) {
    return '';
  }

  return String(value).trim();
}

function deriveNameFromEmail(email) {
  const localPart = asTrimmedString(email).split('@')[0] || '';
  return localPart.replace(/[._-]+/g, ' ').trim();
}

function requireString(value, fieldName) {
  const trimmed = asTrimmedString(value);
  if (!trimmed) {
    throw new HttpError(400, `${fieldName} is required.`);
  }

  return trimmed;
}

function normalizeUsername(value) {
  const normalized = asTrimmedString(value).replace(/\s+/g, ' ').trim();
  if (!normalized) {
    throw new HttpError(400, 'Username is required.');
  }
  if (normalized.length < 2) {
    throw new HttpError(400, 'Username must be at least 2 characters.');
  }
  if (normalized.length > 64) {
    throw new HttpError(400, 'Username must be 64 characters or fewer.');
  }
  return normalized;
}

function normalizeDateString(value, fieldName, allowBlank) {
  const trimmed = asTrimmedString(value);
  if (!trimmed) {
    if (allowBlank) {
      return '';
    }

    throw new HttpError(400, `${fieldName} is required.`);
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new HttpError(400, `${fieldName} must use yyyy-mm-dd.`);
  }

  return trimmed;
}

function coerceNonNegativeNumber(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new HttpError(400, `${fieldName} must be numeric.`);
  }

  if (parsed < 0) {
    throw new HttpError(400, `${fieldName} must be zero or greater.`);
  }

  return parsed;
}

function coerceOptionalNonNegativeNumber(value, fieldName) {
  const trimmed = asTrimmedString(value);
  if (!trimmed) {
    return null;
  }

  return coerceNonNegativeNumber(trimmed, fieldName);
}

function coerceFeetValue(value, fieldName, warnings, allowNegativeClamp) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new HttpError(400, `${fieldName} must be numeric.`);
  }

  const floored = Math.floor(parsed);
  if (floored !== parsed) {
    warnings.push(`${fieldName} was rounded down to ${floored}.`);
  }

  if (floored < 0) {
    if (allowNegativeClamp) {
      warnings.push(`${fieldName} was clamped to 0.`);
      return 0;
    }

    throw new HttpError(400, `${fieldName} must be zero or greater.`);
  }

  return floored;
}

function assertBoxStatus(value) {
  const normalized = asTrimmedString(value).toUpperCase();
  if (!BOX_STATUSES.has(normalized)) {
    throw new HttpError(
      400,
      'Status must be ORDERED, IN_STOCK, CHECKED_OUT, ZEROED, or RETIRED.'
    );
  }

  return normalized;
}

function isAllocatableBoxStatus(value) {
  const normalized = asTrimmedString(value).toUpperCase();
  return normalized === 'IN_STOCK' || normalized === 'CHECKED_OUT';
}

function parseBooleanFlag(value) {
  return value === true || asTrimmedString(value).toLowerCase() === 'true';
}

function formatTimestamp(value) {
  if (!value) {
    return '';
  }

  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function formatDateValue(value) {
  if (!value) {
    return '';
  }

  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }

  const iso = value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  return iso.slice(0, 10);
}

function numericOrNull(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function integerOrZero(value) {
  if (value === null || value === undefined || value === '') {
    return 0;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function integerOrNull(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function parseIntegerInput(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || Math.trunc(parsed) !== parsed) {
    throw new HttpError(400, `${fieldName} must be an integer.`);
  }
  return Math.trunc(parsed);
}

function requireUuid(value, fieldName) {
  const normalized = requireString(value, fieldName);
  if (!UUID_PATTERN.test(normalized)) {
    throw new HttpError(400, `${fieldName} must be a valid UUID.`);
  }
  return normalized;
}

function cloneValue(value) {
  if (value === null || value === undefined) {
    return value;
  }

  return JSON.parse(JSON.stringify(value));
}

function createLogId() {
  const now = new Date();
  const timestamp = [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0'),
    String(now.getUTCHours()).padStart(2, '0'),
    String(now.getUTCMinutes()).padStart(2, '0'),
    String(now.getUTCSeconds()).padStart(2, '0'),
    String(now.getUTCMilliseconds()).padStart(3, '0')
  ].join('');
  const suffix = String(crypto.randomInt(0, 1000)).padStart(3, '0');
  return `${timestamp}-${suffix}`;
}

function roundToDecimals(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function normalizeWarehouseCodeFormat(value, fieldName) {
  const normalized = requireString(value, fieldName || 'Warehouse').toUpperCase();
  if (!/^[A-Z]{2}[1-9][0-9]{0,6}$/.test(normalized)) {
    throw new HttpError(
      400,
      `${fieldName || 'Warehouse'} must match AA1, AA2, ... with a 1-based index.`
    );
  }

  return normalized;
}

function buildFilmKey(manufacturer, filmName) {
  return `${manufacturer.toUpperCase()}|${filmName.toUpperCase()}`;
}

function todayDateString() {
  return new Date().toISOString().slice(0, 10);
}

function deriveAddFeetAvailable(initialFeet, receivedDate) {
  return receivedDate && receivedDate <= todayDateString() ? initialFeet : 0;
}

function deriveLifecycleStatus(receivedDate) {
  return receivedDate && receivedDate <= todayDateString() ? 'IN_STOCK' : 'ORDERED';
}

function normalizeCoreType(value, allowBlank) {
  const trimmed = asTrimmedString(value);
  if (!trimmed) {
    if (allowBlank) {
      return '';
    }

    throw new HttpError(400, 'CoreType is required.');
  }

  const normalized = trimmed.toLowerCase();
  if (normalized === 'white' || normalized === 'white plastic' || normalized === 'whiteplastic') {
    return 'White plastic';
  }

  if (normalized === 'red' || normalized === 'red plastic' || normalized === 'redplastic') {
    return 'Red plastic';
  }

  if (
    normalized === 'cardboard' ||
    normalized === 'cardboard 1/8"' ||
    normalized === 'cardboard 1/8' ||
    normalized === 'cardboard 1-8"' ||
    normalized === 'cardboard 1-8'
  ) {
    return 'Cardboard 1/8"';
  }

  if (
    normalized === 'thick cardboard' ||
    normalized === 'thick-cardboard' ||
    normalized === 'thick_cardboard' ||
    normalized === 'thickcardboard' ||
    normalized === 'cardboard 3/4"' ||
    normalized === 'cardboard 3/4' ||
    normalized === 'cardboard 3-4"' ||
    normalized === 'cardboard 3-4'
  ) {
    return 'Cardboard 3/4"';
  }

  if (
    normalized === 'security 1/4" cardboard' ||
    normalized === 'security 1/4 cardboard' ||
    normalized === 'security 1-4" cardboard' ||
    normalized === 'security 1-4 cardboard'
  ) {
    return 'SECURITY 1/4" Cardboard';
  }

  throw new HttpError(
    400,
    'CoreType must be White plastic, Red plastic, Cardboard 1/8", Cardboard 3/4", or SECURITY 1/4" Cardboard.'
  );
}

function deriveCoreWeightLbs(coreType, widthIn) {
  return roundToDecimals(
    (CORE_WEIGHT_AT_REFERENCE_WIDTH_LBS[coreType] / CORE_WEIGHT_REFERENCE_WIDTH_IN) * widthIn,
    4
  );
}

function deriveLfWeightLbsPerFt(sqFtWeightLbsPerSqFt, widthIn) {
  return roundToDecimals(sqFtWeightLbsPerSqFt * (widthIn / 12), 6);
}

function deriveInitialWeightLbs(lfWeightLbsPerFt, initialFeet, coreWeightLbs) {
  return roundToDecimals(lfWeightLbsPerFt * initialFeet + coreWeightLbs, 2);
}

function deriveSqFtWeightLbsPerSqFt(initialWeightLbs, coreWeightLbs, widthIn, initialFeet) {
  const areaSqFt = (widthIn / 12) * initialFeet;
  if (areaSqFt <= 0) {
    throw new HttpError(400, 'WidthIn and InitialFeet must be greater than zero to derive film weight.');
  }

  const filmOnlyWeightLbs = initialWeightLbs - coreWeightLbs;
  if (filmOnlyWeightLbs < 0) {
    throw new HttpError(
      400,
      'InitialWeightLbs must be greater than or equal to the derived core weight.'
    );
  }

  return roundToDecimals(filmOnlyWeightLbs / areaSqFt, 8);
}

function deriveFeetAvailableFromRollWeight(lastRollWeightLbs, coreWeightLbs, lfWeightLbsPerFt, initialFeet) {
  if (lfWeightLbsPerFt <= 0) {
    throw new HttpError(
      400,
      'LfWeightLbsPerFt must be greater than zero to calculate FeetAvailable.'
    );
  }

  const rawFeet = (lastRollWeightLbs - coreWeightLbs) / lfWeightLbsPerFt;
  if (rawFeet <= 0) {
    return 0;
  }

  const flooredFeet = Math.floor(rawFeet);
  if (flooredFeet > initialFeet) {
    return initialFeet;
  }

  return flooredFeet;
}

function isLowStockBox(box) {
  return box.status === 'IN_STOCK' && box.feetAvailable > 0 && box.feetAvailable < LOW_STOCK_THRESHOLD_LF;
}

function hasPositivePhysicalFeet(box) {
  if (!box || !box.receivedDate) {
    return false;
  }

  if (
    box.lastRollWeightLbs !== null &&
    box.coreWeightLbs !== null &&
    box.lfWeightLbsPerFt !== null &&
    box.lfWeightLbsPerFt > 0
  ) {
    return (
      deriveFeetAvailableFromRollWeight(
        box.lastRollWeightLbs,
        box.coreWeightLbs,
        box.lfWeightLbsPerFt,
        box.initialFeet
      ) > 0
    );
  }

  return box.initialFeet > 0;
}

function shouldAutoMoveToZeroed(existingBox, nextBox) {
  return (
    Boolean(nextBox.receivedDate) &&
    existingBox &&
    hasPositivePhysicalFeet(existingBox) &&
    (nextBox.feetAvailable === 0 || nextBox.lastRollWeightLbs === 0)
  );
}

function determineZeroedReason(box) {
  if (box.feetAvailable === 0 && box.lastRollWeightLbs === 0) {
    return 'Auto-zeroed because Available Feet and Last Roll Weight reached 0.';
  }

  if (box.feetAvailable === 0) {
    return 'Auto-zeroed because Available Feet reached 0.';
  }

  return 'Auto-zeroed because Last Roll Weight reached 0.';
}

function normalizeMeaningfulZeroedNote(note) {
  const trimmed = asTrimmedString(note);
  if (!trimmed) {
    return '';
  }

  if (/^Checked in at /i.test(trimmed) || /^Auto-moved to zeroed out inventory$/i.test(trimmed)) {
    return '';
  }

  return trimmed;
}

function stampZeroedMetadata(box, user, auditNote) {
  const note = normalizeMeaningfulZeroedNote(auditNote);
  box.status = 'ZEROED';
  box.feetAvailable = 0;
  box.zeroedDate = todayDateString();
  box.zeroedReason = `${determineZeroedReason(box)}${note ? ` Additional note: ${note}` : ''}`;
  box.zeroedBy = asTrimmedString(user);
}

function applyAddOrEditWarnings(warnings, currentBox, nextBox) {
  if (nextBox.receivedDate && nextBox.orderDate && nextBox.receivedDate < nextBox.orderDate) {
    warnings.push('Received Date is earlier than Order Date.');
  }

  if (nextBox.lastWeighedDate && nextBox.receivedDate && nextBox.lastWeighedDate < nextBox.receivedDate) {
    warnings.push('Last Weighed Date is earlier than Received Date.');
  }

  if (nextBox.feetAvailable > nextBox.initialFeet) {
    warnings.push('Available Feet is greater than Initial Feet.');
  }

  if (
    nextBox.receivedDate &&
    nextBox.feetAvailable === 0 &&
    nextBox.lastRollWeightLbs !== null &&
    nextBox.lastRollWeightLbs > 0
  ) {
    warnings.push('Available Feet is 0 while Last Roll Weight is still above 0.');
  }

  if (nextBox.receivedDate && nextBox.lastRollWeightLbs === 0 && nextBox.feetAvailable > 0) {
    warnings.push('Last Roll Weight is 0 while Available Feet is still above 0.');
  }

  if (
    currentBox &&
    currentBox.receivedDate &&
    (currentBox.initialWeightLbs !== null ||
      currentBox.lastRollWeightLbs !== null ||
      currentBox.lfWeightLbsPerFt !== null) &&
    (currentBox.manufacturer !== nextBox.manufacturer ||
      currentBox.filmName !== nextBox.filmName ||
      currentBox.widthIn !== nextBox.widthIn ||
      currentBox.initialFeet !== nextBox.initialFeet)
  ) {
    warnings.push('Film identity, width, or initial feet changed after weights were already established.');
  }
}

function applyCheckoutWarnings(warnings, box) {
  if (box.lastRollWeightLbs === null) {
    warnings.push('This box does not have a current Last Roll Weight saved yet.');
  }

  if (!box.lastWeighedDate) {
    warnings.push('This box does not have a Last Weighed Date saved yet.');
  }
}

function applyCheckInWarnings(warnings, existingBox, updatedBox, willAutoZero) {
  if (
    existingBox.lastRollWeightLbs !== null &&
    updatedBox.lastRollWeightLbs !== null &&
    updatedBox.lastRollWeightLbs > existingBox.lastRollWeightLbs
  ) {
    warnings.push('The new Last Roll Weight is greater than the box\'s previous Last Roll Weight.');
  }

  if (
    existingBox.initialWeightLbs !== null &&
    updatedBox.lastRollWeightLbs !== null &&
    updatedBox.lastRollWeightLbs > existingBox.initialWeightLbs
  ) {
    warnings.push('The new Last Roll Weight is greater than the box\'s Initial Weight.');
  }

  if (
    updatedBox.lastRollWeightLbs !== null &&
    updatedBox.lastRollWeightLbs > 0 &&
    updatedBox.coreWeightLbs !== null &&
    updatedBox.lastRollWeightLbs < updatedBox.coreWeightLbs
  ) {
    warnings.push('The new Last Roll Weight is below the derived core weight.');
  }

  if (updatedBox.feetAvailable > existingBox.feetAvailable) {
    warnings.push('The recalculated Available Feet would increase compared with the current box.');
  }

  if (willAutoZero) {
    warnings.push('This check-in will auto-move the box into zeroed out inventory.');
  }
}

function normalizeCollapsedCatalogLabel(value) {
  return asTrimmedString(value).replace(/\s+/g, ' ');
}

function canonicalizeManufacturerLabel(value) {
  const normalized = normalizeCollapsedCatalogLabel(value);
  const key = normalized.toLowerCase();

  if (key === '3m') {
    return '3M Solar';
  }

  if (key === 'fasara' || key === '3m fasara') {
    return '3M Fasara';
  }

  if (key === 'avery') {
    return 'Avery Dennison';
  }

  if (key === 'solar guard') {
    return 'Solar Gard';
  }

  return normalized;
}

function normalizeCatalogLookupKey(value) {
  return normalizeCollapsedCatalogLabel(value).toLowerCase();
}

function normalizeCatalogManufacturerLookupKey(value) {
  return normalizeCatalogLookupKey(canonicalizeManufacturerLabel(value));
}

const SECURITY_MANUFACTURER_LABEL = 'Security';

function normalizeMilTokenSpacing(value) {
  return normalizeCollapsedCatalogLabel(value).replace(/\b(\d+)\s*mil\b/gi, (_match, digits) => `${digits} MIL`);
}

function stripLeadingSecurityToken(value) {
  return normalizeCollapsedCatalogLabel(value).replace(/^security\b[:\-\s]*/i, '').trim();
}

function isBareMilLabel(value) {
  return /^\d+\s*mil$/i.test(normalizeCollapsedCatalogLabel(value));
}

function inferPrestigeCode(value) {
  const normalized = normalizeCollapsedCatalogLabel(value);
  const directMatch = normalized.match(/\b(?:ultra\s+)?prestige\s+(\d{2,3})\b/i);
  if (directMatch) {
    return directMatch[1];
  }

  const prMatch = normalized.match(/\bpr\s*[-]?\s*(\d{2,3})\b/i);
  if (prMatch && /\b(ultra|prestige)\b/i.test(normalized)) {
    return prMatch[1];
  }

  return '';
}

function normalizeSecurityMakerPrefix(value) {
  const normalized = normalizeCollapsedCatalogLabel(value);
  const key = normalized.toLowerCase();
  if (!normalized) return '';
  if (key === '3m' || key === '3m solar' || key === '3m fasara') return '3M';
  if (key === 'solar guard' || key === 'solargard' || key === 'solar gard') return 'Solar Gard';
  if (key === 'avery' || key === 'avery dennison') return 'Avery Dennison';
  if (key === 'llumar vista' || key === 'llumarvista' || key === 'llumar') return 'Llumar';
  if (key === 'solyx') return 'Solyx';
  if (key === 'aswfvkool') return 'ASWFVKOOL';
  if (key === 'madico') return 'Madico';
  if (key === 'sol') return 'SOL';
  return normalized;
}

function startsWithMakerPrefix(value, makerPrefix) {
  const normalizedValue = normalizeCollapsedCatalogLabel(value).toLowerCase();
  const normalizedPrefix = normalizeSecurityMakerPrefix(makerPrefix).toLowerCase();
  if (!normalizedPrefix) {
    return false;
  }
  if (normalizedValue === normalizedPrefix) {
    return true;
  }
  if (normalizedValue.startsWith(`${normalizedPrefix} `)) {
    return true;
  }
  if (normalizedPrefix === '3m' && normalizedValue.startsWith('3m solar ')) {
    return true;
  }
  if (normalizedPrefix === 'solar gard' && normalizedValue.startsWith('solargard ')) {
    return true;
  }
  if (normalizedPrefix === 'avery dennison' && normalizedValue.startsWith('avery ')) {
    return true;
  }
  return false;
}

function normalizeLeadingMakerPrefix(baseName, makerPrefix) {
  const normalizedBase = normalizeCollapsedCatalogLabel(baseName);
  const normalizedPrefix = normalizeSecurityMakerPrefix(makerPrefix);
  if (!normalizedPrefix) {
    return normalizedBase;
  }

  if (normalizedPrefix === '3M') {
    return normalizedBase.replace(/^3m(?:\s+solar)?\b/i, '3M');
  }
  if (normalizedPrefix === 'Solar Gard') {
    return normalizedBase.replace(/^(?:solar\s*guard|solargard|solar\s+gard)\b/i, 'Solar Gard');
  }
  if (normalizedPrefix === 'Avery Dennison') {
    return normalizedBase.replace(/^avery(?:\s+dennison)?\b/i, 'Avery Dennison');
  }
  if (normalizedPrefix === 'Llumar') {
    return normalizedBase.replace(/^llumar(?:\s+vista)?\b/i, 'Llumar');
  }
  if (normalizedPrefix === 'Solyx') {
    return normalizedBase.replace(/^solyx\b/i, 'Solyx');
  }
  if (normalizedPrefix === 'ASWFVKOOL') {
    return normalizedBase.replace(/^aswfvkool\b/i, 'ASWFVKOOL');
  }
  if (normalizedPrefix === 'Madico') {
    return normalizedBase.replace(/^madico\b/i, 'Madico');
  }
  if (normalizedPrefix === 'SOL') {
    return normalizedBase.replace(/^sol\b/i, 'SOL');
  }

  return normalizedBase;
}

function inferSecurityMakerPrefixFromFilmName(filmName) {
  const cleaned = stripLeadingSecurityToken(filmName);
  if (!cleaned) return '';
  if (/^3m\b/i.test(cleaned)) return '3M';
  if (/^madico\b/i.test(cleaned)) return 'Madico';
  if (/^solar\s*guard\b/i.test(cleaned) || /^solargard\b/i.test(cleaned)) return 'Solar Gard';
  if (/^avery(?:\s+dennison)?\b/i.test(cleaned)) return 'Avery Dennison';
  if (/^llumar(?:\s+vista)?\b/i.test(cleaned)) return 'Llumar';
  if (/^solyx\b/i.test(cleaned)) return 'Solyx';
  if (/^aswfvkool\b/i.test(cleaned)) return 'ASWFVKOOL';
  if (/^sol\b/i.test(cleaned)) return 'SOL';
  return '';
}

function inferSecurityMakerPrefixFromManufacturer(manufacturer) {
  const canonical = canonicalizeManufacturerLabel(manufacturer);
  if (!canonical || normalizeCatalogManufacturerLookupKey(canonical) === normalizeCatalogManufacturerLookupKey(SECURITY_MANUFACTURER_LABEL)) {
    return '';
  }
  return normalizeSecurityMakerPrefix(canonical);
}

function getDefaultMakerPrefixForSecurityFamily(family) {
  if (family === 'prestige' || family === 's600') {
    return '3M';
  }
  return '';
}

function detectSecurityFilmFamily(filmName) {
  const normalized = normalizeCollapsedCatalogLabel(filmName);
  const squashedUpper = normalized.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const agMatch = normalized.match(/\bAG[-\s]*([0-9]+)\b/i);
  const prestigeCode = inferPrestigeCode(normalized);

  if (prestigeCode) {
    return { isSecurity: true, family: 'prestige', agCode: '', modelCode: prestigeCode };
  }

  if (
    /\bULTRA\s*S?600\b/i.test(normalized) ||
    /\bS[-\s]*600\b/i.test(normalized) ||
    squashedUpper.includes('ULTRAS600')
  ) {
    return { isSecurity: true, family: 's600', agCode: '', modelCode: '600' };
  }

  if (agMatch || /\banti\s*graffiti\b/i.test(normalized)) {
    return { isSecurity: true, family: 'ag', agCode: agMatch ? agMatch[1] : '', modelCode: '' };
  }
  if (/\bS[-\s]*140\b/i.test(normalized)) {
    return { isSecurity: true, family: 's140', agCode: '', modelCode: '140' };
  }
  if (/\bS[-\s]*70\b/i.test(normalized)) {
    return { isSecurity: true, family: 's70', agCode: '', modelCode: '70' };
  }
  if (
    /\bULTRA\s*S?800\b/i.test(normalized) ||
    /\bS[-\s]*800\b/i.test(normalized) ||
    squashedUpper.includes('ULTRAS800')
  ) {
    return { isSecurity: true, family: 's800', agCode: '', modelCode: '800' };
  }

  if (isBareMilLabel(normalized)) {
    return { isSecurity: false, family: '', agCode: '', modelCode: '' };
  }

  if (/\b\d+\s*mil\b/i.test(normalized)) {
    return { isSecurity: true, family: 'mil', agCode: '', modelCode: '' };
  }
  return { isSecurity: false, family: '', agCode: '', modelCode: '' };
}

function buildCanonicalSecurityFilmName(sourceFilmName, detection, makerPrefix) {
  const cleanedSource = normalizeMilTokenSpacing(stripLeadingSecurityToken(sourceFilmName));
  const normalizedPrefix = normalizeSecurityMakerPrefix(makerPrefix);
  const withPrefix = (baseName) => {
    const normalizedBase = normalizeCollapsedCatalogLabel(baseName);
    if (!normalizedPrefix) {
      return normalizedBase;
    }
    if (startsWithMakerPrefix(normalizedBase, normalizedPrefix)) {
      return normalizeLeadingMakerPrefix(normalizedBase, normalizedPrefix);
    }
    return `${normalizedPrefix} ${normalizedBase}`;
  };

  if (detection.family === 's800') {
    return withPrefix('Ultra S800');
  }
  if (detection.family === 's70') {
    return withPrefix('S70');
  }
  if (detection.family === 's140') {
    return withPrefix('S140');
  }
  if (detection.family === 'ag') {
    const code = detection.agCode ? `AG-${detection.agCode}` : 'AG';
    return withPrefix(code);
  }
  if (detection.family === 's600') {
    return withPrefix('Ultra S600');
  }
  if (detection.family === 'prestige') {
    const prestigeCode = normalizeCollapsedCatalogLabel(detection.modelCode || '');
    return withPrefix(prestigeCode ? `Ultra Prestige ${prestigeCode}` : 'Ultra Prestige');
  }

  return withPrefix(cleanedSource);
}

function normalizeSecurityManufacturerAndFilm(manufacturer, filmName) {
  const normalizedManufacturer = canonicalizeManufacturerLabel(manufacturer);
  const normalizedFilmName = normalizeCollapsedCatalogLabel(filmName);
  const detection = detectSecurityFilmFamily(normalizedFilmName);
  if (!detection.isSecurity) {
    return {
      manufacturer: normalizedManufacturer,
      filmName: normalizedFilmName
    };
  }

  const makerPrefix =
    normalizeSecurityMakerPrefix(inferSecurityMakerPrefixFromFilmName(normalizedFilmName)) ||
    normalizeSecurityMakerPrefix(inferSecurityMakerPrefixFromManufacturer(normalizedManufacturer)) ||
    normalizeSecurityMakerPrefix(getDefaultMakerPrefixForSecurityFamily(detection.family));

  return {
    manufacturer: SECURITY_MANUFACTURER_LABEL,
    filmName: buildCanonicalSecurityFilmName(normalizedFilmName, detection, makerPrefix)
  };
}

function normalizeFilmKeyInput(manufacturer, filmName, filmKeyInput) {
  const normalized = normalizeSecurityManufacturerAndFilm(manufacturer, filmName);
  void filmKeyInput;
  return buildFilmKey(normalized.manufacturer, normalized.filmName);
}

function isFilmNameAliasLookupUnavailableError(error) {
  const message = asTrimmedString(error?.message).toLowerCase();
  return (
    (message.includes('app.film_name_aliases') && message.includes('does not exist')) ||
    (message.includes('app.film_name_aliases') && message.includes('permission denied'))
  );
}

async function resolveCanonicalFilmNameAlias(client, orgId, manufacturer, filmName) {
  const canonicalManufacturer = canonicalizeManufacturerLabel(manufacturer);
  const normalizedFilmName = normalizeCollapsedCatalogLabel(filmName);
  if (!normalizedFilmName) {
    return '';
  }

  let row = null;
  try {
    row = await queryRow(
      client,
      `
        select canonical_film_name
        from app.film_name_aliases
        where org_id = $1
          and manufacturer_lookup_key = $2
          and old_film_name_lookup_key = $3
        limit 1
      `,
      [
        orgId,
        normalizeCatalogManufacturerLookupKey(canonicalManufacturer),
        normalizeCatalogLookupKey(normalizedFilmName)
      ]
    );
  } catch (error) {
    if (isFilmNameAliasLookupUnavailableError(error)) {
      return normalizedFilmName;
    }
    throw error;
  }

  if (!row || !row.canonical_film_name) {
    return normalizedFilmName;
  }

  return normalizeCollapsedCatalogLabel(row.canonical_film_name);
}

async function resolveCanonicalFilmEntry(client, orgId, manufacturer, filmName) {
  const normalized = normalizeSecurityManufacturerAndFilm(manufacturer, filmName);
  const aliasResolvedFilmName = await resolveCanonicalFilmNameAlias(
    client,
    orgId,
    normalized.manufacturer,
    normalized.filmName
  );
  return normalizeSecurityManufacturerAndFilm(normalized.manufacturer, aliasResolvedFilmName);
}

function dedupeNormalizedJobRequirements(requirements) {
  const deduped = {};

  for (let index = 0; index < requirements.length; index += 1) {
    const entry = requirements[index];
    const key = normalizeJobRequirementLookupKey(entry.manufacturer, entry.filmName, entry.widthIn);
    if (!deduped[key]) {
      deduped[key] = { ...entry };
      continue;
    }
    deduped[key].requiredFeet += entry.requiredFeet;
  }

  const values = Object.values(deduped);
  values.sort((left, right) => {
    const manufacturerCompare = compareCatalogStrings(left.manufacturer, right.manufacturer);
    if (manufacturerCompare !== 0) {
      return manufacturerCompare;
    }

    const filmCompare = compareCatalogStrings(left.filmName, right.filmName);
    if (filmCompare !== 0) {
      return filmCompare;
    }

    if (left.widthIn !== right.widthIn) {
      return left.widthIn < right.widthIn ? -1 : 1;
    }

    return 0;
  });

  return values;
}

async function canonicalizeJobRequirementEntriesWithAliases(client, orgId, requirements) {
  const normalized = [];
  for (let index = 0; index < requirements.length; index += 1) {
    const entry = requirements[index];
    const canonical = await resolveCanonicalFilmEntry(client, orgId, entry.manufacturer, entry.filmName);
    normalized.push({
      ...entry,
      manufacturer: canonical.manufacturer,
      filmName: canonical.filmName
    });
  }

  return dedupeNormalizedJobRequirements(normalized);
}

function compareCatalogStrings(left, right) {
  const leftValue = asTrimmedString(left).toLowerCase();
  const rightValue = asTrimmedString(right).toLowerCase();

  if (leftValue < rightValue) {
    return -1;
  }

  if (leftValue > rightValue) {
    return 1;
  }

  return 0;
}

function normalizeJobNumberDigits(value, fieldName) {
  const normalized = requireString(value, fieldName || 'JobNumber');
  if (!/^\d+$/.test(normalized)) {
    throw new HttpError(400, `${fieldName || 'JobNumber'} must contain numbers only.`);
  }

  return normalized;
}

function normalizeJobWarehouse(value) {
  return normalizeWarehouseCodeFormat(value, 'Warehouse');
}

function normalizeJobSections(value) {
  const trimmed = asTrimmedString(value);
  if (!trimmed) {
    return null;
  }

  const rawParts = trimmed.split(',');
  const normalizedParts = [];
  for (let index = 0; index < rawParts.length; index += 1) {
    const token = asTrimmedString(rawParts[index]);
    if (!token) {
      continue;
    }

    if (!/^\d+$/.test(token)) {
      throw new HttpError(400, 'Sections must contain numbers separated by commas.');
    }

    normalizedParts.push(token);
  }

  if (!normalizedParts.length) {
    return null;
  }

  return normalizedParts.join(', ');
}

function normalizeJobLifecycleStatus(value) {
  const normalized = asTrimmedString(value).toUpperCase();
  if (normalized === 'CANCELLED') {
    return 'CANCELLED';
  }

  if (normalized === 'COMPLETED') {
    return 'COMPLETED';
  }

  return 'ACTIVE';
}

function normalizeRequirementWidthKey(value) {
  return String(roundToDecimals(Number(value), 4));
}

function normalizeJobRequirementLookupKey(manufacturer, filmName, widthIn) {
  return [
    normalizeCatalogManufacturerLookupKey(manufacturer),
    normalizeCatalogLookupKey(filmName),
    normalizeRequirementWidthKey(widthIn)
  ].join('|');
}

function normalizeJobRequirementInput(entry, warnings, index) {
  const prefix = `Requirements[${index}]`;
  const manufacturer = requireString(entry && entry.manufacturer, `${prefix}.Manufacturer`);
  const filmName = requireString(entry && entry.filmName, `${prefix}.FilmName`);
  const widthIn = coerceNonNegativeNumber(entry && entry.widthIn, `${prefix}.WidthIn`);
  const requiredFeet = coerceFeetValue(entry && entry.requiredFeet, `${prefix}.RequiredFeet`, warnings, false);

  if (widthIn <= 0) {
    throw new HttpError(400, `${prefix}.WidthIn must be greater than zero.`);
  }

  if (requiredFeet <= 0) {
    throw new HttpError(400, `${prefix}.RequiredFeet must be greater than zero.`);
  }

  return {
    manufacturer: canonicalizeManufacturerLabel(manufacturer),
    filmName: normalizeCollapsedCatalogLabel(filmName),
    widthIn,
    requiredFeet
  };
}

function dedupeJobRequirements(requirements, warnings) {
  const deduped = {};

  if (!requirements || !Array.isArray(requirements)) {
    return [];
  }

  for (let index = 0; index < requirements.length; index += 1) {
    const normalized = normalizeJobRequirementInput(requirements[index], warnings, index);
    const key = normalizeJobRequirementLookupKey(
      normalized.manufacturer,
      normalized.filmName,
      normalized.widthIn
    );

    if (!deduped[key]) {
      deduped[key] = normalized;
      continue;
    }

    deduped[key].requiredFeet += normalized.requiredFeet;
  }

  const values = Object.values(deduped);
  values.sort((left, right) => {
    const manufacturerCompare = compareCatalogStrings(left.manufacturer, right.manufacturer);
    if (manufacturerCompare !== 0) {
      return manufacturerCompare;
    }

    const filmCompare = compareCatalogStrings(left.filmName, right.filmName);
    if (filmCompare !== 0) {
      return filmCompare;
    }

    if (left.widthIn !== right.widthIn) {
      return left.widthIn < right.widthIn ? -1 : 1;
    }

    return 0;
  });

  return values;
}

function normalizeJobNumberKey(jobNumber) {
  return asTrimmedString(jobNumber).toUpperCase();
}

function normalizeCrewLeaderKey(crewLeader) {
  return asTrimmedString(crewLeader).toUpperCase();
}

function compareBoxesByOldestStock(left, right) {
  const leftDate = left.receivedDate || left.orderDate || '9999-12-31';
  const rightDate = right.receivedDate || right.orderDate || '9999-12-31';

  if (leftDate !== rightDate) {
    return leftDate < rightDate ? -1 : 1;
  }

  return left.boxId < right.boxId ? -1 : left.boxId > right.boxId ? 1 : 0;
}

function compareAllocationJobSummaries(left, right) {
  if (left.jobDate && right.jobDate && left.jobDate !== right.jobDate) {
    return left.jobDate < right.jobDate ? -1 : 1;
  }

  if (left.jobDate && !right.jobDate) {
    return -1;
  }

  if (!left.jobDate && right.jobDate) {
    return 1;
  }

  return left.jobNumber < right.jobNumber ? -1 : left.jobNumber > right.jobNumber ? 1 : 0;
}

function compareJobsListEntries(left, right) {
  if (left.dueDate && right.dueDate && left.dueDate !== right.dueDate) {
    return left.dueDate > right.dueDate ? -1 : 1;
  }

  if (left.dueDate && !right.dueDate) {
    return -1;
  }

  if (!left.dueDate && right.dueDate) {
    return 1;
  }

  if (left.updatedAt && right.updatedAt && left.updatedAt !== right.updatedAt) {
    return left.updatedAt > right.updatedAt ? -1 : 1;
  }

  if (left.updatedAt && !right.updatedAt) {
    return -1;
  }

  if (!left.updatedAt && right.updatedAt) {
    return 1;
  }

  return left.jobNumber > right.jobNumber ? -1 : left.jobNumber < right.jobNumber ? 1 : 0;
}

function extractJobNumberDigitsForSearch(value) {
  return asTrimmedString(value).replace(/[^0-9]/g, '');
}

function canonicalizeNumericDigits(digits) {
  const withoutLeadingZeros = digits.replace(/^0+/, '');
  return withoutLeadingZeros || '0';
}

function compareBigInt(left, right) {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

function absoluteBigInt(value) {
  return value < 0n ? -value : value;
}

function mapDbBoxRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    orgId: row.org_id,
    boxId: asTrimmedString(row.box_id),
    warehouse: asTrimmedString(row.warehouse),
    manufacturer: canonicalizeManufacturerLabel(row.manufacturer),
    filmName: asTrimmedString(row.film_name),
    widthIn: numericOrNull(row.width_in) ?? 0,
    initialFeet: integerOrZero(row.initial_feet),
    feetAvailable: integerOrZero(row.feet_available),
    lotRun: asTrimmedString(row.lot_run),
    status: asTrimmedString(row.status) || 'ORDERED',
    orderDate: formatDateValue(row.order_date),
    receivedDate: formatDateValue(row.received_date),
    initialWeightLbs: numericOrNull(row.initial_weight_lbs),
    lastRollWeightLbs: numericOrNull(row.last_roll_weight_lbs),
    lastWeighedDate: formatDateValue(row.last_weighed_date),
    filmKey: asTrimmedString(row.film_key).toUpperCase(),
    coreType: asTrimmedString(row.core_type),
    coreWeightLbs: numericOrNull(row.core_weight_lbs),
    lfWeightLbsPerFt: numericOrNull(row.lf_weight_lbs_per_ft),
    purchaseCost: numericOrNull(row.purchase_cost),
    notes: asTrimmedString(row.notes),
    hasEverBeenCheckedOut: Boolean(row.has_ever_been_checked_out),
    lastCheckoutJob: asTrimmedString(row.last_checkout_job),
    lastCheckoutDate: formatDateValue(row.last_checkout_date),
    zeroedDate: formatDateValue(row.zeroed_date),
    zeroedReason: asTrimmedString(row.zeroed_reason),
    zeroedBy: asTrimmedString(row.zeroed_by),
    createdAt: formatTimestamp(row.created_at),
    updatedAt: formatTimestamp(row.updated_at)
  };
}

function toPublicBox(box) {
  return {
    boxId: box.boxId,
    warehouse: box.warehouse,
    manufacturer: box.manufacturer,
    filmName: box.filmName,
    widthIn: box.widthIn,
    initialFeet: box.initialFeet,
    feetAvailable: box.feetAvailable,
    lotRun: box.lotRun,
    status: box.status,
    orderDate: box.orderDate,
    receivedDate: box.receivedDate,
    initialWeightLbs: box.initialWeightLbs,
    lastRollWeightLbs: box.lastRollWeightLbs,
    lastWeighedDate: box.lastWeighedDate,
    filmKey: box.filmKey,
    coreType: box.coreType,
    coreWeightLbs: box.coreWeightLbs,
    lfWeightLbsPerFt: box.lfWeightLbsPerFt,
    purchaseCost: box.purchaseCost,
    notes: box.notes,
    hasEverBeenCheckedOut: box.hasEverBeenCheckedOut,
    lastCheckoutJob: box.lastCheckoutJob,
    lastCheckoutDate: box.lastCheckoutDate,
    zeroedDate: box.zeroedDate,
    zeroedReason: box.zeroedReason,
    zeroedBy: box.zeroedBy
  };
}

function mapDbFilmCatalogRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    orgId: row.org_id,
    filmKey: asTrimmedString(row.film_key).toUpperCase(),
    manufacturer: canonicalizeManufacturerLabel(row.manufacturer),
    filmName: asTrimmedString(row.film_name),
    sqFtWeightLbsPerSqFt: numericOrNull(row.sq_ft_weight_lbs_per_sq_ft),
    defaultCoreType: asTrimmedString(row.default_core_type),
    sourceWidthIn: numericOrNull(row.source_width_in),
    sourceInitialFeet: integerOrNull(row.source_initial_feet),
    sourceInitialWeightLbs: numericOrNull(row.source_initial_weight_lbs),
    sourceBoxId: asTrimmedString(row.source_box_id),
    notes: asTrimmedString(row.notes),
    updatedAt: formatTimestamp(row.updated_at)
  };
}

function mapDbAllocationRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    orgId: row.org_id,
    allocationId: asTrimmedString(row.allocation_id),
    boxId: asTrimmedString(row.box_id),
    warehouse: asTrimmedString(row.warehouse),
    jobId: row.job_id || null,
    jobNumber: asTrimmedString(row.job_number),
    jobDate: formatDateValue(row.job_date),
    allocatedFeet: integerOrZero(row.allocated_feet),
    status: asTrimmedString(row.status) || 'ACTIVE',
    createdAt: formatTimestamp(row.created_at),
    createdBy: asTrimmedString(row.created_by),
    resolvedAt: formatTimestamp(row.resolved_at),
    resolvedBy: asTrimmedString(row.resolved_by),
    notes: asTrimmedString(row.notes),
    crewLeader: asTrimmedString(row.crew_leader),
    filmOrderId: asTrimmedString(row.film_order_id)
  };
}

function toPublicAllocation(entry) {
  return {
    allocationId: entry.allocationId,
    boxId: entry.boxId,
    warehouse: entry.warehouse,
    jobNumber: entry.jobNumber,
    jobDate: entry.jobDate,
    crewLeader: entry.crewLeader,
    allocatedFeet: entry.allocatedFeet,
    status: entry.status,
    createdAt: entry.createdAt,
    createdBy: entry.createdBy,
    resolvedAt: entry.resolvedAt,
    resolvedBy: entry.resolvedBy,
    filmOrderId: entry.filmOrderId,
    notes: entry.notes
  };
}

function mapDbFilmOrderRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    orgId: row.org_id,
    filmOrderId: asTrimmedString(row.film_order_id),
    jobId: row.job_id || null,
    jobNumber: asTrimmedString(row.job_number),
    warehouse: asTrimmedString(row.warehouse),
    manufacturer: canonicalizeManufacturerLabel(row.manufacturer),
    filmName: asTrimmedString(row.film_name),
    widthIn: numericOrNull(row.width_in) ?? 0,
    requestedFeet: integerOrZero(row.requested_feet),
    coveredFeet: integerOrZero(row.covered_feet),
    orderedFeet: integerOrZero(row.ordered_feet),
    remainingToOrderFeet: integerOrZero(row.remaining_to_order_feet),
    jobDate: formatDateValue(row.job_date),
    crewLeader: asTrimmedString(row.crew_leader),
    status: asTrimmedString(row.status) || 'FILM_ORDER',
    sourceBoxId: asTrimmedString(row.source_box_id),
    createdAt: formatTimestamp(row.created_at),
    createdBy: asTrimmedString(row.created_by),
    resolvedAt: formatTimestamp(row.resolved_at),
    resolvedBy: asTrimmedString(row.resolved_by),
    notes: asTrimmedString(row.notes)
  };
}

function toPublicFilmOrder(entry, linkedBoxes) {
  return {
    filmOrderId: entry.filmOrderId,
    jobNumber: entry.jobNumber,
    warehouse: entry.warehouse,
    manufacturer: entry.manufacturer,
    filmName: entry.filmName,
    widthIn: entry.widthIn,
    requestedFeet: entry.requestedFeet,
    coveredFeet: entry.coveredFeet,
    orderedFeet: entry.orderedFeet,
    remainingToOrderFeet: entry.remainingToOrderFeet,
    jobDate: entry.jobDate,
    crewLeader: entry.crewLeader,
    status: entry.status,
    sourceBoxId: entry.sourceBoxId,
    createdAt: entry.createdAt,
    createdBy: entry.createdBy,
    resolvedAt: entry.resolvedAt,
    resolvedBy: entry.resolvedBy,
    notes: entry.notes,
    linkedBoxes
  };
}

function mapDbFilmOrderLinkRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    orgId: row.org_id,
    linkId: asTrimmedString(row.link_id),
    filmOrderId: asTrimmedString(row.film_order_id),
    boxId: asTrimmedString(row.box_id),
    orderedFeet: integerOrZero(row.ordered_feet),
    autoAllocatedFeet: integerOrZero(row.auto_allocated_feet),
    createdAt: formatTimestamp(row.created_at),
    createdBy: asTrimmedString(row.created_by)
  };
}

function mapDbJobRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    orgId: row.org_id,
    jobNumber: asTrimmedString(row.job_number),
    warehouse: asTrimmedString(row.warehouse),
    sections: asTrimmedString(row.sections) || null,
    dueDate: formatDateValue(row.due_date),
    crewLeader: asTrimmedString(row.crew_leader),
    lifecycleStatus: asTrimmedString(row.lifecycle_status) || 'ACTIVE',
    notes: asTrimmedString(row.notes),
    createdAt: formatTimestamp(row.created_at),
    createdBy: asTrimmedString(row.created_by),
    updatedAt: formatTimestamp(row.updated_at),
    updatedBy: asTrimmedString(row.updated_by)
  };
}

function mapDbRequirementRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    orgId: row.org_id,
    jobId: row.job_id,
    jobNumber: asTrimmedString(row.job_number),
    manufacturer: canonicalizeManufacturerLabel(row.manufacturer),
    filmName: asTrimmedString(row.film_name),
    widthIn: numericOrNull(row.width_in) ?? 0,
    requiredFeet: integerOrZero(row.required_feet),
    notes: asTrimmedString(row.notes),
    createdAt: formatTimestamp(row.created_at),
    createdBy: asTrimmedString(row.created_by),
    updatedAt: formatTimestamp(row.updated_at),
    updatedBy: asTrimmedString(row.updated_by)
  };
}

function mapDbAuditRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    orgId: row.org_id,
    logId: asTrimmedString(row.log_id),
    date: formatTimestamp(row.created_at),
    action: asTrimmedString(row.action),
    boxId: asTrimmedString(row.box_id),
    before: row.before_state || null,
    after: row.after_state || null,
    user: asTrimmedString(row.actor),
    notes: asTrimmedString(row.notes)
  };
}

function mapDbRollHistoryRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    orgId: row.org_id,
    logId: asTrimmedString(row.log_id),
    boxId: asTrimmedString(row.box_id),
    warehouse: asTrimmedString(row.warehouse),
    manufacturer: canonicalizeManufacturerLabel(row.manufacturer),
    filmName: asTrimmedString(row.film_name),
    widthIn: numericOrNull(row.width_in) ?? 0,
    jobNumber: asTrimmedString(row.job_number),
    checkedOutAt: formatTimestamp(row.checked_out_at),
    checkedOutBy: asTrimmedString(row.checked_out_by),
    checkedOutWeightLbs: numericOrNull(row.checked_out_weight_lbs),
    checkedInAt: formatTimestamp(row.checked_in_at),
    checkedInBy: asTrimmedString(row.checked_in_by),
    checkedInWeightLbs: numericOrNull(row.checked_in_weight_lbs),
    weightDeltaLbs: numericOrNull(row.weight_delta_lbs),
    feetBefore: integerOrZero(row.feet_before),
    feetAfter: integerOrZero(row.feet_after),
    notes: asTrimmedString(row.notes)
  };
}

function mapCaulkManufacturerRow(row) {
  if (!row) {
    return null;
  }

  return {
    manufacturerId: asTrimmedString(row.manufacturer_id || row.id),
    name: asTrimmedString(row.name),
    lookupKey: asTrimmedString(row.lookup_key),
    isActive: Boolean(row.is_active),
    updatedAt: formatTimestamp(row.updated_at)
  };
}

function mapCaulkProductRow(row) {
  if (!row) {
    return null;
  }

  return {
    productId: asTrimmedString(row.product_id || row.id),
    manufacturerId: asTrimmedString(row.manufacturer_id),
    manufacturer: asTrimmedString(row.manufacturer),
    productName: asTrimmedString(row.product_name || row.name),
    productCode: asTrimmedString(row.product_code || row.code),
    lookupKey: asTrimmedString(row.lookup_key),
    tubesPerCase: integerOrZero(row.tubes_per_case),
    isActive: Boolean(row.is_active),
    notes: asTrimmedString(row.notes),
    updatedAt: formatTimestamp(row.updated_at)
  };
}

function mapCaulkStockRow(row) {
  if (!row) {
    return null;
  }

  const tubesOnHand = Math.max(0, integerOrZero(row.tubes_on_hand));
  const casesOnHand = Math.floor(tubesOnHand / 16);
  const looseTubes = Math.max(0, tubesOnHand - (casesOnHand * 16));

  return {
    warehouse: asTrimmedString(row.warehouse).toUpperCase(),
    productId: asTrimmedString(row.product_id),
    manufacturerId: asTrimmedString(row.manufacturer_id),
    manufacturer: asTrimmedString(row.manufacturer),
    productName: asTrimmedString(row.product_name),
    productCode: asTrimmedString(row.product_code),
    tubesPerCase: integerOrZero(row.tubes_per_case),
    tubesOnHand,
    casesOnHand,
    looseTubes,
    updatedAt: formatTimestamp(row.updated_at),
    updatedBy: asTrimmedString(row.updated_by)
  };
}

function mapCaulkTransactionRow(row) {
  if (!row) {
    return null;
  }

  return {
    transactionId: asTrimmedString(row.transaction_id),
    productId: asTrimmedString(row.product_id),
    warehouse: asTrimmedString(row.warehouse).toUpperCase(),
    manufacturer: asTrimmedString(row.manufacturer),
    productName: asTrimmedString(row.product_name),
    productCode: asTrimmedString(row.product_code),
    action: asTrimmedString(row.action),
    deltaTubes: integerOrZero(row.delta_tubes),
    resultingTubesOnHand: integerOrZero(row.resulting_tubes_on_hand),
    tubesPerCase: integerOrZero(row.tubes_per_case),
    reason: asTrimmedString(row.reason),
    notes: asTrimmedString(row.notes),
    transferId: asTrimmedString(row.transfer_id),
    sourceBoxId: asTrimmedString(row.source_box_id),
    createdAt: formatTimestamp(row.created_at),
    createdBy: asTrimmedString(row.created_by)
  };
}

function normalizeCaulkCaseMath(result) {
  if (!result || typeof result !== 'object') {
    return result || {};
  }

  const tubesOnHand = Math.max(0, integerOrZero(result.tubesOnHand ?? result.tubes_on_hand));
  const casesOnHand = Math.floor(tubesOnHand / 16);
  const looseTubes = Math.max(0, tubesOnHand - (casesOnHand * 16));

  return {
    ...result,
    tubesOnHand,
    casesOnHand,
    looseTubes
  };
}

function createDeniedFeaturePermissions() {
  return {
    inventory: { read: false, write: false },
    allocations: { read: false, write: false },
    jobs: { read: false, write: false },
    film_orders: { read: false, write: false },
    activity_history: { read: false, write: false },
    reports: { read: false, write: false },
    access_management: { read: false, write: false }
  };
}

function buildOwnerFeaturePermissions() {
  return {
    inventory: { read: true, write: true },
    allocations: { read: true, write: true },
    jobs: { read: true, write: true },
    film_orders: { read: true, write: true },
    activity_history: { read: true, write: true },
    reports: { read: true, write: true },
    access_management: { read: true, write: true }
  };
}

async function ensureGeneralFeaturePermissions(client, orgId, actor = 'system') {
  await client.query(
    `
      insert into app.general_feature_permissions (
        org_id,
        feature_area,
        read_enabled,
        write_enabled,
        updated_at,
        updated_by
      )
      select
        $1::uuid,
        feature_area.value,
        true,
        true,
        now(),
        $2
      from unnest($3::text[]) as feature_area(value)
      on conflict (org_id, feature_area) do nothing
    `,
    [orgId, asTrimmedString(actor), MEMBER_FEATURE_AREAS]
  );
}

async function ensureOwnerNotificationPreference(client, orgId, ownerUserId, actor = 'system') {
  await client.query(
    `
      insert into app.owner_notification_preferences (
        org_id,
        owner_user_id,
        in_app_opt_in,
        email_opt_in,
        updated_at,
        updated_by
      )
      values ($1::uuid, $2::uuid, true, true, now(), $3)
      on conflict (org_id, owner_user_id) do nothing
    `,
    [orgId, ownerUserId, asTrimmedString(actor)]
  );
}

async function getGeneralFeaturePermissions(client, orgId) {
  await ensureGeneralFeaturePermissions(client, orgId, 'backend-access-read');

  const rows = await queryRows(
    client,
    `
      select feature_area, read_enabled, write_enabled
      from app.general_feature_permissions
      where org_id = $1
    `,
    [orgId]
  );

  const mapped = createDeniedFeaturePermissions();
  MEMBER_FEATURE_AREAS.forEach((feature) => {
    mapped[feature] = { read: true, write: true };
  });
  mapped.access_management = { read: false, write: false };

  rows.forEach((row) => {
    const feature = asTrimmedString(row.feature_area);
    if (!(feature in mapped)) {
      return;
    }
    mapped[feature] = {
      read: Boolean(row.read_enabled),
      write: Boolean(row.write_enabled)
    };
  });

  return mapped;
}

async function getMemberEffectiveFeaturePermissionsForUser(client, orgId, userId) {
  const mapped = await getGeneralFeaturePermissions(client, orgId);
  const rows = await queryRows(
    client,
    `
      select feature_area, read_enabled, write_enabled
      from app.admin_feature_permissions
      where org_id = $1
        and admin_user_id = $2::uuid
        and feature_area = any($3::text[])
    `,
    [orgId, userId, MEMBER_FEATURE_AREAS]
  );

  rows.forEach((row) => {
    const feature = asTrimmedString(row.feature_area);
    if (!MEMBER_FEATURE_AREAS.includes(feature)) {
      return;
    }
    mapped[feature] = {
      read: Boolean(row.read_enabled),
      write: Boolean(row.write_enabled)
    };
  });

  mapped.access_management = { read: false, write: false };
  return mapped;
}

async function ensureAdminFeaturePermissions(client, orgId, adminUserId, copyMemberDefaults, actor = 'system') {
  await ensureGeneralFeaturePermissions(client, orgId, actor);
  const generalPermissions = await getGeneralFeaturePermissions(client, orgId);

  for (const feature of ADMIN_FEATURE_AREAS) {
    let readEnabled = true;
    let writeEnabled = true;

    if (copyMemberDefaults && feature !== 'access_management') {
      readEnabled = Boolean(generalPermissions[feature]?.read ?? true);
      writeEnabled = Boolean(generalPermissions[feature]?.write ?? true);
    }

    await client.query(
      `
        insert into app.admin_feature_permissions (
          org_id,
          admin_user_id,
          feature_area,
          read_enabled,
          write_enabled,
          updated_at,
          updated_by
        )
        values ($1::uuid, $2::uuid, $3, $4, $5, now(), $6)
        on conflict (org_id, admin_user_id, feature_area) do nothing
      `,
      [orgId, adminUserId, feature, readEnabled, writeEnabled, asTrimmedString(actor)]
    );
  }
}

async function getAdminFeaturePermissions(client, orgId, adminUserId) {
  await ensureAdminFeaturePermissions(client, orgId, adminUserId, true, 'backend-admin-access-read');
  const generalPermissions = await getGeneralFeaturePermissions(client, orgId);

  const rows = await queryRows(
    client,
    `
      select feature_area, read_enabled, write_enabled
      from app.admin_feature_permissions
      where org_id = $1
        and admin_user_id = $2
    `,
    [orgId, adminUserId]
  );

  const mapped = createDeniedFeaturePermissions();
  MEMBER_FEATURE_AREAS.forEach((feature) => {
    mapped[feature] = {
      read: Boolean(generalPermissions[feature]?.read ?? true),
      write: Boolean(generalPermissions[feature]?.write ?? true)
    };
  });
  mapped.access_management = { read: true, write: true };

  rows.forEach((row) => {
    const feature = asTrimmedString(row.feature_area);
    if (!(feature in mapped)) {
      return;
    }
    mapped[feature] = {
      read: Boolean(row.read_enabled),
      write: Boolean(row.write_enabled)
    };
  });

  return mapped;
}

function inferFeatureForRoute(logicalPath) {
  switch (logicalPath) {
    case '/boxes/search':
    case '/boxes/get':
    case '/boxes/add':
    case '/boxes/update':
    case '/boxes/delete':
    case '/boxes/set-status':
    case '/film-data/catalog':
    case '/inventory/add':
    case '/inventory/scan':
    case '/caulk/manufacturers/list':
    case '/caulk/products/list':
    case '/caulk/stock/list':
    case '/caulk/transactions/list':
    case '/caulk/products/upsert':
    case '/caulk/mutate':
    case '/caulk/transfer':
    case '/owner/caulk/manufacturers/upsert':
      return 'inventory';
    case '/allocations/by-box':
    case '/allocations/jobs':
    case '/allocations/by-job':
    case '/allocations/preview':
    case '/allocations/add':
    case '/allocations/apply':
    case '/allocations/remove-box':
      return 'allocations';
    case '/jobs/list':
    case '/jobs/search':
    case '/jobs/get':
    case '/jobs/create':
    case '/jobs/update':
    case '/jobs/complete':
    case '/jobs/reopen':
      return 'jobs';
    case '/film-orders/list':
    case '/film-orders/create':
    case '/film-orders/cancel':
    case '/film-orders/delete':
      return 'film_orders';
    case '/audit/list':
    case '/audit/by-box':
    case '/audit/undo':
    case '/roll-history/by-box':
    case '/checkout-history':
      return 'activity_history';
    case '/reports/summary':
      return 'reports';
    case '/admin/access/requests':
    case '/admin/access/requests/approve':
    case '/admin/access/requests/deny':
    case '/admin/username-requests':
    case '/admin/username-requests/approve':
    case '/admin/username-requests/deny':
    case '/admin/member-permissions':
    case '/admin/user-permissions':
    case '/admin/roles/promote-member-to-admin':
      return 'access_management';
    default:
      return '';
  }
}

function inferAccessModeForRoute(method, logicalPath) {
  const isReadRoute =
    method === 'GET' ||
    logicalPath === '/allocations/preview' ||
    logicalPath === '/jobs/search' ||
    logicalPath === '/admin/access/requests' ||
    logicalPath === '/admin/username-requests' ||
    logicalPath === '/admin/member-permissions' ||
    logicalPath === '/admin/user-permissions' ||
    logicalPath === '/owner/admin-permissions' ||
    logicalPath === '/owner/notification-preferences' ||
    logicalPath === '/caulk/manufacturers/list' ||
    logicalPath === '/caulk/products/list' ||
    logicalPath === '/caulk/stock/list' ||
    logicalPath === '/caulk/transactions/list';
  return isReadRoute ? 'read' : 'write';
}

function isOwnerOnlyRoute(logicalPath) {
  return (
    logicalPath === '/owner/admin-permissions' ||
    logicalPath === '/owner/roles/demote-admin-to-member' ||
    logicalPath === '/owner/roles/promote-admin-to-owner' ||
    logicalPath === '/owner/notification-preferences' ||
    logicalPath === '/owner/caulk/manufacturers/upsert' ||
    logicalPath === '/jobs/reopen'
  );
}

function isAdminConsoleRoute(logicalPath) {
  return logicalPath.startsWith('/admin/');
}

function mapDatabaseBootstrapError(message) {
  const normalized = asTrimmedString(message).toLowerCase();
  if (
    normalized.includes('relation "app.general_feature_permissions" does not exist') ||
    normalized.includes('relation "app.admin_feature_permissions" does not exist') ||
    normalized.includes('relation "app.access_requests" does not exist') ||
    normalized.includes('relation "app.username_change_requests" does not exist') ||
    normalized.includes('column "requested_by_name" does not exist') ||
    (normalized.includes('function public.api_get_auth_context') && normalized.includes('does not exist'))
  ) {
    return 'Database migrations 0006, 0007, 0008, and 0009 are required. Run 0006_access_control_and_approvals.sql, 0007_access_request_display_name.sql, 0008_username_change_requests.sql, and 0009_user_feature_overrides.sql, then retry.';
  }
  return asTrimmedString(message) || 'Unexpected server error.';
}

function ensureEffectiveRouteAccess(authContext, method, logicalPath) {
  if (logicalPath === '/health' || logicalPath === '/auth/context') {
    return;
  }

  if (logicalPath === '/profile/username') {
    return;
  }

  if (authContext.accessStatus !== 'approved') {
    throw new HttpError(
      403,
      authContext.accessStatus === 'denied'
        ? 'Your access request was denied. Contact an owner for help.'
        : 'Your account is awaiting approval from an admin or owner.'
    );
  }

  if (isOwnerOnlyRoute(logicalPath) && authContext.role !== 'owner') {
    throw new HttpError(403, 'Owner access is required.');
  }

  if (isAdminConsoleRoute(logicalPath)) {
    if (!['owner', 'admin'].includes(authContext.role)) {
      throw new HttpError(403, 'Admin or owner access is required.');
    }
  }

  if (authContext.role === 'owner') {
    return;
  }

  const feature = inferFeatureForRoute(logicalPath);
  if (!feature) {
    return;
  }

  const mode = inferAccessModeForRoute(method, logicalPath);
  const featurePermissions = authContext.permissions?.[feature];
  const allowed = mode === 'read' ? featurePermissions?.read : featurePermissions?.write;

  if (!allowed) {
    throw new HttpError(403, 'Feature access denied.');
  }
}

async function fetchAuthIdentity(token) {
  const cached = authIdentityCache.get(token);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.identity;
  }

  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: SUPABASE_ANON_KEY
    }
  });

  if (!response.ok) {
    return null;
  }

  const payload = await response.json();
  const email = asTrimmedString(payload.email);
  const metadata =
    payload.user_metadata && typeof payload.user_metadata === 'object' ? payload.user_metadata : {};
  const name =
    asTrimmedString(metadata.full_name) ||
    asTrimmedString(metadata.name) ||
    deriveNameFromEmail(email) ||
    'Inventory User';

  const identity = {
    userId: asTrimmedString(payload.id),
    email,
    name,
    token
  };

  authIdentityCache.set(token, {
    expiresAt: Date.now() + 60_000,
    identity
  });

  return identity;
}

async function resolveAuthContext(headers) {
  const authorization = headers.authorization || headers.Authorization || '';
  const token = asTrimmedString(authorization).replace(/^Bearer\s+/i, '');
  if (!token) {
    throw new HttpError(401, 'Authenticated session is required.');
  }

  const identity = await fetchAuthIdentity(token);
  if (!identity || !identity.userId || !identity.email) {
    throw new HttpError(401, 'Authenticated session is required.');
  }

  return withReadClient(async (client) => {
    const memberships = await queryRows(
      client,
      `
        select org_id, role
        from app.organization_members
        where user_id = $1
        order by created_at asc, org_id asc
      `,
      [identity.userId]
    );

    let orgId = DEFAULT_ORG_ID;
    if (!orgId) {
      if (memberships.length === 1) {
        orgId = memberships[0].org_id;
      } else if (memberships.length > 1) {
        throw new HttpError(
          500,
          'DEFAULT_ORG_ID is required because this user belongs to multiple organizations.'
        );
      } else {
        throw new HttpError(
          500,
          'DEFAULT_ORG_ID must be configured before handling pending approvals.'
        );
      }
    }

    if (memberships.length > 0) {
      const found = memberships.some((entry) => entry.org_id === orgId);
      if (!found && DEFAULT_ORG_ID) {
        throw new HttpError(403, 'DEFAULT_ORG_ID is not assigned to the authenticated user.');
      }
    }

    const actor = `${identity.name} <${identity.email}>`;
    const membership = memberships.find((entry) => entry.org_id === orgId) || null;
    await ensureGeneralFeaturePermissions(client, orgId, actor);

    if (!membership) {
      const existingRequest = await queryRow(
        client,
        `
          select status
          from app.access_requests
          where org_id = $1
            and user_id = $2
        `,
        [orgId, identity.userId]
      );

      if (existingRequest && asTrimmedString(existingRequest.status).toLowerCase() === 'denied') {
        return {
          ...identity,
          orgId,
          actor,
          role: '',
          accessStatus: 'denied',
          permissions: createDeniedFeaturePermissions(),
          isAdminConsoleAllowed: false,
          pendingCount: 0,
          receivesInAppNotifications: false,
          pendingRequestCreated: false
        };
      }

      const inserted = await client.query(
        `
          insert into app.access_requests (
            org_id,
            user_id,
            status,
            requested_at,
            requested_by_email,
            requested_by_name
          )
          values ($1::uuid, $2::uuid, 'pending', now(), $3, $4)
          on conflict (org_id, user_id) do nothing
        `,
        [orgId, identity.userId, identity.email, asTrimmedString(identity.name)]
      );

      return {
        ...identity,
        orgId,
        actor,
        role: '',
        accessStatus: 'pending',
        permissions: createDeniedFeaturePermissions(),
        isAdminConsoleAllowed: false,
        pendingCount: 0,
        receivesInAppNotifications: false,
        pendingRequestCreated: inserted.rowCount > 0
      };
    }

    const role = asTrimmedString(membership.role).toLowerCase();
    const normalizedRole = role === 'owner' || role === 'admin' ? role : 'member';

    await client.query(
      `
        insert into app.access_requests (
          org_id,
          user_id,
          status,
          requested_at,
          requested_by_email,
          requested_by_name,
          decided_at,
          decided_by_user_id,
          decided_by_actor,
          decision_note
        )
        values ($1::uuid, $2::uuid, 'approved', now(), $3, $4, now(), $2::uuid, 'auto-approved from membership', '')
        on conflict (org_id, user_id) do nothing
      `,
      [orgId, identity.userId, identity.email, asTrimmedString(identity.name)]
    );

    await client.query(
      `
        update app.access_requests
        set
          status = 'approved',
          decided_at = now(),
          decided_by_user_id = $2::uuid,
          decided_by_actor = 'auto-approved from membership',
          decision_note = ''
        where org_id = $1
          and user_id = $2
          and status <> 'approved'
      `,
      [orgId, identity.userId]
    );

    let permissions = createDeniedFeaturePermissions();
    let isAdminConsoleAllowed = false;
    let receivesInAppNotifications = false;

    if (normalizedRole === 'owner') {
      await ensureOwnerNotificationPreference(client, orgId, identity.userId, actor);
      const preference = await queryRow(
        client,
        `
          select in_app_opt_in
          from app.owner_notification_preferences
          where org_id = $1
            and owner_user_id = $2
        `,
        [orgId, identity.userId]
      );
      permissions = buildOwnerFeaturePermissions();
      isAdminConsoleAllowed = true;
      receivesInAppNotifications = preference ? Boolean(preference.in_app_opt_in) : true;
    } else if (normalizedRole === 'admin') {
      await ensureAdminFeaturePermissions(client, orgId, identity.userId, true, actor);
      permissions = await getAdminFeaturePermissions(client, orgId, identity.userId);
      isAdminConsoleAllowed = Boolean(permissions.access_management?.write);
      receivesInAppNotifications = true;
    } else {
      permissions = await getMemberEffectiveFeaturePermissionsForUser(client, orgId, identity.userId);
      isAdminConsoleAllowed = false;
      receivesInAppNotifications = false;
    }

    let pendingCount = 0;
    if (normalizedRole === 'admin' || (normalizedRole === 'owner' && receivesInAppNotifications)) {
      const pendingRow = await queryRow(
        client,
        `
          select count(*)::int as pending_count
          from app.access_requests
          where org_id = $1
            and status = 'pending'
        `,
        [orgId]
      );
      pendingCount = pendingRow ? integerOrZero(pendingRow.pending_count) : 0;
    }

    return {
      ...identity,
      orgId,
      actor,
      role: normalizedRole,
      accessStatus: 'approved',
      permissions,
      isAdminConsoleAllowed,
      pendingCount,
      receivesInAppNotifications,
      pendingRequestCreated: false
    };
  });
}

async function listWarehouseCodes(client, orgId) {
  const rows = await queryRows(
    client,
    `
      select code
      from app.warehouses
      where org_id = $1
      order by code
    `,
    [orgId]
  );

  return rows
    .map((row) => asTrimmedString(row.code).toUpperCase())
    .filter((code) => code.length > 0);
}

async function requireConfiguredWarehouse(client, orgId, warehouse, fieldName) {
  const normalized = normalizeWarehouseCodeFormat(warehouse, fieldName || 'Warehouse');
  const configured = await listWarehouseCodes(client, orgId);
  if (!configured.includes(normalized)) {
    throw new HttpError(400, `${fieldName || 'Warehouse'} is not configured.`);
  }
  return normalized;
}

async function listCaulkManufacturers(client, orgId) {
  const rows = await queryRows(
    client,
    `
      select
        m.id as manufacturer_id,
        m.name,
        m.lookup_key,
        m.is_active,
        m.updated_at
      from app.caulk_manufacturers m
      where m.org_id = $1::uuid
      order by lower(m.name)
    `,
    [orgId]
  );

  return rows.map(mapCaulkManufacturerRow);
}

async function listCaulkProducts(client, orgId) {
  const rows = await queryRows(
    client,
    `
      select
        p.id as product_id,
        p.manufacturer_id,
        m.name as manufacturer,
        p.name as product_name,
        p.code as product_code,
        p.lookup_key,
        p.tubes_per_case,
        p.is_active,
        p.notes,
        p.updated_at
      from app.caulk_products p
      join app.caulk_manufacturers m
        on m.org_id = p.org_id
       and m.id = p.manufacturer_id
      where p.org_id = $1::uuid
      order by lower(m.name), lower(p.name), lower(p.code)
    `,
    [orgId]
  );

  return rows.map(mapCaulkProductRow);
}

async function listCaulkStock(client, orgId, params) {
  const warehouseFilterRaw = asTrimmedString(params.warehouse).toUpperCase();
  const warehouseFilter =
    warehouseFilterRaw && warehouseFilterRaw !== 'ALL'
      ? await requireConfiguredWarehouse(client, orgId, warehouseFilterRaw, 'Warehouse')
      : '';
  const manufacturerFilter = asTrimmedString(params.manufacturer);
  const queryText = asTrimmedString(params.q);

  const rows = await queryRows(
    client,
    `
      select
        s.warehouse,
        p.id as product_id,
        p.manufacturer_id,
        m.name as manufacturer,
        p.name as product_name,
        p.code as product_code,
        p.tubes_per_case,
        s.tubes_on_hand,
        floor(s.tubes_on_hand::numeric / p.tubes_per_case::numeric)::integer as cases_on_hand,
        mod(s.tubes_on_hand, p.tubes_per_case) as loose_tubes,
        s.updated_at,
        s.updated_by
      from app.caulk_stock s
      join app.caulk_products p
        on p.org_id = s.org_id
       and p.id = s.product_id
      join app.caulk_manufacturers m
        on m.org_id = p.org_id
       and m.id = p.manufacturer_id
      where s.org_id = $1::uuid
        and ($2::text = '' or s.warehouse = $2::text)
        and ($3::text = '' or lower(m.name) = lower($3::text))
        and (
          $4::text = ''
          or p.name ilike ('%' || $4::text || '%')
          or p.code ilike ('%' || $4::text || '%')
          or m.name ilike ('%' || $4::text || '%')
        )
      order by s.warehouse asc, lower(m.name), lower(p.name), lower(p.code)
    `,
    [orgId, warehouseFilter, manufacturerFilter, queryText]
  );

  return rows.map(mapCaulkStockRow);
}

async function listCaulkTransactions(client, orgId, params) {
  const warehouseFilterRaw = asTrimmedString(params.warehouse).toUpperCase();
  const warehouseFilter =
    warehouseFilterRaw && warehouseFilterRaw !== 'ALL'
      ? await requireConfiguredWarehouse(client, orgId, warehouseFilterRaw, 'Warehouse')
      : '';
  const productIdRaw = asTrimmedString(params.productId);
  const productId = productIdRaw ? requireUuid(productIdRaw, 'ProductId') : null;
  const limitValue = Number(params.limit);
  const limit = Number.isFinite(limitValue) && limitValue > 0 ? Math.min(Math.trunc(limitValue), 1000) : 200;

  const rows = await queryRows(
    client,
    `
      select
        t.transaction_id,
        t.product_id,
        t.warehouse,
        m.name as manufacturer,
        p.name as product_name,
        p.code as product_code,
        t.action,
        t.delta_tubes,
        t.resulting_tubes_on_hand,
        t.tubes_per_case,
        t.reason,
        t.notes,
        t.transfer_id,
        t.source_box_id,
        t.created_at,
        t.created_by
      from app.caulk_transactions t
      join app.caulk_products p
        on p.org_id = t.org_id
       and p.id = t.product_id
      join app.caulk_manufacturers m
        on m.org_id = p.org_id
       and m.id = p.manufacturer_id
      where t.org_id = $1::uuid
        and ($2::text = '' or t.warehouse = $2::text)
        and ($3::uuid is null or t.product_id = $3::uuid)
      order by t.created_at desc
      limit $4::integer
    `,
    [orgId, warehouseFilter, productId, limit]
  );

  return rows.map(mapCaulkTransactionRow);
}

async function ownerUpsertCaulkManufacturer(client, orgId, actor, payload) {
  const name = requireString(payload.name, 'Name');
  const isActive = payload.isActive === undefined ? true : parseBooleanFlag(payload.isActive);
  const row = await queryRow(
    client,
    `
      select *
      from app_api.caulk_upsert_manufacturer($1::uuid, $2::text, $3::text, $4::boolean)
    `,
    [orgId, actor, name, isActive]
  );

  return mapCaulkManufacturerRow(row);
}

async function upsertCaulkProduct(client, orgId, actor, payload) {
  const productIdRaw = asTrimmedString(payload.productId);
  const productId = productIdRaw ? requireUuid(productIdRaw, 'ProductId') : null;
  const manufacturerId = requireUuid(payload.manufacturerId, 'ManufacturerId');
  const productName = requireString(payload.productName, 'ProductName');
  const productCode = asTrimmedString(payload.productCode);
  const notes = asTrimmedString(payload.notes);
  const isActive = payload.isActive === undefined ? true : parseBooleanFlag(payload.isActive);
  const tubesPerCaseValue = payload.tubesPerCase === undefined ? 16 : payload.tubesPerCase;
  const tubesPerCase = parseIntegerInput(tubesPerCaseValue, 'TubesPerCase');
  if (tubesPerCase <= 0) {
    throw new HttpError(400, 'TubesPerCase must be greater than zero.');
  }

  const row = await queryRow(
    client,
    `
      select *
      from app_api.caulk_upsert_product(
        $1::uuid,
        $2::text,
        $3::uuid,
        $4::uuid,
        $5::text,
        $6::text,
        $7::integer,
        $8::boolean,
        $9::text
      )
    `,
    [orgId, actor, productId, manufacturerId, productName, productCode, tubesPerCase, isActive, notes]
  );
  const product = mapCaulkProductRow(row);
  const manufacturer = await queryRow(
    client,
    `
      select name
      from app.caulk_manufacturers
      where org_id = $1::uuid
        and id = $2::uuid
    `,
    [orgId, manufacturerId]
  );
  if (product) {
    product.manufacturer = asTrimmedString(manufacturer?.name);
  }
  return product;
}

async function getCaulkProductTubesPerCase(client, orgId, productId) {
  const row = await queryRow(
    client,
    `
      select tubes_per_case
      from app.caulk_products
      where org_id = $1::uuid
        and id = $2::uuid
    `,
    [orgId, productId]
  );
  if (!row) {
    throw new HttpError(404, 'Caulk product was not found.');
  }
  const tubesPerCase = integerOrZero(row.tubes_per_case);
  if (tubesPerCase <= 0) {
    throw new HttpError(400, 'Caulk product tubes-per-case must be greater than zero.');
  }
  return tubesPerCase;
}

async function applyCaulkDelta(
  client,
  orgId,
  actor,
  productId,
  warehouse,
  action,
  deltaTubes,
  reason,
  transferId = '',
  sourceBoxId = '',
  notes = ''
) {
  const row = await queryRow(
    client,
    `
      select app_api.caulk_apply_stock_delta(
        $1::uuid,
        $2::text,
        $3::uuid,
        $4::text,
        $5::text,
        $6::integer,
        $7::text,
        $8::text,
        $9::text,
        $10::text
      ) as result
    `,
    [orgId, actor, productId, warehouse, action, deltaTubes, reason, transferId, sourceBoxId, notes]
  );

  return normalizeCaulkCaseMath(row?.result || {});
}

async function mutateCaulkStock(client, orgId, actor, payload) {
  const action = requireString(payload.action, 'Action').toUpperCase();
  if (!['RECEIVE', 'USE', 'ADJUST'].includes(action)) {
    throw new HttpError(400, 'Action must be RECEIVE, USE, or ADJUST.');
  }

  const productId = requireUuid(payload.productId, 'ProductId');
  const warehouse = await requireConfiguredWarehouse(client, orgId, payload.warehouse, 'Warehouse');
  const tubesPerCase = await getCaulkProductTubesPerCase(client, orgId, productId);
  const cases = payload.cases === undefined || payload.cases === '' ? 0 : parseIntegerInput(payload.cases, 'Cases');
  const tubes = payload.tubes === undefined || payload.tubes === '' ? 0 : parseIntegerInput(payload.tubes, 'Tubes');
  const deltaOverride =
    payload.deltaTubes === undefined || payload.deltaTubes === ''
      ? null
      : parseIntegerInput(payload.deltaTubes, 'DeltaTubes');
  const reason = asTrimmedString(payload.reason) || action;
  const notes = asTrimmedString(payload.notes);

  let delta = deltaOverride !== null ? deltaOverride : (cases * tubesPerCase) + tubes;
  if (action === 'RECEIVE') {
    if (delta <= 0) {
      throw new HttpError(400, 'Receive requires a positive quantity.');
    }
    return applyCaulkDelta(client, orgId, actor, productId, warehouse, 'RECEIVE', delta, reason, '', '', notes);
  }
  if (action === 'USE') {
    if (delta <= 0) {
      throw new HttpError(400, 'Use requires a positive quantity.');
    }
    return applyCaulkDelta(client, orgId, actor, productId, warehouse, 'USE', -delta, reason, '', '', notes);
  }

  if (delta === 0) {
    throw new HttpError(400, 'Adjust requires a non-zero delta.');
  }
  return applyCaulkDelta(client, orgId, actor, productId, warehouse, 'ADJUST', delta, reason, '', '', notes);
}

async function transferCaulkStock(client, orgId, actor, payload) {
  const productId = requireUuid(payload.productId, 'ProductId');
  const fromWarehouse = await requireConfiguredWarehouse(client, orgId, payload.fromWarehouse, 'FromWarehouse');
  const toWarehouse = await requireConfiguredWarehouse(client, orgId, payload.toWarehouse, 'ToWarehouse');
  if (fromWarehouse === toWarehouse) {
    throw new HttpError(400, 'Transfer source and destination warehouse must differ.');
  }

  const tubesPerCase = await getCaulkProductTubesPerCase(client, orgId, productId);
  const cases = payload.cases === undefined || payload.cases === '' ? 0 : parseIntegerInput(payload.cases, 'Cases');
  const tubes = payload.tubes === undefined || payload.tubes === '' ? 0 : parseIntegerInput(payload.tubes, 'Tubes');
  const deltaOverride =
    payload.deltaTubes === undefined || payload.deltaTubes === ''
      ? null
      : parseIntegerInput(payload.deltaTubes, 'DeltaTubes');
  const reason = asTrimmedString(payload.reason) || 'TRANSFER';
  const notes = asTrimmedString(payload.notes);
  const delta = deltaOverride !== null ? deltaOverride : (cases * tubesPerCase) + tubes;
  if (delta <= 0) {
    throw new HttpError(400, 'Transfer requires a positive quantity.');
  }

  const transferRow = await queryRow(client, 'select app_api.caulk_create_transaction_id() as transfer_id');
  const transferId = asTrimmedString(transferRow?.transfer_id);
  const from = await applyCaulkDelta(
    client,
    orgId,
    actor,
    productId,
    fromWarehouse,
    'TRANSFER_OUT',
    -delta,
    reason,
    transferId,
    '',
    notes
  );
  const to = await applyCaulkDelta(
    client,
    orgId,
    actor,
    productId,
    toWarehouse,
    'TRANSFER_IN',
    delta,
    reason,
    transferId,
    '',
    notes
  );

  return {
    transferId,
    movedTubes: delta,
    from,
    to
  };
}

async function resolveBoxIdAlias(client, orgId, boxId) {
  const trimmed = requireString(boxId, 'BoxID').toUpperCase();
  const row = await queryRow(
    client,
    `
      select app_api.resolve_box_id_alias($1::uuid, $2::text) as box_id
    `,
    [orgId, trimmed]
  );
  return asTrimmedString(row?.box_id) || trimmed;
}

async function resolveWarehouseFromBoxId(client, orgId, boxId) {
  const normalizedBoxId = requireString(boxId, 'BoxID').toUpperCase();
  const row = await queryRow(
    client,
    `
      select app_api.resolve_warehouse_from_box_id($1::uuid, $2::text) as warehouse
    `,
    [orgId, normalizedBoxId]
  );
  const resolved = asTrimmedString(row?.warehouse).toUpperCase();
  if (!resolved) {
    throw new HttpError(400, 'Unable to resolve warehouse from BoxID.');
  }
  return resolved;
}

async function listBoxes(client, orgId) {
  const rows = await queryRows(
    client,
    `
      select *
      from app.boxes
      where org_id = $1
    `,
    [orgId]
  );

  return rows.map(mapDbBoxRow);
}

async function findBoxById(client, orgId, boxId) {
  const canonicalBoxId = await resolveBoxIdAlias(client, orgId, boxId);
  const row = await queryRow(
    client,
    `
      select *
      from app.boxes
      where org_id = $1
        and box_id = $2
    `,
    [orgId, canonicalBoxId]
  );

  return mapDbBoxRow(row);
}

async function saveBoxRecord(client, orgId, box) {
  const canonical = await resolveCanonicalFilmEntry(client, orgId, box.manufacturer, box.filmName);
  const manufacturer = canonical.manufacturer;
  const filmName = canonical.filmName;
  const filmKey = normalizeFilmKeyInput(manufacturer, filmName, box.filmKey);
  const row = await queryRow(
    client,
    `
      insert into app.boxes (
        org_id,
        box_id,
        warehouse,
        manufacturer,
        film_name,
        width_in,
        initial_feet,
        feet_available,
        lot_run,
        status,
        order_date,
        received_date,
        initial_weight_lbs,
        last_roll_weight_lbs,
        last_weighed_date,
        film_key,
        core_type,
        core_weight_lbs,
        lf_weight_lbs_per_ft,
        purchase_cost,
        notes,
        has_ever_been_checked_out,
        last_checkout_job,
        last_checkout_date,
        zeroed_date,
        zeroed_reason,
        zeroed_by
      )
      values (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
        nullif($12, '')::date,
        $13,$14,
        nullif($15, '')::date,
        $16,$17,$18,$19,$20,$21,$22,$23,
        nullif($24, '')::date,
        nullif($25, '')::date,
        $26,$27
      )
      on conflict (org_id, box_id) do update set
        warehouse = excluded.warehouse,
        manufacturer = excluded.manufacturer,
        film_name = excluded.film_name,
        width_in = excluded.width_in,
        initial_feet = excluded.initial_feet,
        feet_available = excluded.feet_available,
        lot_run = excluded.lot_run,
        status = excluded.status,
        order_date = excluded.order_date,
        received_date = excluded.received_date,
        initial_weight_lbs = excluded.initial_weight_lbs,
        last_roll_weight_lbs = excluded.last_roll_weight_lbs,
        last_weighed_date = excluded.last_weighed_date,
        film_key = excluded.film_key,
        core_type = excluded.core_type,
        core_weight_lbs = excluded.core_weight_lbs,
        lf_weight_lbs_per_ft = excluded.lf_weight_lbs_per_ft,
        purchase_cost = excluded.purchase_cost,
        notes = excluded.notes,
        has_ever_been_checked_out = excluded.has_ever_been_checked_out,
        last_checkout_job = excluded.last_checkout_job,
        last_checkout_date = excluded.last_checkout_date,
        zeroed_date = excluded.zeroed_date,
        zeroed_reason = excluded.zeroed_reason,
        zeroed_by = excluded.zeroed_by
      returning *
    `,
    [
      orgId,
      box.boxId,
      box.warehouse,
      manufacturer,
      filmName,
      box.widthIn,
      box.initialFeet,
      box.feetAvailable,
      box.lotRun,
      box.status,
      box.orderDate,
      box.receivedDate,
      box.initialWeightLbs,
      box.lastRollWeightLbs,
      box.lastWeighedDate,
      filmKey,
      box.coreType,
      box.coreWeightLbs,
      box.lfWeightLbsPerFt,
      box.purchaseCost,
      box.notes,
      box.hasEverBeenCheckedOut,
      box.lastCheckoutJob,
      box.lastCheckoutDate,
      box.zeroedDate,
      box.zeroedReason,
      box.zeroedBy
    ]
  );

  return mapDbBoxRow(row);
}

async function deleteBoxRecord(client, orgId, boxId) {
  await client.query(
    `
      delete from app.boxes
      where org_id = $1
        and box_id = $2
    `,
    [orgId, boxId]
  );
}

async function listFilmCatalog(client, orgId) {
  const rows = await queryRows(
    client,
    `
      select *
      from app.film_catalog
      where org_id = $1
      order by manufacturer asc, film_name asc, film_key asc
    `,
    [orgId]
  );

  return rows.map(mapDbFilmCatalogRow);
}

async function findFilmCatalogByFilmKey(client, orgId, filmKey) {
  const row = await queryRow(
    client,
    `
      select *
      from app.film_catalog
      where org_id = $1
        and film_key = $2
    `,
    [orgId, filmKey]
  );

  return mapDbFilmCatalogRow(row);
}

async function seedFilmCatalogRecordIfMissing(client, orgId, record) {
  const normalizedFilmKey = asTrimmedString(record.filmKey).toUpperCase();
  const normalizedManufacturer = canonicalizeManufacturerLabel(record.manufacturer);
  const normalizedFilmName = normalizeCollapsedCatalogLabel(record.filmName);
  const normalizedSourceBoxId = asTrimmedString(record.sourceBoxId);

  if (!normalizedFilmKey || !normalizedManufacturer || !normalizedFilmName) {
    return;
  }

  await client.query(
    `
      insert into app.film_catalog (
        org_id,
        film_key,
        manufacturer,
        film_name,
        source_box_id,
        notes,
        updated_at
      )
      values ($1,$2,$3,$4,$5,'', now())
      on conflict (org_id, film_key) do nothing
    `,
    [orgId, normalizedFilmKey, normalizedManufacturer, normalizedFilmName, normalizedSourceBoxId]
  );
}

async function upsertFilmCatalogRecord(client, orgId, record) {
  const canonical = await resolveCanonicalFilmEntry(client, orgId, record.manufacturer, record.filmName);
  const manufacturer = canonical.manufacturer;
  const filmName = canonical.filmName;
  const filmKey = normalizeFilmKeyInput(manufacturer, filmName, record.filmKey);
  const row = await queryRow(
    client,
    `
      insert into app.film_catalog (
        org_id,
        film_key,
        manufacturer,
        film_name,
        sq_ft_weight_lbs_per_sq_ft,
        default_core_type,
        source_width_in,
        source_initial_feet,
        source_initial_weight_lbs,
        source_box_id,
        notes,
        updated_at
      )
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, coalesce($12::timestamptz, now()))
      on conflict (org_id, film_key) do update set
        manufacturer = excluded.manufacturer,
        film_name = excluded.film_name,
        sq_ft_weight_lbs_per_sq_ft = excluded.sq_ft_weight_lbs_per_sq_ft,
        default_core_type = excluded.default_core_type,
        source_width_in = excluded.source_width_in,
        source_initial_feet = excluded.source_initial_feet,
        source_initial_weight_lbs = excluded.source_initial_weight_lbs,
        source_box_id = excluded.source_box_id,
        notes = excluded.notes,
        updated_at = excluded.updated_at
      returning *
    `,
    [
      orgId,
      filmKey,
      manufacturer,
      filmName,
      record.sqFtWeightLbsPerSqFt,
      record.defaultCoreType,
      record.sourceWidthIn,
      record.sourceInitialFeet,
      record.sourceInitialWeightLbs,
      record.sourceBoxId,
      record.notes,
      record.updatedAt || new Date().toISOString()
    ]
  );

  return mapDbFilmCatalogRow(row);
}

async function listAllocations(client, orgId) {
  const rows = await queryRows(
    client,
    `
      select *
      from app.allocations
      where org_id = $1
      order by created_at desc, allocation_id desc
    `,
    [orgId]
  );

  return rows.map(mapDbAllocationRow);
}

async function listAllocationsByBox(client, orgId, boxId) {
  const canonicalBoxId = await resolveBoxIdAlias(client, orgId, boxId);
  const rows = await queryRows(
    client,
    `
      select *
      from app.allocations
      where org_id = $1
        and box_id = $2
      order by created_at desc, allocation_id desc
    `,
    [orgId, canonicalBoxId]
  );

  return rows.map(mapDbAllocationRow);
}

async function listAllocationsByJob(client, orgId, jobNumber) {
  const rows = await queryRows(
    client,
    `
      select *
      from app.allocations
      where org_id = $1
        and upper(trim(job_number)) = upper(trim($2))
      order by created_at desc, allocation_id desc
    `,
    [orgId, jobNumber]
  );

  return rows.map(mapDbAllocationRow);
}

async function listAllocationsByFilmOrderId(client, orgId, filmOrderId) {
  const rows = await queryRows(
    client,
    `
      select *
      from app.allocations
      where org_id = $1
        and film_order_id = $2
      order by created_at desc, allocation_id desc
    `,
    [orgId, filmOrderId]
  );

  return rows.map(mapDbAllocationRow);
}

async function listActiveAllocations(client, orgId) {
  const rows = await queryRows(
    client,
    `
      select *
      from app.allocations
      where org_id = $1
        and status = 'ACTIVE'
      order by created_at desc, allocation_id desc
    `,
    [orgId]
  );

  return rows.map(mapDbAllocationRow);
}

async function saveAllocationRecord(client, orgId, entry) {
  const row = await queryRow(
    client,
    `
      insert into app.allocations (
        org_id,
        allocation_id,
        box_id,
        job_id,
        job_number,
        warehouse,
        job_date,
        allocated_feet,
        status,
        created_at,
        created_by,
        resolved_at,
        resolved_by,
        notes,
        crew_leader,
        film_order_id
      )
      values (
        $1,$2,$3,$4,$5,$6,
        nullif($7, '')::date,
        $8,$9,
        coalesce($10::timestamptz, now()),
        $11,
        nullif($12, '')::timestamptz,
        $13,$14,$15,$16
      )
      on conflict (org_id, allocation_id) do update set
        box_id = excluded.box_id,
        job_id = excluded.job_id,
        job_number = excluded.job_number,
        warehouse = excluded.warehouse,
        job_date = excluded.job_date,
        allocated_feet = excluded.allocated_feet,
        status = excluded.status,
        created_at = excluded.created_at,
        created_by = excluded.created_by,
        resolved_at = excluded.resolved_at,
        resolved_by = excluded.resolved_by,
        notes = excluded.notes,
        crew_leader = excluded.crew_leader,
        film_order_id = excluded.film_order_id
      returning *
    `,
    [
      orgId,
      entry.allocationId,
      entry.boxId,
      entry.jobId,
      entry.jobNumber,
      entry.warehouse,
      entry.jobDate,
      entry.allocatedFeet,
      entry.status,
      entry.createdAt,
      entry.createdBy,
      entry.resolvedAt,
      entry.resolvedBy,
      entry.notes,
      entry.crewLeader,
      entry.filmOrderId
    ]
  );

  return mapDbAllocationRow(row);
}

async function listFilmOrders(client, orgId) {
  const rows = await queryRows(
    client,
    `
      select *
      from app.film_orders
      where org_id = $1
      order by created_at desc, film_order_id desc
    `,
    [orgId]
  );

  return rows.map(mapDbFilmOrderRow);
}

async function listFilmOrdersByJob(client, orgId, jobNumber) {
  const rows = await queryRows(
    client,
    `
      select *
      from app.film_orders
      where org_id = $1
        and upper(trim(job_number)) = upper(trim($2))
      order by created_at desc, film_order_id desc
    `,
    [orgId, jobNumber]
  );

  return rows.map(mapDbFilmOrderRow);
}

async function findFilmOrderById(client, orgId, filmOrderId) {
  const row = await queryRow(
    client,
    `
      select *
      from app.film_orders
      where org_id = $1
        and film_order_id = $2
    `,
    [orgId, filmOrderId]
  );

  return mapDbFilmOrderRow(row);
}

async function saveFilmOrderRecord(client, orgId, entry) {
  const canonical = await resolveCanonicalFilmEntry(client, orgId, entry.manufacturer, entry.filmName);
  const manufacturer = canonical.manufacturer;
  const filmName = canonical.filmName;
  const row = await queryRow(
    client,
    `
      insert into app.film_orders (
        org_id,
        film_order_id,
        job_id,
        job_number,
        warehouse,
        manufacturer,
        film_name,
        width_in,
        requested_feet,
        covered_feet,
        ordered_feet,
        remaining_to_order_feet,
        job_date,
        crew_leader,
        status,
        source_box_id,
        resolved_at,
        resolved_by,
        notes,
        created_at,
        created_by
      )
      values (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
        nullif($13, '')::date,
        $14,$15,$16,
        nullif($17, '')::timestamptz,
        $18,$19,
        coalesce($20::timestamptz, now()),
        $21
      )
      on conflict (org_id, film_order_id) do update set
        job_id = excluded.job_id,
        job_number = excluded.job_number,
        warehouse = excluded.warehouse,
        manufacturer = excluded.manufacturer,
        film_name = excluded.film_name,
        width_in = excluded.width_in,
        requested_feet = excluded.requested_feet,
        covered_feet = excluded.covered_feet,
        ordered_feet = excluded.ordered_feet,
        remaining_to_order_feet = excluded.remaining_to_order_feet,
        job_date = excluded.job_date,
        crew_leader = excluded.crew_leader,
        status = excluded.status,
        source_box_id = excluded.source_box_id,
        resolved_at = excluded.resolved_at,
        resolved_by = excluded.resolved_by,
        notes = excluded.notes,
        created_at = excluded.created_at,
        created_by = excluded.created_by
      returning *
    `,
    [
      orgId,
      entry.filmOrderId,
      entry.jobId,
      entry.jobNumber,
      entry.warehouse,
      manufacturer,
      filmName,
      entry.widthIn,
      entry.requestedFeet,
      entry.coveredFeet,
      entry.orderedFeet,
      entry.remainingToOrderFeet,
      entry.jobDate,
      entry.crewLeader,
      entry.status,
      entry.sourceBoxId,
      entry.resolvedAt,
      entry.resolvedBy,
      entry.notes,
      entry.createdAt,
      entry.createdBy
    ]
  );

  return mapDbFilmOrderRow(row);
}

async function deleteFilmOrderRecord(client, orgId, filmOrderId) {
  await client.query(
    `
      delete from app.film_orders
      where org_id = $1
        and film_order_id = $2
    `,
    [orgId, filmOrderId]
  );
}

async function listFilmOrderLinks(client, orgId) {
  const rows = await queryRows(
    client,
    `
      select *
      from app.film_order_box_links
      where org_id = $1
      order by created_at desc, link_id desc
    `,
    [orgId]
  );

  return rows.map(mapDbFilmOrderLinkRow);
}

async function listFilmOrderLinksByFilmOrderId(client, orgId, filmOrderId) {
  const rows = await queryRows(
    client,
    `
      select *
      from app.film_order_box_links
      where org_id = $1
        and film_order_id = $2
      order by created_at desc, link_id desc
    `,
    [orgId, filmOrderId]
  );

  return rows.map(mapDbFilmOrderLinkRow);
}

async function listFilmOrderLinksByBoxId(client, orgId, boxId) {
  const canonicalBoxId = await resolveBoxIdAlias(client, orgId, boxId);
  const rows = await queryRows(
    client,
    `
      select *
      from app.film_order_box_links
      where org_id = $1
        and box_id = $2
      order by created_at desc, link_id desc
    `,
    [orgId, canonicalBoxId]
  );

  return rows.map(mapDbFilmOrderLinkRow);
}

async function saveFilmOrderLinkRecord(client, orgId, link) {
  const row = await queryRow(
    client,
    `
      insert into app.film_order_box_links (
        org_id,
        link_id,
        film_order_id,
        box_id,
        ordered_feet,
        auto_allocated_feet,
        created_at,
        created_by
      )
      values ($1,$2,$3,$4,$5,$6,coalesce($7::timestamptz, now()),$8)
      on conflict (org_id, link_id) do update set
        film_order_id = excluded.film_order_id,
        box_id = excluded.box_id,
        ordered_feet = excluded.ordered_feet,
        auto_allocated_feet = excluded.auto_allocated_feet,
        created_at = excluded.created_at,
        created_by = excluded.created_by
      returning *
    `,
    [
      orgId,
      link.linkId,
      link.filmOrderId,
      link.boxId,
      link.orderedFeet,
      link.autoAllocatedFeet,
      link.createdAt,
      link.createdBy
    ]
  );

  return mapDbFilmOrderLinkRow(row);
}

async function deleteFilmOrderLinksByFilmOrderId(client, orgId, filmOrderId) {
  await client.query(
    `
      delete from app.film_order_box_links
      where org_id = $1
        and film_order_id = $2
    `,
    [orgId, filmOrderId]
  );
}

async function listJobs(client, orgId) {
  const rows = await queryRows(
    client,
    `
      select *
      from app.jobs
      where org_id = $1
      order by due_date desc nulls last, updated_at desc, job_number desc
    `,
    [orgId]
  );

  return rows.map(mapDbJobRow);
}

async function findJobByNumber(client, orgId, jobNumber) {
  const row = await queryRow(
    client,
    `
      select *
      from app.jobs
      where org_id = $1
        and upper(trim(job_number)) = upper(trim($2))
    `,
    [orgId, jobNumber]
  );

  return mapDbJobRow(row);
}

async function saveJobRecord(client, orgId, job) {
  const row = await queryRow(
    client,
    `
      insert into app.jobs (
        org_id,
        job_number,
        warehouse,
        sections,
        due_date,
        crew_leader,
        lifecycle_status,
        notes,
        created_at,
        created_by,
        updated_at,
        updated_by
      )
      values (
        $1,$2,$3,$4,
        nullif($5, '')::date,
        $6,$7,$8,
        coalesce($9::timestamptz, now()),
        $10,
        coalesce($11::timestamptz, now()),
        $12
      )
      on conflict (org_id, job_number) do update set
        warehouse = excluded.warehouse,
        sections = excluded.sections,
        due_date = excluded.due_date,
        crew_leader = excluded.crew_leader,
        lifecycle_status = excluded.lifecycle_status,
        notes = excluded.notes,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
      returning *
    `,
    [
      orgId,
      job.jobNumber,
      job.warehouse,
      job.sections,
      job.dueDate,
      job.crewLeader,
      job.lifecycleStatus,
      job.notes,
      job.createdAt,
      job.createdBy,
      job.updatedAt,
      job.updatedBy
    ]
  );

  return mapDbJobRow(row);
}

async function listJobRequirements(client, orgId) {
  const rows = await queryRows(
    client,
    `
      select r.*, j.job_number
      from app.job_requirements r
      join app.jobs j on j.id = r.job_id
      where r.org_id = $1
      order by j.job_number asc, r.manufacturer asc, r.film_name asc, r.width_in asc
    `,
    [orgId]
  );

  return rows.map(mapDbRequirementRow);
}

async function listJobRequirementsByJob(client, orgId, jobNumber) {
  const rows = await queryRows(
    client,
    `
      select r.*, j.job_number
      from app.job_requirements r
      join app.jobs j on j.id = r.job_id
      where r.org_id = $1
        and upper(trim(j.job_number)) = upper(trim($2))
      order by r.manufacturer asc, r.film_name asc, r.width_in asc
    `,
    [orgId, jobNumber]
  );

  return rows.map(mapDbRequirementRow);
}

async function replaceJobRequirementsForJob(client, orgId, jobHeader, entries) {
  await client.query(
    `
      delete from app.job_requirements
      where org_id = $1
        and job_id = $2
    `,
    [orgId, jobHeader.id]
  );

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const canonical = await resolveCanonicalFilmEntry(client, orgId, entry.manufacturer, entry.filmName);
    const manufacturer = canonical.manufacturer;
    const filmName = canonical.filmName;
    await client.query(
      `
        insert into app.job_requirements (
          id,
          org_id,
          job_id,
          manufacturer,
          film_name,
          width_in,
          required_feet,
          notes,
          created_at,
          created_by,
          updated_at,
          updated_by
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz,$10,$11::timestamptz,$12)
      `,
      [
        entry.id || crypto.randomUUID(),
        orgId,
        jobHeader.id,
        manufacturer,
        filmName,
        entry.widthIn,
        entry.requiredFeet,
        entry.notes || '',
        entry.createdAt || new Date().toISOString(),
        entry.createdBy || '',
        entry.updatedAt || new Date().toISOString(),
        entry.updatedBy || ''
      ]
    );
  }
}

async function listAuditEntries(client, orgId) {
  const rows = await queryRows(
    client,
    `
      select *
      from app.audit_log
      where org_id = $1
      order by created_at desc, log_id desc
    `,
    [orgId]
  );

  return rows.map(mapDbAuditRow);
}

async function listAuditEntriesByBox(client, orgId, boxId) {
  const canonicalBoxId = await resolveBoxIdAlias(client, orgId, boxId);
  const rows = await queryRows(
    client,
    `
      select *
      from app.audit_log
      where org_id = $1
        and box_id = $2
      order by created_at desc, log_id desc
    `,
    [orgId, canonicalBoxId]
  );

  return rows.map(mapDbAuditRow);
}

async function findAuditEntryByLogId(client, orgId, logId) {
  const row = await queryRow(
    client,
    `
      select *
      from app.audit_log
      where org_id = $1
        and log_id = $2
    `,
    [orgId, logId]
  );

  return mapDbAuditRow(row);
}

async function appendAuditEntry(client, orgId, action, boxId, beforeState, afterState, actor, notes) {
  const logId = createLogId();
  await client.query(
    `
      insert into app.audit_log (
        org_id,
        log_id,
        action,
        box_id,
        before_state,
        after_state,
        actor,
        notes,
        created_at
      )
      values ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9::timestamptz)
    `,
    [
      orgId,
      logId,
      action,
      boxId,
      beforeState === null ? null : JSON.stringify(beforeState),
      afterState === null ? null : JSON.stringify(afterState),
      actor,
      asTrimmedString(notes),
      new Date().toISOString()
    ]
  );
  return logId;
}

async function listRollHistoryByBox(client, orgId, boxId) {
  const canonicalBoxId = await resolveBoxIdAlias(client, orgId, boxId);
  const rows = await queryRows(
    client,
    `
      select *
      from app.roll_weight_log
      where org_id = $1
        and box_id = $2
      order by checked_in_at desc nulls last, checked_out_at desc nulls last, log_id desc
    `,
    [orgId, canonicalBoxId]
  );

  return rows.map(mapDbRollHistoryRow);
}

async function listRollHistoryByJob(client, orgId, jobNumber) {
  const rows = await queryRows(
    client,
    `
      select *
      from app.roll_weight_log
      where org_id = $1
        and upper(trim(job_number)) = upper(trim($2))
      order by checked_in_at desc nulls last, checked_out_at desc nulls last, log_id desc
    `,
    [orgId, jobNumber]
  );

  return rows.map(mapDbRollHistoryRow);
}

function toUsageTimestampSortValue(entry) {
  return asTrimmedString(entry.checkedInAt) || asTrimmedString(entry.checkedOutAt) || '';
}

function buildPublicJobUsageEntries(rollHistoryEntries, boxById) {
  const grouped = {};
  const normalizedEntries = Array.isArray(rollHistoryEntries) ? rollHistoryEntries : [];

  for (let index = 0; index < normalizedEntries.length; index += 1) {
    const entry = normalizedEntries[index];
    if (!entry || !entry.boxId) {
      continue;
    }

    const usedFeet = Math.max(integerOrZero(entry.feetBefore) - integerOrZero(entry.feetAfter), 0);
    const timestampSortValue = toUsageTimestampSortValue(entry);
    const box = boxById[entry.boxId] || null;
    const rollEntryNormalized = normalizeSecurityManufacturerAndFilm(entry.manufacturer, entry.filmName);

    if (!grouped[entry.boxId]) {
      grouped[entry.boxId] = {
        boxId: entry.boxId,
        manufacturer: box ? box.manufacturer : rollEntryNormalized.manufacturer,
        filmName: box ? box.filmName : rollEntryNormalized.filmName,
        widthIn: box ? box.widthIn : numericOrNull(entry.widthIn) ?? 0,
        usedFeet: 0,
        usageEventCount: 0,
        latestCheckedInAt: '',
        latestCheckedOutAt: '',
        lastActivityAt: ''
      };
    }

    grouped[entry.boxId].usedFeet += usedFeet;
    grouped[entry.boxId].usageEventCount += 1;

    if (asTrimmedString(entry.checkedInAt) > grouped[entry.boxId].latestCheckedInAt) {
      grouped[entry.boxId].latestCheckedInAt = asTrimmedString(entry.checkedInAt);
    }

    if (asTrimmedString(entry.checkedOutAt) > grouped[entry.boxId].latestCheckedOutAt) {
      grouped[entry.boxId].latestCheckedOutAt = asTrimmedString(entry.checkedOutAt);
    }

    if (timestampSortValue > grouped[entry.boxId].lastActivityAt) {
      grouped[entry.boxId].lastActivityAt = timestampSortValue;
    }
  }

  const response = Object.values(grouped);
  response.sort((left, right) => {
    if (left.lastActivityAt !== right.lastActivityAt) {
      return left.lastActivityAt > right.lastActivityAt ? -1 : 1;
    }

    return left.boxId < right.boxId ? -1 : left.boxId > right.boxId ? 1 : 0;
  });

  return response;
}

async function appendRollHistoryEntry(client, orgId, entry) {
  const normalized = normalizeSecurityManufacturerAndFilm(entry.manufacturer, entry.filmName);
  const manufacturer = normalized.manufacturer;
  const filmName = normalized.filmName;
  await client.query(
    `
      insert into app.roll_weight_log (
        org_id,
        log_id,
        box_id,
        warehouse,
        manufacturer,
        film_name,
        width_in,
        job_number,
        checked_out_at,
        checked_out_by,
        checked_out_weight_lbs,
        checked_in_at,
        checked_in_by,
        checked_in_weight_lbs,
        weight_delta_lbs,
        feet_before,
        feet_after,
        notes,
        created_at
      )
      values (
        $1,$2,$3,$4,$5,$6,$7,$8,
        nullif($9, '')::timestamptz,
        $10,$11,
        nullif($12, '')::timestamptz,
        $13,$14,$15,$16,$17,$18,now()
      )
    `,
    [
      orgId,
      entry.logId || createLogId(),
      entry.boxId,
      entry.warehouse,
      manufacturer,
      filmName,
      entry.widthIn,
      entry.jobNumber,
      entry.checkedOutAt,
      entry.checkedOutBy,
      entry.checkedOutWeightLbs,
      entry.checkedInAt,
      entry.checkedInBy,
      entry.checkedInWeightLbs,
      entry.weightDeltaLbs,
      entry.feetBefore,
      entry.feetAfter,
      entry.notes
    ]
  );
}

function buildActiveAllocationsByBoxIndex(entries) {
  const grouped = {};

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.status !== 'ACTIVE') {
      continue;
    }

    if (!grouped[entry.boxId]) {
      grouped[entry.boxId] = [];
    }

    grouped[entry.boxId].push(entry);
  }

  return grouped;
}

function getActiveAllocationsForBox(boxId, activeAllocationsByBox) {
  return activeAllocationsByBox && activeAllocationsByBox[boxId] ? activeAllocationsByBox[boxId] : [];
}

function getActiveAllocatedFeetForBox(boxId, activeAllocationsByBox) {
  const entries = getActiveAllocationsForBox(boxId, activeAllocationsByBox);
  let total = 0;

  for (let index = 0; index < entries.length; index += 1) {
    total += entries[index].allocatedFeet;
  }

  return total;
}

function buildJobRequirementsByLookupKey(entries) {
  const byKey = {};

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    byKey[normalizeJobRequirementLookupKey(entry.manufacturer, entry.filmName, entry.widthIn)] = entry;
  }

  return byKey;
}

function normalizeRequirementFilmKey(manufacturer, filmName) {
  return `${normalizeCatalogManufacturerLookupKey(manufacturer)}|${normalizeCatalogLookupKey(filmName)}`;
}

function buildAllocationCoverageByRequirementId(requirements, allocations, boxById) {
  const grouped = {};
  const coverage = {};

  for (let index = 0; index < requirements.length; index += 1) {
    const requirement = requirements[index];
    const requirementId = asTrimmedString(requirement.id) || `generated-${index}`;
    const groupKey = normalizeRequirementFilmKey(requirement.manufacturer, requirement.filmName);
    if (!grouped[groupKey]) {
      grouped[groupKey] = {
        requirements: [],
        pools: []
      };
    }

    grouped[groupKey].requirements.push({
      requirementId,
      widthIn: Number(requirement.widthIn) || 0,
      requiredFeet: Math.max(0, Number(requirement.requiredFeet || 0)),
      index
    });
  }

  for (let index = 0; index < allocations.length; index += 1) {
    const allocation = allocations[index];
    if (allocation.status === 'CANCELLED' || allocation.allocatedFeet <= 0) {
      continue;
    }

    const box = boxById[allocation.boxId];
    if (!box) {
      continue;
    }

    const groupKey = normalizeRequirementFilmKey(box.manufacturer, box.filmName);
    if (!grouped[groupKey]) {
      grouped[groupKey] = {
        requirements: [],
        pools: []
      };
    }

    grouped[groupKey].pools.push({
      widthIn: Number(box.widthIn) || 0,
      remainingFeet: allocation.allocatedFeet
    });
  }

  const groupValues = Object.values(grouped);
  for (let groupIndex = 0; groupIndex < groupValues.length; groupIndex += 1) {
    const group = groupValues[groupIndex];
    group.requirements.sort((left, right) => {
      if (left.widthIn !== right.widthIn) {
        return right.widthIn - left.widthIn;
      }
      return left.index - right.index;
    });
    group.pools.sort((left, right) => left.widthIn - right.widthIn);

    for (let requirementIndex = 0; requirementIndex < group.requirements.length; requirementIndex += 1) {
      const requirement = group.requirements[requirementIndex];
      let remainingNeed = requirement.requiredFeet;

      for (let poolIndex = 0; poolIndex < group.pools.length && remainingNeed > 0; poolIndex += 1) {
        const pool = group.pools[poolIndex];
        if (pool.remainingFeet <= 0 || pool.widthIn < requirement.widthIn) {
          continue;
        }

        const assignedFeet = Math.min(pool.remainingFeet, remainingNeed);
        pool.remainingFeet -= assignedFeet;
        remainingNeed -= assignedFeet;
      }

      coverage[requirement.requirementId] = requirement.requiredFeet - remainingNeed;
    }
  }

  return coverage;
}

function buildPublicJobRequirementEntries(requirements, allocations, boxById) {
  const coverage = buildAllocationCoverageByRequirementId(requirements, allocations, boxById);
  const response = [];

  for (let index = 0; index < requirements.length; index += 1) {
    const requirement = requirements[index];
    const requirementId = asTrimmedString(requirement.id) || `generated-${index}`;
    const allocatedFeet = Math.max(0, Number(coverage[requirementId] || 0));
    const requiredFeet = Math.max(0, Number(requirement.requiredFeet || 0));
    const remainingFeet = Math.max(0, requiredFeet - allocatedFeet);
    const cappedAllocatedFeet = requiredFeet - remainingFeet;

    response.push({
      requirementId,
      manufacturer: requirement.manufacturer,
      filmName: requirement.filmName,
      widthIn: requirement.widthIn,
      requiredFeet,
      allocatedFeet: cappedAllocatedFeet,
      remainingFeet
    });
  }

  response.sort((left, right) => {
    const manufacturerCompare = compareCatalogStrings(left.manufacturer, right.manufacturer);
    if (manufacturerCompare !== 0) {
      return manufacturerCompare;
    }

    const filmCompare = compareCatalogStrings(left.filmName, right.filmName);
    if (filmCompare !== 0) {
      return filmCompare;
    }

    if (left.widthIn !== right.widthIn) {
      return left.widthIn < right.widthIn ? -1 : 1;
    }

    return compareCatalogStrings(left.requirementId, right.requirementId);
  });

  return response;
}

function resolveAllocationJobMetadata(allocations, filmOrders) {
  let jobDate = '';
  let crewLeader = '';

  for (let index = 0; index < allocations.length; index += 1) {
    if (!jobDate && allocations[index].jobDate) {
      jobDate = allocations[index].jobDate;
    }

    if (!crewLeader && allocations[index].crewLeader) {
      crewLeader = allocations[index].crewLeader;
    }
  }

  for (let index = 0; index < filmOrders.length; index += 1) {
    if (!jobDate && filmOrders[index].jobDate) {
      jobDate = filmOrders[index].jobDate;
    }

    if (!crewLeader && filmOrders[index].crewLeader) {
      crewLeader = filmOrders[index].crewLeader;
    }
  }

  return { jobDate, crewLeader };
}

function buildAllocationJobSummary(jobNumber, allocations, filmOrders) {
  const metadata = resolveAllocationJobMetadata(allocations, filmOrders);
  let hasFilmOrder = false;
  let hasFilmOnTheWay = false;
  let hasActiveAllocation = false;
  let hasCancelledRecord = false;
  let hasFulfilledRecord = false;
  let activeAllocatedFeet = 0;
  let fulfilledAllocatedFeet = 0;
  let openFilmOrderCount = 0;
  const distinctBoxes = {};

  for (let index = 0; index < allocations.length; index += 1) {
    const allocation = allocations[index];
    if (allocation.boxId) {
      distinctBoxes[allocation.boxId] = true;
    }

    if (allocation.status === 'ACTIVE') {
      hasActiveAllocation = true;
      activeAllocatedFeet += allocation.allocatedFeet;
    } else if (allocation.status === 'FULFILLED') {
      hasFulfilledRecord = true;
      fulfilledAllocatedFeet += allocation.allocatedFeet;
    } else if (allocation.status === 'CANCELLED') {
      hasCancelledRecord = true;
    }
  }

  for (let index = 0; index < filmOrders.length; index += 1) {
    const filmOrder = filmOrders[index];
    if (filmOrder.status === 'FILM_ORDER') {
      hasFilmOrder = true;
      openFilmOrderCount += 1;
    } else if (filmOrder.status === 'FILM_ON_THE_WAY') {
      hasFilmOnTheWay = true;
      openFilmOrderCount += 1;
    } else if (filmOrder.status === 'FULFILLED') {
      hasFulfilledRecord = true;
    } else if (filmOrder.status === 'CANCELLED') {
      hasCancelledRecord = true;
    }
  }

  let status = 'READY';
  if (hasFilmOrder) {
    status = 'FILM_ORDER';
  } else if (hasFilmOnTheWay) {
    status = 'ON_ORDER';
  } else if (hasActiveAllocation) {
    status = 'READY';
  } else if (hasCancelledRecord) {
    status = 'CANCELLED';
  } else if (hasFulfilledRecord) {
    status = 'COMPLETED';
  }

  return {
    jobNumber,
    jobDate: metadata.jobDate,
    crewLeader: metadata.crewLeader,
    status,
    activeAllocatedFeet,
    fulfilledAllocatedFeet,
    openFilmOrderCount,
    boxCount: Object.keys(distinctBoxes).length
  };
}

function buildLegacyJobHeaderFromData(jobNumber, allocations, filmOrders) {
  const metadata = resolveAllocationJobMetadata(allocations, filmOrders);
  let warehouse = '';
  let createdAt = '';
  let updatedAt = '';

  for (let index = 0; index < allocations.length; index += 1) {
    const allocation = allocations[index];
    if (!warehouse && allocation.warehouse) {
      warehouse = allocation.warehouse;
    }

    if (!createdAt || (allocation.createdAt && allocation.createdAt < createdAt)) {
      createdAt = allocation.createdAt || createdAt;
    }

    const allocationUpdatedAt = allocation.resolvedAt || allocation.createdAt;
    if (!updatedAt || (allocationUpdatedAt && allocationUpdatedAt > updatedAt)) {
      updatedAt = allocationUpdatedAt || updatedAt;
    }
  }

  for (let index = 0; index < filmOrders.length; index += 1) {
    const filmOrder = filmOrders[index];
    if (!warehouse && filmOrder.warehouse) {
      warehouse = filmOrder.warehouse;
    }

    if (!createdAt || (filmOrder.createdAt && filmOrder.createdAt < createdAt)) {
      createdAt = filmOrder.createdAt || createdAt;
    }

    const filmUpdatedAt = filmOrder.resolvedAt || filmOrder.createdAt;
    if (!updatedAt || (filmUpdatedAt && filmUpdatedAt > updatedAt)) {
      updatedAt = filmUpdatedAt || updatedAt;
    }
  }

  return {
    id: '',
    orgId: '',
    jobNumber,
    warehouse: warehouse || '',
    sections: null,
    dueDate: metadata.jobDate,
    crewLeader: metadata.crewLeader,
    lifecycleStatus: 'ACTIVE',
    notes: '',
    createdAt,
    createdBy: '',
    updatedAt,
    updatedBy: ''
  };
}

function deriveLegacyLifecycleStatus(allocations, filmOrders) {
  const legacyStatus = buildAllocationJobSummary('', allocations || [], filmOrders || []).status;
  if (legacyStatus === 'CANCELLED') {
    return 'CANCELLED';
  }

  if (legacyStatus === 'COMPLETED') {
    return 'COMPLETED';
  }

  return 'ACTIVE';
}

function deriveJobStatusFromLegacyAllocationData(allocations, filmOrders) {
  const legacySummary = buildAllocationJobSummary('', allocations || [], filmOrders || []);
  if (legacySummary.status === 'CANCELLED') {
    return 'CANCELLED';
  }

  if (legacySummary.status === 'READY' || legacySummary.status === 'COMPLETED') {
    return 'READY';
  }

  return 'ALLOCATE';
}

function computeJobStatusFromRequirements(lifecycleStatus, requirements, allocations, filmOrders) {
  const normalizedLifecycleStatus = normalizeJobLifecycleStatus(lifecycleStatus);
  if (normalizedLifecycleStatus === 'CANCELLED') {
    return 'CANCELLED';
  }

  if (normalizedLifecycleStatus === 'COMPLETED') {
    return 'COMPLETED';
  }

  if (!requirements.length) {
    if (!allocations.length && !filmOrders.length) {
      return 'ALLOCATE';
    }

    return deriveJobStatusFromLegacyAllocationData(allocations, filmOrders);
  }

  for (let index = 0; index < requirements.length; index += 1) {
    if (requirements[index].remainingFeet > 0) {
      return 'ALLOCATE';
    }
  }

  return 'READY';
}

function hasSharedActiveBoxConflict(jobNumber, dueDate, crewLeader, jobAllocations, allAllocations) {
  const normalizedJobDate = asTrimmedString(dueDate);
  if (!normalizedJobDate) {
    return false;
  }

  const normalizedJobNumber = normalizeJobNumberKey(jobNumber);
  const normalizedCrewLeader = normalizeCrewLeaderKey(crewLeader);
  const activeBoxIds = {};

  for (let index = 0; index < jobAllocations.length; index += 1) {
    const allocation = jobAllocations[index];
    if (allocation.status !== 'ACTIVE' || !allocation.boxId) {
      continue;
    }

    activeBoxIds[allocation.boxId] = true;
  }

  if (!Object.keys(activeBoxIds).length) {
    return false;
  }

  const candidates = Array.isArray(allAllocations) ? allAllocations : [];
  for (let index = 0; index < candidates.length; index += 1) {
    const entry = candidates[index];
    if (entry.status !== 'ACTIVE') {
      continue;
    }

    if (!activeBoxIds[entry.boxId]) {
      continue;
    }

    if (normalizeJobNumberKey(entry.jobNumber) === normalizedJobNumber) {
      continue;
    }

    if (asTrimmedString(entry.jobDate) !== normalizedJobDate) {
      continue;
    }

    if (normalizeCrewLeaderKey(entry.crewLeader) === normalizedCrewLeader) {
      continue;
    }

    return true;
  }

  return false;
}

function buildJobListEntry(jobHeader, requirements, allocations, filmOrders, allAllocations = []) {
  const metadata = resolveAllocationJobMetadata(allocations, filmOrders);
  let dueDate = jobHeader.dueDate;
  if (!dueDate) {
    dueDate = metadata.jobDate;
  }
  const crewLeader = asTrimmedString(jobHeader.crewLeader) || metadata.crewLeader;

  let requiredFeet = 0;
  let allocatedFeet = 0;
  let remainingFeet = 0;

  for (let index = 0; index < requirements.length; index += 1) {
    requiredFeet += requirements[index].requiredFeet;
    allocatedFeet += requirements[index].allocatedFeet;
    remainingFeet += requirements[index].remainingFeet;
  }

  const baseStatus = computeJobStatusFromRequirements(
    jobHeader.lifecycleStatus,
    requirements,
    allocations,
    filmOrders
  );
  const status =
    baseStatus === 'ALLOCATE' &&
    hasSharedActiveBoxConflict(jobHeader.jobNumber, dueDate, crewLeader, allocations, allAllocations)
      ? 'CONFLICT'
      : baseStatus;

  const lifecycleStatus =
    jobHeader && jobHeader.id
      ? normalizeJobLifecycleStatus(jobHeader.lifecycleStatus)
      : deriveLegacyLifecycleStatus(allocations, filmOrders);

  return {
    jobNumber: jobHeader.jobNumber,
    warehouse: jobHeader.warehouse || '',
    sections: jobHeader.sections,
    dueDate,
    crewLeader,
    status,
    lifecycleStatus,
    requiredFeet,
    allocatedFeet,
    remainingFeet,
    requirementCount: requirements.length,
    allocationCount: allocations.length,
    filmOrderCount: filmOrders.length,
    updatedAt: jobHeader.updatedAt || '',
    notes: jobHeader.notes || ''
  };
}

function buildPublicAllocationEntriesForJob(allocations, boxById) {
  return allocations
    .slice()
    .sort((left, right) => {
      if (left.status !== right.status) {
        return left.status === 'ACTIVE' ? -1 : right.status === 'ACTIVE' ? 1 : left.status < right.status ? -1 : 1;
      }

      if (left.jobDate !== right.jobDate) {
        if (left.jobDate && right.jobDate) {
          return left.jobDate < right.jobDate ? -1 : 1;
        }

        if (left.jobDate) {
          return -1;
        }

        if (right.jobDate) {
          return 1;
        }
      }

      return left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0;
    })
    .map((entry) => {
      const box = boxById[entry.boxId];
      const checkedOutOnThisJob = Boolean(
        box &&
          box.status === 'CHECKED_OUT' &&
          normalizeJobNumberKey(box.lastCheckoutJob) === normalizeJobNumberKey(entry.jobNumber)
      );
      return {
        ...toPublicAllocation(entry),
        manufacturer: box ? box.manufacturer : '',
        filmName: box ? box.filmName : '',
        widthIn: box ? box.widthIn : 0,
        boxStatus: box ? box.status : '',
        checkedOutOnThisJob
      };
    });
}

async function buildPublicFilmOrderLinkedBoxes(client, orgId, filmOrderId) {
  const links = await listFilmOrderLinksByFilmOrderId(client, orgId, filmOrderId);
  const response = [];

  for (let index = 0; index < links.length; index += 1) {
    const link = links[index];
    const box = await findBoxById(client, orgId, link.boxId);
    if (!box) {
      continue;
    }

    response.push({
      boxId: link.boxId,
      orderedFeet: link.orderedFeet,
      autoAllocatedFeet: link.autoAllocatedFeet
    });
  }

  response.sort((left, right) => (left.boxId < right.boxId ? -1 : left.boxId > right.boxId ? 1 : 0));
  return response;
}

async function buildPublicFilmOrdersForJob(client, orgId, filmOrders) {
  const response = [];
  const sorted = filmOrders.slice().sort((left, right) =>
    compareAllocationJobSummaries(
      { jobDate: left.createdAt, jobNumber: left.filmOrderId },
      { jobDate: right.createdAt, jobNumber: right.filmOrderId }
    )
  );

  for (let index = 0; index < sorted.length; index += 1) {
    const entry = sorted[index];
    const linkedBoxes = await buildPublicFilmOrderLinkedBoxes(client, orgId, entry.filmOrderId);
    response.push(toPublicFilmOrder(entry, linkedBoxes));
  }

  return response;
}

async function resolveJobContext(client, orgId, jobNumber, jobDate, crewLeader) {
  const normalizedJobNumber = requireString(jobNumber, 'JobNumber');
  const normalizedJobDate = normalizeDateString(jobDate, 'JobDate', true);
  const normalizedCrewLeader = asTrimmedString(crewLeader);
  const existingHeader = await findJobByNumber(client, orgId, normalizedJobNumber);
  if (existingHeader && normalizeJobLifecycleStatus(existingHeader.lifecycleStatus) !== 'ACTIVE') {
    throw new HttpError(400, `Job ${normalizedJobNumber} is closed and cannot receive allocations.`);
  }
  const existingAllocations = await listAllocationsByJob(client, orgId, normalizedJobNumber);
  const existingFilmOrders = await listFilmOrdersByJob(client, orgId, normalizedJobNumber);
  let existingJobDate = existingHeader?.dueDate || '';
  let existingCrewLeader = existingHeader?.crewLeader || '';

  for (let index = 0; index < existingAllocations.length; index += 1) {
    if (!existingJobDate && existingAllocations[index].jobDate) {
      existingJobDate = existingAllocations[index].jobDate;
    }

    if (!existingCrewLeader && existingAllocations[index].crewLeader) {
      existingCrewLeader = existingAllocations[index].crewLeader;
    }
  }

  for (let index = 0; index < existingFilmOrders.length; index += 1) {
    if (!existingJobDate && existingFilmOrders[index].jobDate) {
      existingJobDate = existingFilmOrders[index].jobDate;
    }

    if (!existingCrewLeader && existingFilmOrders[index].crewLeader) {
      existingCrewLeader = existingFilmOrders[index].crewLeader;
    }
  }

  if (existingJobDate && normalizedJobDate && existingJobDate !== normalizedJobDate) {
    throw new HttpError(400, 'JobDate must stay the same for an existing Job Number.');
  }

  if (
    existingCrewLeader &&
    normalizedCrewLeader &&
    normalizeCrewLeaderKey(existingCrewLeader) !== normalizeCrewLeaderKey(normalizedCrewLeader)
  ) {
    throw new HttpError(400, 'CrewLeader must stay the same for an existing Job Number.');
  }

  const resolvedJobDate = normalizedJobDate || existingJobDate;
  const resolvedCrewLeader = normalizedCrewLeader || existingCrewLeader;

  if (resolvedJobDate && !resolvedCrewLeader) {
    throw new HttpError(400, 'CrewLeader is required when JobDate is set.');
  }

  return {
    jobNumber: normalizedJobNumber,
    jobDate: resolvedJobDate,
    crewLeader: resolvedCrewLeader
  };
}

function getDateConflictJobsForBox(boxId, jobContext, activeAllocationsByBox) {
  if (!jobContext.jobDate) {
    return [];
  }

  const active = getActiveAllocationsForBox(boxId, activeAllocationsByBox);
  const conflicts = [];
  const seen = {};

  for (let index = 0; index < active.length; index += 1) {
    const entry = active[index];
    if (
      entry.jobDate !== jobContext.jobDate ||
      normalizeJobNumberKey(entry.jobNumber) === normalizeJobNumberKey(jobContext.jobNumber)
    ) {
      continue;
    }

    if (normalizeCrewLeaderKey(entry.crewLeader) === normalizeCrewLeaderKey(jobContext.crewLeader)) {
      continue;
    }

    if (!seen[entry.jobNumber]) {
      seen[entry.jobNumber] = true;
      conflicts.push(entry.jobNumber);
    }
  }

  return conflicts;
}

function buildAllocationPreviewPlan(sourceBox, requestedFeet, jobContext, options) {
  const requested = coerceFeetValue(requestedFeet, 'RequestedFeet', [], true);
  if (requested <= 0) {
    throw new HttpError(400, 'RequestedFeet must be greater than zero.');
  }

  const useCrossWarehouse = options && options.crossWarehouse === true;
  const minimumWidthValue = Number(options && options.minimumWidthIn);
  const minimumWidthIn =
    Number.isFinite(minimumWidthValue) && minimumWidthValue > 0 ? minimumWidthValue : sourceBox.widthIn;
  if (sourceBox.widthIn < minimumWidthIn) {
    throw new HttpError(400, 'Source box width must meet or exceed the requested width.');
  }
  const activeAllocationsByBox = (options && options.activeAllocationsByBox) || {};
  const sourceConflicts = getDateConflictJobsForBox(sourceBox.boxId, jobContext, activeAllocationsByBox);
  const sourceSuggestedFeet = sourceConflicts.length ? 0 : Math.min(sourceBox.feetAvailable, requested);
  let remaining = requested - sourceSuggestedFeet;
  const candidates = [];
  const candidateBoxes = useCrossWarehouse
    ? options.allBoxes
    : options.allBoxes.filter((box) => box.warehouse === sourceBox.warehouse);
  const filteredCandidates = [];

  for (let index = 0; index < candidateBoxes.length; index += 1) {
    const candidate = candidateBoxes[index];
    if (
      candidate.boxId === sourceBox.boxId ||
      !isAllocatableBoxStatus(candidate.status) ||
      candidate.feetAvailable <= 0 ||
      candidate.manufacturer !== sourceBox.manufacturer ||
      candidate.filmName !== sourceBox.filmName ||
      candidate.widthIn < minimumWidthIn
    ) {
      continue;
    }

    filteredCandidates.push(candidate);
  }

  filteredCandidates.sort((left, right) => {
    const leftWidthDelta = left.widthIn - minimumWidthIn;
    const rightWidthDelta = right.widthIn - minimumWidthIn;
    if (leftWidthDelta !== rightWidthDelta) {
      return leftWidthDelta - rightWidthDelta;
    }

    return compareBoxesByOldestStock(left, right);
  });

  for (let index = 0; index < filteredCandidates.length; index += 1) {
    const candidate = filteredCandidates[index];
    const conflicts = getDateConflictJobsForBox(candidate.boxId, jobContext, activeAllocationsByBox);
    if (conflicts.length) {
      continue;
    }

    candidates.push({
      boxId: candidate.boxId,
      warehouse: candidate.warehouse,
      widthIn: candidate.widthIn,
      availableFeet: candidate.feetAvailable,
      suggestedFeet: remaining > 0 ? Math.min(candidate.feetAvailable, remaining) : 0,
      receivedDate: candidate.receivedDate,
      orderDate: candidate.orderDate
    });

    if (remaining > 0) {
      remaining -= Math.min(candidate.feetAvailable, remaining);
    }
  }

  return {
    jobNumber: jobContext.jobNumber,
    jobDate: jobContext.jobDate,
    crewLeader: jobContext.crewLeader,
    requestedFeet: requested,
    sourceBoxId: sourceBox.boxId,
    sourceWarehouse: sourceBox.warehouse,
    sourceBoxFeetAvailable: sourceBox.feetAvailable,
    sourceSuggestedFeet,
    sourceConflicts,
    suggestions: candidates,
    defaultCoveredFeet: requested - remaining,
    defaultRemainingFeet: remaining
  };
}

function calculateSelectedSuggestionAllocations(plan, selectedBoxIds) {
  const selectedMap = {};
  const allocations = [];
  let remaining = plan.requestedFeet;

  if (plan.sourceSuggestedFeet > 0) {
    allocations.push({
      boxId: plan.sourceBoxId,
      allocatedFeet: plan.sourceSuggestedFeet
    });
    remaining -= plan.sourceSuggestedFeet;
  }

  for (let index = 0; index < selectedBoxIds.length; index += 1) {
    selectedMap[selectedBoxIds[index]] = true;
  }

  for (let index = 0; index < plan.suggestions.length; index += 1) {
    const suggestion = plan.suggestions[index];
    if (!selectedMap[suggestion.boxId] || remaining <= 0) {
      continue;
    }

    const allocatedFeet = Math.min(suggestion.availableFeet, remaining);
    allocations.push({
      boxId: suggestion.boxId,
      allocatedFeet
    });
    remaining -= allocatedFeet;
  }

  return {
    allocations,
    remainingFeet: remaining
  };
}

function parseCrossWarehouseFlag(value) {
  return value === true || String(value).toLowerCase() === 'true';
}

function normalizeOptionalWarehouse(value, fieldName) {
  const normalized = asTrimmedString(value).toUpperCase();
  if (!normalized) {
    return '';
  }

  return normalizeWarehouseCodeFormat(normalized, fieldName || 'Warehouse');
}

async function getOrResolveJobId(client, orgId, jobNumber) {
  const header = await findJobByNumber(client, orgId, jobNumber);
  return header ? header.id : null;
}

async function createAllocationRecord(client, orgId, box, jobContext, allocatedFeet, user, filmOrderId) {
  const jobId = await getOrResolveJobId(client, orgId, jobContext.jobNumber);
  return saveAllocationRecord(client, orgId, {
    allocationId: createLogId(),
    boxId: box.boxId,
    warehouse: box.warehouse,
    jobId,
    jobNumber: jobContext.jobNumber,
    jobDate: jobContext.jobDate,
    allocatedFeet,
    status: 'ACTIVE',
    createdAt: new Date().toISOString(),
    createdBy: asTrimmedString(user),
    resolvedAt: '',
    resolvedBy: '',
    notes: '',
    crewLeader: jobContext.crewLeader,
    filmOrderId: asTrimmedString(filmOrderId)
  });
}

async function sumFilmOrderCoveredFeet(client, orgId, filmOrderId) {
  const allocations = await listAllocationsByFilmOrderId(client, orgId, filmOrderId);
  let total = 0;

  for (let index = 0; index < allocations.length; index += 1) {
    if (allocations[index].status !== 'CANCELLED') {
      total += allocations[index].allocatedFeet;
    }
  }

  return total;
}

async function sumFilmOrderOrderedFeet(client, orgId, filmOrderId) {
  const links = await listFilmOrderLinksByFilmOrderId(client, orgId, filmOrderId);
  let total = 0;

  for (let index = 0; index < links.length; index += 1) {
    const box = await findBoxById(client, orgId, links[index].boxId);
    if (box) {
      total += links[index].orderedFeet;
    }
  }

  return total;
}

async function recalculateFilmOrder(client, orgId, filmOrderId, user) {
  const existing = await findFilmOrderById(client, orgId, filmOrderId);
  if (!existing) {
    return null;
  }

  const updated = cloneValue(existing);
  updated.coveredFeet = await sumFilmOrderCoveredFeet(client, orgId, filmOrderId);
  updated.orderedFeet = await sumFilmOrderOrderedFeet(client, orgId, filmOrderId);
  updated.remainingToOrderFeet = Math.max(updated.requestedFeet - updated.orderedFeet, 0);

  if (updated.status !== 'CANCELLED') {
    if (updated.coveredFeet >= updated.requestedFeet) {
      updated.status = 'FULFILLED';
      if (!updated.resolvedAt) {
        updated.resolvedAt = new Date().toISOString();
        updated.resolvedBy = asTrimmedString(user);
      }
    } else if (updated.orderedFeet >= updated.requestedFeet) {
      updated.status = 'FILM_ON_THE_WAY';
      updated.resolvedAt = '';
      updated.resolvedBy = '';
    } else {
      updated.status = 'FILM_ORDER';
      updated.resolvedAt = '';
      updated.resolvedBy = '';
    }
  }

  return saveFilmOrderRecord(client, orgId, updated);
}

async function createFilmOrderForShortage(
  client,
  orgId,
  sourceBox,
  jobContext,
  requestedFeet,
  shortageFeet,
  user,
  shortageWarehouse
) {
  if (shortageFeet <= 0) {
    return null;
  }

  const resolvedWarehouse = asTrimmedString(shortageWarehouse).toUpperCase() || sourceBox.warehouse;
  const jobId = await getOrResolveJobId(client, orgId, jobContext.jobNumber);

  return saveFilmOrderRecord(client, orgId, {
    filmOrderId: createLogId(),
    jobId,
    jobNumber: jobContext.jobNumber,
    warehouse: resolvedWarehouse,
    manufacturer: sourceBox.manufacturer,
    filmName: sourceBox.filmName,
    widthIn: sourceBox.widthIn,
    requestedFeet: shortageFeet,
    coveredFeet: 0,
    orderedFeet: 0,
    remainingToOrderFeet: shortageFeet,
    jobDate: jobContext.jobDate,
    crewLeader: jobContext.crewLeader,
    status: 'FILM_ORDER',
    sourceBoxId: sourceBox.boxId,
    createdAt: new Date().toISOString(),
    createdBy: asTrimmedString(user),
    resolvedAt: '',
    resolvedBy: '',
    notes: `Created from a shortage while trying to allocate ${requestedFeet} LF.`
  });
}

async function linkBoxToFilmOrder(client, orgId, filmOrderId, box, user) {
  const existing = await findFilmOrderById(client, orgId, filmOrderId);
  if (!existing) {
    throw new HttpError(404, 'Film Order not found.');
  }

  if (existing.status === 'CANCELLED') {
    throw new HttpError(400, 'Cancelled Film Orders cannot receive new boxes.');
  }

  await saveFilmOrderLinkRecord(client, orgId, {
    linkId: createLogId(),
    filmOrderId: existing.filmOrderId,
    boxId: box.boxId,
    orderedFeet: box.initialFeet,
    autoAllocatedFeet: 0,
    createdAt: new Date().toISOString(),
    createdBy: asTrimmedString(user)
  });

  return recalculateFilmOrder(client, orgId, existing.filmOrderId, user);
}

async function processLinkedFilmOrderReceipt(client, orgId, box, user, warnings) {
  const links = await listFilmOrderLinksByBoxId(client, orgId, box.boxId);
  const recalculatedOrders = {};

  if (!box.receivedDate || box.status !== 'IN_STOCK' || box.feetAvailable <= 0) {
    return box;
  }

  for (let index = 0; index < links.length; index += 1) {
    const link = cloneValue(links[index]);
    const filmOrder = await findFilmOrderById(client, orgId, link.filmOrderId);
    if (!filmOrder || filmOrder.status === 'CANCELLED' || filmOrder.status === 'FULFILLED') {
      continue;
    }

    const remainingNeed = Math.max(filmOrder.requestedFeet - filmOrder.coveredFeet, 0);
    const linkCapacity = Math.max(link.orderedFeet - link.autoAllocatedFeet, 0);
    const allocationFeet = Math.min(remainingNeed, linkCapacity, box.feetAvailable);

    if (allocationFeet <= 0) {
      continue;
    }

    await createAllocationRecord(
      client,
      orgId,
      box,
      {
        jobNumber: filmOrder.jobNumber,
        jobDate: filmOrder.jobDate,
        crewLeader: filmOrder.crewLeader
      },
      allocationFeet,
      user,
      filmOrder.filmOrderId
    );

    box.feetAvailable = Math.max(box.feetAvailable - allocationFeet, 0);
    link.autoAllocatedFeet += allocationFeet;
    await saveFilmOrderLinkRecord(client, orgId, link);
    warnings.push(
      `${allocationFeet} LF from ${box.boxId} was automatically allocated to job ${filmOrder.jobNumber} for Film Order ${filmOrder.filmOrderId}.`
    );
    recalculatedOrders[filmOrder.filmOrderId] = true;
  }

  for (const filmOrderId of Object.keys(recalculatedOrders)) {
    await recalculateFilmOrder(client, orgId, filmOrderId, user);
  }

  return box;
}

async function cancelJobAndReleaseAllocations(client, orgId, jobNumber, user, reason) {
  const allocations = await listAllocationsByJob(client, orgId, jobNumber);
  const activeByBoxId = {};
  let activeCount = 0;
  const filmOrders = await listFilmOrdersByJob(client, orgId, jobNumber);
  const resolvedAt = new Date().toISOString();
  const note = asTrimmedString(reason) || 'Job cancelled.';

  for (let index = 0; index < allocations.length; index += 1) {
    const entry = cloneValue(allocations[index]);
    if (entry.status !== 'ACTIVE') {
      continue;
    }

    activeByBoxId[entry.boxId] = (activeByBoxId[entry.boxId] || 0) + entry.allocatedFeet;
    entry.status = 'CANCELLED';
    entry.resolvedAt = resolvedAt;
    entry.resolvedBy = asTrimmedString(user);
    entry.notes = note;
    await saveAllocationRecord(client, orgId, entry);
    activeCount += 1;
  }

  for (const boxId of Object.keys(activeByBoxId)) {
    const box = await findBoxById(client, orgId, boxId);
    if (!box || box.status === 'ZEROED' || box.status === 'RETIRED') {
      continue;
    }

    box.feetAvailable += activeByBoxId[boxId];
    await saveBoxRecord(client, orgId, box);
  }

  for (let index = 0; index < filmOrders.length; index += 1) {
    const order = cloneValue(filmOrders[index]);
    if (order.status === 'CANCELLED') {
      continue;
    }

    order.status = 'CANCELLED';
    order.resolvedAt = resolvedAt;
    order.resolvedBy = asTrimmedString(user);
    order.notes = note;
    await saveFilmOrderRecord(client, orgId, order);
  }

  return {
    releasedAllocationCount: activeCount,
    affectedBoxCount: Object.keys(activeByBoxId).length
  };
}

async function removeAllocationFromJob(client, orgId, jobNumber, allocationId, user, reason) {
  const jobHeader = await findJobByNumber(client, orgId, jobNumber);
  if (jobHeader && normalizeJobLifecycleStatus(jobHeader.lifecycleStatus) !== 'ACTIVE') {
    throw new HttpError(400, `Job ${jobNumber} is closed and allocation rows cannot be removed.`);
  }

  const allocations = await listAllocationsByJob(client, orgId, jobNumber);
  const normalizedJobNumber = normalizeJobNumberKey(jobNumber);
  const normalizedAllocationId = asTrimmedString(allocationId);
  const resolvedAt = new Date().toISOString();
  let target = null;

  for (let index = 0; index < allocations.length; index += 1) {
    if (asTrimmedString(allocations[index].allocationId) === normalizedAllocationId) {
      target = allocations[index];
      break;
    }
  }

  if (!target) {
    throw new HttpError(404, `Allocation ${allocationId} was not found for job ${jobNumber}.`);
  }

  if (target.status === 'CANCELLED') {
    return {
      allocationId: target.allocationId,
      boxId: target.boxId,
      removedAllocationCount: 0,
      releasedFeet: 0
    };
  }

  const entry = cloneValue(target);
  const box = await findBoxById(client, orgId, entry.boxId);
  if (
    box &&
    box.status === 'CHECKED_OUT' &&
    normalizeJobNumberKey(box.lastCheckoutJob) === normalizedJobNumber
  ) {
    throw new HttpError(
      400,
      `Box ${entry.boxId} is checked out on job ${jobNumber} and cannot be removed until the box is checked in.`
    );
  }

  const note =
    asTrimmedString(reason) ||
    `Removed allocation ${entry.allocationId} for box ${entry.boxId} from job ${jobNumber} on allocation detail page.`;
  const releasedFeet =
    entry.status === 'ACTIVE' || entry.status === 'FULFILLED' ? entry.allocatedFeet : 0;

  entry.status = 'CANCELLED';
  entry.resolvedAt = resolvedAt;
  entry.resolvedBy = asTrimmedString(user);
  entry.notes = note;
  await saveAllocationRecord(client, orgId, entry);

  if (releasedFeet > 0) {
    if (box && box.status !== 'ZEROED' && box.status !== 'RETIRED') {
      box.feetAvailable = Math.max(0, integerOrZero(box.feetAvailable) + releasedFeet);
      await saveBoxRecord(client, orgId, box);
    }
  }

  if (entry.filmOrderId) {
    await recalculateFilmOrder(client, orgId, entry.filmOrderId, user);
  }

  return {
    allocationId: entry.allocationId,
    boxId: entry.boxId,
    removedAllocationCount: 1,
    releasedFeet
  };
}

async function cancelFilmOrderAndReleaseAllocations(client, orgId, filmOrderId, user, reason) {
  const existing = await findFilmOrderById(client, orgId, filmOrderId);
  if (!existing) {
    throw new HttpError(404, 'Film Order not found.');
  }

  const allocations = await listAllocationsByFilmOrderId(client, orgId, filmOrderId);
  const activeByBoxId = {};
  let activeCount = 0;
  const resolvedAt = new Date().toISOString();
  const note = asTrimmedString(reason) || 'Film order deleted.';

  for (let index = 0; index < allocations.length; index += 1) {
    const entry = cloneValue(allocations[index]);
    if (entry.status !== 'ACTIVE') {
      continue;
    }

    activeByBoxId[entry.boxId] = (activeByBoxId[entry.boxId] || 0) + entry.allocatedFeet;
    entry.status = 'CANCELLED';
    entry.resolvedAt = resolvedAt;
    entry.resolvedBy = asTrimmedString(user);
    entry.notes = note;
    await saveAllocationRecord(client, orgId, entry);
    activeCount += 1;
  }

  for (const boxId of Object.keys(activeByBoxId)) {
    const box = await findBoxById(client, orgId, boxId);
    if (!box || box.status === 'ZEROED' || box.status === 'RETIRED') {
      continue;
    }

    box.feetAvailable += activeByBoxId[boxId];
    await saveBoxRecord(client, orgId, box);
  }

  await deleteFilmOrderLinksByFilmOrderId(client, orgId, filmOrderId);
  await deleteFilmOrderRecord(client, orgId, filmOrderId);

  return {
    filmOrder: existing,
    releasedAllocationCount: activeCount,
    affectedBoxCount: Object.keys(activeByBoxId).length
  };
}

async function cancelActiveFilmOrderAllocationsForBox(client, orgId, boxId, user, reason) {
  const entries = await listAllocationsByBox(client, orgId, boxId);
  const resolvedAt = new Date().toISOString();
  const affectedFilmOrders = {};
  let count = 0;

  for (let index = 0; index < entries.length; index += 1) {
    const entry = cloneValue(entries[index]);
    if (entry.status !== 'ACTIVE' || !entry.filmOrderId) {
      continue;
    }

    entry.status = 'CANCELLED';
    entry.resolvedAt = resolvedAt;
    entry.resolvedBy = asTrimmedString(user);
    entry.notes = asTrimmedString(reason) || 'Cancelled because linked box state was undone.';
    await saveAllocationRecord(client, orgId, entry);
    affectedFilmOrders[entry.filmOrderId] = true;
    count += 1;
  }

  for (const filmOrderId of Object.keys(affectedFilmOrders)) {
    await recalculateFilmOrder(client, orgId, filmOrderId, user);
  }

  return count;
}

async function recalculateFilmOrdersForBoxLinks(client, orgId, boxId, user) {
  const links = await listFilmOrderLinksByBoxId(client, orgId, boxId);
  const seen = {};

  for (let index = 0; index < links.length; index += 1) {
    if (!seen[links[index].filmOrderId]) {
      seen[links[index].filmOrderId] = true;
      await recalculateFilmOrder(client, orgId, links[index].filmOrderId, user);
    }
  }
}

function hasNonCancelledAllocationForBoxJob(allocations, boxId, jobNumber) {
  const normalizedJobNumber = normalizeJobNumberKey(jobNumber);

  for (let index = 0; index < allocations.length; index += 1) {
    const entry = allocations[index];
    if (
      entry.status !== 'CANCELLED' &&
      entry.boxId === boxId &&
      normalizeJobNumberKey(entry.jobNumber) === normalizedJobNumber
    ) {
      return true;
    }
  }

  return false;
}

function readFeetAvailableFromAuditState(state) {
  if (!state || typeof state !== 'object') {
    return null;
  }

  const rawValue = state.feetAvailable;
  if (rawValue === null || rawValue === undefined || rawValue === '') {
    return null;
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return Math.max(0, Math.floor(parsed));
}

function resolveCheckoutSnapshotAllocationFeet(checkoutAudit, box) {
  const afterFeet = readFeetAvailableFromAuditState(checkoutAudit && checkoutAudit.after);
  if (afterFeet !== null) {
    return afterFeet;
  }

  const beforeFeet = readFeetAvailableFromAuditState(checkoutAudit && checkoutAudit.before);
  if (beforeFeet !== null) {
    return beforeFeet;
  }

  return Math.max(0, integerOrZero(box.feetAvailable));
}

function sumRemainingMatchingRequirementFeetForBox(requirements, box) {
  const boxFilmKey = normalizeRequirementFilmKey(box.manufacturer, box.filmName);
  let total = 0;

  for (let index = 0; index < requirements.length; index += 1) {
    const requirement = requirements[index];
    if (normalizeRequirementFilmKey(requirement.manufacturer, requirement.filmName) !== boxFilmKey) {
      continue;
    }

    if ((Number(requirement.widthIn) || 0) > (Number(box.widthIn) || 0)) {
      continue;
    }

    total += Math.max(0, Number(requirement.remainingFeet || 0));
  }

  return total;
}

async function buildJobContextForAutoLinkedAllocation(client, orgId, jobNumber, allocations) {
  const normalizedJobNumber = requireString(jobNumber, 'JobNumber');
  const header = await findJobByNumber(client, orgId, normalizedJobNumber);
  const filmOrders = await listFilmOrdersByJob(client, orgId, normalizedJobNumber);
  const metadata = resolveAllocationJobMetadata(allocations, filmOrders);

  return {
    jobNumber: normalizedJobNumber,
    jobDate: asTrimmedString(header?.dueDate) || metadata.jobDate || '',
    crewLeader: asTrimmedString(header?.crewLeader) || metadata.crewLeader || ''
  };
}

async function autoLinkRemainingJobFeetToCheckedOutBox(client, orgId, box, jobNumber, user, mode = 'checkout') {
  const normalizedJobNumber = requireString(jobNumber, 'JobNumber');
  const availableFeet = Math.max(0, integerOrZero(box.feetAvailable));

  if (availableFeet <= 0) {
    return {
      created: false,
      allocatedFeet: 0,
      skippedReason: 'NO_AVAILABLE_FEET'
    };
  }

  const requirements = await listJobRequirementsByJob(client, orgId, normalizedJobNumber);
  if (!requirements.length) {
    return {
      created: false,
      allocatedFeet: 0,
      skippedReason: 'NO_REQUIREMENTS'
    };
  }

  const jobAllocations = await listAllocationsByJob(client, orgId, normalizedJobNumber);
  if (
    mode === 'backfill' &&
    hasNonCancelledAllocationForBoxJob(jobAllocations, box.boxId, normalizedJobNumber)
  ) {
    return {
      created: false,
      allocatedFeet: 0,
      skippedReason: 'ALREADY_LINKED'
    };
  }

  const allBoxes = await listBoxes(client, orgId);
  const boxById = {};
  for (let index = 0; index < allBoxes.length; index += 1) {
    boxById[allBoxes[index].boxId] = allBoxes[index];
  }

  const publicRequirements = buildPublicJobRequirementEntries(requirements, jobAllocations, boxById);
  const remainingMatchingFeet = sumRemainingMatchingRequirementFeetForBox(publicRequirements, box);
  if (remainingMatchingFeet <= 0) {
    return {
      created: false,
      allocatedFeet: 0,
      skippedReason: 'NO_MATCHING_REMAINING_REQUIREMENTS'
    };
  }

  const allocatableFeet = Math.min(availableFeet, remainingMatchingFeet);
  if (allocatableFeet <= 0) {
    return {
      created: false,
      allocatedFeet: 0,
      skippedReason: 'NO_ALLOCATABLE_FEET'
    };
  }

  const jobContext = await buildJobContextForAutoLinkedAllocation(
    client,
    orgId,
    normalizedJobNumber,
    jobAllocations
  );
  const allocation = await createAllocationRecord(
    client,
    orgId,
    box,
    jobContext,
    allocatableFeet,
    user,
    ''
  );

  box.feetAvailable = Math.max(availableFeet - allocatableFeet, 0);

  return {
    created: true,
    allocatedFeet: allocatableFeet,
    allocationId: allocation.allocationId,
    skippedReason: ''
  };
}

async function reconcileCheckedOutBoxAllocationLink(client, orgId, box, user) {
  if (!box || box.status !== 'CHECKED_OUT') {
    return {
      created: false,
      allocatedFeet: 0,
      skippedReason: 'NOT_CHECKED_OUT'
    };
  }

  const checkoutJobNumber = asTrimmedString(box.lastCheckoutJob);
  if (!checkoutJobNumber) {
    return {
      created: false,
      allocatedFeet: 0,
      skippedReason: 'MISSING_CHECKOUT_JOB'
    };
  }

  const jobAllocations = await listAllocationsByJob(client, orgId, checkoutJobNumber);
  if (hasNonCancelledAllocationForBoxJob(jobAllocations, box.boxId, checkoutJobNumber)) {
    return {
      created: false,
      allocatedFeet: 0,
      skippedReason: 'ALREADY_LINKED'
    };
  }

  const checkoutAudit = await findLatestCheckoutAuditEntryByBoxId(client, orgId, box.boxId);
  const snapshotFeet = resolveCheckoutSnapshotAllocationFeet(checkoutAudit, box);
  if (snapshotFeet <= 0) {
    return {
      created: false,
      allocatedFeet: 0,
      skippedReason: 'NO_CHECKOUT_SNAPSHOT_FEET'
    };
  }

  const workingBox = cloneValue(box);
  const jobContext = await buildJobContextForAutoLinkedAllocation(
    client,
    orgId,
    checkoutJobNumber,
    jobAllocations
  );

  await createAllocationRecord(
    client,
    orgId,
    workingBox,
    jobContext,
    snapshotFeet,
    user,
    ''
  );

  const availableBefore = Math.max(0, integerOrZero(workingBox.feetAvailable));
  const deductedFeet = Math.min(availableBefore, snapshotFeet);
  workingBox.feetAvailable = Math.max(availableBefore - deductedFeet, 0);

  await resolveAllocationsForCheckout(client, orgId, workingBox.boxId, checkoutJobNumber, user);
  await saveBoxRecord(client, orgId, workingBox);

  return {
    created: true,
    allocatedFeet: snapshotFeet,
    skippedReason: ''
  };
}

async function reconcileCheckedOutBoxAllocationLinkByBoxId(client, orgId, boxId, user) {
  const box = await findBoxById(client, orgId, boxId);
  if (!box) {
    return {
      created: false,
      allocatedFeet: 0,
      skippedReason: 'BOX_NOT_FOUND'
    };
  }

  return reconcileCheckedOutBoxAllocationLink(client, orgId, box, user);
}

async function reconcileCheckedOutBoxAllocationLinksForJob(client, orgId, jobNumber, user) {
  const normalizedJobNumber = requireString(jobNumber, 'jobNumber');
  const normalizedKey = normalizeJobNumberKey(normalizedJobNumber);
  const boxes = await listBoxes(client, orgId);

  for (let index = 0; index < boxes.length; index += 1) {
    const box = boxes[index];
    if (box.status !== 'CHECKED_OUT') {
      continue;
    }

    if (normalizeJobNumberKey(box.lastCheckoutJob) !== normalizedKey) {
      continue;
    }

    await reconcileCheckedOutBoxAllocationLink(client, orgId, box, user);
  }
}

async function reconcileZeroedBoxAllocationStateByBoxId(client, orgId, boxId, user) {
  const box = await findBoxById(client, orgId, boxId);
  if (!box) {
    return {
      cancelledCount: 0,
      skippedReason: 'BOX_NOT_FOUND'
    };
  }

  if (box.status !== 'ZEROED') {
    return {
      cancelledCount: 0,
      skippedReason: 'NOT_ZEROED'
    };
  }

  const cancelledCount = await cancelAllocationsForZeroedBox(client, orgId, box.boxId, user);
  return {
    cancelledCount,
    skippedReason: cancelledCount > 0 ? '' : 'NO_ALLOCATIONS_TO_CANCEL'
  };
}

async function reconcileZeroedBoxAllocationStateForJob(client, orgId, jobNumber, user) {
  const allocations = await listAllocationsByJob(client, orgId, requireString(jobNumber, 'jobNumber'));
  const boxes = await listBoxes(client, orgId);
  const boxesById = {};
  const zeroedBoxIds = {};
  let cancelledCount = 0;

  for (let index = 0; index < boxes.length; index += 1) {
    boxesById[boxes[index].boxId] = boxes[index];
  }

  for (let index = 0; index < allocations.length; index += 1) {
    const allocation = allocations[index];
    if (allocation.status === 'CANCELLED') {
      continue;
    }

    const box = boxesById[allocation.boxId];
    if (!box || box.status !== 'ZEROED' || zeroedBoxIds[box.boxId]) {
      continue;
    }

    zeroedBoxIds[box.boxId] = true;
  }

  for (const boxId of Object.keys(zeroedBoxIds)) {
    const result = await reconcileZeroedBoxAllocationStateByBoxId(client, orgId, boxId, user);
    cancelledCount += result.cancelledCount;
  }

  return {
    cancelledCount
  };
}

async function resolveAllocationsForCheckout(client, orgId, boxId, jobNumber, user) {
  const active = (await listAllocationsByBox(client, orgId, boxId)).filter((entry) => entry.status === 'ACTIVE');
  const normalizedJobNumber = normalizeJobNumberKey(jobNumber);
  const resolvedAt = new Date().toISOString();
  const result = {
    fulfilledCount: 0,
    fulfilledFeet: 0,
    otherJobs: []
  };
  const otherJobs = {};

  for (let index = 0; index < active.length; index += 1) {
    const entry = cloneValue(active[index]);
    if (normalizeJobNumberKey(entry.jobNumber) === normalizedJobNumber) {
      entry.status = 'FULFILLED';
      entry.resolvedAt = resolvedAt;
      entry.resolvedBy = asTrimmedString(user);
      entry.notes = `Fulfilled by checkout for job ${jobNumber}.`;
      await saveAllocationRecord(client, orgId, entry);
      result.fulfilledCount += 1;
      result.fulfilledFeet += entry.allocatedFeet;
      continue;
    }

    if (entry.jobNumber && !otherJobs[entry.jobNumber]) {
      otherJobs[entry.jobNumber] = true;
      result.otherJobs.push(entry.jobNumber);
    }
  }

  return result;
}

async function cancelNonCancelledAllocationsForBox(client, orgId, boxId, user, reason) {
  const cancellable = (await listAllocationsByBox(client, orgId, boxId)).filter(
    (entry) => entry.status !== 'CANCELLED'
  );
  const resolvedAt = new Date().toISOString();
  const trimmedReason = asTrimmedString(reason);
  const affectedFilmOrders = {};

  for (let index = 0; index < cancellable.length; index += 1) {
    const entry = cloneValue(cancellable[index]);
    entry.status = 'CANCELLED';
    entry.resolvedAt = resolvedAt;
    entry.resolvedBy = asTrimmedString(user);
    entry.notes = trimmedReason || entry.notes;
    await saveAllocationRecord(client, orgId, entry);

    if (entry.filmOrderId) {
      affectedFilmOrders[entry.filmOrderId] = true;
    }
  }

  for (const filmOrderId of Object.keys(affectedFilmOrders)) {
    await recalculateFilmOrder(client, orgId, filmOrderId, user);
  }

  return cancellable.length;
}

async function cancelAllocationsForZeroedBox(client, orgId, boxId, user) {
  return cancelNonCancelledAllocationsForBox(
    client,
    orgId,
    boxId,
    user,
    ZEROED_BOX_AUTO_CANCEL_NOTE
  );
}

async function reactivateFulfilledAllocationsForUndo(client, orgId, boxId, jobNumber) {
  const entries = await listAllocationsByBox(client, orgId, boxId);
  const expectedNote = `Fulfilled by checkout for job ${jobNumber}.`;
  let count = 0;

  for (let index = 0; index < entries.length; index += 1) {
    const entry = cloneValue(entries[index]);
    if (
      entry.status === 'FULFILLED' &&
      normalizeJobNumberKey(entry.jobNumber) === normalizeJobNumberKey(jobNumber) &&
      entry.notes === expectedNote
    ) {
      entry.status = 'ACTIVE';
      entry.resolvedAt = '';
      entry.resolvedBy = '';
      entry.notes = '';
      await saveAllocationRecord(client, orgId, entry);
      count += 1;
    }
  }

  return count;
}

async function reactivateCancelledAllocationsForZeroUndo(client, orgId, boxId) {
  const entries = await listAllocationsByBox(client, orgId, boxId);
  const expectedNote = ZEROED_BOX_AUTO_CANCEL_NOTE;
  let count = 0;
  const affectedFilmOrders = {};

  for (let index = 0; index < entries.length; index += 1) {
    const entry = cloneValue(entries[index]);
    if (entry.status === 'CANCELLED' && entry.notes === expectedNote) {
      entry.status = 'ACTIVE';
      entry.resolvedAt = '';
      entry.resolvedBy = '';
      entry.notes = '';
      await saveAllocationRecord(client, orgId, entry);
      if (entry.filmOrderId) {
        affectedFilmOrders[entry.filmOrderId] = true;
      }
      count += 1;
    }
  }

  for (const filmOrderId of Object.keys(affectedFilmOrders)) {
    await recalculateFilmOrder(client, orgId, filmOrderId, '');
  }

  return count;
}

async function findLatestCheckoutAuditEntryByBoxId(client, orgId, boxId) {
  const entries = await listAuditEntriesByBox(client, orgId, boxId);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.action !== 'SET_STATUS') {
      continue;
    }

    if (entry.after && entry.after.status === 'CHECKED_OUT') {
      return entry;
    }
  }

  return null;
}

function getCheckoutJobNumberFromAuditNotes(notes) {
  const text = asTrimmedString(notes);
  const match = text.match(/^Checked out for job\s+(.+)$/i);
  return match ? asTrimmedString(match[1]) : '';
}

function groupEntriesByJobNumber(entries) {
  const grouped = {};

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry.jobNumber) {
      continue;
    }

    if (!grouped[entry.jobNumber]) {
      grouped[entry.jobNumber] = [];
    }

    grouped[entry.jobNumber].push(entry);
  }

  return grouped;
}

function buildRequirementRowsForReplace(jobNumber, requirementEntries, existingByKey, user, nowIso) {
  const rows = [];

  for (let index = 0; index < requirementEntries.length; index += 1) {
    const requirement = requirementEntries[index];
    const key = normalizeJobRequirementLookupKey(
      requirement.manufacturer,
      requirement.filmName,
      requirement.widthIn
    );
    const existing = existingByKey[key] || null;

    rows.push({
      id: existing ? existing.id : '',
      jobNumber,
      manufacturer: requirement.manufacturer,
      filmName: requirement.filmName,
      widthIn: requirement.widthIn,
      requiredFeet: requirement.requiredFeet,
      createdAt: existing ? existing.createdAt : nowIso,
      createdBy: existing ? existing.createdBy : user,
      updatedAt: nowIso,
      updatedBy: user,
      notes: existing ? existing.notes : ''
    });
  }

  return rows;
}

async function buildBoxFromPayload(client, orgId, payload, warnings, existingBox) {
  const boxId = existingBox ? existingBox.boxId : requireString(payload.boxId, 'BoxID');
  const canonical = await resolveCanonicalFilmEntry(
    client,
    orgId,
    requireString(payload.manufacturer, 'Manufacturer'),
    requireString(payload.filmName, 'FilmName')
  );
  const manufacturer = canonical.manufacturer;
  const filmName = canonical.filmName;
  const widthIn = coerceNonNegativeNumber(payload.widthIn, 'WidthIn');
  const initialFeet = coerceFeetValue(payload.initialFeet, 'InitialFeet', warnings, false);
  const orderDate = normalizeDateString(payload.orderDate, 'OrderDate', false);
  const receivedDate = normalizeDateString(payload.receivedDate, 'ReceivedDate', true);
  const feetAvailableInput = asTrimmedString(payload.feetAvailable);
  const filmKey = normalizeFilmKeyInput(manufacturer, filmName, payload.filmKey);
  const initialWeightInput = coerceOptionalNonNegativeNumber(payload.initialWeightLbs, 'InitialWeightLbs');
  const lastRollWeightInput = coerceOptionalNonNegativeNumber(payload.lastRollWeightLbs, 'LastRollWeightLbs');
  const lastWeighedDateInput = normalizeDateString(payload.lastWeighedDate, 'LastWeighedDate', true);
  const coreTypeInput = normalizeCoreType(payload.coreType, true);
  const existingCoreType = existingBox ? normalizeCoreType(existingBox.coreType, true) : '';
  let feetAvailable;
  let resolvedInitialWeightLbs = initialWeightInput;
  let resolvedLastRollWeightLbs = lastRollWeightInput;
  let resolvedLastWeighedDate = lastWeighedDateInput;
  let resolvedCoreType = coreTypeInput || existingCoreType;
  let resolvedCoreWeightLbs = null;
  let resolvedLfWeightLbsPerFt = null;
  let shouldRefreshReceivingMetrics = false;

  if (!feetAvailableInput) {
    if (existingBox) {
      feetAvailable = existingBox.feetAvailable;
    } else {
      feetAvailable = deriveAddFeetAvailable(initialFeet, receivedDate);
    }
  } else {
    feetAvailable = coerceFeetValue(payload.feetAvailable, 'FeetAvailable', warnings, true);
  }

  if (existingBox && existingBox.receivedDate && !receivedDate) {
    throw new HttpError(400, 'ReceivedDate cannot be cleared after a box has been received.');
  }

  if (receivedDate) {
    if (widthIn <= 0) {
      throw new HttpError(400, 'WidthIn must be greater than zero for received boxes.');
    }

    if (initialFeet <= 0) {
      throw new HttpError(400, 'InitialFeet must be greater than zero for received boxes.');
    }

    shouldRefreshReceivingMetrics =
      !existingBox ||
      !existingBox.receivedDate ||
      existingBox.filmKey !== filmKey ||
      existingBox.widthIn !== widthIn ||
      existingBox.initialFeet !== initialFeet ||
      (coreTypeInput && coreTypeInput !== existingCoreType) ||
      initialWeightInput !== null;

    if (shouldRefreshReceivingMetrics) {
      const filmData = await findFilmCatalogByFilmKey(client, orgId, filmKey);
      const filmDataCoreType = filmData ? normalizeCoreType(filmData.defaultCoreType, true) : '';
      const effectiveCoreType = coreTypeInput || filmDataCoreType || existingCoreType;

      if (filmData && filmData.sqFtWeightLbsPerSqFt !== null) {
        if (!effectiveCoreType) {
          throw new HttpError(400, 'CoreType is required before this film can be received.');
        }

        const knownSqFtWeight = coerceNonNegativeNumber(
          filmData.sqFtWeightLbsPerSqFt,
          'SqFtWeightLbsPerSqFt'
        );
        resolvedCoreType = effectiveCoreType;
        resolvedCoreWeightLbs = deriveCoreWeightLbs(effectiveCoreType, widthIn);

        if (initialWeightInput !== null) {
          const inputSqFtWeight = deriveSqFtWeightLbsPerSqFt(
            initialWeightInput,
            resolvedCoreWeightLbs,
            widthIn,
            initialFeet
          );
          resolvedLfWeightLbsPerFt = deriveLfWeightLbsPerFt(inputSqFtWeight, widthIn);
          resolvedInitialWeightLbs = roundToDecimals(initialWeightInput, 2);
        } else {
          resolvedLfWeightLbsPerFt = deriveLfWeightLbsPerFt(knownSqFtWeight, widthIn);
          resolvedInitialWeightLbs = deriveInitialWeightLbs(
            resolvedLfWeightLbsPerFt,
            initialFeet,
            resolvedCoreWeightLbs
          );
        }

        if (resolvedLastRollWeightLbs === null) {
          resolvedLastRollWeightLbs =
            existingBox && existingBox.lastRollWeightLbs !== null
              ? existingBox.lastRollWeightLbs
              : resolvedInitialWeightLbs;
        }

        if (!resolvedLastWeighedDate) {
          resolvedLastWeighedDate =
            existingBox && existingBox.lastWeighedDate ? existingBox.lastWeighedDate : receivedDate;
        }

        if ((!existingBox || !existingBox.receivedDate) && initialWeightInput === null) {
          warnings.push('Initial and last roll weights were auto-filled from FILM DATA.');
        }

        if (!filmDataCoreType || filmDataCoreType !== effectiveCoreType) {
          await upsertFilmCatalogRecord(client, orgId, {
            filmKey,
            manufacturer: filmData.manufacturer || manufacturer,
            filmName: filmData.filmName || filmName,
            sqFtWeightLbsPerSqFt: knownSqFtWeight,
            defaultCoreType: effectiveCoreType,
            sourceWidthIn: filmData.sourceWidthIn,
            sourceInitialFeet: filmData.sourceInitialFeet,
            sourceInitialWeightLbs: filmData.sourceInitialWeightLbs,
            updatedAt: new Date().toISOString(),
            sourceBoxId: filmData.sourceBoxId || boxId,
            notes: filmData.notes
          });
          warnings.push('FILM DATA was updated with the selected core type.');
        }
      } else {
        if (!effectiveCoreType) {
          throw new HttpError(400, 'CoreType is required the first time a received film is saved.');
        }

        const seedInitialWeight =
          initialWeightInput !== null
            ? initialWeightInput
            : existingBox && existingBox.initialWeightLbs !== null
              ? existingBox.initialWeightLbs
              : null;

        if (seedInitialWeight === null) {
          throw new HttpError(400, 'InitialWeightLbs is required the first time a received film is saved.');
        }

        resolvedCoreType = effectiveCoreType;
        resolvedCoreWeightLbs = deriveCoreWeightLbs(effectiveCoreType, widthIn);
        const derivedSqFtWeight = deriveSqFtWeightLbsPerSqFt(
          seedInitialWeight,
          resolvedCoreWeightLbs,
          widthIn,
          initialFeet
        );
        resolvedLfWeightLbsPerFt = deriveLfWeightLbsPerFt(derivedSqFtWeight, widthIn);
        resolvedInitialWeightLbs = roundToDecimals(seedInitialWeight, 2);

        if (resolvedLastRollWeightLbs === null) {
          resolvedLastRollWeightLbs =
            existingBox && existingBox.lastRollWeightLbs !== null
              ? existingBox.lastRollWeightLbs
              : resolvedInitialWeightLbs;
        }

        if (!resolvedLastWeighedDate) {
          resolvedLastWeighedDate = receivedDate;
        }

        await upsertFilmCatalogRecord(client, orgId, {
          filmKey,
          manufacturer,
          filmName,
          sqFtWeightLbsPerSqFt: derivedSqFtWeight,
          defaultCoreType: effectiveCoreType,
          sourceWidthIn: widthIn,
          sourceInitialFeet: initialFeet,
          sourceInitialWeightLbs: resolvedInitialWeightLbs,
          updatedAt: new Date().toISOString(),
          sourceBoxId: boxId,
          notes: ''
        });
        warnings.push(`FILM DATA was created from the first received weight for ${filmKey}.`);
      }
    } else {
      resolvedInitialWeightLbs = existingBox ? existingBox.initialWeightLbs : resolvedInitialWeightLbs;
      resolvedCoreType = coreTypeInput || existingCoreType;
      resolvedCoreWeightLbs = existingBox ? existingBox.coreWeightLbs : null;
      resolvedLfWeightLbsPerFt = existingBox ? existingBox.lfWeightLbsPerFt : null;
      resolvedLastRollWeightLbs =
        resolvedLastRollWeightLbs !== null
          ? resolvedLastRollWeightLbs
          : existingBox
            ? existingBox.lastRollWeightLbs
            : resolvedInitialWeightLbs;
      resolvedLastWeighedDate =
        resolvedLastWeighedDate || (existingBox ? existingBox.lastWeighedDate : receivedDate);
    }
  } else {
    resolvedInitialWeightLbs = null;
    resolvedLastRollWeightLbs = null;
    resolvedLastWeighedDate = '';
    resolvedCoreType = '';
    resolvedCoreWeightLbs = null;
    resolvedLfWeightLbsPerFt = null;
  }

  if (receivedDate) {
    if (resolvedLastRollWeightLbs === null) {
      throw new HttpError(
        400,
        'LastRollWeightLbs is required for received boxes because FeetAvailable is derived from roll weight.'
      );
    }

    if (
      resolvedCoreWeightLbs === null ||
      resolvedLfWeightLbsPerFt === null ||
      resolvedLfWeightLbsPerFt <= 0
    ) {
      throw new HttpError(
        400,
        'CoreWeightLbs and LfWeightLbsPerFt must be set for received boxes because FeetAvailable is derived from roll weight.'
      );
    }

    const isFirstReceipt = !existingBox || !existingBox.receivedDate;
    const weightChanged =
      !existingBox || resolvedLastRollWeightLbs !== existingBox.lastRollWeightLbs;
    let activeAllocatedFeet = 0;

    if (existingBox) {
      const existingAllocations = await listAllocationsByBox(client, orgId, boxId);
      for (let index = 0; index < existingAllocations.length; index += 1) {
        if (existingAllocations[index].status === 'ACTIVE') {
          activeAllocatedFeet += existingAllocations[index].allocatedFeet;
        }
      }
    }

    if (isFirstReceipt) {
      feetAvailable = Math.max(initialFeet - activeAllocatedFeet, 0);
    } else if (weightChanged) {
      const physicalFeetAvailable = deriveFeetAvailableFromRollWeight(
        resolvedLastRollWeightLbs,
        resolvedCoreWeightLbs,
        resolvedLfWeightLbsPerFt,
        initialFeet
      );
      const recalculatedFeetAvailable = Math.max(physicalFeetAvailable - activeAllocatedFeet, 0);
      if (feetAvailable !== recalculatedFeetAvailable) {
        feetAvailable = recalculatedFeetAvailable;
        warnings.push('FeetAvailable was recalculated from Last Roll Weight and weight metadata.');
      }
    } else {
      feetAvailable = Math.min(Math.max(existingBox ? existingBox.feetAvailable : feetAvailable, 0), initialFeet);
    }
  }

  return {
    boxId,
    warehouse: await resolveWarehouseFromBoxId(client, orgId, boxId),
    manufacturer,
    filmName,
    widthIn,
    initialFeet,
    feetAvailable,
    lotRun: asTrimmedString(payload.lotRun),
    status:
      existingBox &&
      (existingBox.status === 'CHECKED_OUT' ||
        existingBox.status === 'ZEROED' ||
        existingBox.status === 'RETIRED')
        ? existingBox.status
        : deriveLifecycleStatus(receivedDate),
    orderDate,
    receivedDate,
    initialWeightLbs: resolvedInitialWeightLbs,
    lastRollWeightLbs: resolvedLastRollWeightLbs,
    lastWeighedDate: resolvedLastWeighedDate,
    filmKey,
    coreType: resolvedCoreType,
    coreWeightLbs: resolvedCoreWeightLbs,
    lfWeightLbsPerFt: resolvedLfWeightLbsPerFt,
    purchaseCost: coerceOptionalNonNegativeNumber(payload.purchaseCost, 'PurchaseCost'),
    notes: asTrimmedString(payload.notes),
    hasEverBeenCheckedOut: existingBox ? existingBox.hasEverBeenCheckedOut === true : false,
    lastCheckoutJob: existingBox ? existingBox.lastCheckoutJob : '',
    lastCheckoutDate: existingBox ? existingBox.lastCheckoutDate : '',
    zeroedDate: '',
    zeroedReason: '',
    zeroedBy: ''
  };
}

async function buildSearchBoxes(client, orgId, params) {
  const warehouse = await requireConfiguredWarehouse(client, orgId, params.warehouse, 'warehouse');

  const manufacturerFilterKey = normalizeCatalogManufacturerLookupKey(params.manufacturer);
  const query = asTrimmedString(params.q).toLowerCase();
  const status = asTrimmedString(params.status).toUpperCase();
  const film = asTrimmedString(params.film).toLowerCase();
  const width = asTrimmedString(params.width);
  const showRetired = String(params.showRetired) === 'true';
  const boxes = (await listBoxes(client, orgId)).filter((box) => box.warehouse === warehouse);
  let filtered = [];

  for (let index = 0; index < boxes.length; index += 1) {
    const box = boxes[index];

    if (!showRetired && !status && (box.status === 'ZEROED' || box.status === 'RETIRED')) {
      continue;
    }

    if (status && box.status !== status) {
      continue;
    }

    if (
      manufacturerFilterKey &&
      normalizeCatalogManufacturerLookupKey(box.manufacturer).indexOf(manufacturerFilterKey) === -1
    ) {
      continue;
    }

    if (width && String(box.widthIn) !== width) {
      continue;
    }

    if (
      film &&
      box.filmName.toLowerCase().indexOf(film) === -1 &&
      box.manufacturer.toLowerCase().indexOf(film) === -1 &&
      box.filmKey.toLowerCase().indexOf(film) === -1
    ) {
      continue;
    }

    if (query) {
      const haystack = [box.boxId, box.manufacturer, box.filmName, box.lotRun, box.filmKey]
        .join(' ')
        .toLowerCase();

      if (haystack.indexOf(query) === -1) {
        continue;
      }
    }

    filtered.push(toPublicBox(box));
  }

  if (film) {
    const lowStock = [];
    const remaining = [];

    for (let index = 0; index < filtered.length; index += 1) {
      if (isLowStockBox(filtered[index])) {
        lowStock.push(filtered[index]);
      } else {
        remaining.push(filtered[index]);
      }
    }

    lowStock.sort((left, right) => {
      if (left.feetAvailable !== right.feetAvailable) {
        return left.feetAvailable - right.feetAvailable;
      }

      return left.boxId < right.boxId ? -1 : left.boxId > right.boxId ? 1 : 0;
    });

    filtered = lowStock.concat(remaining);
  }

  return filtered;
}

async function buildAllocationJobList(client, orgId) {
  const allAllocations = await listAllocations(client, orgId);
  const allFilmOrders = await listFilmOrders(client, orgId);
  const groupedAllocations = groupEntriesByJobNumber(allAllocations);
  const groupedFilmOrders = groupEntriesByJobNumber(allFilmOrders);
  const jobNumbers = {};
  const response = [];

  for (let index = 0; index < allAllocations.length; index += 1) {
    if (allAllocations[index].jobNumber) {
      jobNumbers[allAllocations[index].jobNumber] = true;
    }
  }

  for (let index = 0; index < allFilmOrders.length; index += 1) {
    if (allFilmOrders[index].jobNumber) {
      jobNumbers[allFilmOrders[index].jobNumber] = true;
    }
  }

  const keys = Object.keys(jobNumbers);
  for (let index = 0; index < keys.length; index += 1) {
    const jobNumber = keys[index];
    response.push(
      buildAllocationJobSummary(
        jobNumber,
        groupedAllocations[jobNumber] || [],
        groupedFilmOrders[jobNumber] || []
      )
    );
  }

  response.sort(compareAllocationJobSummaries);
  return response;
}

async function buildAllocationJobDetail(client, orgId, jobNumber) {
  const normalizedJobNumber = requireString(jobNumber, 'jobNumber');
  const allocations = await listAllocationsByJob(client, orgId, normalizedJobNumber);
  const filmOrders = await listFilmOrdersByJob(client, orgId, normalizedJobNumber);
  const rollHistory = await listRollHistoryByJob(client, orgId, normalizedJobNumber);

  if (!allocations.length && !filmOrders.length) {
    throw new HttpError(404, 'Job not found.');
  }

  const boxById = {};
  const boxes = await listBoxes(client, orgId);
  for (let index = 0; index < boxes.length; index += 1) {
    boxById[boxes[index].boxId] = boxes[index];
  }

  return {
    summary: buildAllocationJobSummary(normalizedJobNumber, allocations, filmOrders),
    allocations: buildPublicAllocationEntriesForJob(allocations, boxById),
    usage: buildPublicJobUsageEntries(rollHistory, boxById),
    filmOrders: await buildPublicFilmOrdersForJob(client, orgId, filmOrders)
  };
}

async function buildJobsList(client, orgId, limit) {
  const jobs = await listJobs(client, orgId);
  const allAllocations = await listAllocations(client, orgId);
  const allFilmOrders = await listFilmOrders(client, orgId);
  const allRequirements = await listJobRequirements(client, orgId);
  const allBoxes = await listBoxes(client, orgId);
  const groupedAllocations = groupEntriesByJobNumber(allAllocations);
  const groupedFilmOrders = groupEntriesByJobNumber(allFilmOrders);
  const groupedRequirements = groupEntriesByJobNumber(allRequirements);
  const byJobNumber = {};
  const boxById = {};
  const response = [];

  for (let index = 0; index < allBoxes.length; index += 1) {
    boxById[allBoxes[index].boxId] = allBoxes[index];
  }

  for (let index = 0; index < jobs.length; index += 1) {
    byJobNumber[jobs[index].jobNumber] = jobs[index];
  }

  for (let index = 0; index < allAllocations.length; index += 1) {
    if (allAllocations[index].jobNumber) {
      byJobNumber[allAllocations[index].jobNumber] =
        byJobNumber[allAllocations[index].jobNumber] || null;
    }
  }

  for (let index = 0; index < allFilmOrders.length; index += 1) {
    if (allFilmOrders[index].jobNumber) {
      byJobNumber[allFilmOrders[index].jobNumber] =
        byJobNumber[allFilmOrders[index].jobNumber] || null;
    }
  }

  const jobNumbers = Object.keys(byJobNumber);
  for (let index = 0; index < jobNumbers.length; index += 1) {
    const jobNumber = jobNumbers[index];
    const allocations = groupedAllocations[jobNumber] || [];
    const filmOrders = groupedFilmOrders[jobNumber] || [];
    const requirements = buildPublicJobRequirementEntries(
      groupedRequirements[jobNumber] || [],
      allocations,
      boxById
    );
    const header = byJobNumber[jobNumber] || buildLegacyJobHeaderFromData(jobNumber, allocations, filmOrders);

    response.push(buildJobListEntry(header, requirements, allocations, filmOrders, allAllocations));
  }

  response.sort(compareJobsListEntries);

  if (limit > 0 && response.length > limit) {
    return response.slice(0, limit);
  }

  return response;
}

async function buildJobsSearchResults(client, orgId, query, limit) {
  const normalizedQueryDigits = extractJobNumberDigitsForSearch(query);
  if (!normalizedQueryDigits) {
    return [];
  }

  const normalizedLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 25;
  const queryCanonical = canonicalizeNumericDigits(normalizedQueryDigits);
  const queryValue = BigInt(queryCanonical);
  const ranked = [];
  const entries = await buildJobsList(client, orgId, 0);

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const lifecycle = asTrimmedString(entry.lifecycleStatus || 'ACTIVE').toUpperCase();
    if (lifecycle !== 'ACTIVE') {
      continue;
    }

    const jobDigits = extractJobNumberDigitsForSearch(entry.jobNumber);
    if (!jobDigits) {
      continue;
    }

    const jobCanonical = canonicalizeNumericDigits(jobDigits);
    const jobValue = BigInt(jobCanonical);
    const isPrefixMatch = jobCanonical.startsWith(queryCanonical);
    ranked.push({
      entry,
      isPrefixMatch,
      isExactMatch: jobCanonical === queryCanonical,
      distance: absoluteBigInt(jobValue - queryValue),
      lengthDelta: Math.abs(jobCanonical.length - queryCanonical.length)
    });
  }

  ranked.sort((left, right) => {
    if (left.isPrefixMatch !== right.isPrefixMatch) {
      return left.isPrefixMatch ? -1 : 1;
    }

    if (left.isPrefixMatch && right.isPrefixMatch) {
      if (left.isExactMatch !== right.isExactMatch) {
        return left.isExactMatch ? -1 : 1;
      }

      if (left.lengthDelta !== right.lengthDelta) {
        return left.lengthDelta - right.lengthDelta;
      }
    }

    const distanceOrder = compareBigInt(left.distance, right.distance);
    if (distanceOrder !== 0) {
      return distanceOrder;
    }

    return compareJobsListEntries(left.entry, right.entry);
  });

  return ranked.slice(0, normalizedLimit).map((entry) => entry.entry);
}

async function buildJobDetail(client, orgId, jobNumber) {
  const normalizedJobNumber = requireString(jobNumber, 'jobNumber');
  let header = await findJobByNumber(client, orgId, normalizedJobNumber);
  const allocations = await listAllocationsByJob(client, orgId, normalizedJobNumber);
  const filmOrders = await listFilmOrdersByJob(client, orgId, normalizedJobNumber);
  const requirements = await listJobRequirementsByJob(client, orgId, normalizedJobNumber);
  const rollHistory = await listRollHistoryByJob(client, orgId, normalizedJobNumber);
  const allAllocations = await listAllocations(client, orgId);

  if (!header && !allocations.length && !filmOrders.length && !requirements.length) {
    throw new HttpError(404, 'Job not found.');
  }

  if (!header) {
    header = buildLegacyJobHeaderFromData(normalizedJobNumber, allocations, filmOrders);
  }

  const boxById = {};
  const boxes = await listBoxes(client, orgId);
  for (let index = 0; index < boxes.length; index += 1) {
    boxById[boxes[index].boxId] = boxes[index];
  }

  const publicRequirements = buildPublicJobRequirementEntries(requirements, allocations, boxById);
  return {
    summary: buildJobListEntry(header, publicRequirements, allocations, filmOrders, allAllocations),
    requirements: publicRequirements,
    allocations: buildPublicAllocationEntriesForJob(allocations, boxById),
    usage: buildPublicJobUsageEntries(rollHistory, boxById),
    filmOrders: await buildPublicFilmOrdersForJob(client, orgId, filmOrders)
  };
}

async function ensureJobHeaderForUpdate(client, orgId, jobNumber, payload, user, nowIso) {
  const existing = await findJobByNumber(client, orgId, jobNumber);
  if (existing) {
    return existing;
  }

  const legacyAllocations = await listAllocationsByJob(client, orgId, jobNumber);
  const legacyFilmOrders = await listFilmOrdersByJob(client, orgId, jobNumber);
  const derived = buildLegacyJobHeaderFromData(jobNumber, legacyAllocations, legacyFilmOrders);

  derived.warehouse = payload.warehouse ? normalizeJobWarehouse(payload.warehouse) : derived.warehouse;
  derived.sections = normalizeJobSections(payload.sections);
  derived.dueDate = normalizeDateString(payload.dueDate, 'DueDate', true);
  derived.crewLeader =
    payload.crewLeader !== undefined ? asTrimmedString(payload.crewLeader) : derived.crewLeader;
  derived.lifecycleStatus = normalizeJobLifecycleStatus(payload.lifecycleStatus);
  derived.createdAt = derived.createdAt || nowIso;
  derived.createdBy = derived.createdBy || user;
  derived.updatedAt = nowIso;
  derived.updatedBy = user;
  derived.notes = asTrimmedString(payload.notes || derived.notes);

  return saveJobRecord(client, orgId, derived);
}

async function resolveExistingOrLegacyJobHeader(client, orgId, jobNumber, actor, nowIso) {
  const existing = await findJobByNumber(client, orgId, jobNumber);
  if (existing) {
    return {
      header: existing,
      allocations: null,
      filmOrders: null
    };
  }

  const allocations = await listAllocationsByJob(client, orgId, jobNumber);
  const filmOrders = await listFilmOrdersByJob(client, orgId, jobNumber);
  const requirements = await listJobRequirementsByJob(client, orgId, jobNumber);
  if (!allocations.length && !filmOrders.length && !requirements.length) {
    return {
      header: null,
      allocations,
      filmOrders
    };
  }

  const derived = buildLegacyJobHeaderFromData(jobNumber, allocations, filmOrders);
  const legacyStatus = deriveJobStatusFromLegacyAllocationData(allocations, filmOrders);
  if (legacyStatus === 'CANCELLED') {
    derived.lifecycleStatus = 'CANCELLED';
  } else if (legacyStatus === 'COMPLETED') {
    derived.lifecycleStatus = 'COMPLETED';
  } else {
    derived.lifecycleStatus = 'ACTIVE';
  }
  derived.createdAt = derived.createdAt || nowIso;
  derived.createdBy = derived.createdBy || actor;
  derived.updatedAt = nowIso;
  derived.updatedBy = actor;

  return {
    header: await saveJobRecord(client, orgId, derived),
    allocations,
    filmOrders
  };
}

function boxMatchesReportFilters(box, filters) {
  if (filters.warehouse && box.warehouse !== filters.warehouse) {
    return false;
  }

  const manufacturerFilterKey = normalizeCatalogManufacturerLookupKey(filters.manufacturer);
  if (
    manufacturerFilterKey &&
    normalizeCatalogManufacturerLookupKey(box.manufacturer).indexOf(manufacturerFilterKey) === -1
  ) {
    return false;
  }

  if (
    filters.film &&
    box.filmName.toLowerCase().indexOf(filters.film.toLowerCase()) === -1 &&
    box.filmKey.toLowerCase().indexOf(filters.film.toLowerCase()) === -1 &&
    box.manufacturer.toLowerCase().indexOf(filters.film.toLowerCase()) === -1
  ) {
    return false;
  }

  if (filters.width && String(box.widthIn) !== filters.width) {
    return false;
  }

  return true;
}

function extractClosedDate(updatedAt) {
  const timestamp = asTrimmedString(updatedAt);
  if (!timestamp) {
    return '';
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(timestamp)) {
    return timestamp;
  }

  return timestamp.slice(0, 10);
}

function matchesClosedJobReportFilters(jobEntry, filters) {
  if (filters.warehouse && jobEntry.warehouse !== filters.warehouse) {
    return false;
  }

  const closedDate = extractClosedDate(jobEntry.updatedAt);
  if (!closedDate) {
    return false;
  }

  if (filters.from && closedDate < filters.from) {
    return false;
  }

  if (filters.to && closedDate > filters.to) {
    return false;
  }

  return true;
}

async function buildReportsSummary(client, orgId, params) {
  const filters = {
    warehouse: asTrimmedString(params.warehouse).toUpperCase(),
    manufacturer: canonicalizeManufacturerLabel(params.manufacturer),
    film: asTrimmedString(params.film),
    width: asTrimmedString(params.width),
    from: asTrimmedString(params.from),
    to: asTrimmedString(params.to)
  };
  const allBoxes = await listBoxes(client, orgId);
  const activeBoxes = allBoxes.filter((box) => box.status !== 'ZEROED' && box.status !== 'RETIRED');
  const widthGroups = {};
  const availableFeetByWidth = [];
  const neverCheckedOut = [];
  const zeroedByMonthMap = {};
  const zeroedByMonth = [];
  const completedJobs = [];
  const cancelledJobs = [];

  for (let index = 0; index < activeBoxes.length; index += 1) {
    const activeBox = activeBoxes[index];
    if (!boxMatchesReportFilters(activeBox, filters)) {
      continue;
    }

    const widthKey = String(activeBox.widthIn);
    if (!widthGroups[widthKey]) {
      widthGroups[widthKey] = {
        widthIn: activeBox.widthIn,
        totalFeetAvailable: 0,
        boxCount: 0
      };
    }

    widthGroups[widthKey].totalFeetAvailable += activeBox.feetAvailable;
    widthGroups[widthKey].boxCount += 1;
  }

  for (const widthGroupKey of Object.keys(widthGroups)) {
    availableFeetByWidth.push(widthGroups[widthGroupKey]);
  }

  availableFeetByWidth.sort((left, right) => left.widthIn - right.widthIn);

  for (let index = 0; index < allBoxes.length; index += 1) {
    const box = allBoxes[index];
    if (!boxMatchesReportFilters(box, filters)) {
      continue;
    }

    if (box.receivedDate && !box.hasEverBeenCheckedOut) {
      if (filters.from && box.receivedDate < filters.from) {
        continue;
      }

      if (filters.to && box.receivedDate > filters.to) {
        continue;
      }

      neverCheckedOut.push({
        boxId: box.boxId,
        warehouse: box.warehouse,
        manufacturer: box.manufacturer,
        filmName: box.filmName,
        widthIn: box.widthIn,
        receivedDate: box.receivedDate,
        status: box.status,
        feetAvailable: box.feetAvailable
      });
    }

    if (box.status === 'ZEROED' && box.zeroedDate) {
      if (filters.from && box.zeroedDate < filters.from) {
        continue;
      }

      if (filters.to && box.zeroedDate > filters.to) {
        continue;
      }

      const monthKey = box.zeroedDate.slice(0, 7);
      zeroedByMonthMap[monthKey] = (zeroedByMonthMap[monthKey] || 0) + 1;
    }
  }

  neverCheckedOut.sort((left, right) => {
    if (left.receivedDate !== right.receivedDate) {
      return left.receivedDate < right.receivedDate ? -1 : 1;
    }

    return left.boxId < right.boxId ? -1 : left.boxId > right.boxId ? 1 : 0;
  });

  for (const month of Object.keys(zeroedByMonthMap)) {
    zeroedByMonth.push({
      month,
      zeroedCount: zeroedByMonthMap[month]
    });
  }

  zeroedByMonth.sort((left, right) => (left.month < right.month ? -1 : left.month > right.month ? 1 : 0));

  const allJobEntries = await buildJobsList(client, orgId, 0);
  for (let index = 0; index < allJobEntries.length; index += 1) {
    const jobEntry = allJobEntries[index];
    const lifecycleStatus = normalizeJobLifecycleStatus(jobEntry.lifecycleStatus);

    if (lifecycleStatus !== 'COMPLETED' && lifecycleStatus !== 'CANCELLED') {
      continue;
    }

    if (!matchesClosedJobReportFilters(jobEntry, filters)) {
      continue;
    }

    const reportEntry = {
      jobNumber: jobEntry.jobNumber,
      warehouse: jobEntry.warehouse,
      dueDate: jobEntry.dueDate,
      crewLeader: jobEntry.crewLeader,
      status: jobEntry.status,
      lifecycleStatus,
      requiredFeet: jobEntry.requiredFeet,
      allocatedFeet: jobEntry.allocatedFeet,
      remainingFeet: jobEntry.remainingFeet,
      closedAt: asTrimmedString(jobEntry.updatedAt)
    };

    if (lifecycleStatus === 'COMPLETED') {
      completedJobs.push(reportEntry);
    } else {
      cancelledJobs.push(reportEntry);
    }
  }

  const compareClosedJobs = (left, right) => {
    if (left.closedAt !== right.closedAt) {
      return left.closedAt > right.closedAt ? -1 : 1;
    }

    return left.jobNumber > right.jobNumber ? -1 : left.jobNumber < right.jobNumber ? 1 : 0;
  };
  completedJobs.sort(compareClosedJobs);
  cancelledJobs.sort(compareClosedJobs);

  return {
    availableFeetByWidth,
    neverCheckedOut,
    zeroedByMonth,
    completedJobs,
    cancelledJobs
  };
}

async function addBox(client, orgId, payload, actor) {
  const warnings = [];
  const boxId = requireString(payload.boxId, 'BoxID');

  if (await findBoxById(client, orgId, boxId)) {
    throw new HttpError(400, 'A box with this BoxID already exists.');
  }

  let box = await buildBoxFromPayload(client, orgId, payload, warnings, null);
  applyAddOrEditWarnings(warnings, null, box);
  box = await saveBoxRecord(client, orgId, box);
  await seedFilmCatalogRecordIfMissing(client, orgId, {
    filmKey: box.filmKey,
    manufacturer: box.manufacturer,
    filmName: box.filmName,
    sourceBoxId: box.boxId
  });

  if (asTrimmedString(payload.filmOrderId)) {
    const linkedOrder = await linkBoxToFilmOrder(client, orgId, payload.filmOrderId, box, actor);
    warnings.push(
      `Box ${box.boxId} was linked to Film Order ${linkedOrder.filmOrderId} for job ${linkedOrder.jobNumber}.`
    );

    if (box.receivedDate && box.status === 'IN_STOCK') {
      box = await processLinkedFilmOrderReceipt(client, orgId, cloneValue(box), actor, warnings);
      box = await saveBoxRecord(client, orgId, box);
    }
  }

  const publicBox = toPublicBox(box);
  const logId = await appendAuditEntry(
    client,
    orgId,
    'ADD_BOX',
    box.boxId,
    null,
    publicBox,
    actor,
    asTrimmedString(payload.auditNote)
  );

  return ok({ box: publicBox, logId }, warnings);
}

async function updateBox(client, orgId, payload, actor) {
  const warnings = [];
  const requestedMoveToZeroed = payload.moveToZeroed === true || String(payload.moveToZeroed) === 'true';
  const existing = await findBoxById(client, orgId, payload.boxId);

  if (!existing) {
    throw new HttpError(404, 'Box not found.');
  }

  if (existing.status === 'ZEROED') {
    throw new HttpError(400, 'Zeroed boxes cannot be edited directly. Use audit undo instead.');
  }

  let updatedBox = await buildBoxFromPayload(client, orgId, payload, warnings, existing);
  if (
    existing.status !== 'CHECKED_OUT' &&
    existing.status !== 'RETIRED' &&
    deriveLifecycleStatus(existing.receivedDate) === 'ORDERED' &&
    updatedBox.status === 'IN_STOCK'
  ) {
    updatedBox.feetAvailable = updatedBox.initialFeet;
  }

  applyAddOrEditWarnings(warnings, existing, updatedBox);

  let auditAction = 'UPDATE_BOX';
  const autoMoveToZeroed = shouldAutoMoveToZeroed(existing, updatedBox);
  const moveToZeroed = requestedMoveToZeroed || autoMoveToZeroed;
  const reachedZeroState =
    Boolean(updatedBox.receivedDate) &&
    (updatedBox.feetAvailable === 0 || updatedBox.lastRollWeightLbs === 0);

  if (moveToZeroed) {
    if (!autoMoveToZeroed) {
      throw new HttpError(
        400,
        'Received boxes move to zeroed out inventory only after they have had Available Feet above 0 and then reach 0 Available Feet or 0 Last Roll Weight.'
      );
    }

    stampZeroedMetadata(updatedBox, actor, payload.auditNote);
    const cancelledAllocationCount = await cancelAllocationsForZeroedBox(
      client,
      orgId,
      updatedBox.boxId,
      actor
    );
    updatedBox = await saveBoxRecord(client, orgId, updatedBox);
    auditAction = 'ZERO_OUT_BOX';

    if (autoMoveToZeroed && !requestedMoveToZeroed) {
      warnings.push(
        'Box was automatically moved to zeroed out inventory because Available Feet or Last Roll Weight reached 0.'
      );
    }

    if (cancelledAllocationCount > 0) {
      warnings.push(
        `${cancelledAllocationCount} allocation${cancelledAllocationCount === 1 ? ' was' : 's were'} cancelled because the box moved to zeroed out inventory.`
      );
    }
  } else {
    if (reachedZeroState && !hasPositivePhysicalFeet(existing)) {
      warnings.push('Box stayed in active inventory because it has not had Available Feet above 0 yet.');
    }

    updatedBox = await processLinkedFilmOrderReceipt(client, orgId, updatedBox, actor, warnings);
    updatedBox = await saveBoxRecord(client, orgId, updatedBox);
  }

  const publicBefore = toPublicBox(existing);
  const publicAfter = toPublicBox(updatedBox);
  const logId = await appendAuditEntry(
    client,
    orgId,
    auditAction,
    updatedBox.boxId,
    publicBefore,
    publicAfter,
    actor,
    asTrimmedString(payload.auditNote)
  );

  return ok({ box: publicAfter, logId }, warnings);
}

async function setBoxStatus(client, orgId, payload, actor) {
  const warnings = [];
  const status = assertBoxStatus(payload.status);

  if (status === 'ORDERED') {
    throw new HttpError(400, 'ORDERED is derived from ReceivedDate and cannot be set manually.');
  }

  if (status === 'RETIRED') {
    throw new HttpError(400, 'RETIRED status is no longer supported.');
  }

  if (status === 'ZEROED') {
    throw new HttpError(400, 'ZEROED status is assigned automatically when a received box reaches 0.');
  }

  const existing = await findBoxById(client, orgId, payload.boxId);
  if (!existing) {
    throw new HttpError(404, 'Box not found.');
  }

  if (deriveLifecycleStatus(existing.receivedDate) === 'ORDERED') {
    throw new HttpError(400, 'Add a ReceivedDate on or before today before changing status.');
  }

  if (existing.status === 'ZEROED') {
    throw new HttpError(400, 'Zeroed boxes cannot change status directly. Use audit undo instead.');
  }

  if (existing.status === 'RETIRED') {
    throw new HttpError(400, 'Retired boxes cannot change status directly. Use audit undo instead.');
  }

  let updatedBox = cloneValue(existing);
  let auditAction = 'SET_STATUS';

  if (status === 'CHECKED_OUT') {
    const jobNumber = getCheckoutJobNumberFromAuditNotes(payload.auditNote);
    if (!jobNumber) {
      throw new HttpError(400, 'A checkout job number is required.');
    }

    updatedBox.status = 'CHECKED_OUT';
    updatedBox.hasEverBeenCheckedOut = true;
    updatedBox.lastCheckoutJob = jobNumber;
    updatedBox.lastCheckoutDate = todayDateString();
    updatedBox.zeroedDate = '';
    updatedBox.zeroedReason = '';
    updatedBox.zeroedBy = '';
    applyCheckoutWarnings(warnings, existing);

    const autoLinkResult = await autoLinkRemainingJobFeetToCheckedOutBox(
      client,
      orgId,
      updatedBox,
      jobNumber,
      actor,
      'checkout'
    );
    if (autoLinkResult.created) {
      warnings.push(
        `Auto-linked ${autoLinkResult.allocatedFeet} LF from ${updatedBox.boxId} to job ${jobNumber} at checkout.`
      );
    } else if (autoLinkResult.skippedReason === 'NO_REQUIREMENTS') {
      warnings.push(`No job requirements were found for job ${jobNumber}, so no LF was auto-linked.`);
    }

    const allocationResolution = await resolveAllocationsForCheckout(
      client,
      orgId,
      updatedBox.boxId,
      jobNumber,
      actor
    );
    if (allocationResolution.fulfilledCount > 0) {
      warnings.push(
        `Fulfilled ${allocationResolution.fulfilledCount} allocation${allocationResolution.fulfilledCount === 1 ? '' : 's'} totaling ${allocationResolution.fulfilledFeet} LF for job ${jobNumber}.`
      );
    }

    if (allocationResolution.otherJobs.length > 0) {
      warnings.push(`This box still has active allocations for ${allocationResolution.otherJobs.join(', ')}.`);
    }

    updatedBox = await saveBoxRecord(client, orgId, updatedBox);
  } else {
    updatedBox.status = 'IN_STOCK';
    updatedBox.lastRollWeightLbs = coerceNonNegativeNumber(payload.lastRollWeightLbs, 'LastRollWeightLbs');
    updatedBox.lastWeighedDate = todayDateString();
    let physicalFeetAvailable = updatedBox.feetAvailable;

    if (
      updatedBox.coreWeightLbs !== null &&
      updatedBox.lfWeightLbsPerFt !== null &&
      updatedBox.lfWeightLbsPerFt > 0
    ) {
      physicalFeetAvailable = deriveFeetAvailableFromRollWeight(
        updatedBox.lastRollWeightLbs,
        updatedBox.coreWeightLbs,
        updatedBox.lfWeightLbsPerFt,
        updatedBox.initialFeet
      );
    } else {
      warnings.push(
        'Available Feet could not be recalculated because this box is missing core or LF weight metadata.'
      );
    }

    const existingAllocations = await listAllocationsByBox(client, orgId, updatedBox.boxId);
    let activeAllocatedFeetAfterCheckIn = 0;
    for (let index = 0; index < existingAllocations.length; index += 1) {
      if (existingAllocations[index].status === 'ACTIVE') {
        activeAllocatedFeetAfterCheckIn += existingAllocations[index].allocatedFeet;
      }
    }

    updatedBox.feetAvailable = Math.max(physicalFeetAvailable - activeAllocatedFeetAfterCheckIn, 0);
    const willAutoZero =
      Boolean(updatedBox.receivedDate) &&
      existing.initialFeet > 0 &&
      (physicalFeetAvailable === 0 || updatedBox.lastRollWeightLbs === 0);

    applyCheckInWarnings(warnings, existing, updatedBox, willAutoZero);
    if (activeAllocatedFeetAfterCheckIn > physicalFeetAvailable) {
      warnings.push(
        'This box now has more LF allocated to future jobs than the weight-based remaining feet.'
      );
    } else if (activeAllocatedFeetAfterCheckIn > 0 && updatedBox.feetAvailable === 0) {
      warnings.push('All remaining LF on this box is reserved by active allocations.');
    }

    const checkoutAudit = await findLatestCheckoutAuditEntryByBoxId(client, orgId, updatedBox.boxId);
    let checkoutJob = asTrimmedString(existing.lastCheckoutJob);
    let checkoutDate = asTrimmedString(existing.lastCheckoutDate);
    let checkoutUser = '';

    if (checkoutAudit) {
      if (!checkoutJob) {
        checkoutJob = getCheckoutJobNumberFromAuditNotes(checkoutAudit.notes);
      }

      if (!checkoutDate) {
        checkoutDate = asTrimmedString(checkoutAudit.date);
      }

      checkoutUser = asTrimmedString(checkoutAudit.user);
    }

    if (!checkoutJob) {
      checkoutJob = 'UNKNOWN';
      warnings.push('Roll history was logged with UNKNOWN job number because no checkout job was saved.');
    }

    if (!checkoutDate) {
      checkoutDate = todayDateString();
    }

    const checkedOutWeight = existing.lastRollWeightLbs;
    const weightDelta =
      checkedOutWeight === null ? null : roundToDecimals(checkedOutWeight - updatedBox.lastRollWeightLbs, 2);

    if (checkedOutWeight === null) {
      warnings.push(
        'Roll history was logged without an outbound weight because no Last Roll Weight was saved at checkout.'
      );
    }

    await appendRollHistoryEntry(client, orgId, {
      logId: '',
      boxId: updatedBox.boxId,
      warehouse: updatedBox.warehouse,
      manufacturer: updatedBox.manufacturer,
      filmName: updatedBox.filmName,
      widthIn: updatedBox.widthIn,
      jobNumber: checkoutJob,
      checkedOutAt: checkoutDate,
      checkedOutBy: checkoutUser,
      checkedOutWeightLbs: checkedOutWeight,
      checkedInAt: new Date().toISOString(),
      checkedInBy: actor,
      checkedInWeightLbs: updatedBox.lastRollWeightLbs,
      weightDeltaLbs: weightDelta,
      feetBefore: existing.feetAvailable,
      feetAfter: updatedBox.feetAvailable,
      notes: asTrimmedString(payload.auditNote)
    });

    updatedBox.lastCheckoutJob = '';
    updatedBox.lastCheckoutDate = '';

    const reachedZeroState =
      Boolean(updatedBox.receivedDate) &&
      (physicalFeetAvailable === 0 || updatedBox.lastRollWeightLbs === 0);
    const autoMoveToZeroed = willAutoZero;

    if (autoMoveToZeroed) {
      stampZeroedMetadata(updatedBox, actor, payload.auditNote);
      const cancelledAllocationCount = await cancelAllocationsForZeroedBox(
        client,
        orgId,
        updatedBox.boxId,
        actor
      );
      updatedBox = await saveBoxRecord(client, orgId, updatedBox);
      auditAction = 'ZERO_OUT_BOX';
      warnings.push(
        'Box was automatically moved to zeroed out inventory because Available Feet or Last Roll Weight reached 0.'
      );

      if (cancelledAllocationCount > 0) {
        warnings.push(
          `${cancelledAllocationCount} allocation${cancelledAllocationCount === 1 ? ' was' : 's were'} cancelled because the box moved to zeroed out inventory.`
        );
      }
    } else {
      if (reachedZeroState && existing.feetAvailable <= 0) {
        warnings.push('Box stayed in active inventory because it has not had Available Feet above 0 yet.');
      }

      updatedBox = await saveBoxRecord(client, orgId, updatedBox);
    }
  }

  const publicBefore = toPublicBox(existing);
  const publicAfter = toPublicBox(updatedBox);
  const logId = await appendAuditEntry(
    client,
    orgId,
    auditAction,
    updatedBox.boxId,
    publicBefore,
    publicAfter,
    actor,
    asTrimmedString(payload.auditNote)
  );

  return ok({ box: publicAfter, logId }, warnings);
}

async function createJob(client, orgId, payload, actor) {
  const warnings = [];
  const jobNumber = normalizeJobNumberDigits(payload.jobNumber, 'Job ID number');
  const warehouse = normalizeJobWarehouse(payload.warehouse);
  const sections = normalizeJobSections(payload.sections);
  const dueDate = normalizeDateString(payload.dueDate, 'DueDate', true);
  const crewLeader = asTrimmedString(payload.crewLeader);
  const lifecycleStatus = normalizeJobLifecycleStatus(payload.lifecycleStatus);
  const notes = asTrimmedString(payload.notes);
  const incomingRequirementsRaw = dedupeJobRequirements(payload.requirements, warnings);
  const incomingRequirements = await canonicalizeJobRequirementEntriesWithAliases(
    client,
    orgId,
    incomingRequirementsRaw
  );
  const nowIso = new Date().toISOString();
  const existingHeader = await findJobByNumber(client, orgId, jobNumber);
  let nextHeader =
    existingHeader ||
    {
      id: '',
      orgId,
      jobNumber,
      warehouse,
      sections,
      dueDate,
      crewLeader,
      lifecycleStatus,
      notes,
      createdAt: nowIso,
      createdBy: actor,
      updatedAt: nowIso,
      updatedBy: actor
    };

  if (existingHeader) {
    nextHeader = {
      ...cloneValue(existingHeader),
      warehouse,
      sections,
      dueDate,
      crewLeader,
      lifecycleStatus,
      updatedAt: nowIso,
      updatedBy: actor,
      notes
    };
  }

  nextHeader = await saveJobRecord(client, orgId, nextHeader);

  const existingRequirements = await listJobRequirementsByJob(client, orgId, jobNumber);
  const merged = {};

  for (let index = 0; index < existingRequirements.length; index += 1) {
    const existing = existingRequirements[index];
    const existingCanonical = await resolveCanonicalFilmEntry(
      client,
      orgId,
      existing.manufacturer,
      existing.filmName
    );
    const existingManufacturer = existingCanonical.manufacturer;
    const existingFilmName = existingCanonical.filmName;
    const existingKey = normalizeJobRequirementLookupKey(
      existingManufacturer,
      existingFilmName,
      existing.widthIn
    );
    merged[existingKey] = {
      manufacturer: existingManufacturer,
      filmName: existingFilmName,
      widthIn: existing.widthIn,
      requiredFeet: existing.requiredFeet
    };
  }

  for (let index = 0; index < incomingRequirements.length; index += 1) {
    const incoming = incomingRequirements[index];
    const incomingKey = normalizeJobRequirementLookupKey(
      incoming.manufacturer,
      incoming.filmName,
      incoming.widthIn
    );

    if (!merged[incomingKey]) {
      merged[incomingKey] = incoming;
      continue;
    }

    merged[incomingKey].requiredFeet += incoming.requiredFeet;
  }

  const mergedValues = Object.values(merged);
  const existingByKey = buildJobRequirementsByLookupKey(existingRequirements);
  await replaceJobRequirementsForJob(
    client,
    orgId,
    nextHeader,
    buildRequirementRowsForReplace(jobNumber, mergedValues, existingByKey, actor, nowIso)
  );

  return ok(await buildJobDetail(client, orgId, jobNumber), warnings);
}

async function syncJobMetadataToActiveAllocationsAndOpenFilmOrders(
  client,
  orgId,
  jobNumber,
  jobDate,
  crewLeader
) {
  const allocations = await listAllocationsByJob(client, orgId, jobNumber);
  const filmOrders = await listFilmOrdersByJob(client, orgId, jobNumber);
  let updatedAllocationCount = 0;
  let updatedFilmOrderCount = 0;

  for (let index = 0; index < allocations.length; index += 1) {
    const allocation = cloneValue(allocations[index]);
    if (allocation.status !== 'ACTIVE') {
      continue;
    }

    if (allocation.jobDate === jobDate && allocation.crewLeader === crewLeader) {
      continue;
    }

    allocation.jobDate = jobDate;
    allocation.crewLeader = crewLeader;
    await saveAllocationRecord(client, orgId, allocation);
    updatedAllocationCount += 1;
  }

  for (let index = 0; index < filmOrders.length; index += 1) {
    const filmOrder = cloneValue(filmOrders[index]);
    if (filmOrder.status === 'CANCELLED' || filmOrder.status === 'FULFILLED') {
      continue;
    }

    if (filmOrder.jobDate === jobDate && filmOrder.crewLeader === crewLeader) {
      continue;
    }

    filmOrder.jobDate = jobDate;
    filmOrder.crewLeader = crewLeader;
    await saveFilmOrderRecord(client, orgId, filmOrder);
    updatedFilmOrderCount += 1;
  }

  return {
    updatedAllocationCount,
    updatedFilmOrderCount
  };
}

async function updateJob(client, orgId, payload, actor) {
  const warnings = [];
  const jobNumber = normalizeJobNumberDigits(payload.jobNumber, 'Job ID number');
  if (
    payload.lifecycleStatus !== undefined &&
    normalizeJobLifecycleStatus(payload.lifecycleStatus) !== 'ACTIVE'
  ) {
    throw new HttpError(400, `Closed lifecycle changes are not allowed here. Use complete/reopen actions for job ${jobNumber}.`);
  }
  const requirementsRaw = dedupeJobRequirements(payload.requirements, warnings);
  const requirements = await canonicalizeJobRequirementEntriesWithAliases(client, orgId, requirementsRaw);
  const nowIso = new Date().toISOString();
  const header = await ensureJobHeaderForUpdate(client, orgId, jobNumber, payload, actor, nowIso);
  if (normalizeJobLifecycleStatus(header.lifecycleStatus) !== 'ACTIVE') {
    throw new HttpError(400, `Job ${jobNumber} is closed. Reopen it before editing.`);
  }
  const nextHeader = cloneValue(header);

  if (payload.warehouse !== undefined) {
    nextHeader.warehouse = normalizeJobWarehouse(payload.warehouse);
  }

  if (payload.sections !== undefined) {
    nextHeader.sections = normalizeJobSections(payload.sections);
  }

  if (payload.dueDate !== undefined) {
    nextHeader.dueDate = normalizeDateString(payload.dueDate, 'DueDate', true);
  }

  if (payload.crewLeader !== undefined) {
    nextHeader.crewLeader = asTrimmedString(payload.crewLeader);
  }

  if (payload.lifecycleStatus !== undefined) {
    nextHeader.lifecycleStatus = normalizeJobLifecycleStatus(payload.lifecycleStatus);
  }

  if (payload.notes !== undefined) {
    nextHeader.notes = asTrimmedString(payload.notes);
  }

  nextHeader.updatedAt = nowIso;
  nextHeader.updatedBy = actor;

  const savedHeader = await saveJobRecord(client, orgId, nextHeader);
  const existingRequirements = await listJobRequirementsByJob(client, orgId, jobNumber);
  const existingByKey = buildJobRequirementsByLookupKey(existingRequirements);
  await replaceJobRequirementsForJob(
    client,
    orgId,
    savedHeader,
    buildRequirementRowsForReplace(jobNumber, requirements, existingByKey, actor, nowIso)
  );

  const dueDateChanged = asTrimmedString(header.dueDate) !== asTrimmedString(savedHeader.dueDate);
  const crewLeaderChanged =
    normalizeCrewLeaderKey(header.crewLeader) !== normalizeCrewLeaderKey(savedHeader.crewLeader);
  if (dueDateChanged || crewLeaderChanged) {
    const syncResult = await syncJobMetadataToActiveAllocationsAndOpenFilmOrders(
      client,
      orgId,
      jobNumber,
      savedHeader.dueDate,
      savedHeader.crewLeader
    );
    if (syncResult.updatedAllocationCount > 0 || syncResult.updatedFilmOrderCount > 0) {
      warnings.push(
        `Updated scheduling metadata on ${syncResult.updatedAllocationCount} active allocation${syncResult.updatedAllocationCount === 1 ? '' : 's'} and ${syncResult.updatedFilmOrderCount} open film order${syncResult.updatedFilmOrderCount === 1 ? '' : 's'}.`
      );
    }
  }

  return ok(await buildJobDetail(client, orgId, jobNumber), warnings);
}

async function completeJob(client, orgId, payload, actor) {
  const warnings = [];
  const jobNumber = normalizeJobNumberDigits(payload.jobNumber, 'Job ID number');
  const resolvedAt = new Date().toISOString();
  const resolvedContext = await resolveExistingOrLegacyJobHeader(
    client,
    orgId,
    jobNumber,
    actor,
    resolvedAt
  );
  const existingJob = resolvedContext.header;
  if (!existingJob) {
    throw new HttpError(404, `Job ${jobNumber} was not found.`);
  }

  const lifecycleStatus = normalizeJobLifecycleStatus(existingJob.lifecycleStatus);
  if (lifecycleStatus === 'COMPLETED') {
    throw new HttpError(400, `Job ${jobNumber} is already completed.`);
  }

  if (lifecycleStatus === 'CANCELLED') {
    throw new HttpError(400, `Job ${jobNumber} is cancelled and cannot be completed.`);
  }

  const checkedOutBoxes = (await listBoxes(client, orgId)).filter(
    (box) =>
      box.status === 'CHECKED_OUT' &&
      normalizeJobNumberKey(box.lastCheckoutJob) === normalizeJobNumberKey(jobNumber)
  );
  if (checkedOutBoxes.length) {
    const listedBoxes = checkedOutBoxes
      .slice(0, 5)
      .map((box) => box.boxId)
      .join(', ');
    const suffix = checkedOutBoxes.length > 5 ? ', ...' : '';
    throw new HttpError(
      400,
      `Job ${jobNumber} cannot be completed while boxes are still checked out: ${listedBoxes}${suffix}.`
    );
  }

  const cancelNote =
    asTrimmedString(payload.reason) || `Cancelled because job ${jobNumber} was marked completed.`;
  const activeAllocations = resolvedContext.allocations || (await listAllocationsByJob(client, orgId, jobNumber));
  const releasedFeetByBox = {};
  let cancelledAllocationCount = 0;

  for (let index = 0; index < activeAllocations.length; index += 1) {
    const allocation = cloneValue(activeAllocations[index]);
    if (allocation.status !== 'ACTIVE') {
      continue;
    }

    releasedFeetByBox[allocation.boxId] =
      integerOrZero(releasedFeetByBox[allocation.boxId]) + integerOrZero(allocation.allocatedFeet);
    allocation.status = 'CANCELLED';
    allocation.resolvedAt = resolvedAt;
    allocation.resolvedBy = asTrimmedString(actor);
    allocation.notes = cancelNote;
    await saveAllocationRecord(client, orgId, allocation);
    cancelledAllocationCount += 1;
  }

  for (const boxId of Object.keys(releasedFeetByBox)) {
    const box = await findBoxById(client, orgId, boxId);
    if (!box || box.status === 'ZEROED' || box.status === 'RETIRED') {
      continue;
    }

    box.feetAvailable = Math.max(0, integerOrZero(box.feetAvailable) + integerOrZero(releasedFeetByBox[boxId]));
    await saveBoxRecord(client, orgId, box);
  }

  const filmOrders = resolvedContext.filmOrders || (await listFilmOrdersByJob(client, orgId, jobNumber));
  let cancelledFilmOrderCount = 0;
  for (let index = 0; index < filmOrders.length; index += 1) {
    const filmOrder = cloneValue(filmOrders[index]);
    if (filmOrder.status !== 'FILM_ORDER' && filmOrder.status !== 'FILM_ON_THE_WAY') {
      continue;
    }

    filmOrder.status = 'CANCELLED';
    filmOrder.resolvedAt = resolvedAt;
    filmOrder.resolvedBy = asTrimmedString(actor);
    filmOrder.notes = cancelNote;
    await saveFilmOrderRecord(client, orgId, filmOrder);
    cancelledFilmOrderCount += 1;
  }

  existingJob.lifecycleStatus = 'COMPLETED';
  existingJob.updatedAt = resolvedAt;
  existingJob.updatedBy = actor;
  await saveJobRecord(client, orgId, existingJob);

  warnings.push(
    `Marked job ${jobNumber} completed. Cancelled ${cancelledAllocationCount} active allocation${cancelledAllocationCount === 1 ? '' : 's'} and ${cancelledFilmOrderCount} open film order${cancelledFilmOrderCount === 1 ? '' : 's'}.`
  );

  return ok(await buildJobDetail(client, orgId, jobNumber), warnings);
}

async function reopenJob(client, orgId, payload, actor) {
  const warnings = [];
  const jobNumber = normalizeJobNumberDigits(payload.jobNumber, 'Job ID number');
  const nowIso = new Date().toISOString();
  const resolvedContext = await resolveExistingOrLegacyJobHeader(client, orgId, jobNumber, actor, nowIso);
  const existingJob = resolvedContext.header;
  if (!existingJob) {
    throw new HttpError(404, `Job ${jobNumber} was not found.`);
  }

  const lifecycleStatus = normalizeJobLifecycleStatus(existingJob.lifecycleStatus);
  if (lifecycleStatus !== 'COMPLETED' && lifecycleStatus !== 'CANCELLED') {
    throw new HttpError(400, `Job ${jobNumber} is already active.`);
  }

  existingJob.lifecycleStatus = 'ACTIVE';
  existingJob.updatedAt = nowIso;
  existingJob.updatedBy = actor;
  await saveJobRecord(client, orgId, existingJob);
  warnings.push(`Reopened job ${jobNumber}. Previously cancelled allocations and film orders remain cancelled.`);

  return ok(await buildJobDetail(client, orgId, jobNumber), warnings);
}

async function createFilmOrder(client, orgId, payload, actor) {
  const warnings = [];
  const warehouse = await requireConfiguredWarehouse(client, orgId, payload.warehouse, 'Warehouse');
  const jobNumber = requireString(payload.jobNumber, 'JobNumber');
  const manufacturer = canonicalizeManufacturerLabel(requireString(payload.manufacturer, 'Manufacturer'));
  const filmName = normalizeCollapsedCatalogLabel(requireString(payload.filmName, 'FilmName'));
  const widthIn = coerceNonNegativeNumber(payload.widthIn, 'WidthIn');
  const requestedFeet = coerceFeetValue(payload.requestedFeet, 'RequestedFeet', warnings, false);

  if (widthIn <= 0) {
    throw new HttpError(400, 'WidthIn must be greater than zero.');
  }

  if (requestedFeet <= 0) {
    throw new HttpError(400, 'RequestedFeet must be greater than zero.');
  }

  const existingJob = await findJobByNumber(client, orgId, jobNumber);
  if (existingJob && normalizeJobLifecycleStatus(existingJob.lifecycleStatus) !== 'ACTIVE') {
    throw new HttpError(400, `Job ${jobNumber} is closed and cannot receive film orders.`);
  }

  const jobId = await getOrResolveJobId(client, orgId, jobNumber);
  const entry = await saveFilmOrderRecord(client, orgId, {
    filmOrderId: '',
    jobId,
    jobNumber,
    warehouse,
    manufacturer,
    filmName,
    widthIn,
    requestedFeet,
    coveredFeet: 0,
    orderedFeet: 0,
    remainingToOrderFeet: requestedFeet,
    jobDate: '',
    crewLeader: '',
    status: 'FILM_ORDER',
    sourceBoxId: '',
    createdAt: new Date().toISOString(),
    createdBy: asTrimmedString(actor),
    resolvedAt: '',
    resolvedBy: '',
    notes: 'Created manually from Film Orders.'
  });

  return ok(toPublicFilmOrder(entry, []), warnings);
}

async function cancelJob(client, orgId, payload, actor) {
  const warnings = [];
  const jobNumber = requireString(payload.jobNumber, 'JobNumber');
  const result = await cancelJobAndReleaseAllocations(client, orgId, jobNumber, actor, payload.reason);
  const existingJob = await findJobByNumber(client, orgId, jobNumber);

  if (existingJob) {
    existingJob.lifecycleStatus = 'CANCELLED';
    existingJob.updatedAt = new Date().toISOString();
    existingJob.updatedBy = actor;
    await saveJobRecord(client, orgId, existingJob);
  }

  warnings.push(
    `Cancelled job ${jobNumber}. Released ${result.releasedAllocationCount} active allocation${result.releasedAllocationCount === 1 ? '' : 's'} across ${result.affectedBoxCount} box${result.affectedBoxCount === 1 ? '' : 'es'}.`
  );

  return ok({ jobNumber }, warnings);
}

async function removeJobBoxAllocation(client, orgId, payload, actor) {
  const warnings = [];
  const jobNumber = requireString(payload.jobNumber, 'JobNumber');
  const allocationId = requireString(payload.allocationId, 'AllocationID');
  const result = await removeAllocationFromJob(
    client,
    orgId,
    jobNumber,
    allocationId,
    actor,
    payload.reason
  );

  if (result.removedAllocationCount === 0) {
    warnings.push(`Allocation ${allocationId} was already cancelled for job ${jobNumber}.`);
  } else {
    warnings.push(
      `Removed allocation ${result.allocationId} for box ${result.boxId} on job ${jobNumber}. Released ${result.releasedFeet} LF back to box availability.`
    );
  }

  return ok(
    {
      jobNumber,
      allocationId: result.allocationId,
      boxId: result.boxId,
      removedAllocationCount: result.removedAllocationCount,
      releasedFeet: result.releasedFeet
    },
    warnings
  );
}

async function deleteFilmOrder(client, orgId, payload, actor) {
  const warnings = [];
  const filmOrderId = requireString(payload.filmOrderId, 'FilmOrderID');
  const result = await cancelFilmOrderAndReleaseAllocations(
    client,
    orgId,
    filmOrderId,
    actor,
    payload.reason || 'Deleted from Film Orders.'
  );

  warnings.push(
    `Deleted film order ${filmOrderId}. Released ${result.releasedAllocationCount} active allocation${result.releasedAllocationCount === 1 ? '' : 's'} across ${result.affectedBoxCount} box${result.affectedBoxCount === 1 ? '' : 'es'}.`
  );

  return ok(toPublicFilmOrder(result.filmOrder, []), warnings);
}

async function deleteBox(client, orgId, payload, actor) {
  const boxId = requireString(payload.boxId, 'BoxID');
  const reason = asTrimmedString(payload.reason) || 'Deleted from box details.';
  const current = await findBoxById(client, orgId, boxId);

  if (!current) {
    throw new HttpError(404, 'Box not found.');
  }

  if (current.status === 'CHECKED_OUT') {
    throw new HttpError(
      400,
      'Checked-out boxes cannot be deleted. Check the box in or zero it out first.'
    );
  }

  const activeAllocationRow = await queryRow(
    client,
    `
      select count(*)::integer as count
      from app.allocations
      where org_id = $1
        and box_id = $2
        and status = 'ACTIVE'
    `,
    [orgId, current.boxId]
  );

  if (integerOrZero(activeAllocationRow?.count) > 0) {
    throw new HttpError(
      400,
      'Boxes with active allocations cannot be deleted. Resolve the allocations first.'
    );
  }

  const linkedFilmOrderRow = await queryRow(
    client,
    `
      select count(*)::integer as count
      from app.film_order_box_links
      where org_id = $1
        and box_id = $2
    `,
    [orgId, current.boxId]
  );

  if (integerOrZero(linkedFilmOrderRow?.count) > 0) {
    throw new HttpError(
      400,
      'Boxes linked to film orders cannot be deleted. Resolve the linked film order first.'
    );
  }

  await deleteBoxRecord(client, orgId, current.boxId);
  const logId = await appendAuditEntry(
    client,
    orgId,
    'DELETE_BOX',
    current.boxId,
    toPublicBox(current),
    null,
    actor,
    reason
  );

  return ok({ boxId: current.boxId, logId });
}

async function previewAllocationPlan(client, orgId, payload) {
  const source = await findBoxById(client, orgId, payload.boxId);
  if (!source) {
    throw new HttpError(404, 'Box not found.');
  }

  if (!isAllocatableBoxStatus(source.status)) {
    throw new HttpError(400, 'Only in-stock or checked-out boxes can be allocated.');
  }

  const crossWarehouse = parseCrossWarehouseFlag(payload.crossWarehouse);
  const allBoxes = await listBoxes(client, orgId);
  const activeAllocationsByBox = buildActiveAllocationsByBoxIndex(await listActiveAllocations(client, orgId));
  const jobContext = await resolveJobContext(
    client,
    orgId,
    payload.jobNumber,
    payload.jobDate,
    payload.crewLeader
  );

  return buildAllocationPreviewPlan(source, payload.requestedFeet, jobContext, {
    crossWarehouse,
    minimumWidthIn: payload.requestedWidthIn,
    allBoxes,
    activeAllocationsByBox
  });
}

async function applyAllocationPlan(client, orgId, payload, actor) {
  const warnings = [];
  const boxId = requireString(payload.boxId, 'BoxID');
  const crossWarehouse = parseCrossWarehouseFlag(payload.crossWarehouse);
  const source = await findBoxById(client, orgId, boxId);

  if (!source) {
    throw new HttpError(404, 'Box not found.');
  }

  if (!isAllocatableBoxStatus(source.status)) {
    throw new HttpError(400, 'Only in-stock or checked-out boxes can be allocated.');
  }

  const allBoxes = await listBoxes(client, orgId);
  const boxById = {};
  for (let index = 0; index < allBoxes.length; index += 1) {
    boxById[allBoxes[index].boxId] = cloneValue(allBoxes[index]);
  }

  const activeAllocationsByBox = buildActiveAllocationsByBoxIndex(await listActiveAllocations(client, orgId));
  const jobContext = await resolveJobContext(
    client,
    orgId,
    payload.jobNumber,
    payload.jobDate,
    payload.crewLeader
  );
  const plan = buildAllocationPreviewPlan(source, payload.requestedFeet, jobContext, {
    crossWarehouse,
    minimumWidthIn: payload.requestedWidthIn,
    allBoxes,
    activeAllocationsByBox
  });
  const selectedSuggestionBoxIds = Array.isArray(payload.selectedSuggestionBoxIds)
    ? payload.selectedSuggestionBoxIds.map((value) => asTrimmedString(value))
    : plan.suggestions.map((suggestion) => suggestion.boxId);
  const selection = calculateSelectedSuggestionAllocations(plan, selectedSuggestionBoxIds);
  const createdAllocations = [];

  for (let index = 0; index < selection.allocations.length; index += 1) {
    const plannedAllocation = selection.allocations[index];
    if (plannedAllocation.allocatedFeet <= 0) {
      continue;
    }

    const currentBox = boxById[plannedAllocation.boxId] || (await findBoxById(client, orgId, plannedAllocation.boxId));
    if (!currentBox) {
      throw new HttpError(404, `Box not found: ${plannedAllocation.boxId}`);
    }

    if (!isAllocatableBoxStatus(currentBox.status)) {
      throw new HttpError(400, `Box ${currentBox.boxId} is no longer allocatable.`);
    }

    if (currentBox.feetAvailable < plannedAllocation.allocatedFeet) {
      throw new HttpError(400, `Box ${currentBox.boxId} no longer has enough available LF.`);
    }

    const allocation = await createAllocationRecord(
      client,
      orgId,
      currentBox,
      jobContext,
      plannedAllocation.allocatedFeet,
      actor,
      ''
    );
    currentBox.feetAvailable = Math.max(currentBox.feetAvailable - plannedAllocation.allocatedFeet, 0);
    boxById[currentBox.boxId] = await saveBoxRecord(client, orgId, currentBox);
    createdAllocations.push(toPublicAllocation(allocation));
  }

  let publicFilmOrder = null;
  if (selection.remainingFeet > 0) {
    const filmOrder = await createFilmOrderForShortage(
      client,
      orgId,
      source,
      jobContext,
      payload.requestedFeet,
      selection.remainingFeet,
      actor,
      normalizeOptionalWarehouse(payload.jobWarehouse, 'JobWarehouse')
    );
    publicFilmOrder = filmOrder
      ? toPublicFilmOrder(filmOrder, await buildPublicFilmOrderLinkedBoxes(client, orgId, filmOrder.filmOrderId))
      : null;

    if (filmOrder) {
      warnings.push(
        `Film Order ${filmOrder.filmOrderId} was created for the remaining ${selection.remainingFeet} LF.`
      );
    }
  }

  return ok(
    {
      allocations: createdAllocations,
      filmOrder: publicFilmOrder,
      remainingUncoveredFeet: selection.remainingFeet
    },
    warnings
  );
}

async function listAudit(client, orgId, params) {
  const from = asTrimmedString(params.from);
  const to = asTrimmedString(params.to);
  const user = asTrimmedString(params.user).toLowerCase();
  const action = asTrimmedString(params.action).toLowerCase();
  const entries = await listAuditEntries(client, orgId);
  const filtered = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const entryDate = entry.date.slice(0, 10);

    if (from && entryDate < from) {
      continue;
    }

    if (to && entryDate > to) {
      continue;
    }

    if (user && entry.user.toLowerCase().indexOf(user) === -1) {
      continue;
    }

    if (action && entry.action.toLowerCase().indexOf(action) === -1) {
      continue;
    }

    filtered.push(entry);
  }

  return filtered;
}

async function undoAudit(client, orgId, payload, actor) {
  const reason = asTrimmedString(payload.reason);
  const warnings = [];
  const auditEntry = await findAuditEntryByLogId(client, orgId, payload.logId);

  if (!auditEntry) {
    throw new HttpError(404, 'Audit entry not found.');
  }

  const current = await findBoxById(client, orgId, auditEntry.boxId);
  const notes = `Undo ${auditEntry.action}${reason ? `: ${reason}` : ''}`;

  if (auditEntry.before) {
    let resultBox = cloneValue(auditEntry.before);
    resultBox = await saveBoxRecord(client, orgId, resultBox);

    if (auditEntry.action === 'SET_STATUS' && auditEntry.after && auditEntry.after.status === 'CHECKED_OUT') {
      const checkoutJobNumber = getCheckoutJobNumberFromAuditNotes(auditEntry.notes);
      if (checkoutJobNumber) {
        const reactivatedFulfilledCount = await reactivateFulfilledAllocationsForUndo(
          client,
          orgId,
          auditEntry.boxId,
          checkoutJobNumber
        );
        if (reactivatedFulfilledCount > 0) {
          warnings.push(
            `${reactivatedFulfilledCount} allocation${reactivatedFulfilledCount === 1 ? ' was' : 's were'} reactivated for job ${checkoutJobNumber}.`
          );
        }
      }
    }

    if (auditEntry.action === 'ZERO_OUT_BOX') {
      const reactivatedCancelledCount = await reactivateCancelledAllocationsForZeroUndo(
        client,
        orgId,
        auditEntry.boxId
      );
      if (reactivatedCancelledCount > 0) {
        warnings.push(
          `${reactivatedCancelledCount} zero-cancelled allocation${reactivatedCancelledCount === 1 ? ' was' : 's were'} reactivated.`
        );
      }
    }

    if (auditEntry.after && auditEntry.after.receivedDate && auditEntry.before && !auditEntry.before.receivedDate) {
      const cancelledFilmOrderAllocations = await cancelActiveFilmOrderAllocationsForBox(
        client,
        orgId,
        auditEntry.boxId,
        actor,
        'Cancelled because undo restored the box to its pre-receipt state.'
      );
      if (cancelledFilmOrderAllocations > 0) {
        warnings.push(
          `${cancelledFilmOrderAllocations} auto-allocation${cancelledFilmOrderAllocations === 1 ? ' was' : 's were'} cancelled because the linked box was reverted to pre-receipt.`
        );
      }
    }

    await recalculateFilmOrdersForBoxLinks(client, orgId, auditEntry.boxId, actor);

    const newLogId = await appendAuditEntry(
      client,
      orgId,
      'UNDO',
      auditEntry.boxId,
      current ? toPublicBox(current) : null,
      toPublicBox(resultBox),
      actor,
      notes
    );

    return ok({ box: toPublicBox(resultBox), logId: newLogId }, warnings);
  }

  if (!current) {
    throw new HttpError(400, 'Cannot undo add because the current box row is missing.');
  }

  await deleteBoxRecord(client, orgId, current.boxId);
  await cancelActiveFilmOrderAllocationsForBox(
    client,
    orgId,
    auditEntry.boxId,
    actor,
    'Cancelled because the linked box was removed by undo.'
  );
  await recalculateFilmOrdersForBoxLinks(client, orgId, auditEntry.boxId, actor);

  const newLogId = await appendAuditEntry(
    client,
    orgId,
    'UNDO_ADD_DELETE',
    auditEntry.boxId,
    toPublicBox(current),
    null,
    actor,
    notes
  );

  return ok({ box: null, logId: newLogId }, warnings);
}

async function buildFilmOrdersList(client, orgId) {
  const entries = await listFilmOrders(client, orgId);
  const sorted = entries.slice().sort((left, right) => {
    const leftOpen = left.status === 'FILM_ORDER' || left.status === 'FILM_ON_THE_WAY';
    const rightOpen = right.status === 'FILM_ORDER' || right.status === 'FILM_ON_THE_WAY';

    if (leftOpen !== rightOpen) {
      return leftOpen ? -1 : 1;
    }

    if (leftOpen) {
      return left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0;
    }

    const leftResolved = left.resolvedAt || left.createdAt;
    const rightResolved = right.resolvedAt || right.createdAt;
    return leftResolved < rightResolved ? -1 : leftResolved > rightResolved ? 1 : 0;
  });
  const response = [];

  for (let index = 0; index < sorted.length; index += 1) {
    const entry = sorted[index];
    response.push(
      toPublicFilmOrder(
        entry,
        await buildPublicFilmOrderLinkedBoxes(client, orgId, entry.filmOrderId)
      )
    );
  }

  return response;
}

async function buildFilmCatalog(client, orgId) {
  const entries = await listFilmCatalog(client, orgId);
  const dedupedByKey = {};

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const normalized = normalizeSecurityManufacturerAndFilm(entry.manufacturer, entry.filmName);
    const manufacturer = normalized.manufacturer;
    const filmName = normalized.filmName;
    const manufacturerKey = normalizeCatalogManufacturerLookupKey(manufacturer);
    const filmNameKey = normalizeCatalogLookupKey(filmName);

    if (!manufacturerKey || !filmNameKey) {
      continue;
    }

    dedupedByKey[`${manufacturerKey}|${filmNameKey}`] = {
      filmKey: asTrimmedString(entry.filmKey).toUpperCase(),
      manufacturer,
      filmName,
      updatedAt: asTrimmedString(entry.updatedAt)
    };
  }

  const response = Object.values(dedupedByKey);
  response.sort((left, right) => {
    const manufacturerCompare = compareCatalogStrings(left.manufacturer, right.manufacturer);
    if (manufacturerCompare !== 0) {
      return manufacturerCompare;
    }

    const filmCompare = compareCatalogStrings(left.filmName, right.filmName);
    if (filmCompare !== 0) {
      return filmCompare;
    }

    return compareCatalogStrings(left.filmKey, right.filmKey);
  });

  return response;
}

async function listAccessRequests(client, orgId, status) {
  const rows = await queryRows(
    client,
    `
      select
        r.user_id,
        coalesce(nullif(r.requested_by_name, ''), nullif(u.raw_user_meta_data->>'full_name', ''), nullif(u.raw_user_meta_data->>'name', '')) as requested_by_name,
        coalesce(nullif(r.requested_by_email, ''), nullif(u.email, ''), '') as requested_by_email,
        r.status,
        r.requested_at,
        r.decided_at,
        r.decided_by_actor,
        r.decision_note,
        m.role as current_role
      from app.access_requests r
      left join app.organization_members m
        on m.org_id = r.org_id
       and m.user_id = r.user_id
      left join auth.users u
        on u.id = r.user_id
      where r.org_id = $1
        and ($2 = '' or lower(r.status) = lower($2))
      order by r.requested_at asc, r.user_id asc
    `,
    [orgId, asTrimmedString(status).toLowerCase()]
  );

  return rows.map((row) => ({
    userId: asTrimmedString(row.user_id),
    name:
      asTrimmedString(row.requested_by_name) ||
      deriveNameFromEmail(asTrimmedString(row.requested_by_email)) ||
      asTrimmedString(row.user_id),
    email: asTrimmedString(row.requested_by_email),
    status: asTrimmedString(row.status).toLowerCase(),
    requestedAt: formatTimestamp(row.requested_at),
    decidedAt: formatTimestamp(row.decided_at),
    decidedByActor: asTrimmedString(row.decided_by_actor),
    decisionNote: asTrimmedString(row.decision_note),
    currentRole: asTrimmedString(row.current_role).toLowerCase()
  }));
}

async function approveAccessRequestByUserId(client, orgId, actor, payload, actingUserId) {
  const userId = requireString(payload.userId, 'userId');
  const note = asTrimmedString(payload.note);
  const existing = await queryRow(
    client,
    `
      select role
      from app.organization_members m
      where org_id = $1
        and user_id = $2::uuid
      for update
    `,
    [orgId, userId]
  );

  let role = asTrimmedString(existing?.role).toLowerCase();
  if (!role) {
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
    role = 'member';
  }

  await client.query(
    `
      insert into app.access_requests (
        org_id,
        user_id,
        status,
        requested_at,
        requested_by_email,
        decided_at,
        decided_by_user_id,
        decided_by_actor,
        decision_note
      )
      values ($1::uuid, $2::uuid, 'approved', now(), '', now(), $3::uuid, $4, $5)
      on conflict (org_id, user_id) do update
      set
        status = 'approved',
        decided_at = excluded.decided_at,
        decided_by_user_id = excluded.decided_by_user_id,
        decided_by_actor = excluded.decided_by_actor,
        decision_note = excluded.decision_note
    `,
    [orgId, userId, actingUserId, asTrimmedString(actor), note]
  );

  if (role === 'owner') {
    await ensureOwnerNotificationPreference(client, orgId, userId, actor);
  } else if (role === 'admin') {
    await ensureAdminFeaturePermissions(client, orgId, userId, false, actor);
  }

  return {
    userId,
    status: 'approved',
    role
  };
}

async function denyAccessRequestByUserId(client, orgId, actor, payload, actingUserId) {
  const userId = requireString(payload.userId, 'userId');
  const note = asTrimmedString(payload.note);

  const existing = await queryRow(
    client,
    `
      select role
      from app.organization_members m
      where org_id = $1
        and user_id = $2::uuid
    `,
    [orgId, userId]
  );
  if (existing) {
    throw new HttpError(400, 'This user is already a workspace member and cannot be denied.');
  }

  await client.query(
    `
      insert into app.access_requests (
        org_id,
        user_id,
        status,
        requested_at,
        requested_by_email,
        decided_at,
        decided_by_user_id,
        decided_by_actor,
        decision_note
      )
      values ($1::uuid, $2::uuid, 'denied', now(), '', now(), $3::uuid, $4, $5)
      on conflict (org_id, user_id) do update
      set
        status = 'denied',
        decided_at = excluded.decided_at,
        decided_by_user_id = excluded.decided_by_user_id,
        decided_by_actor = excluded.decided_by_actor,
        decision_note = excluded.decision_note
    `,
    [orgId, userId, actingUserId, asTrimmedString(actor), note]
  );

  return {
    userId,
    status: 'denied'
  };
}

async function setUserDisplayName(client, userId, displayName) {
  const username = normalizeUsername(displayName);
  const result = await client.query(
    `
      update auth.users
      set
        raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || jsonb_build_object(
          'name', $2,
          'full_name', $2
        ),
        updated_at = now()
      where id = $1::uuid
    `,
    [userId, username]
  );

  if (!result.rowCount) {
    throw new HttpError(404, 'The user profile could not be found.');
  }
}

async function listUsernameChangeRequests(client, orgId, status) {
  const rows = await queryRows(
    client,
    `
      select
        r.user_id,
        coalesce(nullif(a.requested_by_email, ''), nullif(u.email, ''), '') as email,
        coalesce(
          nullif(a.requested_by_name, ''),
          nullif(u.raw_user_meta_data->>'full_name', ''),
          nullif(u.raw_user_meta_data->>'name', '')
        ) as current_name,
        r.requested_name,
        r.status,
        r.requested_at,
        r.decided_at,
        r.decided_by_actor,
        r.decision_note,
        m.role as current_role
      from app.username_change_requests r
      left join app.access_requests a
        on a.org_id = r.org_id
       and a.user_id = r.user_id
      left join app.organization_members m
        on m.org_id = r.org_id
       and m.user_id = r.user_id
      left join auth.users u
        on u.id = r.user_id
      where r.org_id = $1
        and ($2 = '' or lower(r.status) = lower($2))
      order by r.requested_at asc, r.user_id asc
    `,
    [orgId, asTrimmedString(status).toLowerCase()]
  );

  return rows.map((row) => {
    const email = asTrimmedString(row.email);
    return {
      userId: asTrimmedString(row.user_id),
      email,
      currentName: asTrimmedString(row.current_name) || deriveNameFromEmail(email) || asTrimmedString(row.user_id),
      requestedName: asTrimmedString(row.requested_name),
      status: asTrimmedString(row.status).toLowerCase(),
      requestedAt: formatTimestamp(row.requested_at),
      decidedAt: formatTimestamp(row.decided_at),
      decidedByActor: asTrimmedString(row.decided_by_actor),
      decisionNote: asTrimmedString(row.decision_note),
      currentRole: asTrimmedString(row.current_role).toLowerCase()
    };
  });
}

async function requestUsernameChange(client, orgId, authContext, payload) {
  const requestedName = normalizeUsername(payload.username);
  const actor = asTrimmedString(authContext.actor);
  const role = asTrimmedString(authContext.role).toLowerCase();
  const email = asTrimmedString(authContext.email);
  const userId = requireString(authContext.userId, 'userId');

  if (role === 'owner' || role === 'admin') {
    await setUserDisplayName(client, userId, requestedName);
    await client.query(
      `
        insert into app.access_requests (
          org_id,
          user_id,
          status,
          requested_at,
          requested_by_email,
          requested_by_name
        )
        values ($1::uuid, $2::uuid, 'pending', now(), $3, $4)
        on conflict (org_id, user_id) do update
        set
          requested_by_email = case
            when trim(app.access_requests.requested_by_email) = '' then excluded.requested_by_email
            else app.access_requests.requested_by_email
          end,
          requested_by_name = excluded.requested_by_name
      `,
      [orgId, userId, email, requestedName]
    );

    await client.query(
      `
        insert into app.username_change_requests (
          org_id,
          user_id,
          requested_name,
          status,
          requested_at,
          requested_by_actor,
          decided_at,
          decided_by_user_id,
          decided_by_actor,
          decision_note
        )
        values ($1::uuid, $2::uuid, $3, 'approved', now(), $4, now(), $2::uuid, $4, 'Auto-approved admin/owner self-update.')
        on conflict (org_id, user_id) do update
        set
          requested_name = excluded.requested_name,
          status = 'approved',
          requested_at = excluded.requested_at,
          requested_by_actor = excluded.requested_by_actor,
          decided_at = excluded.decided_at,
          decided_by_user_id = excluded.decided_by_user_id,
          decided_by_actor = excluded.decided_by_actor,
          decision_note = excluded.decision_note
      `,
      [orgId, userId, requestedName, actor]
    );

    return {
      status: 'approved',
      requiresApproval: false,
      username: requestedName
    };
  }

  await client.query(
    `
      insert into app.username_change_requests (
        org_id,
        user_id,
        requested_name,
        status,
        requested_at,
        requested_by_actor,
        decided_at,
        decided_by_user_id,
        decided_by_actor,
        decision_note
      )
      values ($1::uuid, $2::uuid, $3, 'pending', now(), $4, null, null, '', '')
      on conflict (org_id, user_id) do update
      set
        requested_name = excluded.requested_name,
        status = 'pending',
        requested_at = excluded.requested_at,
        requested_by_actor = excluded.requested_by_actor,
        decided_at = null,
        decided_by_user_id = null,
        decided_by_actor = '',
        decision_note = ''
    `,
    [orgId, userId, requestedName, actor]
  );

  if (email) {
    await client.query(
      `
        update app.access_requests
        set requested_by_email = $3
        where org_id = $1
          and user_id = $2::uuid
          and trim(requested_by_email) = ''
      `,
      [orgId, userId, email]
    );
  }

  return {
    status: 'pending',
    requiresApproval: true,
    username: requestedName
  };
}

async function approveUsernameChangeRequestByUserId(client, orgId, actor, payload, actingUserId) {
  const userId = requireString(payload.userId, 'userId');
  const note = asTrimmedString(payload.note);

  const requestRow = await queryRow(
    client,
    `
      select requested_name
      from app.username_change_requests
      where org_id = $1
        and user_id = $2::uuid
        and status = 'pending'
      for update
    `,
    [orgId, userId]
  );

  if (!requestRow) {
    throw new HttpError(404, 'No pending username change request was found for this user.');
  }

  const username = normalizeUsername(requestRow.requested_name);
  await setUserDisplayName(client, userId, username);

  const emailRow = await queryRow(
    client,
    `
      select coalesce(nullif(r.requested_by_email, ''), nullif(u.email, ''), '') as email
      from auth.users u
      left join app.access_requests r
        on r.org_id = $1
       and r.user_id = u.id
      where u.id = $2::uuid
    `,
    [orgId, userId]
  );
  const email = asTrimmedString(emailRow?.email);

  await client.query(
    `
      insert into app.access_requests (
        org_id,
        user_id,
        status,
        requested_at,
        requested_by_email,
        requested_by_name
      )
      values ($1::uuid, $2::uuid, 'pending', now(), $3, $4)
      on conflict (org_id, user_id) do update
      set
        requested_by_email = case
          when trim(app.access_requests.requested_by_email) = '' then excluded.requested_by_email
          else app.access_requests.requested_by_email
        end,
        requested_by_name = excluded.requested_by_name
    `,
    [orgId, userId, email, username]
  );

  await client.query(
    `
      update app.username_change_requests
      set
        status = 'approved',
        decided_at = now(),
        decided_by_user_id = $3::uuid,
        decided_by_actor = $4,
        decision_note = $5
      where org_id = $1
        and user_id = $2::uuid
    `,
    [orgId, userId, actingUserId, asTrimmedString(actor), note]
  );

  return {
    userId,
    status: 'approved',
    username
  };
}

async function denyUsernameChangeRequestByUserId(client, orgId, actor, payload, actingUserId) {
  const userId = requireString(payload.userId, 'userId');
  const note = asTrimmedString(payload.note);
  const result = await client.query(
    `
      update app.username_change_requests
      set
        status = 'denied',
        decided_at = now(),
        decided_by_user_id = $3::uuid,
        decided_by_actor = $4,
        decision_note = $5
      where org_id = $1
        and user_id = $2::uuid
        and status = 'pending'
    `,
    [orgId, userId, actingUserId, asTrimmedString(actor), note]
  );

  if (!result.rowCount) {
    throw new HttpError(404, 'No pending username change request was found for this user.');
  }

  return {
    userId,
    status: 'denied'
  };
}

async function updateMemberFeaturePermissionsInternal(client, orgId, actor, payload) {
  await ensureGeneralFeaturePermissions(client, orgId, actor);
  const permissions = payload?.permissions && typeof payload.permissions === 'object' ? payload.permissions : {};

  for (const feature of MEMBER_FEATURE_AREAS) {
    const entry = permissions[feature];
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const readValue = String(entry.read).toLowerCase();
    const writeValue = String(entry.write).toLowerCase();
    await client.query(
      `
        update app.general_feature_permissions
        set
          read_enabled = case when $3 in ('true', 'false') then $3::boolean else read_enabled end,
          write_enabled = case when $4 in ('true', 'false') then $4::boolean else write_enabled end,
          updated_at = now(),
          updated_by = $5
        where org_id = $1
          and feature_area = $2
      `,
      [orgId, feature, readValue, writeValue, asTrimmedString(actor)]
    );
  }

  return getGeneralFeaturePermissions(client, orgId);
}

async function getUserFeaturePermissionsInternal(client, orgId, payload) {
  const userId = requireString(payload.userId, 'userId');
  const target = await queryRow(
    client,
    `
      select role
      from app.organization_members
      where org_id = $1
        and user_id = $2::uuid
    `,
    [orgId, userId]
  );
  if (!target) {
    throw new HttpError(404, 'Target user is not an organization member.');
  }

  const role = asTrimmedString(target.role).toLowerCase();
  if (role === 'owner') {
    return buildOwnerFeaturePermissions();
  }
  if (role === 'admin') {
    return getAdminFeaturePermissions(client, orgId, userId);
  }

  return getMemberEffectiveFeaturePermissionsForUser(client, orgId, userId);
}

async function updateUserFeaturePermissionsInternal(client, orgId, actor, payload) {
  const userId = requireString(payload.userId, 'userId');
  const target = await queryRow(
    client,
    `
      select role
      from app.organization_members
      where org_id = $1
        and user_id = $2::uuid
      for update
    `,
    [orgId, userId]
  );
  if (!target) {
    throw new HttpError(404, 'Target user is not an organization member.');
  }

  const role = asTrimmedString(target.role).toLowerCase();
  if (role !== 'member') {
    throw new HttpError(400, 'Only member accounts can be changed from this page.');
  }

  await ensureGeneralFeaturePermissions(client, orgId, actor);
  const permissions = payload?.permissions && typeof payload.permissions === 'object' ? payload.permissions : {};

  for (const feature of MEMBER_FEATURE_AREAS) {
    const entry = permissions[feature];
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    await client.query(
      `
        insert into app.admin_feature_permissions (
          org_id,
          admin_user_id,
          feature_area,
          read_enabled,
          write_enabled,
          updated_at,
          updated_by
        )
        values (
          $1,
          $2::uuid,
          $3,
          coalesce((select g.read_enabled from app.general_feature_permissions g where g.org_id = $1 and g.feature_area = $3), true),
          coalesce((select g.write_enabled from app.general_feature_permissions g where g.org_id = $1 and g.feature_area = $3), true),
          now(),
          $4
        )
        on conflict (org_id, admin_user_id, feature_area) do nothing
      `,
      [orgId, userId, feature, asTrimmedString(actor)]
    );

    const readValue = String(entry.read).toLowerCase();
    const writeValue = String(entry.write).toLowerCase();
    await client.query(
      `
        update app.admin_feature_permissions
        set
          read_enabled = case when $4 in ('true', 'false') then $4::boolean else read_enabled end,
          write_enabled = case when $5 in ('true', 'false') then $5::boolean else write_enabled end,
          updated_at = now(),
          updated_by = $6
        where org_id = $1
          and admin_user_id = $2::uuid
          and feature_area = $3
      `,
      [orgId, userId, feature, readValue, writeValue, asTrimmedString(actor)]
    );
  }

  await client.query(
    `
      delete from app.admin_feature_permissions
      where org_id = $1
        and admin_user_id = $2::uuid
        and feature_area = 'access_management'
    `,
    [orgId, userId]
  );

  return getMemberEffectiveFeaturePermissionsForUser(client, orgId, userId);
}

async function listAdminFeaturePermissions(client, orgId) {
  const admins = await queryRows(
    client,
    `
      select
        m.user_id,
        m.role,
        coalesce(nullif(r.requested_by_name, ''), nullif(u.raw_user_meta_data->>'full_name', ''), nullif(u.raw_user_meta_data->>'name', '')) as requested_by_name,
        coalesce(nullif(r.requested_by_email, ''), nullif(u.email, ''), '') as requested_by_email
      from app.organization_members m
      left join lateral (
        select a.requested_by_name, a.requested_by_email
        from app.access_requests a
        where a.org_id = m.org_id
          and a.user_id = m.user_id
        order by a.requested_at desc
        limit 1
      ) r on true
      left join auth.users u
        on u.id = m.user_id
      where m.org_id = $1
        and m.role = 'admin'
      order by m.created_at asc, m.user_id asc
    `,
    [orgId]
  );

  const entries = [];
  for (const admin of admins) {
    const email = asTrimmedString(admin.requested_by_email);
    const name = asTrimmedString(admin.requested_by_name) || deriveNameFromEmail(email) || asTrimmedString(admin.user_id);
    entries.push({
      userId: asTrimmedString(admin.user_id),
      name,
      email,
      role: 'admin',
      permissions: await getAdminFeaturePermissions(client, orgId, asTrimmedString(admin.user_id))
    });
  }

  return entries;
}

async function updateAdminFeaturePermissionsInternal(client, orgId, actor, payload) {
  const userId = requireString(payload.userId, 'userId');
  const target = await queryRow(
    client,
    `
      select role
      from app.organization_members
      where org_id = $1
        and user_id = $2::uuid
      for update
    `,
    [orgId, userId]
  );
  if (!target || asTrimmedString(target.role).toLowerCase() !== 'admin') {
    throw new HttpError(400, 'Target user must be an admin.');
  }

  await ensureAdminFeaturePermissions(client, orgId, userId, true, actor);
  const permissions = payload?.permissions && typeof payload.permissions === 'object' ? payload.permissions : {};
  for (const feature of ADMIN_FEATURE_AREAS) {
    const entry = permissions[feature];
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const readValue = String(entry.read).toLowerCase();
    const writeValue = String(entry.write).toLowerCase();
    await client.query(
      `
        update app.admin_feature_permissions
        set
          read_enabled = case when $4 in ('true', 'false') then $4::boolean else read_enabled end,
          write_enabled = case when $5 in ('true', 'false') then $5::boolean else write_enabled end,
          updated_at = now(),
          updated_by = $6
        where org_id = $1
          and admin_user_id = $2::uuid
          and feature_area = $3
      `,
      [orgId, userId, feature, readValue, writeValue, asTrimmedString(actor)]
    );
  }

  return getAdminFeaturePermissions(client, orgId, userId);
}

async function promoteMemberToAdminInternal(client, orgId, actor, payload, actingUserId) {
  const userId = requireString(payload.userId, 'userId');
  const target = await queryRow(
    client,
    `
      select role
      from app.organization_members
      where org_id = $1
        and user_id = $2::uuid
      for update
    `,
    [orgId, userId]
  );
  if (!target) {
    throw new HttpError(404, 'Target user is not an organization member.');
  }
  if (asTrimmedString(target.role).toLowerCase() !== 'member') {
    throw new HttpError(400, 'Only member accounts can be promoted to admin.');
  }

  await client.query(
    `
      update app.organization_members
      set role = 'admin'
      where org_id = $1
        and user_id = $2::uuid
    `,
    [orgId, userId]
  );

  await ensureAdminFeaturePermissions(client, orgId, userId, true, actor);
  await client.query(
    `
      insert into app.access_requests (
        org_id,
        user_id,
        status,
        requested_at,
        requested_by_email,
        decided_at,
        decided_by_user_id,
        decided_by_actor,
        decision_note
      )
      values ($1::uuid, $2::uuid, 'approved', now(), '', now(), $3::uuid, $4, 'Promoted member to admin.')
      on conflict (org_id, user_id) do update
      set
        status = 'approved',
        decided_at = excluded.decided_at,
        decided_by_user_id = excluded.decided_by_user_id,
        decided_by_actor = excluded.decided_by_actor,
        decision_note = excluded.decision_note
    `,
    [orgId, userId, actingUserId, asTrimmedString(actor)]
  );

  return {
    userId,
    role: 'admin'
  };
}

async function demoteAdminToMemberInternal(client, orgId, payload) {
  const userId = requireString(payload.userId, 'userId');
  const target = await queryRow(
    client,
    `
      select role
      from app.organization_members
      where org_id = $1
        and user_id = $2::uuid
      for update
    `,
    [orgId, userId]
  );
  if (!target || asTrimmedString(target.role).toLowerCase() !== 'admin') {
    throw new HttpError(400, 'Target user must be an admin.');
  }

  await client.query(
    `
      update app.organization_members
      set role = 'member'
      where org_id = $1
        and user_id = $2::uuid
    `,
    [orgId, userId]
  );
  await client.query(
    `
      delete from app.admin_feature_permissions
      where org_id = $1
        and admin_user_id = $2::uuid
    `,
    [orgId, userId]
  );

  return {
    userId,
    role: 'member'
  };
}

async function promoteAdminToOwnerInternal(client, orgId, actor, payload) {
  const userId = requireString(payload.userId, 'userId');
  const target = await queryRow(
    client,
    `
      select role
      from app.organization_members
      where org_id = $1
        and user_id = $2::uuid
      for update
    `,
    [orgId, userId]
  );
  if (!target || asTrimmedString(target.role).toLowerCase() !== 'admin') {
    throw new HttpError(400, 'Target user must be an admin.');
  }

  await client.query(
    `
      update app.organization_members
      set role = 'owner'
      where org_id = $1
        and user_id = $2::uuid
    `,
    [orgId, userId]
  );
  await ensureOwnerNotificationPreference(client, orgId, userId, actor);

  return {
    userId,
    role: 'owner'
  };
}

async function getOwnerNotificationPreferencesInternal(client, orgId, ownerUserId) {
  await ensureOwnerNotificationPreference(client, orgId, ownerUserId, 'owner-preference-read');
  const row = await queryRow(
    client,
    `
      select in_app_opt_in, email_opt_in
      from app.owner_notification_preferences
      where org_id = $1
        and owner_user_id = $2::uuid
    `,
    [orgId, ownerUserId]
  );

  return {
    inAppOptIn: row ? Boolean(row.in_app_opt_in) : true,
    emailOptIn: row ? Boolean(row.email_opt_in) : true
  };
}

async function updateOwnerNotificationPreferencesInternal(client, orgId, ownerUserId, actor, payload) {
  await ensureOwnerNotificationPreference(client, orgId, ownerUserId, actor);

  const inAppValue = String(payload.inAppOptIn).toLowerCase();
  const emailValue = String(payload.emailOptIn).toLowerCase();
  await client.query(
    `
      update app.owner_notification_preferences
      set
        in_app_opt_in = case when $3 in ('true', 'false') then $3::boolean else in_app_opt_in end,
        email_opt_in = case when $4 in ('true', 'false') then $4::boolean else email_opt_in end,
        updated_at = now(),
        updated_by = $5
      where org_id = $1
        and owner_user_id = $2::uuid
    `,
    [orgId, ownerUserId, inAppValue, emailValue, asTrimmedString(actor)]
  );

  return getOwnerNotificationPreferencesInternal(client, orgId, ownerUserId);
}

async function runAutomaticAllocationReconciliationForRead(logicalPath, params, authContext) {
  if (
    logicalPath !== '/boxes/get' &&
    logicalPath !== '/allocations/by-box' &&
    logicalPath !== '/jobs/get' &&
    logicalPath !== '/allocations/by-job'
  ) {
    return;
  }

  await withMutation(async (client) => {
    if (logicalPath === '/boxes/get' || logicalPath === '/allocations/by-box') {
      const boxId = requireString(params.boxId, 'boxId');
      await reconcileCheckedOutBoxAllocationLinkByBoxId(
        client,
        authContext.orgId,
        boxId,
        authContext.actor
      );
      await reconcileZeroedBoxAllocationStateByBoxId(client, authContext.orgId, boxId, authContext.actor);
      return;
    }

    const jobNumber = requireString(params.jobNumber, 'jobNumber');
    await reconcileCheckedOutBoxAllocationLinksForJob(
      client,
      authContext.orgId,
      jobNumber,
      authContext.actor
    );
    await reconcileZeroedBoxAllocationStateForJob(client, authContext.orgId, jobNumber, authContext.actor);
  });
}

export async function handleSupabaseRequest({ method, logicalPath, requestUrl, bodyJson, headers }) {
  try {
    ensureConfigured();

    if (logicalPath === '/health') {
      return {
        statusCode: 200,
        payload: ok({
          status: 'ok',
          timestamp: new Date().toISOString(),
          sheets: [],
          mode: 'supabase'
        })
      };
    }

    const params = routeParams(method, requestUrl, bodyJson);
    const authContext = await resolveAuthContext(headers);

    if (logicalPath === '/auth/context') {
      return {
        statusCode: 200,
        payload: ok({
          orgId: authContext.orgId,
          accessStatus: authContext.accessStatus,
          role: authContext.role || '',
          permissions: authContext.permissions || createDeniedFeaturePermissions(),
          isAdminConsoleAllowed: Boolean(authContext.isAdminConsoleAllowed),
          pendingCount: integerOrZero(authContext.pendingCount),
          receivesInAppNotifications: Boolean(authContext.receivesInAppNotifications)
        })
      };
    }

    ensureEffectiveRouteAccess(authContext, method, logicalPath);

    if (method === 'GET' || (method === 'POST' && READ_PATHS.has(logicalPath))) {
      await runAutomaticAllocationReconciliationForRead(logicalPath, params, authContext);

      const payload = await withReadClient(async (client) => {
        switch (logicalPath) {
          case '/admin/access/requests':
            return ok({ entries: await listAccessRequests(client, authContext.orgId, params.status) });
          case '/admin/username-requests':
            return ok({ entries: await listUsernameChangeRequests(client, authContext.orgId, params.status) });
          case '/admin/member-permissions':
            return ok(await getGeneralFeaturePermissions(client, authContext.orgId));
          case '/admin/user-permissions':
            return ok({ permissions: await getUserFeaturePermissionsInternal(client, authContext.orgId, params) });
          case '/owner/admin-permissions':
            return ok({ entries: await listAdminFeaturePermissions(client, authContext.orgId) });
          case '/owner/notification-preferences':
            return ok(
              await getOwnerNotificationPreferencesInternal(
                client,
                authContext.orgId,
                authContext.userId
              )
            );
          case '/boxes/search':
            return ok(await buildSearchBoxes(client, authContext.orgId, params));
          case '/boxes/get': {
            const found = await findBoxById(client, authContext.orgId, params.boxId);
            if (!found) {
              throw new HttpError(404, 'Box not found.');
            }
            return ok(toPublicBox(found));
          }
          case '/audit/list':
            return ok({ entries: await listAudit(client, authContext.orgId, params) });
          case '/audit/by-box':
            return ok({
              entries: await listAuditEntriesByBox(client, authContext.orgId, requireString(params.boxId, 'boxId'))
            });
          case '/allocations/by-box':
            return ok({
              entries: (await listAllocationsByBox(client, authContext.orgId, requireString(params.boxId, 'boxId'))).map(
                toPublicAllocation
              )
            });
          case '/allocations/jobs':
            return ok({ entries: await buildAllocationJobList(client, authContext.orgId) });
          case '/allocations/by-job':
            return ok(await buildAllocationJobDetail(client, authContext.orgId, params.jobNumber));
          case '/allocations/preview':
            return ok(await previewAllocationPlan(client, authContext.orgId, params));
          case '/jobs/list': {
            const limitValue = Number(params && params.limit);
            const limit = Number.isFinite(limitValue) && limitValue > 0 ? Math.floor(limitValue) : 25;
            return ok({ entries: await buildJobsList(client, authContext.orgId, limit) });
          }
          case '/jobs/search': {
            const limitValue = Number(params && params.limit);
            const limit = Number.isFinite(limitValue) && limitValue > 0 ? Math.floor(limitValue) : 25;
            return ok({
              entries: await buildJobsSearchResults(client, authContext.orgId, params && params.query, limit)
            });
          }
          case '/jobs/get':
            return ok(await buildJobDetail(client, authContext.orgId, params.jobNumber));
          case '/film-orders/list':
            return ok({ entries: await buildFilmOrdersList(client, authContext.orgId) });
          case '/film-data/catalog':
            return ok({ entries: await buildFilmCatalog(client, authContext.orgId) });
          case '/roll-history/by-box':
            return ok({
              entries: await listRollHistoryByBox(client, authContext.orgId, requireString(params.boxId, 'boxId'))
            });
          case '/reports/summary':
            return ok(await buildReportsSummary(client, authContext.orgId, params));
          case '/caulk/manufacturers/list':
            return ok({ entries: await listCaulkManufacturers(client, authContext.orgId) });
          case '/caulk/products/list':
            return ok({ entries: await listCaulkProducts(client, authContext.orgId) });
          case '/caulk/stock/list':
            return ok({ entries: await listCaulkStock(client, authContext.orgId, params) });
          case '/caulk/transactions/list':
            return ok({ entries: await listCaulkTransactions(client, authContext.orgId, params) });
          default:
            throw new HttpError(404, `Route not found: ${logicalPath || '/'}`);
        }
      });

      return {
        statusCode: 200,
        payload
      };
    }

    const payload = await withMutation(async (client) => {
      switch (logicalPath) {
        case '/profile/username':
          return ok(await requestUsernameChange(client, authContext.orgId, authContext, params));
        case '/admin/access/requests/approve':
          return ok(
            await approveAccessRequestByUserId(
              client,
              authContext.orgId,
              authContext.actor,
              params,
              authContext.userId
            )
          );
        case '/admin/access/requests/deny':
          return ok(
            await denyAccessRequestByUserId(
              client,
              authContext.orgId,
              authContext.actor,
              params,
              authContext.userId
            )
          );
        case '/admin/username-requests/approve':
          return ok(
            await approveUsernameChangeRequestByUserId(
              client,
              authContext.orgId,
              authContext.actor,
              params,
              authContext.userId
            )
          );
        case '/admin/username-requests/deny':
          return ok(
            await denyUsernameChangeRequestByUserId(
              client,
              authContext.orgId,
              authContext.actor,
              params,
              authContext.userId
            )
          );
        case '/admin/member-permissions':
          return ok({
            permissions: await updateMemberFeaturePermissionsInternal(
              client,
              authContext.orgId,
              authContext.actor,
              params
            )
          });
        case '/admin/user-permissions':
          return ok({
            permissions: await updateUserFeaturePermissionsInternal(
              client,
              authContext.orgId,
              authContext.actor,
              params
            )
          });
        case '/owner/admin-permissions':
          return ok({
            permissions: await updateAdminFeaturePermissionsInternal(
              client,
              authContext.orgId,
              authContext.actor,
              params
            )
          });
        case '/admin/roles/promote-member-to-admin':
          return ok(
            await promoteMemberToAdminInternal(
              client,
              authContext.orgId,
              authContext.actor,
              params,
              authContext.userId
            )
          );
        case '/owner/roles/demote-admin-to-member':
          return ok(await demoteAdminToMemberInternal(client, authContext.orgId, params));
        case '/owner/roles/promote-admin-to-owner':
          return ok(
            await promoteAdminToOwnerInternal(
              client,
              authContext.orgId,
              authContext.actor,
              params
            )
          );
        case '/owner/notification-preferences':
          return ok(
            await updateOwnerNotificationPreferencesInternal(
              client,
              authContext.orgId,
              authContext.userId,
              authContext.actor,
              params
            )
          );
        case '/owner/caulk/manufacturers/upsert':
          return ok(await ownerUpsertCaulkManufacturer(client, authContext.orgId, authContext.actor, params));
        case '/caulk/products/upsert':
          return ok(await upsertCaulkProduct(client, authContext.orgId, authContext.actor, params));
        case '/caulk/mutate':
          return ok(await mutateCaulkStock(client, authContext.orgId, authContext.actor, params));
        case '/caulk/transfer':
          return ok(await transferCaulkStock(client, authContext.orgId, authContext.actor, params));
        case '/boxes/add':
          return addBox(client, authContext.orgId, params, authContext.actor);
        case '/allocations/add':
        case '/allocations/apply':
          return applyAllocationPlan(client, authContext.orgId, params, authContext.actor);
        case '/allocations/remove-box':
          return removeJobBoxAllocation(client, authContext.orgId, params, authContext.actor);
        case '/jobs/create':
          return createJob(client, authContext.orgId, params, authContext.actor);
        case '/jobs/update':
          return updateJob(client, authContext.orgId, params, authContext.actor);
        case '/jobs/complete':
          return completeJob(client, authContext.orgId, params, authContext.actor);
        case '/jobs/reopen':
          return reopenJob(client, authContext.orgId, params, authContext.actor);
        case '/film-orders/create':
          return createFilmOrder(client, authContext.orgId, params, authContext.actor);
        case '/film-orders/cancel':
          return cancelJob(client, authContext.orgId, params, authContext.actor);
        case '/film-orders/delete':
          return deleteFilmOrder(client, authContext.orgId, params, authContext.actor);
        case '/boxes/update':
          return updateBox(client, authContext.orgId, params, authContext.actor);
        case '/boxes/delete':
          return deleteBox(client, authContext.orgId, params, authContext.actor);
        case '/boxes/set-status':
          return setBoxStatus(client, authContext.orgId, params, authContext.actor);
        case '/audit/undo':
          return undoAudit(client, authContext.orgId, params, authContext.actor);
        default:
          throw new HttpError(404, `Route not found: ${logicalPath || '/'}`);
      }
    });

    return {
      statusCode: 200,
      payload
    };
  } catch (error) {
    if (error instanceof HttpError) {
      return {
        statusCode: error.statusCode,
        payload: {
          ok: false,
          error: error.message,
          warnings: error.warnings || []
        }
      };
    }

    return {
      statusCode: 500,
      payload: {
        ok: false,
        error: mapDatabaseBootstrapError(error instanceof Error ? error.message : ''),
        warnings: []
      }
    };
  }
}


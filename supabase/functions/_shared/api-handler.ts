import { createClient } from "npm:@supabase/supabase-js@2";
import {
  API_BUILD_SHA,
  API_BUILT_AT,
  CACHE_TTL_MS,
  CORS_ALLOWED_ORIGINS,
  FILM_NAME_ALIAS_CACHE_TTL_MS,
  MAX_CACHE_ENTRIES,
  RESEND_API_KEY,
  RESEND_FROM_EMAIL,
  SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_URL
} from "./config.ts";
import { HttpError, ok } from "./http.ts";
import { ensureEffectiveRouteAccess } from "./acl.ts";
import { resolveAuthContext as resolveAuthContextFromModule } from "./auth.ts";
import { createInventoryRepositories } from "./repositories/inventoryRepositories.ts";
import { routeParams as routeParamsFromModule } from "./routes/params.ts";
import { dispatchReadWithHandlers } from "./routes/readHandlers.ts";
import { dispatchMutationWithHandlers } from "./routes/mutationHandlers.ts";
import { listRollHistoryByJob as listRollHistoryByJobFromService } from "./services/rollHistory.ts";
import type { AuthIdentity } from "./types.ts";
import {
  computeCoveredFeetForAllocation,
  isSplitCoveragePair,
  planCoverageAllocation,
} from "../../../frontend/src/domain/allocationCoverageContract.mjs";
import {
  matchesBoxSearchQuery,
  rankBoxSearchCandidates,
} from "../../../frontend/src/domain/boxSearchMatcher.mjs";
import {
  canJobPlanningFilmSatisfyRequirement as canSharedJobPlanningFilmSatisfyRequirement,
  compareJobPlanningFilmMatches as compareSharedJobPlanningFilmMatches,
  describeJobPlanningFilm as describeSharedJobPlanningFilm,
  getJobPlanningFilmMatch as getSharedJobPlanningFilmMatch,
} from "../../../frontend/src/domain/jobPlanningFilmMatcher.mjs";
import { rankJobNumberSearchCandidates } from "../../../frontend/src/domain/jobNumberSearchMatcher.mjs";

type CacheEntry = {
  expiresAt: number;
  status: number;
  contentType: string;
  body: string;
};

const cache = new Map<string, CacheEntry>();
const authIdentityCache = new Map<string, { expiresAt: number; identity: AuthIdentity }>();
const authUserProfileCache = new Map<string, { expiresAt: number; profile: { email: string; name: string } }>();
const filmNameAliasCache = new Map<string, {
  expiresAt: number;
  aliases: Record<string, string>;
}>();

function asTrimmedString(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value).trim();
}

function requireString(value: unknown, fieldName: string): string {
  const trimmed = asTrimmedString(value);
  if (!trimmed) {
    throw new HttpError(400, `${fieldName} is required.`);
  }
  return trimmed;
}

function normalizeDateString(value: unknown, fieldName: string, allowBlank: boolean): string {
  const trimmed = asTrimmedString(value);
  if (!trimmed) {
    if (allowBlank) {
      return "";
    }
    throw new HttpError(400, `${fieldName} is required.`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new HttpError(400, `${fieldName} must use yyyy-mm-dd.`);
  }
  return trimmed;
}

function coerceFeetValue(
  value: unknown,
  fieldName: string,
  warnings: string[],
  allowNegativeClamp: boolean,
): number {
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

function formatTimestamp(value: unknown): string {
  if (!value) {
    return "";
  }
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function formatDateValue(value: unknown): string {
  if (!value) {
    return "";
  }
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }
  const iso = value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
  return iso.slice(0, 10);
}

function numericOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function integerOrZero(value: unknown): number {
  if (value === null || value === undefined || value === "") {
    return 0;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function normalizeCaulkCaseMath(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== "object") {
    return {};
  }

  const source = result as Record<string, unknown>;
  const tubesOnHand = Math.max(0, integerOrZero(source.tubesOnHand ?? source.tubes_on_hand));
  const casesOnHand = Math.floor(tubesOnHand / 16);
  const looseTubes = Math.max(0, tubesOnHand - (casesOnHand * 16));

  return {
    ...source,
    tubesOnHand,
    casesOnHand,
    looseTubes,
  };
}

function integerOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function roundToDecimals(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function createLogId(): string {
  const now = new Date();
  const timestamp = [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    String(now.getUTCDate()).padStart(2, "0"),
    String(now.getUTCHours()).padStart(2, "0"),
    String(now.getUTCMinutes()).padStart(2, "0"),
    String(now.getUTCSeconds()).padStart(2, "0"),
    String(now.getUTCMilliseconds()).padStart(3, "0"),
  ].join("");
  const bytes = crypto.getRandomValues(new Uint8Array(2));
  const suffix = String(((bytes[0] << 8) | bytes[1]) % 1000).padStart(3, "0");
  return `${timestamp}-${suffix}`;
}

function normalizeCollapsedCatalogLabel(value: unknown): string {
  return asTrimmedString(value).replace(/\s+/g, " ");
}

function normalizeCatalogLookupKey(value: unknown): string {
  return normalizeCollapsedCatalogLabel(value).toLowerCase();
}

function canonicalizeManufacturerLabel(value: unknown): string {
  const normalized = normalizeCollapsedCatalogLabel(value);
  const key = normalized.toLowerCase();

  if (key === "3m" || key === "3m solar") return "3M Solar";
  if (key === "fasara" || key === "3m fasara") return "3M Fasara";
  if (key === "avery" || key === "avery dennison") return "Avery Dennison";
  if (key === "llumar vista" || key === "llumarvista" || key === "llumar") return "Llumar";
  if (key === "solar guard" || key === "solargard" || key === "solar gard" || key === "sg") return "Solar Gard";
  if (key === "solyx" || key === "sol") return "SOLYX";
  if (key === "madico") return "Madico";
  if (key === "v-kool" || key === "vkool" || key === "aswfvkool") return "ASWFVKOOL";
  if (key === "di-noc" || key === "dinoc") return "Di-Noc";
  if (key === "vinyl") return "Vinyl";

  return normalized;
}

const SECURITY_MANUFACTURER_LABEL = "Security";
const SOLAR_MANUFACTURER_LABEL = "3M Solar";
const PREFIX_POLICY_TARGET_MANUFACTURERS = new Set([
  "3M Solar",
  "3M Fasara",
  "Madico",
  "Avery Dennison",
  "Llumar",
  "Solar Gard",
  "SOLYX",
]);
const PREFIX_POLICY_EXEMPT_MANUFACTURERS = new Set([SECURITY_MANUFACTURER_LABEL, "Vinyl"]);

function manufacturerPrefixPatterns(manufacturer: string): RegExp[] {
  if (manufacturer === "3M Solar") return [/^3m\s+/i];
  if (manufacturer === "3M Fasara") return [/^3m\s+fasara\s+/i, /^fasara\s+/i, /^3m\s+/i];
  if (manufacturer === "Solar Gard") return [/^sg\s+/i, /^solar\s*guard\s+/i, /^solar\s+gard\s+/i, /^solarguard\s+/i, /^solargard\s+/i];
  if (manufacturer === "Llumar") return [/^llumar\s+vista\s+/i, /^llumarvista\s+/i, /^llumar\s+/i];
  if (manufacturer === "Avery Dennison") return [/^avery\s+dennison\s+/i, /^avery\s+/i, /^ad\s+/i];
  if (manufacturer === "SOLYX") return [/^solyx\s+/i, /^sol\s+/i];
  if (manufacturer === "Madico") return [/^madico\s+/i];
  return [];
}

function stripManufacturerPrefixes(manufacturer: string, filmName: unknown): string {
  let value = normalizeCollapsedCatalogLabel(filmName);
  const patterns = manufacturerPrefixPatterns(manufacturer);
  if (!value || !patterns.length) {
    return value;
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const pattern of patterns) {
      const next = normalizeCollapsedCatalogLabel(value.replace(pattern, ""));
      if (next && next !== value) {
        value = next;
        changed = true;
      }
    }
  }

  return value;
}

function normalizeManufacturerPrefixPolicyFilmName(manufacturer: unknown, filmName: unknown): string {
  const canonicalManufacturer = canonicalizeManufacturerLabel(manufacturer);
  const normalizedFilmName = normalizeCollapsedCatalogLabel(filmName);
  if (!normalizedFilmName) return normalizedFilmName;
  if (PREFIX_POLICY_EXEMPT_MANUFACTURERS.has(canonicalManufacturer)) return normalizedFilmName;
  if (!PREFIX_POLICY_TARGET_MANUFACTURERS.has(canonicalManufacturer)) return normalizedFilmName;

  const stripped = stripManufacturerPrefixes(canonicalManufacturer, normalizedFilmName);
  if (!stripped) return normalizedFilmName;
  if (normalizeCatalogLookupKey(stripped) === normalizeCatalogLookupKey(normalizedFilmName)) {
    return normalizedFilmName;
  }
  return stripped;
}

function isAveryDennisonManufacturer(value: unknown): boolean {
  return (
    normalizeCatalogManufacturerLookupKey(canonicalizeManufacturerLabel(value))
    === normalizeCatalogManufacturerLookupKey("Avery Dennison")
  );
}

function normalizeAveryNaturaShadeFilmName(manufacturer: unknown, filmName: unknown): string {
  const canonicalManufacturer = canonicalizeManufacturerLabel(manufacturer);
  const normalizedFilmName = normalizeCollapsedCatalogLabel(filmName);
  if (!normalizedFilmName) return normalizedFilmName;
  if (!isAveryDennisonManufacturer(canonicalManufacturer)) return normalizedFilmName;

  const shadeMatch = normalizedFilmName.match(/^natura\s*0*([0-9]{1,3})(.*)$/i);
  if (!shadeMatch) return normalizedFilmName;

  const shadeDigits = canonicalizeNumericDigits(shadeMatch[1]);
  const suffix = normalizeCollapsedCatalogLabel(shadeMatch[2] || "");
  if (!suffix) {
    return `Natura ${shadeDigits}`;
  }
  return `Natura ${shadeDigits}${suffix.startsWith("-") ? "" : " "}${suffix}`;
}

function assertAveryNaturaShadeForWrite(manufacturer: unknown, filmName: unknown, fieldName: string): void {
  const canonicalManufacturer = canonicalizeManufacturerLabel(manufacturer);
  if (!isAveryDennisonManufacturer(canonicalManufacturer)) return;

  const normalizedFilmName = normalizeCollapsedCatalogLabel(filmName);
  if (!/^natura\b/i.test(normalizedFilmName)) return;
  if (/^natura\s*0*[0-9]+/i.test(normalizedFilmName)) return;

  throw new HttpError(
    400,
    `${fieldName || "FilmName"} must include an Avery Natura shade number (for example, "Natura 5" or "Natura 30").`,
  );
}

function normalizeMilTokenSpacing(value: unknown): string {
  return normalizeCollapsedCatalogLabel(value).replace(/\b(\d+)\s*mil\b/gi, (_match, digits) => `${digits} MIL`);
}

function stripLeadingSecurityToken(value: unknown): string {
  return normalizeCollapsedCatalogLabel(value).replace(/^security\b[:\-\s]*/i, "").trim();
}

function isBareMilLabel(value: unknown): boolean {
  return /^\d+\s*mil$/i.test(normalizeCollapsedCatalogLabel(value));
}

function inferPrestigeCode(value: unknown): string {
  const normalized = normalizeCollapsedCatalogLabel(value);
  const directMatch = normalized.match(/\b(?:ultra\s+)?prestige\s+(\d{2,3})\b/i);
  if (directMatch) {
    return directMatch[1];
  }

  const prMatch = normalized.match(/\bpr\s*[-]?\s*(\d{2,3})\b/i);
  if (prMatch && /\b(ultra|prestige)\b/i.test(normalized)) {
    return prMatch[1];
  }

  return "";
}

function normalizeSecurityMakerPrefix(value: unknown): string {
  const normalized = normalizeCollapsedCatalogLabel(value);
  const key = normalized.toLowerCase();
  if (!normalized) return "";
  if (key === "3m" || key === "3m solar" || key === "3m fasara") return "3M";
  if (key === "solar guard" || key === "solargard" || key === "solar gard") return "Solar Gard";
  if (key === "avery" || key === "avery dennison") return "Avery Dennison";
  if (key === "llumar vista" || key === "llumarvista" || key === "llumar") return "Llumar";
  if (key === "solyx") return "SOLYX";
  if (key === "aswfvkool") return "ASWFVKOOL";
  if (key === "madico") return "Madico";
  if (key === "sol") return "SOL";
  return normalized;
}

function startsWithMakerPrefix(value: unknown, makerPrefix: string): boolean {
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
  if (normalizedPrefix === "3m" && normalizedValue.startsWith("3m solar ")) {
    return true;
  }
  if (normalizedPrefix === "solar gard" && normalizedValue.startsWith("solargard ")) {
    return true;
  }
  if (normalizedPrefix === "avery dennison" && normalizedValue.startsWith("avery ")) {
    return true;
  }
  return false;
}

function normalizeLeadingMakerPrefix(baseName: unknown, makerPrefix: string): string {
  const normalizedBase = normalizeCollapsedCatalogLabel(baseName);
  const normalizedPrefix = normalizeSecurityMakerPrefix(makerPrefix);
  if (!normalizedPrefix) {
    return normalizedBase;
  }

  if (normalizedPrefix === "3M") {
    return normalizedBase.replace(/^3m(?:\s+solar)?\b/i, "3M");
  }
  if (normalizedPrefix === "Solar Gard") {
    return normalizedBase.replace(/^(?:solar\s*guard|solargard|solar\s+gard)\b/i, "Solar Gard");
  }
  if (normalizedPrefix === "Avery Dennison") {
    return normalizedBase.replace(/^avery(?:\s+dennison)?\b/i, "Avery Dennison");
  }
  if (normalizedPrefix === "Llumar") {
    return normalizedBase.replace(/^llumar(?:\s+vista)?\b/i, "Llumar");
  }
  if (normalizedPrefix === "SOLYX") {
    return normalizedBase.replace(/^solyx\b/i, "SOLYX");
  }
  if (normalizedPrefix === "ASWFVKOOL") {
    return normalizedBase.replace(/^aswfvkool\b/i, "ASWFVKOOL");
  }
  if (normalizedPrefix === "Madico") {
    return normalizedBase.replace(/^madico\b/i, "Madico");
  }
  if (normalizedPrefix === "SOL") {
    return normalizedBase.replace(/^sol\b/i, "SOL");
  }

  return normalizedBase;
}

function inferSecurityMakerPrefixFromFilmName(filmName: unknown): string {
  const cleaned = stripLeadingSecurityToken(filmName);
  if (!cleaned) return "";
  if (/^3m\b/i.test(cleaned)) return "3M";
  if (/^madico\b/i.test(cleaned)) return "Madico";
  if (/^solar\s*guard\b/i.test(cleaned) || /^solargard\b/i.test(cleaned)) return "Solar Gard";
  if (/^avery(?:\s+dennison)?\b/i.test(cleaned)) return "Avery Dennison";
  if (/^llumar(?:\s+vista)?\b/i.test(cleaned)) return "Llumar";
  if (/^solyx\b/i.test(cleaned)) return "SOLYX";
  if (/^aswfvkool\b/i.test(cleaned)) return "ASWFVKOOL";
  if (/^sol\b/i.test(cleaned)) return "SOL";
  return "";
}

function inferSecurityMakerPrefixFromManufacturer(manufacturer: unknown): string {
  const canonical = canonicalizeManufacturerLabel(manufacturer);
  if (!canonical || normalizeCatalogManufacturerLookupKey(canonical) === normalizeCatalogManufacturerLookupKey(SECURITY_MANUFACTURER_LABEL)) {
    return "";
  }
  return normalizeSecurityMakerPrefix(canonical);
}

function getDefaultMakerPrefixForSecurityFamily(family: string): string {
  if (family === "prestige" || family === "s600") {
    return "3M";
  }
  return "";
}

function shouldTreatPrestigeAsSecurity(manufacturer: unknown, filmName: unknown): boolean {
  const normalizedManufacturer = canonicalizeManufacturerLabel(manufacturer);
  if (
    normalizeCatalogManufacturerLookupKey(normalizedManufacturer) ===
    normalizeCatalogManufacturerLookupKey(SECURITY_MANUFACTURER_LABEL)
  ) {
    return true;
  }

  const normalizedFilmName = normalizeCollapsedCatalogLabel(filmName);
  return (
    /^security\b/i.test(normalizedFilmName) ||
    /\bultra\s+prestige\b/i.test(normalizedFilmName) ||
    /\bpr\s*[-]?\s*\d{2,3}\b/i.test(normalizedFilmName)
  );
}

function detectSecurityFilmFamily(filmName: unknown): { isSecurity: boolean; family: string; agCode: string; modelCode: string } {
  const normalized = normalizeCollapsedCatalogLabel(filmName);
  const squashedUpper = normalized.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const agMatch = normalized.match(/\bAG[-\s]*([0-9]+)\b/i);
  const prestigeCode = inferPrestigeCode(normalized);

  if (prestigeCode) {
    return { isSecurity: true, family: "prestige", agCode: "", modelCode: prestigeCode };
  }

  if (
    /\bULTRA\s*S?600\b/i.test(normalized) ||
    /\bS[-\s]*600\b/i.test(normalized) ||
    squashedUpper.includes("ULTRAS600")
  ) {
    return { isSecurity: true, family: "s600", agCode: "", modelCode: "600" };
  }

  if (agMatch || /\banti\s*graffiti\b/i.test(normalized)) {
    return { isSecurity: true, family: "ag", agCode: agMatch ? agMatch[1] : "", modelCode: "" };
  }
  if (/\bS[-\s]*140\b/i.test(normalized)) {
    return { isSecurity: true, family: "s140", agCode: "", modelCode: "140" };
  }
  if (/\bS[-\s]*70\b/i.test(normalized)) {
    return { isSecurity: true, family: "s70", agCode: "", modelCode: "70" };
  }
  if (
    /\bULTRA\s*S?800\b/i.test(normalized) ||
    /\bS[-\s]*800\b/i.test(normalized) ||
    squashedUpper.includes("ULTRAS800")
  ) {
    return { isSecurity: true, family: "s800", agCode: "", modelCode: "800" };
  }
  if (isBareMilLabel(normalized)) {
    return { isSecurity: false, family: "", agCode: "", modelCode: "" };
  }
  if (/\b\d+\s*mil\b/i.test(normalized)) {
    return { isSecurity: true, family: "mil", agCode: "", modelCode: "" };
  }
  return { isSecurity: false, family: "", agCode: "", modelCode: "" };
}

function buildCanonicalSecurityFilmName(
  sourceFilmName: unknown,
  family: string,
  agCode: string,
  modelCode: string,
  makerPrefix: string,
): string {
  const cleanedSource = normalizeMilTokenSpacing(stripLeadingSecurityToken(sourceFilmName));
  const normalizedPrefix = normalizeSecurityMakerPrefix(makerPrefix);
  const withPrefix = (baseName: string) => {
    const normalizedBase = normalizeCollapsedCatalogLabel(baseName);
    if (!normalizedPrefix) {
      return normalizedBase;
    }
    if (startsWithMakerPrefix(normalizedBase, normalizedPrefix)) {
      return normalizeLeadingMakerPrefix(normalizedBase, normalizedPrefix);
    }
    return `${normalizedPrefix} ${normalizedBase}`;
  };

  if (family === "s800") return withPrefix("Ultra S800");
  if (family === "s70") return withPrefix("S70");
  if (family === "s140") return withPrefix("S140");
  if (family === "ag") return withPrefix(agCode ? `AG-${agCode}` : "AG");
  if (family === "s600") return withPrefix("Ultra S600");
  if (family === "prestige") {
    const prestigeCode = normalizeCollapsedCatalogLabel(modelCode || "");
    return withPrefix(prestigeCode ? `Ultra Prestige ${prestigeCode}` : "Ultra Prestige");
  }
  return withPrefix(cleanedSource);
}

function normalizeSecurityManufacturerAndFilm(manufacturer: unknown, filmName: unknown): { manufacturer: string; filmName: string } {
  const normalizedManufacturer = canonicalizeManufacturerLabel(manufacturer);
  const normalizedFilmName = normalizeCollapsedCatalogLabel(filmName);
  const detection = detectSecurityFilmFamily(normalizedFilmName);
  if (!detection.isSecurity) {
    return { manufacturer: normalizedManufacturer, filmName: normalizedFilmName };
  }

  if (detection.family === "prestige" && !shouldTreatPrestigeAsSecurity(normalizedManufacturer, normalizedFilmName)) {
    return { manufacturer: normalizedManufacturer, filmName: normalizedFilmName };
  }

  const makerPrefix =
    normalizeSecurityMakerPrefix(inferSecurityMakerPrefixFromFilmName(normalizedFilmName)) ||
    normalizeSecurityMakerPrefix(inferSecurityMakerPrefixFromManufacturer(normalizedManufacturer)) ||
    normalizeSecurityMakerPrefix(getDefaultMakerPrefixForSecurityFamily(detection.family));

  return {
    manufacturer: SECURITY_MANUFACTURER_LABEL,
    filmName: buildCanonicalSecurityFilmName(
      normalizedFilmName,
      detection.family,
      detection.agCode,
      detection.modelCode,
      makerPrefix,
    ),
  };
}

function inferNightVisionCode(filmName: unknown): string {
  const normalizedFilmName = normalizeCollapsedCatalogLabel(filmName);
  const nightVisionMatch = normalizedFilmName.match(/\bnight\s*vision\s*(\d{1,3})\b/i);
  if (nightVisionMatch) {
    return canonicalizeNumericDigits(nightVisionMatch[1]);
  }

  const snvMatch = normalizedFilmName.match(/\bs?nv\s*[-]?\s*(\d{1,3})\b/i);
  if (snvMatch) {
    return canonicalizeNumericDigits(snvMatch[1]);
  }

  const securityNvMatch = normalizedFilmName.match(/\bs\s*(\d{1,3})\s*nv\b/i);
  if (securityNvMatch) {
    return canonicalizeNumericDigits(securityNvMatch[1]);
  }

  return "";
}

function normalize3MSolarNightVisionManufacturerAndFilm(
  manufacturer: unknown,
  filmName: unknown,
): { manufacturer: string; filmName: string } {
  const normalizedManufacturer = canonicalizeManufacturerLabel(manufacturer);
  const normalizedFilmName = normalizeCollapsedCatalogLabel(filmName);
  if (
    normalizeCatalogManufacturerLookupKey(normalizedManufacturer) !==
    normalizeCatalogManufacturerLookupKey(SOLAR_MANUFACTURER_LABEL)
  ) {
    return { manufacturer: normalizedManufacturer, filmName: normalizedFilmName };
  }

  const nightVisionCode = inferNightVisionCode(normalizedFilmName);
  if (!nightVisionCode) {
    return { manufacturer: normalizedManufacturer, filmName: normalizedFilmName };
  }

  return {
    manufacturer: SOLAR_MANUFACTURER_LABEL,
    filmName: `Night Vision ${nightVisionCode}`,
  };
}

function normalizeCanonicalManufacturerAndFilm(
  manufacturer: unknown,
  filmName: unknown,
): { manufacturer: string; filmName: string } {
  const securityNormalized = normalizeSecurityManufacturerAndFilm(manufacturer, filmName);
  const solarNormalized = normalize3MSolarNightVisionManufacturerAndFilm(
    securityNormalized.manufacturer,
    securityNormalized.filmName,
  );
  const prefixPolicyNormalizedFilmName = normalizeManufacturerPrefixPolicyFilmName(
    solarNormalized.manufacturer,
    solarNormalized.filmName,
  );
  return {
    manufacturer: solarNormalized.manufacturer,
    filmName: normalizeAveryNaturaShadeFilmName(
      solarNormalized.manufacturer,
      prefixPolicyNormalizedFilmName,
    ),
  };
}

function normalizeCatalogManufacturerLookupKey(value: unknown): string {
  return normalizeCatalogLookupKey(canonicalizeManufacturerLabel(value));
}

function buildFilmKey(manufacturer: unknown, filmName: unknown): string {
  return `${asTrimmedString(manufacturer).toUpperCase()}|${asTrimmedString(filmName).toUpperCase()}`;
}

function normalizeFilmKeyInput(manufacturer: unknown, filmName: unknown, filmKeyInput: unknown): string {
  const normalized = normalizeCanonicalManufacturerAndFilm(manufacturer, filmName);
  void filmKeyInput;
  return buildFilmKey(normalized.manufacturer, normalized.filmName);
}

function compareCatalogStrings(left: unknown, right: unknown): number {
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

function normalizeRequirementWidthKey(value: unknown): string {
  return String(roundToDecimals(Number(value), 4));
}

function normalizeJobRequirementLookupKey(
  manufacturer: unknown,
  filmName: unknown,
  widthIn: unknown,
): string {
  const canonical = normalizeCanonicalManufacturerAndFilm(manufacturer, filmName);
  return [
    normalizeCatalogLookupKey(canonical.manufacturer),
    normalizeCatalogLookupKey(canonical.filmName),
    normalizeRequirementWidthKey(widthIn),
  ].join("|");
}

function stripPlanningExteriorSuffix(
  filmName: unknown,
): { familyFilmName: string; isExterior: boolean } {
  const normalized = normalizeCollapsedCatalogLabel(filmName);
  if (!/\bexterior$/i.test(normalized)) {
    return {
      familyFilmName: normalized,
      isExterior: false,
    };
  }

  const stripped = normalizeCollapsedCatalogLabel(normalized.replace(/\s+exterior$/i, ""));
  return {
    familyFilmName: stripped || normalized,
    isExterior: true,
  };
}

function describePlanningFilmIdentity(
  manufacturer: unknown,
  filmName: unknown,
){
  const canonical = normalizeCanonicalManufacturerAndFilm(manufacturer, filmName);
  return describeSharedJobPlanningFilm(canonical.manufacturer, canonical.filmName);
}

function normalizePlanningFilmKey(manufacturer: unknown, filmName: unknown): string {
  return describePlanningFilmIdentity(manufacturer, filmName).key;
}

function normalizePlanningFilmFamilyKey(manufacturer: unknown, filmName: unknown): string {
  return describePlanningFilmIdentity(manufacturer, filmName).familyKey;
}

function planningFilmIsExterior(manufacturer: unknown, filmName: unknown): boolean {
  return describePlanningFilmIdentity(manufacturer, filmName).isExterior;
}

function planningFilmCanSatisfyRequirement(
  candidateManufacturer: unknown,
  candidateFilmName: unknown,
  requirementManufacturer: unknown,
  requirementFilmName: unknown,
): boolean {
  const candidate = normalizeCanonicalManufacturerAndFilm(candidateManufacturer, candidateFilmName);
  const requirement = normalizeCanonicalManufacturerAndFilm(requirementManufacturer, requirementFilmName);
  return canSharedJobPlanningFilmSatisfyRequirement(
    candidate.manufacturer,
    candidate.filmName,
    requirement.manufacturer,
    requirement.filmName,
  );
}

function getPlanningFilmMatch(
  candidateManufacturer: unknown,
  candidateFilmName: unknown,
  requirementManufacturer: unknown,
  requirementFilmName: unknown,
) {
  const candidate = normalizeCanonicalManufacturerAndFilm(candidateManufacturer, candidateFilmName);
  const requirement = normalizeCanonicalManufacturerAndFilm(requirementManufacturer, requirementFilmName);
  return getSharedJobPlanningFilmMatch(
    candidate.manufacturer,
    candidate.filmName,
    requirement.manufacturer,
    requirement.filmName,
  );
}

function getPlanningFilmManufacturerGroupKey(manufacturer: unknown, filmName: unknown): string {
  return describePlanningFilmIdentity(manufacturer, filmName).manufacturerKey;
}

function normalizeJobNumberKey(jobNumber: unknown): string {
  return asTrimmedString(jobNumber).toUpperCase();
}

function normalizeCrewLeaderKey(crewLeader: unknown): string {
  return asTrimmedString(crewLeader).toUpperCase();
}

function normalizeJobLifecycleStatus(value: unknown): "ACTIVE" | "COMPLETED" | "CANCELLED" {
  const normalized = asTrimmedString(value).toUpperCase();
  if (normalized === "CANCELLED") {
    return "CANCELLED";
  }
  if (normalized === "COMPLETED") {
    return "COMPLETED";
  }
  return "ACTIVE";
}

function normalizeJobLifecycleFilter(value: unknown): "ACTIVE" | "COMPLETED" | "" {
  const normalized = asTrimmedString(value).toUpperCase();
  if (!normalized) {
    return "";
  }
  if (normalized === "ACTIVE" || normalized === "COMPLETED") {
    return normalized;
  }
  throw new HttpError(400, "lifecycleStatus must be ACTIVE or COMPLETED.");
}

function normalizeCalendarMonth(value: unknown): string {
  const month = asTrimmedString(value);
  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw new HttpError(400, "month must use yyyy-mm.");
  }
  return month;
}

function normalizeCalendarView(value: unknown): "week" | "month" {
  const normalized = asTrimmedString(value).toLowerCase();
  if (!normalized || normalized === "month") {
    return "month";
  }
  if (normalized === "week") {
    return "week";
  }
  throw new HttpError(400, "view must be week or month.");
}

function parseCalendarDate(value: unknown): Date | null {
  const match = asTrimmedString(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const dayOfMonth = Number(match[3]);
  const parsed = new Date(year, monthIndex, dayOfMonth);
  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== monthIndex ||
    parsed.getDate() !== dayOfMonth
  ) {
    return null;
  }

  return parsed;
}

function formatCalendarDate(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function normalizeCalendarAnchorDate(anchorDate: unknown, monthFallback?: unknown): string {
  const parsedAnchorDate = parseCalendarDate(anchorDate);
  if (parsedAnchorDate) {
    return formatCalendarDate(parsedAnchorDate);
  }

  const month = asTrimmedString(monthFallback);
  if (month) {
    return `${normalizeCalendarMonth(month)}-01`;
  }

  throw new HttpError(400, "anchorDate must use yyyy-mm-dd.");
}

function shiftCalendarDate(anchorDate: string, deltaDays: number): string {
  const parsedAnchorDate = parseCalendarDate(anchorDate);
  if (!parsedAnchorDate) {
    throw new HttpError(400, "anchorDate must use yyyy-mm-dd.");
  }

  return formatCalendarDate(
    new Date(
      parsedAnchorDate.getFullYear(),
      parsedAnchorDate.getMonth(),
      parsedAnchorDate.getDate() + deltaDays,
    ),
  );
}

function getCalendarWeekStart(anchorDate: string): string {
  const parsedAnchorDate = parseCalendarDate(anchorDate);
  if (!parsedAnchorDate) {
    throw new HttpError(400, "anchorDate must use yyyy-mm-dd.");
  }

  return formatCalendarDate(
    new Date(
      parsedAnchorDate.getFullYear(),
      parsedAnchorDate.getMonth(),
      parsedAnchorDate.getDate() - parsedAnchorDate.getDay(),
    ),
  );
}

function compareBoxesByOldestStock(left: any, right: any): number {
  const leftDate = left.receivedDate || left.orderDate || "9999-12-31";
  const rightDate = right.receivedDate || right.orderDate || "9999-12-31";
  if (leftDate !== rightDate) {
    return leftDate < rightDate ? -1 : 1;
  }
  return left.boxId < right.boxId ? -1 : left.boxId > right.boxId ? 1 : 0;
}

function compareAllocationJobSummaries(left: any, right: any): number {
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

function compareJobsListEntries(left: any, right: any): number {
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

function normalizeJobNumberDigits(value: unknown): string {
  return asTrimmedString(value).replace(/[^0-9]/g, "");
}

function canonicalizeNumericDigits(digits: string): string {
  const withoutLeadingZeros = digits.replace(/^0+/, "");
  return withoutLeadingZeros || "0";
}

function compareBigInt(left: bigint, right: bigint): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function absoluteBigInt(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function normalizePath(value: string | null | undefined): string {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function parseBodyJson(bodyText: string): Record<string, unknown> | null {
  const trimmed = bodyText.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

async function sha1Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-1", data);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function shouldUseCache(method: string, logicalPath: string): boolean {
  if (!Number.isFinite(CACHE_TTL_MS) || CACHE_TTL_MS <= 0) {
    return false;
  }
  if (logicalPath === "/auth/context") {
    return false;
  }
  return method === "GET";
}

function isMutation(method: string, logicalPath: string): boolean {
  return method === "POST" && logicalPath !== "";
}

function getCorsOrigin(request: Request): string {
  const origin = request.headers.get("origin");
  if (!origin || CORS_ALLOWED_ORIGINS.includes("*")) {
    return "*";
  }
  if (CORS_ALLOWED_ORIGINS.includes(origin)) {
    return origin;
  }
  return CORS_ALLOWED_ORIGINS[0] || "*";
}

function buildCorsHeaders(request: Request): Headers {
  const headers = new Headers();
  headers.set("Access-Control-Allow-Origin", getCorsOrigin(request));
  headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, apikey, x-client-info");
  headers.set("Vary", "Origin");
  return headers;
}

function jsonResponse(request: Request, status: number, payload: unknown): Response {
  const headers = buildCorsHeaders(request);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(payload), { status, headers });
}

function pruneCache(): void {
  const now = Date.now();
  for (const [key, entry] of cache.entries()) {
    if (entry.expiresAt <= now) {
      cache.delete(key);
    }
  }
  if (cache.size <= MAX_CACHE_ENTRIES) {
    return;
  }
  const keys = [...cache.keys()];
  const removeCount = cache.size - MAX_CACHE_ENTRIES;
  for (let index = 0; index < removeCount; index += 1) {
    cache.delete(keys[index]);
  }
}

function pruneAuthIdentityCache(): void {
  const now = Date.now();
  for (const [key, entry] of authIdentityCache.entries()) {
    if (entry.expiresAt <= now) {
      authIdentityCache.delete(key);
    }
  }
}

function resolveLogicalPath(requestUrl: URL, bodyJson: Record<string, unknown> | null, canonicalName: string): string {
  const fromQuery = normalizePath(requestUrl.searchParams.get("path"));
  if (fromQuery) {
    return fromQuery;
  }
  const fromBody = normalizePath(bodyJson && typeof bodyJson.path === "string" ? bodyJson.path : "");
  if (fromBody) {
    return fromBody;
  }
  if (requestUrl.pathname === "/" || requestUrl.pathname.endsWith(`/${canonicalName}`)) {
    return "";
  }
  if (requestUrl.pathname.endsWith("/health")) {
    return "/health";
  }
  return normalizePath(requestUrl.pathname);
}

function deriveNameFromEmail(email: string): string {
  const localPart = email.split("@")[0] || "";
  const sanitized = localPart.replace(/[._-]+/g, " ").trim();
  return sanitized || "Inventory User";
}

function createUserScopedClient(token: string) {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  });
}

function createServiceRoleClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return null;
  }

  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

function parseFeaturePermissions(value: unknown): Record<string, { read: boolean; write: boolean }> {
  if (!value || typeof value !== "object") {
    return {};
  }

  const source = value as Record<string, unknown>;
  const next: Record<string, { read: boolean; write: boolean }> = {};
  for (const [feature, raw] of Object.entries(source)) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const featureMap = raw as Record<string, unknown>;
    next[feature] = {
      read: featureMap.read === true || String(featureMap.read).toLowerCase() === "true",
      write: featureMap.write === true || String(featureMap.write).toLowerCase() === "true",
    };
  }

  return next;
}

async function fetchUserEmailById(userId: string): Promise<string> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !userId) {
    return "";
  }

  const now = Date.now();
  const cached = authUserProfileCache.get(userId);
  if (cached && cached.expiresAt > now) {
    return cached.profile.email;
  }

  const response = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      apikey: SUPABASE_SERVICE_ROLE_KEY,
    },
  });

  if (!response.ok) {
    return "";
  }

  const payload = await response.json();
  const source =
    payload && typeof payload === "object" && payload.user && typeof payload.user === "object"
      ? (payload.user as Record<string, unknown>)
      : (payload as Record<string, unknown>);
  const email = asTrimmedString(source?.email);
  const metadata = source?.user_metadata && typeof source.user_metadata === "object"
    ? (source.user_metadata as Record<string, unknown>)
    : {};
  const name =
    asTrimmedString(metadata.full_name) ||
    asTrimmedString(metadata.name) ||
    (email ? deriveNameFromEmail(email) : "");

  authUserProfileCache.set(userId, {
    expiresAt: Date.now() + 5 * 60_000,
    profile: {
      email,
      name,
    },
  });

  return email;
}

async function fetchUserProfileById(userId: string): Promise<{ email: string; name: string }> {
  const cached = authUserProfileCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.profile;
  }

  const email = await fetchUserEmailById(userId);
  const profile = authUserProfileCache.get(userId);
  if (profile && profile.expiresAt > Date.now()) {
    return profile.profile;
  }

  return {
    email,
    name: email ? deriveNameFromEmail(email) : "",
  };
}

async function enrichAdminPermissionEntries(entriesRaw: unknown[]): Promise<Record<string, unknown>[]> {
  const entries = Array.isArray(entriesRaw) ? entriesRaw : [];
  const response: Record<string, unknown>[] = [];

  for (const rawEntry of entries) {
    if (!rawEntry || typeof rawEntry !== "object") {
      continue;
    }

    const entry = rawEntry as Record<string, unknown>;
    const userId = asTrimmedString(entry.userId);
    if (!userId) {
      continue;
    }

    let email = asTrimmedString(entry.email);
    let name = asTrimmedString(entry.name);
    if (!email || !name) {
      const profile = await fetchUserProfileById(userId);
      if (!email) {
        email = profile.email;
      }
      if (!name) {
        name = profile.name;
      }
    }

    if (!name) {
      name = email ? deriveNameFromEmail(email) : userId;
    }

    response.push({
      ...entry,
      userId,
      role: "admin",
      email,
      name,
    });
  }

  return response;
}

async function sendNewAccessRequestNotification(params: {
  orgId: string;
  requestedEmail: string;
  requestedUserId: string;
}): Promise<void> {
  if (!RESEND_API_KEY || !RESEND_FROM_EMAIL) {
    return;
  }

  const serviceClient = createServiceRoleClient();
  if (!serviceClient) {
    return;
  }

  const { data, error } = await serviceClient.rpc("api_list_access_notification_recipients", {
    p_org_id: params.orgId,
  });
  if (error) {
    return;
  }

  const recipientsRaw = Array.isArray(data) ? data : [];
  const recipientEmails = new Set<string>();
  for (const entry of recipientsRaw) {
    const userId = asTrimmedString((entry as Record<string, unknown>)?.user_id);
    if (!userId) {
      continue;
    }
    const email = await fetchUserEmailById(userId);
    if (email) {
      recipientEmails.add(email);
    }
  }

  if (!recipientEmails.size) {
    return;
  }

  const to = [...recipientEmails];
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: RESEND_FROM_EMAIL,
      to,
      subject: "New inventory access request pending approval",
      text:
        `A new user is waiting for approval.\n\n` +
        `Email: ${params.requestedEmail || "(unknown)"}\n` +
        `User ID: ${params.requestedUserId}\n` +
        `Organization ID: ${params.orgId}`,
    }),
  });
}

function statusFromRpcError(error: any, fallback = 500) {
  const detail = asTrimmedString(error?.details);
  const match = detail.match(/status=(\d+)/i);
  return match ? Number(match[1]) : fallback;
}

function mapBackendBootstrapError(message: string): string {
  const normalized = asTrimmedString(message).toLowerCase();
  if (
    normalized.includes('relation "app.general_feature_permissions" does not exist') ||
    normalized.includes('relation "app.admin_feature_permissions" does not exist') ||
    normalized.includes('relation "app.access_requests" does not exist') ||
    normalized.includes('relation "app.username_change_requests" does not exist') ||
    normalized.includes('column "requested_by_name" does not exist') ||
    (normalized.includes('function public.api_get_auth_context') && normalized.includes('does not exist')) ||
    (normalized.includes('function public.api_request_username_change') && normalized.includes('does not exist')) ||
    (normalized.includes('function public.api_get_user_feature_permissions') && normalized.includes('does not exist')) ||
    (normalized.includes('function public.api_update_user_feature_permissions') && normalized.includes('does not exist')) ||
    (normalized.includes('function app_api.member_permissions_for_user_json') && normalized.includes('does not exist'))
  ) {
    return 'Database migrations 0006_access_control_and_approvals.sql, 0007_access_request_display_name.sql, 0008_username_change_requests.sql, 0009_user_feature_overrides.sql, 0027_member_read_only_permissions.sql, and 0028_member_permission_persistence_guardrails.sql are required. Run all six, then retry.';
  }
  return message;
}

async function rpcOrThrow<T>(client: any, fn: string, params: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await client.rpc(fn, params);
  if (error) {
    const rawMessage = asTrimmedString(error.message) || "Unexpected database error.";
    throw new HttpError(statusFromRpcError(error), mapBackendBootstrapError(rawMessage));
  }
  return data as T;
}

function isFilmNameAliasRpcUnavailable(message: string): boolean {
  const normalized = asTrimmedString(message).toLowerCase();
  if (!normalized) {
    return false;
  }

  return (
    (normalized.includes("api_acl_list_film_name_aliases") && normalized.includes("does not exist")) ||
    (normalized.includes("api_acl_list_film_name_aliases") && normalized.includes("permission denied")) ||
    (normalized.includes("app.film_name_aliases") && normalized.includes("does not exist"))
  );
}

function pruneFilmNameAliasCache() {
  const now = Date.now();
  for (const [key, entry] of filmNameAliasCache.entries()) {
    if (entry.expiresAt <= now) {
      filmNameAliasCache.delete(key);
    }
  }
}

async function listFilmNameAliases(client: any, orgId: string) {
  pruneFilmNameAliasCache();
  const cached = filmNameAliasCache.get(orgId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.aliases;
  }

  let rows: Array<{
    manufacturer_lookup_key: unknown;
    old_film_name_lookup_key: unknown;
    canonical_film_name: unknown;
  }> = [];
  try {
    rows = await rpcOrThrow(client, "api_acl_list_film_name_aliases", { p_org_id: orgId });
  } catch (error) {
    const message = error instanceof HttpError ? asTrimmedString(error.message) : "";
    if (!isFilmNameAliasRpcUnavailable(message)) {
      throw error;
    }
  }

  const aliases: Record<string, string> = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const manufacturerLookupKey = normalizeCatalogManufacturerLookupKey(row.manufacturer_lookup_key);
    const oldFilmNameLookupKey = normalizeCatalogLookupKey(row.old_film_name_lookup_key);
    const canonicalFilmName = normalizeCollapsedCatalogLabel(row.canonical_film_name);
    if (!manufacturerLookupKey || !oldFilmNameLookupKey || !canonicalFilmName) {
      continue;
    }
    aliases[`${manufacturerLookupKey}|${oldFilmNameLookupKey}`] = canonicalFilmName;
  }

  filmNameAliasCache.set(orgId, {
    aliases,
    expiresAt: Date.now() + FILM_NAME_ALIAS_CACHE_TTL_MS,
  });
  return aliases;
}

async function resolveCanonicalFilmNameAlias(
  client: any,
  orgId: string,
  manufacturer: unknown,
  filmName: unknown,
): Promise<string> {
  const canonicalManufacturer = canonicalizeManufacturerLabel(manufacturer);
  const normalizedFilmName = normalizeCollapsedCatalogLabel(filmName);
  if (!normalizedFilmName) {
    return "";
  }

  const aliases = await listFilmNameAliases(client, orgId);
  const key = `${normalizeCatalogManufacturerLookupKey(canonicalManufacturer)}|${normalizeCatalogLookupKey(normalizedFilmName)}`;
  return aliases[key] || normalizedFilmName;
}

async function resolveCanonicalFilmEntry(
  client: any,
  orgId: string,
  manufacturer: unknown,
  filmName: unknown,
): Promise<{ manufacturer: string; filmName: string }> {
  const normalized = normalizeCanonicalManufacturerAndFilm(manufacturer, filmName);
  const aliasResolvedFilmName = await resolveCanonicalFilmNameAlias(
    client,
    orgId,
    normalized.manufacturer,
    normalized.filmName,
  );
  return normalizeCanonicalManufacturerAndFilm(normalized.manufacturer, aliasResolvedFilmName);
}

const inventoryRepositories = createInventoryRepositories({
  rpcOrThrow,
  asTrimmedString,
  numericOrNull,
  integerOrZero,
  integerOrNull,
  formatDateValue,
  formatTimestamp,
});
const {
  mapDbRollHistoryRow,
  toPublicBox,
  toPublicAllocation,
  toPublicFilmOrder,
  listBoxes,
  findBoxById,
  listFilmCatalog,
  listAllocations,
  listAllocationsByBox,
  listAllocationsByJob,
  listAllocationsByFilmOrderId,
  listAllocationsByIds,
  listActiveAllocations,
  listFilmOrders,
  listFilmOrdersByJob,
  findFilmOrderById,
  listFilmOrderLinksByFilmOrderId,
  listJobs,
  findJobByNumber,
  listJobRequirements,
  listJobRequirementsByJob,
  listJobCaulkRequirementsByJob,
  listCaulkJobAllocationsByJob,
  listCaulkJobCheckoutsByJob,
  listAuditEntries,
  listAuditEntriesByBox,
  listRollHistoryByBox,
} = inventoryRepositories;

async function resolveAuthContext(request: Request): Promise<{ identity: AuthIdentity; client: any }> {
  return resolveAuthContextFromModule(request, {
    asTrimmedString,
    deriveNameFromEmail,
    pruneAuthIdentityCache,
    authIdentityCache,
    createUserScopedClient,
    rpcOrThrow,
    parseFeaturePermissions,
    sendNewAccessRequestNotification,
  });
}

function routeParams(method: string, requestUrl: URL, bodyJson: Record<string, unknown> | null) {
  return routeParamsFromModule(method, requestUrl, bodyJson);
}
function getRollHistoryActivityTimestamp(entry: any): string {
  return asTrimmedString(entry.checkedInAt) || asTrimmedString(entry.checkedOutAt) || "";
}

async function listRollHistoryByJob(client: any, orgId: string, jobNumber: string, allocations: any[] = []) {
  return await listRollHistoryByJobFromService(client, orgId, jobNumber, allocations, {
    asTrimmedString,
    normalizeJobNumberKey,
    createServiceRoleClient,
    listBoxes,
    listRollHistoryByBox,
    mapDbRollHistoryRow,
  });
}

function createTransferId(): string {
  return `TRF-${createLogId()}`.toUpperCase();
}

function mapDbBoxTransferRow(row: any) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    orgId: row.org_id,
    transferId: asTrimmedString(row.transfer_id).toUpperCase(),
    boxRecordId: row.box_record_id,
    sourceBoxId: asTrimmedString(row.source_box_id).toUpperCase(),
    destinationBoxId: asTrimmedString(row.destination_box_id).toUpperCase(),
    sourceWarehouse: asTrimmedString(row.source_warehouse).toUpperCase(),
    destinationWarehouse: asTrimmedString(row.destination_warehouse).toUpperCase(),
    status: asTrimmedString(row.status).toUpperCase() || "PENDING",
    notes: asTrimmedString(row.notes),
    createdAt: formatTimestamp(row.created_at),
    createdBy: asTrimmedString(row.created_by),
    receivedAt: formatTimestamp(row.received_at),
    receivedBy: asTrimmedString(row.received_by),
    cancelledAt: formatTimestamp(row.cancelled_at),
    cancelledBy: asTrimmedString(row.cancelled_by),
    updatedAt: formatTimestamp(row.updated_at),
    updatedBy: asTrimmedString(row.updated_by),
  };
}

function toPublicBoxTransfer(transfer: any) {
  if (!transfer) {
    return null;
  }

  return {
    transferId: transfer.transferId,
    boxId: transfer.status === "RECEIVED" ? transfer.destinationBoxId : transfer.sourceBoxId,
    sourceBoxId: transfer.sourceBoxId,
    destinationBoxId: transfer.destinationBoxId,
    sourceWarehouse: transfer.sourceWarehouse,
    destinationWarehouse: transfer.destinationWarehouse,
    status: transfer.status,
    createdAt: transfer.createdAt,
    createdBy: transfer.createdBy,
    receivedAt: transfer.receivedAt,
    receivedBy: transfer.receivedBy,
    cancelledAt: transfer.cancelledAt,
    cancelledBy: transfer.cancelledBy,
    notes: transfer.notes,
  };
}

async function findWarehouseEntry(client: any, orgId: string, warehouseCode: unknown, fieldName = "warehouse") {
  const normalizedCode = requireString(warehouseCode, fieldName).toUpperCase();
  const warehouseRows = await rpcOrThrow<any[]>(client, "api_acl_list_warehouses", {
    p_org_id: orgId,
  });
  const matchingRow = (warehouseRows || []).find((row) => asTrimmedString(row.code).toUpperCase() === normalizedCode);
  if (!matchingRow) {
    throw new HttpError(400, `${fieldName} is not configured.`);
  }

  return {
    code: normalizedCode,
    name: asTrimmedString(matchingRow.name),
    boxIdPrefix: asTrimmedString(matchingRow.box_id_prefix).toUpperCase() || normalizedCode,
  };
}

function getBoxIdPrefixToken(prefix: unknown): string {
  return requireString(prefix, "BoxID prefix")
    .toUpperCase()
    .replace(/-+$/, "");
}

function getTransferredBoxIdSuffix(boxId: unknown, sourcePrefix: unknown): string {
  const normalizedBoxId = requireString(boxId, "BoxID").toUpperCase();
  const normalizedSourcePrefix = getBoxIdPrefixToken(sourcePrefix);
  const prefixWithDash = `${normalizedSourcePrefix}-`;
  if (normalizedBoxId.startsWith(prefixWithDash)) {
    return normalizedBoxId.slice(prefixWithDash.length);
  }

  const dashIndex = normalizedBoxId.indexOf("-");
  if (dashIndex >= 0 && dashIndex < normalizedBoxId.length - 1) {
    return normalizedBoxId.slice(dashIndex + 1);
  }

  return normalizedBoxId;
}

function buildTransferredBoxId(boxId: unknown, sourcePrefix: unknown, destinationPrefix: unknown): string {
  return `${getBoxIdPrefixToken(destinationPrefix)}-${getTransferredBoxIdSuffix(boxId, sourcePrefix)}`.toUpperCase();
}

async function findBoxByRecordId(client: any, orgId: string, boxRecordId: string) {
  if (!boxRecordId) {
    return null;
  }

  const serviceClient = requireServiceRoleClient();
  const { data, error } = await serviceClient
    .schema("app")
    .from("boxes")
    .select("box_id")
    .eq("org_id", orgId)
    .eq("id", boxRecordId)
    .maybeSingle();
  throwOnSupabaseError(error, "Unable to load box");

  const boxId = asTrimmedString((data || {}).box_id);
  if (!boxId) {
    return null;
  }

  return await findBoxById(client, orgId, boxId);
}

async function findBoxTransferByTransferId(client: any, orgId: string, transferId: string) {
  const serviceClient = requireServiceRoleClient();
  const { data, error } = await serviceClient
    .schema("app")
    .from("box_transfers")
    .select("*")
    .eq("org_id", orgId)
    .eq("transfer_id", requireString(transferId, "TransferID").toUpperCase())
    .maybeSingle();
  throwOnSupabaseError(error, "Unable to load box transfer");
  return mapDbBoxTransferRow(data);
}

async function listBoxTransfersByBoxRecordId(client: any, orgId: string, boxRecordId: string) {
  if (!boxRecordId) {
    return [];
  }

  const serviceClient = requireServiceRoleClient();
  const { data, error } = await serviceClient
    .schema("app")
    .from("box_transfers")
    .select("*")
    .eq("org_id", orgId)
    .eq("box_record_id", boxRecordId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false });
  throwOnSupabaseError(error, "Unable to load box transfer history");
  return (Array.isArray(data) ? data : []).map(mapDbBoxTransferRow);
}

async function getLatestBoxTransferByBoxId(client: any, orgId: string, boxId: string) {
  const box = await findBoxById(client, orgId, boxId);
  if (!box) {
    return { box: null, transfer: null };
  }

  const transfers = await listBoxTransfersByBoxRecordId(client, orgId, box.id);
  return {
    box,
    transfer: transfers[0] || null,
  };
}

async function findPendingBoxTransferByBoxRecordId(client: any, orgId: string, boxRecordId: string) {
  if (!boxRecordId) {
    return null;
  }

  const serviceClient = requireServiceRoleClient();
  const { data, error } = await serviceClient
    .schema("app")
    .from("box_transfers")
    .select("*")
    .eq("org_id", orgId)
    .eq("box_record_id", boxRecordId)
    .eq("status", "PENDING")
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  throwOnSupabaseError(error, "Unable to load pending transfer");
  return mapDbBoxTransferRow(data);
}

async function listPendingBoxTransfersByBoxRecordIds(client: any, orgId: string, boxRecordIds: string[]) {
  const normalizedIds = Array.from(new Set((Array.isArray(boxRecordIds) ? boxRecordIds : []).filter(Boolean)));
  if (!normalizedIds.length) {
    return [];
  }

  const serviceClient = requireServiceRoleClient();
  const { data, error } = await serviceClient
    .schema("app")
    .from("box_transfers")
    .select("*")
    .eq("org_id", orgId)
    .eq("status", "PENDING")
    .in("box_record_id", normalizedIds)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false });
  throwOnSupabaseError(error, "Unable to load pending transfers");
  return (Array.isArray(data) ? data : []).map(mapDbBoxTransferRow);
}

function indexPendingBoxTransfersByBoxRecordId(transfers: any[]) {
  const indexed: Record<string, any> = {};
  for (const transfer of Array.isArray(transfers) ? transfers : []) {
    if (!transfer?.boxRecordId || indexed[transfer.boxRecordId]) {
      continue;
    }
    indexed[transfer.boxRecordId] = transfer;
  }
  return indexed;
}

async function saveBoxTransferRecord(client: any, orgId: string, transfer: Record<string, unknown>) {
  const serviceClient = requireServiceRoleClient();
  const row = {
    org_id: orgId,
    transfer_id: requireString(transfer.transferId, "TransferID").toUpperCase(),
    box_record_id: requireString(transfer.boxRecordId, "BoxRecordID"),
    source_box_id: requireString(transfer.sourceBoxId, "SourceBoxID").toUpperCase(),
    destination_box_id: requireString(transfer.destinationBoxId, "DestinationBoxID").toUpperCase(),
    source_warehouse: requireString(transfer.sourceWarehouse, "SourceWarehouse").toUpperCase(),
    destination_warehouse: requireString(transfer.destinationWarehouse, "DestinationWarehouse").toUpperCase(),
    status: requireString(transfer.status, "TransferStatus").toUpperCase(),
    notes: asTrimmedString(transfer.notes),
    created_at: asTrimmedString(transfer.createdAt) || new Date().toISOString(),
    created_by: asTrimmedString(transfer.createdBy),
    received_at: asTrimmedString(transfer.receivedAt) || null,
    received_by: asTrimmedString(transfer.receivedBy) || null,
    cancelled_at: asTrimmedString(transfer.cancelledAt) || null,
    cancelled_by: asTrimmedString(transfer.cancelledBy) || null,
    updated_at: asTrimmedString(transfer.updatedAt) || new Date().toISOString(),
    updated_by: asTrimmedString(transfer.updatedBy || transfer.createdBy),
  };

  const { data, error } = await serviceClient
    .schema("app")
    .from("box_transfers")
    .upsert(row, { onConflict: "org_id,transfer_id" })
    .select("*")
    .single();
  throwOnSupabaseError(error, "Unable to save box transfer");
  return mapDbBoxTransferRow(data);
}

async function appendAuditEntry(
  orgId: string,
  action: string,
  boxId: string,
  beforeState: unknown,
  afterState: unknown,
  actor: string,
  notes: unknown,
) {
  const serviceClient = requireServiceRoleClient();
  const logId = createLogId();
  const { error } = await serviceClient
    .schema("app")
    .from("audit_log")
    .insert({
      org_id: orgId,
      log_id: logId,
      action,
      box_id: boxId,
      before_state: beforeState === null ? null : beforeState,
      after_state: afterState === null ? null : afterState,
      actor: asTrimmedString(actor),
      notes: asTrimmedString(notes),
      created_at: new Date().toISOString(),
    });
  throwOnSupabaseError(error, "Unable to write audit entry");
  return logId;
}

async function listActiveAllocationTransferTargetsForBox(client: any, orgId: string, boxId: string) {
  const activeAllocations = (await listAllocationsByBox(client, orgId, boxId)).filter(
    (entry) => entry.status === "ACTIVE" && asTrimmedString(entry.jobNumber),
  );
  const distinctJobNumbers = Array.from(new Set(activeAllocations.map((entry) => asTrimmedString(entry.jobNumber))));
  const jobs = await Promise.all(distinctJobNumbers.map((jobNumber) => findJobByNumber(client, orgId, jobNumber)));
  const warehouseByJobNumber = Object.fromEntries(
    distinctJobNumbers.map((jobNumber, index) => [jobNumber, asTrimmedString(jobs[index]?.warehouse).toUpperCase()]),
  );

  return activeAllocations.map((entry) => ({
    allocationId: asTrimmedString(entry.allocationId),
    jobNumber: asTrimmedString(entry.jobNumber),
    jobWarehouse: warehouseByJobNumber[asTrimmedString(entry.jobNumber)] || "",
  }));
}

function getTransferStartGuardForBox(box: any, activeTargets: any[]) {
  const sourceWarehouse = asTrimmedString(box?.warehouse).toUpperCase();
  const distinctDestinations = new Set<string>();
  let hasSameWarehouseAllocation = false;

  for (const target of Array.isArray(activeTargets) ? activeTargets : []) {
    const destinationWarehouse = asTrimmedString(target?.jobWarehouse).toUpperCase();
    if (!destinationWarehouse) {
      continue;
    }

    if (destinationWarehouse === sourceWarehouse) {
      hasSameWarehouseAllocation = true;
      continue;
    }

    distinctDestinations.add(destinationWarehouse);
  }

  if (hasSameWarehouseAllocation) {
    return {
      suggestedDestinationWarehouse: "",
      blockingMessage:
        `Box ${box.boxId} still has active allocations for jobs in ${sourceWarehouse}. Remove those same-warehouse allocations before starting a transfer.`,
    };
  }

  if (distinctDestinations.size > 1) {
    return {
      suggestedDestinationWarehouse: "",
      blockingMessage:
        `Box ${box.boxId} has active allocations for multiple destination warehouses. Clear the conflicting allocations before starting a transfer.`,
    };
  }

  return {
    suggestedDestinationWarehouse: Array.from(distinctDestinations)[0] || "",
    blockingMessage: "",
  };
}

async function boxIdOrAliasExists(orgId: string, boxId: string, excludedBoxRecordId = "") {
  const normalizedBoxId = requireString(boxId, "BoxID").toUpperCase();
  const serviceClient = requireServiceRoleClient();
  const { data: existingBox, error: existingBoxError } = await serviceClient
    .schema("app")
    .from("boxes")
    .select("id")
    .eq("org_id", orgId)
    .eq("box_id", normalizedBoxId)
    .maybeSingle();
  throwOnSupabaseError(existingBoxError, "Unable to check box ID availability");

  const { data: aliasRow, error: aliasError } = await serviceClient
    .schema("app")
    .from("box_id_aliases")
    .select("canonical_box_id")
    .eq("org_id", orgId)
    .eq("old_box_id", normalizedBoxId)
    .maybeSingle();
  throwOnSupabaseError(aliasError, "Unable to check box ID aliases");

  if (existingBox && (!excludedBoxRecordId || asTrimmedString((existingBox as Record<string, unknown>).id) !== excludedBoxRecordId)) {
    return true;
  }

  if (aliasRow && excludedBoxRecordId) {
    const canonicalBoxId = asTrimmedString((aliasRow as Record<string, unknown>).canonical_box_id);
    if (canonicalBoxId) {
      const { data: canonicalBox, error: canonicalBoxError } = await serviceClient
        .schema("app")
        .from("boxes")
        .select("id")
        .eq("org_id", orgId)
        .eq("box_id", canonicalBoxId)
        .maybeSingle();
      throwOnSupabaseError(canonicalBoxError, "Unable to resolve alias owner");
      if (canonicalBox && asTrimmedString((canonicalBox as Record<string, unknown>).id) === excludedBoxRecordId) {
        return false;
      }
    }
  }

  return Boolean(aliasRow);
}

async function releaseReusableBoxIdAlias(orgId: string, boxId: string, boxRecordId: string) {
  const normalizedBoxId = requireString(boxId, "BoxID").toUpperCase();
  const normalizedBoxRecordId = requireString(boxRecordId, "BoxRecordID");
  const serviceClient = requireServiceRoleClient();
  const { data: aliasRow, error: aliasError } = await serviceClient
    .schema("app")
    .from("box_id_aliases")
    .select("canonical_box_id")
    .eq("org_id", orgId)
    .eq("old_box_id", normalizedBoxId)
    .maybeSingle();
  throwOnSupabaseError(aliasError, "Unable to load reusable box ID alias");

  if (!aliasRow) {
    return false;
  }

  const canonicalBoxId = asTrimmedString((aliasRow as Record<string, unknown>).canonical_box_id);
  if (!canonicalBoxId) {
    return false;
  }

  const { data: canonicalBox, error: canonicalBoxError } = await serviceClient
    .schema("app")
    .from("boxes")
    .select("id")
    .eq("org_id", orgId)
    .eq("box_id", canonicalBoxId)
    .maybeSingle();
  throwOnSupabaseError(canonicalBoxError, "Unable to resolve reusable alias owner");

  if (!canonicalBox || asTrimmedString((canonicalBox as Record<string, unknown>).id) !== normalizedBoxRecordId) {
    return false;
  }

  const { error: deleteAliasError } = await serviceClient
    .schema("app")
    .from("box_id_aliases")
    .delete()
    .eq("org_id", orgId)
    .eq("old_box_id", normalizedBoxId);
  throwOnSupabaseError(deleteAliasError, "Unable to release reusable box ID alias");

  return true;
}

async function applyReceivedBoxTransfer(
  client: any,
  orgId: string,
  box: any,
  destinationWarehouse: string,
  destinationBoxId: string,
  actor: string,
) {
  const serviceClient = requireServiceRoleClient();
  const sourceBoxId = requireString(box?.boxId, "SourceBoxID").toUpperCase();
  const sourceBoxRecordId = requireString(box?.id, "BoxRecordID");
  const normalizedDestinationWarehouse = requireString(destinationWarehouse, "ToWarehouse").toUpperCase();
  const normalizedDestinationBoxId = requireString(destinationBoxId, "DestinationBoxID").toUpperCase();
  const nowIso = new Date().toISOString();
  const normalizedActor = asTrimmedString(actor);

  const { error: updateBoxError } = await serviceClient
    .schema("app")
    .from("boxes")
    .update({
      box_id: normalizedDestinationBoxId,
      warehouse: normalizedDestinationWarehouse,
      status: "IN_STOCK",
      updated_at: nowIso,
      updated_by: normalizedActor,
    })
    .eq("org_id", orgId)
    .eq("id", sourceBoxRecordId);
  throwOnSupabaseError(updateBoxError, `Unable to update box ${sourceBoxId}`);

  const updateByBoxId = async (table: string, column: string, updateValues: Record<string, unknown>) => {
    const { error } = await serviceClient
      .schema("app")
      .from(table)
      .update(updateValues)
      .eq("org_id", orgId)
      .eq(column, sourceBoxId);
    throwOnSupabaseError(error, `Unable to update ${table}`);
  };

  await updateByBoxId("allocations", "box_id", {
    box_id: normalizedDestinationBoxId,
    warehouse: normalizedDestinationWarehouse,
  });
  await updateByBoxId("audit_log", "box_id", { box_id: normalizedDestinationBoxId });
  await updateByBoxId("roll_weight_log", "box_id", { box_id: normalizedDestinationBoxId });
  await updateByBoxId("film_order_box_links", "box_id", { box_id: normalizedDestinationBoxId });
  await updateByBoxId("film_orders", "source_box_id", { source_box_id: normalizedDestinationBoxId });
  await updateByBoxId("film_catalog", "source_box_id", {
    source_box_id: normalizedDestinationBoxId,
    updated_at: nowIso,
  });

  const { error: touchAliasError } = await serviceClient
    .schema("app")
    .from("box_id_aliases")
    .update({
      updated_at: nowIso,
      updated_by: normalizedActor,
    })
    .eq("org_id", orgId)
    .eq("canonical_box_id", normalizedDestinationBoxId);
  throwOnSupabaseError(touchAliasError, "Unable to update box aliases");

  const { error: aliasUpsertError } = await serviceClient
    .schema("app")
    .from("box_id_aliases")
    .upsert(
      {
        org_id: orgId,
        old_box_id: sourceBoxId,
        canonical_box_id: normalizedDestinationBoxId,
        expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        created_by: normalizedActor,
        updated_by: normalizedActor,
        updated_at: nowIso,
      },
      { onConflict: "org_id,old_box_id" },
    );
  throwOnSupabaseError(aliasUpsertError, "Unable to save box alias");

  return await findBoxById(client, orgId, normalizedDestinationBoxId);
}

function buildFilmTransferAlertMessage(alerts: any[], context: "staging" | "checkout") {
  if (!Array.isArray(alerts) || alerts.length === 0) {
    return "";
  }

  const actionLabel = context === "staging" ? "staging this job" : "checking out this job";
  return `Receive transferred film before ${actionLabel}.`;
}

function buildJobFilmTransferAlerts(
  jobWarehouse: unknown,
  allocations: any[],
  boxById: Record<string, any>,
  pendingTransferByBoxRecordId: Record<string, any> = {},
) {
  const normalizedJobWarehouse = asTrimmedString(jobWarehouse).toUpperCase();
  if (!normalizedJobWarehouse) {
    return [];
  }

  const alerts: any[] = [];
  const seen = new Set<string>();

  for (const allocation of Array.isArray(allocations) ? allocations : []) {
    if (!allocation || allocation.status !== "ACTIVE" || !allocation.boxId) {
      continue;
    }

    const box = boxById[allocation.boxId] || null;
    if (!box) {
      continue;
    }

    const sourceWarehouse = asTrimmedString(box.warehouse).toUpperCase();
    if (!sourceWarehouse || sourceWarehouse === normalizedJobWarehouse) {
      continue;
    }

    const pendingTransfer = box.id ? pendingTransferByBoxRecordId[box.id] || null : null;
    const state =
      pendingTransfer && pendingTransfer.destinationWarehouse === normalizedJobWarehouse
        ? "TRANSFER_PENDING"
        : "NEEDS_TRANSFER";
    const dedupeKey = `${box.boxId}:${normalizedJobWarehouse}:${state}`;
    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    alerts.push({
      boxId: box.boxId,
      sourceWarehouse,
      destinationWarehouse: normalizedJobWarehouse,
      state,
      transferId: pendingTransfer ? pendingTransfer.transferId : "",
      startedAt: pendingTransfer ? pendingTransfer.createdAt : "",
      startedBy: pendingTransfer ? pendingTransfer.createdBy : "",
    });
  }

  return alerts;
}

function toUsageTimestampSortValue(entry: any) {
  return getRollHistoryActivityTimestamp(entry);
}

function buildPublicJobUsageEntries(rollHistoryEntries: any[], boxById: Record<string, any>) {
  const grouped: Record<string, any> = {};
  const entries = Array.isArray(rollHistoryEntries) ? rollHistoryEntries : [];

  for (const entry of entries) {
    if (!entry || !entry.boxId) {
      continue;
    }

    const usedFeet = Math.max(integerOrZero(entry.feetBefore) - integerOrZero(entry.feetAfter), 0);
    const timestampSortValue = toUsageTimestampSortValue(entry);
    const box = boxById[entry.boxId] || null;

    if (!grouped[entry.boxId]) {
      grouped[entry.boxId] = {
        boxId: entry.boxId,
        manufacturer: box ? box.manufacturer : asTrimmedString(entry.manufacturer),
        filmName: box ? box.filmName : asTrimmedString(entry.filmName),
        widthIn: box ? box.widthIn : numericOrNull(entry.widthIn) ?? 0,
        usedFeet: 0,
        usageEventCount: 0,
        latestCheckedInAt: "",
        latestCheckedOutAt: "",
        lastActivityAt: "",
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
  response.sort((left: any, right: any) => {
    if (left.lastActivityAt !== right.lastActivityAt) {
      return left.lastActivityAt > right.lastActivityAt ? -1 : 1;
    }
    return left.boxId < right.boxId ? -1 : left.boxId > right.boxId ? 1 : 0;
  });
  return response;
}

function buildCaulkCoverageByProductId(caulkAllocations: any[]) {
  const totals: Record<string, number> = {};
  for (const entry of caulkAllocations) {
    const productId = asTrimmedString(entry.productId);
    if (!productId || asTrimmedString(entry.status).toUpperCase() === "CANCELLED") {
      continue;
    }
    totals[productId] = (totals[productId] || 0) + Math.max(0, integerOrZero(entry.allocatedTubes));
  }
  return totals;
}

function buildPublicCaulkRequirementEntries(caulkRequirements: any[], caulkAllocations: any[]) {
  const coverageByProductId = buildCaulkCoverageByProductId(caulkAllocations);
  const response = (Array.isArray(caulkRequirements) ? caulkRequirements : []).map((entry) => {
    const requiredTubes = Math.max(0, integerOrZero(entry.requiredTubes));
    const allocatedTubes = Math.max(0, integerOrZero(coverageByProductId[asTrimmedString(entry.productId)] || 0));
    const remainingTubes = Math.max(0, requiredTubes - allocatedTubes);
    return {
      requirementId: asTrimmedString(entry.requirementId),
      jobNumber: asTrimmedString(entry.jobNumber),
      productId: asTrimmedString(entry.productId),
      manufacturerId: asTrimmedString(entry.manufacturerId),
      manufacturer: asTrimmedString(entry.manufacturer),
      productName: asTrimmedString(entry.productName),
      productCode: asTrimmedString(entry.productCode),
      tubesPerCase: integerOrZero(entry.tubesPerCase),
      requiredTubes,
      allocatedTubes,
      remainingTubes,
      notes: asTrimmedString(entry.notes),
      updatedAt: asTrimmedString(entry.updatedAt),
    };
  });

  response.sort((left, right) => {
    const manufacturerCompare = compareCatalogStrings(left.manufacturer, right.manufacturer);
    if (manufacturerCompare !== 0) {
      return manufacturerCompare;
    }
    const productCompare = compareCatalogStrings(left.productName, right.productName);
    if (productCompare !== 0) {
      return productCompare;
    }
    return compareCatalogStrings(left.productCode, right.productCode);
  });
  return response;
}

function summarizeCaulkRequirementCoverage(caulkRequirements: any[]) {
  let requiredTubes = 0;
  let allocatedTubes = 0;
  let remainingTubes = 0;

  for (const entry of Array.isArray(caulkRequirements) ? caulkRequirements : []) {
    requiredTubes += Math.max(0, integerOrZero(entry.requiredTubes));
    allocatedTubes += Math.max(0, integerOrZero(entry.allocatedTubes));
    remainingTubes += Math.max(0, integerOrZero(entry.remainingTubes));
  }

  return {
    requiredTubes,
    allocatedTubes,
    remainingTubes,
  };
}

function buildPublicJobUsageTimelineEntries(
  rollHistoryEntries: any[],
  boxById: Record<string, any>,
  caulkCheckouts: any[],
) {
  const response: any[] = [];
  for (const entry of Array.isArray(rollHistoryEntries) ? rollHistoryEntries : []) {
    if (!entry || !entry.boxId) {
      continue;
    }
    const usedFeet = Math.max(integerOrZero(entry.feetBefore) - integerOrZero(entry.feetAfter), 0);
    const occurredAt = asTrimmedString(entry.checkedInAt) || asTrimmedString(entry.checkedOutAt);
    if (!occurredAt) {
      continue;
    }
    const box = boxById[entry.boxId] || null;
    response.push({
      usageType: "FILM",
      occurredAt,
      actor: asTrimmedString(entry.checkedInBy) || asTrimmedString(entry.checkedOutBy),
      warehouse: box ? asTrimmedString(box.warehouse) : asTrimmedString(entry.warehouse),
      referenceId: asTrimmedString(entry.boxId),
      manufacturer: box ? asTrimmedString(box.manufacturer) : asTrimmedString(entry.manufacturer),
      itemName: box ? asTrimmedString(box.filmName) : asTrimmedString(entry.filmName),
      itemCode: "",
      unit: "LF",
      checkedOutQuantity: integerOrZero(entry.feetBefore),
      returnedQuantity: integerOrZero(entry.feetAfter),
      usedQuantity: usedFeet,
      notes: asTrimmedString(entry.notes),
    });
  }

  for (const entry of Array.isArray(caulkCheckouts) ? caulkCheckouts : []) {
    if (!entry || asTrimmedString(entry.status).toUpperCase() !== "CLOSED") {
      continue;
    }
    const occurredAt = asTrimmedString(entry.checkedInAt) || asTrimmedString(entry.checkedOutAt);
    if (!occurredAt) {
      continue;
    }
    response.push({
      usageType: "CAULK",
      occurredAt,
      actor: asTrimmedString(entry.checkedInBy) || asTrimmedString(entry.checkedOutBy),
      warehouse: asTrimmedString(entry.warehouse),
      referenceId: asTrimmedString(entry.caulkCheckoutId),
      manufacturer: asTrimmedString(entry.manufacturer),
      itemName: asTrimmedString(entry.productName),
      itemCode: asTrimmedString(entry.productCode),
      unit: "TUBES",
      checkedOutQuantity: integerOrZero(entry.checkoutTubes),
      returnedQuantity: integerOrZero(entry.unusedTubes),
      usedQuantity: integerOrZero(entry.usedTubes),
      notes: asTrimmedString(entry.notes),
    });
  }

  response.sort((left, right) => {
    if (left.occurredAt !== right.occurredAt) {
      return left.occurredAt > right.occurredAt ? -1 : 1;
    }
    return compareCatalogStrings(left.referenceId, right.referenceId);
  });
  return response;
}

function buildActiveAllocationsByBoxIndex(entries: any[]) {
  const grouped: Record<string, any[]> = {};
  for (const entry of entries) {
    if (entry.status !== "ACTIVE") {
      continue;
    }
    if (!grouped[entry.boxId]) {
      grouped[entry.boxId] = [];
    }
    grouped[entry.boxId].push(entry);
  }
  return grouped;
}

function getActiveAllocationsForBox(boxId: string, activeAllocationsByBox: Record<string, any[]>) {
  return activeAllocationsByBox && activeAllocationsByBox[boxId] ? activeAllocationsByBox[boxId] : [];
}

function normalizeAllocationKind(value: unknown): "REQUIREMENT" | "EXTRA" {
  return asTrimmedString(value).toUpperCase() === "EXTRA" ? "EXTRA" : "REQUIREMENT";
}

function shouldIgnoreAllocationCoverageForBoxStatus(allocation: any, box: any) {
  if (!box || allocation.status !== "ACTIVE") {
    return false;
  }

  return box.status === "ZEROED" || box.status === "RETIRED";
}

function compareCoveragePoolsForRequirement(left: any, right: any, requirement: any) {
  const leftMatch = getPlanningFilmMatch(
    left.manufacturer,
    left.filmName,
    requirement.manufacturer,
    requirement.filmName,
  );
  const rightMatch = getPlanningFilmMatch(
    right.manufacturer,
    right.filmName,
    requirement.manufacturer,
    requirement.filmName,
  );

  if (leftMatch && rightMatch) {
    const matchComparison = compareSharedJobPlanningFilmMatches(leftMatch, rightMatch);
    if (matchComparison !== 0) {
      return matchComparison;
    }
  }

  if (!planningFilmIsExterior(requirement.manufacturer, requirement.filmName) && left.isExterior !== right.isExterior) {
    return left.isExterior ? 1 : -1;
  }

  if (left.widthIn !== right.widthIn) {
    return left.widthIn - right.widthIn;
  }

  return left.index - right.index;
}

function allocationMatchesRequirement(box: any, requirement: any) {
  if (!box || !requirement) {
    return false;
  }

  return (
    planningFilmCanSatisfyRequirement(
      box.manufacturer,
      box.filmName,
      requirement.manufacturer,
      requirement.filmName,
    ) &&
    (Number(box.widthIn) || 0) >= (Number(requirement.widthIn) || 0)
  );
}

function getStoredAllocationCoveredFeet(allocation: any) {
  const coveredFeet = integerOrZero(allocation.coveredFeet);
  if (coveredFeet > 0) {
    return coveredFeet;
  }

  return integerOrZero(allocation.allocatedFeet);
}

function buildAllocationCoverageByRequirementId(requirements: any[], allocations: any[], boxById: Record<string, any>) {
  const grouped: Record<string, {
    requirements: Array<{
      requirementId: string;
      manufacturer: string;
      filmName: string;
      widthIn: number;
      requiredFeet: number;
      isExterior: boolean;
      specificity: number;
      index: number;
    }>;
    pools: Array<{
      manufacturer: string;
      filmName: string;
      widthIn: number;
      remainingFeet: number;
      isExterior: boolean;
      index: number;
    }>;
  }> = {};
  const coverageByRequirementId: Record<string, number> = {};
  const requirementById: Record<string, any> = {};

  for (let index = 0; index < requirements.length; index += 1) {
    const requirement = requirements[index];
    const requirementId = asTrimmedString(requirement.id) || `generated-${index}`;
    requirementById[requirementId] = requirement;
    const groupKey = getPlanningFilmManufacturerGroupKey(requirement.manufacturer, requirement.filmName);
    if (!grouped[groupKey]) {
      grouped[groupKey] = {
        requirements: [],
        pools: [],
      };
    }

    grouped[groupKey].requirements.push({
      requirementId,
      manufacturer: requirement.manufacturer,
      filmName: requirement.filmName,
      widthIn: Number(requirement.widthIn) || 0,
      requiredFeet: Math.max(0, Number(requirement.requiredFeet || 0)),
      isExterior: planningFilmIsExterior(requirement.manufacturer, requirement.filmName),
      specificity: describePlanningFilmIdentity(requirement.manufacturer, requirement.filmName).compactFamilyFilmName.length,
      index,
    });
  }

  for (let index = 0; index < allocations.length; index += 1) {
    const allocation = allocations[index];
    if (
      allocation.status === "CANCELLED" ||
      allocation.allocatedFeet <= 0 ||
      normalizeAllocationKind(allocation.allocationKind) === "EXTRA"
    ) {
      continue;
    }
    const box = boxById[allocation.boxId];
    if (!box) {
      continue;
    }
    if (shouldIgnoreAllocationCoverageForBoxStatus(allocation, box)) {
      continue;
    }

    const boundRequirementId = asTrimmedString(allocation.requirementId);
    const boundRequirement = boundRequirementId ? requirementById[boundRequirementId] : null;
    const coveredFeet = getStoredAllocationCoveredFeet(allocation);
    if (boundRequirement && allocationMatchesRequirement(box, boundRequirement)) {
      coverageByRequirementId[boundRequirementId] = Math.min(
        Math.max(0, Number(boundRequirement.requiredFeet || 0)),
        Math.max(0, Number(coverageByRequirementId[boundRequirementId] || 0)) +
          coveredFeet,
      );
      continue;
    }

    const groupKey = getPlanningFilmManufacturerGroupKey(box.manufacturer, box.filmName);
    if (!grouped[groupKey]) {
      grouped[groupKey] = {
        requirements: [],
        pools: [],
      };
    }
    grouped[groupKey].pools.push({
      manufacturer: box.manufacturer,
      filmName: box.filmName,
      widthIn: Number(box.widthIn) || 0,
      remainingFeet: coveredFeet,
      isExterior: planningFilmIsExterior(box.manufacturer, box.filmName),
      index,
    });
  }

  for (const group of Object.values(grouped)) {
    group.requirements.sort((left, right) => {
      if (left.isExterior !== right.isExterior) {
        return left.isExterior ? -1 : 1;
      }

      if (left.widthIn !== right.widthIn) {
        return right.widthIn - left.widthIn;
      }

      if (left.specificity !== right.specificity) {
        return right.specificity - left.specificity;
      }

      return left.index - right.index;
    });
    group.pools.sort((left, right) => {
      if (left.isExterior !== right.isExterior) {
        return left.isExterior ? 1 : -1;
      }

      return left.widthIn - right.widthIn;
    });

    for (const requirement of group.requirements) {
      let remainingNeed = Math.max(
        0,
        requirement.requiredFeet - Math.max(0, Number(coverageByRequirementId[requirement.requirementId] || 0)),
      );
      const compatiblePools = group.pools
        .filter(
          (pool) =>
            pool.remainingFeet > 0 &&
            pool.widthIn >= requirement.widthIn &&
            Boolean(
              getPlanningFilmMatch(
                pool.manufacturer,
                pool.filmName,
                requirement.manufacturer,
                requirement.filmName,
              )
            ),
        )
        .sort((left, right) => compareCoveragePoolsForRequirement(left, right, requirement));

      for (const pool of compatiblePools) {
        if (remainingNeed <= 0) {
          break;
        }

        const assignedFeet = Math.min(pool.remainingFeet, remainingNeed);
        pool.remainingFeet -= assignedFeet;
        remainingNeed -= assignedFeet;
      }

      coverageByRequirementId[requirement.requirementId] = Math.min(
        requirement.requiredFeet,
        requirement.requiredFeet - Math.max(0, remainingNeed),
      );
    }
  }

  return coverageByRequirementId;
}

function buildPublicJobRequirementEntries(requirements: any[], allocations: any[], boxById: Record<string, any>) {
  const coverage = buildAllocationCoverageByRequirementId(requirements, allocations, boxById);
  const response = requirements.map((requirement) => {
    const requirementId = asTrimmedString(requirement.id) || createLogId();
    const allocatedFeet = Math.max(0, Number(coverage[requirementId] || 0));
    const requiredFeet = Math.max(0, Number(requirement.requiredFeet || 0));
    const remainingFeet = Math.max(0, requiredFeet - allocatedFeet);
    return {
      requirementId,
      manufacturer: requirement.manufacturer,
      filmName: requirement.filmName,
      widthIn: requirement.widthIn,
      requiredFeet,
      allocatedFeet: requiredFeet - remainingFeet,
      remainingFeet,
    };
  });
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

function resolveAllocationJobMetadata(allocations: any[], filmOrders: any[]) {
  let jobDate = "";
  let crewLeader = "";
  for (const allocation of allocations) {
    if (!jobDate && allocation.jobDate) {
      jobDate = allocation.jobDate;
    }
    if (!crewLeader && allocation.crewLeader) {
      crewLeader = allocation.crewLeader;
    }
  }
  for (const filmOrder of filmOrders) {
    if (!jobDate && filmOrder.jobDate) {
      jobDate = filmOrder.jobDate;
    }
    if (!crewLeader && filmOrder.crewLeader) {
      crewLeader = filmOrder.crewLeader;
    }
  }
  return { jobDate, crewLeader };
}

function buildAllocationJobSummary(
  jobNumber: string,
  allocations: any[],
  filmOrders: any[],
  requirements: any[] = [],
  caulkRequirements: any[] = [],
  lifecycleStatus = "ACTIVE",
  isLaborOnly = false,
  isStagedForPickup = false,
  fallbackJobDate = "",
  fallbackCrewLeader = "",
) {
  const metadata = resolveAllocationJobMetadata(allocations, filmOrders);
  let hasFilmOrder = false;
  let hasFilmOnTheWay = false;
  let hasActiveAllocation = false;
  let hasCancelledRecord = false;
  let hasFulfilledRecord = false;
  let activeAllocatedFeet = 0;
  let fulfilledAllocatedFeet = 0;
  let openFilmOrderCount = 0;
  const distinctBoxes: Record<string, boolean> = {};
  const normalizedLifecycleStatus = normalizeJobLifecycleStatus(lifecycleStatus);
  const caulkTotals = summarizeCaulkRequirementCoverage(caulkRequirements);
  const hasMaterialRequirements =
    requirements.some((entry) => integerOrZero(entry?.requiredFeet) > 0) ||
    caulkRequirements.some((entry) => integerOrZero(entry?.requiredTubes) > 0);

  for (const allocation of allocations) {
    if (allocation.boxId) {
      distinctBoxes[allocation.boxId] = true;
    }
    if (allocation.status === "ACTIVE") {
      hasActiveAllocation = true;
      activeAllocatedFeet += getStoredAllocationCoveredFeet(allocation);
    } else if (allocation.status === "FULFILLED") {
      hasFulfilledRecord = true;
      fulfilledAllocatedFeet += getStoredAllocationCoveredFeet(allocation);
    } else if (allocation.status === "CANCELLED") {
      hasCancelledRecord = true;
    }
  }

  for (const filmOrder of filmOrders) {
    if (filmOrder.status === "FILM_ORDER") {
      hasFilmOrder = true;
      openFilmOrderCount += 1;
    } else if (filmOrder.status === "FILM_ON_THE_WAY") {
      hasFilmOnTheWay = true;
      openFilmOrderCount += 1;
    } else if (filmOrder.status === "FULFILLED") {
      hasFulfilledRecord = true;
    } else if (filmOrder.status === "CANCELLED") {
      hasCancelledRecord = true;
    }
  }

  let status = "READY";
  if (normalizedLifecycleStatus === "CANCELLED") {
    status = "CANCELLED";
  } else if (normalizedLifecycleStatus === "COMPLETED") {
    status = "COMPLETED";
  } else if (hasMaterialRequirements) {
    const hasRemainingFilm = requirements.some((entry) => Math.max(0, Number(entry.remainingFeet || 0)) > 0);
    const hasRemainingCaulk = caulkRequirements.some((entry) => Math.max(0, Number(entry.remainingTubes || 0)) > 0);
    if (hasRemainingFilm || hasRemainingCaulk) {
      status = hasFilmOrder ? "FILM_ORDER" : hasFilmOnTheWay ? "ON_ORDER" : "ALLOCATE";
    } else {
      status = "READY";
    }
  } else if (isLaborOnly || requirements.length || caulkRequirements.length) {
    status = "READY";
  } else if (hasFilmOrder) {
    status = "FILM_ORDER";
  } else if (hasFilmOnTheWay) {
    status = "ON_ORDER";
  } else if (hasActiveAllocation) {
    status = "READY";
  } else if (hasCancelledRecord) {
    status = "CANCELLED";
  } else if (hasFulfilledRecord) {
    status = "COMPLETED";
  }

  return {
    jobNumber,
    jobDate: metadata.jobDate || fallbackJobDate,
    crewLeader: metadata.crewLeader || fallbackCrewLeader,
    status,
    activeAllocatedFeet,
    fulfilledAllocatedFeet,
    requiredTubes: caulkTotals.requiredTubes,
    allocatedTubes: caulkTotals.allocatedTubes,
    remainingTubes: caulkTotals.remainingTubes,
    openFilmOrderCount,
    boxCount: Object.keys(distinctBoxes).length,
  };
}

function buildLegacyJobHeaderFromData(jobNumber: string, allocations: any[], filmOrders: any[]) {
  const metadata = resolveAllocationJobMetadata(allocations, filmOrders);
  let warehouse = "";
  let createdAt = "";
  let updatedAt = "";

  for (const allocation of allocations) {
    if (!warehouse && allocation.warehouse) {
      warehouse = allocation.warehouse;
    }
    if (!createdAt || (allocation.createdAt && allocation.createdAt < createdAt)) {
      createdAt = allocation.createdAt || createdAt;
    }
    if (!updatedAt || (allocation.createdAt && allocation.createdAt > updatedAt)) {
      updatedAt = allocation.createdAt || updatedAt;
    }
  }

  for (const filmOrder of filmOrders) {
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
    id: "",
    orgId: "",
    jobNumber,
    warehouse: warehouse || "",
    sections: null,
    dueDate: metadata.jobDate,
    crewLeader: metadata.crewLeader,
    lifecycleStatus: "ACTIVE",
    isLaborOnly: false,
    isStagedForPickup: false,
    notes: "",
    createdAt,
    createdBy: "",
    updatedAt,
    updatedBy: "",
  };
}

function deriveLegacyLifecycleStatus(allocations: any[], filmOrders: any[]) {
  const legacyStatus = buildAllocationJobSummary("", allocations || [], filmOrders || []).status;
  if (legacyStatus === "CANCELLED") {
    return "CANCELLED";
  }
  if (legacyStatus === "COMPLETED") {
    return "COMPLETED";
  }
  return "ACTIVE";
}

function resolveEffectiveJobLifecycleStatus(
  lifecycleStatus: unknown,
  allocations: any[],
  filmOrders: any[],
) {
  return normalizeJobLifecycleStatus(lifecycleStatus);
}

function deriveJobStatusFromLegacyAllocationData(allocations: any[], filmOrders: any[]) {
  const legacySummary = buildAllocationJobSummary("", allocations || [], filmOrders || []);
  if (legacySummary.status === "CANCELLED") {
    return "CANCELLED";
  }
  if (legacySummary.status === "READY" || legacySummary.status === "COMPLETED") {
    return "READY";
  }
  return "ALLOCATE";
}

function computeJobStatusFromRequirements(
  lifecycleStatus: string,
  isLaborOnly: boolean,
  isStagedForPickup: boolean,
  requirements: any[],
  caulkRequirements: any[],
  allocations: any[],
  filmOrders: any[],
) {
  const normalizedLifecycleStatus = normalizeJobLifecycleStatus(lifecycleStatus);
  if (normalizedLifecycleStatus === "CANCELLED") {
    return "CANCELLED";
  }
  if (normalizedLifecycleStatus === "COMPLETED") {
    return "COMPLETED";
  }
  const hasMaterialRequirements =
    requirements.some((entry) => integerOrZero(entry?.requiredFeet) > 0) ||
    caulkRequirements.some((entry) => integerOrZero(entry?.requiredTubes) > 0);
  if (!hasMaterialRequirements) {
    if (isLaborOnly || requirements.length || caulkRequirements.length) {
      return "READY";
    }

    if (filmOrders.some((entry) => asTrimmedString(entry.status).toUpperCase() === "FILM_ORDER")) {
      return "FILM_ORDER";
    }

    if (filmOrders.some((entry) => asTrimmedString(entry.status).toUpperCase() === "FILM_ON_THE_WAY")) {
      return "ON_ORDER";
    }

    return deriveJobStatusFromLegacyAllocationData(allocations, filmOrders);
  }
  const hasRemainingFilm = requirements.some((entry) => integerOrZero(entry.remainingFeet) > 0);
  const hasRemainingCaulk = caulkRequirements.some((entry) => integerOrZero(entry.remainingTubes) > 0);
  if (!hasRemainingFilm && !hasRemainingCaulk) {
    return "READY";
  }
  if (filmOrders.some((entry) => asTrimmedString(entry.status).toUpperCase() === "FILM_ORDER")) {
    return "FILM_ORDER";
  }
  if (filmOrders.some((entry) => asTrimmedString(entry.status).toUpperCase() === "FILM_ON_THE_WAY")) {
    return "ON_ORDER";
  }
  for (const requirement of requirements) {
    if (requirement.remainingFeet > 0) {
      return "ALLOCATE";
    }
  }
  for (const requirement of caulkRequirements) {
    if (requirement.remainingTubes > 0) {
      return "ALLOCATE";
    }
  }
  return "ALLOCATE";
}

function hasOpenFilmOrders(filmOrders: any[]) {
  return filmOrders.some((entry) => {
    const status = asTrimmedString(entry.status).toUpperCase();
    return status === "FILM_ORDER" || status === "FILM_ON_THE_WAY";
  });
}

function hasUncheckedOutFilmRequirementAllocations(allocations: any[]) {
  return allocations.some(
    (entry) =>
      asTrimmedString(entry.status).toUpperCase() === "ACTIVE" &&
      normalizeAllocationKind(entry.allocationKind) !== "EXTRA" &&
      integerOrZero(entry.allocatedFeet) > 0,
  );
}

function hasUncheckedOutCaulkAllocations(caulkAllocations: any[]) {
  return caulkAllocations.some(
    (entry) =>
      asTrimmedString(entry.status).toUpperCase() === "ACTIVE" &&
      integerOrZero(entry.allocatedTubes) > 0 &&
      integerOrZero(entry.reservedTubesRemaining) > 0,
  );
}

function getJobStagingBlockingReason(
  requirements: any[],
  caulkRequirements: any[],
  allocations: any[],
  filmOrders: any[],
  caulkAllocations: any[],
  filmTransferAlerts: any[] = [],
) {
  const hasMaterialRequirements =
    requirements.some((entry) => integerOrZero(entry.requiredFeet) > 0) ||
    caulkRequirements.some((entry) => integerOrZero(entry.requiredTubes) > 0);
  if (!hasMaterialRequirements) {
    return "";
  }
  const hasRemainingFilm = requirements.some((entry) => integerOrZero(entry.remainingFeet) > 0);
  const hasRemainingCaulk = caulkRequirements.some((entry) => integerOrZero(entry.remainingTubes) > 0);
  if (hasRemainingFilm || hasRemainingCaulk) {
    return "All required film and caulk must be fully allocated before staging this job.";
  }
  if (filmTransferAlerts.length > 0) {
    return buildFilmTransferAlertMessage(filmTransferAlerts, "staging");
  }
  if (hasUncheckedOutFilmRequirementAllocations(allocations)) {
    return "All required film must be checked out before staging this job.";
  }
  if (hasUncheckedOutCaulkAllocations(caulkAllocations)) {
    return "All required caulk must be checked out before staging this job.";
  }
  return "";
}

function buildJobListEntry(
  jobHeader: any,
  requirements: any[],
  allocations: any[],
  filmOrders: any[],
  caulkRequirements: any[] = [],
) {
  const metadata = resolveAllocationJobMetadata(allocations, filmOrders);
  let dueDate = jobHeader.dueDate;
  if (!dueDate) {
    dueDate = metadata.jobDate;
  }
  const crewLeader = asTrimmedString(jobHeader.crewLeader) || metadata.crewLeader;
  let requiredFeet = 0;
  let allocatedFeet = 0;
  let remainingFeet = 0;
  const caulkTotals = summarizeCaulkRequirementCoverage(caulkRequirements);
  for (const requirement of requirements) {
    requiredFeet += requirement.requiredFeet;
    allocatedFeet += requirement.allocatedFeet;
    remainingFeet += requirement.remainingFeet;
  }
  const effectiveLifecycleStatus =
    jobHeader && jobHeader.id
      ? resolveEffectiveJobLifecycleStatus(jobHeader.lifecycleStatus, allocations, filmOrders)
      : deriveLegacyLifecycleStatus(allocations, filmOrders);
  return {
    jobNumber: jobHeader.jobNumber,
    warehouse: jobHeader.warehouse || "",
    sections: jobHeader.sections,
    dueDate,
    crewLeader,
    isLaborOnly: Boolean(jobHeader.isLaborOnly),
    isStagedForPickup: Boolean(jobHeader.isStagedForPickup),
    status: computeJobStatusFromRequirements(
      effectiveLifecycleStatus,
      Boolean(jobHeader.isLaborOnly),
      Boolean(jobHeader.isStagedForPickup),
      requirements,
      caulkRequirements,
      allocations,
      filmOrders,
    ),
    lifecycleStatus: effectiveLifecycleStatus,
    requiredFeet,
    allocatedFeet,
    remainingFeet,
    requiredTubes: caulkTotals.requiredTubes,
    allocatedTubes: caulkTotals.allocatedTubes,
    remainingTubes: caulkTotals.remainingTubes,
    requirementCount: requirements.length,
    allocationCount: allocations.length,
    filmOrderCount: filmOrders.length,
    updatedAt: jobHeader.updatedAt || "",
    notes: jobHeader.notes || "",
  };
}

async function buildJobContextForCheckedOutBox(client: any, orgId: string, jobNumber: string) {
  const normalizedJobNumber = requireString(jobNumber, "JobNumber");
  const [header, allocations, filmOrders] = await Promise.all([
    findJobByNumber(client, orgId, normalizedJobNumber),
    listAllocationsByJob(client, orgId, normalizedJobNumber),
    listFilmOrdersByJob(client, orgId, normalizedJobNumber),
  ]);
  const metadata = resolveAllocationJobMetadata(allocations, filmOrders);
  return {
    jobNumber: normalizedJobNumber,
    crewLeader: asTrimmedString(header?.crewLeader) || metadata.crewLeader || "",
  };
}

function getCheckoutCrewConflictJobs(targetJobNumber: string, targetCrewLeader: string, allocations: any[]) {
  const normalizedTargetJobNumber = normalizeJobNumberKey(targetJobNumber);
  const normalizedTargetCrewLeader = normalizeCrewLeaderKey(targetCrewLeader);
  const conflicts: string[] = [];
  const seen: Record<string, boolean> = {};

  for (const entry of allocations) {
    if (asTrimmedString(entry.status).toUpperCase() !== "ACTIVE") {
      continue;
    }
    if (normalizeJobNumberKey(entry.jobNumber) === normalizedTargetJobNumber) {
      continue;
    }
    if (normalizeCrewLeaderKey(entry.crewLeader) === normalizedTargetCrewLeader) {
      continue;
    }
    if (!seen[entry.jobNumber]) {
      seen[entry.jobNumber] = true;
      conflicts.push(entry.jobNumber);
    }
  }

  return conflicts;
}

async function ensureBoxCheckoutCrewCompatibility(client: any, orgId: string, payload: Record<string, unknown>) {
  const status = asTrimmedString(payload.status).toUpperCase();
  if (status !== "CHECKED_OUT") {
    return;
  }

  const boxId = requireString(payload.boxId, "BoxId");
  const auditNote = asTrimmedString(payload.auditNote || payload.audit_note);
  const checkoutMatch = auditNote.match(/^Checked out for job\s+(.+)$/i);
  const jobNumber = checkoutMatch ? asTrimmedString(checkoutMatch[1]) : "";
  if (!jobNumber) {
    return;
  }

  const [boxAllocations, targetJobContext] = await Promise.all([
    listAllocationsByBox(client, orgId, boxId),
    buildJobContextForCheckedOutBox(client, orgId, jobNumber),
  ]);
  const conflicts = getCheckoutCrewConflictJobs(jobNumber, targetJobContext.crewLeader, boxAllocations);
  if (conflicts.length > 0) {
    throw new HttpError(
      400,
      `Box ${boxId} is still allocated to ${conflicts.join(", ")} with a different crew leader. Clear those allocations before checkout.`,
    );
  }
}

function buildPublicAllocationEntriesForJob(allocations: any[], boxById: Record<string, any>) {
  return allocations
    .slice()
    .sort((left, right) => {
      if (left.status !== right.status) {
        return left.status === "ACTIVE"
          ? -1
          : right.status === "ACTIVE"
          ? 1
          : left.status < right.status
          ? -1
          : 1;
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
          box.status === "CHECKED_OUT" &&
          normalizeJobNumberKey(box.lastCheckoutJob) === normalizeJobNumberKey(entry.jobNumber),
      );
      return {
        ...toPublicAllocation(entry),
        manufacturer: box ? box.manufacturer : "",
        filmName: box ? box.filmName : "",
        widthIn: box ? box.widthIn : 0,
        boxStatus: box ? box.status : "",
        checkedOutOnThisJob,
      };
    });
}

function parseCrossWarehouseFlag(value: unknown): boolean {
  return value === true || String(value).toLowerCase() === "true";
}

function normalizeOptionalWarehouse(value: unknown, fieldName = "Warehouse"): string {
  const normalized = asTrimmedString(value).toUpperCase();
  if (!normalized) {
    return "";
  }
  if (!/^[A-Z]{2}\d+$/.test(normalized)) {
    throw new HttpError(400, `${fieldName} must be a valid warehouse code.`);
  }
  return normalized;
}

function getDateConflictJobsForBox(
  boxId: string,
  jobContext: { jobNumber: string; jobDate: string; crewLeader: string },
  activeAllocationsByBox: Record<string, any[]>,
) {
  if (!jobContext.jobDate) {
    return [];
  }
  const active = getActiveAllocationsForBox(boxId, activeAllocationsByBox);
  const conflicts: string[] = [];
  const seen: Record<string, boolean> = {};
  for (const entry of active) {
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

async function buildPublicFilmOrderLinkedBoxes(client: any, orgId: string, filmOrderId: string) {
  const links = await listFilmOrderLinksByFilmOrderId(client, orgId, filmOrderId);
  const response: Array<{ boxId: string; orderedFeet: number; autoAllocatedFeet: number }> = [];
  for (const link of links) {
    const box = await findBoxById(client, orgId, asTrimmedString(link.box_id));
    if (!box) {
      continue;
    }
    response.push({
      boxId: asTrimmedString(link.box_id),
      orderedFeet: integerOrZero(link.ordered_feet),
      autoAllocatedFeet: integerOrZero(link.auto_allocated_feet),
    });
  }
  response.sort((left, right) => left.boxId < right.boxId ? -1 : left.boxId > right.boxId ? 1 : 0);
  return response;
}

function isUnresolvedFilmOrderStatus(status: unknown) {
  const normalizedStatus = asTrimmedString(status).toUpperCase();
  return normalizedStatus === "FILM_ORDER" || normalizedStatus === "FILM_ON_THE_WAY";
}

async function enrichOpenFilmOrdersWithJobSchedule(client: any, orgId: string, filmOrders: any[]) {
  const jobHeaderCache = new Map<string, any | null>();
  const response = [];

  for (const entry of filmOrders) {
    if (!entry || !isUnresolvedFilmOrderStatus(entry.status)) {
      response.push(entry);
      continue;
    }

    const needsJobDate = !asTrimmedString(entry.jobDate);
    const needsCrewLeader = !asTrimmedString(entry.crewLeader);
    if (!needsJobDate && !needsCrewLeader) {
      response.push(entry);
      continue;
    }

    const jobNumber = asTrimmedString(entry.jobNumber);
    if (!jobNumber) {
      response.push(entry);
      continue;
    }

    if (!jobHeaderCache.has(jobNumber)) {
      jobHeaderCache.set(jobNumber, (await findJobByNumber(client, orgId, jobNumber)) || null);
    }

    const jobHeader = jobHeaderCache.get(jobNumber);
    if (!jobHeader) {
      response.push(entry);
      continue;
    }

    response.push({
      ...entry,
      ...(needsJobDate && asTrimmedString(jobHeader.dueDate)
        ? { jobDate: asTrimmedString(jobHeader.dueDate) }
        : {}),
      ...(needsCrewLeader && asTrimmedString(jobHeader.crewLeader)
        ? { crewLeader: asTrimmedString(jobHeader.crewLeader) }
        : {}),
    });
  }

  return response;
}

async function buildPublicFilmOrdersForJob(client: any, orgId: string, filmOrders: any[]) {
  const response = [];
  const enrichedEntries = await enrichOpenFilmOrdersWithJobSchedule(client, orgId, filmOrders);
  const sorted = enrichedEntries.slice().sort((left, right) =>
    compareAllocationJobSummaries(
      { jobDate: left.createdAt, jobNumber: left.filmOrderId },
      { jobDate: right.createdAt, jobNumber: right.filmOrderId },
    )
  );
  for (const entry of sorted) {
    const linkedBoxes = await buildPublicFilmOrderLinkedBoxes(client, orgId, entry.filmOrderId);
    response.push(toPublicFilmOrder(entry, linkedBoxes));
  }
  return response;
}

async function resolveJobContext(client: any, orgId: string, jobNumber: unknown, jobDate: unknown, crewLeader: unknown) {
  const normalizedJobNumber = requireString(jobNumber, "JobNumber");
  const normalizedJobDate = normalizeDateString(jobDate, "JobDate", true);
  const normalizedCrewLeader = asTrimmedString(crewLeader);
  const existingHeader = await findJobByNumber(client, orgId, normalizedJobNumber);
  if (existingHeader && normalizeJobLifecycleStatus(existingHeader.lifecycleStatus) !== "ACTIVE") {
    throw new HttpError(400, `Job ${normalizedJobNumber} is closed and cannot receive allocations.`);
  }
  const existingAllocations = await listAllocationsByJob(client, orgId, normalizedJobNumber);
  const existingFilmOrders = await listFilmOrdersByJob(client, orgId, normalizedJobNumber);
  let existingJobDate = existingHeader?.dueDate || "";
  let existingCrewLeader = existingHeader?.crewLeader || "";

  for (const entry of existingAllocations) {
    if (!existingJobDate && entry.jobDate) {
      existingJobDate = entry.jobDate;
    }
    if (!existingCrewLeader && entry.crewLeader) {
      existingCrewLeader = entry.crewLeader;
    }
  }
  for (const entry of existingFilmOrders) {
    if (!existingJobDate && entry.jobDate) {
      existingJobDate = entry.jobDate;
    }
    if (!existingCrewLeader && entry.crewLeader) {
      existingCrewLeader = entry.crewLeader;
    }
  }

  if (existingJobDate && normalizedJobDate && existingJobDate !== normalizedJobDate) {
    throw new HttpError(400, "JobDate must stay the same for an existing Job Number.");
  }
  if (
    existingCrewLeader &&
    normalizedCrewLeader &&
    normalizeCrewLeaderKey(existingCrewLeader) !== normalizeCrewLeaderKey(normalizedCrewLeader)
  ) {
    throw new HttpError(400, "CrewLeader must stay the same for an existing Job Number.");
  }

  const resolvedJobDate = normalizedJobDate || existingJobDate;
  const resolvedCrewLeader = normalizedCrewLeader || existingCrewLeader;
  if (resolvedJobDate && !resolvedCrewLeader) {
    throw new HttpError(400, "CrewLeader is required when JobDate is set.");
  }

  return {
    jobNumber: normalizedJobNumber,
    jobDate: resolvedJobDate,
    crewLeader: resolvedCrewLeader,
  };
}

function buildAllocationPreviewPlan(
  sourceBox: any,
  requestedFeet: unknown,
  jobContext: { jobNumber: string; jobDate: string; crewLeader: string },
  options: {
    crossWarehouse: boolean;
    minimumWidthIn?: unknown;
    allBoxes: any[];
    activeAllocationsByBox: Record<string, any[]>;
    selectedRequirement?: any;
    jobWarehouse?: string;
  },
) {
  type CandidatePreviewEntry = {
    candidate: any;
    filmMatch: ReturnType<typeof getPlanningFilmMatch>;
  };

  const requested = coerceFeetValue(requestedFeet, "RequestedFeet", [], true);
  if (requested <= 0) {
    throw new HttpError(400, "RequestedFeet must be greater than zero.");
  }
  const selectedRequirement = options.selectedRequirement || null;
  const preferredWarehouse = asTrimmedString(options.jobWarehouse).toUpperCase();
  const requirementWidthValue = Number(selectedRequirement?.widthIn);
  const minimumWidthValue = Number(options.minimumWidthIn);
  const minimumWidthIn =
    Number.isFinite(requirementWidthValue) && requirementWidthValue > 0
      ? requirementWidthValue
      : Number.isFinite(minimumWidthValue) && minimumWidthValue > 0
        ? minimumWidthValue
        : sourceBox.widthIn;
  if (selectedRequirement && !allocationMatchesRequirement(sourceBox, selectedRequirement)) {
    throw new HttpError(
      400,
      `Box ${sourceBox.boxId} does not match requirement ${asTrimmedString(selectedRequirement.id)}.`,
    );
  }
  if (sourceBox.widthIn < minimumWidthIn) {
    throw new HttpError(400, "Source box width must meet or exceed the requested width.");
  }
  const sourceConflicts = getDateConflictJobsForBox(sourceBox.boxId, jobContext, options.activeAllocationsByBox);
  const sourcePlan = sourceConflicts.length
    ? { allocatedFeet: 0, coveredFeet: 0, remainingCoveredFeet: requested }
    : planCoverageAllocation(requested, sourceBox.feetAvailable, sourceBox.widthIn, minimumWidthIn);
  const sourceSuggestedFeet = sourcePlan.allocatedFeet;
  const sourceSuggestedCoveredFeet = sourcePlan.coveredFeet;
  let remaining = sourcePlan.remainingCoveredFeet;
  const candidateBoxes = options.crossWarehouse
    ? options.allBoxes
    : options.allBoxes.filter((box) => box.warehouse === sourceBox.warehouse);
  const filteredCandidates: CandidatePreviewEntry[] = [];
  for (const candidate of candidateBoxes) {
    if (
      candidate.boxId === sourceBox.boxId ||
      candidate.status !== "IN_STOCK" ||
      candidate.feetAvailable <= 0 ||
      candidate.widthIn < minimumWidthIn
    ) {
      continue;
    }

    let filmMatch: ReturnType<typeof getPlanningFilmMatch> = null;
    if (selectedRequirement) {
      filmMatch = getPlanningFilmMatch(
        candidate.manufacturer,
        candidate.filmName,
        selectedRequirement.manufacturer,
        selectedRequirement.filmName,
      );
      if (!filmMatch) {
        continue;
      }
      filteredCandidates.push({ candidate, filmMatch });
      continue;
    }

    if (
      normalizePlanningFilmKey(candidate.manufacturer, candidate.filmName) ===
      normalizePlanningFilmKey(sourceBox.manufacturer, sourceBox.filmName)
    ) {
      filteredCandidates.push({ candidate, filmMatch });
    }
  }
  filteredCandidates.sort((leftEntry, rightEntry) => {
    if (preferredWarehouse) {
      const leftPreferredWarehouse = asTrimmedString(leftEntry.candidate.warehouse).toUpperCase() === preferredWarehouse;
      const rightPreferredWarehouse =
        asTrimmedString(rightEntry.candidate.warehouse).toUpperCase() === preferredWarehouse;
      if (leftPreferredWarehouse !== rightPreferredWarehouse) {
        return leftPreferredWarehouse ? -1 : 1;
      }
    }

    if (selectedRequirement && leftEntry.filmMatch && rightEntry.filmMatch) {
      const filmComparison = compareSharedJobPlanningFilmMatches(leftEntry.filmMatch, rightEntry.filmMatch);
      if (filmComparison !== 0) {
        return filmComparison;
      }
    }

    const left = leftEntry.candidate;
    const right = rightEntry.candidate;
    const leftIsExactMatch = left.widthIn === minimumWidthIn;
    const rightIsExactMatch = right.widthIn === minimumWidthIn;
    if (leftIsExactMatch !== rightIsExactMatch) {
      return leftIsExactMatch ? -1 : 1;
    }

    const leftIsPreferredSplitMatch = isSplitCoveragePair(left.widthIn, minimumWidthIn);
    const rightIsPreferredSplitMatch = isSplitCoveragePair(right.widthIn, minimumWidthIn);
    if (leftIsPreferredSplitMatch !== rightIsPreferredSplitMatch) {
      return leftIsPreferredSplitMatch ? -1 : 1;
    }

    const leftWidthDelta = left.widthIn - minimumWidthIn;
    const rightWidthDelta = right.widthIn - minimumWidthIn;
    if (leftWidthDelta !== rightWidthDelta) {
      return leftWidthDelta - rightWidthDelta;
    }

    if (selectedRequirement && !planningFilmIsExterior(selectedRequirement.manufacturer, selectedRequirement.filmName)) {
      const leftIsExterior = planningFilmIsExterior(left.manufacturer, left.filmName);
      const rightIsExterior = planningFilmIsExterior(right.manufacturer, right.filmName);
      if (leftIsExterior !== rightIsExterior) {
        return leftIsExterior ? 1 : -1;
      }
    }

    return compareBoxesByOldestStock(left, right);
  });

  const suggestions: any[] = [];
  for (const entry of filteredCandidates) {
    const candidate = entry.candidate;
    const conflicts = getDateConflictJobsForBox(candidate.boxId, jobContext, options.activeAllocationsByBox);
    if (conflicts.length) {
      continue;
    }
    const candidatePlan = planCoverageAllocation(remaining, candidate.feetAvailable, candidate.widthIn, minimumWidthIn);
    suggestions.push({
      boxId: candidate.boxId,
      warehouse: candidate.warehouse,
      widthIn: candidate.widthIn,
      availableFeet: candidate.feetAvailable,
      suggestedFeet: candidatePlan.allocatedFeet,
      suggestedCoveredFeet: candidatePlan.coveredFeet,
      receivedDate: candidate.receivedDate,
      orderDate: candidate.orderDate,
    });
    if (remaining > 0) {
      remaining = candidatePlan.remainingCoveredFeet;
    }
  }

  return {
    jobNumber: jobContext.jobNumber,
    jobDate: jobContext.jobDate,
    crewLeader: jobContext.crewLeader,
    requestedFeet: requested,
    requestedWidthIn: minimumWidthIn,
    sourceBoxId: sourceBox.boxId,
    sourceWarehouse: sourceBox.warehouse,
    sourceWidthIn: sourceBox.widthIn,
    sourceBoxFeetAvailable: sourceBox.feetAvailable,
    sourceSuggestedFeet,
    sourceSuggestedCoveredFeet,
    sourceConflicts,
    suggestions,
    defaultCoveredFeet: requested - remaining,
    defaultRemainingFeet: remaining,
  };
}

function boxMatchesReportFilters(box: any, filters: any) {
  if (filters.warehouse && box.warehouse !== filters.warehouse) {
    return false;
  }
  if (
    filters.manufacturer &&
    box.manufacturer.toLowerCase().indexOf(filters.manufacturer.toLowerCase()) === -1
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

function extractClosedDate(updatedAt: unknown): string {
  const timestamp = asTrimmedString(updatedAt);
  if (!timestamp) {
    return "";
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(timestamp)) {
    return timestamp;
  }
  return timestamp.slice(0, 10);
}

function matchesClosedJobReportFilters(jobEntry: any, filters: any): boolean {
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

async function buildSearchBoxes(client: any, orgId: string, params: Record<string, unknown>) {
  const warehouse = requireString(params.warehouse, "warehouse").toUpperCase();
  const warehouseRows = await rpcOrThrow<any[]>(client, "api_acl_list_warehouses", {
    p_org_id: orgId,
  });
  const isConfiguredWarehouse = (warehouseRows || []).some((row) =>
    asTrimmedString(row.code).toUpperCase() === warehouse
  );
  if (!isConfiguredWarehouse) {
    throw new HttpError(400, "warehouse is not configured.");
  }
  const manufacturerFilterKey = normalizeCatalogManufacturerLookupKey(params.manufacturer);
  const query = asTrimmedString(params.q).toLowerCase();
  const status = asTrimmedString(params.status).toUpperCase();
  const film = asTrimmedString(params.film).toLowerCase();
  const width = asTrimmedString(params.width);
  const showRetired = String(params.showRetired) === "true";
  const boxes = (await listBoxes(client, orgId)).filter((box) => box.warehouse === warehouse);
  let filtered = boxes.filter((box) => {
    if (!showRetired && !status && (box.status === "ZEROED" || box.status === "RETIRED")) {
      return false;
    }
    if (status && box.status !== status) {
      return false;
    }
    if (
      manufacturerFilterKey &&
      normalizeCatalogManufacturerLookupKey(box.manufacturer).indexOf(manufacturerFilterKey) === -1
    ) {
      return false;
    }
    if (width && String(box.widthIn) !== width) {
      return false;
    }
    if (
      film &&
      box.filmName.toLowerCase().indexOf(film) === -1 &&
      box.manufacturer.toLowerCase().indexOf(film) === -1 &&
      box.filmKey.toLowerCase().indexOf(film) === -1
    ) {
      return false;
    }
    if (query && !matchesBoxSearchQuery(box, query)) {
      return false;
    }
    return true;
  }).map(toPublicBox);

  if (film) {
    const lowStock = filtered.filter((box) =>
      box.status === "IN_STOCK" && box.feetAvailable > 0 && box.feetAvailable < 10
    );
    const remaining = filtered.filter((box) => !lowStock.includes(box));
    lowStock.sort((left, right) =>
      left.feetAvailable !== right.feetAvailable
        ? left.feetAvailable - right.feetAvailable
        : left.boxId < right.boxId
        ? -1
        : left.boxId > right.boxId
        ? 1
        : 0
    );
    filtered = lowStock.concat(remaining);
  }

  if (query) {
    filtered = rankBoxSearchCandidates(filtered, query);
  }

  return filtered;
}

async function buildAllocationJobList(client: any, orgId: string) {
  const jobs = await listJobs(client, orgId);
  const allAllocations = await listAllocations(client, orgId);
  const allFilmOrders = await listFilmOrders(client, orgId);
  const allRequirements = await listJobRequirements(client, orgId);
  const allBoxes = await listBoxes(client, orgId);
  const groupedAllocations: Record<string, any[]> = {};
  const groupedFilmOrders: Record<string, any[]> = {};
  const groupedRequirements: Record<string, any[]> = {};
  const jobNumbers: Record<string, boolean> = {};
  const jobHeadersByNumber: Record<string, any> = {};
  const boxById = Object.fromEntries(allBoxes.map((box) => [box.boxId, box]));

  for (const job of jobs) {
    if (asTrimmedString(job.jobNumber)) {
      jobNumbers[job.jobNumber] = true;
      jobHeadersByNumber[job.jobNumber] = job;
    }
  }

  for (const allocation of allAllocations) {
    if (allocation.jobNumber) {
      jobNumbers[allocation.jobNumber] = true;
      if (!groupedAllocations[allocation.jobNumber]) {
        groupedAllocations[allocation.jobNumber] = [];
      }
      groupedAllocations[allocation.jobNumber].push(allocation);
    }
  }

  for (const filmOrder of allFilmOrders) {
    if (filmOrder.jobNumber) {
      jobNumbers[filmOrder.jobNumber] = true;
      if (!groupedFilmOrders[filmOrder.jobNumber]) {
        groupedFilmOrders[filmOrder.jobNumber] = [];
      }
      groupedFilmOrders[filmOrder.jobNumber].push(filmOrder);
    }
  }
  for (const requirement of allRequirements) {
    if (!groupedRequirements[requirement.jobNumber]) {
      groupedRequirements[requirement.jobNumber] = [];
    }
    groupedRequirements[requirement.jobNumber].push(requirement);
  }
  const caulkPlanning = await loadCaulkPlanningByJobNumbers(client, orgId, Object.keys(jobNumbers));

  const response = Object.keys(jobNumbers)
    .map((jobNumber) => {
      const allocations = groupedAllocations[jobNumber] || [];
      const filmOrders = groupedFilmOrders[jobNumber] || [];
      const requirements = buildPublicJobRequirementEntries(
        groupedRequirements[jobNumber] || [],
        allocations,
        boxById,
      );
      const publicCaulkRequirements = caulkPlanning.requirementsByJob[jobNumber] || [];
      const header = jobHeadersByNumber[jobNumber];

      if (!allocations.length && !filmOrders.length && !requirements.length && !publicCaulkRequirements.length) {
        return null;
      }

      return buildAllocationJobSummary(
        jobNumber,
        allocations,
        filmOrders,
        requirements,
        publicCaulkRequirements,
        header?.lifecycleStatus || "ACTIVE",
        Boolean(header?.isLaborOnly),
        Boolean(header?.isStagedForPickup),
        header?.dueDate || "",
        header?.crewLeader || "",
      );
    })
    .filter((entry): entry is any => Boolean(entry));
  response.sort(compareAllocationJobSummaries);
  return response;
}

async function buildAllocationJobDetail(client: any, orgId: string, jobNumber: unknown) {
  const normalizedJobNumber = requireString(jobNumber, "jobNumber");
  const header = await findJobByNumber(client, orgId, normalizedJobNumber);
  const allocations = await listAllocationsByJob(client, orgId, normalizedJobNumber);
  const filmOrders = await listFilmOrdersByJob(client, orgId, normalizedJobNumber);
  const caulkRequirements = await listJobCaulkRequirementsByJob(client, orgId, normalizedJobNumber);
  const caulkAllocations = await listCaulkJobAllocationsByJob(client, orgId, normalizedJobNumber);
  const caulkCheckouts = await listCaulkJobCheckoutsByJob(client, orgId, normalizedJobNumber);
  const rollHistory = await listRollHistoryByJob(client, orgId, normalizedJobNumber, allocations);
  if (!header && !allocations.length && !filmOrders.length && !caulkRequirements.length && !caulkAllocations.length) {
    throw new HttpError(404, "Job not found.");
  }
  const boxes = await listBoxes(client, orgId);
  const boxById = Object.fromEntries(boxes.map((box) => [box.boxId, box]));
  const pendingTransfersByBoxRecordId = indexPendingBoxTransfersByBoxRecordId(
    await listPendingBoxTransfersByBoxRecordIds(
      client,
      orgId,
      boxes.map((box) => box.id).filter(Boolean),
    ),
  );
  const publicCaulkRequirements = buildPublicCaulkRequirementEntries(caulkRequirements, caulkAllocations);
  const publicRequirements = header
    ? buildPublicJobRequirementEntries(await listJobRequirementsByJob(client, orgId, normalizedJobNumber), allocations, boxById)
    : [];
  const filmTransferAlerts = buildJobFilmTransferAlerts(
    header?.warehouse || "",
    allocations,
    boxById,
    pendingTransfersByBoxRecordId,
  );
  return {
    summary: buildAllocationJobSummary(
      normalizedJobNumber,
      allocations,
      filmOrders,
      publicRequirements,
      publicCaulkRequirements,
      header?.lifecycleStatus || "ACTIVE",
      Boolean(header?.isLaborOnly),
      Boolean(header?.isStagedForPickup),
      header?.dueDate || "",
      header?.crewLeader || "",
    ),
    allocations: buildPublicAllocationEntriesForJob(allocations, boxById),
    usage: buildPublicJobUsageEntries(rollHistory, boxById),
    usageTimeline: buildPublicJobUsageTimelineEntries(rollHistory, boxById, caulkCheckouts),
    caulkRequirements: publicCaulkRequirements,
    caulkAllocations: caulkAllocations,
    caulkCheckouts: caulkCheckouts,
    filmOrders: await buildPublicFilmOrdersForJob(client, orgId, filmOrders),
    filmTransferAlerts,
  };
}

async function loadCaulkPlanningByJobNumbers(client: any, orgId: string, jobNumbers: string[]) {
  const requirementsByJob: Record<string, any[]> = {};
  const allocationsByJob: Record<string, any[]> = {};
  const normalizedJobNumbers = Array.from(new Set(jobNumbers.filter((entry) => asTrimmedString(entry))));

  await Promise.all(
    normalizedJobNumbers.map(async (jobNumber) => {
      const [caulkRequirements, caulkAllocations] = await Promise.all([
        listJobCaulkRequirementsByJob(client, orgId, jobNumber),
        listCaulkJobAllocationsByJob(client, orgId, jobNumber),
      ]);
      requirementsByJob[jobNumber] = buildPublicCaulkRequirementEntries(caulkRequirements, caulkAllocations);
      allocationsByJob[jobNumber] = caulkAllocations;
    }),
  );

  return {
    requirementsByJob,
    allocationsByJob,
  };
}

async function buildJobsList(client: any, orgId: string, limit: number, lifecycleStatus?: unknown) {
  const lifecycleFilter = normalizeJobLifecycleFilter(lifecycleStatus);
  const jobs = await listJobs(client, orgId);
  const allAllocations = await listAllocations(client, orgId);
  const allFilmOrders = await listFilmOrders(client, orgId);
  const allRequirements = await listJobRequirements(client, orgId);
  const allBoxes = await listBoxes(client, orgId);
  const groupedAllocations: Record<string, any[]> = {};
  const groupedFilmOrders: Record<string, any[]> = {};
  const groupedRequirements: Record<string, any[]> = {};
  const byJobNumber: Record<string, any> = {};
  const boxById = Object.fromEntries(allBoxes.map((box) => [box.boxId, box]));

  for (const job of jobs) {
    byJobNumber[job.jobNumber] = job;
  }
  for (const allocation of allAllocations) {
    if (allocation.jobNumber) {
      byJobNumber[allocation.jobNumber] = byJobNumber[allocation.jobNumber] || null;
      if (!groupedAllocations[allocation.jobNumber]) {
        groupedAllocations[allocation.jobNumber] = [];
      }
      groupedAllocations[allocation.jobNumber].push(allocation);
    }
  }
  for (const filmOrder of allFilmOrders) {
    if (filmOrder.jobNumber) {
      byJobNumber[filmOrder.jobNumber] = byJobNumber[filmOrder.jobNumber] || null;
      if (!groupedFilmOrders[filmOrder.jobNumber]) {
        groupedFilmOrders[filmOrder.jobNumber] = [];
      }
      groupedFilmOrders[filmOrder.jobNumber].push(filmOrder);
    }
  }
  for (const requirement of allRequirements) {
    if (!groupedRequirements[requirement.jobNumber]) {
      groupedRequirements[requirement.jobNumber] = [];
    }
    groupedRequirements[requirement.jobNumber].push(requirement);
  }
  const caulkPlanning = await loadCaulkPlanningByJobNumbers(client, orgId, Object.keys(byJobNumber));

  const response = Object.keys(byJobNumber).reduce<any[]>((entries, jobNumber) => {
    const allocations = groupedAllocations[jobNumber] || [];
    const filmOrders = groupedFilmOrders[jobNumber] || [];
    const requirements = buildPublicJobRequirementEntries(
      groupedRequirements[jobNumber] || [],
      allocations,
      boxById,
    );
    const publicCaulkRequirements = caulkPlanning.requirementsByJob[jobNumber] || [];
    const header = byJobNumber[jobNumber] || buildLegacyJobHeaderFromData(jobNumber, allocations, filmOrders);
    const entry = buildJobListEntry(header, requirements, allocations, filmOrders, publicCaulkRequirements);
    if (lifecycleFilter && entry.lifecycleStatus !== lifecycleFilter) {
      return entries;
    }
    if (lifecycleFilter === "COMPLETED" && entry.status !== "COMPLETED") {
      return entries;
    }
    entries.push(entry);
    return entries;
  }, []);

  response.sort(compareJobsListEntries);
  return limit > 0 && response.length > limit ? response.slice(0, limit) : response;
}

async function buildJobsSearchResults(
  client: any,
  orgId: string,
  query: unknown,
  limit: number,
  lifecycleStatus?: unknown
) {
  const normalizedQueryDigits = normalizeJobNumberDigits(query);
  if (!normalizedQueryDigits) {
    return [];
  }

  const lifecycleFilter = normalizeJobLifecycleFilter(lifecycleStatus) || "ACTIVE";
  const normalizedLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 25;
  const entries = await buildJobsList(client, orgId, 0, lifecycleFilter);
  return rankJobNumberSearchCandidates(entries, normalizedQueryDigits, {
    compareWithinMatch: compareJobsListEntries,
    limit: normalizedLimit,
  });
}

async function buildJobsCalendar(
  client: any,
  orgId: string,
  view: unknown,
  anchorDate: unknown,
  month: unknown,
  lifecycleStatus?: unknown
) {
  const normalizedView = normalizeCalendarView(view);
  const normalizedAnchorDate = normalizeCalendarAnchorDate(anchorDate, month);
  const lifecycleFilter = normalizeJobLifecycleFilter(lifecycleStatus) || "ACTIVE";
  const entries = await buildJobsList(client, orgId, 0, lifecycleFilter);
  if (normalizedView === "week") {
    const weekStart = getCalendarWeekStart(normalizedAnchorDate);
    const weekEnd = shiftCalendarDate(weekStart, 6);
    return entries.filter((entry) => {
      const dueDate = asTrimmedString((entry as Record<string, unknown>).dueDate);
      return /^\d{4}-\d{2}-\d{2}$/.test(dueDate) && dueDate >= weekStart && dueDate <= weekEnd;
    });
  }

  const normalizedMonth = normalizedAnchorDate.slice(0, 7);
  return entries.filter((entry) => asTrimmedString((entry as Record<string, unknown>).dueDate).slice(0, 7) === normalizedMonth);
}

async function buildJobDetail(client: any, orgId: string, jobNumber: unknown) {
  const normalizedJobNumber = requireString(jobNumber, "jobNumber");
  let header = await findJobByNumber(client, orgId, normalizedJobNumber);
  const allocations = await listAllocationsByJob(client, orgId, normalizedJobNumber);
  const filmOrders = await listFilmOrdersByJob(client, orgId, normalizedJobNumber);
  const requirements = await listJobRequirementsByJob(client, orgId, normalizedJobNumber);
  const caulkRequirements = await listJobCaulkRequirementsByJob(client, orgId, normalizedJobNumber);
  const caulkAllocations = await listCaulkJobAllocationsByJob(client, orgId, normalizedJobNumber);
  const caulkCheckouts = await listCaulkJobCheckoutsByJob(client, orgId, normalizedJobNumber);
  const rollHistory = await listRollHistoryByJob(client, orgId, normalizedJobNumber, allocations);

  if (
    !header &&
    !allocations.length &&
    !filmOrders.length &&
    !requirements.length &&
    !caulkRequirements.length &&
    !caulkAllocations.length
  ) {
    throw new HttpError(404, "Job not found.");
  }
  if (!header) {
    header = buildLegacyJobHeaderFromData(normalizedJobNumber, allocations, filmOrders);
  }
  const boxes = await listBoxes(client, orgId);
  const boxById = Object.fromEntries(boxes.map((box) => [box.boxId, box]));
  const pendingTransfersByBoxRecordId = indexPendingBoxTransfersByBoxRecordId(
    await listPendingBoxTransfersByBoxRecordIds(
      client,
      orgId,
      boxes.map((box) => box.id).filter(Boolean),
    ),
  );
  const publicRequirements = buildPublicJobRequirementEntries(requirements, allocations, boxById);
  const publicCaulkRequirements = buildPublicCaulkRequirementEntries(caulkRequirements, caulkAllocations);
  const filmTransferAlerts = buildJobFilmTransferAlerts(
    header?.warehouse || "",
    allocations,
    boxById,
    pendingTransfersByBoxRecordId,
  );
  return {
    summary: buildJobListEntry(header, publicRequirements, allocations, filmOrders, publicCaulkRequirements),
    requirements: publicRequirements,
    allocations: buildPublicAllocationEntriesForJob(allocations, boxById),
    usage: buildPublicJobUsageEntries(rollHistory, boxById),
    usageTimeline: buildPublicJobUsageTimelineEntries(rollHistory, boxById, caulkCheckouts),
    caulkRequirements: publicCaulkRequirements,
    caulkAllocations: caulkAllocations,
    caulkCheckouts: caulkCheckouts,
    filmOrders: await buildPublicFilmOrdersForJob(client, orgId, filmOrders),
    filmTransferAlerts,
  };
}

async function buildReportsSummary(client: any, orgId: string, params: Record<string, unknown>) {
  const filters = {
    warehouse: asTrimmedString(params.warehouse).toUpperCase(),
    manufacturer: asTrimmedString(params.manufacturer),
    film: asTrimmedString(params.film),
    width: asTrimmedString(params.width),
    from: asTrimmedString(params.from),
    to: asTrimmedString(params.to),
  };
  const allBoxes = await listBoxes(client, orgId);
  const activeBoxes = allBoxes.filter((box) => box.status !== "ZEROED" && box.status !== "RETIRED");
  const widthGroups: Record<string, { widthIn: number; totalFeetAvailable: number; boxCount: number }> = {};
  const neverCheckedOut: any[] = [];
  const zeroedByMonthMap: Record<string, number> = {};
  const zeroedBoxes: any[] = [];
  const completedJobs: any[] = [];
  const cancelledJobs: any[] = [];

  for (const activeBox of activeBoxes) {
    if (!boxMatchesReportFilters(activeBox, filters)) {
      continue;
    }
    const widthKey = String(activeBox.widthIn);
    if (!widthGroups[widthKey]) {
      widthGroups[widthKey] = {
        widthIn: activeBox.widthIn,
        totalFeetAvailable: 0,
        boxCount: 0,
      };
    }
    widthGroups[widthKey].totalFeetAvailable += activeBox.feetAvailable;
    widthGroups[widthKey].boxCount += 1;
  }

  for (const box of allBoxes) {
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
        feetAvailable: box.feetAvailable,
      });
    }
    if (box.status === "ZEROED" && box.zeroedDate) {
      if (filters.from && box.zeroedDate < filters.from) {
        continue;
      }
      if (filters.to && box.zeroedDate > filters.to) {
        continue;
      }
      zeroedBoxes.push({
        boxId: box.boxId,
        warehouse: box.warehouse,
        manufacturer: box.manufacturer,
        filmName: box.filmName,
        widthIn: box.widthIn,
        zeroedDate: box.zeroedDate,
      });
      const monthKey = box.zeroedDate.slice(0, 7);
      zeroedByMonthMap[monthKey] = (zeroedByMonthMap[monthKey] || 0) + 1;
    }
  }

  neverCheckedOut.sort((left, right) =>
    left.receivedDate !== right.receivedDate
      ? left.receivedDate < right.receivedDate
        ? -1
        : 1
      : left.boxId < right.boxId
      ? -1
      : left.boxId > right.boxId
      ? 1
      : 0
  );

  const availableFeetByWidth = Object.values(widthGroups).sort((left, right) => left.widthIn - right.widthIn);
  const zeroedByMonth = Object.keys(zeroedByMonthMap)
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
    .map((month) => ({ month, zeroedCount: zeroedByMonthMap[month] }));
  zeroedBoxes.sort((left, right) => {
    if (left.zeroedDate !== right.zeroedDate) {
      return left.zeroedDate > right.zeroedDate ? -1 : 1;
    }
    return left.boxId < right.boxId ? -1 : left.boxId > right.boxId ? 1 : 0;
  });

  const allJobEntries = await buildJobsList(client, orgId, 0);
  for (const jobEntry of allJobEntries) {
    const lifecycleStatus = normalizeJobLifecycleStatus(jobEntry.lifecycleStatus);
    if (lifecycleStatus !== "COMPLETED" && lifecycleStatus !== "CANCELLED") {
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
      closedAt: asTrimmedString(jobEntry.updatedAt),
    };

    if (lifecycleStatus === "COMPLETED") {
      completedJobs.push(reportEntry);
    } else {
      cancelledJobs.push(reportEntry);
    }
  }

  const compareClosedJobs = (left: any, right: any) => {
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
    zeroedBoxes,
    completedJobs,
    cancelledJobs,
  };
}

async function buildOwnerAssetTotalCost(client: any, orgId: string, params: Record<string, unknown>) {
  const warehouseFilter = asTrimmedString(params.warehouse).toUpperCase();
  const boxes = await listBoxes(client, orgId);

  let includedBoxCount = 0;
  let includedFeet = 0;
  let pricedBoxCount = 0;
  let pricedFeet = 0;
  let unpricedBoxCount = 0;
  let unpricedFeet = 0;
  let totalAssetCost = 0;

  for (const box of boxes) {
    const status = asTrimmedString(box.status).toUpperCase();
    const warehouse = asTrimmedString(box.warehouse).toUpperCase();
    const feetAvailable = Math.max(0, integerOrZero(box.feetAvailable));
    const pricePerLf = numericOrNull(box.pricePerLf);

    if (warehouseFilter && warehouse !== warehouseFilter) {
      continue;
    }
    if (status === "ZEROED" || status === "RETIRED") {
      continue;
    }
    if (feetAvailable <= 0) {
      continue;
    }

    includedBoxCount += 1;
    includedFeet += feetAvailable;

    if (pricePerLf === null || pricePerLf < 0) {
      unpricedBoxCount += 1;
      unpricedFeet += feetAvailable;
      continue;
    }

    pricedBoxCount += 1;
    pricedFeet += feetAvailable;
    totalAssetCost += feetAvailable * pricePerLf;
  }

  return {
    warehouse: warehouseFilter,
    includedBoxCount,
    includedFeet,
    pricedBoxCount,
    pricedFeet,
    unpricedBoxCount,
    unpricedFeet,
    coveragePercentByFeet:
      includedFeet > 0 ? roundToDecimals(pricedFeet / includedFeet, 6) : 0,
    totalAssetCost: roundToDecimals(totalAssetCost, 2),
  };
}

async function listAudit(client: any, orgId: string, params: Record<string, unknown>) {
  const from = asTrimmedString(params.from);
  const to = asTrimmedString(params.to);
  const user = asTrimmedString(params.user).toLowerCase();
  const action = asTrimmedString(params.action).toLowerCase();
  const entries = await listAuditEntries(client, orgId);
  return entries.filter((entry) => {
    const entryDate = entry.date.slice(0, 10);
    if (from && entryDate < from) {
      return false;
    }
    if (to && entryDate > to) {
      return false;
    }
    if (user && entry.user.toLowerCase().indexOf(user) === -1) {
      return false;
    }
    if (action && entry.action.toLowerCase().indexOf(action) === -1) {
      return false;
    }
    return true;
  });
}

async function buildFilmOrdersList(client: any, orgId: string) {
  const entries = await enrichOpenFilmOrdersWithJobSchedule(client, orgId, await listFilmOrders(client, orgId));
  const sorted = entries.slice().sort((left, right) => {
    const leftOpen = isUnresolvedFilmOrderStatus(left.status);
    const rightOpen = isUnresolvedFilmOrderStatus(right.status);
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
  for (const entry of sorted) {
    response.push(
      toPublicFilmOrder(entry, await buildPublicFilmOrderLinkedBoxes(client, orgId, entry.filmOrderId)),
    );
  }
  return response;
}

async function buildFilmCatalog(client: any, orgId: string) {
  const entries = await listFilmCatalog(client, orgId);
  const dedupedByKey: Record<string, any> = {};
  for (const entry of entries) {
    const canonical = normalizeCanonicalManufacturerAndFilm(entry.manufacturer, entry.filmName);
    const manufacturer = normalizeCollapsedCatalogLabel(canonical.manufacturer);
    const filmName = normalizeCollapsedCatalogLabel(canonical.filmName);
    const manufacturerKey = normalizeCatalogLookupKey(manufacturer);
    const filmNameKey = normalizeCatalogLookupKey(filmName);
    if (!manufacturerKey || !filmNameKey) {
      continue;
    }
    dedupedByKey[`${manufacturerKey}|${filmNameKey}`] = {
      filmKey: buildFilmKey(manufacturer, filmName),
      manufacturer,
      filmName,
      updatedAt: asTrimmedString(entry.updatedAt),
    };
  }
  const response = Object.values(dedupedByKey);
  response.sort((left: any, right: any) => {
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

function throwOnSupabaseError(error: any, messagePrefix: string): void {
  if (!error) {
    return;
  }
  throw new HttpError(500, `${messagePrefix}: ${asTrimmedString(error.message) || "Unexpected database error."}`);
}

function requireServiceRoleClient() {
  const serviceClient = createServiceRoleClient();
  if (!serviceClient) {
    throw new HttpError(500, "SUPABASE_SERVICE_ROLE_KEY is required for this inventory mutation.");
  }
  return serviceClient;
}

function requireServiceRoleClientForJobs() {
  return requireServiceRoleClient();
}

async function checkoutAllJobMaterials(client: any, identity: AuthIdentity, payload: Record<string, unknown>) {
  const warnings: string[] = [];
  const orgId = identity.orgId;
  const actor = identity.actor;
  const jobNumber = requireString(payload.jobNumber, "JobNumber");
  const serviceClient = requireServiceRoleClientForJobs();
  const { data: jobRow, error: jobError } = await serviceClient
    .schema("app")
    .from("jobs")
    .select("id, lifecycle_status, warehouse")
    .eq("org_id", orgId)
    .eq("job_number", jobNumber)
    .maybeSingle();
  throwOnSupabaseError(jobError, "Unable to load job");
  if (!jobRow) {
    throw new HttpError(404, `Job ${jobNumber} was not found.`);
  }

  const lifecycleStatus = normalizeJobLifecycleStatus((jobRow as Record<string, unknown>).lifecycle_status);
  if (lifecycleStatus !== "ACTIVE") {
    throw new HttpError(400, `Job ${jobNumber} is closed and checkout-all cannot be changed.`);
  }

  const [allocations, filmOrders, requirements, caulkRequirements, caulkAllocations, boxes] = await Promise.all([
    listAllocationsByJob(client, orgId, jobNumber),
    listFilmOrdersByJob(client, orgId, jobNumber),
    listJobRequirementsByJob(client, orgId, jobNumber),
    listJobCaulkRequirementsByJob(client, orgId, jobNumber),
    listCaulkJobAllocationsByJob(client, orgId, jobNumber),
    listBoxes(client, orgId)
  ]);
  const boxById = Object.fromEntries(boxes.map((box) => [box.boxId, box]));
  const pendingTransfersByBoxRecordId = indexPendingBoxTransfersByBoxRecordId(
    await listPendingBoxTransfersByBoxRecordIds(
      client,
      orgId,
      boxes.map((box) => box.id).filter(Boolean),
    ),
  );
  const preCheckoutTransferAlerts = buildJobFilmTransferAlerts(
    asTrimmedString((jobRow as Record<string, unknown>).warehouse),
    allocations,
    boxById,
    pendingTransfersByBoxRecordId,
  );
  if (preCheckoutTransferAlerts.length > 0) {
    throw new HttpError(400, buildFilmTransferAlertMessage(preCheckoutTransferAlerts, "checkout"));
  }
  const seenBoxIds: Record<string, boolean> = {};
  let checkedOutBoxCount = 0;
  let checkedOutCaulkCount = 0;

  for (const allocation of allocations) {
    if (allocation.status !== "ACTIVE" || !allocation.boxId || seenBoxIds[allocation.boxId]) {
      continue;
    }
    seenBoxIds[allocation.boxId] = true;
    const box = boxById[allocation.boxId];
    if (!box) {
      throw new HttpError(404, `Box ${allocation.boxId} was not found.`);
    }

    const normalizedBoxStatus = asTrimmedString(box.status).toUpperCase();
    const sameJobCheckedOut =
      normalizedBoxStatus === "CHECKED_OUT" &&
      normalizeJobNumberKey(box.lastCheckoutJob) === normalizeJobNumberKey(jobNumber);

    if (!sameJobCheckedOut && normalizedBoxStatus !== "IN_STOCK") {
      throw new HttpError(
        400,
        `Box ${box.boxId} is ${normalizedBoxStatus || "not in stock"} and cannot be checked out from this view.`,
      );
    }

    if (sameJobCheckedOut) {
      continue;
    }

    const { data: checkoutResult, error: checkoutError } = await serviceClient.rpc("api_acl_boxes_set_status", {
      p_org_id: orgId,
      p_actor: actor,
      p_payload: {
        boxId: box.boxId,
        status: "CHECKED_OUT",
        auditNote: `Checked out for job ${jobNumber}`,
      },
    });
    throwOnSupabaseError(checkoutError, `Unable to check out box ${box.boxId}`);
    if (checkoutResult && Array.isArray((checkoutResult as Record<string, unknown>).warnings)) {
      warnings.push(...((checkoutResult as Record<string, unknown>).warnings as unknown[]).map((entry) => asTrimmedString(entry)).filter(Boolean));
    }
    checkedOutBoxCount += 1;
  }

  for (const allocation of caulkAllocations) {
    if (allocation.status !== "ACTIVE") {
      continue;
    }

    const remaining = integerOrZero(allocation.reservedTubesRemaining);
    const openCount = integerOrZero(allocation.openCheckoutCount);
    if (remaining <= 0) {
      continue;
    }

    if (openCount > 0) {
      throw new HttpError(
        400,
        `Caulk allocation ${allocation.caulkAllocationId} already has an open checkout and cannot be bulk checked out again until that cycle is closed.`,
      );
    }

    const result = await rpcOrThrow<any>(client, "api_acl_allocations_caulk_checkout", {
      p_org_id: orgId,
      p_actor: actor,
      p_payload: {
        caulkAllocationId: allocation.caulkAllocationId,
        checkoutTubes: remaining,
        notes: `Checked out all remaining caulk for job ${jobNumber}.`,
      },
    });
    if (result) {
      if (Array.isArray((result as Record<string, unknown>).warnings)) {
        warnings.push(...((result as Record<string, unknown>).warnings as unknown[]).map((entry) => asTrimmedString(entry)).filter(Boolean));
      }
      checkedOutCaulkCount += 1;
    }
  }

  const refreshedAllocations = await listAllocationsByJob(client, orgId, jobNumber);
  const refreshedFilmOrders = await listFilmOrdersByJob(client, orgId, jobNumber);
  const refreshedRequirements = await listJobRequirementsByJob(client, orgId, jobNumber);
  const refreshedCaulkRequirements = await listJobCaulkRequirementsByJob(client, orgId, jobNumber);
  const refreshedCaulkAllocations = await listCaulkJobAllocationsByJob(client, orgId, jobNumber);
  const refreshedBoxes = await listBoxes(client, orgId);
  const refreshedBoxById = Object.fromEntries(refreshedBoxes.map((box) => [box.boxId, box]));
  const refreshedPendingTransfersByBoxRecordId = indexPendingBoxTransfersByBoxRecordId(
    await listPendingBoxTransfersByBoxRecordIds(
      client,
      orgId,
      refreshedBoxes.map((box) => box.id).filter(Boolean),
    ),
  );
  const publicRequirements = buildPublicJobRequirementEntries(
    refreshedRequirements,
    refreshedAllocations,
    refreshedBoxById,
  );
  const publicCaulkRequirements = buildPublicCaulkRequirementEntries(
    refreshedCaulkRequirements,
    refreshedCaulkAllocations,
  );
  const blockingReason = getJobStagingBlockingReason(
    publicRequirements,
    publicCaulkRequirements,
    refreshedAllocations,
    refreshedFilmOrders,
    refreshedCaulkAllocations,
    buildJobFilmTransferAlerts(
      asTrimmedString((jobRow as Record<string, unknown>).warehouse),
      refreshedAllocations,
      refreshedBoxById,
      refreshedPendingTransfersByBoxRecordId,
    ),
  );
  if (blockingReason) {
    throw new HttpError(400, blockingReason);
  }

  if (checkedOutBoxCount > 0 || checkedOutCaulkCount > 0) {
    warnings.push(
      `Checked out ${checkedOutBoxCount} film box${checkedOutBoxCount === 1 ? "" : "es"} and ${checkedOutCaulkCount} caulk allocation${checkedOutCaulkCount === 1 ? "" : "s"} for job ${jobNumber}.`,
    );
  }

  return ok(await buildJobDetail(client, orgId, jobNumber), warnings);
}

async function setJobStagedPickup(client: any, identity: AuthIdentity, payload: Record<string, unknown>) {
  const orgId = identity.orgId;
  const actor = identity.actor;
  const jobNumber = requireString(payload.jobNumber, "JobNumber");
  const normalizedFlag = typeof payload.isStagedForPickup === "boolean"
    ? String(payload.isStagedForPickup)
    : asTrimmedString(payload.isStagedForPickup).toLowerCase();
  let nextIsStaged: boolean | null = null;

  if (["true", "t", "1", "yes", "on"].includes(normalizedFlag)) {
    nextIsStaged = true;
  } else if (["false", "f", "0", "no", "off"].includes(normalizedFlag)) {
    nextIsStaged = false;
  }

  if (nextIsStaged === null) {
    throw new HttpError(400, "isStagedForPickup must be true or false.");
  }

  const serviceClient = requireServiceRoleClientForJobs();
  const { data: jobRow, error: jobError } = await serviceClient
    .schema("app")
    .from("jobs")
    .select("id, lifecycle_status, warehouse")
    .eq("org_id", orgId)
    .eq("job_number", jobNumber)
    .maybeSingle();
  throwOnSupabaseError(jobError, "Unable to load job");
  if (!jobRow) {
    throw new HttpError(404, `Job ${jobNumber} was not found.`);
  }

  const lifecycleStatus = normalizeJobLifecycleStatus((jobRow as Record<string, unknown>).lifecycle_status);
  if (lifecycleStatus !== "ACTIVE") {
    throw new HttpError(400, `Job ${jobNumber} is closed and staged pickup cannot be changed.`);
  }

  const warnings: string[] = [];
  if (nextIsStaged) {
    const autoCheckoutRemaining =
      payload.autoCheckoutRemaining === true || asTrimmedString(payload.autoCheckoutRemaining).toLowerCase() === "true";

    if (autoCheckoutRemaining) {
      const checkoutResult = await checkoutAllJobMaterials(client, identity, payload);
      warnings.push(...(checkoutResult.warnings || []));
    }

    const [allocations, filmOrders, requirements, caulkRequirements, caulkAllocations] = await Promise.all([
      listAllocationsByJob(client, orgId, jobNumber),
      listFilmOrdersByJob(client, orgId, jobNumber),
      listJobRequirementsByJob(client, orgId, jobNumber),
      listJobCaulkRequirementsByJob(client, orgId, jobNumber),
      listCaulkJobAllocationsByJob(client, orgId, jobNumber),
    ]);
    const boxes = await listBoxes(client, orgId);
    const boxById = Object.fromEntries(boxes.map((box) => [box.boxId, box]));
    const pendingTransfersByBoxRecordId = indexPendingBoxTransfersByBoxRecordId(
      await listPendingBoxTransfersByBoxRecordIds(
        client,
        orgId,
        boxes.map((box) => box.id).filter(Boolean),
      ),
    );
    const publicRequirements = buildPublicJobRequirementEntries(requirements, allocations, boxById);
    const publicCaulkRequirements = buildPublicCaulkRequirementEntries(caulkRequirements, caulkAllocations);
    const blockingReason = getJobStagingBlockingReason(
      publicRequirements,
      publicCaulkRequirements,
      allocations,
      filmOrders,
      caulkAllocations,
      buildJobFilmTransferAlerts(
        asTrimmedString((jobRow as Record<string, unknown>).warehouse),
        allocations,
        boxById,
        pendingTransfersByBoxRecordId,
      ),
    );
    if (blockingReason) {
      throw new HttpError(400, blockingReason);
    }
  }

  const { error: updateError } = await serviceClient
    .schema("app")
    .from("jobs")
    .update({
      is_staged_for_pickup: nextIsStaged,
      updated_at: new Date().toISOString(),
      updated_by: actor,
    })
    .eq("org_id", orgId)
    .eq("id", (jobRow as Record<string, unknown>).id);
  throwOnSupabaseError(updateError, "Unable to update staged pickup");

  return ok(await buildJobDetail(client, orgId, jobNumber), warnings);
}

async function getBoxTransferByBox(client: any, orgId: string, boxId: string) {
  const { box, transfer } = await getLatestBoxTransferByBoxId(client, orgId, boxId);
  if (!box) {
    throw new HttpError(404, "Box not found.");
  }

  return ok(toPublicBoxTransfer(transfer));
}

async function startBoxTransfer(client: any, identity: AuthIdentity, payload: Record<string, unknown>) {
  const orgId = identity.orgId;
  const actor = identity.actor;
  const warnings: string[] = [];
  const boxId = requireString(payload.boxId, "BoxID").toUpperCase();
  const box = await findBoxById(client, orgId, boxId);
  if (!box) {
    throw new HttpError(404, `Box ${boxId} was not found.`);
  }

  if (asTrimmedString(box.status).toUpperCase() !== "IN_STOCK") {
    throw new HttpError(400, `Box ${box.boxId} must be in stock before it can be transferred.`);
  }

  const existingPendingTransfer = await findPendingBoxTransferByBoxRecordId(client, orgId, box.id);
  if (existingPendingTransfer) {
    throw new HttpError(400, `Box ${box.boxId} already has a pending transfer.`);
  }

  const sourceWarehouse = await findWarehouseEntry(client, orgId, box.warehouse, "CurrentWarehouse");
  const destinationWarehouse = await findWarehouseEntry(client, orgId, payload.toWarehouse, "ToWarehouse");
  if (sourceWarehouse.code === destinationWarehouse.code) {
    throw new HttpError(400, "Choose a different destination warehouse.");
  }

  const activeTargets = await listActiveAllocationTransferTargetsForBox(client, orgId, box.boxId);
  const transferGuard = getTransferStartGuardForBox(box, activeTargets);
  if (transferGuard.blockingMessage) {
    throw new HttpError(400, transferGuard.blockingMessage);
  }
  if (
    transferGuard.suggestedDestinationWarehouse &&
    transferGuard.suggestedDestinationWarehouse !== destinationWarehouse.code
  ) {
    throw new HttpError(
      400,
      `Box ${box.boxId} is already allocated to a job in ${transferGuard.suggestedDestinationWarehouse}. Start the transfer to that warehouse or remove the allocation first.`,
    );
  }

  const transfer = await saveBoxTransferRecord(client, orgId, {
    transferId: createTransferId(),
    boxRecordId: box.id,
    sourceBoxId: box.boxId,
    destinationBoxId: buildTransferredBoxId(box.boxId, sourceWarehouse.boxIdPrefix, destinationWarehouse.boxIdPrefix),
    sourceWarehouse: sourceWarehouse.code,
    destinationWarehouse: destinationWarehouse.code,
    status: "PENDING",
    notes: asTrimmedString(payload.notes),
    createdAt: new Date().toISOString(),
    createdBy: actor,
    updatedAt: new Date().toISOString(),
    updatedBy: actor,
  });

  const serviceClient = requireServiceRoleClient();
  const { error: updateBoxError } = await serviceClient
    .schema("app")
    .from("boxes")
    .update({
      status: "TRANSFER",
      updated_at: new Date().toISOString(),
      updated_by: actor,
    })
    .eq("org_id", orgId)
    .eq("id", box.id);
  throwOnSupabaseError(updateBoxError, `Unable to update box ${box.boxId}`);

  const updatedBox = await findBoxById(client, orgId, box.boxId);
  if (!updatedBox) {
    throw new HttpError(500, "Transfer started but the box could not be reloaded.");
  }

  const logId = await appendAuditEntry(
    orgId,
    "START_TRANSFER",
    updatedBox.boxId,
    toPublicBox(box),
    toPublicBox(updatedBox),
    actor,
    asTrimmedString(payload.notes) || `Started transfer to ${destinationWarehouse.code}.`,
  );

  return ok(
    {
      box: toPublicBox(updatedBox),
      transfer: toPublicBoxTransfer(transfer),
      logId,
      cancelledAllocationCount: 0,
      releasedFeet: 0,
    },
    warnings,
  );
}

async function receiveBoxTransfer(client: any, identity: AuthIdentity, payload: Record<string, unknown>) {
  const orgId = identity.orgId;
  const actor = identity.actor;
  const warnings: string[] = [];
  const transfer = await findBoxTransferByTransferId(client, orgId, requireString(payload.transferId, "TransferID"));
  if (!transfer) {
    throw new HttpError(404, "Transfer not found.");
  }
  if (transfer.status !== "PENDING") {
    throw new HttpError(400, `Transfer ${transfer.transferId} is already ${transfer.status.toLowerCase()}.`);
  }

  const box = await findBoxByRecordId(client, orgId, transfer.boxRecordId);
  if (!box) {
    throw new HttpError(404, "The source box for this transfer was not found.");
  }
  if (asTrimmedString(box.status).toUpperCase() !== "TRANSFER") {
    throw new HttpError(400, `Box ${box.boxId} is not in transfer status.`);
  }

  const sourceWarehouse = await findWarehouseEntry(client, orgId, transfer.sourceWarehouse, "SourceWarehouse");
  const destinationWarehouse = await findWarehouseEntry(client, orgId, transfer.destinationWarehouse, "DestinationWarehouse");
  const destinationBoxId = buildTransferredBoxId(box.boxId, sourceWarehouse.boxIdPrefix, destinationWarehouse.boxIdPrefix);
  if (await boxIdOrAliasExists(orgId, destinationBoxId, box.id)) {
    throw new HttpError(
      400,
      `Cannot receive transfer because ${destinationBoxId} is already in use. The suffix must stay fixed during warehouse transfers.`,
    );
  }

  await releaseReusableBoxIdAlias(orgId, destinationBoxId, box.id);

  const beforeBox = box;
  const updatedBox = await applyReceivedBoxTransfer(
    client,
    orgId,
    box,
    destinationWarehouse.code,
    destinationBoxId,
    actor,
  );
  if (!updatedBox) {
    throw new HttpError(500, "Transfer received but the updated box could not be reloaded.");
  }

  const savedTransfer = await saveBoxTransferRecord(client, orgId, {
    ...transfer,
    destinationBoxId,
    status: "RECEIVED",
    receivedAt: new Date().toISOString(),
    receivedBy: actor,
    updatedAt: new Date().toISOString(),
    updatedBy: actor,
  });

  const logId = await appendAuditEntry(
    orgId,
    "RECEIVE_TRANSFER",
    updatedBox.boxId,
    toPublicBox(beforeBox),
    toPublicBox(updatedBox),
    actor,
    `Received transfer into ${destinationWarehouse.code}.`,
  );

  return ok(
    {
      box: toPublicBox(updatedBox),
      transfer: toPublicBoxTransfer(savedTransfer),
      logId,
      cancelledAllocationCount: 0,
      releasedFeet: 0,
    },
    warnings,
  );
}

async function cancelBoxTransfer(client: any, identity: AuthIdentity, payload: Record<string, unknown>) {
  const orgId = identity.orgId;
  const actor = identity.actor;
  const warnings: string[] = [];
  const transfer = await findBoxTransferByTransferId(client, orgId, requireString(payload.transferId, "TransferID"));
  if (!transfer) {
    throw new HttpError(404, "Transfer not found.");
  }
  if (transfer.status !== "PENDING") {
    throw new HttpError(400, `Transfer ${transfer.transferId} is already ${transfer.status.toLowerCase()}.`);
  }

  const box = await findBoxByRecordId(client, orgId, transfer.boxRecordId);
  if (!box) {
    throw new HttpError(404, "The source box for this transfer was not found.");
  }

  let cancelledAllocationCount = 0;
  let releasedFeet = 0;
  const activeAllocations = await listAllocationsByBox(client, orgId, box.boxId);
  for (const allocation of activeAllocations) {
    if (allocation.status !== "ACTIVE" || !allocation.jobNumber) {
      continue;
    }

    const job = await findJobByNumber(client, orgId, allocation.jobNumber);
    if (!job || asTrimmedString(job.warehouse).toUpperCase() !== transfer.destinationWarehouse) {
      continue;
    }

    const removal = await removeJobBoxAllocation(client, identity, {
      jobNumber: allocation.jobNumber,
      allocationId: allocation.allocationId,
      reason:
        asTrimmedString(payload.reason) ||
        `Removed allocation ${allocation.allocationId} after cancelling transfer ${transfer.transferId}.`,
    });
    const removalResult = removal.data as Record<string, unknown>;
    cancelledAllocationCount += integerOrZero(removalResult.removedAllocationCount);
    releasedFeet += integerOrZero(removalResult.releasedFeet);
    warnings.push(...(removal.warnings || []));
  }

  const refreshedBox = (await findBoxByRecordId(client, orgId, transfer.boxRecordId)) || box;
  const serviceClient = requireServiceRoleClient();
  const { error: updateBoxError } = await serviceClient
    .schema("app")
    .from("boxes")
    .update({
      status: "IN_STOCK",
      updated_at: new Date().toISOString(),
      updated_by: actor,
    })
    .eq("org_id", orgId)
    .eq("id", transfer.boxRecordId);
  throwOnSupabaseError(updateBoxError, `Unable to restore box ${refreshedBox.boxId}`);

  const updatedBox = (await findBoxByRecordId(client, orgId, transfer.boxRecordId)) || refreshedBox;
  const savedTransfer = await saveBoxTransferRecord(client, orgId, {
    ...transfer,
    status: "CANCELLED",
    cancelledAt: new Date().toISOString(),
    cancelledBy: actor,
    notes: asTrimmedString(payload.reason) || transfer.notes,
    updatedAt: new Date().toISOString(),
    updatedBy: actor,
  });

  const logId = await appendAuditEntry(
    orgId,
    "CANCEL_TRANSFER",
    updatedBox.boxId,
    toPublicBox(refreshedBox),
    toPublicBox(updatedBox),
    actor,
    asTrimmedString(payload.reason) || `Cancelled transfer to ${transfer.destinationWarehouse}.`,
  );

  return ok(
    {
      box: toPublicBox(updatedBox),
      transfer: toPublicBoxTransfer(savedTransfer),
      logId,
      cancelledAllocationCount,
      releasedFeet,
    },
    warnings,
  );
}

async function completeJob(client: any, identity: AuthIdentity, payload: Record<string, unknown>) {
  const warnings: string[] = [];
  const orgId = identity.orgId;
  const actor = identity.actor;
  const jobNumber = requireString(payload.jobNumber, "JobNumber");
  const serviceClient = requireServiceRoleClientForJobs();

  const { data: jobRow, error: jobError } = await serviceClient
    .schema("app")
    .from("jobs")
    .select("id, org_id, job_number, lifecycle_status")
    .eq("org_id", orgId)
    .eq("job_number", jobNumber)
    .maybeSingle();
  throwOnSupabaseError(jobError, "Unable to load job");
  if (!jobRow) {
    throw new HttpError(404, `Job ${jobNumber} was not found.`);
  }

  const lifecycleStatus = normalizeJobLifecycleStatus((jobRow as Record<string, unknown>).lifecycle_status);
  if (lifecycleStatus === "COMPLETED") {
    throw new HttpError(400, `Job ${jobNumber} is already completed.`);
  }
  if (lifecycleStatus === "CANCELLED") {
    throw new HttpError(400, `Job ${jobNumber} is cancelled and cannot be completed.`);
  }

  const { data: checkedOutRows, error: checkedOutError } = await serviceClient
    .schema("app")
    .from("boxes")
    .select("box_id, last_checkout_job")
    .eq("org_id", orgId)
    .eq("status", "CHECKED_OUT");
  throwOnSupabaseError(checkedOutError, "Unable to load checked-out boxes");
  const matchingCheckedOutRows = (Array.isArray(checkedOutRows) ? checkedOutRows : []).filter((row) =>
    normalizeJobNumberKey((row as Record<string, unknown>).last_checkout_job) === normalizeJobNumberKey(jobNumber)
  );
  if (matchingCheckedOutRows.length) {
    const listedBoxes = matchingCheckedOutRows
      .slice(0, 5)
      .map((row) => asTrimmedString((row as Record<string, unknown>).box_id))
      .join(", ");
    const suffix = matchingCheckedOutRows.length > 5 ? ", ..." : "";
    throw new HttpError(
      400,
      `Job ${jobNumber} cannot be completed while boxes are still checked out: ${listedBoxes}${suffix}.`,
    );
  }

  const { data: openCaulkCheckoutRows, error: openCaulkCheckoutError } = await serviceClient
    .schema("app")
    .from("caulk_job_checkouts")
    .select("caulk_checkout_id")
    .eq("org_id", orgId)
    .eq("status", "OPEN")
    .eq("job_number", jobNumber);
  throwOnSupabaseError(openCaulkCheckoutError, "Unable to load open caulk checkouts");
  const openCaulkCheckoutCount = Array.isArray(openCaulkCheckoutRows) ? openCaulkCheckoutRows.length : 0;
  if (openCaulkCheckoutCount > 0) {
    throw new HttpError(
      400,
      `Job ${jobNumber} cannot be completed while ${openCaulkCheckoutCount} caulk checkout${openCaulkCheckoutCount === 1 ? " remains" : "s remain"} open.`,
    );
  }

  const nowIso = new Date().toISOString();
  const cancelNote = asTrimmedString(payload.reason) || `Cancelled because job ${jobNumber} was marked completed.`;
  const { data: activeAllocations, error: activeAllocationsError } = await serviceClient
    .schema("app")
    .from("allocations")
    .select("id, box_id, allocated_feet")
    .eq("org_id", orgId)
    .eq("job_number", jobNumber)
    .eq("status", "ACTIVE");
  throwOnSupabaseError(activeAllocationsError, "Unable to load active allocations");

  const releasedFeetByBox: Record<string, number> = {};
  let cancelledAllocationCount = 0;
  for (const row of Array.isArray(activeAllocations) ? activeAllocations : []) {
    const allocationId = (row as Record<string, unknown>).id;
    const boxId = asTrimmedString((row as Record<string, unknown>).box_id);
    const allocatedFeet = integerOrZero((row as Record<string, unknown>).allocated_feet);
    if (!allocationId || !boxId) {
      continue;
    }

    const { error: updateAllocationError } = await serviceClient
      .schema("app")
      .from("allocations")
      .update({
        status: "CANCELLED",
        resolved_at: nowIso,
        resolved_by: actor,
        notes: cancelNote,
      })
      .eq("org_id", orgId)
      .eq("id", allocationId);
    throwOnSupabaseError(updateAllocationError, `Unable to cancel allocation ${asTrimmedString(allocationId)}`);

    releasedFeetByBox[boxId] = integerOrZero(releasedFeetByBox[boxId]) + allocatedFeet;
    cancelledAllocationCount += 1;
  }

  for (const [boxId, releasedFeet] of Object.entries(releasedFeetByBox)) {
    const { data: boxRow, error: boxError } = await serviceClient
      .schema("app")
      .from("boxes")
      .select("id, status, feet_available")
      .eq("org_id", orgId)
      .eq("box_id", boxId)
      .maybeSingle();
    throwOnSupabaseError(boxError, `Unable to load box ${boxId}`);
    if (!boxRow) {
      continue;
    }

    const boxStatus = asTrimmedString((boxRow as Record<string, unknown>).status);
    if (boxStatus === "ZEROED" || boxStatus === "RETIRED") {
      continue;
    }

    const nextFeetAvailable = Math.max(0, integerOrZero((boxRow as Record<string, unknown>).feet_available) + releasedFeet);
    const { error: updateBoxError } = await serviceClient
      .schema("app")
      .from("boxes")
      .update({ feet_available: nextFeetAvailable })
      .eq("org_id", orgId)
      .eq("id", (boxRow as Record<string, unknown>).id);
    throwOnSupabaseError(updateBoxError, `Unable to update box ${boxId}`);
  }

  const { data: openFilmOrders, error: openFilmOrdersError } = await serviceClient
    .schema("app")
    .from("film_orders")
    .select("id")
    .eq("org_id", orgId)
    .eq("job_number", jobNumber)
    .in("status", ["FILM_ORDER", "FILM_ON_THE_WAY"]);
  throwOnSupabaseError(openFilmOrdersError, "Unable to load open film orders");

  let cancelledFilmOrderCount = 0;
  for (const row of Array.isArray(openFilmOrders) ? openFilmOrders : []) {
    const filmOrderId = (row as Record<string, unknown>).id;
    if (!filmOrderId) {
      continue;
    }
    const { error: updateFilmOrderError } = await serviceClient
      .schema("app")
      .from("film_orders")
      .update({
        status: "CANCELLED",
        resolved_at: nowIso,
        resolved_by: actor,
        notes: cancelNote,
      })
      .eq("org_id", orgId)
      .eq("id", filmOrderId);
    throwOnSupabaseError(updateFilmOrderError, "Unable to cancel open film order");
    cancelledFilmOrderCount += 1;
  }

  const caulkCancelResult = await rpcOrThrow<any>(client, "api_acl_jobs_cancel_caulk_allocations", {
    p_org_id: orgId,
    p_actor: actor,
    p_payload: {
      jobNumber,
      reason: cancelNote,
    },
  });
  const cancelledCaulkAllocationCount = integerOrZero((caulkCancelResult || {}).cancelledAllocationCount);
  const releasedReservedCaulkTubes = integerOrZero((caulkCancelResult || {}).releasedReservedTubes);

  const { error: completeJobError } = await serviceClient
    .schema("app")
    .from("jobs")
    .update({
      lifecycle_status: "COMPLETED",
      updated_at: nowIso,
      updated_by: actor,
    })
    .eq("org_id", orgId)
    .eq("id", (jobRow as Record<string, unknown>).id);
  throwOnSupabaseError(completeJobError, "Unable to mark job completed");

  warnings.push(
    `Marked job ${jobNumber} completed. Cancelled ${cancelledAllocationCount} active film allocation${cancelledAllocationCount === 1 ? "" : "s"}, ${cancelledCaulkAllocationCount} active caulk allocation${cancelledCaulkAllocationCount === 1 ? "" : "s"}, released ${releasedReservedCaulkTubes} reserved caulk tube${releasedReservedCaulkTubes === 1 ? "" : "s"}, and cancelled ${cancelledFilmOrderCount} open film order${cancelledFilmOrderCount === 1 ? "" : "s"}.`,
  );

  return ok(await buildJobDetail(client, orgId, jobNumber), warnings);
}

function formatDeletedJobCleanupWarning({
  jobNumber,
  filmRequirementCount,
  caulkRequirementCount,
  releasedFilmAllocationCount,
  affectedBoxCount,
  releasedReservedCaulkTubes,
  cancelledCaulkAllocationCount,
  purgedFilmAllocationCount,
  purgedCaulkAllocationCount,
  purgedCaulkCheckoutCount,
  purgedRollHistoryCount,
  deletedFilmOrderCount,
}: {
  jobNumber: string;
  filmRequirementCount: number;
  caulkRequirementCount: number;
  releasedFilmAllocationCount: number;
  affectedBoxCount: number;
  releasedReservedCaulkTubes: number;
  cancelledCaulkAllocationCount: number;
  purgedFilmAllocationCount: number;
  purgedCaulkAllocationCount: number;
  purgedCaulkCheckoutCount: number;
  purgedRollHistoryCount: number;
  deletedFilmOrderCount: number;
}) {
  return (
    `Deleted job ${jobNumber}. Removed ${filmRequirementCount} film requirement${filmRequirementCount === 1 ? "" : "s"} and ${caulkRequirementCount} caulk requirement${caulkRequirementCount === 1 ? "" : "s"}, ` +
    `released ${releasedFilmAllocationCount} active film allocation${releasedFilmAllocationCount === 1 ? "" : "s"} across ${affectedBoxCount} box${affectedBoxCount === 1 ? "" : "es"} and ${releasedReservedCaulkTubes} reserved caulk tube${releasedReservedCaulkTubes === 1 ? "" : "s"} across ${cancelledCaulkAllocationCount} active caulk allocation${cancelledCaulkAllocationCount === 1 ? "" : "s"}, ` +
    `purged ${purgedFilmAllocationCount} film allocation${purgedFilmAllocationCount === 1 ? "" : "s"}, ${purgedCaulkAllocationCount} caulk allocation${purgedCaulkAllocationCount === 1 ? "" : "s"}, ${purgedCaulkCheckoutCount} caulk checkout${purgedCaulkCheckoutCount === 1 ? "" : "s"}, and ${purgedRollHistoryCount} roll history ${purgedRollHistoryCount === 1 ? "entry" : "entries"}, ` +
    `and deleted ${deletedFilmOrderCount} film order${deletedFilmOrderCount === 1 ? "" : "s"}.`
  );
}

async function deleteJob(client: any, identity: AuthIdentity, payload: Record<string, unknown>) {
  const warnings: string[] = [];
  const orgId = identity.orgId;
  const actor = identity.actor;
  const role = asTrimmedString(identity.role).toLowerCase();
  if (role !== "owner" && role !== "admin") {
    throw new HttpError(403, "Admin or owner access is required.");
  }

  const jobNumber = normalizeJobNumberDigits(requireString(payload.jobNumber, "Job ID number"));
  if (!jobNumber) {
    throw new HttpError(400, "Job ID number must include at least one digit.");
  }
  const existingJob = await findJobByNumber(client, orgId, jobNumber);
  if (!existingJob) {
    throw new HttpError(404, `Job ${jobNumber} was not found.`);
  }

  const existingAllocations = await listAllocationsByJob(client, orgId, jobNumber);
  const existingFilmOrders = await listFilmOrdersByJob(client, orgId, jobNumber);
  const existingRequirements = await listJobRequirementsByJob(client, orgId, jobNumber);
  const existingCaulkRequirements = await listJobCaulkRequirementsByJob(client, orgId, jobNumber);
  const existingCaulkAllocations = await listCaulkJobAllocationsByJob(client, orgId, jobNumber);
  const existingCaulkCheckouts = await listCaulkJobCheckoutsByJob(client, orgId, jobNumber);
  const existingRollHistory = await listRollHistoryByJob(client, orgId, jobNumber, existingAllocations);
  const checkedOutBoxes = (await listBoxes(client, orgId)).filter(
    (box) =>
      box.status === "CHECKED_OUT" &&
      normalizeJobNumberKey(box.lastCheckoutJob) === normalizeJobNumberKey(jobNumber),
  );
  if (checkedOutBoxes.length) {
    const listedBoxes = checkedOutBoxes
      .slice(0, 5)
      .map((box) => box.boxId)
      .join(", ");
    const suffix = checkedOutBoxes.length > 5 ? ", ..." : "";
    throw new HttpError(
      400,
      `Job ${jobNumber} cannot be deleted while boxes are still checked out: ${listedBoxes}${suffix}.`,
    );
  }

  const openCaulkCheckoutCount = existingCaulkCheckouts.filter((entry) => entry.status === "OPEN").length;
  if (openCaulkCheckoutCount > 0) {
    throw new HttpError(
      400,
      `Job ${jobNumber} cannot be deleted while ${openCaulkCheckoutCount} caulk checkout${openCaulkCheckoutCount === 1 ? " remains" : "s remain"} open.`,
    );
  }

  const serviceClient = requireServiceRoleClientForJobs();
  const cancelReason = asTrimmedString(payload.reason) || `Deleted job ${jobNumber}.`;
  const nowIso = new Date().toISOString();

  const { data: activeAllocations, error: activeAllocationsError } = await serviceClient
    .schema("app")
    .from("allocations")
    .select("id, box_id, allocated_feet")
    .eq("org_id", orgId)
    .eq("job_number", jobNumber)
    .eq("status", "ACTIVE");
  throwOnSupabaseError(activeAllocationsError, "Unable to load active allocations");

  const releasedFeetByBox: Record<string, number> = {};
  let releasedFilmAllocationCount = 0;
  for (const row of Array.isArray(activeAllocations) ? activeAllocations : []) {
    const allocationId = (row as Record<string, unknown>).id;
    const boxId = asTrimmedString((row as Record<string, unknown>).box_id);
    const allocatedFeet = integerOrZero((row as Record<string, unknown>).allocated_feet);
    if (!allocationId || !boxId) {
      continue;
    }

    const { error: updateAllocationError } = await serviceClient
      .schema("app")
      .from("allocations")
      .update({
        status: "CANCELLED",
        resolved_at: nowIso,
        resolved_by: actor,
        notes: cancelReason,
      })
      .eq("org_id", orgId)
      .eq("id", allocationId);
    throwOnSupabaseError(updateAllocationError, `Unable to cancel allocation ${asTrimmedString(allocationId)}`);

    releasedFeetByBox[boxId] = integerOrZero(releasedFeetByBox[boxId]) + allocatedFeet;
    releasedFilmAllocationCount += 1;
  }

  let affectedBoxCount = 0;
  for (const [boxId, releasedFeet] of Object.entries(releasedFeetByBox)) {
    const { data: boxRow, error: boxError } = await serviceClient
      .schema("app")
      .from("boxes")
      .select("id, status, feet_available")
      .eq("org_id", orgId)
      .eq("box_id", boxId)
      .maybeSingle();
    throwOnSupabaseError(boxError, `Unable to load box ${boxId}`);
    if (!boxRow) {
      continue;
    }

    const boxStatus = asTrimmedString((boxRow as Record<string, unknown>).status);
    if (boxStatus === "ZEROED" || boxStatus === "RETIRED") {
      continue;
    }

    const nextFeetAvailable = Math.max(0, integerOrZero((boxRow as Record<string, unknown>).feet_available) + releasedFeet);
    const { error: updateBoxError } = await serviceClient
      .schema("app")
      .from("boxes")
      .update({ feet_available: nextFeetAvailable })
      .eq("org_id", orgId)
      .eq("id", (boxRow as Record<string, unknown>).id);
    throwOnSupabaseError(updateBoxError, `Unable to update box ${boxId}`);
    affectedBoxCount += 1;
  }

  let deletedFilmOrderCount = 0;
  for (const filmOrder of existingFilmOrders) {
    const filmOrderId = asTrimmedString((filmOrder as Record<string, unknown>).filmOrderId);
    if (!filmOrderId) {
      continue;
    }

    const { error: deleteFilmOrderLinksError } = await serviceClient
      .schema("app")
      .from("film_order_box_links")
      .delete()
      .eq("org_id", orgId)
      .eq("film_order_id", filmOrderId);
    throwOnSupabaseError(deleteFilmOrderLinksError, `Unable to delete film order links for ${filmOrderId}`);

    const { error: deleteFilmOrderError } = await serviceClient
      .schema("app")
      .from("film_orders")
      .delete()
      .eq("org_id", orgId)
      .eq("film_order_id", filmOrderId);
    throwOnSupabaseError(deleteFilmOrderError, `Unable to delete film order ${filmOrderId}`);
    deletedFilmOrderCount += 1;
  }

  const caulkCancelResult = await rpcOrThrow<any>(client, "api_acl_jobs_cancel_caulk_allocations", {
    p_org_id: orgId,
    p_actor: actor,
    p_payload: {
      jobNumber,
      reason: cancelReason,
    },
  });
  const cancelledCaulkAllocationCount = integerOrZero((caulkCancelResult || {}).cancelledAllocationCount);
  const releasedReservedCaulkTubes = integerOrZero((caulkCancelResult || {}).releasedReservedTubes);

  const { error: deleteAllocationsError } = await serviceClient
    .schema("app")
    .from("allocations")
    .delete()
    .eq("org_id", orgId)
    .eq("job_number", jobNumber);
  throwOnSupabaseError(deleteAllocationsError, `Unable to delete film allocations for job ${jobNumber}`);

  const { error: deleteCaulkAllocationsError } = await serviceClient
    .schema("app")
    .from("caulk_job_allocations")
    .delete()
    .eq("org_id", orgId)
    .eq("job_number", jobNumber);
  throwOnSupabaseError(deleteCaulkAllocationsError, `Unable to delete caulk allocations for job ${jobNumber}`);

  const { error: deleteRollHistoryError } = await serviceClient
    .schema("app")
    .from("roll_weight_log")
    .delete()
    .eq("org_id", orgId)
    .eq("job_number", jobNumber);
  throwOnSupabaseError(deleteRollHistoryError, `Unable to delete roll history for job ${jobNumber}`);

  const { error: deleteRequirementsError } = await serviceClient
    .schema("app")
    .from("job_requirements")
    .delete()
    .eq("org_id", orgId)
    .eq("job_id", existingJob.id);
  throwOnSupabaseError(deleteRequirementsError, `Unable to delete job requirements for job ${jobNumber}`);

  const { error: deleteCaulkRequirementsError } = await serviceClient
    .schema("app")
    .from("job_caulk_requirements")
    .delete()
    .eq("org_id", orgId)
    .eq("job_id", existingJob.id);
  throwOnSupabaseError(deleteCaulkRequirementsError, `Unable to delete caulk requirements for job ${jobNumber}`);

  const { error: deleteJobError } = await serviceClient
    .schema("app")
    .from("jobs")
    .delete()
    .eq("org_id", orgId)
    .eq("id", existingJob.id);
  throwOnSupabaseError(deleteJobError, `Unable to delete job ${jobNumber}`);

  warnings.push(
    formatDeletedJobCleanupWarning({
      jobNumber,
      filmRequirementCount: existingRequirements.length,
      caulkRequirementCount: existingCaulkRequirements.length,
      releasedFilmAllocationCount,
      affectedBoxCount,
      releasedReservedCaulkTubes,
      cancelledCaulkAllocationCount,
      purgedFilmAllocationCount: existingAllocations.length,
      purgedCaulkAllocationCount: existingCaulkAllocations.length,
      purgedCaulkCheckoutCount: existingCaulkCheckouts.length,
      purgedRollHistoryCount: existingRollHistory.length,
      deletedFilmOrderCount,
    }),
  );

  return ok({ jobNumber }, warnings);
}

async function recalculateFilmOrderAfterAllocationMutation(
  client: any,
  serviceClient: any,
  orgId: string,
  filmOrderId: string,
  actor: string,
) {
  const existing = await findFilmOrderById(client, orgId, filmOrderId);
  if (!existing) {
    return;
  }

  const allocations = await listAllocationsByFilmOrderId(client, orgId, filmOrderId);
  let coveredFeet = 0;
  for (const allocation of allocations) {
    if (allocation.status !== "CANCELLED") {
      coveredFeet += getStoredAllocationCoveredFeet(allocation);
    }
  }

  const links = await listFilmOrderLinksByFilmOrderId(client, orgId, filmOrderId);
  let orderedFeet = 0;
  for (const link of links) {
    const linkRecord = link as Record<string, unknown>;
    const boxId = asTrimmedString(linkRecord.box_id);
    if (!boxId) {
      continue;
    }

    const box = await findBoxById(client, orgId, boxId);
    if (!box) {
      continue;
    }
    orderedFeet += integerOrZero(linkRecord.ordered_feet);
  }

  const requestedFeet = integerOrZero(existing.requestedFeet);
  const remainingToOrderFeet = Math.max(requestedFeet - orderedFeet, 0);
  let nextStatus = asTrimmedString(existing.status) || "FILM_ORDER";
  let resolvedAt: string | null = existing.resolvedAt || null;
  let resolvedBy: string | null = existing.resolvedBy || null;

  if (nextStatus !== "CANCELLED") {
    if (coveredFeet >= requestedFeet) {
      nextStatus = "FULFILLED";
      if (!resolvedAt) {
        resolvedAt = new Date().toISOString();
        resolvedBy = actor;
      }
    } else if (orderedFeet >= requestedFeet) {
      nextStatus = "FILM_ON_THE_WAY";
      resolvedAt = null;
      resolvedBy = null;
    } else {
      nextStatus = "FILM_ORDER";
      resolvedAt = null;
      resolvedBy = null;
    }
  }

  const { error: updateFilmOrderError } = await serviceClient
    .schema("app")
    .from("film_orders")
    .update({
      covered_feet: coveredFeet,
      ordered_feet: orderedFeet,
      remaining_to_order_feet: remainingToOrderFeet,
      status: nextStatus,
      resolved_at: resolvedAt,
      resolved_by: resolvedBy,
    })
    .eq("org_id", orgId)
    .eq("id", existing.id);
  throwOnSupabaseError(updateFilmOrderError, `Unable to recalculate film order ${filmOrderId}`);
}

async function removeJobBoxAllocation(client: any, identity: AuthIdentity, payload: Record<string, unknown>) {
  const warnings: string[] = [];
  const orgId = identity.orgId;
  const actor = identity.actor;
  const jobNumber = requireString(payload.jobNumber, "JobNumber");
  const allocationId = requireString(payload.allocationId, "AllocationID");
  const normalizedJobNumber = normalizeJobNumberKey(jobNumber);
  const serviceClient = requireServiceRoleClientForJobs();

  const existingJob = await findJobByNumber(client, orgId, jobNumber);
  if (existingJob && normalizeJobLifecycleStatus(existingJob.lifecycleStatus) !== "ACTIVE") {
    throw new HttpError(400, `Job ${jobNumber} is closed and allocation rows cannot be removed.`);
  }

  const allocations = await listAllocationsByJob(client, orgId, jobNumber);
  const target = allocations.find((entry) => asTrimmedString(entry.allocationId) === allocationId);
  if (!target) {
    throw new HttpError(404, `Allocation ${allocationId} was not found for job ${jobNumber}.`);
  }

  if (target.status === "CANCELLED") {
    warnings.push(`Allocation ${allocationId} was already cancelled for job ${jobNumber}.`);
    return ok({
      jobNumber,
      allocationId: target.allocationId,
      boxId: target.boxId,
      removedAllocationCount: 0,
      releasedFeet: 0,
    }, warnings);
  }

  const box = await findBoxById(client, orgId, target.boxId);
  if (
    box &&
    box.status === "CHECKED_OUT" &&
    normalizeJobNumberKey(box.lastCheckoutJob) === normalizedJobNumber
  ) {
    throw new HttpError(
      400,
      `Box ${target.boxId} is checked out on job ${jobNumber} and cannot be removed until the box is checked in.`,
    );
  }

  const note = asTrimmedString(payload.reason) ||
    `Removed allocation ${target.allocationId} for box ${target.boxId} from job ${jobNumber} on allocation detail page.`;
  const releasedFeet =
    target.status === "ACTIVE" || target.status === "FULFILLED" ? integerOrZero(target.allocatedFeet) : 0;
  const nowIso = new Date().toISOString();

  const { error: updateAllocationError } = await serviceClient
    .schema("app")
    .from("allocations")
    .update({
      status: "CANCELLED",
      resolved_at: nowIso,
      resolved_by: actor,
      notes: note,
    })
    .eq("org_id", orgId)
    .eq("id", target.id);
  throwOnSupabaseError(updateAllocationError, `Unable to remove allocation ${target.allocationId}`);

  if (releasedFeet > 0 && box && box.status !== "ZEROED" && box.status !== "RETIRED") {
    const nextFeetAvailable = Math.max(0, integerOrZero(box.feetAvailable) + releasedFeet);
    const { error: updateBoxError } = await serviceClient
      .schema("app")
      .from("boxes")
      .update({
        feet_available: nextFeetAvailable,
      })
      .eq("org_id", orgId)
      .eq("id", box.id);
    throwOnSupabaseError(updateBoxError, `Unable to update box ${target.boxId}`);
  }

  const filmOrderId = asTrimmedString(target.filmOrderId);
  if (filmOrderId) {
    await recalculateFilmOrderAfterAllocationMutation(client, serviceClient, orgId, filmOrderId, actor);
  }

  warnings.push(
    `Removed allocation ${target.allocationId} for box ${target.boxId} on job ${jobNumber}. Released ${releasedFeet} LF back to box availability.`,
  );

  return ok({
    jobNumber,
    allocationId: target.allocationId,
    boxId: target.boxId,
    removedAllocationCount: 1,
    releasedFeet,
  }, warnings);
}

async function reopenJob(client: any, identity: AuthIdentity, payload: Record<string, unknown>) {
  if (identity.role !== "owner") {
    throw new HttpError(403, "Owner access is required to reopen jobs.");
  }

  const warnings: string[] = [];
  const orgId = identity.orgId;
  const actor = identity.actor;
  const jobNumber = requireString(payload.jobNumber, "JobNumber");
  const serviceClient = requireServiceRoleClientForJobs();

  const { data: jobRow, error: jobError } = await serviceClient
    .schema("app")
    .from("jobs")
    .select("id, lifecycle_status")
    .eq("org_id", orgId)
    .eq("job_number", jobNumber)
    .maybeSingle();
  throwOnSupabaseError(jobError, "Unable to load job");
  if (!jobRow) {
    throw new HttpError(404, `Job ${jobNumber} was not found.`);
  }

  const lifecycleStatus = normalizeJobLifecycleStatus((jobRow as Record<string, unknown>).lifecycle_status);
  if (lifecycleStatus !== "COMPLETED" && lifecycleStatus !== "CANCELLED") {
    throw new HttpError(400, `Job ${jobNumber} is already active.`);
  }

  const { error: reopenError } = await serviceClient
    .schema("app")
    .from("jobs")
    .update({
      lifecycle_status: "ACTIVE",
      updated_at: new Date().toISOString(),
      updated_by: actor,
    })
    .eq("org_id", orgId)
    .eq("id", (jobRow as Record<string, unknown>).id);
  throwOnSupabaseError(reopenError, "Unable to reopen job");

  warnings.push(`Reopened job ${jobNumber}. Previously cancelled allocations and film orders remain cancelled.`);
  return ok(await buildJobDetail(client, orgId, jobNumber), warnings);
}

async function canonicalizeRequirementPayloadEntries(
  client: any,
  orgId: string,
  entriesRaw: unknown,
) {
  if (!Array.isArray(entriesRaw)) {
    return entriesRaw;
  }

  const normalized = [];
  for (let index = 0; index < entriesRaw.length; index += 1) {
    const entry = entriesRaw[index];
    if (!entry || typeof entry !== "object") {
      normalized.push(entry);
      continue;
    }
    const source = entry as Record<string, unknown>;
    assertAveryNaturaShadeForWrite(
      source.manufacturer,
      source.filmName,
      `requirements[${index}].filmName`,
    );
    const canonical = await resolveCanonicalFilmEntry(client, orgId, source.manufacturer, source.filmName);
    normalized.push({
      ...source,
      manufacturer: canonical.manufacturer,
      filmName: canonical.filmName,
    });
  }

  return normalized;
}

async function canonicalizeMutationPayloadForRoute(
  client: any,
  orgId: string,
  logicalPath: string,
  payload: Record<string, unknown>,
) {
  const next = payload && typeof payload === "object" ? { ...payload } : {};

  if (logicalPath === "/boxes/add" || logicalPath === "/boxes/update") {
    assertAveryNaturaShadeForWrite(next.manufacturer, next.filmName, "FilmName");
    const canonical = await resolveCanonicalFilmEntry(client, orgId, next.manufacturer, next.filmName);
    next.manufacturer = canonical.manufacturer;
    next.filmName = canonical.filmName;
    next.filmKey = normalizeFilmKeyInput(canonical.manufacturer, canonical.filmName, next.filmKey);
    return next;
  }

  if (logicalPath === "/film-orders/create") {
    assertAveryNaturaShadeForWrite(next.manufacturer, next.filmName, "FilmName");
    const canonical = await resolveCanonicalFilmEntry(client, orgId, next.manufacturer, next.filmName);
    next.manufacturer = canonical.manufacturer;
    next.filmName = canonical.filmName;
    return next;
  }

  if (logicalPath === "/jobs/create" || logicalPath === "/jobs/update") {
    next.requirements = await canonicalizeRequirementPayloadEntries(client, orgId, next.requirements);
    return next;
  }

  return next;
}

async function callMutationRpc(client: any, fn: string, orgId: string, actor: string, payload: Record<string, unknown>) {
  return await rpcOrThrow<any>(client, fn, {
    p_org_id: orgId,
    p_actor: actor,
    p_payload: payload,
  });
}

async function dispatchRead(client: any, orgId: string, logicalPath: string, params: Record<string, unknown>) {
  return dispatchReadWithHandlers(client, orgId, logicalPath, params, {
    asTrimmedString,
    requireString,
    integerOrZero,
    rpcOrThrow,
    enrichAdminPermissionEntries,
    buildSearchBoxes,
    findBoxById,
    getBoxTransferByBox,
    toPublicBox,
    listAudit,
    listAuditEntriesByBox,
    listAllocationsByBox,
    toPublicAllocation,
    buildAllocationJobList,
    buildAllocationJobDetail,
    buildAllocationPreviewPlan,
    normalizeOptionalWarehouse,
    resolveJobContext,
    parseCrossWarehouseFlag,
    listBoxes,
    listJobRequirementsByJob,
    buildActiveAllocationsByBoxIndex,
    listActiveAllocations,
    buildJobsList,
    buildJobsCalendar,
    buildJobsSearchResults,
    buildJobDetail,
    buildFilmOrdersList,
    buildFilmCatalog,
    listRollHistoryByBox,
    buildReportsSummary,
    buildOwnerAssetTotalCost,
  });
}

async function dispatchMutation(
  client: any,
  identity: AuthIdentity,
  logicalPath: string,
  payload: Record<string, unknown>,
) {
  return dispatchMutationWithHandlers(client, identity, logicalPath, payload, {
    asTrimmedString,
    requireString,
    integerOrZero,
    normalizeCaulkCaseMath,
    canonicalizeMutationPayloadForRoute,
    callMutationRpc,
    findBoxById,
    toPublicBox,
    startBoxTransfer,
    receiveBoxTransfer,
    cancelBoxTransfer,
    ensureBoxCheckoutCrewCompatibility,
    findJobByNumber,
    normalizeJobLifecycleStatus,
    listAllocationsByIds,
    toPublicAllocation,
    findFilmOrderById,
    toPublicFilmOrder,
    buildPublicFilmOrderLinkedBoxes,
    removeJobBoxAllocation,
    buildJobDetail,
    setJobStagedPickup,
    checkoutAllJobMaterials,
    completeJob,
    reopenJob,
    deleteJob,
  });
}

export async function handleApiRequest(request: Request, canonicalName = "api"): Promise<Response> {
  const corsHeaders = buildCorsHeaders(request);
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (request.method !== "GET" && request.method !== "POST") {
    return jsonResponse(request, 405, {
      ok: false,
      error: `Unsupported method: ${request.method}`,
    });
  }

  const requestUrl = new URL(request.url);
  const requestBody = request.method === "POST" ? await request.text() : "";
  const bodyJson = request.method === "POST" ? parseBodyJson(requestBody) : null;
  const logicalPath = resolveLogicalPath(requestUrl, bodyJson, canonicalName);

  if (logicalPath === "/health" || requestUrl.pathname.endsWith("/health")) {
    return jsonResponse(request, 200, {
      ok: true,
      data: {
        status: "ok",
        mode: "supabase",
        timestamp: new Date().toISOString(),
        sheets: [],
        apiBuildSha: API_BUILD_SHA,
        apiBuiltAt: API_BUILT_AT,
      },
      warnings: [],
    });
  }

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return jsonResponse(request, 500, {
      ok: false,
      error: "SUPABASE_URL and SUPABASE_ANON_KEY must be configured for the Edge API.",
    });
  }

  const useCache = shouldUseCache(request.method, logicalPath);
  const authorization = request.headers.get("authorization") || "";
  const authKey = await sha1Hex(authorization);
  const cacheRouteKey = request.method === "POST" ? `${logicalPath}|${requestUrl.search}` : requestUrl.toString();
  const cacheKey = request.method === "POST"
    ? `${request.method}|${cacheRouteKey}|${await sha1Hex(requestBody)}|${authKey}`
    : `${request.method}|${cacheRouteKey}|${authKey}`;

  if (useCache) {
    pruneCache();
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      const headers = buildCorsHeaders(request);
      headers.set("Content-Type", cached.contentType);
      return new Response(cached.body, { status: cached.status, headers });
    }
  }

  try {
    const { identity, client } = await resolveAuthContext(request);
    if (logicalPath === "/auth/context") {
      const payload = ok({
        orgId: identity.orgId,
        accessStatus: identity.accessStatus,
        role: identity.role,
        permissions: identity.permissions,
        isAdminConsoleAllowed: identity.isAdminConsoleAllowed,
        pendingCount: identity.pendingCount,
        receivesInAppNotifications: identity.receivesInAppNotifications,
      });
      const responseBody = JSON.stringify(payload);
      const headers = buildCorsHeaders(request);
      headers.set("Content-Type", "application/json; charset=utf-8");
      return new Response(responseBody, { status: 200, headers });
    }

    ensureEffectiveRouteAccess(identity, logicalPath);

    const params = routeParams(request.method, requestUrl, bodyJson);
    const payload = request.method === "GET"
      ? await dispatchRead(client, identity.orgId, logicalPath, params)
      : await dispatchMutation(client, identity, logicalPath, params);

    const responseBody = JSON.stringify(payload);
    if (useCache) {
      cache.set(cacheKey, {
        expiresAt: Date.now() + CACHE_TTL_MS,
        status: 200,
        contentType: "application/json; charset=utf-8",
        body: responseBody,
      });
    }
    if (isMutation(request.method, logicalPath)) {
      cache.clear();
      authIdentityCache.clear();
    }

    const headers = buildCorsHeaders(request);
    headers.set("Content-Type", "application/json; charset=utf-8");
    return new Response(responseBody, { status: 200, headers });
  } catch (error) {
    if (error instanceof HttpError) {
      return jsonResponse(request, error.statusCode, {
        ok: false,
        error: error.message,
        warnings: error.warnings || [],
      });
    }
    return jsonResponse(request, 500, {
      ok: false,
      error: error instanceof Error ? error.message : "Unexpected server error.",
      warnings: [],
    });
  }
}




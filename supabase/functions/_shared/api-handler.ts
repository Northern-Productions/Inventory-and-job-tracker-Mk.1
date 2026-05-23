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
import {
  getRouteTimingErrorCategory,
  maybeLogRouteTiming,
  resolveRouteTimingRequestId,
} from "./route-timing.ts";
import { ensureEffectiveRouteAccess } from "./acl.ts";
import { resolveAuthContext as resolveAuthContextFromModule } from "./auth.ts";
import { createInventoryRepositories } from "./repositories/index.ts";
import {
  asTrimmedString,
  chunkValues,
  requireString,
  normalizeStringArrayParam,
  normalizeDateString,
  coerceFeetValue,
  formatTimestamp,
  formatDateValue,
  numericOrNull,
  integerOrZero,
  normalizeCaulkCaseMath,
  integerOrNull,
  roundToDecimals,
  createLogId,
} from "./core/index.ts";
import { routeParams as routeParamsFromModule } from "./routes/params.ts";
import { dispatchReadWithHandlers } from "./routes/readHandlers.ts";
import { dispatchMutationWithHandlers } from "./routes/mutationHandlers.ts";
import { resolveEdgeJobMutationTargetById } from "./jobMutationIdentity.ts";
import { buildAppAttentionSummary as buildAppAttentionSummaryFromService } from "./services/appAttention.ts";
import { listRollHistoryByJob as listRollHistoryByJobFromService } from "./services/rollHistory.ts";
import {
  buildCurrentCheckedOutAllocationIdSet,
  buildFilmCheckoutActionPlan,
} from "../../../shared/checkoutSemantics.mjs";
import { normalizeSchedulePayloadAliases } from "../../../shared/schedulePayloadAliases.mjs";
import type { AuthIdentity } from "./types.ts";
import {
  computeCoveredFeetForAllocation,
  isSplitCoveragePair,
  planCoverageAllocation,
} from "../../../shared/domain/allocationCoverageContract.mjs";
import {
  buildTransferredBoxId as buildSharedTransferredBoxId,
  planTransferredBoxId,
} from "../../../shared/domain/boxTransferPlanner.mjs";
import {
  matchesBoxSearchQuery,
  rankBoxSearchCandidates,
} from "../../../shared/domain/boxSearchMatcher.mjs";
import {
  canJobPlanningFilmSatisfyRequirement as canSharedJobPlanningFilmSatisfyRequirement,
  compareJobPlanningFilmMatches as compareSharedJobPlanningFilmMatches,
  describeJobPlanningFilm as describeSharedJobPlanningFilm,
  getJobPlanningFilmMatch as getSharedJobPlanningFilmMatch,
} from "../../../shared/domain/jobPlanningFilmMatcher.mjs";
import { rankJobNumberSearchCandidates } from "../../../shared/domain/jobNumberSearchMatcher.mjs";
import {
  buildBoxReservationSnapshot,
  getAllocationReservationState,
} from "../../../shared/domain/filmAllocationReservations.mjs";
import { getSameDayCrewConflictJobs } from "../../../shared/domain/sameDayCrewConflicts.mjs";

const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
const BOX_TRANSFER_QUERY_BATCH_SIZE = 100;
const WAREHOUSE_BOX_READ_PAGE_SIZE = 1000;
const JOBS_CALENDAR_CANDIDATE_LIMIT = 500;
const JOBS_CALENDAR_DETAIL_BATCH_SIZE = 25;

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

function normalizeCatalogWriteManufacturerAndFilm(
  manufacturer: unknown,
  filmName: unknown,
): { manufacturer: string; filmName: string } {
  const normalizedManufacturer = canonicalizeManufacturerLabel(manufacturer);
  const normalizedFilmName = normalizeCollapsedCatalogLabel(filmName);
  const solarNormalized = normalize3MSolarNightVisionManufacturerAndFilm(
    normalizedManufacturer,
    normalizedFilmName,
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

function normalizeCatalogWriteFilmKeyInput(
  manufacturer: unknown,
  filmName: unknown,
  filmKeyInput: unknown,
): string {
  const normalized = normalizeCatalogWriteManufacturerAndFilm(manufacturer, filmName);
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
  if (left.installDate && right.installDate && left.installDate !== right.installDate) {
    return left.installDate < right.installDate ? -1 : 1;
  }
  if (left.installDate && !right.installDate) {
    return -1;
  }
  if (!left.installDate && right.installDate) {
    return 1;
  }
  return left.jobNumber < right.jobNumber ? -1 : left.jobNumber > right.jobNumber ? 1 : 0;
}

function compareJobsListEntries(left: any, right: any): number {
  if (left.installDate && right.installDate && left.installDate !== right.installDate) {
    return left.installDate > right.installDate ? -1 : 1;
  }
  if (left.installDate && !right.installDate) {
    return -1;
  }
  if (!left.installDate && right.installDate) {
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
  if (left.jobNumber !== right.jobNumber) {
    return left.jobNumber > right.jobNumber ? -1 : 1;
  }

  const leftScope = asTrimmedString(left.workScopeKey || left.workScope || left.sections);
  const rightScope = asTrimmedString(right.workScopeKey || right.workScope || right.sections);
  if (leftScope !== rightScope) {
    return leftScope < rightScope ? -1 : 1;
  }

  const leftJobId = asTrimmedString(left.jobId);
  const rightJobId = asTrimmedString(right.jobId);
  return leftJobId < rightJobId ? -1 : leftJobId > rightJobId ? 1 : 0;
}

function normalizeJobNumberDigits(value: unknown): string {
  return asTrimmedString(value).replace(/[^0-9]/g, "");
}

function getEntryJobId(entry: any): string {
  return asTrimmedString(entry?.jobId || entry?.id);
}

function getEntryJobNumber(entry: any): string {
  return asTrimmedString(entry?.jobNumber);
}

function groupEntriesByCanonicalJobId(entries: any[]): Record<string, any[]> {
  const grouped: Record<string, any[]> = {};
  for (const entry of entries) {
    const jobId = getEntryJobId(entry);
    if (!jobId) {
      continue;
    }
    if (!grouped[jobId]) {
      grouped[jobId] = [];
    }
    grouped[jobId].push(entry);
  }
  return grouped;
}

function groupEntriesByJobNumberFallback(
  entries: any[],
  options: { includeScopedRows?: boolean } = {},
): Record<string, any[]> {
  const grouped: Record<string, any[]> = {};
  for (const entry of entries) {
    if (!options.includeScopedRows && getEntryJobId(entry)) {
      continue;
    }
    const jobNumber = getEntryJobNumber(entry);
    if (!jobNumber) {
      continue;
    }
    if (!grouped[jobNumber]) {
      grouped[jobNumber] = [];
    }
    grouped[jobNumber].push(entry);
  }
  return grouped;
}

function getRowsForJobHeader(
  header: any,
  rowsByJobId: Record<string, any[]>,
  unscopedRowsByJobNumber: Record<string, any[]>,
  jobNumberHeaderCounts: Record<string, number>,
): any[] {
  const jobId = getEntryJobId(header);
  const jobNumber = getEntryJobNumber(header);
  const scopedRows = jobId ? rowsByJobId[jobId] || [] : [];
  const fallbackRows = jobNumberHeaderCounts[jobNumber] === 1
    ? unscopedRowsByJobNumber[jobNumber] || []
    : [];
  return fallbackRows.length ? [...scopedRows, ...fallbackRows] : scopedRows;
}

function getRowsForLegacyJobNumber(jobNumber: string, rowsByJobNumber: Record<string, any[]>): any[] {
  return rowsByJobNumber[jobNumber] || [];
}

function collectLegacyJobNumbersFromRows(
  rows: any[],
  legacyJobNumbers: Set<string>,
  jobNumberFilterSet: Set<string>,
) {
  for (const row of rows) {
    const jobNumber = getEntryJobNumber(row);
    if (!jobNumber || (jobNumberFilterSet.size > 0 && !jobNumberFilterSet.has(jobNumber))) {
      continue;
    }
    legacyJobNumbers.add(jobNumber);
  }
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

const CACHEABLE_GET_ROUTES = new Set([
  "/box-dealers/list",
  "/caulk/manufacturers/list",
  "/caulk/products/list",
  "/film-data/catalog",
  "/warehouses/list",
]);

export function shouldUseCache(method: string, logicalPath: string): boolean {
  if (!Number.isFinite(CACHE_TTL_MS) || CACHE_TTL_MS <= 0) {
    return false;
  }

  if (method !== "GET") {
    return false;
  }

  /*
   * Operational cache safety:
   * job/allocation/readiness state changes immediately after mutations, while
   * this Edge response cache is process-local and cannot be invalidated across
   * isolates. Broad GET caching can therefore replay stale job truth over a
   * fresh optimistic client update, so only stable reference reads are cached.
   */
  return CACHEABLE_GET_ROUTES.has(logicalPath);
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
  if (
    normalized.includes('relation "app.caulk_transfers" does not exist') ||
    (normalized.includes('type "app.caulk_transfer_status"') && normalized.includes('does not exist')) ||
    (normalized.includes('function public.api_acl_list_caulk_transfers') && normalized.includes('does not exist')) ||
    (normalized.includes('function public.api_acl_caulk_transfer_receive') && normalized.includes('does not exist')) ||
    (normalized.includes('function public.api_acl_caulk_transfer_cancel') && normalized.includes('does not exist')) ||
    (normalized.includes('function public.api_acl_list_caulk_job_allocations_by_job') && normalized.includes('does not exist'))
  ) {
    return 'Database migration 0065_caulk_transfer_assist_and_new_products.sql is required. Apply missing backend migrations through 0065, then retry.';
  }
  if (
    normalized.includes('relation "app.allocation_planner_suppressions" does not exist') ||
    (normalized.includes('function public.api_acl_clear_allocation_planner_suppression') && normalized.includes('does not exist')) ||
    (normalized.includes('function public.api_acl_record_auto_planned_allocation_suppression') && normalized.includes('does not exist')) ||
    (normalized.includes('function app_api.film_allocation_reserves_capacity') && normalized.includes('does not exist')) ||
    (normalized.includes('function app_api.film_requirement_planner_signature') && normalized.includes('does not exist'))
  ) {
    return 'Database migrations through 0087_allocation_reserved_availability.sql are required. Apply missing backend and Supabase migrations through 0087, then retry.';
  }
  if (
    (normalized.includes('function public.api_acl_reconcile_auto_planned_allocations') && normalized.includes('does not exist')) ||
    (normalized.includes('function app_api.reconcile_auto_planned_allocations') && normalized.includes('does not exist')) ||
    (normalized.includes('function app_api.assert_film_box_allocation_capacity') && normalized.includes('does not exist'))
  ) {
    return 'Database migration 0085_auto_planned_allocation_engine.sql is required. Apply missing backend and Supabase migrations through 0085, then retry.';
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

async function listInternalBoxRecordIdsByBoxId(orgId: string, boxIds: string[]) {
  const normalizedBoxIds = Array.from(
    new Set(boxIds.map((boxId) => asTrimmedString(boxId).toUpperCase()).filter(Boolean)),
  );
  if (!normalizedBoxIds.length) {
    return {};
  }

  const serviceClient = requireServiceRoleClient();
  const idsByBoxId: Record<string, string> = {};
  for (const batchIds of chunkValues(normalizedBoxIds, BOX_TRANSFER_QUERY_BATCH_SIZE)) {
    const { data, error } = await serviceClient
      .schema("app")
      .from("boxes")
      .select("id, box_id")
      .eq("org_id", orgId)
      .in("box_id", batchIds);
    throwOnSupabaseError(error, "Unable to load internal box identities");

    for (const row of Array.isArray(data) ? data : []) {
      const boxId = asTrimmedString((row as Record<string, unknown>).box_id).toUpperCase();
      const internalId = asTrimmedString((row as Record<string, unknown>).id);
      if (!boxId || !internalId) {
        continue;
      }
      idsByBoxId[boxId] = internalId;
    }
  }
  return idsByBoxId;
}

export async function fetchWarehouseBoxRowsForInventory(
  serviceClient: any,
  orgId: string,
  normalizedWarehouses: string[],
  pageSize = WAREHOUSE_BOX_READ_PAGE_SIZE,
) {
  /**
   * PURPOSE:
   * Pages warehouse box rows for /boxes/search so large warehouses are not silently truncated.
   *
   * AFFECTS:
   * Inventory search, offline inventory snapshots, and allocation planning values shown on box rows.
   *
   * WHEN CHANGING THIS, ALSO CHECK:
   * Frontend offline sync ordering, local backend buildSearchBoxes, and app.boxes warehouse indexes.
   *
   * COMMON FAILURE MODES:
   * Missing later box IDs after PostgREST row caps, or falling back to all-org RPCs that timeout.
   */
  const normalizedPageSize = Math.max(1, Math.floor(pageSize));
  const rows: any[] = [];
  for (const warehouseBatch of chunkValues(normalizedWarehouses, BOX_TRANSFER_QUERY_BATCH_SIZE)) {
    let pageStart = 0;
    while (true) {
      const pageEnd = pageStart + normalizedPageSize - 1;
      const { data, error } = await serviceClient
        .schema("app")
        .from("boxes")
        .select("*")
        .eq("org_id", orgId)
        .in("warehouse", warehouseBatch)
        .order("box_id", { ascending: true })
        .range(pageStart, pageEnd);
      throwOnSupabaseError(error, "Unable to load warehouse box snapshots");
      const pageRows = Array.isArray(data) ? data : [];
      rows.push(...pageRows);

      if (pageRows.length < normalizedPageSize) {
        break;
      }

      pageStart += normalizedPageSize;
    }
  }

  return rows;
}

async function listBoxesByWarehouses(_client: any, orgId: string, warehouses: string[]) {
  const normalizedWarehouses = Array.from(
    new Set(warehouses.map((warehouse) => asTrimmedString(warehouse).toUpperCase()).filter(Boolean)),
  );
  if (!normalizedWarehouses.length) {
    return [];
  }

  const rows = await fetchWarehouseBoxRowsForInventory(
    requireServiceRoleClient(),
    orgId,
    normalizedWarehouses,
  );
  const mappedBoxes: any[] = [];
  for (const row of rows) {
    const mapped = mapDbBoxRow(row);
    if (mapped) {
      mappedBoxes.push(mapped);
    }
  }
  return mappedBoxes;
}

async function findRawBoxRowByBoxIdForInventory(orgId: string, boxId: string) {
  const normalizedBoxId = asTrimmedString(boxId);
  if (!normalizedBoxId) {
    return null;
  }

  const { data, error } = await requireServiceRoleClient()
    .schema("app")
    .from("boxes")
    .select("*")
    .eq("org_id", orgId)
    .eq("box_id", normalizedBoxId)
    .maybeSingle();
  throwOnSupabaseError(error, "Unable to load box snapshot");
  return data || null;
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

async function resolveCatalogWriteFilmEntry(
  client: any,
  orgId: string,
  manufacturer: unknown,
  filmName: unknown,
): Promise<{ manufacturer: string; filmName: string }> {
  // Preserve explicit normalized labels on direct box/catalog writes.
  // Alias resolution is still used for requirement/order matching, but box edits
  // must be able to introduce a new canonical descriptive label instead of
  // collapsing it back to an older alias target.
  return normalizeCatalogWriteManufacturerAndFilm(manufacturer, filmName);
}

const inventoryRepositories = createInventoryRepositories({
  rpcOrThrow,
  asTrimmedString,
  numericOrNull,
  integerOrZero,
  integerOrNull,
  formatDateValue,
  formatTimestamp,
  listInternalBoxRecordIdsByBoxId,
  findRawBoxRowByBoxId: findRawBoxRowByBoxIdForInventory,
});
const {
  mapDbBoxRow,
  mapDbAllocationRow,
  mapDbFilmOrderRow,
  mapDbJobPhaseRow,
  mapDbRequirementRow,
  mapDbCaulkJobRequirementRow,
  mapDbCaulkJobAllocationRow,
  mapDbCaulkJobCheckoutRow,
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
  listJobsCalendar,
  findJobByNumber,
  findJobById,
  listJobPhases,
  listJobPhasesByJob,
  listJobPhasesByJobId,
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

function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
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

function toTimestampMs(value: unknown): number | null {
  const timestamp = asTrimmedString(value);
  if (!timestamp) {
    return null;
  }

  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildRollHistoryAllocationWindowsByBox(allocations: any[]) {
  const grouped: Record<string, Array<{ startMs: number | null; endMs: number | null }>> = {};
  for (const allocation of Array.isArray(allocations) ? allocations : []) {
    const boxId = asTrimmedString(allocation?.boxId).toUpperCase();
    if (!boxId) {
      continue;
    }
    if (!grouped[boxId]) {
      grouped[boxId] = [];
    }
    grouped[boxId].push({
      startMs: toTimestampMs(allocation?.createdAt),
      endMs: toTimestampMs(allocation?.resolvedAt),
    });
  }
  return grouped;
}

function isTimestampInAllocationWindow(
  timestampMs: number | null,
  window: { startMs: number | null; endMs: number | null },
) {
  if (timestampMs === null) {
    return false;
  }
  if (window.startMs !== null && timestampMs < window.startMs) {
    return false;
  }
  if (window.endMs !== null && timestampMs > window.endMs) {
    return false;
  }
  return true;
}

function filterRollHistoryForJobAllocations(entries: any[], allocations: any[]) {
  const windowsByBox = buildRollHistoryAllocationWindowsByBox(allocations);
  const deduped: Record<string, any> = {};
  for (const entry of Array.isArray(entries) ? entries : []) {
    const boxId = asTrimmedString(entry?.boxId).toUpperCase();
    const windows = windowsByBox[boxId] || [];
    const activityTimestampMs = toTimestampMs(getRollHistoryActivityTimestamp(entry));
    const checkoutTimestampMs = toTimestampMs(entry?.checkedOutAt);
    if (
      !boxId ||
      !windows.some(
        (window) =>
          isTimestampInAllocationWindow(activityTimestampMs, window) ||
          isTimestampInAllocationWindow(checkoutTimestampMs, window),
      )
    ) {
      continue;
    }
    const dedupeKey = `${asTrimmedString(entry?.logId)}|${boxId}`;
    if (!deduped[dedupeKey]) {
      deduped[dedupeKey] = entry;
    }
  }

  return Object.values(deduped).sort((left, right) => {
    const leftDate = getRollHistoryActivityTimestamp(left);
    const rightDate = getRollHistoryActivityTimestamp(right);
    if (leftDate !== rightDate) {
      return leftDate > rightDate ? -1 : 1;
    }
    const leftLogId = asTrimmedString(left?.logId);
    const rightLogId = asTrimmedString(right?.logId);
    return leftLogId < rightLogId ? 1 : leftLogId > rightLogId ? -1 : 0;
  });
}

async function listRollHistoryForJobAllocations(client: any, orgId: string, allocations: any[]) {
  // Historical roll_weight_log rows may not store job_id, so by-id detail still
  // scopes usage through selected allocation box windows during the transition.
  const boxIds = Object.keys(buildRollHistoryAllocationWindowsByBox(allocations));
  if (!boxIds.length) {
    return [];
  }

  const entries: any[] = [];
  for (const boxId of boxIds) {
    entries.push(...(await listRollHistoryByBox(client, orgId, boxId)));
  }
  return filterRollHistoryForJobAllocations(entries, allocations);
}

function collectJobBoxIds(allocations: any[], rollHistory: any[], filmOrderLinks: any[] = []) {
  const boxIds = new Set<string>();
  for (const entry of Array.isArray(allocations) ? allocations : []) {
    const boxId = asTrimmedString(entry?.boxId).toUpperCase();
    if (boxId) {
      boxIds.add(boxId);
    }
  }
  for (const entry of Array.isArray(rollHistory) ? rollHistory : []) {
    const boxId = asTrimmedString(entry?.boxId).toUpperCase();
    if (boxId) {
      boxIds.add(boxId);
    }
  }
  for (const entry of Array.isArray(filmOrderLinks) ? filmOrderLinks : []) {
    const boxId = asTrimmedString(entry?.boxId).toUpperCase();
    if (boxId) {
      boxIds.add(boxId);
    }
  }
  return Array.from(boxIds);
}

function collectAllocationBoxIds(allocations: any[]) {
  return collectJobBoxIds(allocations, [], []);
}

function indexBoxesById(boxes: any[]) {
  const boxById: Record<string, any> = {};
  for (const box of Array.isArray(boxes) ? boxes : []) {
    const boxId = asTrimmedString(box?.boxId).toUpperCase();
    if (boxId) {
      boxById[boxId] = box;
    }
  }
  return boxById;
}

async function listBoxesByIds(orgId: string, boxIds: string[]) {
  const normalizedBoxIds = Array.from(
    new Set((Array.isArray(boxIds) ? boxIds : []).map((boxId) => asTrimmedString(boxId).toUpperCase()).filter(Boolean)),
  );
  if (!normalizedBoxIds.length) {
    return [];
  }

  const serviceClient = requireServiceRoleClient();
  const rows: any[] = [];
  for (const batchIds of chunkValues(normalizedBoxIds, BOX_TRANSFER_QUERY_BATCH_SIZE)) {
    const { data, error } = await serviceClient
      .schema("app")
      .from("boxes")
      .select("*")
      .eq("org_id", orgId)
      .in("box_id", batchIds);
    throwOnSupabaseError(error, "Unable to load job detail boxes");
    rows.push(...(Array.isArray(data) ? data : []));
  }

  return rows.map((row) => mapDbBoxRow(row)).filter(isPresent);
}

async function listBoxesSnapshotDirect(orgId: string) {
  const serviceClient = requireServiceRoleClient();
  const rows: any[] = [];
  for (let from = 0; ; from += WAREHOUSE_BOX_READ_PAGE_SIZE) {
    const { data, error } = await serviceClient
      .schema("app")
      .from("boxes")
      .select("*")
      .eq("org_id", orgId)
      .order("box_id", { ascending: true })
      .range(from, from + WAREHOUSE_BOX_READ_PAGE_SIZE - 1);
    throwOnSupabaseError(error, "Unable to load report boxes");
    const batch = Array.isArray(data) ? data : [];
    rows.push(...batch);
    if (batch.length < WAREHOUSE_BOX_READ_PAGE_SIZE) {
      break;
    }
  }

  return rows.map((row) => mapDbBoxRow(row)).filter(isPresent);
}

async function listCaulkStockEntries(client: any, orgId: string) {
  const entriesRaw = await rpcOrThrow<any[]>(client, "api_acl_list_caulk_stock", {
    p_org_id: orgId,
    p_warehouse: "",
    p_manufacturer: "",
    p_q: "",
  });

  return (entriesRaw || []).map((entry) => ({
    warehouse: asTrimmedString(entry.warehouse).toUpperCase(),
    productId: asTrimmedString(entry.product_id),
    tubesOnHand: Math.max(0, integerOrZero(entry.tubes_on_hand)),
  }));
}

async function listFilmOrderLinksByFilmOrderIds(orgId: string, filmOrderIds: string[]) {
  const normalizedFilmOrderIds = Array.from(
    new Set((Array.isArray(filmOrderIds) ? filmOrderIds : []).map((filmOrderId) => asTrimmedString(filmOrderId)).filter(Boolean)),
  );
  if (!normalizedFilmOrderIds.length) {
    return [];
  }

  const serviceClient = requireServiceRoleClient();
  const rows: any[] = [];
  for (const batchIds of chunkValues(normalizedFilmOrderIds, BOX_TRANSFER_QUERY_BATCH_SIZE)) {
    const { data, error } = await serviceClient
      .schema("app")
      .from("film_order_box_links")
      .select("link_id, film_order_id, box_id, ordered_feet, auto_allocated_feet, created_at, created_by")
      .eq("org_id", orgId)
      .in("film_order_id", batchIds);
    throwOnSupabaseError(error, "Unable to load film-order linked boxes");
    rows.push(...(Array.isArray(data) ? data : []));
  }

  return rows.map((row) => mapDbFilmOrderLinkRow(row)).filter(isPresent);
}

async function listFilmOrderLinksByBoxIdDirect(orgId: string, boxId: string) {
  const normalizedBoxId = asTrimmedString(boxId).toUpperCase();
  if (!normalizedBoxId) {
    return [];
  }

  const serviceClient = requireServiceRoleClient();
  const { data, error } = await serviceClient
    .schema("app")
    .from("film_order_box_links")
    .select("link_id, film_order_id, box_id, ordered_feet, auto_allocated_feet, created_at, created_by")
    .eq("org_id", orgId)
    .eq("box_id", normalizedBoxId)
    .order("created_at", { ascending: false })
    .order("link_id", { ascending: false });
  throwOnSupabaseError(error, `Unable to load film-order links for box ${normalizedBoxId}`);

  return (Array.isArray(data) ? data : []).map((row) => ({
    linkId: asTrimmedString(row.link_id),
    filmOrderId: asTrimmedString(row.film_order_id),
    boxId: asTrimmedString(row.box_id),
    orderedFeet: integerOrZero(row.ordered_feet),
    autoAllocatedFeet: integerOrZero(row.auto_allocated_feet),
    createdAt: formatTimestamp(row.created_at),
    createdBy: asTrimmedString(row.created_by),
  }));
}

async function listAllocationsByJobIdDirect(orgId: string, jobId: string) {
  const serviceClient = requireServiceRoleClient();
  const { data, error } = await serviceClient
    .schema("app")
    .from("allocations")
    .select("*")
    .eq("org_id", orgId)
    .eq("job_id", jobId)
    .order("created_at", { ascending: false })
    .order("allocation_id", { ascending: false });
  throwOnSupabaseError(error, "Unable to load job allocations by id");
  return (Array.isArray(data) ? data : []).map((row) => mapDbAllocationRow(row)).filter(isPresent);
}

async function listFilmOrdersByJobIdDirect(orgId: string, jobId: string) {
  const serviceClient = requireServiceRoleClient();
  const { data, error } = await serviceClient
    .schema("app")
    .from("film_orders")
    .select("*")
    .eq("org_id", orgId)
    .eq("job_id", jobId)
    .order("created_at", { ascending: false })
    .order("film_order_id", { ascending: false });
  throwOnSupabaseError(error, "Unable to load job film orders by id");
  return (Array.isArray(data) ? data : []).map((row) => mapDbFilmOrderRow(row)).filter(isPresent);
}

async function listJobPhaseRowsByJobIdDirect(orgId: string, jobId: string) {
  const serviceClient = requireServiceRoleClient();
  const { data, error } = await serviceClient
    .schema("app")
    .from("job_phases")
    .select("*")
    .eq("org_id", orgId)
    .eq("job_id", jobId)
    .order("phase_number", { ascending: true })
    .order("created_at", { ascending: true });
  throwOnSupabaseError(error, "Unable to load job phases by id");
  return Array.isArray(data) ? data : [];
}

function indexPhaseRowsById(rows: any[]) {
  const phasesById: Record<string, any> = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const phaseId = asTrimmedString(row?.id);
    if (phaseId) {
      phasesById[phaseId] = row;
    }
  }
  return phasesById;
}

function enrichRequirementRowWithPhase(row: any, phasesById: Record<string, any>) {
  const phase = phasesById[asTrimmedString(row?.phase_id)] || {};
  return {
    ...row,
    phase_number: phase.phase_number,
    phase_sections: phase.sections,
    phase_install_date: phase.install_date,
    phase_install_end_date: phase.install_end_date,
    phase_crew_leader: phase.crew_leader,
  };
}

async function listPlannerSuppressionSignatures(orgId: string, jobId: string, materialType: "FILM" | "CAULK") {
  const serviceClient = requireServiceRoleClient();
  const { data, error } = await serviceClient
    .schema("app")
    .from("allocation_planner_suppressions")
    .select("phase_id, requirement_signature")
    .eq("org_id", orgId)
    .eq("job_id", jobId)
    .eq("material_type", materialType)
    .is("cleared_at", null);
  throwOnSupabaseError(error, `Unable to load ${materialType.toLowerCase()} planner suppressions`);
  return new Set(
    (Array.isArray(data) ? data : [])
      .map((entry: any) => buildSuppressionSignatureKey(entry?.phase_id, entry?.requirement_signature))
      .filter(Boolean),
  );
}

async function listPlannerSuppressionSignaturesByJobId(
  orgId: string,
  jobIds: string[],
  materialType: "FILM" | "CAULK",
) {
  const normalizedJobIds = Array.from(new Set(jobIds.map((entry) => asTrimmedString(entry)).filter(Boolean)));
  const result: Record<string, Set<string>> = {};
  if (!normalizedJobIds.length) {
    return result;
  }

  const serviceClient = requireServiceRoleClient();
  for (const batchIds of chunkValues(normalizedJobIds, BOX_TRANSFER_QUERY_BATCH_SIZE)) {
    const { data, error } = await serviceClient
      .schema("app")
      .from("allocation_planner_suppressions")
      .select("job_id, phase_id, requirement_signature")
      .eq("org_id", orgId)
      .eq("material_type", materialType)
      .is("cleared_at", null)
      .in("job_id", batchIds);
    throwOnSupabaseError(error, `Unable to load ${materialType.toLowerCase()} planner suppressions`);

    for (const entry of Array.isArray(data) ? data : []) {
      const jobId = asTrimmedString(entry?.job_id);
      const signature = asTrimmedString(entry?.requirement_signature);
      if (!jobId || !signature) {
        continue;
      }
      if (!result[jobId]) {
        result[jobId] = new Set<string>();
      }
      result[jobId].add(buildSuppressionSignatureKey(entry?.phase_id, signature));
    }
  }

  return result;
}

function buildSuppressionSignatureKey(phaseId: unknown, signature: unknown) {
  const normalizedSignature = asTrimmedString(signature);
  if (!normalizedSignature) {
    return "";
  }
  return `${asTrimmedString(phaseId)}|${normalizedSignature}`;
}

function hasPlannerSuppression(suppressedSignatures: Set<string>, phaseId: unknown, signature: unknown) {
  const normalizedSignature = asTrimmedString(signature);
  return (
    suppressedSignatures.has(buildSuppressionSignatureKey(phaseId, normalizedSignature)) ||
    suppressedSignatures.has(buildSuppressionSignatureKey("", normalizedSignature))
  );
}

function buildFilmRequirementPlannerSignature(row: any) {
  return `${normalizeJobRequirementLookupKey(
    row?.manufacturer,
    row?.film_name,
    row?.width_in,
  )}|${Math.max(integerOrZero(row?.required_feet), 0)}`;
}

function buildCaulkRequirementPlannerSignature(productId: unknown, warehouse: unknown, requiredTubes: unknown) {
  return [
    asTrimmedString(productId),
    asTrimmedString(warehouse).toUpperCase(),
    String(Math.max(integerOrZero(requiredTubes), 0)),
  ].join("|");
}

async function listJobRequirementsByJobIdDirect(orgId: string, header: any) {
  const jobId = requireString(header?.id, "jobId");
  const serviceClient = requireServiceRoleClient();
  const [phaseRows, requirementsResult] = await Promise.all([
    listJobPhaseRowsByJobIdDirect(orgId, jobId),
    serviceClient
      .schema("app")
      .from("job_requirements")
      .select("*")
      .eq("org_id", orgId)
      .eq("job_id", jobId)
      .order("manufacturer", { ascending: true })
      .order("film_name", { ascending: true })
      .order("width_in", { ascending: true }),
  ]);
  const { data, error } = requirementsResult;
  throwOnSupabaseError(error, "Unable to load job requirements by id");
  const suppressedSignatures = await listPlannerSuppressionSignatures(orgId, jobId, "FILM");
  const phasesById = indexPhaseRowsById(phaseRows);
  return (Array.isArray(data) ? data : [])
    .map((row: any) => ({
      ...enrichRequirementRowWithPhase(row, phasesById),
      job_number: header.jobNumber,
      auto_planning_suppressed: hasPlannerSuppression(
        suppressedSignatures,
        row.phase_id,
        buildFilmRequirementPlannerSignature(row),
      ),
    }))
    .map((row: any) => mapDbRequirementRow(row))
    .filter(isPresent);
}

async function loadCaulkProductsById(orgId: string, productIds: string[]) {
  const normalizedProductIds = Array.from(new Set(productIds.map((entry) => asTrimmedString(entry)).filter(Boolean)));
  if (!normalizedProductIds.length) {
    return {};
  }

  const serviceClient = requireServiceRoleClient();
  const { data: productsRaw, error: productsError } = await serviceClient
    .schema("app")
    .from("caulk_products")
    .select("id, manufacturer_id, name, code, tubes_per_case")
    .eq("org_id", orgId)
    .in("id", normalizedProductIds);
  throwOnSupabaseError(productsError, "Unable to load caulk products for job detail");

  const products = Array.isArray(productsRaw) ? productsRaw : [];
  const manufacturerIds = Array.from(
    new Set(products.map((entry: any) => asTrimmedString(entry?.manufacturer_id)).filter(Boolean)),
  );
  const manufacturersById: Record<string, any> = {};
  if (manufacturerIds.length) {
    const { data: manufacturersRaw, error: manufacturersError } = await serviceClient
      .schema("app")
      .from("caulk_manufacturers")
      .select("id, name")
      .eq("org_id", orgId)
      .in("id", manufacturerIds);
    throwOnSupabaseError(manufacturersError, "Unable to load caulk manufacturers for job detail");
    for (const manufacturer of Array.isArray(manufacturersRaw) ? manufacturersRaw : []) {
      manufacturersById[asTrimmedString(manufacturer?.id)] = manufacturer;
    }
  }

  const productsById: Record<string, any> = {};
  for (const product of products) {
    productsById[asTrimmedString(product?.id)] = {
      ...product,
      manufacturer: manufacturersById[asTrimmedString(product?.manufacturer_id)]?.name || "",
    };
  }
  return productsById;
}

async function listJobCaulkRequirementsByJobIdDirect(orgId: string, header: any) {
  const jobId = requireString(header?.id, "jobId");
  const serviceClient = requireServiceRoleClient();
  const [phaseRows, requirementsResult] = await Promise.all([
    listJobPhaseRowsByJobIdDirect(orgId, jobId),
    serviceClient
      .schema("app")
      .from("job_caulk_requirements")
      .select("id, phase_id, product_id, required_tubes, status, actual_used_tubes, completed_at, completed_by, notes, updated_at")
      .eq("org_id", orgId)
      .eq("job_id", jobId)
      .order("updated_at", { ascending: false }),
  ]);
  const { data, error } = requirementsResult;
  throwOnSupabaseError(error, "Unable to load job caulk requirements by id");

  const rows = Array.isArray(data) ? data : [];
  const phasesById = indexPhaseRowsById(phaseRows);
  const productsById = await loadCaulkProductsById(
    orgId,
    rows.map((row: any) => asTrimmedString(row?.product_id)),
  );
  const suppressedSignatures = await listPlannerSuppressionSignatures(orgId, jobId, "CAULK");

  return rows
    .map((row: any) => {
      const product = productsById[asTrimmedString(row?.product_id)] || {};
      return {
        requirement_id: row.id,
        job_id: jobId,
        phase_id: row.phase_id,
        ...enrichRequirementRowWithPhase(row, phasesById),
        job_number: header.jobNumber,
        product_id: row.product_id,
        manufacturer_id: product.manufacturer_id,
        manufacturer: product.manufacturer || "",
        product_name: product.name,
        product_code: product.code,
        tubes_per_case: product.tubes_per_case,
        required_tubes: row.required_tubes,
        status: row.status,
        actual_used_tubes: row.actual_used_tubes,
        completed_at: row.completed_at,
        completed_by: row.completed_by,
        notes: row.notes,
        updated_at: row.updated_at,
        auto_planning_suppressed: hasPlannerSuppression(
          suppressedSignatures,
          row.phase_id,
          buildCaulkRequirementPlannerSignature(row.product_id, header.warehouse, row.required_tubes),
        ),
      };
    })
    .map((row: any) => mapDbCaulkJobRequirementRow(row))
    .filter(isPresent);
}

async function listJobCaulkRequirementsByJobIdsDirect(orgId: string, headersByJobId: Record<string, any>) {
  const jobIds = Object.keys(headersByJobId).map((entry) => asTrimmedString(entry)).filter(Boolean);
  if (!jobIds.length) {
    return [];
  }

  const serviceClient = requireServiceRoleClient();
  const rows: any[] = [];
  for (const batchIds of chunkValues(jobIds, BOX_TRANSFER_QUERY_BATCH_SIZE)) {
    const { data, error } = await serviceClient
      .schema("app")
      .from("job_caulk_requirements")
      .select("id, job_id, phase_id, product_id, required_tubes, status, actual_used_tubes, completed_at, completed_by, notes, updated_at")
      .eq("org_id", orgId)
      .in("job_id", batchIds)
      .order("updated_at", { ascending: false });
    throwOnSupabaseError(error, "Unable to load job caulk requirements by id");
    rows.push(...(Array.isArray(data) ? data : []));
  }
  const phaseRowsByJobId: Record<string, any[]> = {};
  const phaseRows: any[] = [];
  for (const batchIds of chunkValues(jobIds, BOX_TRANSFER_QUERY_BATCH_SIZE)) {
    const { data, error } = await serviceClient
      .schema("app")
      .from("job_phases")
      .select("*")
      .eq("org_id", orgId)
      .in("job_id", batchIds)
      .order("phase_number", { ascending: true });
    throwOnSupabaseError(error, "Unable to load job phases by id");
    phaseRows.push(...(Array.isArray(data) ? data : []));
  }
  for (const phaseRow of phaseRows) {
    const jobId = asTrimmedString(phaseRow?.job_id);
    if (!jobId) {
      continue;
    }
    if (!phaseRowsByJobId[jobId]) {
      phaseRowsByJobId[jobId] = [];
    }
    phaseRowsByJobId[jobId].push(phaseRow);
  }

  const productsById = await loadCaulkProductsById(
    orgId,
    rows.map((row: any) => asTrimmedString(row?.product_id)),
  );
  const suppressedSignaturesByJobId = await listPlannerSuppressionSignaturesByJobId(orgId, jobIds, "CAULK");

  return rows
    .map((row: any) => {
      const jobId = asTrimmedString(row?.job_id);
      const header = headersByJobId[jobId] || {};
      const product = productsById[asTrimmedString(row?.product_id)] || {};
      const phasesById = indexPhaseRowsById(phaseRowsByJobId[jobId] || []);
      return {
        requirement_id: row.id,
        job_id: jobId,
        phase_id: row.phase_id,
        ...enrichRequirementRowWithPhase(row, phasesById),
        job_number: header.jobNumber,
        product_id: row.product_id,
        manufacturer_id: product.manufacturer_id,
        manufacturer: product.manufacturer || "",
        product_name: product.name,
        product_code: product.code,
        tubes_per_case: product.tubes_per_case,
        required_tubes: row.required_tubes,
        status: row.status,
        actual_used_tubes: row.actual_used_tubes,
        completed_at: row.completed_at,
        completed_by: row.completed_by,
        notes: row.notes,
        updated_at: row.updated_at,
        auto_planning_suppressed: hasPlannerSuppression(
          suppressedSignaturesByJobId[jobId] || new Set<string>(),
          row.phase_id,
          buildCaulkRequirementPlannerSignature(row.product_id, header.warehouse, row.required_tubes),
        ),
      };
    })
    .map((row: any) => mapDbCaulkJobRequirementRow(row))
    .filter(isPresent);
}

async function findPlannerSuppressionRequirementById(
  _client: any,
  orgId: string,
  requirementId: string,
  materialType: string,
) {
  const normalizedMaterialType = asTrimmedString(materialType || "FILM").toUpperCase();
  const serviceClient = requireServiceRoleClient();
  const tableName =
    normalizedMaterialType === "CAULK" ? "job_caulk_requirements" : "job_requirements";
  const { data, error } = await serviceClient
    .schema("app")
    .from(tableName)
    .select("id, job_id")
    .eq("org_id", orgId)
    .eq("id", requirementId)
    .maybeSingle();
  throwOnSupabaseError(error, `Unable to load ${normalizedMaterialType.toLowerCase()} requirement`);
  if (!data) {
    return null;
  }

  const jobId = asTrimmedString((data as Record<string, unknown>).job_id);
  const { data: jobData, error: jobError } = jobId
    ? await serviceClient
      .schema("app")
      .from("jobs")
      .select("job_number")
      .eq("org_id", orgId)
      .eq("id", jobId)
      .maybeSingle()
    : { data: null, error: null };
  throwOnSupabaseError(jobError, "Unable to load requirement job");
  return {
    requirementId: asTrimmedString((data as Record<string, unknown>).id),
    jobId,
    jobNumber: asTrimmedString((jobData as Record<string, unknown> | null)?.job_number),
  };
}

async function listCaulkJobAllocationsByJobIdDirect(orgId: string, jobId: string) {
  const serviceClient = requireServiceRoleClient();
  const { data, error } = await serviceClient
    .schema("app")
    .from("caulk_job_allocations")
    .select("*")
    .eq("org_id", orgId)
    .eq("job_id", jobId)
    .order("created_at", { ascending: false })
    .order("caulk_allocation_id", { ascending: false });
  throwOnSupabaseError(error, "Unable to load caulk job allocations by id");

  const allocations = Array.isArray(data) ? data : [];
  const internalIds = allocations.map((entry: any) => asTrimmedString(entry?.id)).filter(Boolean);
  const productsById = await loadCaulkProductsById(
    orgId,
    allocations.map((entry: any) => asTrimmedString(entry?.product_id)),
  );

  const openCountsByAllocationId: Record<string, number> = {};
  const pendingTransfersByAllocationId: Record<string, any> = {};
  if (internalIds.length) {
    const { data: checkoutsRaw, error: checkoutsError } = await serviceClient
      .schema("app")
      .from("caulk_job_checkouts")
      .select("caulk_allocation_id")
      .eq("org_id", orgId)
      .eq("status", "OPEN")
      .in("caulk_allocation_id", internalIds);
    throwOnSupabaseError(checkoutsError, "Unable to load open caulk checkout counts");
    for (const checkout of Array.isArray(checkoutsRaw) ? checkoutsRaw : []) {
      const allocationId = asTrimmedString(checkout?.caulk_allocation_id);
      openCountsByAllocationId[allocationId] = (openCountsByAllocationId[allocationId] || 0) + 1;
    }

    const { data: transfersRaw, error: transfersError } = await serviceClient
      .schema("app")
      .from("caulk_transfers")
      .select("caulk_allocation_id, transfer_id, source_warehouse, destination_warehouse, pending_tubes, created_at, created_by, notes")
      .eq("org_id", orgId)
      .eq("status", "PENDING")
      .in("caulk_allocation_id", internalIds)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false });
    throwOnSupabaseError(transfersError, "Unable to load pending caulk transfers for job detail");
    for (const transfer of Array.isArray(transfersRaw) ? transfersRaw : []) {
      const allocationId = asTrimmedString(transfer?.caulk_allocation_id);
      if (allocationId && !pendingTransfersByAllocationId[allocationId]) {
        pendingTransfersByAllocationId[allocationId] = transfer;
      }
    }
  }

  return allocations
    .map((allocation: any) => {
      const product = productsById[asTrimmedString(allocation?.product_id)] || {};
      const pendingTransfer = pendingTransfersByAllocationId[asTrimmedString(allocation?.id)] || {};
      return {
        caulk_allocation_id: allocation.caulk_allocation_id,
        requirement_id: allocation.requirement_id,
        job_id: allocation.job_id,
        product_id: allocation.product_id,
        manufacturer_id: product.manufacturer_id,
        manufacturer: product.manufacturer || "",
        product_name: product.name,
        product_code: product.code,
        tubes_per_case: product.tubes_per_case,
        job_number: allocation.job_number,
        warehouse: allocation.warehouse,
        allocated_tubes: allocation.allocated_tubes,
        reserved_tubes_remaining: allocation.reserved_tubes_remaining,
        checked_out_tubes_total: allocation.checked_out_tubes_total,
        returned_unused_tubes_total: allocation.returned_unused_tubes_total,
        used_tubes_total: allocation.used_tubes_total,
        overage_tubes_total: allocation.overage_tubes_total,
        outstanding_checkout_tubes: Math.max(
          integerOrZero(allocation.checked_out_tubes_total) -
            integerOrZero(allocation.returned_unused_tubes_total) -
            integerOrZero(allocation.used_tubes_total),
          0,
        ),
        open_checkout_count: openCountsByAllocationId[asTrimmedString(allocation.id)] || 0,
        pending_transfer_id: pendingTransfer.transfer_id,
        pending_transfer_source_warehouse: pendingTransfer.source_warehouse,
        pending_transfer_destination_warehouse: pendingTransfer.destination_warehouse,
        pending_transfer_tubes: pendingTransfer.pending_tubes,
        pending_transfer_started_at: pendingTransfer.created_at,
        pending_transfer_started_by: pendingTransfer.created_by,
        pending_transfer_notes: pendingTransfer.notes,
        status: allocation.status,
        allocation_source: allocation.allocation_source,
        created_at: allocation.created_at,
        created_by: allocation.created_by,
        updated_at: allocation.updated_at,
        updated_by: allocation.updated_by,
        resolved_at: allocation.resolved_at,
        resolved_by: allocation.resolved_by,
        notes: allocation.notes,
      };
    })
    .map((row: any) => mapDbCaulkJobAllocationRow(row))
    .filter(isPresent);
}

async function listCaulkJobAllocationsByJobIdsDirect(orgId: string, jobIds: string[]) {
  const normalizedJobIds = Array.from(new Set(jobIds.map((entry) => asTrimmedString(entry)).filter(Boolean)));
  if (!normalizedJobIds.length) {
    return [];
  }

  const serviceClient = requireServiceRoleClient();
  const allocations: any[] = [];
  for (const batchIds of chunkValues(normalizedJobIds, BOX_TRANSFER_QUERY_BATCH_SIZE)) {
    const { data, error } = await serviceClient
      .schema("app")
      .from("caulk_job_allocations")
      .select("*")
      .eq("org_id", orgId)
      .in("job_id", batchIds)
      .order("created_at", { ascending: false })
      .order("caulk_allocation_id", { ascending: false });
    throwOnSupabaseError(error, "Unable to load caulk job allocations by id");
    allocations.push(...(Array.isArray(data) ? data : []));
  }

  const internalIds = allocations.map((entry: any) => asTrimmedString(entry?.id)).filter(Boolean);
  const productsById = await loadCaulkProductsById(
    orgId,
    allocations.map((entry: any) => asTrimmedString(entry?.product_id)),
  );
  const openCountsByAllocationId: Record<string, number> = {};
  const pendingTransfersByAllocationId: Record<string, any> = {};

  for (const batchIds of chunkValues(internalIds, BOX_TRANSFER_QUERY_BATCH_SIZE)) {
    const { data: checkoutsRaw, error: checkoutsError } = await serviceClient
      .schema("app")
      .from("caulk_job_checkouts")
      .select("caulk_allocation_id")
      .eq("org_id", orgId)
      .eq("status", "OPEN")
      .in("caulk_allocation_id", batchIds);
    throwOnSupabaseError(checkoutsError, "Unable to load open caulk checkout counts");
    for (const checkout of Array.isArray(checkoutsRaw) ? checkoutsRaw : []) {
      const allocationId = asTrimmedString(checkout?.caulk_allocation_id);
      openCountsByAllocationId[allocationId] = (openCountsByAllocationId[allocationId] || 0) + 1;
    }

    const { data: transfersRaw, error: transfersError } = await serviceClient
      .schema("app")
      .from("caulk_transfers")
      .select("caulk_allocation_id, transfer_id, source_warehouse, destination_warehouse, pending_tubes, created_at, created_by, notes")
      .eq("org_id", orgId)
      .eq("status", "PENDING")
      .in("caulk_allocation_id", batchIds)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false });
    throwOnSupabaseError(transfersError, "Unable to load pending caulk transfers for job detail");
    for (const transfer of Array.isArray(transfersRaw) ? transfersRaw : []) {
      const allocationId = asTrimmedString(transfer?.caulk_allocation_id);
      if (allocationId && !pendingTransfersByAllocationId[allocationId]) {
        pendingTransfersByAllocationId[allocationId] = transfer;
      }
    }
  }

  return allocations
    .map((allocation: any) => {
      const product = productsById[asTrimmedString(allocation?.product_id)] || {};
      const pendingTransfer = pendingTransfersByAllocationId[asTrimmedString(allocation?.id)] || {};
      return {
        caulk_allocation_id: allocation.caulk_allocation_id,
        requirement_id: allocation.requirement_id,
        job_id: allocation.job_id,
        product_id: allocation.product_id,
        manufacturer_id: product.manufacturer_id,
        manufacturer: product.manufacturer || "",
        product_name: product.name,
        product_code: product.code,
        tubes_per_case: product.tubes_per_case,
        job_number: allocation.job_number,
        warehouse: allocation.warehouse,
        allocated_tubes: allocation.allocated_tubes,
        reserved_tubes_remaining: allocation.reserved_tubes_remaining,
        checked_out_tubes_total: allocation.checked_out_tubes_total,
        returned_unused_tubes_total: allocation.returned_unused_tubes_total,
        used_tubes_total: allocation.used_tubes_total,
        overage_tubes_total: allocation.overage_tubes_total,
        outstanding_checkout_tubes: Math.max(
          integerOrZero(allocation.checked_out_tubes_total) -
            integerOrZero(allocation.returned_unused_tubes_total) -
            integerOrZero(allocation.used_tubes_total),
          0,
        ),
        open_checkout_count: openCountsByAllocationId[asTrimmedString(allocation.id)] || 0,
        pending_transfer_id: pendingTransfer.transfer_id,
        pending_transfer_source_warehouse: pendingTransfer.source_warehouse,
        pending_transfer_destination_warehouse: pendingTransfer.destination_warehouse,
        pending_transfer_tubes: pendingTransfer.pending_tubes,
        pending_transfer_started_at: pendingTransfer.created_at,
        pending_transfer_started_by: pendingTransfer.created_by,
        pending_transfer_notes: pendingTransfer.notes,
        status: allocation.status,
        allocation_source: allocation.allocation_source,
        created_at: allocation.created_at,
        created_by: allocation.created_by,
        updated_at: allocation.updated_at,
        updated_by: allocation.updated_by,
        resolved_at: allocation.resolved_at,
        resolved_by: allocation.resolved_by,
        notes: allocation.notes,
      };
    })
    .map((row: any) => mapDbCaulkJobAllocationRow(row))
    .filter(isPresent);
}

async function listCaulkJobCheckoutsByJobIdDirect(orgId: string, jobId: string) {
  const serviceClient = requireServiceRoleClient();
  const { data: allocationRowsRaw, error: allocationRowsError } = await serviceClient
    .schema("app")
    .from("caulk_job_allocations")
    .select("id, caulk_allocation_id")
    .eq("org_id", orgId)
    .eq("job_id", jobId);
  throwOnSupabaseError(allocationRowsError, "Unable to resolve caulk allocation ids for checkouts");

  const publicByInternalAllocationId: Record<string, string> = {};
  for (const allocation of Array.isArray(allocationRowsRaw) ? allocationRowsRaw : []) {
    publicByInternalAllocationId[asTrimmedString(allocation?.id)] = asTrimmedString(allocation?.caulk_allocation_id);
  }

  const internalIds = Object.keys(publicByInternalAllocationId).filter(Boolean);
  if (!internalIds.length) {
    return [];
  }

  const { data, error } = await serviceClient
    .schema("app")
    .from("caulk_job_checkouts")
    .select("*")
    .eq("org_id", orgId)
    .in("caulk_allocation_id", internalIds)
    .order("checked_out_at", { ascending: false })
    .order("caulk_checkout_id", { ascending: false });
  throwOnSupabaseError(error, "Unable to load caulk job checkouts by id");

  const checkouts = Array.isArray(data) ? data : [];
  const productsById = await loadCaulkProductsById(
    orgId,
    checkouts.map((entry: any) => asTrimmedString(entry?.product_id)),
  );

  return checkouts
    .map((checkout: any) => {
      const product = productsById[asTrimmedString(checkout?.product_id)] || {};
      return {
        caulk_checkout_id: checkout.caulk_checkout_id,
        caulk_allocation_id: publicByInternalAllocationId[asTrimmedString(checkout.caulk_allocation_id)] || "",
        product_id: checkout.product_id,
        manufacturer_id: product.manufacturer_id,
        manufacturer: product.manufacturer || "",
        product_name: product.name,
        product_code: product.code,
        tubes_per_case: product.tubes_per_case,
        warehouse: checkout.warehouse,
        checkout_tubes: checkout.checkout_tubes,
        overage_tubes: checkout.overage_tubes,
        status: checkout.status,
        checked_out_at: checkout.checked_out_at,
        checked_out_by: checkout.checked_out_by,
        checked_in_at: checkout.checked_in_at,
        checked_in_by: checkout.checked_in_by,
        unused_tubes: checkout.unused_tubes,
        used_tubes: checkout.used_tubes,
        notes: checkout.notes,
      };
    })
    .map((row: any) => mapDbCaulkJobCheckoutRow(row))
    .filter(isPresent);
}

function buildJobStagingValidationState(params: {
  jobNumber: string;
  warehouse: string;
  allocations: any[];
  filmOrders: any[];
  requirements: any[];
  caulkRequirements: any[];
  caulkAllocations: any[];
  boxes: any[];
  pendingTransfersByBoxRecordId: Record<string, any>;
}) {
  const boxById = indexBoxesById(params.boxes);
  const publicRequirements = buildPublicJobRequirementEntries(
    params.requirements,
    params.allocations,
    boxById,
  );
  const publicCaulkRequirements = buildPublicCaulkRequirementEntries(
    params.caulkRequirements,
    params.caulkAllocations,
    {
      jobNumber: params.jobNumber,
      jobWarehouse: params.warehouse,
    },
  );
  const filmTransferAlerts = buildJobFilmTransferAlerts(
    params.warehouse,
    params.allocations,
    boxById,
    params.pendingTransfersByBoxRecordId,
  );
  const caulkTransferAlerts = buildJobCaulkTransferAlerts(
    params.warehouse,
    params.caulkAllocations,
  );

  return {
    jobNumber: params.jobNumber,
    warehouse: params.warehouse,
    allocations: params.allocations,
    filmOrders: params.filmOrders,
    requirements: params.requirements,
    caulkRequirements: params.caulkRequirements,
    caulkAllocations: params.caulkAllocations,
    boxes: params.boxes,
    boxById,
    pendingTransfersByBoxRecordId: params.pendingTransfersByBoxRecordId,
    publicRequirements,
    publicCaulkRequirements,
    filmTransferAlerts,
    caulkTransferAlerts,
    blockingReason: getJobStagingBlockingReason(
      publicRequirements,
      publicCaulkRequirements,
      params.allocations,
      params.filmOrders,
      params.caulkAllocations,
      filmTransferAlerts,
      caulkTransferAlerts,
      boxById,
    ),
  };
}

async function loadJobStagingValidationState(
  client: any,
  orgId: string,
  jobNumber: string,
  warehouse: string,
  seedData: Record<string, any> = {},
) {
  const [allocations, filmOrders, requirements, caulkRequirements, caulkAllocations] = await Promise.all([
    Array.isArray(seedData.allocations)
      ? seedData.allocations
      : listAllocationsByJob(client, orgId, jobNumber),
    Array.isArray(seedData.filmOrders)
      ? seedData.filmOrders
      : listFilmOrdersByJob(client, orgId, jobNumber),
    Array.isArray(seedData.requirements)
      ? seedData.requirements
      : listJobRequirementsByJob(client, orgId, jobNumber),
    Array.isArray(seedData.caulkRequirements)
      ? seedData.caulkRequirements
      : listJobCaulkRequirementsByJob(client, orgId, jobNumber),
    Array.isArray(seedData.caulkAllocations)
      ? seedData.caulkAllocations
      : listCaulkJobAllocationsByJob(client, orgId, jobNumber),
  ]);
  const boxes = Array.isArray(seedData.boxes)
    ? seedData.boxes
    : await listBoxesByIds(orgId, collectAllocationBoxIds(allocations));
  const pendingTransfersByBoxRecordId =
    seedData.pendingTransfersByBoxRecordId ??
    (boxes.length
      ? indexPendingBoxTransfersByBoxRecordId(
          await listPendingBoxTransfersByBoxRecordIds(
            client,
            orgId,
            boxes.map((box) => box.id).filter(Boolean),
          ),
        )
      : {});

  return buildJobStagingValidationState({
    jobNumber,
    warehouse,
    allocations,
    filmOrders,
    requirements,
    caulkRequirements,
    caulkAllocations,
    boxes,
    pendingTransfersByBoxRecordId,
  });
}

function mapDbFilmOrderLinkRow(row: any) {
  if (!row) {
    return null;
  }

  return {
    linkId: asTrimmedString(row.link_id),
    filmOrderId: asTrimmedString(row.film_order_id),
    boxId: asTrimmedString(row.box_id).toUpperCase(),
    orderedFeet: integerOrZero(row.ordered_feet),
    autoAllocatedFeet: integerOrZero(row.auto_allocated_feet),
    createdAt: formatTimestamp(row.created_at),
    createdBy: asTrimmedString(row.created_by),
  };
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

async function listWarehouseBoxIdPrefixes(client: any, orgId: string) {
  const warehouseRows = await rpcOrThrow<any[]>(client, "api_acl_list_warehouses", {
    p_org_id: orgId,
  });

  return (warehouseRows || [])
    .map((row) => asTrimmedString(row.box_id_prefix).toUpperCase() || asTrimmedString(row.code).toUpperCase())
    .filter(Boolean);
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
  return buildSharedTransferredBoxId(boxId, sourcePrefix, destinationPrefix);
}

function requireBoxRecordId(box: any, operation: string) {
  const boxRecordId = asTrimmedString(box?.id);
  if (boxRecordId) {
    return boxRecordId;
  }

  const boxId = asTrimmedString(box?.boxId).toUpperCase() || "unknown box";
  throw new HttpError(
    500,
    `Internal box identity could not be resolved for ${boxId} while ${operation}.`,
  );
}

async function findBoxByRecordId(client: any, orgId: string, boxRecordId: string) {
  if (!boxRecordId) {
    return null;
  }

  const serviceClient = requireServiceRoleClient();
  const { data, error } = await serviceClient
    .schema("app")
    .from("boxes")
    .select("id, box_id")
    .eq("org_id", orgId)
    .eq("id", boxRecordId)
    .maybeSingle();
  throwOnSupabaseError(error, "Unable to load box");

  const boxId = asTrimmedString((data || {}).box_id);
  if (!boxId) {
    return null;
  }

  const box = await findBoxById(client, orgId, boxId);
  if (!box) {
    return null;
  }

  const internalId = asTrimmedString((data || {}).id);
  if (internalId && !asTrimmedString(box.id)) {
    return {
      ...box,
      id: internalId,
    };
  }

  return box;
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

  const transfers = await listBoxTransfersByBoxRecordId(
    client,
    orgId,
    requireBoxRecordId(box, "loading box transfer history"),
  );
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

async function findPendingBoxTransferByDestinationBoxId(client: any, orgId: string, destinationBoxId: string) {
  const normalizedDestinationBoxId = requireString(destinationBoxId, "DestinationBoxID").toUpperCase();
  const serviceClient = requireServiceRoleClient();
  const { data, error } = await serviceClient
    .schema("app")
    .from("box_transfers")
    .select("*")
    .eq("org_id", orgId)
    .eq("status", "PENDING")
    .eq("destination_box_id", normalizedDestinationBoxId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  throwOnSupabaseError(error, "Unable to load pending destination transfer");
  return mapDbBoxTransferRow(data);
}

async function listPendingBoxTransfersByBoxRecordIds(client: any, orgId: string, boxRecordIds: string[]) {
  const normalizedIds = Array.from(new Set((Array.isArray(boxRecordIds) ? boxRecordIds : []).filter(Boolean)));
  if (!normalizedIds.length) {
    return [];
  }

  const serviceClient = requireServiceRoleClient();
  const rows: any[] = [];

  for (const batchIds of chunkValues(normalizedIds, BOX_TRANSFER_QUERY_BATCH_SIZE)) {
    const { data, error } = await serviceClient
      .schema("app")
      .from("box_transfers")
      .select("*")
      .eq("org_id", orgId)
      .eq("status", "PENDING")
      .in("box_record_id", batchIds)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false });
    throwOnSupabaseError(error, "Unable to load pending transfers");

    if (Array.isArray(data) && data.length > 0) {
      rows.push(...data);
    }
  }

  rows.sort((left, right) => {
    const createdAtDelta = formatTimestamp(right.created_at).localeCompare(formatTimestamp(left.created_at));
    if (createdAtDelta !== 0) {
      return createdAtDelta;
    }

    return Number(right.id || 0) - Number(left.id || 0);
  });

  return rows.map(mapDbBoxTransferRow);
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

async function buildPendingTransfersByBoxRecordId(client: any, orgId: string, boxes: any[]) {
  return indexPendingBoxTransfersByBoxRecordId(
    await listPendingBoxTransfersByBoxRecordIds(
      client,
      orgId,
      Array.from(
        new Set(
          (Array.isArray(boxes) ? boxes : [])
            .filter((box) => asTrimmedString(box?.status).toUpperCase() === "TRANSFER" && box?.id)
            .map((box) => box.id),
        ),
      ),
    ),
  );
}

async function resolveAllocationJobWarehouse(
  client: any,
  orgId: string,
  jobNumber: unknown,
  explicitJobWarehouse: unknown,
  selectedJob: any = null,
) {
  const explicitWarehouse = normalizeOptionalWarehouse(explicitJobWarehouse, "JobWarehouse");
  if (explicitWarehouse) {
    return explicitWarehouse;
  }

  if (selectedJob?.warehouse) {
    return asTrimmedString(selectedJob.warehouse).toUpperCase();
  }

  const normalizedJobNumber = asTrimmedString(jobNumber);
  const existingJob = normalizedJobNumber ? await findJobByNumber(client, orgId, normalizedJobNumber) : null;
  if (existingJob?.warehouse) {
    return asTrimmedString(existingJob.warehouse).toUpperCase();
  }

  if (!normalizedJobNumber) {
    return "";
  }

  const allocations = await listAllocationsByJob(client, orgId, normalizedJobNumber);
  const filmOrders = await listFilmOrdersByJob(client, orgId, normalizedJobNumber);
  return asTrimmedString(buildLegacyJobHeaderFromData(normalizedJobNumber, allocations, filmOrders).warehouse).toUpperCase();
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
    received_by: asTrimmedString(transfer.receivedBy),
    cancelled_at: asTrimmedString(transfer.cancelledAt) || null,
    cancelled_by: asTrimmedString(transfer.cancelledBy),
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

async function findBoxIdConflict(
  client: any,
  orgId: string,
  boxId: string,
  { excludedBoxRecordId = "", excludedTransferId = "" }: { excludedBoxRecordId?: string; excludedTransferId?: string } = {},
) {
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
    return {
      conflictType: "box",
      conflictBoxId: normalizedBoxId,
    };
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
        return null;
      }
    }
  }

  if (aliasRow) {
    return {
      conflictType: "alias",
      conflictBoxId: asTrimmedString((aliasRow as Record<string, unknown>).canonical_box_id).toUpperCase() || normalizedBoxId,
    };
  }

  const pendingTransfer = await findPendingBoxTransferByDestinationBoxId(client, orgId, normalizedBoxId);
  if (
    pendingTransfer &&
    asTrimmedString(pendingTransfer.transferId) !== asTrimmedString(excludedTransferId)
  ) {
    return {
      conflictType: "pending_transfer",
      conflictBoxId: asTrimmedString(pendingTransfer.destinationBoxId).toUpperCase() || normalizedBoxId,
    };
  }

  return null;
}

async function boxIdOrAliasExists(client: any, orgId: string, boxId: string, excludedBoxRecordId = "") {
  return Boolean(await findBoxIdConflict(client, orgId, boxId, { excludedBoxRecordId }));
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

function buildCaulkTransferAlertMessage(alerts: any[], context: "staging" | "checkout") {
  if (!Array.isArray(alerts) || alerts.length === 0) {
    return "";
  }

  const actionLabel = context === "staging" ? "staging this job" : "checking out this job";
  return `Receive transferred caulk before ${actionLabel}.`;
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

function getCaulkAllocationTransferDeficit(allocation: any) {
  return Math.max(
    integerOrZero(allocation?.allocatedTubes) -
      integerOrZero(allocation?.checkedOutTubesTotal) -
      integerOrZero(allocation?.reservedTubesRemaining),
    0,
  );
}

function buildJobCaulkTransferAlerts(jobWarehouse: unknown, caulkAllocations: any[]) {
  const normalizedJobWarehouse = asTrimmedString(jobWarehouse).toUpperCase();
  if (!normalizedJobWarehouse) {
    return [];
  }

  const entries = Array.isArray(caulkAllocations) ? caulkAllocations : [];
  const alerts: any[] = [];

  for (const allocation of entries) {
    if (!allocation || asTrimmedString(allocation.status).toUpperCase() !== "ACTIVE") {
      continue;
    }

    const pendingTransfer = allocation.pendingTransfer || null;
    const shortageTubes = pendingTransfer
      ? integerOrZero(pendingTransfer.pendingTubes)
      : getCaulkAllocationTransferDeficit(allocation);
    if (shortageTubes <= 0) {
      continue;
    }

    alerts.push({
      caulkAllocationId: asTrimmedString(allocation.caulkAllocationId),
      productId: asTrimmedString(allocation.productId),
      manufacturer: asTrimmedString(allocation.manufacturer),
      productName: asTrimmedString(allocation.productName),
      productCode: asTrimmedString(allocation.productCode),
      sourceWarehouse: pendingTransfer
        ? asTrimmedString(pendingTransfer.sourceWarehouse).toUpperCase()
        : "",
      destinationWarehouse: normalizedJobWarehouse,
      pendingTubes: shortageTubes,
      state: pendingTransfer ? "TRANSFER_PENDING" : "NEEDS_TRANSFER",
      transferId: pendingTransfer ? asTrimmedString(pendingTransfer.transferId) : "",
      startedAt: pendingTransfer ? asTrimmedString(pendingTransfer.startedAt) : "",
      startedBy: pendingTransfer ? asTrimmedString(pendingTransfer.startedBy) : "",
    });
  }

  return alerts;
}

function toUsageTimestampSortValue(entry: any) {
  return getRollHistoryActivityTimestamp(entry);
}

function resolveTrustedRollHistoryFeet(entry: any) {
  const feetBefore = integerOrZero(entry?.feetBefore);
  const feetAfter = integerOrZero(entry?.feetAfter);
  const hasTrustedFeet = feetBefore > 0 || feetAfter > 0;

  if (!hasTrustedFeet) {
    return {
      feetBefore: null,
      feetAfter: null,
      usedFeet: null,
    };
  }

  return {
    feetBefore,
    feetAfter,
    usedFeet: Math.max(feetBefore - feetAfter, 0),
  };
}

function deriveOpenFilmCheckoutFeet(box: any): number {
  if (!box) {
    return 0;
  }

  if (
    box.directToJobSite === true &&
    !asTrimmedString(box.receivedDate) &&
    numericOrNull(box.lastRollWeightLbs) === null
  ) {
    return integerOrZero(box.initialFeet);
  }

  const lastRollWeightLbs = numericOrNull(box.lastRollWeightLbs);
  const coreWeightLbs = numericOrNull(box.coreWeightLbs);
  const lfWeightLbsPerFt = numericOrNull(box.lfWeightLbsPerFt);
  if (
    lastRollWeightLbs !== null &&
    coreWeightLbs !== null &&
    lfWeightLbsPerFt !== null &&
    lfWeightLbsPerFt > 0
  ) {
    const rawFeet = roundToDecimals((lastRollWeightLbs - coreWeightLbs) / lfWeightLbsPerFt, 2);
    if (rawFeet <= 0) {
      return 0;
    }
    return Math.min(Math.floor(rawFeet), integerOrZero(box.initialFeet));
  }

  return integerOrZero(box.feetAvailable);
}

function buildPublicJobUsageEntries(rollHistoryEntries: any[], boxById: Record<string, any>) {
  const grouped: Record<string, any> = {};
  const entries = Array.isArray(rollHistoryEntries) ? rollHistoryEntries : [];

  for (const entry of entries) {
    if (!entry || !entry.boxId) {
      continue;
    }

    const usageFeet = resolveTrustedRollHistoryFeet(entry);
    const usedFeet = usageFeet.usedFeet ?? 0;
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

const PROD_PROJECT_REF = "tiwpulgvxtwlmqdnyuzd";

function getCaulkRequirementId(requirement: any): string {
  return asTrimmedString(requirement?.requirementId || requirement?.id);
}

function getCaulkAllocationId(allocation: any, index = 0): string {
  return asTrimmedString(allocation?.caulkAllocationId || allocation?.allocationId || allocation?.id || `allocation-${index}`);
}

function getCaulkAllocationOutstandingCheckoutTubes(allocation: any): number {
  const storedOutstanding = integerOrZero(allocation?.outstandingCheckoutTubes);
  if (storedOutstanding > 0) {
    return storedOutstanding;
  }

  return Math.max(
    0,
    integerOrZero(allocation?.checkedOutTubesTotal) -
      integerOrZero(allocation?.returnedUnusedTubesTotal) -
      integerOrZero(allocation?.usedTubesTotal),
  );
}

export function getCaulkAllocationCoverageTubes(allocation: any): number {
  const allocatedTubes = integerOrZero(allocation?.allocatedTubes);
  if (allocatedTubes <= 0 || asTrimmedString(allocation?.status).toUpperCase() === "CANCELLED") {
    return 0;
  }

  const committedTubes =
    integerOrZero(allocation?.reservedTubesRemaining) +
    getCaulkAllocationOutstandingCheckoutTubes(allocation) +
    integerOrZero(allocation?.usedTubesTotal);

  return Math.min(allocatedTubes, Math.max(0, committedTubes));
}

function caulkFallbackProductLabel(entry: any): string {
  return [entry?.manufacturer, entry?.productName, entry?.productCode]
    .map(asTrimmedString)
    .filter(Boolean)
    .join(" ");
}

function compareCaulkFallbackRequirements(left: any, right: any): number {
  const leftOrder = Number.isFinite(left?._coverageOrder) ? left._coverageOrder : 0;
  const rightOrder = Number.isFinite(right?._coverageOrder) ? right._coverageOrder : 0;
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }
  return compareCatalogStrings(getCaulkRequirementId(left), getCaulkRequirementId(right));
}

function compareCaulkFallbackAllocations(left: any, right: any): number {
  const createdCompare = compareCatalogStrings(left?.createdAt, right?.createdAt);
  if (createdCompare !== 0) {
    return createdCompare;
  }
  return compareCatalogStrings(getCaulkAllocationId(left), getCaulkAllocationId(right));
}

function buildCaulkFallbackRequirementGroupKey(productId: unknown, jobNumber: unknown): string {
  return `${asTrimmedString(productId)}|${normalizeJobNumberKey(jobNumber)}`;
}

function caulkAllocationMatchesJob(allocation: any, expectedJobNumber: unknown): boolean {
  const normalizedExpectedJobNumber = normalizeJobNumberKey(expectedJobNumber);
  return !normalizedExpectedJobNumber || normalizeJobNumberKey(allocation?.jobNumber) === normalizedExpectedJobNumber;
}

function caulkAllocationMatchesWarehouse(allocation: any, expectedWarehouse: unknown): boolean {
  const normalizedExpectedWarehouse = asTrimmedString(expectedWarehouse).toUpperCase();
  const allocationWarehouse = asTrimmedString(allocation?.warehouse).toUpperCase();
  return !normalizedExpectedWarehouse || !allocationWarehouse || allocationWarehouse === normalizedExpectedWarehouse;
}

function addCaulkCoverageTubes(coverageByRequirementId: Record<string, number>, requirementId: unknown, tubes: unknown) {
  const normalizedRequirementId = asTrimmedString(requirementId);
  if (!normalizedRequirementId) {
    return;
  }
  coverageByRequirementId[normalizedRequirementId] =
    integerOrZero(coverageByRequirementId[normalizedRequirementId]) + Math.max(0, integerOrZero(tubes));
}

function isTruthyEnvFlag(value: unknown): boolean {
  return ["1", "true", "yes", "on"].includes(asTrimmedString(value).toLowerCase());
}

function readDenoEnv(name: string): string {
  try {
    return asTrimmedString(Deno.env.get(name));
  } catch (_error) {
    return "";
  }
}

function extractSupabaseProjectRef(value: unknown): string {
  const rawValue = asTrimmedString(value);
  if (!rawValue) {
    return "";
  }
  try {
    const url = new URL(rawValue);
    const directMatch = url.hostname.match(/^([a-z0-9]{20})\.supabase\.co$/i);
    if (directMatch) {
      return directMatch[1];
    }
    const dbMatch = url.hostname.match(/^db\.([a-z0-9]{20})\.supabase\.co$/i);
    if (dbMatch) {
      return dbMatch[1];
    }
    return url.hostname.includes(PROD_PROJECT_REF) ? PROD_PROJECT_REF : "";
  } catch (_error) {
    return rawValue.includes(PROD_PROJECT_REF) ? PROD_PROJECT_REF : "";
  }
}

function caulkFallbackDebugIsProd(env: Record<string, unknown> | null = null): boolean {
  const hasExplicitEnv = env !== null;
  const readEnv = (name: string) => (hasExplicitEnv ? env?.[name] : readDenoEnv(name));
  const appEnvValues = [readEnv("APP_ENV"), readEnv("NODE_ENV"), readEnv("VERCEL_ENV")]
    .map((value) => asTrimmedString(value).toLowerCase())
    .filter(Boolean);
  if (appEnvValues.some((value) => value === "prod" || value === "production")) {
    return true;
  }

  const projectRefs = [readEnv("SUPABASE_PROJECT_REF"), readEnv("PROJECT_REF")]
    .map(asTrimmedString)
    .filter(Boolean);
  if (projectRefs.includes(PROD_PROJECT_REF)) {
    return true;
  }

  return (
    extractSupabaseProjectRef(readEnv("SUPABASE_URL") || (hasExplicitEnv ? "" : SUPABASE_URL)) === PROD_PROJECT_REF ||
    extractSupabaseProjectRef(readEnv("DATABASE_URL") || readEnv("SUPABASE_DB_URL")) === PROD_PROJECT_REF
  );
}

export function isCaulkFallbackDebugLoggingEnabled(env: Record<string, unknown> | null = null): boolean {
  const flagValue = env === null ? readDenoEnv("DEV_CAULK_FALLBACK_DEBUG_LOGS") : env?.DEV_CAULK_FALLBACK_DEBUG_LOGS;
  return isTruthyEnvFlag(flagValue) &&
    !caulkFallbackDebugIsProd(env);
}

export function buildCaulkFallbackDebugLogEntry(input: any, runtime = "supabase-edge") {
  return {
    level: "debug",
    msg: "caulk_fallback_coverage",
    runtime,
    allocationId: asTrimmedString(input?.allocationId),
    jobNumber: asTrimmedString(input?.jobNumber),
    productId: asTrimmedString(input?.productId),
    product: asTrimmedString(input?.product),
    tubesApplied: Math.max(0, integerOrZero(input?.tubesApplied)),
    requirementIdsFulfilled: Array.isArray(input?.requirementIdsFulfilled)
      ? input.requirementIdsFulfilled.map(asTrimmedString).filter(Boolean)
      : [],
  };
}

export function maybeLogCaulkFallbackCoverageDecision(
  input: any,
  options: { env?: Record<string, unknown> | null; logger?: (message: string) => void; runtime?: string } = {},
) {
  const env = options.env || null;
  if (!isCaulkFallbackDebugLoggingEnabled(env)) {
    return null;
  }

  const entry = buildCaulkFallbackDebugLogEntry(input, options.runtime || "supabase-edge");
  if (!entry.allocationId || !entry.jobNumber || entry.tubesApplied <= 0 || entry.requirementIdsFulfilled.length === 0) {
    return null;
  }

  try {
    const logger = options.logger || console.log;
    logger(JSON.stringify(entry));
  } catch (_error) {
    // Diagnostics must never affect coverage or API behavior.
  }
  return entry;
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

export function buildCaulkCoverageByRequirementId(
  caulkRequirements: any[],
  caulkAllocations: any[],
  options: {
    jobNumber?: unknown;
    jobWarehouse?: unknown;
    debugEnv?: Record<string, unknown> | null;
    debugLogger?: (message: string) => void;
    debugRuntime?: string;
  } = {},
) {
  const totals: Record<string, number> = {};
  const requirementById: Record<string, { requirement: any; jobNumber: string }> = {};
  const requirementsByFallbackGroup: Record<string, any[]> = {};
  const expectedJobNumber = normalizeJobNumberKey(options.jobNumber);

  const requirements = Array.isArray(caulkRequirements) ? caulkRequirements : [];
  for (let index = 0; index < requirements.length; index += 1) {
    const requirement = { ...requirements[index], _coverageOrder: index };
    if (isCaulkRequirementComplete(requirement)) {
      continue;
    }
    const requirementId = getCaulkRequirementId(requirement);
    if (!requirementId) {
      continue;
    }

    const requirementJobNumber = normalizeJobNumberKey(requirement.jobNumber || options.jobNumber);
    requirementById[requirementId] = {
      requirement,
      jobNumber: requirementJobNumber,
    };

    const productId = asTrimmedString(requirement.productId);
    if (!productId) {
      continue;
    }

    const groupKey = buildCaulkFallbackRequirementGroupKey(productId, requirementJobNumber);
    if (!requirementsByFallbackGroup[groupKey]) {
      requirementsByFallbackGroup[groupKey] = [];
    }
    requirementsByFallbackGroup[groupKey].push(requirement);
  }

  for (const groupKey of Object.keys(requirementsByFallbackGroup)) {
    requirementsByFallbackGroup[groupKey].sort(compareCaulkFallbackRequirements);
  }

  const allocations = Array.isArray(caulkAllocations) ? caulkAllocations : [];
  for (const allocation of allocations) {
    const requirementId = asTrimmedString(allocation.requirementId);
    const requirementEntry = requirementId ? requirementById[requirementId] : null;
    const coverageTubes = getCaulkAllocationCoverageTubes(allocation);
    if (
      !requirementEntry ||
      coverageTubes <= 0
    ) {
      continue;
    }

    const requirementJobNumber = expectedJobNumber || requirementEntry.jobNumber;
    if (
      requirementJobNumber &&
      normalizeJobNumberKey(allocation.jobNumber) !== requirementJobNumber
    ) {
      continue;
    }

    if (asTrimmedString(allocation.productId) !== asTrimmedString(requirementEntry.requirement.productId)) {
      continue;
    }

    addCaulkCoverageTubes(totals, requirementId, coverageTubes);
  }

  const fallbackAllocations = allocations
    .filter((allocation) => {
      if (asTrimmedString(allocation?.requirementId)) {
        return false;
      }
      if (asTrimmedString(allocation?.status).toUpperCase() !== "ACTIVE") {
        return false;
      }
      if (!caulkAllocationMatchesJob(allocation, expectedJobNumber)) {
        return false;
      }
      if (!caulkAllocationMatchesWarehouse(allocation, options.jobWarehouse)) {
        return false;
      }
      return getCaulkAllocationCoverageTubes(allocation) > 0;
    })
    .sort(compareCaulkFallbackAllocations);

  for (let index = 0; index < fallbackAllocations.length; index += 1) {
    const allocation = fallbackAllocations[index];
    const allocationJobNumber = normalizeJobNumberKey(allocation.jobNumber || options.jobNumber);
    const productId = asTrimmedString(allocation.productId);
    const matchingRequirements = requirementsByFallbackGroup[
      buildCaulkFallbackRequirementGroupKey(productId, allocationJobNumber || expectedJobNumber)
    ] || [];
    let remainingAllocationTubes = getCaulkAllocationCoverageTubes(allocation);
    const impactedRequirementIds: string[] = [];
    let appliedByAllocation = 0;

    for (let reqIndex = 0; reqIndex < matchingRequirements.length && remainingAllocationTubes > 0; reqIndex += 1) {
      const requirement = matchingRequirements[reqIndex];
      const requirementId = getCaulkRequirementId(requirement);
      const requiredTubes = Math.max(0, integerOrZero(requirement.requiredTubes));
      const coveredBefore = Math.min(requiredTubes, integerOrZero(totals[requirementId]));
      const remainingRequirementTubes = Math.max(0, requiredTubes - coveredBefore);
      if (remainingRequirementTubes <= 0) {
        continue;
      }

      const appliedTubes = Math.min(remainingAllocationTubes, remainingRequirementTubes);
      addCaulkCoverageTubes(totals, requirementId, appliedTubes);
      remainingAllocationTubes -= appliedTubes;
      appliedByAllocation += appliedTubes;
      impactedRequirementIds.push(requirementId);
    }

    if (appliedByAllocation > 0) {
      maybeLogCaulkFallbackCoverageDecision(
        {
          allocationId: getCaulkAllocationId(allocation, index),
          jobNumber: allocation.jobNumber || options.jobNumber,
          productId,
          product: caulkFallbackProductLabel(allocation),
          tubesApplied: appliedByAllocation,
          requirementIdsFulfilled: impactedRequirementIds,
        },
        {
          env: options.debugEnv,
          logger: options.debugLogger,
          runtime: options.debugRuntime || "supabase-edge",
        },
      );
    }
  }

  return totals;
}

export function buildPublicCaulkRequirementEntries(
  caulkRequirements: any[],
  caulkAllocations: any[],
  options: { jobNumber?: unknown; jobWarehouse?: unknown } = {},
) {
  const coverageByRequirementId = buildCaulkCoverageByRequirementId(caulkRequirements, caulkAllocations, options);
  const response = (Array.isArray(caulkRequirements) ? caulkRequirements : []).map((entry) => {
    const requirementId = asTrimmedString(entry.requirementId);
    const requiredTubes = Math.max(0, integerOrZero(entry.requiredTubes));
    const status = normalizeCaulkRequirementState(entry);
    const isComplete = status === "COMPLETE";
    const actualUsedTubes = Math.max(0, integerOrZero(entry.actualUsedTubes));
    const allocatedTubes = Math.max(
      0,
      isComplete ? 0 : Math.min(requiredTubes, integerOrZero(coverageByRequirementId[requirementId] || 0)),
    );
    const remainingTubes = isComplete ? 0 : Math.max(0, requiredTubes - actualUsedTubes - allocatedTubes);
    return {
      requirementId,
      phaseId: asTrimmedString(entry.phaseId),
      phaseNumber: integerOrZero(entry.phaseNumber),
      phaseWorkScope: asTrimmedString(entry.phaseWorkScope),
      phaseInstallDate: asTrimmedString(entry.phaseInstallDate),
      phaseCrewLeader: asTrimmedString(entry.phaseCrewLeader),
      jobNumber: asTrimmedString(entry.jobNumber),
      productId: asTrimmedString(entry.productId),
      manufacturerId: asTrimmedString(entry.manufacturerId),
      manufacturer: asTrimmedString(entry.manufacturer),
      productName: asTrimmedString(entry.productName),
      productCode: asTrimmedString(entry.productCode),
      tubesPerCase: integerOrZero(entry.tubesPerCase),
      requiredTubes,
      status,
      isComplete,
      actualUsedTubes,
      completedAt: asTrimmedString(entry.completedAt),
      completedBy: asTrimmedString(entry.completedBy),
      completionResult: deriveCaulkRequirementCompletionResult(entry, requiredTubes, actualUsedTubes),
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
    if (isCaulkRequirementComplete(entry)) {
      continue;
    }
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
  jobNumber: string,
  rollHistoryEntries: any[],
  boxById: Record<string, any>,
  caulkCheckouts: any[],
  filmOrderLinks: any[] = [],
  filmOrders: any[] = [],
) {
  const response: any[] = [];
  const filmOrderById: Record<string, any> = {};
  const normalizedJobNumber = normalizeJobNumberKey(jobNumber);
  for (const entry of Array.isArray(filmOrders) ? filmOrders : []) {
    const filmOrderId = asTrimmedString(entry?.filmOrderId);
    if (filmOrderId) {
      filmOrderById[filmOrderId] = entry;
    }
  }

  for (const entry of Array.isArray(rollHistoryEntries) ? rollHistoryEntries : []) {
    if (!entry || !entry.boxId) {
      continue;
    }
    const usageFeet = resolveTrustedRollHistoryFeet(entry);
    const usedFeet = usageFeet.usedFeet ?? 0;
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
      jobNumber: asTrimmedString(entry.jobNumber),
      manufacturer: box ? asTrimmedString(box.manufacturer) : asTrimmedString(entry.manufacturer),
      itemName: box ? asTrimmedString(box.filmName) : asTrimmedString(entry.filmName),
      itemCode: "",
      widthIn: box ? numericOrNull(box.widthIn) ?? 0 : numericOrNull(entry.widthIn) ?? 0,
      unit: "LF",
      checkedOutQuantity: usageFeet.feetBefore ?? 0,
      returnedQuantity: usageFeet.feetAfter ?? 0,
      usedQuantity: usedFeet,
      checkedOutAt: asTrimmedString(entry.checkedOutAt),
      checkedInAt: asTrimmedString(entry.checkedInAt),
      checkedOutWeightLbs: numericOrNull(entry.checkedOutWeightLbs),
      checkedInWeightLbs: numericOrNull(entry.checkedInWeightLbs),
      weightDeltaLbs: numericOrNull(entry.weightDeltaLbs),
      feetBefore: usageFeet.feetBefore,
      feetAfter: usageFeet.feetAfter,
      usedLinearFeet: usageFeet.usedFeet,
      notes: asTrimmedString(entry.notes),
    });
  }

  for (const link of Array.isArray(filmOrderLinks) ? filmOrderLinks : []) {
    const boxId = asTrimmedString(link?.boxId).toUpperCase();
    const occurredAt = asTrimmedString(link?.createdAt);
    if (!boxId || !occurredAt) {
      continue;
    }

    const filmOrder = filmOrderById[asTrimmedString(link?.filmOrderId)] || null;
    const box = boxById[boxId] || null;
    response.push({
      usageType: "FILM_ORDER",
      occurredAt,
      actor: asTrimmedString(link?.createdBy),
      warehouse: box ? asTrimmedString(box.warehouse) : asTrimmedString(filmOrder?.warehouse),
      referenceId: boxId,
      jobNumber: asTrimmedString(filmOrder?.jobNumber),
      manufacturer: box ? asTrimmedString(box.manufacturer) : asTrimmedString(filmOrder?.manufacturer),
      itemName: box ? asTrimmedString(box.filmName) : asTrimmedString(filmOrder?.filmName),
      itemCode: "",
      widthIn: box ? numericOrNull(box.widthIn) ?? 0 : numericOrNull(filmOrder?.widthIn) ?? 0,
      unit: "LF",
      checkedOutQuantity: integerOrZero(link?.orderedFeet),
      returnedQuantity: 0,
      usedQuantity: 0,
      notes: "",
    });
  }

  for (const box of Object.values(boxById || {})) {
    if (!box || asTrimmedString((box as any).status).toUpperCase() !== "CHECKED_OUT") {
      continue;
    }

    if (normalizeJobNumberKey((box as any).lastCheckoutJob) !== normalizedJobNumber) {
      continue;
    }

    const boxId = asTrimmedString((box as any).boxId).toUpperCase();
    const checkoutDate = asTrimmedString((box as any).lastCheckoutDate);
    const occurredAt = checkoutDate ? `${checkoutDate}T00:00:00.000Z` : "";
    if (!boxId || !occurredAt) {
      continue;
    }

    const checkedOutQuantity = deriveOpenFilmCheckoutFeet(box);
    response.push({
      usageType: "FILM",
      occurredAt,
      actor: "",
      warehouse: asTrimmedString((box as any).warehouse),
      referenceId: boxId,
      jobNumber: asTrimmedString((box as any).lastCheckoutJob),
      manufacturer: asTrimmedString((box as any).manufacturer),
      itemName: asTrimmedString((box as any).filmName),
      itemCode: "",
      widthIn: numericOrNull((box as any).widthIn) ?? 0,
      unit: "LF",
      checkedOutQuantity,
      returnedQuantity: 0,
      usedQuantity: 0,
      checkedOutAt: occurredAt,
      checkedInAt: "",
      checkedOutWeightLbs: numericOrNull((box as any).lastRollWeightLbs),
      checkedInWeightLbs: null,
      weightDeltaLbs: null,
      feetBefore: checkedOutQuantity > 0 ? checkedOutQuantity : null,
      feetAfter: null,
      usedLinearFeet: null,
      notes: (box as any).directToJobSite === true && !asTrimmedString((box as any).receivedDate)
        ? `DIRECT_TO_SITE_CHECKED_OUT: Box committed directly to job ${asTrimmedString((box as any).lastCheckoutJob)}.`
        : `WAREHOUSE_CHECKOUT: Box checked out from warehouse inventory for job ${asTrimmedString((box as any).lastCheckoutJob)}.`,
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

function isAllocatableBoxStatus(value: unknown) {
  const normalized = asTrimmedString(value).toUpperCase();
  return normalized === "IN_STOCK" || normalized === "ORDERED";
}

function findPendingTransferForBox(box: any, pendingTransfersByBoxRecordId: Record<string, any> = {}) {
  const boxRecordId = asTrimmedString(box?.id);
  if (!boxRecordId) {
    return null;
  }

  return pendingTransfersByBoxRecordId[boxRecordId] || null;
}

function getTransferAllocationBlockReason(box: any, pendingTransfer: any, jobWarehouse: unknown) {
  if (asTrimmedString(box?.status).toUpperCase() !== "TRANSFER") {
    return "";
  }

  const normalizedJobWarehouse = asTrimmedString(jobWarehouse).toUpperCase();
  if (!normalizedJobWarehouse) {
    return `Box ${asTrimmedString(box?.boxId) || "this box"} is in transfer status and needs a job warehouse before it can be allocated.`;
  }

  if (!pendingTransfer || asTrimmedString(pendingTransfer.status).toUpperCase() !== "PENDING") {
    return `Box ${asTrimmedString(box?.boxId) || "this box"} is in transfer status but no pending transfer was found.`;
  }

  const destinationWarehouse = asTrimmedString(pendingTransfer.destinationWarehouse).toUpperCase();
  if (destinationWarehouse !== normalizedJobWarehouse) {
    return `Box ${asTrimmedString(box?.boxId) || "this box"} is transferring to ${destinationWarehouse || "another warehouse"} and cannot be allocated to a job in ${normalizedJobWarehouse}.`;
  }

  return "";
}

function isJobAllocationEligibleBox(box: any, pendingTransfer: any, jobWarehouse: unknown) {
  if (isAllocatableBoxStatus(box?.status)) {
    return true;
  }

  return getTransferAllocationBlockReason(box, pendingTransfer, jobWarehouse) === "";
}

function getAllocationCandidateStatusRank(box: any) {
  const normalizedStatus = asTrimmedString(box?.status).toUpperCase();
  if (normalizedStatus === "IN_STOCK") {
    return 0;
  }

  if (normalizedStatus === "TRANSFER") {
    return 1;
  }

  if (normalizedStatus === "ORDERED") {
    return 2;
  }

  return 3;
}

function computeAllocationPlanningFeet(
  status: unknown,
  initialFeet: unknown,
  feetAvailable: unknown,
  activeAllocatedFeet: unknown,
) {
  const normalizedStatus = asTrimmedString(status).toUpperCase();
  if (normalizedStatus === "IN_STOCK" || normalizedStatus === "TRANSFER") {
    return Math.max(0, integerOrZero(feetAvailable));
  }

  if (normalizedStatus === "ORDERED") {
    return Math.max(0, integerOrZero(initialFeet) - integerOrZero(activeAllocatedFeet));
  }

  return 0;
}

function getBoxAllocationPlanningFeet(box: any, activeAllocationsByBox?: Record<string, any[]>) {
  if (!box) {
    return 0;
  }

  if (activeAllocationsByBox && Object.prototype.hasOwnProperty.call(activeAllocationsByBox, box.boxId)) {
    return buildBoxReservationSnapshot(box, activeAllocationsByBox[box.boxId]).allocatableNowFeet;
  }

  if (
    box.allocatableNowFeet !== undefined &&
    box.allocatableNowFeet !== null &&
    Number.isFinite(Number(box.allocatableNowFeet))
  ) {
    return Math.max(0, integerOrZero(box.allocatableNowFeet));
  }

  const activeAllocatedFeet =
    box.activeAllocatedFeet !== undefined && box.activeAllocatedFeet !== null
      ? integerOrZero(box.activeAllocatedFeet)
      : getActiveAllocationsForBox(box.boxId, activeAllocationsByBox || {}).reduce(
          (sum, entry) => sum + integerOrZero(entry.allocatedFeet),
          0,
        );

  return computeAllocationPlanningFeet(box.status, box.initialFeet, box.feetAvailable, activeAllocatedFeet);
}

function boxUsesOrderedPlanning(box: any) {
  return asTrimmedString(box?.status).toUpperCase() === "ORDERED";
}

function boxCanReceiveReleasedAllocationFeet(box: any) {
  const normalizedStatus = asTrimmedString(box?.status).toUpperCase();
  return normalizedStatus !== "ZEROED" && normalizedStatus !== "RETIRED" && normalizedStatus !== "ORDERED";
}

function hasActiveOrderedAllocations(allocations: any[], boxById: Record<string, any> = {}) {
  return allocations.some(
    (entry) =>
      asTrimmedString(entry?.status).toUpperCase() === "ACTIVE" &&
      boxUsesOrderedPlanning(boxById[asTrimmedString(entry?.boxId)] || null),
  );
}

function hasActiveOrderedRequirementAllocations(allocations: any[], boxById: Record<string, any> = {}) {
  return allocations.some(
    (entry) =>
      asTrimmedString(entry?.status).toUpperCase() === "ACTIVE" &&
      normalizeAllocationKind(entry?.allocationKind) !== "EXTRA" &&
      integerOrZero(entry?.allocatedFeet) > 0 &&
      boxUsesOrderedPlanning(boxById[asTrimmedString(entry?.boxId)] || null),
  );
}

function buildOrderedAllocationReceiptMessage(action: "checkout" | "staging") {
  return action === "checkout"
    ? "Receive ordered film before checking out all materials for this job."
    : "Receive ordered film before staging this job.";
}

function getNextFeetAvailableAfterAllocationRelease(box: any, releasedFeet: unknown) {
  const nextReleasedFeet = Math.max(0, integerOrZero(releasedFeet));
  if (boxUsesOrderedPlanning(box)) {
    return 0;
  }

  if (!boxCanReceiveReleasedAllocationFeet(box)) {
    return integerOrZero(box?.feetAvailable);
  }

  return Math.min(
    integerOrZero(box?.initialFeet),
    Math.max(0, integerOrZero(box?.feetAvailable) + nextReleasedFeet),
  );
}

function shouldIgnoreAllocationCoverageForBoxStatus(allocation: any, box: any) {
  void allocation;
  if (!box) {
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

function createEmptyRequirementCoverageSummary() {
  return {
    allocatedFeet: 0,
    allocatedWithInstallDateFeet: 0,
    allocatedWithoutInstallDateFeet: 0,
  };
}

function ensureRequirementCoverageSummary(
  coverageByRequirementId: Record<string, ReturnType<typeof createEmptyRequirementCoverageSummary>>,
  requirementId: string,
) {
  if (!coverageByRequirementId[requirementId]) {
    coverageByRequirementId[requirementId] = createEmptyRequirementCoverageSummary();
  }

  return coverageByRequirementId[requirementId];
}

function addRequirementCoverageFeet(
  coverageByRequirementId: Record<string, ReturnType<typeof createEmptyRequirementCoverageSummary>>,
  requirementId: string,
  requiredFeet: number,
  reservationState: "WITH_INSTALL_DATE" | "WITHOUT_INSTALL_DATE",
  feet: number,
) {
  const normalizedFeet = Math.max(0, Number(feet || 0));
  if (!requirementId || normalizedFeet <= 0 || requiredFeet <= 0) {
    return 0;
  }

  const summary = ensureRequirementCoverageSummary(coverageByRequirementId, requirementId);
  const remainingCapacity = Math.max(0, requiredFeet - Math.max(0, Number(summary.allocatedFeet || 0)));
  if (remainingCapacity <= 0) {
    return 0;
  }

  const appliedFeet = Math.min(remainingCapacity, normalizedFeet);
  summary.allocatedFeet += appliedFeet;
  if (reservationState === "WITH_INSTALL_DATE") {
    summary.allocatedWithInstallDateFeet += appliedFeet;
  } else {
    summary.allocatedWithoutInstallDateFeet += appliedFeet;
  }

  return appliedFeet;
}

function getRequirementCoverageId(requirement: any, index: number) {
  return asTrimmedString(requirement?.id || requirement?.requirementId) || `generated-${index}`;
}

function findCoverageBoxById(boxById: Record<string, any>, boxId: unknown) {
  const normalizedBoxId = asTrimmedString(boxId);
  if (!normalizedBoxId) {
    return null;
  }

  return boxById[normalizedBoxId] || boxById[normalizedBoxId.toUpperCase()] || null;
}

function requirementEntryMatchesAllocationJob(requirementEntry: any, allocation: any, expectedJobNumber: string) {
  const requirementJobNumber = expectedJobNumber || requirementEntry.jobNumber;
  return !requirementJobNumber || normalizeJobNumberKey(allocation.jobNumber) === requirementJobNumber;
}

function findFallbackCoverageRequirementEntry(
  requirementEntries: any[],
  allocation: any,
  box: any,
  expectedJobNumber: string,
) {
  const matches = requirementEntries.filter((requirementEntry) =>
    requirementEntryMatchesAllocationJob(requirementEntry, allocation, expectedJobNumber) &&
    allocationMatchesRequirement(box, requirementEntry.requirement)
  );

  return matches.length === 1 ? matches[0] : null;
}

function buildAllocationCoverageByRequirementId(
  requirements: any[],
  allocations: any[],
  boxById: Record<string, any>,
  options: { jobNumber?: unknown } = {},
) {
  const coverageByRequirementId: Record<string, ReturnType<typeof createEmptyRequirementCoverageSummary>> = {};
  const requirementById: Record<string, {
    requirement: any;
    requirementId: string;
    jobNumber: string;
    requiredFeet: number;
  }> = {};
  const requirementEntries: any[] = [];
  const expectedJobNumber = normalizeJobNumberKey(options.jobNumber);

  for (let index = 0; index < requirements.length; index += 1) {
    const requirement = requirements[index];
    const requirementId = getRequirementCoverageId(requirement, index);
    const requirementEntry = {
      requirement,
      requirementId,
      jobNumber: normalizeJobNumberKey(requirement.jobNumber || options.jobNumber),
      requiredFeet: Math.max(0, Number(requirement.requiredFeet || 0)),
    };
    requirementById[requirementId] = requirementEntry;
    requirementEntries.push(requirementEntry);
  }

  for (let index = 0; index < allocations.length; index += 1) {
    const allocation = allocations[index];
    const allocationStatus = asTrimmedString(allocation.status).toUpperCase();
    const coveredFeet = getStoredAllocationCoveredFeet(allocation);
    if (
      allocationStatus === "CANCELLED" ||
      coveredFeet <= 0 ||
      normalizeAllocationKind(allocation.allocationKind) === "EXTRA"
    ) {
      continue;
    }

    if (
      expectedJobNumber &&
      normalizeJobNumberKey(allocation.jobNumber) !== expectedJobNumber
    ) {
      continue;
    }

    const box = findCoverageBoxById(boxById, allocation.boxId);
    if (!box || shouldIgnoreAllocationCoverageForBoxStatus(allocation, box)) {
      continue;
    }

    const boundRequirementId = asTrimmedString(allocation.requirementId);
    const requirementEntry =
      (boundRequirementId ? requirementById[boundRequirementId] : null) ||
      findFallbackCoverageRequirementEntry(requirementEntries, allocation, box, expectedJobNumber);
    if (!requirementEntry || !requirementEntryMatchesAllocationJob(requirementEntry, allocation, expectedJobNumber)) {
      continue;
    }

    if (!allocationMatchesRequirement(box, requirementEntry.requirement)) {
      continue;
    }

    addRequirementCoverageFeet(
      coverageByRequirementId,
      requirementEntry.requirementId,
      requirementEntry.requiredFeet,
      getAllocationReservationState(allocation),
      coveredFeet,
    );
  }

  return coverageByRequirementId;
}

function normalizeRequirementState(requirement: any): "ACTIVE" | "COMPLETE" {
  return asTrimmedString(requirement?.status).toUpperCase() === "COMPLETE" ? "COMPLETE" : "ACTIVE";
}

function isRequirementComplete(requirement: any): boolean {
  return normalizeRequirementState(requirement) === "COMPLETE";
}

function deriveRequirementCompletionResult(requirement: any, requiredFeet: number, actualUsedFeet: number): "" | "ON_TARGET" | "OVERUSED" {
  if (!isRequirementComplete(requirement)) {
    return "";
  }

  return integerOrZero(actualUsedFeet) <= integerOrZero(requiredFeet) ? "ON_TARGET" : "OVERUSED";
}

function normalizeCaulkRequirementState(requirement: any): "ACTIVE" | "COMPLETE" {
  return asTrimmedString(requirement?.status).toUpperCase() === "COMPLETE" ? "COMPLETE" : "ACTIVE";
}

function isCaulkRequirementComplete(requirement: any): boolean {
  return normalizeCaulkRequirementState(requirement) === "COMPLETE";
}

function deriveCaulkRequirementCompletionResult(requirement: any, requiredTubes: number, actualUsedTubes: number): "" | "ON_TARGET" | "OVERUSED" {
  if (!isCaulkRequirementComplete(requirement)) {
    return "";
  }

  return integerOrZero(actualUsedTubes) <= integerOrZero(requiredTubes) ? "ON_TARGET" : "OVERUSED";
}

/**
 * PURPOSE:
 * Builds public film requirement coverage rows from stored allocations and
 * attaches planner suppression state for user-paused AUTO planning.
 *
 * AFFECTS:
 * Job detail Film Requirements, status/readiness math, Order actions, and
 * Resume auto-plan UI.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * backend runtimeAllocationCoverage, Supabase requirement read RPCs, frontend
 * jobRequirementCoverage, and planner suppression migration 0086.
 *
 * COMMON FAILURE MODES:
 * Stale remaining LF, backend/frontend status drift, or suppressed
 * requirements being hidden from the user.
 */
export function buildPublicJobRequirementEntries(requirements: any[], allocations: any[], boxById: Record<string, any>) {
  const coverage = buildAllocationCoverageByRequirementId(requirements, allocations, boxById);
  const response = requirements.map((requirement, index) => {
    const requirementId = getRequirementCoverageId(requirement, index);
    const coverageSummary = coverage[requirementId] || createEmptyRequirementCoverageSummary();
    const allocatedFeet = Math.max(0, Number(coverageSummary.allocatedFeet || 0));
    const requiredFeet = Math.max(0, Number(requirement.requiredFeet || 0));
    const status = normalizeRequirementState(requirement);
    const isComplete = status === "COMPLETE";
    const actualUsedFeet = Math.max(0, integerOrZero(requirement.actualUsedFeet));
    const remainingFeet = isComplete ? 0 : Math.max(0, requiredFeet - actualUsedFeet - allocatedFeet);
    const cappedAllocatedFeet = Math.min(requiredFeet, allocatedFeet);
    return {
      requirementId,
      phaseId: asTrimmedString(requirement.phaseId),
      phaseNumber: integerOrZero(requirement.phaseNumber),
      phaseWorkScope: asTrimmedString(requirement.phaseWorkScope),
      phaseInstallDate: asTrimmedString(requirement.phaseInstallDate),
      phaseCrewLeader: asTrimmedString(requirement.phaseCrewLeader),
      manufacturer: requirement.manufacturer,
      filmName: requirement.filmName,
      widthIn: requirement.widthIn,
      requiredFeet,
      status,
      isComplete,
      actualUsedFeet,
      completedAt: asTrimmedString(requirement.completedAt),
      completedBy: asTrimmedString(requirement.completedBy),
      completionResult: deriveRequirementCompletionResult(requirement, requiredFeet, actualUsedFeet),
      allocatedFeet: cappedAllocatedFeet,
      allocatedWithInstallDateFeet: Math.min(
        cappedAllocatedFeet,
        Math.max(0, Number(coverageSummary.allocatedWithInstallDateFeet || 0)),
      ),
      allocatedWithoutInstallDateFeet: Math.min(
        cappedAllocatedFeet,
        Math.max(0, Number(coverageSummary.allocatedWithoutInstallDateFeet || 0)),
      ),
      remainingFeet,
      autoPlanningSuppressed: requirement.autoPlanningSuppressed === true,
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

function isOpenMaterialFilmOrder(entry: any) {
  const status = asTrimmedString(entry?.status).toUpperCase();
  return status === "FILM_ORDER" || status === "FILM_ON_THE_WAY";
}

function getRequirementId(requirement: any): string {
  return asTrimmedString(requirement?.requirementId || requirement?.id);
}

function getEntryPhaseId(entry: any): string {
  return asTrimmedString(entry?.phaseId || entry?.phase_id);
}

function getPhaseDisplayWorkScope(phase: any, fallback: unknown = null) {
  return phase?.workScope ?? phase?.sections ?? fallback;
}

function todayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

function indexReadinessBoxes(allBoxes: any[], boxById: Record<string, any> = {}) {
  const response: Record<string, any> = { ...(boxById || {}) };
  for (const box of Array.isArray(allBoxes) ? allBoxes : []) {
    const boxId = asTrimmedString(box?.boxId);
    if (!boxId) {
      continue;
    }

    response[boxId] = box;
    response[boxId.toUpperCase()] = box;
  }

  return response;
}


function filmOrderMatchesRequirement(filmOrder: any, requirement: any): boolean {
  const orderRequirementId = asTrimmedString(filmOrder?.requirementId);
  const requirementId = asTrimmedString(requirement?.requirementId || requirement?.id);
  const productMatches = planningFilmCanSatisfyRequirement(
    filmOrder?.manufacturer,
    filmOrder?.filmName,
    requirement?.manufacturer,
    requirement?.filmName,
  ) && Number(filmOrder?.widthIn || 0) === Number(requirement?.widthIn || 0);

  if (orderRequirementId || requirementId) {
    return Boolean(orderRequirementId && requirementId && orderRequirementId === requirementId && productMatches);
  }

  return productMatches;
}

function getFilmOnTheWayFeetForRequirement(filmOrders: any[], requirement: any): number {
  let total = 0;
  for (const entry of Array.isArray(filmOrders) ? filmOrders : []) {
    if (asTrimmedString(entry?.status).toUpperCase() !== "FILM_ON_THE_WAY") {
      continue;
    }
    if (!filmOrderMatchesRequirement(entry, requirement)) {
      continue;
    }
    // FILM_ON_THE_WAY coverage prefers approved ordered LF; requested LF is a legacy fallback.
    const orderedFeet = integerOrZero(entry.orderedFeet);
    total += orderedFeet > 0 ? orderedFeet : integerOrZero(entry.requestedFeet);
  }
  return total;
}

function areFilmShortagesFullyOnTheWay(requirements: any[], filmOrders: any[]): boolean {
  for (const requirement of Array.isArray(requirements) ? requirements : []) {
    if (isRequirementComplete(requirement)) {
      continue;
    }
    const missingFeet = Math.max(
      0,
      integerOrZero(requirement?.requiredFeet) -
        integerOrZero(requirement?.actualUsedFeet) -
        integerOrZero(requirement?.allocatedFeet),
    );
    if (missingFeet > 0 && getFilmOnTheWayFeetForRequirement(filmOrders, requirement) < missingFeet) {
      return false;
    }
  }
  return true;
}

function deriveInStockReadinessStatus(params: {
  jobNumber?: unknown;
  lifecycleStatus: unknown;
  isLaborOnly: boolean;
  requirements: any[];
  caulkRequirements: any[];
  allocations: any[];
  caulkAllocations: any[];
  filmOrders: any[];
  allBoxes: any[];
  boxById?: Record<string, any>;
  caulkStockEntries: any[];
  jobWarehouse: unknown;
}) {
  /**
   * PURPOSE:
   * Mirrors backend READY/FILM_ORDER derivation for Supabase Edge reads using
   * canonical caulk coverage: requirement-linked allocations first, then
   * deterministic same-product fallback for unbound caulk allocations.
   *
   * AFFECTS:
   * Supabase job list/detail APIs, allocation summaries, calendar/search reads,
   * and optimistic frontend reconciliation that trusts returned status pills.
   *
   * WHEN CHANGING THIS, ALSO CHECK:
   * backend runtimeJobSummaries.mjs, frontend jobSummaryMath/jobCalendar, and
   * canonical film/caulk allocation coverage helpers.
   *
   * COMMON FAILURE MODES:
   * Trusting stale remaining values, counting stale requirement IDs, double
   * counting fallback caulk allocations, or local backend and Edge status drift.
   */
  void params.caulkStockEntries;
  const normalizedLifecycleStatus = normalizeJobLifecycleStatus(params.lifecycleStatus);
  if (normalizedLifecycleStatus === "CANCELLED") {
    return "CANCELLED";
  }

  if (normalizedLifecycleStatus === "COMPLETED") {
    return "COMPLETED";
  }

  const requirements = Array.isArray(params.requirements) ? params.requirements : [];
  const caulkRequirements = Array.isArray(params.caulkRequirements) ? params.caulkRequirements : [];
  const filmOrders = Array.isArray(params.filmOrders) ? params.filmOrders : [];
  const hasMaterialRequirements =
    requirements.some((entry) => !isRequirementComplete(entry) && integerOrZero(entry?.requiredFeet) > 0) ||
    caulkRequirements.some((entry) => !isCaulkRequirementComplete(entry) && integerOrZero(entry?.requiredTubes) > 0);

  if (!hasMaterialRequirements) {
    if (params.isLaborOnly || requirements.length || caulkRequirements.length) {
      return "READY";
    }
    if (!filmOrders.some(isOpenMaterialFilmOrder)) {
      return "READY";
    }
    if (filmOrders.some((entry) => asTrimmedString(entry?.status).toUpperCase() === "FILM_ORDER")) {
      return "FILM_ORDER";
    }
    return "ORDERED";
  }

  const readinessBoxById = indexReadinessBoxes(params.allBoxes, params.boxById || {});
  const filmCoverageByRequirementId = buildAllocationCoverageByRequirementId(
    requirements,
    params.allocations,
    readinessBoxById,
    { jobNumber: params.jobNumber },
  );
  const caulkCoverageByRequirementId = buildCaulkCoverageByRequirementId(
    caulkRequirements,
    params.caulkAllocations,
    { jobNumber: params.jobNumber, jobWarehouse: params.jobWarehouse },
  );
  const filmReady = requirements.every((requirement) => {
    if (isRequirementComplete(requirement)) {
      return true;
    }
    const requiredFeet = integerOrZero(requirement?.requiredFeet);
    if (requiredFeet <= 0) {
      return true;
    }

    const requirementId = getRequirementId(requirement);
    if (!requirementId) {
      return false;
    }

    return integerOrZero(filmCoverageByRequirementId[requirementId]?.allocatedFeet) >= requiredFeet;
  });
  const caulkReady = caulkRequirements.every((requirement) => {
    if (isCaulkRequirementComplete(requirement)) {
      return true;
    }
    const requiredTubes = integerOrZero(requirement?.requiredTubes);
    if (requiredTubes <= 0) {
      return true;
    }

    const requirementId = getRequirementId(requirement);
    if (!requirementId) {
      return false;
    }

    return integerOrZero(caulkCoverageByRequirementId[requirementId]) >= requiredTubes;
  });

  if (filmReady && caulkReady) {
    return "READY";
  }

  const filmOrdered = requirements.every((requirement) => {
    if (isRequirementComplete(requirement)) {
      return true;
    }
    const requiredFeet = integerOrZero(requirement?.requiredFeet);
    if (requiredFeet <= 0) {
      return true;
    }
    const requirementId = getRequirementId(requirement);
    if (!requirementId) {
      return false;
    }
    const actualUsedFeet = integerOrZero(requirement?.actualUsedFeet);
    const allocatedFeet = integerOrZero(filmCoverageByRequirementId[requirementId]?.allocatedFeet);
    const missingFeet = Math.max(0, requiredFeet - actualUsedFeet - Math.min(allocatedFeet, requiredFeet));
    return missingFeet <= 0 || getFilmOnTheWayFeetForRequirement(filmOrders, requirement) >= missingFeet;
  });

  return caulkReady && filmOrdered ? "ORDERED" : "FILM_ORDER";
}

function resolveAllocationJobMetadata(allocations: any[], filmOrders: any[]) {
  let installDate = "";
  let crewLeader = "";
  for (const allocation of allocations) {
    if (!installDate && allocation.installDate) {
      installDate = allocation.installDate;
    }
    if (!crewLeader && allocation.crewLeader) {
      crewLeader = allocation.crewLeader;
    }
  }
  for (const filmOrder of filmOrders) {
    if (!installDate && filmOrder.installDate) {
      installDate = filmOrder.installDate;
    }
    if (!crewLeader && filmOrder.crewLeader) {
      crewLeader = filmOrder.crewLeader;
    }
  }
  return { installDate, crewLeader };
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
  fallbackInstallDate = "",
  fallbackCrewLeader = "",
  boxById: Record<string, any> = {},
  jobId = "",
  workScope: string | null = null,
) {
  const metadata = resolveAllocationJobMetadata(allocations, filmOrders);
  let hasFilmOrder = false;
  let hasFilmOnTheWay = false;
  let hasActiveAllocation = false;
  let hasCancelledRecord = false;
  let hasFulfilledRecord = false;
  let activeAllocatedFeet = 0;
  let allocatedWithInstallDateFeet = 0;
  let allocatedWithoutInstallDateFeet = 0;
  let fulfilledAllocatedFeet = 0;
  let openFilmOrderCount = 0;
  const distinctBoxes: Record<string, boolean> = {};
  const normalizedLifecycleStatus = normalizeJobLifecycleStatus(lifecycleStatus);
  const caulkTotals = summarizeCaulkRequirementCoverage(caulkRequirements);
  const hasMaterialRequirements =
    requirements.some((entry) => !isRequirementComplete(entry) && integerOrZero(entry?.requiredFeet) > 0) ||
    caulkRequirements.some((entry) => integerOrZero(entry?.requiredTubes) > 0);
  const hasOrderedAllocations = hasActiveOrderedAllocations(allocations, boxById);

  for (const requirement of requirements) {
    if (isRequirementComplete(requirement)) {
      continue;
    }
    allocatedWithInstallDateFeet += Math.max(0, Number(requirement?.allocatedWithInstallDateFeet || 0));
    allocatedWithoutInstallDateFeet += Math.max(0, Number(requirement?.allocatedWithoutInstallDateFeet || 0));
  }

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
    const hasRemainingCaulk = caulkRequirements.some(
      (entry) => !isCaulkRequirementComplete(entry) && Math.max(0, Number(entry.remainingTubes || 0)) > 0,
    );
    if (!hasRemainingFilm && !hasRemainingCaulk) {
      status = "READY";
    } else if (!hasRemainingCaulk && areFilmShortagesFullyOnTheWay(requirements, filmOrders)) {
      status = "ORDERED";
    } else {
      status = "FILM_ORDER";
    }
  } else if (isLaborOnly || requirements.length || caulkRequirements.length) {
    status = "READY";
  } else if (hasFilmOrder) {
    status = "FILM_ORDER";
  } else if (hasFilmOnTheWay) {
    status = "ORDERED";
  } else if (hasActiveAllocation) {
    status = "READY";
  } else if (hasCancelledRecord) {
    status = "CANCELLED";
  } else if (hasFulfilledRecord) {
    status = "COMPLETED";
  }

  return {
    jobId,
    jobNumber,
    workScope: asTrimmedString(workScope) || null,
    sections: asTrimmedString(workScope) || null,
    installDate: metadata.installDate || fallbackInstallDate,
    crewLeader: metadata.crewLeader || fallbackCrewLeader,
    status,
    activeAllocatedFeet,
    allocatedWithInstallDateFeet,
    allocatedWithoutInstallDateFeet,
    fulfilledAllocatedFeet,
    requiredTubes: caulkTotals.requiredTubes,
    allocatedTubes: caulkTotals.allocatedTubes,
    remainingTubes: caulkTotals.remainingTubes,
    openFilmOrderCount,
    boxCount: Object.keys(distinctBoxes).length,
    hasOrderedAllocations,
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
    workScope: null,
    sections: null,
    installDate: metadata.installDate,
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
  return "FILM_ORDER";
}

function computeJobStatusFromRequirements(
  lifecycleStatus: string,
  isLaborOnly: boolean,
  isStagedForPickup: boolean,
  requirements: any[],
  caulkRequirements: any[],
  allocations: any[],
  filmOrders: any[],
  options: {
    allBoxes?: any[];
    boxById?: Record<string, any>;
    caulkAllocations?: any[];
    caulkStockEntries?: any[];
    jobNumber?: unknown;
    jobWarehouse?: unknown;
  } = {},
) {
  void isStagedForPickup;
  return deriveInStockReadinessStatus({
    lifecycleStatus,
    isLaborOnly,
    requirements,
    caulkRequirements,
    allocations,
    caulkAllocations: options.caulkAllocations || [],
    filmOrders,
    allBoxes: options.allBoxes || [],
    boxById: options.boxById || {},
    caulkStockEntries: options.caulkStockEntries || [],
    jobNumber: options.jobNumber || "",
    jobWarehouse: options.jobWarehouse || "",
  });
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
  caulkTransferAlerts: any[] = [],
  boxById: Record<string, any> = {},
) {
  const hasMaterialRequirements =
    requirements.some((entry) => !isRequirementComplete(entry) && integerOrZero(entry.requiredFeet) > 0) ||
    caulkRequirements.some((entry) => !isCaulkRequirementComplete(entry) && integerOrZero(entry.requiredTubes) > 0);
  if (!hasMaterialRequirements) {
    return "";
  }
  const hasRemainingFilm = requirements.some((entry) => integerOrZero(entry.remainingFeet) > 0);
  const hasRemainingCaulk = caulkRequirements.some(
    (entry) => !isCaulkRequirementComplete(entry) && integerOrZero(entry.remainingTubes) > 0,
  );
  if (hasRemainingFilm || hasRemainingCaulk) {
    return "All required film and caulk must be fully allocated before staging this job.";
  }
  if (filmTransferAlerts.length > 0 && caulkTransferAlerts.length > 0) {
    return "Receive transferred film and caulk before staging this job.";
  }
  if (filmTransferAlerts.length > 0) {
    return buildFilmTransferAlertMessage(filmTransferAlerts, "staging");
  }
  if (caulkTransferAlerts.length > 0) {
    return buildCaulkTransferAlertMessage(caulkTransferAlerts, "staging");
  }
  if (hasActiveOrderedRequirementAllocations(allocations, boxById)) {
    return buildOrderedAllocationReceiptMessage("staging");
  }
  if (hasUncheckedOutCaulkAllocations(caulkAllocations)) {
    return "All required caulk must be checked out before staging this job.";
  }
  return "";
}

function buildFallbackJobPhase(jobHeader: any) {
  return {
    phaseId: "",
    phaseNumber: 1,
    workScope: jobHeader.workScope ?? jobHeader.sections ?? null,
    sections: jobHeader.sections ?? jobHeader.workScope ?? null,
    installDate: jobHeader.installDate || "",
    crewLeader: jobHeader.crewLeader || "",
    laborStatus: "ACTIVE",
    isPrimary: true,
    createdAt: jobHeader.createdAt || "",
    updatedAt: jobHeader.updatedAt || "",
  };
}

function filterEntriesForPhase(entries: any[], phase: any, fallbackPhaseId = "") {
  const phaseId = asTrimmedString(phase?.phaseId);
  const fallbackId = asTrimmedString(fallbackPhaseId);
  return (Array.isArray(entries) ? entries : []).filter((entry) => {
    const entryPhaseId = getEntryPhaseId(entry);
    if (phaseId) {
      return entryPhaseId === phaseId || (!entryPhaseId && fallbackId === phaseId);
    }
    return !entryPhaseId;
  });
}

function filterRequirementLinkedEntriesForPhase(
  entries: any[],
  phase: any,
  requirementIds: Set<string>,
  fallbackPhaseId = "",
) {
  const phaseId = asTrimmedString(phase?.phaseId);
  const fallbackId = asTrimmedString(fallbackPhaseId);
  const scopedRequirementIds = requirementIds instanceof Set ? requirementIds : new Set<string>();
  return (Array.isArray(entries) ? entries : []).filter((entry) => {
    const entryPhaseId = getEntryPhaseId(entry);
    if (entryPhaseId) {
      return entryPhaseId === phaseId || (!phaseId && !entryPhaseId);
    }

    const requirementId = getRequirementId(entry);
    if (requirementId) {
      return scopedRequirementIds.has(requirementId);
    }

    return Boolean(phaseId && fallbackId === phaseId);
  });
}

function isPhaseCompleteFromRequirements(phase: any, requirements: any[], caulkRequirements: any[] = []) {
  const filmRequirements = Array.isArray(requirements) ? requirements : [];
  const caulkEntries = Array.isArray(caulkRequirements) ? caulkRequirements : [];
  if (filmRequirements.length > 0 || caulkEntries.length > 0) {
    return (
      filmRequirements.every((entry) => isRequirementComplete(entry)) &&
      caulkEntries.every((entry) => isCaulkRequirementComplete(entry))
    );
  }
  return asTrimmedString(phase?.laborStatus || phase?.status).toUpperCase() === "COMPLETE";
}

function comparePhasesByNumber(left: any, right: any): number {
  const leftNumber = integerOrZero(left?.phaseNumber) || 1;
  const rightNumber = integerOrZero(right?.phaseNumber) || 1;
  if (leftNumber !== rightNumber) {
    return leftNumber - rightNumber;
  }
  return compareCatalogStrings(left?.phaseId, right?.phaseId);
}

function chooseNextRelevantPhaseGroup(phases: any[]) {
  const incomplete = (Array.isArray(phases) ? phases : []).filter((phase) => !phase.isComplete).slice();
  if (!incomplete.length) {
    return [];
  }
  const today = todayDateString();
  const dated = incomplete.filter((phase) => asTrimmedString(phase.installDate));
  const pastOrToday = dated
    .filter((phase) => asTrimmedString(phase.installDate) <= today)
    .sort((left, right) => left.installDate !== right.installDate ? (left.installDate < right.installDate ? -1 : 1) : comparePhasesByNumber(left, right));
  const future = dated
    .filter((phase) => asTrimmedString(phase.installDate) > today)
    .sort((left, right) => left.installDate !== right.installDate ? (left.installDate < right.installDate ? -1 : 1) : comparePhasesByNumber(left, right));
  const source = pastOrToday.length ? pastOrToday : future.length ? future : incomplete.sort(comparePhasesByNumber);
  const first = source[0];
  const installDate = asTrimmedString(first.installDate);
  return installDate ? source.filter((phase) => asTrimmedString(phase.installDate) === installDate) : [first];
}

function combinePhaseGroupStatus(phases: any[]) {
  const statuses = (Array.isArray(phases) ? phases : []).map((phase) => asTrimmedString(phase.status).toUpperCase());
  if (statuses.includes("FILM_ORDER")) {
    return "FILM_ORDER";
  }
  if (statuses.includes("ORDERED")) {
    return "ORDERED";
  }
  if (statuses.includes("COMPLETED")) {
    return "COMPLETED";
  }
  return "READY";
}

function buildJobPhaseEntries(
  jobHeader: any,
  phases: any[],
  requirements: any[],
  allocations: any[],
  filmOrders: any[],
  caulkRequirements: any[],
  caulkAllocations: any[],
  boxById: Record<string, any>,
  options: { allBoxes?: any[]; caulkStockEntries?: any[] } = {},
) {
  const phaseSource = Array.isArray(phases) && phases.length ? phases.slice().sort(comparePhasesByNumber) : [buildFallbackJobPhase(jobHeader)];
  const fallbackPhaseId = asTrimmedString(phaseSource.find((entry) => entry.isPrimary)?.phaseId || phaseSource[0]?.phaseId);
  const entries = phaseSource.map((phase, index) => {
    const phaseRequirements = filterEntriesForPhase(requirements, phase, fallbackPhaseId);
    const phaseCaulkRequirements = filterEntriesForPhase(caulkRequirements, phase, fallbackPhaseId);
    const phaseRequirementIds = new Set(phaseRequirements.map((entry) => getRequirementId(entry)).filter(Boolean));
    const phaseCaulkRequirementIds = new Set(
      phaseCaulkRequirements.map((entry) => getRequirementId(entry)).filter(Boolean),
    );
    const phaseAllocations = filterRequirementLinkedEntriesForPhase(
      allocations,
      phase,
      phaseRequirementIds,
      fallbackPhaseId,
    );
    const phaseCaulkAllocations = filterRequirementLinkedEntriesForPhase(
      caulkAllocations,
      phase,
      phaseCaulkRequirementIds,
      fallbackPhaseId,
    );
    const phaseFilmOrders = filterRequirementLinkedEntriesForPhase(
      filmOrders,
      phase,
      phaseRequirementIds,
      fallbackPhaseId,
    );
    const isComplete = isPhaseCompleteFromRequirements(phase, phaseRequirements, phaseCaulkRequirements);
    const status = isComplete
      ? "COMPLETED"
      : deriveInStockReadinessStatus({
          lifecycleStatus: jobHeader.lifecycleStatus,
          isLaborOnly: !phaseRequirements.length && !phaseCaulkRequirements.length,
          requirements: phaseRequirements,
          caulkRequirements: phaseCaulkRequirements,
          allocations: phaseAllocations,
          caulkAllocations: phaseCaulkAllocations,
          filmOrders: phaseFilmOrders,
          allBoxes: options.allBoxes || Object.values(boxById || {}),
          boxById,
          caulkStockEntries: options.caulkStockEntries || [],
          jobWarehouse: jobHeader.warehouse || "",
          jobNumber: jobHeader.jobNumber || "",
        });
    let requiredFeet = 0;
    let allocatedFeet = 0;
    let allocatedWithInstallDateFeet = 0;
    let allocatedWithoutInstallDateFeet = 0;
    let remainingFeet = 0;
    for (const requirement of phaseRequirements) {
      if (isRequirementComplete(requirement)) {
        continue;
      }
      requiredFeet += integerOrZero(requirement.requiredFeet);
      allocatedFeet += integerOrZero(requirement.allocatedFeet);
      allocatedWithInstallDateFeet += integerOrZero(requirement.allocatedWithInstallDateFeet);
      allocatedWithoutInstallDateFeet += integerOrZero(requirement.allocatedWithoutInstallDateFeet);
      remainingFeet += integerOrZero(requirement.remainingFeet);
    }
    const caulkTotals = summarizeCaulkRequirementCoverage(isComplete ? [] : phaseCaulkRequirements);
    return {
      phaseId: asTrimmedString(phase.phaseId || phase.id),
      phaseNumber: integerOrZero(phase.phaseNumber) || index + 1,
      workScope: getPhaseDisplayWorkScope(phase, jobHeader.workScope ?? jobHeader.sections ?? null),
      sections: getPhaseDisplayWorkScope(phase, jobHeader.sections ?? jobHeader.workScope ?? null),
      installDate: asTrimmedString(phase.installDate),
      installEndDate: asTrimmedString(phase.installEndDate),
      crewLeader: asTrimmedString(phase.crewLeader),
      laborStatus: asTrimmedString(phase.laborStatus || phase.status).toUpperCase() === "COMPLETE" ? "COMPLETE" : "ACTIVE",
      status,
      isComplete,
      isPrimary: phase.isPrimary === true || (!phase.isPrimary && index === 0),
      requiredFeet,
      allocatedFeet,
      allocatedWithInstallDateFeet,
      allocatedWithoutInstallDateFeet,
      remainingFeet,
      requiredTubes: caulkTotals.requiredTubes,
      allocatedTubes: caulkTotals.allocatedTubes,
      remainingTubes: caulkTotals.remainingTubes,
      requirementCount: phaseRequirements.length,
      caulkRequirementCount: phaseCaulkRequirements.length,
      filmOrderCount: countUnresolvedFilmOrders(phaseFilmOrders),
      allocationCount: phaseAllocations.length,
      createdAt: asTrimmedString(phase.createdAt),
      updatedAt: asTrimmedString(phase.updatedAt),
    };
  });
  const currentGroup = chooseNextRelevantPhaseGroup(entries);
  const currentIds = new Set(currentGroup.map((entry) => asTrimmedString(entry.phaseId)));
  return entries.map((entry) => ({
    ...entry,
    isNextRelevant: currentIds.has(asTrimmedString(entry.phaseId)),
    isExpandedByDefault: currentIds.has(asTrimmedString(entry.phaseId)) || (!entry.isComplete && !entry.installDate),
  }));
}

function buildJobListEntry(
  jobHeader: any,
  requirements: any[],
  allocations: any[],
  filmOrders: any[],
  caulkRequirements: any[] = [],
  boxById: Record<string, any> = {},
  options: {
    allBoxes?: any[];
    boxById?: Record<string, any>;
    caulkAllocations?: any[];
    caulkStockEntries?: any[];
    jobWarehouse?: unknown;
    phases?: any[];
  } = {},
) {
  const metadata = resolveAllocationJobMetadata(allocations, filmOrders);
  const phaseEntries = buildJobPhaseEntries(
    jobHeader,
    options.phases || [],
    requirements,
    allocations,
    filmOrders,
    caulkRequirements,
    options.caulkAllocations || [],
    boxById,
    options,
  );
  const nextPhaseGroup = chooseNextRelevantPhaseGroup(phaseEntries);
  const currentPhase = nextPhaseGroup[0] || phaseEntries[0] || null;
  let installDate = asTrimmedString(currentPhase?.installDate) || jobHeader.installDate;
  if (!installDate) {
    installDate = metadata.installDate;
  }
  const installEndDate = asTrimmedString(currentPhase?.installEndDate);
  const crewLeader = asTrimmedString(currentPhase?.crewLeader) || asTrimmedString(jobHeader.crewLeader) || metadata.crewLeader;
  let requiredFeet = 0;
  let allocatedFeet = 0;
  let allocatedWithInstallDateFeet = 0;
  let allocatedWithoutInstallDateFeet = 0;
  let remainingFeet = 0;
  const summaryRequirements = nextPhaseGroup.length
    ? requirements.filter((entry) => nextPhaseGroup.some((phase) => asTrimmedString(phase.phaseId) === getEntryPhaseId(entry)))
    : requirements;
  const summaryCaulkRequirements = nextPhaseGroup.length
    ? caulkRequirements.filter((entry) =>
        nextPhaseGroup.some((phase) => asTrimmedString(phase.phaseId) === getEntryPhaseId(entry)),
      )
    : caulkRequirements;
  const caulkTotals = nextPhaseGroup.length
    ? {
        requiredTubes: nextPhaseGroup.reduce((sum, phase) => sum + integerOrZero(phase.requiredTubes), 0),
        allocatedTubes: nextPhaseGroup.reduce((sum, phase) => sum + integerOrZero(phase.allocatedTubes), 0),
        remainingTubes: nextPhaseGroup.reduce((sum, phase) => sum + integerOrZero(phase.remainingTubes), 0),
      }
    : summarizeCaulkRequirementCoverage(caulkRequirements);
  for (const requirement of summaryRequirements) {
    if (isRequirementComplete(requirement)) {
      continue;
    }
    requiredFeet += requirement.requiredFeet;
    allocatedFeet += requirement.allocatedFeet;
    allocatedWithInstallDateFeet += Math.max(0, Number(requirement.allocatedWithInstallDateFeet || 0));
    allocatedWithoutInstallDateFeet += Math.max(0, Number(requirement.allocatedWithoutInstallDateFeet || 0));
    remainingFeet += requirement.remainingFeet;
  }
  const effectiveLifecycleStatus =
    jobHeader && jobHeader.id
      ? resolveEffectiveJobLifecycleStatus(jobHeader.lifecycleStatus, allocations, filmOrders)
      : deriveLegacyLifecycleStatus(allocations, filmOrders);
  const status = nextPhaseGroup.length
    ? combinePhaseGroupStatus(nextPhaseGroup)
    : computeJobStatusFromRequirements(
        effectiveLifecycleStatus,
        Boolean(jobHeader.isLaborOnly),
        Boolean(jobHeader.isStagedForPickup),
        summaryRequirements,
        summaryCaulkRequirements,
        allocations,
        filmOrders,
        {
          allBoxes: options.allBoxes || Object.values(boxById || {}),
          boxById: options.boxById || boxById,
          caulkAllocations: options.caulkAllocations || [],
          caulkStockEntries: options.caulkStockEntries || [],
          jobNumber: jobHeader.jobNumber || "",
          jobWarehouse: options.jobWarehouse || jobHeader.warehouse || "",
        },
      );
  const primaryWorkScope = jobHeader.workScope ?? jobHeader.sections ?? null;
  const workScope = getPhaseDisplayWorkScope(currentPhase, primaryWorkScope);

  return {
    jobId: jobHeader.id || "",
    jobNumber: jobHeader.jobNumber,
    warehouse: jobHeader.warehouse || "",
    workScope,
    primaryWorkScope,
    workScopeKey: jobHeader.workScopeKey || "",
    sections: workScope,
    phaseId: asTrimmedString(currentPhase?.phaseId),
    phaseNumber: integerOrZero(currentPhase?.phaseNumber) || undefined,
    phaseWorkScope: workScope,
    phaseCount: phaseEntries.length,
    phases: phaseEntries,
    installDate,
    installEndDate,
    crewLeader,
    isLaborOnly: Boolean(jobHeader.isLaborOnly),
    isStagedForPickup: Boolean(jobHeader.isStagedForPickup),
    status,
    lifecycleStatus: effectiveLifecycleStatus,
    requiredFeet,
    allocatedFeet,
    allocatedWithInstallDateFeet,
    allocatedWithoutInstallDateFeet,
    remainingFeet,
    requiredTubes: caulkTotals.requiredTubes,
    allocatedTubes: caulkTotals.allocatedTubes,
    remainingTubes: caulkTotals.remainingTubes,
    requirementCount: requirements.length,
    allocationCount: allocations.length,
    filmOrderCount: countUnresolvedFilmOrders(filmOrders),
    hasOrderedAllocations: hasActiveOrderedAllocations(allocations, boxById),
    createdAt: jobHeader.createdAt || "",
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
    installDate: asTrimmedString(header?.installDate) || metadata.installDate || "",
    crewLeader: asTrimmedString(header?.crewLeader) || metadata.crewLeader || "",
  };
}

function getCheckoutCrewConflictJobs(
  targetJobContext: { jobNumber: string; installDate: string; crewLeader: string },
  allocations: any[],
) {
  return getSameDayCrewConflictJobs(targetJobContext, allocations);
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
  const conflicts = getCheckoutCrewConflictJobs(targetJobContext, boxAllocations);
  if (conflicts.length > 0) {
    throw new HttpError(
      400,
      `Box ${boxId} is already allocated to ${conflicts.join(", ")} on the same install date for a different crew leader. Clear that same-day crew conflict before checkout.`,
    );
  }
}

function buildPublicAllocationEntriesForJob(allocations: any[], boxById: Record<string, any>) {
  const sortedAllocations = allocations
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
      if (left.installDate !== right.installDate) {
        if (left.installDate && right.installDate) {
          return left.installDate < right.installDate ? -1 : 1;
        }
        if (left.installDate) {
          return -1;
        }
        if (right.installDate) {
          return 1;
        }
      }
      return left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0;
    });
  const currentCheckedOutAllocationIds = buildCurrentCheckedOutAllocationIdSet(sortedAllocations, boxById);
  const activeAllocationsByBoxId: Record<string, any[]> = {};

  for (const entry of sortedAllocations) {
    if (asTrimmedString(entry?.status).toUpperCase() !== "ACTIVE") {
      continue;
    }

    if (!activeAllocationsByBoxId[entry.boxId]) {
      activeAllocationsByBoxId[entry.boxId] = [];
    }

    activeAllocationsByBoxId[entry.boxId].push(entry);
  }

  const reservationSnapshotsByBoxId: Record<string, any> = {};
  for (const boxId of Object.keys(activeAllocationsByBoxId)) {
    const box = boxById[boxId];
    if (!box) {
      continue;
    }

    reservationSnapshotsByBoxId[boxId] = buildBoxReservationSnapshot(box, activeAllocationsByBoxId[boxId]);
  }

  return sortedAllocations.map((entry) => {
    const box = boxById[entry.boxId];
    const allocationSnapshot =
      reservationSnapshotsByBoxId[entry.boxId]?.allocationSnapshotsById?.[entry.allocationId] || null;
    return {
      ...toPublicAllocation(entry),
      manufacturer: box ? box.manufacturer : "",
      filmName: box ? box.filmName : "",
      widthIn: box ? box.widthIn : 0,
      boxStatus: box ? box.status : "",
      backedPhysicalFeet: allocationSnapshot ? allocationSnapshot.backedPhysicalFeet : integerOrZero(entry.allocatedFeet),
      reservationState: allocationSnapshot ? allocationSnapshot.reservationState : "WITHOUT_INSTALL_DATE",
      checkedOutOnThisJob: Boolean(currentCheckedOutAllocationIds[entry.allocationId]),
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
  jobContext: { jobNumber: string; installDate: string; crewLeader: string },
  activeAllocationsByBox: Record<string, any[]>,
) {
  return getSameDayCrewConflictJobs(jobContext, getActiveAllocationsForBox(boxId, activeAllocationsByBox));
}

async function buildPublicFilmOrderLinkedBoxesByFilmOrderId(
  orgId: string,
  filmOrderIds: string[],
  initialBoxById: Record<string, any> = {},
) {
  const normalizedFilmOrderIds = Array.from(
    new Set((Array.isArray(filmOrderIds) ? filmOrderIds : []).map((filmOrderId) => asTrimmedString(filmOrderId)).filter(Boolean)),
  );
  const linkedBoxesByFilmOrderId: Record<
    string,
    Array<{
      boxId: string;
      orderedFeet: number;
      autoAllocatedFeet: number;
      dealer: string;
      isReceived: boolean;
    }>
  > = {};
  if (!normalizedFilmOrderIds.length) {
    return linkedBoxesByFilmOrderId;
  }

  const links = await listFilmOrderLinksByFilmOrderIds(orgId, normalizedFilmOrderIds);
  const boxById = { ...initialBoxById };
  const missingBoxIds = Array.from(
    new Set(
      links
        .map((link) => asTrimmedString((link as Record<string, unknown>).boxId).toUpperCase())
        .filter((boxId) => boxId && !boxById[boxId]),
    ),
  );
  if (missingBoxIds.length) {
    const fetchedBoxes = await listBoxesByIds(orgId, missingBoxIds);
    Object.assign(boxById, indexBoxesById(fetchedBoxes));
  }

  function isReceivedLinkedBoxStatus(status: unknown) {
    const normalizedStatus = asTrimmedString(status).toUpperCase();
    return normalizedStatus !== "" && normalizedStatus !== "ORDERED";
  }

  for (const link of links) {
    const filmOrderId = asTrimmedString((link as Record<string, unknown>).filmOrderId);
    const boxId = asTrimmedString((link as Record<string, unknown>).boxId).toUpperCase();
    if (!filmOrderId || !boxId || !boxById[boxId]) {
      continue;
    }
    if (!linkedBoxesByFilmOrderId[filmOrderId]) {
      linkedBoxesByFilmOrderId[filmOrderId] = [];
    }
    linkedBoxesByFilmOrderId[filmOrderId].push({
      boxId,
      orderedFeet: integerOrZero((link as Record<string, unknown>).orderedFeet),
      autoAllocatedFeet: integerOrZero((link as Record<string, unknown>).autoAllocatedFeet),
      dealer: asTrimmedString((boxById[boxId] as Record<string, unknown>).dealer),
      isReceived: isReceivedLinkedBoxStatus((boxById[boxId] as Record<string, unknown>).status),
    });
  }

  for (const entries of Object.values(linkedBoxesByFilmOrderId)) {
    entries.sort((left, right) => left.boxId < right.boxId ? -1 : left.boxId > right.boxId ? 1 : 0);
  }

  return linkedBoxesByFilmOrderId;
}

async function buildPublicFilmOrderLinkedBoxes(
  _client: any,
  orgId: string,
  filmOrderId: string,
  boxById: Record<string, any> = {},
) {
  const linkedBoxesByFilmOrderId = await buildPublicFilmOrderLinkedBoxesByFilmOrderId(orgId, [filmOrderId], boxById);
  return linkedBoxesByFilmOrderId[asTrimmedString(filmOrderId)] || [];
}

function hasReceivedLinkedBoxStatus(status: unknown) {
  const normalizedStatus = asTrimmedString(status).toUpperCase();
  return normalizedStatus !== "" && normalizedStatus !== "ORDERED";
}

async function summarizeFilmOrderLinkedBoxes(
  client: any,
  orgId: string,
  filmOrderId: string,
) {
  const links = await listFilmOrderLinksByFilmOrderId(client, orgId, filmOrderId);
  if (!links.length) {
    return {
      hasLinkedBoxes: false,
      allLinkedBoxesReceived: false,
      orderedFeet: 0,
    };
  }

  let orderedFeet = 0;
  let allLinkedBoxesReceived = true;

  for (const link of links) {
    const linkRecord = link as Record<string, unknown>;
    const boxId = asTrimmedString(linkRecord.box_id);
    if (!boxId) {
      allLinkedBoxesReceived = false;
      continue;
    }

    const box = await findBoxById(client, orgId, boxId);
    if (!box) {
      allLinkedBoxesReceived = false;
      continue;
    }

    orderedFeet += integerOrZero(linkRecord.ordered_feet);
    if (!hasReceivedLinkedBoxStatus(box.status)) {
      allLinkedBoxesReceived = false;
    }
  }

  return {
    hasLinkedBoxes: true,
    allLinkedBoxesReceived,
    orderedFeet,
  };
}

function isUnresolvedFilmOrderStatus(status: unknown) {
  const normalizedStatus = asTrimmedString(status).toUpperCase();
  return normalizedStatus === "FILM_ORDER" || normalizedStatus === "FILM_ON_THE_WAY";
}

function countUnresolvedFilmOrders(entries: any[]) {
  let count = 0;
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry && isUnresolvedFilmOrderStatus(entry.status)) {
      count += 1;
    }
  }

  return count;
}

async function enrichOpenFilmOrdersWithJobSchedule(client: any, orgId: string, filmOrders: any[]) {
  const entries = Array.isArray(filmOrders) ? filmOrders : [];
  const jobIdsNeedingHeaders = Array.from(
    new Set(
      entries
        .filter((entry) => {
          if (!entry) {
            return false;
          }
          const jobId = asTrimmedString(entry.jobId);
          if (!jobId) {
            return false;
          }
          const needsScope = !asTrimmedString(entry.workScope || entry.sections);
          const needsSchedule =
            isUnresolvedFilmOrderStatus(entry.status) &&
            (!asTrimmedString(entry.installDate) || !asTrimmedString(entry.crewLeader));
          return needsScope || needsSchedule;
        })
        .map((entry) => asTrimmedString(entry.jobId))
        .filter(Boolean),
    ),
  );
  const idHeaderEntries = await Promise.all(
    jobIdsNeedingHeaders.map(async (jobId) => [jobId, (await findJobById(client, orgId, jobId)) || null]),
  );
  const jobHeaderById = new Map<string, any | null>(idHeaderEntries as Array<[string, any | null]>);
  const jobNumbersNeedingHeaders = Array.from(
    new Set(
      entries
        .filter((entry) => entry && isUnresolvedFilmOrderStatus(entry.status))
        .filter((entry) => !asTrimmedString(entry.jobId))
        .filter((entry) => !asTrimmedString(entry.installDate) || !asTrimmedString(entry.crewLeader))
        .map((entry) => asTrimmedString(entry.jobNumber))
        .filter(Boolean),
    ),
  );
  const headerEntries = await Promise.all(
    jobNumbersNeedingHeaders.map(async (jobNumber) => [jobNumber, (await findJobByNumber(client, orgId, jobNumber)) || null]),
  );
  const jobHeaderCache = new Map<string, any | null>(headerEntries as Array<[string, any | null]>);
  const response = [];

  for (const entry of entries) {
    if (!entry) {
      response.push(entry);
      continue;
    }

    const jobId = asTrimmedString(entry.jobId);
    const jobHeaderByJobId = jobId ? jobHeaderById.get(jobId) : null;
    const existingScope = asTrimmedString(entry.workScope || entry.sections);
    const headerScope = jobHeaderByJobId
      ? asTrimmedString(jobHeaderByJobId.workScope || jobHeaderByJobId.sections)
      : "";
    const scopePatch = !existingScope && headerScope
      ? {
          workScope: headerScope,
          sections: headerScope,
        }
      : {};

    if (!isUnresolvedFilmOrderStatus(entry.status)) {
      response.push(Object.keys(scopePatch).length ? { ...entry, ...scopePatch } : entry);
      continue;
    }

    const needsInstallDate = !asTrimmedString(entry.installDate);
    const needsCrewLeader = !asTrimmedString(entry.crewLeader);
    if (!needsInstallDate && !needsCrewLeader) {
      response.push(Object.keys(scopePatch).length ? { ...entry, ...scopePatch } : entry);
      continue;
    }

    const jobNumber = asTrimmedString(entry.jobNumber);
    if (!jobNumber) {
      response.push(Object.keys(scopePatch).length ? { ...entry, ...scopePatch } : entry);
      continue;
    }

    const jobHeader = jobHeaderByJobId || jobHeaderCache.get(jobNumber);
    if (!jobHeader) {
      response.push(Object.keys(scopePatch).length ? { ...entry, ...scopePatch } : entry);
      continue;
    }

    response.push({
      ...entry,
      ...scopePatch,
      ...(needsInstallDate && asTrimmedString(jobHeader.installDate)
        ? { installDate: asTrimmedString(jobHeader.installDate) }
        : {}),
      ...(needsCrewLeader && asTrimmedString(jobHeader.crewLeader)
        ? { crewLeader: asTrimmedString(jobHeader.crewLeader) }
        : {}),
    });
  }

  return response;
}

async function buildPublicFilmOrdersForJob(
  client: any,
  orgId: string,
  filmOrders: any[],
  options: { boxById?: Record<string, any> } = {},
) {
  const enrichedEntries = await enrichOpenFilmOrdersWithJobSchedule(client, orgId, filmOrders);
  const sorted = enrichedEntries.slice().sort((left, right) =>
    compareAllocationJobSummaries(
      { installDate: left.createdAt, jobNumber: left.filmOrderId },
      { installDate: right.createdAt, jobNumber: right.filmOrderId },
    )
  );
  const linkedBoxesByFilmOrderId = await buildPublicFilmOrderLinkedBoxesByFilmOrderId(
    orgId,
    sorted.map((entry) => asTrimmedString(entry.filmOrderId)),
    options.boxById || {},
  );

  return sorted.map((entry) =>
    toPublicFilmOrder(entry, linkedBoxesByFilmOrderId[asTrimmedString(entry.filmOrderId)] || [])
  );
}

async function resolveJobContext(client: any, orgId: string, jobNumber: unknown, installDate: unknown, crewLeader: unknown) {
  const normalizedJobNumber = requireString(jobNumber, "JobNumber");
  const normalizedInstallDate = normalizeDateString(installDate, "Install Date", true);
  const normalizedCrewLeader = asTrimmedString(crewLeader);
  const existingHeader = await findJobByNumber(client, orgId, normalizedJobNumber);
  if (existingHeader && normalizeJobLifecycleStatus(existingHeader.lifecycleStatus) !== "ACTIVE") {
    throw new HttpError(400, `Job ${normalizedJobNumber} is closed and cannot receive allocations.`);
  }
  const existingAllocations = await listAllocationsByJob(client, orgId, normalizedJobNumber);
  const existingFilmOrders = await listFilmOrdersByJob(client, orgId, normalizedJobNumber);
  let existingInstallDate = existingHeader?.installDate || "";
  let existingCrewLeader = existingHeader?.crewLeader || "";

  for (const entry of existingAllocations) {
    if (!existingInstallDate && entry.installDate) {
      existingInstallDate = entry.installDate;
    }
    if (!existingCrewLeader && entry.crewLeader) {
      existingCrewLeader = entry.crewLeader;
    }
  }
  for (const entry of existingFilmOrders) {
    if (!existingInstallDate && entry.installDate) {
      existingInstallDate = entry.installDate;
    }
    if (!existingCrewLeader && entry.crewLeader) {
      existingCrewLeader = entry.crewLeader;
    }
  }

  if (existingInstallDate && normalizedInstallDate && existingInstallDate !== normalizedInstallDate) {
    throw new HttpError(400, "Install Date must stay the same for an existing Job Number.");
  }
  if (
    existingCrewLeader &&
    normalizedCrewLeader &&
    normalizeCrewLeaderKey(existingCrewLeader) !== normalizeCrewLeaderKey(normalizedCrewLeader)
  ) {
    throw new HttpError(400, "Crew Leader must stay the same for an existing Job Number.");
  }

  const resolvedInstallDate = normalizedInstallDate || existingInstallDate;
  const resolvedCrewLeader = normalizedCrewLeader || existingCrewLeader;
  if (resolvedInstallDate && !resolvedCrewLeader) {
    throw new HttpError(400, "Crew Leader is required when Install Date is set.");
  }

  return {
    jobNumber: normalizedJobNumber,
    installDate: resolvedInstallDate,
    crewLeader: resolvedCrewLeader,
  };
}

function buildAllocationPreviewPlan(
  sourceBox: any,
  requestedFeet: unknown,
  jobContext: { jobNumber: string; installDate: string; crewLeader: string },
  options: {
    crossWarehouse: boolean;
    minimumWidthIn?: unknown;
    allBoxes: any[];
    activeAllocationsByBox: Record<string, any[]>;
    selectedRequirement?: any;
    jobWarehouse?: string;
    pendingTransfersByBoxRecordId?: Record<string, any>;
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
  const pendingTransfersByBoxRecordId = options.pendingTransfersByBoxRecordId || {};
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
  const sourcePendingTransfer = findPendingTransferForBox(sourceBox, pendingTransfersByBoxRecordId);
  const sourceTransferBlockReason = getTransferAllocationBlockReason(
    sourceBox,
    sourcePendingTransfer,
    preferredWarehouse,
  );
  if (sourceTransferBlockReason) {
    throw new HttpError(400, sourceTransferBlockReason);
  }
  if (!isJobAllocationEligibleBox(sourceBox, sourcePendingTransfer, preferredWarehouse)) {
    throw new HttpError(400, `Box ${sourceBox.boxId} is no longer allocatable.`);
  }
  const sourcePlanningFeet = getBoxAllocationPlanningFeet(sourceBox, options.activeAllocationsByBox);
  const sourceConflicts = getDateConflictJobsForBox(sourceBox.boxId, jobContext, options.activeAllocationsByBox);
  const sourcePlan = sourceConflicts.length
    ? { allocatedFeet: 0, coveredFeet: 0, remainingCoveredFeet: requested }
    : planCoverageAllocation(requested, sourcePlanningFeet, sourceBox.widthIn, minimumWidthIn);
  const sourceSuggestedFeet = sourcePlan.allocatedFeet;
  const sourceSuggestedCoveredFeet = sourcePlan.coveredFeet;
  let remaining = sourcePlan.remainingCoveredFeet;
  const candidateBoxes = options.crossWarehouse
    ? options.allBoxes
    : options.allBoxes.filter((box) => box.warehouse === sourceBox.warehouse);
  const filteredCandidates: CandidatePreviewEntry[] = [];
  for (const candidate of candidateBoxes) {
    const candidatePlanningFeet = getBoxAllocationPlanningFeet(candidate, options.activeAllocationsByBox);
    const candidatePendingTransfer = findPendingTransferForBox(candidate, pendingTransfersByBoxRecordId);
    if (
      candidate.boxId === sourceBox.boxId ||
      !isJobAllocationEligibleBox(candidate, candidatePendingTransfer, preferredWarehouse) ||
      candidatePlanningFeet <= 0 ||
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
    const left = leftEntry.candidate;
    const right = rightEntry.candidate;
    const leftStatusRank = getAllocationCandidateStatusRank(left);
    const rightStatusRank = getAllocationCandidateStatusRank(right);
    if (leftStatusRank !== rightStatusRank) {
      return leftStatusRank - rightStatusRank;
    }

    if (preferredWarehouse) {
      const leftPreferredWarehouse = asTrimmedString(left.warehouse).toUpperCase() === preferredWarehouse;
      const rightPreferredWarehouse = asTrimmedString(right.warehouse).toUpperCase() === preferredWarehouse;
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
    const candidatePlanningFeet = getBoxAllocationPlanningFeet(candidate, options.activeAllocationsByBox);
    const conflicts = getDateConflictJobsForBox(candidate.boxId, jobContext, options.activeAllocationsByBox);
    if (conflicts.length) {
      continue;
    }
    const candidatePlan = planCoverageAllocation(remaining, candidatePlanningFeet, candidate.widthIn, minimumWidthIn);
    suggestions.push({
      boxId: candidate.boxId,
      warehouse: candidate.warehouse,
      widthIn: candidate.widthIn,
      availableFeet: candidate.feetAvailable,
      planningFeet: candidatePlanningFeet,
      boxStatus: candidate.status,
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
    installDate: jobContext.installDate,
    crewLeader: jobContext.crewLeader,
    requestedFeet: requested,
    requestedWidthIn: minimumWidthIn,
    sourceBoxId: sourceBox.boxId,
    sourceWarehouse: sourceBox.warehouse,
    sourceWidthIn: sourceBox.widthIn,
    sourceBoxFeetAvailable: sourceBox.feetAvailable,
    sourceBoxPlanningFeet: sourcePlanningFeet,
    sourceBoxStatus: sourceBox.status,
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
  const requestedWarehouseTokens = normalizeStringArrayParam([
    params.warehouse,
    ...(Array.isArray(params.warehouses) ? params.warehouses : [params.warehouses]),
  ]).map((entry) => entry.toUpperCase());
  const warehouseRows = await rpcOrThrow<any[]>(client, "api_acl_list_warehouses", {
    p_org_id: orgId,
  });
  const configuredWarehouses = new Set(
    (warehouseRows || []).map((row) => asTrimmedString(row.code).toUpperCase()).filter(Boolean)
  );
  const warehouseFilters =
    requestedWarehouseTokens.length === 0 || requestedWarehouseTokens.includes("ALL")
      ? Array.from(configuredWarehouses)
      : requestedWarehouseTokens;
  const invalidWarehouse = warehouseFilters.find((warehouse) => !configuredWarehouses.has(warehouse));
  if (invalidWarehouse) {
    throw new HttpError(400, "warehouse is not configured.");
  }
  const warehouseFilterSet = new Set(warehouseFilters);
  const manufacturerFilterKey = normalizeCatalogManufacturerLookupKey(params.manufacturer);
  const query = asTrimmedString(params.q).toLowerCase();
  const status = asTrimmedString(params.status).toUpperCase();
  const film = asTrimmedString(params.film).toLowerCase();
  const width = asTrimmedString(params.width);
  const showRetired = String(params.showRetired) === "true";
  const boxes = await listBoxesByWarehouses(client, orgId, Array.from(warehouseFilterSet));
  const activeAllocations = await listActiveAllocations(client, orgId);
  const activeAllocationsByBoxId: Record<string, any[]> = {};
  for (const entry of activeAllocations) {
    if (!activeAllocationsByBoxId[entry.boxId]) {
      activeAllocationsByBoxId[entry.boxId] = [];
    }

    activeAllocationsByBoxId[entry.boxId].push(entry);
  }
  const filteredBoxes = boxes.filter((box) => {
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
  });
  const pendingTransfersByBoxRecordId = await buildPendingTransfersByBoxRecordId(client, orgId, filteredBoxes);
  let filtered = filteredBoxes.map((box) => {
    const reservationSnapshot = buildBoxReservationSnapshot(box, activeAllocationsByBoxId[box.boxId] || []);
    const publicBox = toPublicBox({
      ...box,
      physicalFeetAvailable: reservationSnapshot.physicalFeetAvailable,
      feetAvailable: reservationSnapshot.allocatableNowFeet,
      allocatableNowFeet: reservationSnapshot.allocatableNowFeet,
      allocatedWithInstallDateFeet: reservationSnapshot.allocatedWithInstallDateFeet,
      allocatedWithoutInstallDateFeet: reservationSnapshot.allocatedWithoutInstallDateFeet,
      activeAllocatedFeet: reservationSnapshot.activeAllocatedFeet,
      allocationPlanningFeet: reservationSnapshot.allocatableNowFeet,
    });
    const pendingTransfer = findPendingTransferForBox(box, pendingTransfersByBoxRecordId);
    if (!pendingTransfer || !isJobAllocationEligibleBox(box, pendingTransfer, pendingTransfer.destinationWarehouse)) {
      return publicBox;
    }

    return {
      ...publicBox,
      pendingTransfer: {
        transferId: pendingTransfer.transferId,
        status: "PENDING",
        sourceWarehouse: pendingTransfer.sourceWarehouse,
        destinationWarehouse: pendingTransfer.destinationWarehouse,
      },
    };
  });

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

const SUMMARY_SNAPSHOT_READ_CONCURRENCY = 2;

async function runBoundedSnapshotReads(
  taskFactories: Array<() => Promise<any>>,
  maxConcurrency = SUMMARY_SNAPSHOT_READ_CONCURRENCY,
): Promise<any[]> {
  if (!taskFactories.length) {
    return [];
  }

  const workerCount = Math.max(1, Math.min(taskFactories.length, Math.floor(maxConcurrency)));
  const results = new Array(taskFactories.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < taskFactories.length) {
      const taskIndex = nextIndex;
      nextIndex += 1;
      results[taskIndex] = await taskFactories[taskIndex]();
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

export async function buildAllocationJobList(client: any, orgId: string) {
  const [
    jobs,
    allAllocations,
    allFilmOrders,
    allRequirements,
    allBoxes,
    allCaulkStock,
  ] = await runBoundedSnapshotReads([
    () => listJobs(client, orgId),
    () => listAllocations(client, orgId),
    () => listFilmOrders(client, orgId),
    () => listJobRequirements(client, orgId),
    () => listBoxes(client, orgId),
    () => listCaulkStockEntries(client, orgId),
  ]);
  const allocationsByJobId = groupEntriesByCanonicalJobId(allAllocations);
  const filmOrdersByJobId = groupEntriesByCanonicalJobId(allFilmOrders);
  const requirementsByJobId = groupEntriesByCanonicalJobId(allRequirements);
  const legacyAllocationsByJobNumber = groupEntriesByJobNumberFallback(allAllocations);
  const legacyFilmOrdersByJobNumber = groupEntriesByJobNumberFallback(allFilmOrders);
  const legacyRequirementsByJobNumber = groupEntriesByJobNumberFallback(allRequirements);
  const allAllocationsByJobNumber = groupEntriesByJobNumberFallback(allAllocations, { includeScopedRows: true });
  const allFilmOrdersByJobNumber = groupEntriesByJobNumberFallback(allFilmOrders, { includeScopedRows: true });
  const allRequirementsByJobNumber = groupEntriesByJobNumberFallback(allRequirements, { includeScopedRows: true });
  const jobHeaders: any[] = [];
  const jobNumberHeaderCounts: Record<string, number> = {};
  const legacyJobNumbers = new Set<string>();
  const boxById = Object.fromEntries(allBoxes.map((box: any) => [box.boxId, box]));

  for (const job of jobs) {
    const jobNumber = getEntryJobNumber(job);
    if (jobNumber) {
      jobHeaders.push(job);
      jobNumberHeaderCounts[jobNumber] = (jobNumberHeaderCounts[jobNumber] || 0) + 1;
    }
  }

  collectLegacyJobNumbersFromRows(allAllocations, legacyJobNumbers, new Set());
  collectLegacyJobNumbersFromRows(allFilmOrders, legacyJobNumbers, new Set());
  collectLegacyJobNumbersFromRows(allRequirements, legacyJobNumbers, new Set());

  const jobContexts = jobHeaders.map((header) => ({
    jobNumber: getEntryJobNumber(header),
    header,
    legacy: false,
  }));

  for (const jobNumber of legacyJobNumbers) {
    if (!jobNumberHeaderCounts[jobNumber]) {
      jobContexts.push({
        jobNumber,
        header: null,
        legacy: true,
      });
    }
  }

  const caulkPlanning = await loadCaulkPlanningByJobContexts(client, orgId, jobContexts);

  const response = jobContexts
    .map((context) => {
      const jobNumber = context.jobNumber;
      const contextJobId = context.header ? getEntryJobId(context.header) : "";
      const allocations = context.legacy
        ? getRowsForLegacyJobNumber(jobNumber, allAllocationsByJobNumber)
        : getRowsForJobHeader(context.header, allocationsByJobId, legacyAllocationsByJobNumber, jobNumberHeaderCounts);
      const filmOrders = context.legacy
        ? getRowsForLegacyJobNumber(jobNumber, allFilmOrdersByJobNumber)
        : getRowsForJobHeader(context.header, filmOrdersByJobId, legacyFilmOrdersByJobNumber, jobNumberHeaderCounts);
      const requirements = buildPublicJobRequirementEntries(
        context.legacy
          ? getRowsForLegacyJobNumber(jobNumber, allRequirementsByJobNumber)
          : getRowsForJobHeader(context.header, requirementsByJobId, legacyRequirementsByJobNumber, jobNumberHeaderCounts),
        allocations,
        boxById,
      );
      const publicCaulkRequirements = contextJobId
        ? caulkPlanning.requirementsByJobId[contextJobId] || []
        : caulkPlanning.requirementsByJob[jobNumber] || [];
      const caulkAllocations = contextJobId
        ? caulkPlanning.allocationsByJobId[contextJobId] || []
        : caulkPlanning.allocationsByJob[jobNumber] || [];
      const header = context.header;

      if (!allocations.length && !filmOrders.length && !requirements.length && !publicCaulkRequirements.length) {
        return null;
      }

      const summary = buildAllocationJobSummary(
        jobNumber,
        allocations,
        filmOrders,
        requirements,
        publicCaulkRequirements,
        header?.lifecycleStatus || "ACTIVE",
        Boolean(header?.isLaborOnly),
        Boolean(header?.isStagedForPickup),
        header?.installDate || "",
        header?.crewLeader || "",
        boxById,
        header?.id || "",
        header?.workScope ?? header?.sections ?? null,
      );
      summary.status = deriveInStockReadinessStatus({
        lifecycleStatus: header?.lifecycleStatus || "ACTIVE",
        isLaborOnly: Boolean(header?.isLaborOnly),
        requirements,
        caulkRequirements: publicCaulkRequirements,
        allocations,
        caulkAllocations,
        filmOrders,
        allBoxes,
        boxById,
        caulkStockEntries: allCaulkStock,
        jobWarehouse: header?.warehouse || "",
        jobNumber,
      });
      return summary;
    })
    .filter((entry): entry is any => Boolean(entry));
  response.sort(compareAllocationJobSummaries);
  return response;
}

async function buildAllocationJobDetail(client: any, orgId: string, jobNumber: unknown) {
  const normalizedJobNumber = requireString(jobNumber, "jobNumber");
  const [
    header,
    allocations,
    filmOrders,
    requirements,
    caulkRequirements,
    caulkAllocations,
    caulkCheckouts,
  ] = await Promise.all([
    findJobByNumber(client, orgId, normalizedJobNumber),
    listAllocationsByJob(client, orgId, normalizedJobNumber),
    listFilmOrdersByJob(client, orgId, normalizedJobNumber),
    listJobRequirementsByJob(client, orgId, normalizedJobNumber),
    listJobCaulkRequirementsByJob(client, orgId, normalizedJobNumber),
    listCaulkJobAllocationsByJob(client, orgId, normalizedJobNumber),
    listCaulkJobCheckoutsByJob(client, orgId, normalizedJobNumber),
  ]);
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
  const filmOrderLinks = await listFilmOrderLinksByFilmOrderIds(
    orgId,
    filmOrders.map((entry) => asTrimmedString(entry?.filmOrderId))
  );
  const boxes = await listBoxesByIds(orgId, collectJobBoxIds(allocations, rollHistory, filmOrderLinks));
  const boxById = indexBoxesById(boxes);
  const pendingTransfersByBoxRecordId = indexPendingBoxTransfersByBoxRecordId(
    await listPendingBoxTransfersByBoxRecordIds(
      client,
      orgId,
      boxes.map((box) => box.id).filter(Boolean),
    ),
  );
  const publicCaulkRequirements = buildPublicCaulkRequirementEntries(caulkRequirements, caulkAllocations, {
    jobNumber: normalizedJobNumber,
    jobWarehouse: header?.warehouse || "",
  });
  const publicRequirements = buildPublicJobRequirementEntries(requirements, allocations, boxById);
  const filmTransferAlerts = buildJobFilmTransferAlerts(
    header?.warehouse || "",
    allocations,
    boxById,
    pendingTransfersByBoxRecordId,
  );
  const caulkTransferAlerts = buildJobCaulkTransferAlerts(
    header?.warehouse || "",
    caulkAllocations,
  );
  const summary = buildAllocationJobSummary(
    normalizedJobNumber,
    allocations,
    filmOrders,
    publicRequirements,
    publicCaulkRequirements,
    header?.lifecycleStatus || "ACTIVE",
    Boolean(header?.isLaborOnly),
    Boolean(header?.isStagedForPickup),
    header?.installDate || "",
    header?.crewLeader || "",
    boxById,
    header?.id || "",
    header?.workScope ?? header?.sections ?? null,
  );
  summary.status = deriveInStockReadinessStatus({
    lifecycleStatus: header?.lifecycleStatus || "ACTIVE",
    isLaborOnly: Boolean(header?.isLaborOnly),
    requirements: publicRequirements,
    caulkRequirements: publicCaulkRequirements,
    allocations,
    caulkAllocations,
    filmOrders,
    allBoxes: boxes,
    boxById,
    caulkStockEntries: [],
    jobWarehouse: header?.warehouse || "",
    jobNumber: normalizedJobNumber,
  });

  return {
    summary,
    allocations: buildPublicAllocationEntriesForJob(allocations, boxById),
    usage: buildPublicJobUsageEntries(rollHistory, boxById),
    usageTimeline: buildPublicJobUsageTimelineEntries(
      normalizedJobNumber,
      rollHistory,
      boxById,
      caulkCheckouts,
      filmOrderLinks,
      filmOrders
    ),
    caulkRequirements: publicCaulkRequirements,
    caulkAllocations: caulkAllocations,
    caulkCheckouts: caulkCheckouts,
    filmOrders: await buildPublicFilmOrdersForJob(client, orgId, filmOrders, { boxById }),
    filmTransferAlerts,
    caulkTransferAlerts,
  };
}

async function loadCaulkPlanningByJobNumbers(
  client: any,
  orgId: string,
  jobNumbers: string[],
  jobHeadersByNumber: Record<string, any> = {},
  jobHeadersById: Record<string, any> = {},
) {
  const requirementsByJob: Record<string, any[]> = {};
  const requirementsByJobId: Record<string, any[]> = {};
  const allocationsByJob: Record<string, any[]> = {};
  const allocationsByJobId: Record<string, any[]> = {};
  const normalizedJobNumbers = Array.from(new Set(jobNumbers.filter((entry) => asTrimmedString(entry))));

  await Promise.all(
    normalizedJobNumbers.map(async (jobNumber) => {
      const [caulkRequirements, caulkAllocations] = await Promise.all([
        listJobCaulkRequirementsByJob(client, orgId, jobNumber),
        listCaulkJobAllocationsByJob(client, orgId, jobNumber),
      ]);
      const caulkRequirementsByJobId = groupEntriesByCanonicalJobId(caulkRequirements);
      const caulkAllocationsByJobId = groupEntriesByCanonicalJobId(caulkAllocations);
      requirementsByJob[jobNumber] = buildPublicCaulkRequirementEntries(caulkRequirements, caulkAllocations, {
        jobNumber,
        jobWarehouse: jobHeadersByNumber[jobNumber]?.warehouse || "",
      });
      allocationsByJob[jobNumber] = caulkAllocations;

      for (const [jobId, scopedRequirements] of Object.entries(caulkRequirementsByJobId)) {
        const scopedAllocations = caulkAllocationsByJobId[jobId] || [];
        const header = jobHeadersById[jobId] || {};
        requirementsByJobId[jobId] = buildPublicCaulkRequirementEntries(scopedRequirements, scopedAllocations, {
          jobNumber: asTrimmedString(header.jobNumber) || jobNumber,
          jobWarehouse: header.warehouse || jobHeadersByNumber[jobNumber]?.warehouse || "",
        });
      }

      for (const [jobId, scopedAllocations] of Object.entries(caulkAllocationsByJobId)) {
        allocationsByJobId[jobId] = scopedAllocations;
        if (!requirementsByJobId[jobId]) {
          const header = jobHeadersById[jobId] || {};
          requirementsByJobId[jobId] = buildPublicCaulkRequirementEntries([], scopedAllocations, {
            jobNumber: asTrimmedString(header.jobNumber) || jobNumber,
            jobWarehouse: header.warehouse || jobHeadersByNumber[jobNumber]?.warehouse || "",
          });
        }
      }
    }),
  );

  return {
    requirementsByJob,
    requirementsByJobId,
    allocationsByJob,
    allocationsByJobId,
  };
}

export async function loadCaulkPlanningByJobContexts(
  client: any,
  orgId: string,
  jobContexts: Array<{ jobNumber: string; header: any; legacy: boolean }>,
) {
  const requirementsByJob: Record<string, any[]> = {};
  const requirementsByJobId: Record<string, any[]> = {};
  const allocationsByJob: Record<string, any[]> = {};
  const allocationsByJobId: Record<string, any[]> = {};
  const legacyJobNumbers = new Set<string>();
  const canonicalContexts: Array<{ jobId: string; jobNumber: string; header: any }> = [];
  const canonicalHeadersByJobId: Record<string, any> = {};

  for (const context of jobContexts) {
    const jobNumber = asTrimmedString(context?.jobNumber || context?.header?.jobNumber);
    const jobId = context?.header ? getEntryJobId(context.header) : "";
    if (context?.header && jobId) {
      canonicalContexts.push({ jobId, jobNumber, header: context.header });
      canonicalHeadersByJobId[jobId] = context.header;
    } else if (jobNumber) {
      legacyJobNumbers.add(jobNumber);
    }
  }

  const canonicalJobIds = canonicalContexts.map((context) => context.jobId);
  const [canonicalCaulkRequirements, canonicalCaulkAllocations] = await Promise.all([
    listJobCaulkRequirementsByJobIdsDirect(orgId, canonicalHeadersByJobId),
    listCaulkJobAllocationsByJobIdsDirect(orgId, canonicalJobIds),
  ]);
  const canonicalRequirementsByJobId = groupEntriesByCanonicalJobId(canonicalCaulkRequirements);
  const canonicalAllocationsByJobId = groupEntriesByCanonicalJobId(canonicalCaulkAllocations);

  for (const { jobId, jobNumber, header } of canonicalContexts) {
    const caulkRequirements = canonicalRequirementsByJobId[jobId] || [];
    const caulkAllocations = canonicalAllocationsByJobId[jobId] || [];
    requirementsByJobId[jobId] = buildPublicCaulkRequirementEntries(caulkRequirements, caulkAllocations, {
      jobNumber,
      jobWarehouse: header?.warehouse || "",
    });
    allocationsByJobId[jobId] = caulkAllocations;
  }

  await Promise.all(
    Array.from(legacyJobNumbers).map(async (jobNumber) => {
      const [caulkRequirements, caulkAllocations] = await Promise.all([
        listJobCaulkRequirementsByJob(client, orgId, jobNumber),
        listCaulkJobAllocationsByJob(client, orgId, jobNumber),
      ]);
      requirementsByJob[jobNumber] = buildPublicCaulkRequirementEntries(caulkRequirements, caulkAllocations, {
        jobNumber,
        jobWarehouse: "",
      });
      allocationsByJob[jobNumber] = caulkAllocations;
    }),
  );

  return {
    requirementsByJob,
    requirementsByJobId,
    allocationsByJob,
    allocationsByJobId,
  };
}

/**
 * PURPOSE:
 * Builds public job-list summaries from org-scoped job, allocation, order,
 * requirement, box, and caulk snapshots.
 *
 * AFFECTS:
 * Jobs list/search/calendar reads, allocation job summaries, app shell job
 * previews, and reports that reuse job summary state.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * /jobs/list, /jobs/search, /jobs/calendar, /allocations/jobs,
 * /reports/summary, local runtime parity, and job summary parity checks.
 *
 * COMMON FAILURE MODES:
 * Duplicate full-org reads, stale preloaded snapshots, local/Edge drift,
 * changed sort/filter behavior, or report response-shape regressions.
 */
export async function buildJobsList(
  client: any,
  orgId: string,
  limit: number,
  lifecycleStatus?: unknown,
  jobNumbers: unknown = [],
  options: { preloadedBoxes?: any[]; snapshotConcurrency?: number } = {},
) {
  const lifecycleFilter = normalizeJobLifecycleFilter(lifecycleStatus);
  const jobNumberFilterSet = new Set(normalizeStringArrayParam(jobNumbers));
  const hasPreloadedBoxes = Array.isArray(options.preloadedBoxes);
  const snapshotTasks: Array<() => Promise<any>> = [
    () => listJobs(client, orgId),
    () => listAllocations(client, orgId),
    () => listFilmOrders(client, orgId),
    () => listJobPhases(client, orgId),
    () => listJobRequirements(client, orgId),
  ];

  const snapshotResults = await runBoundedSnapshotReads(snapshotTasks, options.snapshotConcurrency);
  let snapshotIndex = 0;
  const jobs = snapshotResults[snapshotIndex++];
  const allAllocations = snapshotResults[snapshotIndex++];
  const allFilmOrders = snapshotResults[snapshotIndex++];
  const allPhases = snapshotResults[snapshotIndex++];
  const allRequirements = snapshotResults[snapshotIndex++];
  const allBoxes: any[] = hasPreloadedBoxes
    ? (options.preloadedBoxes as any[])
    : await listBoxesByIds(orgId, collectAllocationBoxIds(allAllocations));
  const allocationsByJobId = groupEntriesByCanonicalJobId(allAllocations);
  const filmOrdersByJobId = groupEntriesByCanonicalJobId(allFilmOrders);
  const phasesByJobId = groupEntriesByCanonicalJobId(allPhases);
  const requirementsByJobId = groupEntriesByCanonicalJobId(allRequirements);
  const legacyAllocationsByJobNumber = groupEntriesByJobNumberFallback(allAllocations);
  const legacyFilmOrdersByJobNumber = groupEntriesByJobNumberFallback(allFilmOrders);
  const legacyRequirementsByJobNumber = groupEntriesByJobNumberFallback(allRequirements);
  const allAllocationsByJobNumber = groupEntriesByJobNumberFallback(allAllocations, { includeScopedRows: true });
  const allFilmOrdersByJobNumber = groupEntriesByJobNumberFallback(allFilmOrders, { includeScopedRows: true });
  const allRequirementsByJobNumber = groupEntriesByJobNumberFallback(allRequirements, { includeScopedRows: true });
  const jobHeaders: any[] = [];
  const jobNumberHeaderCounts: Record<string, number> = {};
  const legacyJobNumbers = new Set<string>();
  const boxById = Object.fromEntries(allBoxes.map((box: any) => [box.boxId, box]));

  for (const job of jobs) {
    if (jobNumberFilterSet.size > 0 && !jobNumberFilterSet.has(job.jobNumber)) {
      continue;
    }
    const jobNumber = getEntryJobNumber(job);
    jobHeaders.push(job);
    jobNumberHeaderCounts[jobNumber] = (jobNumberHeaderCounts[jobNumber] || 0) + 1;
  }

  collectLegacyJobNumbersFromRows(allAllocations, legacyJobNumbers, jobNumberFilterSet);
  collectLegacyJobNumbersFromRows(allFilmOrders, legacyJobNumbers, jobNumberFilterSet);
  collectLegacyJobNumbersFromRows(allRequirements, legacyJobNumbers, jobNumberFilterSet);

  const jobContexts = jobHeaders.map((header) => ({
    jobNumber: getEntryJobNumber(header),
    header,
    legacy: false,
  }));

  for (const jobNumber of legacyJobNumbers) {
    if (!jobNumberHeaderCounts[jobNumber]) {
      jobContexts.push({
        jobNumber,
        header: null,
        legacy: true,
      });
    }
  }

  const caulkPlanning = await loadCaulkPlanningByJobContexts(client, orgId, jobContexts);

  const response = jobContexts.reduce<any[]>((entries, context) => {
    const jobNumber = context.jobNumber;
    const contextJobId = context.header ? getEntryJobId(context.header) : "";
    const allocations = context.legacy
      ? getRowsForLegacyJobNumber(jobNumber, allAllocationsByJobNumber)
      : getRowsForJobHeader(context.header, allocationsByJobId, legacyAllocationsByJobNumber, jobNumberHeaderCounts);
    const filmOrders = context.legacy
      ? getRowsForLegacyJobNumber(jobNumber, allFilmOrdersByJobNumber)
      : getRowsForJobHeader(context.header, filmOrdersByJobId, legacyFilmOrdersByJobNumber, jobNumberHeaderCounts);
    const requirements = buildPublicJobRequirementEntries(
      context.legacy
        ? getRowsForLegacyJobNumber(jobNumber, allRequirementsByJobNumber)
        : getRowsForJobHeader(context.header, requirementsByJobId, legacyRequirementsByJobNumber, jobNumberHeaderCounts),
      allocations,
      boxById,
    );
    const publicCaulkRequirements = contextJobId
      ? caulkPlanning.requirementsByJobId[contextJobId] || []
      : caulkPlanning.requirementsByJob[jobNumber] || [];
    const header = context.header || buildLegacyJobHeaderFromData(jobNumber, allocations, filmOrders);
    const entry = buildJobListEntry(header, requirements, allocations, filmOrders, publicCaulkRequirements, boxById, {
      phases: context.legacy ? [] : getRowsForJobHeader(context.header, phasesByJobId, {}, jobNumberHeaderCounts),
      allBoxes,
      caulkAllocations: contextJobId
        ? caulkPlanning.allocationsByJobId[contextJobId] || []
        : caulkPlanning.allocationsByJob[jobNumber] || [],
      jobWarehouse: header.warehouse || "",
    });
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

async function hasActiveJobsNeedingAllocationForAttentionSummary(client: any, orgId: string) {
  const activeJobs = await buildJobsList(client, orgId, 0, "ACTIVE", [], { snapshotConcurrency: 2 });
  return activeJobs.some((job) => {
    const status = asTrimmedString((job as Record<string, unknown>).status).toUpperCase();
    return Boolean(asTrimmedString((job as Record<string, unknown>).installDate)) &&
      (status === "FILM_ORDER" || status === "ORDERED");
  });
}

/**
 * PURPOSE:
 * Builds full public calendar job entries from a prefiltered job-header set.
 *
 * AFFECTS:
 * /jobs/calendar reads, calendar status badges, job links, and allocation
 * readiness summaries returned to the frontend.
 *
 * WHEN CHANGING THIS, ALSO CHECK:
 * buildJobsList, buildJobListEntry, calendar query caching, and the indexed
 * api_acl_list_jobs_calendar RPC used to choose candidate jobs.
 *
 * COMMON FAILURE MODES:
 * Accidentally reintroducing full box reads, dropping status/detail fields,
 * overloading the Edge/database with unbounded per-job RPCs, or changing the
 * lifecycle filtering contract for calendar entries.
 */
async function buildJobsCalendarEntriesForHeaders(
  client: any,
  orgId: string,
  jobHeaders: any[],
  lifecycleFilter: "ACTIVE" | "COMPLETED" | "",
) {
  const detailRows: Array<{
    header: any;
    allocations: any[];
    filmOrders: any[];
    requirements: any[];
    caulkRequirements: any[];
    caulkAllocations: any[];
  }> = [];

  for (const headerBatch of chunkValues(jobHeaders, JOBS_CALENDAR_DETAIL_BATCH_SIZE)) {
    const batchRows = await Promise.all(
      headerBatch.map(async (header) => {
        const jobNumber = asTrimmedString(header?.jobNumber);
        if (!jobNumber) {
          return null;
        }

        const jobId = getEntryJobId(header);
        const [allocations, filmOrders, requirements, caulkRequirements, caulkAllocations] = await Promise.all([
          listAllocationsByJob(client, orgId, jobNumber),
          listFilmOrdersByJob(client, orgId, jobNumber),
          listJobRequirementsByJob(client, orgId, jobNumber),
          jobId
            ? listJobCaulkRequirementsByJobIdDirect(orgId, header)
            : listJobCaulkRequirementsByJob(client, orgId, jobNumber),
          jobId
            ? listCaulkJobAllocationsByJobIdDirect(orgId, jobId)
            : listCaulkJobAllocationsByJob(client, orgId, jobNumber),
        ]);

        return {
          header,
          allocations,
          filmOrders,
          requirements,
          caulkRequirements,
          caulkAllocations,
        };
      }),
    );
    detailRows.push(...batchRows.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)));
  }

  if (!detailRows.length) {
    return [];
  }

  const allAllocations = detailRows.flatMap((entry) => entry.allocations);
  const allBoxes = await listBoxesByIds(orgId, collectAllocationBoxIds(allAllocations));
  const boxById = indexBoxesById(allBoxes);
  const entries = detailRows.reduce<any[]>((response, row) => {
    const requirements = buildPublicJobRequirementEntries(row.requirements, row.allocations, boxById);
    const publicCaulkRequirements = buildPublicCaulkRequirementEntries(
      row.caulkRequirements,
      row.caulkAllocations,
      {
        jobNumber: row.header?.jobNumber || "",
        jobWarehouse: row.header?.warehouse || "",
      },
    );
    const entry = buildJobListEntry(
      row.header,
      requirements,
      row.allocations,
      row.filmOrders,
      publicCaulkRequirements,
      boxById,
      {
        allBoxes,
        caulkAllocations: row.caulkAllocations,
        caulkStockEntries: [],
        jobWarehouse: row.header?.warehouse || "",
      },
    );

    if (lifecycleFilter && entry.lifecycleStatus !== lifecycleFilter) {
      return response;
    }
    if (lifecycleFilter === "COMPLETED" && entry.status !== "COMPLETED") {
      return response;
    }
    response.push(entry);
    return response;
  }, []);

  entries.sort(compareJobsListEntries);
  return entries;
}

function buildPhaseCalendarEntries(entries: any[]) {
  const response: any[] = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const phases = Array.isArray(entry?.phases) ? entry.phases : [];
    const phaseSource = phases.length
      ? phases
      : [{
          phaseId: entry.phaseId,
          phaseNumber: entry.phaseNumber || 1,
          installDate: entry.installDate,
          installEndDate: entry.installEndDate,
          crewLeader: entry.crewLeader,
          status: entry.status,
          workScope: entry.workScope ?? entry.sections,
          sections: entry.sections ?? entry.workScope,
        }];

    for (let phaseIndex = 0; phaseIndex < phaseSource.length; phaseIndex += 1) {
      const phase = phaseSource[phaseIndex];
      const installDate = asTrimmedString(phase.installDate);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(installDate)) {
        continue;
      }
      const rawEndDate = asTrimmedString(phase.installEndDate);
      const installEndDate = /^\d{4}-\d{2}-\d{2}$/.test(rawEndDate) && rawEndDate >= installDate
        ? rawEndDate
        : "";
      response.push({
        ...entry,
        installDate,
        installEndDate,
        crewLeader: asTrimmedString(phase.crewLeader),
        status: asTrimmedString(phase.status) || entry.status,
        workScope: phase.workScope ?? phase.sections ?? entry.workScope,
        sections: phase.sections ?? phase.workScope ?? entry.sections,
        phaseId: asTrimmedString(phase.phaseId),
        phaseNumber: integerOrZero(phase.phaseNumber) || phaseIndex + 1,
        phaseWorkScope: phase.workScope ?? phase.sections ?? entry.workScope,
      });
    }
  }

  return response;
}

function calendarEntryOverlapsRange(entry: Record<string, unknown>, rangeStart: string, rangeEnd: string) {
  const installDate = asTrimmedString(entry.installDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(installDate)) {
    return false;
  }
  const rawEndDate = asTrimmedString(entry.installEndDate);
  const installEndDate = /^\d{4}-\d{2}-\d{2}$/.test(rawEndDate) && rawEndDate >= installDate
    ? rawEndDate
    : installDate;
  return installDate <= rangeEnd && installEndDate >= rangeStart;
}

function getCalendarMonthRange(anchorDate: string) {
  const year = Number(anchorDate.slice(0, 4));
  const monthIndex = Number(anchorDate.slice(5, 7)) - 1;
  const startDate = `${anchorDate.slice(0, 7)}-01`;
  if (!Number.isInteger(year) || !Number.isInteger(monthIndex) || monthIndex < 0 || monthIndex > 11) {
    return { startDate, endDate: startDate };
  }

  return {
    startDate,
    endDate: formatCalendarDate(new Date(year, monthIndex + 1, 0)),
  };
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
  const entries = buildPhaseCalendarEntries(await buildJobsList(client, orgId, 0, lifecycleFilter));
  if (normalizedView === "week") {
    const rangeStart = getCalendarWeekStart(normalizedAnchorDate);
    const rangeEnd = shiftCalendarDate(rangeStart, 6);
    return entries.filter((entry) => calendarEntryOverlapsRange(entry, rangeStart, rangeEnd));
  }

  const monthRange = getCalendarMonthRange(normalizedAnchorDate);
  return entries.filter((entry) => calendarEntryOverlapsRange(entry, monthRange.startDate, monthRange.endDate));
}

async function buildJobDetail(client: any, orgId: string, jobNumber: unknown) {
  const normalizedJobNumber = requireString(jobNumber, "jobNumber");
  let header: any = null;
  let allocations: any[] = [];
  let filmOrders: any[] = [];
  let requirements: any[] = [];
  let caulkRequirements: any[] = [];
  let caulkAllocations: any[] = [];
  let caulkCheckouts: any[] = [];
  [
    header,
    allocations,
    filmOrders,
    requirements,
    caulkRequirements,
    caulkAllocations,
    caulkCheckouts,
  ] = await Promise.all([
    findJobByNumber(client, orgId, normalizedJobNumber),
    listAllocationsByJob(client, orgId, normalizedJobNumber),
    listFilmOrdersByJob(client, orgId, normalizedJobNumber),
    listJobRequirementsByJob(client, orgId, normalizedJobNumber),
    listJobCaulkRequirementsByJob(client, orgId, normalizedJobNumber),
    listCaulkJobAllocationsByJob(client, orgId, normalizedJobNumber),
    listCaulkJobCheckoutsByJob(client, orgId, normalizedJobNumber),
  ]);
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
  const phases = header?.id ? await listJobPhasesByJobId(client, orgId, header.id) : [];
  const filmOrderLinks = await listFilmOrderLinksByFilmOrderIds(
    orgId,
    filmOrders.map((entry) => asTrimmedString(entry?.filmOrderId))
  );
  const boxes = await listBoxesByIds(orgId, collectJobBoxIds(allocations, rollHistory, filmOrderLinks));
  const boxById = indexBoxesById(boxes);
  const pendingTransfersByBoxRecordId = indexPendingBoxTransfersByBoxRecordId(
    await listPendingBoxTransfersByBoxRecordIds(
      client,
      orgId,
      boxes.map((box) => box.id).filter(Boolean),
    ),
  );
  const publicRequirements = buildPublicJobRequirementEntries(requirements, allocations, boxById);
  const publicCaulkRequirements = buildPublicCaulkRequirementEntries(caulkRequirements, caulkAllocations, {
    jobNumber: normalizedJobNumber,
    jobWarehouse: header?.warehouse || "",
  });
  const filmTransferAlerts = buildJobFilmTransferAlerts(
    header?.warehouse || "",
    allocations,
    boxById,
    pendingTransfersByBoxRecordId,
  );
  const caulkTransferAlerts = buildJobCaulkTransferAlerts(
    header?.warehouse || "",
    caulkAllocations,
  );
  /**
   * PURPOSE:
   * Keep single-job detail reads scoped to boxes referenced by the job instead
   * of loading the full org inventory.
   *
   * AFFECTS:
   * GET /jobs/get, post-mutation job detail reloads, readiness status, and
   * staged-pickup transfer warnings.
   *
   * WHEN CHANGING THIS, ALSO CHECK:
   * backend runtimeJobDetails.mjs, deriveInStockReadinessStatus, film order
   * linked-box enrichment, and route timing logs for /jobs/get.
   *
   * COMMON FAILURE MODES:
   * Full inventory refetch regressions, missing linked boxes in allocation
   * coverage, or Edge/backend detail drift.
   */
  return {
    summary: buildJobListEntry(header, publicRequirements, allocations, filmOrders, publicCaulkRequirements, boxById, {
      allBoxes: boxes,
      caulkAllocations,
      caulkStockEntries: [],
      jobWarehouse: header?.warehouse || "",
      phases,
    }),
    phases: buildJobListEntry(header, publicRequirements, allocations, filmOrders, publicCaulkRequirements, boxById, {
      allBoxes: boxes,
      caulkAllocations,
      caulkStockEntries: [],
      jobWarehouse: header?.warehouse || "",
      phases,
    }).phases || [],
    requirements: publicRequirements,
    allocations: buildPublicAllocationEntriesForJob(allocations, boxById),
    usage: buildPublicJobUsageEntries(rollHistory, boxById),
    usageTimeline: buildPublicJobUsageTimelineEntries(
      normalizedJobNumber,
      rollHistory,
      boxById,
      caulkCheckouts,
      filmOrderLinks,
      filmOrders
    ),
    caulkRequirements: publicCaulkRequirements,
    caulkAllocations: caulkAllocations,
    caulkCheckouts: caulkCheckouts,
    filmOrders: await buildPublicFilmOrdersForJob(client, orgId, filmOrders, { boxById }),
    filmTransferAlerts,
    caulkTransferAlerts,
  };
}

export async function buildJobDetailById(client: any, orgId: string, jobId: unknown) {
  const header = await findJobById(client, orgId, requireString(jobId, "jobId"));
  if (!header) {
    throw new HttpError(404, "Job not found.");
  }

  const normalizedJobNumber = requireString(header.jobNumber, "jobNumber");
  const [
    allocations,
    filmOrders,
    phases,
    requirements,
    caulkRequirements,
    caulkAllocations,
  ] = await Promise.all([
    listAllocationsByJobIdDirect(orgId, header.id),
    listFilmOrdersByJobIdDirect(orgId, header.id),
    listJobPhasesByJobId(client, orgId, header.id),
    listJobRequirementsByJobIdDirect(orgId, header),
    listJobCaulkRequirementsByJobIdDirect(orgId, header),
    listCaulkJobAllocationsByJobIdDirect(orgId, header.id),
  ]);
  const [caulkCheckouts, rollHistory] = await Promise.all([
    listCaulkJobCheckoutsByJobIdDirect(orgId, header.id),
    listRollHistoryForJobAllocations(client, orgId, allocations),
  ]);

  const filmOrderLinks = await listFilmOrderLinksByFilmOrderIds(
    orgId,
    filmOrders.map((entry) => asTrimmedString(entry?.filmOrderId)),
  );
  const boxes = await listBoxesByIds(orgId, collectJobBoxIds(allocations, rollHistory, filmOrderLinks));
  const boxById = indexBoxesById(boxes);
  const pendingTransfersByBoxRecordId = indexPendingBoxTransfersByBoxRecordId(
    await listPendingBoxTransfersByBoxRecordIds(
      client,
      orgId,
      boxes.map((box) => box.id).filter(Boolean),
    ),
  );
  const publicRequirements = buildPublicJobRequirementEntries(requirements, allocations, boxById);
  const publicCaulkRequirements = buildPublicCaulkRequirementEntries(caulkRequirements, caulkAllocations, {
    jobNumber: normalizedJobNumber,
    jobWarehouse: header?.warehouse || "",
  });
  const filmTransferAlerts = buildJobFilmTransferAlerts(
    header?.warehouse || "",
    allocations,
    boxById,
    pendingTransfersByBoxRecordId,
  );
  const caulkTransferAlerts = buildJobCaulkTransferAlerts(
    header?.warehouse || "",
    caulkAllocations,
  );

  return {
    summary: buildJobListEntry(header, publicRequirements, allocations, filmOrders, publicCaulkRequirements, boxById, {
      allBoxes: boxes,
      caulkAllocations,
      caulkStockEntries: [],
      jobWarehouse: header?.warehouse || "",
      phases,
    }),
    phases: buildJobListEntry(header, publicRequirements, allocations, filmOrders, publicCaulkRequirements, boxById, {
      allBoxes: boxes,
      caulkAllocations,
      caulkStockEntries: [],
      jobWarehouse: header?.warehouse || "",
      phases,
    }).phases || [],
    requirements: publicRequirements,
    allocations: buildPublicAllocationEntriesForJob(allocations, boxById),
    usage: buildPublicJobUsageEntries(rollHistory, boxById),
    usageTimeline: buildPublicJobUsageTimelineEntries(
      normalizedJobNumber,
      rollHistory,
      boxById,
      caulkCheckouts,
      filmOrderLinks,
      filmOrders,
    ),
    caulkRequirements: publicCaulkRequirements,
    caulkAllocations: caulkAllocations,
    caulkCheckouts: caulkCheckouts,
    filmOrders: await buildPublicFilmOrdersForJob(client, orgId, filmOrders, { boxById }),
    filmTransferAlerts,
    caulkTransferAlerts,
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
  const allBoxes = await listBoxesSnapshotDirect(orgId);
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

  const allJobEntries = await buildJobsList(client, orgId, 0, undefined, [], {
    preloadedBoxes: allBoxes,
    snapshotConcurrency: 1,
  });
  for (const jobEntry of allJobEntries) {
    const lifecycleStatus = normalizeJobLifecycleStatus(jobEntry.lifecycleStatus);
    if (lifecycleStatus !== "COMPLETED" && lifecycleStatus !== "CANCELLED") {
      continue;
    }
    if (!matchesClosedJobReportFilters(jobEntry, filters)) {
      continue;
    }

    const reportEntry = {
      ...(asTrimmedString(jobEntry.jobId) ? { jobId: asTrimmedString(jobEntry.jobId) } : {}),
      ...(asTrimmedString(jobEntry.workScope ?? jobEntry.sections)
        ? {
            workScope: asTrimmedString(jobEntry.workScope ?? jobEntry.sections),
            sections: asTrimmedString(jobEntry.workScope ?? jobEntry.sections),
          }
        : {}),
      jobNumber: jobEntry.jobNumber,
      warehouse: jobEntry.warehouse,
      installDate: jobEntry.installDate,
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
  const linkedBoxesByFilmOrderId = await buildPublicFilmOrderLinkedBoxesByFilmOrderId(
    orgId,
    sorted.map((entry) => asTrimmedString(entry.filmOrderId)),
  );

  return sorted.map((entry) =>
    toPublicFilmOrder(entry, linkedBoxesByFilmOrderId[asTrimmedString(entry.filmOrderId)] || [])
  );
}

async function buildFilmOrderDetail(client: any, orgId: string, filmOrderId: unknown) {
  const result = await rpcOrThrow<Record<string, unknown> | null>(client, "api_acl_film_orders_get", {
    p_org_id: orgId,
    p_film_order_id: requireString(filmOrderId, "filmOrderId"),
  });
  if (!result) {
    throw new HttpError(404, "Film order not found.");
  }
  return result;
}

async function buildBoxFilmOrderOrigins(client: any, orgId: string, boxId: string) {
  const result = await rpcOrThrow<any[] | null>(client, "api_acl_box_film_order_origins", {
    p_org_id: orgId,
    p_box_id: requireString(boxId, "boxId"),
  });
  return Array.isArray(result) ? result : [];
}

async function buildFilmCatalog(client: any, orgId: string) {
  const entries = await listFilmCatalog(client, orgId);
  const dedupedByKey: Record<string, any> = {};
  for (const entry of entries) {
    const canonical = normalizeCatalogWriteManufacturerAndFilm(entry.manufacturer, entry.filmName);
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

async function resolveAllocationsForCheckoutWithoutBoxMutation(
  _serviceClient: any,
  client: any,
  orgId: string,
  boxId: string,
  jobNumber: string,
  actor: string,
  jobId = "",
) {
  const result = await rpcOrThrow<any>(client, "api_acl_boxes_resolve_checkout_allocations", {
    p_org_id: orgId,
    p_actor: actor,
    p_payload: {
      boxId,
      jobNumber,
      ...(jobId ? { jobId } : {}),
    },
  });

  return {
    fulfilledCount: integerOrZero(result?.fulfilledCount),
    fulfilledFeet: integerOrZero(result?.fulfilledFeet),
    otherJobs: Array.isArray(result?.otherJobs)
      ? result.otherJobs.map((entry: unknown) => asTrimmedString(entry)).filter(Boolean)
      : [],
  };
}

async function executeCheckoutAllJobMaterials(client: any, identity: AuthIdentity, payload: Record<string, unknown>) {
  const warnings: string[] = [];
  const orgId = identity.orgId;
  const actor = identity.actor;
  const target = await resolveEdgeJobMutationTargetById(client, orgId, payload, {
    findJobById,
    normalizeJobNumberDigits,
  });
  const jobNumber = target.usedJobId
    ? requireString(target.jobNumber, "JobNumber")
    : requireString(payload.jobNumber, "JobNumber");
  const targetJobId = target.usedJobId ? requireString(target.jobId, "jobId") : "";
  const serviceClient = requireServiceRoleClientForJobs();
  const { data: legacyJobRow, error: jobError } = target.usedJobId
    ? { data: null, error: null }
    : await serviceClient
      .schema("app")
      .from("jobs")
      .select("id, lifecycle_status, warehouse")
      .eq("org_id", orgId)
      .eq("job_number", jobNumber)
      .maybeSingle();
  throwOnSupabaseError(jobError, "Unable to load job");
  const jobRow = target.usedJobId ? target.job : legacyJobRow;
  if (!jobRow) {
    throw new HttpError(404, `Job ${jobNumber} was not found.`);
  }

  const lifecycleStatus = normalizeJobLifecycleStatus(
    (jobRow as Record<string, unknown>).lifecycleStatus ||
      (jobRow as Record<string, unknown>).lifecycle_status
  );
  if (lifecycleStatus !== "ACTIVE") {
    throw new HttpError(400, `Job ${jobNumber} is closed and checkout-all cannot be changed.`);
  }

  const jobWarehouse = asTrimmedString((jobRow as Record<string, unknown>).warehouse);
  const canonicalHeader = target.usedJobId
    ? { ...(jobRow as Record<string, unknown>), id: targetJobId, jobNumber, warehouse: jobWarehouse }
    : null;
  const canonicalSeedData = target.usedJobId
    ? {
      allocations: await listAllocationsByJobIdDirect(orgId, targetJobId),
      filmOrders: await listFilmOrdersByJobIdDirect(orgId, targetJobId),
      requirements: await listJobRequirementsByJobIdDirect(orgId, canonicalHeader),
      caulkRequirements: await listJobCaulkRequirementsByJobIdDirect(orgId, canonicalHeader),
      caulkAllocations: await listCaulkJobAllocationsByJobIdDirect(orgId, targetJobId),
    }
    : {};
  const preCheckoutState = await loadJobStagingValidationState(
    client,
    orgId,
    jobNumber,
    jobWarehouse,
    canonicalSeedData,
  );
  if (preCheckoutState.filmTransferAlerts.length > 0 && preCheckoutState.caulkTransferAlerts.length > 0) {
    throw new HttpError(400, "Receive transferred film and caulk before checking out this job.");
  }
  if (preCheckoutState.filmTransferAlerts.length > 0) {
    throw new HttpError(400, buildFilmTransferAlertMessage(preCheckoutState.filmTransferAlerts, "checkout"));
  }
  if (preCheckoutState.caulkTransferAlerts.length > 0) {
    throw new HttpError(400, buildCaulkTransferAlertMessage(preCheckoutState.caulkTransferAlerts, "checkout"));
  }
  if (hasActiveOrderedRequirementAllocations(preCheckoutState.allocations, preCheckoutState.boxById)) {
    throw new HttpError(400, buildOrderedAllocationReceiptMessage("checkout"));
  }
  const checkoutPlan = buildFilmCheckoutActionPlan(
    preCheckoutState.allocations,
    preCheckoutState.boxById,
    jobNumber,
  );
  let checkedOutBoxCount = 0;
  let checkedOutCaulkCount = 0;

  for (const step of checkoutPlan) {
    const box = preCheckoutState.boxById[step.boxId];
    if (!box) {
      throw new HttpError(404, `Box ${step.boxId} was not found.`);
    }

    if (boxUsesOrderedPlanning(box)) {
      continue;
    }

    const normalizedBoxStatus = asTrimmedString(box.status).toUpperCase();
    const boxLastCheckoutJobId = asTrimmedString(box.lastCheckoutJobId).toLowerCase();
    const sameJobCheckedOut =
      normalizedBoxStatus === "CHECKED_OUT" &&
      (target.usedJobId
        ? boxLastCheckoutJobId === targetJobId.toLowerCase() ||
          (!boxLastCheckoutJobId && normalizeJobNumberKey(box.lastCheckoutJob) === normalizeJobNumberKey(jobNumber))
        : normalizeJobNumberKey(box.lastCheckoutJob) === normalizeJobNumberKey(jobNumber));

    if (!sameJobCheckedOut && normalizedBoxStatus !== "IN_STOCK") {
      throw new HttpError(
        400,
        `Box ${box.boxId} is ${normalizedBoxStatus || "not in stock"} and cannot be checked out from this view.`,
      );
    }

    if (step.action === "RESOLVE_ONLY" || sameJobCheckedOut) {
      const allocationResolution = await resolveAllocationsForCheckoutWithoutBoxMutation(
        serviceClient,
        client,
        orgId,
        box.boxId,
        jobNumber,
        actor,
        targetJobId,
      );
      if (allocationResolution.fulfilledCount > 0) {
        warnings.push(
          `Kept ${allocationResolution.fulfilledCount} allocation${allocationResolution.fulfilledCount === 1 ? "" : "s"} totaling ${allocationResolution.fulfilledFeet} LF linked to job ${jobNumber} after checkout.`,
        );
      }
      if (allocationResolution.otherJobs.length > 0) {
        warnings.push(`This box still has active allocations for ${allocationResolution.otherJobs.join(", ")}.`);
      }
      continue;
    }

    const checkoutResult = await rpcOrThrow<any>(client, "api_acl_boxes_set_status", {
      p_org_id: orgId,
      p_actor: actor,
      p_payload: {
        boxId: box.boxId,
        status: "CHECKED_OUT",
        ...(target.usedJobId ? { jobId: targetJobId, jobNumber } : {}),
        auditNote: `Checked out for job ${jobNumber}`,
      },
    });
    if (checkoutResult && Array.isArray((checkoutResult as Record<string, unknown>).warnings)) {
      warnings.push(...((checkoutResult as Record<string, unknown>).warnings as unknown[]).map((entry) => asTrimmedString(entry)).filter(Boolean));
    }
    checkedOutBoxCount += 1;
  }

  for (const allocation of preCheckoutState.caulkAllocations) {
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

  const refreshedState = await loadJobStagingValidationState(
    client,
    orgId,
    jobNumber,
    jobWarehouse,
    target.usedJobId
      ? {
        allocations: await listAllocationsByJobIdDirect(orgId, targetJobId),
        filmOrders: await listFilmOrdersByJobIdDirect(orgId, targetJobId),
        requirements: await listJobRequirementsByJobIdDirect(orgId, canonicalHeader),
        caulkRequirements: await listJobCaulkRequirementsByJobIdDirect(orgId, canonicalHeader),
        caulkAllocations: await listCaulkJobAllocationsByJobIdDirect(orgId, targetJobId),
      }
      : {},
  );
  if (refreshedState.blockingReason) {
    throw new HttpError(400, refreshedState.blockingReason);
  }

  if (checkedOutBoxCount > 0 || checkedOutCaulkCount > 0) {
    warnings.push(
      `Checked out ${checkedOutBoxCount} film box${checkedOutBoxCount === 1 ? "" : "es"} and ${checkedOutCaulkCount} caulk allocation${checkedOutCaulkCount === 1 ? "" : "s"} for job ${jobNumber}.`,
    );
  }

  return {
    ...(target.usedJobId ? { jobId: targetJobId } : {}),
    jobNumber,
    warnings,
    stagingState: refreshedState,
  };
}

async function checkoutAllJobMaterials(client: any, identity: AuthIdentity, payload: Record<string, unknown>) {
  return await executeCheckoutAllJobMaterials(client, identity, payload);
}

async function setJobStagedPickup(client: any, identity: AuthIdentity, payload: Record<string, unknown>) {
  const orgId = identity.orgId;
  const actor = identity.actor;
  const target = await resolveEdgeJobMutationTargetById(client, orgId, payload, {
    findJobById,
    normalizeJobNumberDigits,
  });
  const jobNumber = target.usedJobId
    ? requireString(target.jobNumber, "JobNumber")
    : requireString(payload.jobNumber, "JobNumber");
  const targetJobId = target.usedJobId ? requireString(target.jobId, "jobId") : "";
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
  const { data: legacyJobRow, error: jobError } = target.usedJobId
    ? { data: null, error: null }
    : await serviceClient
      .schema("app")
      .from("jobs")
      .select("id, lifecycle_status, warehouse")
      .eq("org_id", orgId)
      .eq("job_number", jobNumber)
      .maybeSingle();
  throwOnSupabaseError(jobError, "Unable to load job");
  const jobRow = target.usedJobId ? target.job : legacyJobRow;
  if (!jobRow) {
    throw new HttpError(404, `Job ${jobNumber} was not found.`);
  }

  const lifecycleStatus = normalizeJobLifecycleStatus(
    (jobRow as Record<string, unknown>).lifecycleStatus ||
      (jobRow as Record<string, unknown>).lifecycle_status
  );
  if (lifecycleStatus !== "ACTIVE") {
    throw new HttpError(400, `Job ${jobNumber} is closed and staged pickup cannot be changed.`);
  }

  const warnings: string[] = [];
  const jobWarehouse = asTrimmedString((jobRow as Record<string, unknown>).warehouse);
  const canonicalHeader = target.usedJobId
    ? { ...(jobRow as Record<string, unknown>), id: targetJobId, jobNumber, warehouse: jobWarehouse }
    : null;
  if (nextIsStaged) {
    let stagingState: Record<string, unknown> | null = null;
    const autoCheckoutRemaining =
      payload.autoCheckoutRemaining === true || asTrimmedString(payload.autoCheckoutRemaining).toLowerCase() === "true";

    if (autoCheckoutRemaining) {
      const checkoutResult = await executeCheckoutAllJobMaterials(
        client,
        identity,
        target.usedJobId ? { ...payload, jobId: targetJobId, jobNumber } : payload,
      );
      warnings.push(...(checkoutResult.warnings || []));
      stagingState = checkoutResult.stagingState || null;
    }

    if (!stagingState) {
      stagingState = await loadJobStagingValidationState(
        client,
        orgId,
        jobNumber,
        jobWarehouse,
        target.usedJobId
          ? {
            allocations: await listAllocationsByJobIdDirect(orgId, targetJobId),
            filmOrders: await listFilmOrdersByJobIdDirect(orgId, targetJobId),
            requirements: await listJobRequirementsByJobIdDirect(orgId, canonicalHeader),
            caulkRequirements: await listJobCaulkRequirementsByJobIdDirect(orgId, canonicalHeader),
            caulkAllocations: await listCaulkJobAllocationsByJobIdDirect(orgId, targetJobId),
          }
          : {},
      );
    }
    if (stagingState.blockingReason) {
      throw new HttpError(400, String(stagingState.blockingReason));
    }
  }

  const updatedAt = new Date().toISOString();
  const { error: updateError } = await serviceClient
    .schema("app")
    .from("jobs")
    .update({
      is_staged_for_pickup: nextIsStaged,
      updated_at: updatedAt,
      updated_by: actor,
    })
    .eq("org_id", orgId)
    .eq("id", target.usedJobId ? targetJobId : (jobRow as Record<string, unknown>).id);
  throwOnSupabaseError(updateError, "Unable to update staged pickup");

  return {
    ...(target.usedJobId ? { jobId: targetJobId } : {}),
    jobNumber,
    isStagedForPickup: nextIsStaged,
    updatedAt,
    warnings,
  };
}

async function getBoxTransferByBox(client: any, orgId: string, boxId: string) {
  const { box, transfer } = await getLatestBoxTransferByBoxId(client, orgId, boxId);
  if (!box) {
    throw new HttpError(404, "Box not found.");
  }

  return ok(transfer ? toPublicBoxTransfer(transfer) : null);
}

function buildTransferDestinationConflictMessage(destinationBoxId: string, conflict: any) {
  const normalizedDestinationBoxId = requireString(destinationBoxId, "DestinationBoxID").toUpperCase();
  if (!conflict) {
    return `Arrival BoxID ${normalizedDestinationBoxId} is not available.`;
  }

  if (conflict.conflictType === "alias") {
    return `Arrival BoxID ${normalizedDestinationBoxId} is already kept as an alias for ${conflict.conflictBoxId}.`;
  }

  if (conflict.conflictType === "pending_transfer") {
    return `Arrival BoxID ${normalizedDestinationBoxId} is already reserved by another pending transfer.`;
  }

  return `Arrival BoxID ${normalizedDestinationBoxId} already exists.`;
}

function isPendingTransferReservationConflict(error: unknown) {
  return (
    Boolean(error) &&
    typeof error === "object" &&
    (error as Record<string, unknown>).code === "23505" &&
    String((error as Record<string, unknown>).constraint || "").includes("idx_box_transfers_one_pending_destination_box")
  );
}

async function resolveBoxTransferPlan(client: any, orgId: string, payload: Record<string, unknown>) {
  const boxId = requireString(payload.boxId, "BoxID").toUpperCase();
  const box = await findBoxById(client, orgId, boxId);
  if (!box) {
    throw new HttpError(404, `Box ${boxId} was not found.`);
  }

  if (asTrimmedString(box.status).toUpperCase() !== "IN_STOCK") {
    throw new HttpError(400, `Box ${box.boxId} must be in stock before it can be transferred.`);
  }

  const boxRecordId = requireBoxRecordId(box, "starting a box transfer");
  const existingPendingTransfer = await findPendingBoxTransferByBoxRecordId(client, orgId, boxRecordId);
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

  const warehousePrefixes = await listWarehouseBoxIdPrefixes(client, orgId);
  let destinationBoxId = "";
  try {
    destinationBoxId = planTransferredBoxId(
      box.boxId,
      sourceWarehouse.boxIdPrefix,
      destinationWarehouse.boxIdPrefix,
      warehousePrefixes,
      asTrimmedString(payload.destinationBoxIdOverride) || undefined,
    );
  } catch (error) {
    throw new HttpError(
      400,
      error instanceof Error ? error.message : "Arrival Box ID is not valid for this destination warehouse.",
    );
  }

  const conflict = await findBoxIdConflict(client, orgId, destinationBoxId, {
    excludedBoxRecordId: boxRecordId,
  });

  return {
    box,
    boxRecordId,
    sourceWarehouse,
    destinationWarehouse,
    destinationBoxId,
    conflict,
  };
}

async function getBoxTransferPlan(client: any, orgId: string, payload: Record<string, unknown>) {
  const plan = await resolveBoxTransferPlan(client, orgId, payload);
  return ok({
    destinationBoxId: plan.destinationBoxId,
    available: !plan.conflict,
    conflictType: plan.conflict?.conflictType || null,
    conflictBoxId: plan.conflict?.conflictBoxId || null,
  });
}

async function startBoxTransfer(client: any, identity: AuthIdentity, payload: Record<string, unknown>) {
  const orgId = identity.orgId;
  const actor = identity.actor;
  const warnings: string[] = [];
  const { box, boxRecordId, sourceWarehouse, destinationWarehouse, destinationBoxId, conflict } =
    await resolveBoxTransferPlan(client, orgId, payload);
  if (conflict) {
    throw new HttpError(400, buildTransferDestinationConflictMessage(destinationBoxId, conflict));
  }

  let transfer;
  try {
    transfer = await saveBoxTransferRecord(client, orgId, {
      transferId: createTransferId(),
      boxRecordId,
      sourceBoxId: box.boxId,
      destinationBoxId,
      sourceWarehouse: sourceWarehouse.code,
      destinationWarehouse: destinationWarehouse.code,
      status: "PENDING",
      notes: asTrimmedString(payload.notes),
      createdAt: new Date().toISOString(),
      createdBy: actor,
      updatedAt: new Date().toISOString(),
      updatedBy: actor,
    });
  } catch (error) {
    if (isPendingTransferReservationConflict(error)) {
      const raceConflict = await findBoxIdConflict(client, orgId, destinationBoxId, {
        excludedBoxRecordId: boxRecordId,
      });
      throw new HttpError(409, buildTransferDestinationConflictMessage(destinationBoxId, raceConflict));
    }
    throw error;
  }

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
    .eq("id", boxRecordId);
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

  const destinationWarehouse = await findWarehouseEntry(client, orgId, transfer.destinationWarehouse, "DestinationWarehouse");
  const destinationBoxId = requireString(transfer.destinationBoxId, "DestinationBoxID").toUpperCase();
  const receiveConflict = await findBoxIdConflict(client, orgId, destinationBoxId, {
    excludedBoxRecordId: box.id,
    excludedTransferId: transfer.transferId,
  });
  if (receiveConflict) {
    throw new HttpError(409, buildTransferDestinationConflictMessage(destinationBoxId, receiveConflict));
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
  const target = await resolveEdgeJobMutationTargetById(client, orgId, payload, {
    findJobById,
    normalizeJobNumberDigits,
  });
  const targetJobId = target.usedJobId ? requireString(target.jobId, "jobId") : "";
  const jobNumber = target.usedJobId
    ? requireString(target.jobNumber, "JobNumber")
    : requireString(payload.jobNumber, "JobNumber");
  const serviceClient = requireServiceRoleClientForJobs();

  const { data: legacyJobRow, error: jobError } = target.usedJobId
    ? { data: null, error: null }
    : await serviceClient
      .schema("app")
      .from("jobs")
      .select("id, org_id, job_number, lifecycle_status")
      .eq("org_id", orgId)
      .eq("job_number", jobNumber)
      .maybeSingle();
  throwOnSupabaseError(jobError, "Unable to load job");
  const jobRow = target.usedJobId
    ? {
        id: targetJobId,
        org_id: orgId,
        job_number: jobNumber,
        lifecycle_status: asTrimmedString((target.job as Record<string, unknown> | null)?.lifecycleStatus) || "ACTIVE",
      }
    : legacyJobRow;
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
    .select("box_id, last_checkout_job, last_checkout_job_id")
    .eq("org_id", orgId)
    .eq("status", "CHECKED_OUT");
  throwOnSupabaseError(checkedOutError, "Unable to load checked-out boxes");
  const normalizedTargetJobId = targetJobId.toLowerCase();
  const normalizedTargetJobNumber = normalizeJobNumberKey(jobNumber);
  const matchingCheckedOutRows = (Array.isArray(checkedOutRows) ? checkedOutRows : []).filter((row) => {
    const entry = row as Record<string, unknown>;
    if (!target.usedJobId) {
      return normalizeJobNumberKey(entry.last_checkout_job) === normalizedTargetJobNumber;
    }

    const boxJobId = asTrimmedString(entry.last_checkout_job_id).toLowerCase();
    return (
      boxJobId === normalizedTargetJobId ||
      (!boxJobId && normalizeJobNumberKey(entry.last_checkout_job) === normalizedTargetJobNumber)
    );
  });
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

  let openCaulkCheckoutCount = 0;
  if (target.usedJobId) {
    const { data: activeCaulkAllocationRows, error: activeCaulkAllocationError } = await serviceClient
      .schema("app")
      .from("caulk_job_allocations")
      .select("id")
      .eq("org_id", orgId)
      .eq("job_id", targetJobId);
    throwOnSupabaseError(activeCaulkAllocationError, "Unable to resolve caulk allocations for selected job");
    const caulkAllocationIds = (Array.isArray(activeCaulkAllocationRows) ? activeCaulkAllocationRows : [])
      .map((row) => asTrimmedString((row as Record<string, unknown>).id))
      .filter(Boolean);
    if (caulkAllocationIds.length) {
      const { data: openCaulkCheckoutRows, error: openCaulkCheckoutError } = await serviceClient
        .schema("app")
        .from("caulk_job_checkouts")
        .select("caulk_checkout_id")
        .eq("org_id", orgId)
        .eq("status", "OPEN")
        .in("caulk_allocation_id", caulkAllocationIds);
      throwOnSupabaseError(openCaulkCheckoutError, "Unable to load open caulk checkouts");
      openCaulkCheckoutCount = Array.isArray(openCaulkCheckoutRows) ? openCaulkCheckoutRows.length : 0;
    }
  } else {
    const { data: openCaulkCheckoutRows, error: openCaulkCheckoutError } = await serviceClient
      .schema("app")
      .from("caulk_job_checkouts")
      .select("caulk_checkout_id")
      .eq("org_id", orgId)
      .eq("status", "OPEN")
      .eq("job_number", jobNumber);
    throwOnSupabaseError(openCaulkCheckoutError, "Unable to load open caulk checkouts");
    openCaulkCheckoutCount = Array.isArray(openCaulkCheckoutRows) ? openCaulkCheckoutRows.length : 0;
  }
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
    .eq("status", "ACTIVE")
    .eq(target.usedJobId ? "job_id" : "job_number", target.usedJobId ? targetJobId : jobNumber);
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
      .select("id, status, feet_available, initial_feet")
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

    const nextFeetAvailable = getNextFeetAvailableAfterAllocationRelease({
      status: boxStatus,
      feetAvailable: integerOrZero((boxRow as Record<string, unknown>).feet_available),
      initialFeet: integerOrZero((boxRow as Record<string, unknown>).initial_feet),
    }, releasedFeet);
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
    .in("status", ["FILM_ORDER", "FILM_ON_THE_WAY"])
    .eq(target.usedJobId ? "job_id" : "job_number", target.usedJobId ? targetJobId : jobNumber);
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
      ...(target.usedJobId ? { jobId: targetJobId } : {}),
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
    .eq("id", target.usedJobId ? targetJobId : (jobRow as Record<string, unknown>).id);
  throwOnSupabaseError(completeJobError, "Unable to mark job completed");

  warnings.push(
    `Marked job ${jobNumber} completed. Cancelled ${cancelledAllocationCount} active film allocation${cancelledAllocationCount === 1 ? "" : "s"}, ${cancelledCaulkAllocationCount} active caulk allocation${cancelledCaulkAllocationCount === 1 ? "" : "s"}, released ${releasedReservedCaulkTubes} reserved caulk tube${releasedReservedCaulkTubes === 1 ? "" : "s"}, and cancelled ${cancelledFilmOrderCount} open film order${cancelledFilmOrderCount === 1 ? "" : "s"}.`,
  );

  return ok(
    target.usedJobId ? await buildJobDetailById(client, orgId, targetJobId) : await buildJobDetail(client, orgId, jobNumber),
    warnings,
  );
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

  const suppliedJobId = asTrimmedString(payload.jobId);
  if (suppliedJobId && !JOB_ID_PATTERN.test(suppliedJobId)) {
    throw new HttpError(400, "jobId must be a valid UUID.");
  }
  const suppliedJobNumber = normalizeJobNumberDigits(requireString(payload.jobNumber, "Job ID number"));
  if (!suppliedJobNumber) {
    throw new HttpError(400, "Job ID number must include at least one digit.");
  }
  const target = await resolveEdgeJobMutationTargetById(client, orgId, {
    ...payload,
    jobNumber: suppliedJobNumber,
  }, {
    findJobById,
    normalizeJobNumberDigits,
  });
  const targetJobId = target.usedJobId ? requireString(target.jobId, "jobId") : "";
  const jobNumber = target.usedJobId
    ? requireString(target.jobNumber, "JobNumber")
    : suppliedJobNumber;
  const existingJob = target.usedJobId ? target.job : await findJobByNumber(client, orgId, jobNumber);
  if (!existingJob) {
    throw new HttpError(404, `Job ${jobNumber} was not found.`);
  }

  const canonicalHeader = target.usedJobId
    ? { ...(existingJob as Record<string, unknown>), id: targetJobId, jobNumber }
    : null;
  const existingAllocations = target.usedJobId
    ? await listAllocationsByJobIdDirect(orgId, targetJobId)
    : await listAllocationsByJob(client, orgId, jobNumber);
  const existingFilmOrders = target.usedJobId
    ? await listFilmOrdersByJobIdDirect(orgId, targetJobId)
    : await listFilmOrdersByJob(client, orgId, jobNumber);
  const existingRequirements = target.usedJobId
    ? await listJobRequirementsByJobIdDirect(orgId, canonicalHeader)
    : await listJobRequirementsByJob(client, orgId, jobNumber);
  const existingCaulkRequirements = target.usedJobId
    ? await listJobCaulkRequirementsByJobIdDirect(orgId, canonicalHeader)
    : await listJobCaulkRequirementsByJob(client, orgId, jobNumber);
  const existingCaulkAllocations = target.usedJobId
    ? await listCaulkJobAllocationsByJobIdDirect(orgId, targetJobId)
    : await listCaulkJobAllocationsByJob(client, orgId, jobNumber);
  const existingCaulkCheckouts = target.usedJobId
    ? await listCaulkJobCheckoutsByJobIdDirect(orgId, targetJobId)
    : await listCaulkJobCheckoutsByJob(client, orgId, jobNumber);
  const existingRollHistory = target.usedJobId
    ? await listRollHistoryForJobAllocations(client, orgId, existingAllocations)
    : await listRollHistoryByJob(client, orgId, jobNumber, existingAllocations);
  const normalizedTargetJobId = targetJobId.toLowerCase();
  const normalizedTargetJobNumber = normalizeJobNumberKey(jobNumber);
  const checkedOutBoxes = (await listBoxes(client, orgId)).filter((box) => {
    if (box.status !== "CHECKED_OUT") {
      return false;
    }
    if (!target.usedJobId) {
      return normalizeJobNumberKey(box.lastCheckoutJob) === normalizedTargetJobNumber;
    }

    const boxJobId = asTrimmedString(box.lastCheckoutJobId).toLowerCase();
    return (
      boxJobId === normalizedTargetJobId ||
      (!boxJobId && normalizeJobNumberKey(box.lastCheckoutJob) === normalizedTargetJobNumber)
    );
  });
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
    .eq(target.usedJobId ? "job_id" : "job_number", target.usedJobId ? targetJobId : jobNumber)
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
      .select("id, status, feet_available, initial_feet")
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

    const nextFeetAvailable = getNextFeetAvailableAfterAllocationRelease({
      status: boxStatus,
      feetAvailable: integerOrZero((boxRow as Record<string, unknown>).feet_available),
      initialFeet: integerOrZero((boxRow as Record<string, unknown>).initial_feet),
    }, releasedFeet);
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
      ...(target.usedJobId ? { jobId: targetJobId } : {}),
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
    .eq(target.usedJobId ? "job_id" : "job_number", target.usedJobId ? targetJobId : jobNumber);
  throwOnSupabaseError(deleteAllocationsError, `Unable to delete film allocations for job ${jobNumber}`);

  const { error: deleteCaulkAllocationsError } = await serviceClient
    .schema("app")
    .from("caulk_job_allocations")
    .delete()
    .eq("org_id", orgId)
    .eq(target.usedJobId ? "job_id" : "job_number", target.usedJobId ? targetJobId : jobNumber);
  throwOnSupabaseError(deleteCaulkAllocationsError, `Unable to delete caulk allocations for job ${jobNumber}`);

  if (target.usedJobId) {
    const { error: deleteSelectedRollHistoryError } = await serviceClient
      .schema("app")
      .from("roll_weight_log")
      .delete()
      .eq("org_id", orgId)
      .eq("job_id", targetJobId);
    throwOnSupabaseError(deleteSelectedRollHistoryError, `Unable to delete selected roll history for job ${jobNumber}`);

    const { error: deleteLegacyRollHistoryError } = await serviceClient
      .schema("app")
      .from("roll_weight_log")
      .delete()
      .eq("org_id", orgId)
      .is("job_id", null)
      .eq("job_number", jobNumber);
    throwOnSupabaseError(deleteLegacyRollHistoryError, `Unable to delete legacy roll history for job ${jobNumber}`);
  } else {
    const { error: deleteRollHistoryError } = await serviceClient
      .schema("app")
      .from("roll_weight_log")
      .delete()
      .eq("org_id", orgId)
      .eq("job_number", jobNumber);
    throwOnSupabaseError(deleteRollHistoryError, `Unable to delete roll history for job ${jobNumber}`);
  }

  const { error: deleteRequirementsError } = await serviceClient
    .schema("app")
    .from("job_requirements")
    .delete()
    .eq("org_id", orgId)
    .eq("job_id", target.usedJobId ? targetJobId : existingJob.id);
  throwOnSupabaseError(deleteRequirementsError, `Unable to delete job requirements for job ${jobNumber}`);

  const { error: deleteCaulkRequirementsError } = await serviceClient
    .schema("app")
    .from("job_caulk_requirements")
    .delete()
    .eq("org_id", orgId)
    .eq("job_id", target.usedJobId ? targetJobId : existingJob.id);
  throwOnSupabaseError(deleteCaulkRequirementsError, `Unable to delete caulk requirements for job ${jobNumber}`);

  const { error: deleteJobError } = await serviceClient
    .schema("app")
    .from("jobs")
    .delete()
    .eq("org_id", orgId)
    .eq("id", target.usedJobId ? targetJobId : existingJob.id);
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

  return ok(target.usedJobId ? { jobId: targetJobId, jobNumber } : { jobNumber }, warnings);
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

  const linkedBoxSummary = await summarizeFilmOrderLinkedBoxes(client, orgId, filmOrderId);
  const orderedFeet = linkedBoxSummary.orderedFeet;

  const requestedFeet = integerOrZero(existing.requestedFeet);
  const remainingToOrderFeet = Math.max(requestedFeet - orderedFeet, 0);
  let nextStatus = asTrimmedString(existing.status) || "FILM_ORDER";
  let resolvedAt: string | null = existing.resolvedAt || null;
  let resolvedBy: string | null = existing.resolvedBy || null;

  if (nextStatus !== "CANCELLED") {
    if (linkedBoxSummary.hasLinkedBoxes) {
      if (orderedFeet < requestedFeet) {
        nextStatus = "FILM_ORDER";
        resolvedAt = null;
        resolvedBy = null;
      } else if (linkedBoxSummary.allLinkedBoxesReceived) {
        nextStatus = "FULFILLED";
        if (!resolvedAt) {
          resolvedAt = new Date().toISOString();
          resolvedBy = actor;
        }
      } else {
        nextStatus = "FILM_ON_THE_WAY";
        resolvedAt = null;
        resolvedBy = null;
      }
    } else if (coveredFeet >= requestedFeet) {
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
  const orgId = identity.orgId;
  const actor = identity.actor;
  const jobNumber = requireString(payload.jobNumber, "JobNumber");
  const allocationId = requireString(payload.allocationId, "AllocationID");
  const result = await rpcOrThrow<Record<string, unknown>>(client, "api_acl_allocations_remove_box", {
    p_org_id: orgId,
    p_actor: actor,
    p_payload: {
      ...payload,
      jobNumber,
      allocationId,
    },
  });

  return ok({
    jobNumber: asTrimmedString(result.jobNumber),
    allocationId: asTrimmedString(result.allocationId),
    boxId: asTrimmedString(result.boxId),
    removedAllocationCount: integerOrZero(result.removedAllocationCount),
    releasedFeet: integerOrZero(result.releasedFeet),
  }, Array.isArray(result.warnings) ? result.warnings.map(asTrimmedString).filter(Boolean) : []);
}

async function reopenJob(client: any, identity: AuthIdentity, payload: Record<string, unknown>) {
  if (identity.role !== "owner") {
    throw new HttpError(403, "Owner access is required to reopen jobs.");
  }

  const warnings: string[] = [];
  const orgId = identity.orgId;
  const actor = identity.actor;
  const target = await resolveEdgeJobMutationTargetById(client, orgId, payload, {
    findJobById,
    normalizeJobNumberDigits,
  });
  const jobNumber = target.usedJobId ? target.jobNumber : requireString(payload.jobNumber, "JobNumber");
  const serviceClient = requireServiceRoleClientForJobs();

  let jobRow: Record<string, unknown> | null = null;
  if (target.usedJobId) {
    jobRow = target.job;
  } else {
    const { data, error: jobError } = await serviceClient
      .schema("app")
      .from("jobs")
      .select("id, lifecycle_status")
      .eq("org_id", orgId)
      .eq("job_number", jobNumber)
      .maybeSingle();
    throwOnSupabaseError(jobError, "Unable to load job");
    jobRow = data as Record<string, unknown> | null;
    if (!jobRow) {
      throw new HttpError(404, `Job ${jobNumber} was not found.`);
    }
  }

  if (!jobRow) {
    throw new HttpError(404, `Job ${jobNumber} was not found.`);
  }

  const lifecycleStatus = normalizeJobLifecycleStatus(jobRow.lifecycleStatus || jobRow.lifecycle_status);
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
    .eq("id", jobRow.id || jobRow.jobId || jobRow.job_id);
  throwOnSupabaseError(reopenError, "Unable to reopen job");

  warnings.push(`Reopened job ${jobNumber}. Previously cancelled allocations and film orders remain cancelled.`);
  return ok(
    target.usedJobId ? await buildJobDetailById(client, orgId, target.jobId) : await buildJobDetail(client, orgId, jobNumber),
    warnings,
  );
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
    const canonical = await resolveCatalogWriteFilmEntry(client, orgId, source.manufacturer, source.filmName);
    normalized.push({
      ...source,
      manufacturer: canonical.manufacturer,
      filmName: canonical.filmName,
    });
  }

  return normalized;
}

export async function canonicalizeMutationPayloadForRoute(
  client: any,
  orgId: string,
  logicalPath: string,
  payload: Record<string, unknown>,
) {
  const next = normalizeSchedulePayloadAliases(logicalPath, payload) as Record<string, unknown>;

  if (logicalPath === "/boxes/add" || logicalPath === "/boxes/update") {
    assertAveryNaturaShadeForWrite(next.manufacturer, next.filmName, "FilmName");
    const canonical = await resolveCatalogWriteFilmEntry(client, orgId, next.manufacturer, next.filmName);
    next.manufacturer = canonical.manufacturer;
    next.filmName = canonical.filmName;
    next.filmKey = normalizeCatalogWriteFilmKeyInput(
      canonical.manufacturer,
      canonical.filmName,
      next.filmKey,
    );
    return next;
  }

  if (logicalPath === "/boxes/set-status") {
    if (typeof next.coreType === "string") {
      next.coreType = asTrimmedString(next.coreType);
    }
    return next;
  }

  if (logicalPath === "/boxes/receive") {
    if (typeof next.lotRun === "string") {
      next.lotRun = asTrimmedString(next.lotRun);
    }
    if (typeof next.coreType === "string") {
      next.coreType = asTrimmedString(next.coreType);
    }
    return next;
  }

  if (logicalPath === "/film-orders/create") {
    assertAveryNaturaShadeForWrite(next.manufacturer, next.filmName, "FilmName");
    const canonical = await resolveCatalogWriteFilmEntry(client, orgId, next.manufacturer, next.filmName);
    next.manufacturer = canonical.manufacturer;
    next.filmName = canonical.filmName;
    return next;
  }

  if (logicalPath === "/jobs/create" || logicalPath === "/jobs/update") {
    next.requirements = await canonicalizeRequirementPayloadEntries(client, orgId, next.requirements);
    if (Array.isArray(next.phases)) {
      const phases = [];
      for (let index = 0; index < next.phases.length; index += 1) {
        const phase = next.phases[index];
        if (!phase || typeof phase !== "object") {
          phases.push(phase);
          continue;
        }
        phases.push({
          ...(phase as Record<string, unknown>),
          requirements: await canonicalizeRequirementPayloadEntries(
            client,
            orgId,
            (phase as Record<string, unknown>).requirements,
          ),
        });
      }
      next.phases = phases;
    }
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

async function reconcileAutoPlannedAllocations(
  client: any,
  orgId: string,
  actor: string,
  scope: Record<string, unknown>,
) {
  return await rpcOrThrow<Record<string, unknown>>(client, "api_acl_reconcile_auto_planned_allocations", {
    p_org_id: orgId,
    p_actor: actor,
    p_scope: scope || {},
  });
}

async function dispatchRead(
  client: any,
  identity: AuthIdentity,
  logicalPath: string,
  params: Record<string, unknown>,
) {
  return dispatchReadWithHandlers(client, identity.orgId, logicalPath, params, identity, {
    buildAppAttentionSummary: (readClient, readOrgId, identity) =>
      buildAppAttentionSummaryFromService(readClient, readOrgId, identity, {
        hasActiveJobsNeedingAllocation: hasActiveJobsNeedingAllocationForAttentionSummary,
        buildFilmOrdersList,
        rpcOrThrow,
      }),
    asTrimmedString,
    requireString,
    integerOrZero,
    rpcOrThrow,
    enrichAdminPermissionEntries,
    buildSearchBoxes,
    findBoxById,
    findFilmOrderById,
    listFilmOrderLinksByBoxId: (_readClient: any, readOrgId: string, boxId: string) =>
      listFilmOrderLinksByBoxIdDirect(readOrgId, boxId),
    getBoxTransferByBox,
    getBoxTransferPlan,
    toPublicBox,
    listAudit,
    listAuditEntriesByBox,
    listAllocationsByBox,
    toPublicAllocation,
    buildAllocationJobList,
    buildAllocationJobDetail,
    buildAllocationPreviewPlan,
    normalizeOptionalWarehouse,
    resolveAllocationJobWarehouse,
    resolveJobContext,
    parseCrossWarehouseFlag,
    listBoxes,
    listBoxesByWarehouses,
    buildPendingTransfersByBoxRecordId,
    listJobRequirementsByJob,
    listJobRequirementsByJobId: async (
      _readClient: any,
      readOrgId: string,
      _jobId: string,
      selectedJob: any,
    ) => listJobRequirementsByJobIdDirect(readOrgId, selectedJob),
    buildActiveAllocationsByBoxIndex,
    listActiveAllocations,
    listJobs,
    buildJobsList,
    buildJobsCalendar,
    buildJobsSearchResults,
    findJobByNumber,
    findJobById,
    normalizeJobNumberDigits,
    normalizeJobLifecycleStatus,
    normalizeDateString,
    normalizeCrewLeaderKey,
    buildJobDetail,
    buildJobDetailById,
    buildFilmOrdersList,
    buildFilmOrderDetail,
    buildBoxFilmOrderOrigins,
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
    findPendingBoxTransferByDestinationBoxId,
    findBoxById,
    listAllocationsByBox,
    listJobs,
    toPublicBox,
    startBoxTransfer,
    receiveBoxTransfer,
    cancelBoxTransfer,
    ensureBoxCheckoutCrewCompatibility,
    findJobByNumber,
    findJobById,
    normalizeJobNumberDigits,
    normalizeJobLifecycleStatus,
    listAllocationsByIds,
    toPublicAllocation,
    findFilmOrderById,
    findPlannerSuppressionRequirementById,
    toPublicFilmOrder,
    buildPublicFilmOrderLinkedBoxes,
    removeJobBoxAllocation,
    buildJobDetail,
    buildJobDetailById,
    setJobStagedPickup,
    checkoutAllJobMaterials,
    completeJob,
    reopenJob,
    deleteJob,
    reconcileAutoPlannedAllocations,
  });
}

export async function handleApiRequest(request: Request, canonicalName = "api"): Promise<Response> {
  const startedAt = Date.now();
  const requestId = resolveRouteTimingRequestId(request.headers);
  let logicalPath = "";
  let timingStatusCode = 500;
  let timingOk = false;
  let timingCacheState: "hit" | "miss" | "none" = "none";
  let errorCategory = "";
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

  try {
    const requestUrl = new URL(request.url);
    const requestBody = request.method === "POST" ? await request.text() : "";
    const bodyJson = request.method === "POST" ? parseBodyJson(requestBody) : null;
    logicalPath = resolveLogicalPath(requestUrl, bodyJson, canonicalName);

    if (logicalPath === "/health" || requestUrl.pathname.endsWith("/health")) {
      timingStatusCode = 200;
      timingOk = true;
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
      errorCategory = "ConfigurationError";
      timingStatusCode = 500;
      timingOk = false;
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

    timingCacheState = useCache ? "miss" : "none";
    if (useCache) {
      pruneCache();
      const cached = cache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        const headers = buildCorsHeaders(request);
        headers.set("Content-Type", cached.contentType);
        timingStatusCode = cached.status;
        timingOk = cached.status >= 200 && cached.status < 400;
        timingCacheState = "hit";
        return new Response(cached.body, { status: cached.status, headers });
      }
    }

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
      timingStatusCode = 200;
      timingOk = true;
      return new Response(responseBody, { status: 200, headers });
    }

    ensureEffectiveRouteAccess(identity, logicalPath);

    const params = routeParams(request.method, requestUrl, bodyJson);
    const payload = request.method === "GET"
      ? await dispatchRead(client, identity, logicalPath, params)
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
    timingStatusCode = 200;
    timingOk = true;
    return new Response(responseBody, { status: 200, headers });
  } catch (error) {
    errorCategory = getRouteTimingErrorCategory(error);
    if (error instanceof HttpError) {
      timingStatusCode = error.statusCode;
      timingOk = false;
      return jsonResponse(request, error.statusCode, {
        ok: false,
        error: error.message,
        warnings: error.warnings || [],
        ...(error.details || {}),
      });
    }
    timingStatusCode = 500;
    timingOk = false;
    return jsonResponse(request, 500, {
      ok: false,
      error: error instanceof Error ? error.message : "Unexpected server error.",
      warnings: [],
    });
  } finally {
    maybeLogRouteTiming({
      runtime: "supabase-edge",
      method: request.method,
      route: logicalPath,
      statusCode: timingStatusCode,
      ok: timingOk,
      durationMs: Date.now() - startedAt,
      cache: timingCacheState,
      requestId,
      errorCategory,
    });
  }
}




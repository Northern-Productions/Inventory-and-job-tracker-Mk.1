import {
  canonicalizeManufacturerLabel,
  normalizeManufacturerLookupKey
} from '../../../lib/manufacturerCanonicalization';

const SOLAR_MANUFACTURER_LOOKUP_KEY = normalizeManufacturerLookupKey('3M Solar');

function normalizeLabel(value: string): string {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function normalizeLookup(value: string): string {
  return normalizeLabel(value).toLowerCase();
}

function stripTrailingExteriorSuffix(value: string): { familyFilmName: string; isExterior: boolean } {
  const normalized = normalizeLabel(value);
  if (!/\bexterior$/i.test(normalized)) {
    return {
      familyFilmName: normalized,
      isExterior: false
    };
  }

  const stripped = normalizeLabel(normalized.replace(/\s+exterior$/i, ''));
  return {
    familyFilmName: stripped || normalized,
    isExterior: true
  };
}

function canonicalizeNumericDigits(value: string): string {
  const digitsOnly = value.replace(/[^0-9]/g, '');
  const withoutLeadingZeros = digitsOnly.replace(/^0+/, '');
  return withoutLeadingZeros || '0';
}

export function inferNightVisionCode(value: string): string {
  const normalized = normalizeLabel(value);
  const nightVisionMatch = normalized.match(/\bnight\s*vision\s*(\d{1,3})\b/i);
  if (nightVisionMatch) {
    return canonicalizeNumericDigits(nightVisionMatch[1]);
  }

  const snvMatch = normalized.match(/\bs?nv\s*[-]?\s*(\d{1,3})\b/i);
  if (snvMatch) {
    return canonicalizeNumericDigits(snvMatch[1]);
  }

  const securityNvMatch = normalized.match(/\bs\s*(\d{1,3})\s*nv\b/i);
  if (securityNvMatch) {
    return canonicalizeNumericDigits(securityNvMatch[1]);
  }

  return '';
}

export function canonicalizeJobPlanningManufacturerAndFilm(
  manufacturer: string,
  filmName: string
): { manufacturer: string; filmName: string } {
  const canonicalManufacturer = canonicalizeManufacturerLabel(manufacturer);
  const normalizedFilmName = normalizeLabel(filmName);
  if (normalizeManufacturerLookupKey(canonicalManufacturer) !== SOLAR_MANUFACTURER_LOOKUP_KEY) {
    return {
      manufacturer: canonicalManufacturer,
      filmName: normalizedFilmName
    };
  }

  const nightVisionCode = inferNightVisionCode(normalizedFilmName);
  if (!nightVisionCode) {
    return {
      manufacturer: canonicalManufacturer,
      filmName: normalizedFilmName
    };
  }

  return {
    manufacturer: canonicalManufacturer,
    filmName: `Night Vision ${nightVisionCode}`
  };
}

export function buildJobPlanningFilmKey(manufacturer: string, filmName: string): string {
  const canonical = canonicalizeJobPlanningManufacturerAndFilm(manufacturer, filmName);
  return `${normalizeManufacturerLookupKey(canonical.manufacturer)}|${normalizeLookup(canonical.filmName)}`;
}

export function describeJobPlanningFilm(
  manufacturer: string,
  filmName: string
): {
  manufacturer: string;
  filmName: string;
  familyFilmName: string;
  key: string;
  familyKey: string;
  isExterior: boolean;
} {
  const canonical = canonicalizeJobPlanningManufacturerAndFilm(manufacturer, filmName);
  const { familyFilmName, isExterior } = stripTrailingExteriorSuffix(canonical.filmName);
  const manufacturerKey = normalizeManufacturerLookupKey(canonical.manufacturer);

  return {
    manufacturer: canonical.manufacturer,
    filmName: canonical.filmName,
    familyFilmName,
    key: `${manufacturerKey}|${normalizeLookup(canonical.filmName)}`,
    familyKey: `${manufacturerKey}|${normalizeLookup(familyFilmName)}`,
    isExterior
  };
}

export function buildJobPlanningFilmFamilyKey(manufacturer: string, filmName: string): string {
  return describeJobPlanningFilm(manufacturer, filmName).familyKey;
}

export function canJobPlanningFilmSatisfyRequirement(
  candidateManufacturer: string,
  candidateFilmName: string,
  requirementManufacturer: string,
  requirementFilmName: string
): boolean {
  const candidate = describeJobPlanningFilm(candidateManufacturer, candidateFilmName);
  const requirement = describeJobPlanningFilm(requirementManufacturer, requirementFilmName);
  if (candidate.familyKey !== requirement.familyKey) {
    return false;
  }

  if (requirement.isExterior && !candidate.isExterior) {
    return false;
  }

  return true;
}

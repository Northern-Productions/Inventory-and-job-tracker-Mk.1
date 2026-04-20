function normalizePlanningLabel(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function normalizeLookup(value) {
  return normalizePlanningLabel(value).toLowerCase();
}

function normalizeCompact(value) {
  return normalizeLookup(value).replace(/[^a-z0-9]+/g, '');
}

function canonicalizeNumericDigits(value) {
  const digitsOnly = String(value || '').replace(/[^0-9]/g, '');
  const withoutLeadingZeros = digitsOnly.replace(/^0+/, '');
  return withoutLeadingZeros || '0';
}

function canonicalizeManufacturerLabel(value) {
  const normalized = normalizePlanningLabel(value);
  const key = normalized.toLowerCase();

  if (key === '3m' || key === '3m solar') return '3M Solar';
  if (key === 'fasara' || key === '3m fasara') return '3M Fasara';
  if (key === 'avery' || key === 'avery dennison') return 'Avery Dennison';
  if (key === 'llumar vista' || key === 'llumarvista' || key === 'llumar') return 'Llumar';
  if (key === 'solar guard' || key === 'solargard' || key === 'solar gard' || key === 'sg') return 'Solar Gard';
  if (key === 'solyx' || key === 'sol') return 'SOLYX';
  if (key === 'madico') return 'Madico';
  if (key === 'v-kool' || key === 'vkool' || key === 'aswfvkool') return 'ASWFVKOOL';
  if (key === 'di-noc' || key === 'dinoc') return 'Di-Noc';
  if (key === 'vinyl') return 'Vinyl';

  return normalized;
}

function normalizeManufacturerLookupKey(value) {
  return normalizeLookup(canonicalizeManufacturerLabel(value));
}

const SOLAR_MANUFACTURER_LOOKUP_KEY = normalizeManufacturerLookupKey('3M Solar');
const PREFIX_POLICY_TARGET_MANUFACTURERS = new Set([
  '3M Solar',
  '3M Fasara',
  'Madico',
  'Avery Dennison',
  'Llumar',
  'Solar Gard',
  'SOLYX'
]);
const PREFIX_POLICY_EXEMPT_MANUFACTURERS = new Set(['Security', 'Vinyl']);
const MATCH_KIND_PRIORITY = Object.freeze({
  exact: 0,
  prefix: 1
});

function manufacturerPrefixPatterns(manufacturer) {
  if (manufacturer === '3M Solar') return [/^3m(?:\s+solar)?\s+/i];
  if (manufacturer === '3M Fasara') return [/^3m\s+fasara\s+/i, /^fasara\s+/i, /^3m\s+/i];
  if (manufacturer === 'Solar Gard') {
    return [/^sg\s+/i, /^solar\s*guard\s+/i, /^solar\s+gard\s+/i, /^solarguard\s+/i, /^solargard\s+/i];
  }
  if (manufacturer === 'Llumar') return [/^llumar(?:\s+vista)?\s+/i, /^llumarvista\s+/i];
  if (manufacturer === 'Avery Dennison') return [/^avery\s+dennison\s+/i, /^avery\s+/i, /^ad\s+/i];
  if (manufacturer === 'SOLYX') return [/^solyx\s+/i, /^sol\s+/i];
  if (manufacturer === 'Madico') return [/^madico\s+/i];
  return [];
}

function stripManufacturerPrefixes(manufacturer, filmName) {
  let value = normalizePlanningLabel(filmName);
  const patterns = manufacturerPrefixPatterns(manufacturer);
  if (!value || !patterns.length) {
    return value;
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (let index = 0; index < patterns.length; index += 1) {
      const next = normalizePlanningLabel(value.replace(patterns[index], ''));
      if (next && next !== value) {
        value = next;
        changed = true;
      }
    }
  }

  return value;
}

function normalizeManufacturerPrefixPolicyFilmName(manufacturer, filmName) {
  const canonicalManufacturer = canonicalizeManufacturerLabel(manufacturer);
  const normalizedFilmName = normalizePlanningLabel(filmName);
  if (!normalizedFilmName) {
    return normalizedFilmName;
  }

  if (PREFIX_POLICY_EXEMPT_MANUFACTURERS.has(canonicalManufacturer)) {
    return normalizedFilmName;
  }

  if (!PREFIX_POLICY_TARGET_MANUFACTURERS.has(canonicalManufacturer)) {
    return normalizedFilmName;
  }

  const stripped = stripManufacturerPrefixes(canonicalManufacturer, normalizedFilmName);
  return stripped || normalizedFilmName;
}

function normalizeAveryNaturaShadeFilmName(manufacturer, filmName) {
  const canonicalManufacturer = canonicalizeManufacturerLabel(manufacturer);
  const normalizedFilmName = normalizePlanningLabel(filmName);
  if (!normalizedFilmName || normalizeManufacturerLookupKey(canonicalManufacturer) !== normalizeManufacturerLookupKey('Avery Dennison')) {
    return normalizedFilmName;
  }

  const shadeMatch = normalizedFilmName.match(/^natura\s*0*([0-9]{1,3})(.*)$/i);
  if (!shadeMatch) {
    return normalizedFilmName;
  }

  const digits = canonicalizeNumericDigits(shadeMatch[1] || '');
  const suffix = normalizePlanningLabel(shadeMatch[2] || '');
  if (!suffix) {
    return `Natura ${digits}`;
  }

  return `Natura ${digits}${suffix.startsWith('-') ? '' : ' '}${suffix}`;
}

function normalizeDescriptorTokens(value) {
  return normalizePlanningLabel(value)
    .replace(/\brefl(?:ective)?\.?\b/gi, 'Reflective')
    .replace(/\bone[-\s]*way\b/gi, 'One Way');
}

// Collapse trailing code aliases like "(PR40 Ext)" before family and exterior matching.
function stripTrailingPlanningAliasCode(value) {
  let normalized = normalizePlanningLabel(value);

  while (normalized) {
    const match = normalized.match(/^(.*?)(?:\s*\(([^()]*)\))$/);
    if (!match) {
      return normalized;
    }

    const baseFilmName = normalizePlanningLabel(match[1]);
    const aliasCode = normalizePlanningLabel(match[2]);
    const aliasCompact = normalizeCompact(aliasCode);
    const baseDigitsRaw = String(baseFilmName || '').replace(/[^0-9]/g, '');
    const baseDigits = baseDigitsRaw ? canonicalizeNumericDigits(baseDigitsRaw) : '';

    if (
      !baseFilmName ||
      !aliasCompact ||
      !/[a-z]/.test(aliasCompact) ||
      !/[0-9]/.test(aliasCompact) ||
      !baseDigits ||
      !aliasCompact.includes(baseDigits)
    ) {
      return normalized;
    }

    normalized = baseFilmName;
  }

  return normalized;
}

function stripTrailingExteriorSuffix(value) {
  const normalized = stripTrailingPlanningAliasCode(value);
  if (!/\bexterior$/i.test(normalized)) {
    return {
      familyFilmName: normalized,
      isExterior: false
    };
  }

  const stripped = normalizePlanningLabel(normalized.replace(/\s+exterior$/i, ''));
  return {
    familyFilmName: stripped || normalized,
    isExterior: true
  };
}

function extractCompactBaseCode(value) {
  const normalized = normalizeLookup(value);
  const match = normalized.match(/^([a-z]{1,4})[\s-]*([0-9]{1,4})(?:\b|[^a-z0-9])/);
  if (!match) {
    return '';
  }

  return `${match[1]}${match[2]}`;
}

export function inferNightVisionCode(value) {
  const normalized = normalizePlanningLabel(value);
  const nightVisionMatch = normalized.match(/\bnight\s*vision\s*(\d{1,3})\b/i);
  if (nightVisionMatch) {
    return canonicalizeNumericDigits(nightVisionMatch[1] || '');
  }

  const snvMatch = normalized.match(/\bs?nv\s*[-]?\s*(\d{1,3})\b/i);
  if (snvMatch) {
    return canonicalizeNumericDigits(snvMatch[1] || '');
  }

  const securityNvMatch = normalized.match(/\bs\s*(\d{1,3})\s*nv\b/i);
  if (securityNvMatch) {
    return canonicalizeNumericDigits(securityNvMatch[1] || '');
  }

  return '';
}

export function canonicalizeJobPlanningManufacturerAndFilm(manufacturer, filmName) {
  const canonicalManufacturer = canonicalizeManufacturerLabel(manufacturer);
  let normalizedFilmName = normalizeDescriptorTokens(
    normalizeManufacturerPrefixPolicyFilmName(canonicalManufacturer, filmName)
  );
  normalizedFilmName = normalizeAveryNaturaShadeFilmName(canonicalManufacturer, normalizedFilmName);

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

export function describeJobPlanningFilm(manufacturer, filmName) {
  const canonical = canonicalizeJobPlanningManufacturerAndFilm(manufacturer, filmName);
  const { familyFilmName, isExterior } = stripTrailingExteriorSuffix(canonical.filmName);
  const manufacturerKey = normalizeManufacturerLookupKey(canonical.manufacturer);
  const compactFilmName = normalizeCompact(canonical.filmName);
  const compactFamilyFilmName = normalizeCompact(familyFilmName);
  const compactBaseCode = extractCompactBaseCode(familyFilmName);

  return {
    manufacturer: canonical.manufacturer,
    manufacturerKey,
    filmName: canonical.filmName,
    familyFilmName,
    key: `${manufacturerKey}|${compactFilmName}`,
    familyKey: `${manufacturerKey}|${compactFamilyFilmName}`,
    compactFilmName,
    compactFamilyFilmName,
    compactBaseCode,
    isExterior
  };
}

export function buildJobPlanningFilmKey(manufacturer, filmName) {
  return describeJobPlanningFilm(manufacturer, filmName).key;
}

export function buildJobPlanningFilmFamilyKey(manufacturer, filmName) {
  return describeJobPlanningFilm(manufacturer, filmName).familyKey;
}

export function getJobPlanningFilmMatch(
  candidateManufacturer,
  candidateFilmName,
  requirementManufacturer,
  requirementFilmName
) {
  const candidate = describeJobPlanningFilm(candidateManufacturer, candidateFilmName);
  const requirement = describeJobPlanningFilm(requirementManufacturer, requirementFilmName);

  if (!candidate.compactFamilyFilmName || !requirement.compactFamilyFilmName) {
    return null;
  }

  if (candidate.manufacturerKey !== requirement.manufacturerKey) {
    return null;
  }

  if (requirement.isExterior && !candidate.isExterior) {
    return null;
  }

  if (candidate.familyKey === requirement.familyKey) {
    return {
      kind: 'exact',
      compactLengthDelta: 0,
      candidateFamilyLength: candidate.compactFamilyFilmName.length,
      requirementFamilyLength: requirement.compactFamilyFilmName.length
    };
  }

  if (
    requirement.compactBaseCode &&
    requirement.compactFamilyFilmName === requirement.compactBaseCode &&
    candidate.compactBaseCode === requirement.compactBaseCode &&
    candidate.compactFamilyFilmName.startsWith(requirement.compactFamilyFilmName) &&
    candidate.compactFamilyFilmName.length > requirement.compactFamilyFilmName.length
  ) {
    return {
      kind: 'prefix',
      compactLengthDelta:
        candidate.compactFamilyFilmName.length - requirement.compactFamilyFilmName.length,
      candidateFamilyLength: candidate.compactFamilyFilmName.length,
      requirementFamilyLength: requirement.compactFamilyFilmName.length
    };
  }

  return null;
}

export function compareJobPlanningFilmMatches(left, right) {
  if (left.kind !== right.kind) {
    return MATCH_KIND_PRIORITY[left.kind] - MATCH_KIND_PRIORITY[right.kind];
  }

  if (left.compactLengthDelta !== right.compactLengthDelta) {
    return left.compactLengthDelta - right.compactLengthDelta;
  }

  if (left.candidateFamilyLength !== right.candidateFamilyLength) {
    return left.candidateFamilyLength - right.candidateFamilyLength;
  }

  if (left.requirementFamilyLength !== right.requirementFamilyLength) {
    return left.requirementFamilyLength - right.requirementFamilyLength;
  }

  return 0;
}

export function canJobPlanningFilmSatisfyRequirement(
  candidateManufacturer,
  candidateFilmName,
  requirementManufacturer,
  requirementFilmName
) {
  return Boolean(
    getJobPlanningFilmMatch(
      candidateManufacturer,
      candidateFilmName,
      requirementManufacturer,
      requirementFilmName
    )
  );
}

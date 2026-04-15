import { queryRow } from '../../db/client.mjs';
import { HttpError } from '../../lib/http.mjs';
import {
  asTrimmedString,
  buildFilmKey,
  canonicalizeNumericDigits,
  coerceFeetValue,
  coerceNonNegativeNumber,
  compareCatalogStrings,
  normalizeRequirementWidthKey,
  requireString,
} from './helpers.mjs';

function normalizeCollapsedCatalogLabel(value) {
  return asTrimmedString(value).replace(/\s+/g, ' ');
}

function canonicalizeManufacturerLabel(value) {
  const normalized = normalizeCollapsedCatalogLabel(value);
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

function normalizeCatalogLookupKey(value) {
  return normalizeCollapsedCatalogLabel(value).toLowerCase();
}

function normalizeCatalogManufacturerLookupKey(value) {
  return normalizeCatalogLookupKey(canonicalizeManufacturerLabel(value));
}

const SECURITY_MANUFACTURER_LABEL = 'Security';
const SOLAR_MANUFACTURER_LABEL = '3M Solar';
const PREFIX_POLICY_TARGET_MANUFACTURERS = new Set([
  '3M Solar',
  '3M Fasara',
  'Madico',
  'Avery Dennison',
  'Llumar',
  'Solar Gard',
  'SOLYX',
]);
const PREFIX_POLICY_EXEMPT_MANUFACTURERS = new Set([SECURITY_MANUFACTURER_LABEL, 'Vinyl']);

function manufacturerPrefixPatterns(manufacturer) {
  if (manufacturer === '3M Solar') return [/^3m\s+/i];
  if (manufacturer === '3M Fasara') return [/^3m\s+fasara\s+/i, /^fasara\s+/i, /^3m\s+/i];
  if (manufacturer === 'Solar Gard') return [/^sg\s+/i, /^solar\s*guard\s+/i, /^solar\s+gard\s+/i, /^solarguard\s+/i, /^solargard\s+/i];
  if (manufacturer === 'Llumar') return [/^llumar\s+vista\s+/i, /^llumarvista\s+/i, /^llumar\s+/i];
  if (manufacturer === 'Avery Dennison') return [/^avery\s+dennison\s+/i, /^avery\s+/i, /^ad\s+/i];
  if (manufacturer === 'SOLYX') return [/^solyx\s+/i, /^sol\s+/i];
  if (manufacturer === 'Madico') return [/^madico\s+/i];
  return [];
}

function stripManufacturerPrefixes(manufacturer, filmName) {
  let value = normalizeCollapsedCatalogLabel(filmName);
  const patterns = manufacturerPrefixPatterns(manufacturer);
  if (!patterns.length || !value) {
    return value;
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (let index = 0; index < patterns.length; index += 1) {
      const pattern = patterns[index];
      const next = normalizeCollapsedCatalogLabel(value.replace(pattern, ''));
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

function isAveryDennisonManufacturer(value) {
  return (
    normalizeCatalogManufacturerLookupKey(canonicalizeManufacturerLabel(value)) ===
    normalizeCatalogManufacturerLookupKey('Avery Dennison')
  );
}

function normalizeAveryNaturaShadeFilmName(manufacturer, filmName) {
  const canonicalManufacturer = canonicalizeManufacturerLabel(manufacturer);
  const normalizedFilmName = normalizeCollapsedCatalogLabel(filmName);
  if (!normalizedFilmName) return normalizedFilmName;
  if (!isAveryDennisonManufacturer(canonicalManufacturer)) return normalizedFilmName;

  const shadeMatch = normalizedFilmName.match(/^natura\s*0*([0-9]{1,3})(.*)$/i);
  if (!shadeMatch) return normalizedFilmName;

  const shadeDigits = canonicalizeNumericDigits(shadeMatch[1]);
  const suffix = normalizeCollapsedCatalogLabel(shadeMatch[2] || '');
  if (!suffix) {
    return `Natura ${shadeDigits}`;
  }
  return `Natura ${shadeDigits}${suffix.startsWith('-') ? '' : ' '}${suffix}`;
}

function assertAveryNaturaShadeForWrite(manufacturer, filmName, fieldName) {
  const canonicalManufacturer = canonicalizeManufacturerLabel(manufacturer);
  if (!isAveryDennisonManufacturer(canonicalManufacturer)) return;

  const normalizedFilmName = normalizeCollapsedCatalogLabel(filmName);
  if (!/^natura\b/i.test(normalizedFilmName)) return;
  if (/^natura\s*0*[0-9]+/i.test(normalizedFilmName)) return;

  throw new HttpError(
    400,
    `${fieldName || 'FilmName'} must include an Avery Natura shade number (for example, "Natura 5" or "Natura 30").`
  );
}

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
  if (key === 'solyx') return 'SOLYX';
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
  if (normalizedPrefix === 'SOLYX') {
    return normalizedBase.replace(/^solyx\b/i, 'SOLYX');
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
  if (/^solyx\b/i.test(cleaned)) return 'SOLYX';
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

  if (detection.family === 's800') return withPrefix('Ultra S800');
  if (detection.family === 's70') return withPrefix('S70');
  if (detection.family === 's140') return withPrefix('S140');
  if (detection.family === 'ag') return withPrefix(detection.agCode ? `AG-${detection.agCode}` : 'AG');
  if (detection.family === 's600') return withPrefix('Ultra S600');
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
      filmName: normalizedFilmName,
    };
  }

  const makerPrefix =
    normalizeSecurityMakerPrefix(inferSecurityMakerPrefixFromFilmName(normalizedFilmName)) ||
    normalizeSecurityMakerPrefix(inferSecurityMakerPrefixFromManufacturer(normalizedManufacturer)) ||
    normalizeSecurityMakerPrefix(getDefaultMakerPrefixForSecurityFamily(detection.family));

  return {
    manufacturer: SECURITY_MANUFACTURER_LABEL,
    filmName: buildCanonicalSecurityFilmName(normalizedFilmName, detection, makerPrefix),
  };
}

function inferNightVisionCode(filmName) {
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

  return '';
}

function normalize3MSolarNightVisionManufacturerAndFilm(manufacturer, filmName) {
  const normalizedManufacturer = canonicalizeManufacturerLabel(manufacturer);
  const normalizedFilmName = normalizeCollapsedCatalogLabel(filmName);
  if (
    normalizeCatalogManufacturerLookupKey(normalizedManufacturer) !==
    normalizeCatalogManufacturerLookupKey(SOLAR_MANUFACTURER_LABEL)
  ) {
    return {
      manufacturer: normalizedManufacturer,
      filmName: normalizedFilmName,
    };
  }

  const nightVisionCode = inferNightVisionCode(normalizedFilmName);
  if (!nightVisionCode) {
    return {
      manufacturer: normalizedManufacturer,
      filmName: normalizedFilmName,
    };
  }

  return {
    manufacturer: SOLAR_MANUFACTURER_LABEL,
    filmName: `Night Vision ${nightVisionCode}`,
  };
}

function normalizeCanonicalManufacturerAndFilm(manufacturer, filmName) {
  const securityNormalized = normalizeSecurityManufacturerAndFilm(manufacturer, filmName);
  const solarNormalized = normalize3MSolarNightVisionManufacturerAndFilm(
    securityNormalized.manufacturer,
    securityNormalized.filmName
  );
  const prefixPolicyNormalizedFilmName = normalizeManufacturerPrefixPolicyFilmName(
    solarNormalized.manufacturer,
    solarNormalized.filmName
  );
  return {
    manufacturer: solarNormalized.manufacturer,
    filmName: normalizeAveryNaturaShadeFilmName(
      solarNormalized.manufacturer,
      prefixPolicyNormalizedFilmName
    ),
  };
}

function normalizeCatalogWriteManufacturerAndFilm(manufacturer, filmName) {
  const normalizedManufacturer = canonicalizeManufacturerLabel(manufacturer);
  const normalizedFilmName = normalizeCollapsedCatalogLabel(filmName);
  const solarNormalized = normalize3MSolarNightVisionManufacturerAndFilm(
    normalizedManufacturer,
    normalizedFilmName
  );
  const prefixPolicyNormalizedFilmName = normalizeManufacturerPrefixPolicyFilmName(
    solarNormalized.manufacturer,
    solarNormalized.filmName
  );
  return {
    manufacturer: solarNormalized.manufacturer,
    filmName: normalizeAveryNaturaShadeFilmName(
      solarNormalized.manufacturer,
      prefixPolicyNormalizedFilmName
    ),
  };
}

function normalizeFilmKeyInput(manufacturer, filmName, filmKeyInput) {
  const normalized = normalizeCanonicalManufacturerAndFilm(manufacturer, filmName);
  void filmKeyInput;
  return buildFilmKey(normalized.manufacturer, normalized.filmName);
}

function normalizeCatalogWriteFilmKeyInput(manufacturer, filmName, filmKeyInput) {
  const normalized = normalizeCatalogWriteManufacturerAndFilm(manufacturer, filmName);
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
        normalizeCatalogLookupKey(normalizedFilmName),
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
  const normalized = normalizeCanonicalManufacturerAndFilm(manufacturer, filmName);
  const aliasResolvedFilmName = await resolveCanonicalFilmNameAlias(
    client,
    orgId,
    normalized.manufacturer,
    normalized.filmName
  );
  return normalizeCanonicalManufacturerAndFilm(normalized.manufacturer, aliasResolvedFilmName);
}

async function resolveCatalogWriteFilmEntry(client, orgId, manufacturer, filmName) {
  return normalizeCatalogWriteManufacturerAndFilm(manufacturer, filmName);
}

function normalizeRequirementLookupKey(manufacturer, filmName, widthIn) {
  const canonical = normalizeCanonicalManufacturerAndFilm(manufacturer, filmName);
  return [
    normalizeCatalogManufacturerLookupKey(canonical.manufacturer),
    normalizeCatalogLookupKey(canonical.filmName),
    normalizeRequirementWidthKey(widthIn),
  ].join('|');
}

function dedupeNormalizedJobRequirements(requirements) {
  const deduped = {};

  for (let index = 0; index < requirements.length; index += 1) {
    const entry = requirements[index];
    const key = normalizeRequirementLookupKey(entry.manufacturer, entry.filmName, entry.widthIn);
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
    assertAveryNaturaShadeForWrite(
      entry.manufacturer,
      entry.filmName,
      `Requirements[${index}].FilmName`
    );
    const canonical = await resolveCanonicalFilmEntry(client, orgId, entry.manufacturer, entry.filmName);
    normalized.push({
      ...entry,
      manufacturer: canonical.manufacturer,
      filmName: canonical.filmName,
    });
  }

  return dedupeNormalizedJobRequirements(normalized);
}

async function normalizeJobRequirementEntriesForWrite(client, orgId, requirements) {
  const normalized = [];
  for (let index = 0; index < requirements.length; index += 1) {
    const entry = requirements[index];
    assertAveryNaturaShadeForWrite(
      entry.manufacturer,
      entry.filmName,
      `Requirements[${index}].FilmName`
    );
    const writeEntry = await resolveCatalogWriteFilmEntry(
      client,
      orgId,
      entry.manufacturer,
      entry.filmName
    );
    normalized.push({
      ...entry,
      manufacturer: writeEntry.manufacturer,
      filmName: writeEntry.filmName,
    });
  }

  return dedupeNormalizedJobRequirements(normalized);
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
    requiredFeet,
  };
}

export {
  normalizeCollapsedCatalogLabel,
  canonicalizeManufacturerLabel,
  normalizeCatalogLookupKey,
  normalizeCatalogManufacturerLookupKey,
  manufacturerPrefixPatterns,
  stripManufacturerPrefixes,
  normalizeManufacturerPrefixPolicyFilmName,
  isAveryDennisonManufacturer,
  normalizeAveryNaturaShadeFilmName,
  assertAveryNaturaShadeForWrite,
  normalizeMilTokenSpacing,
  stripLeadingSecurityToken,
  isBareMilLabel,
  inferPrestigeCode,
  normalizeSecurityMakerPrefix,
  startsWithMakerPrefix,
  normalizeLeadingMakerPrefix,
  inferSecurityMakerPrefixFromFilmName,
  inferSecurityMakerPrefixFromManufacturer,
  getDefaultMakerPrefixForSecurityFamily,
  detectSecurityFilmFamily,
  buildCanonicalSecurityFilmName,
  normalizeSecurityManufacturerAndFilm,
  inferNightVisionCode,
  normalize3MSolarNightVisionManufacturerAndFilm,
  normalizeCanonicalManufacturerAndFilm,
  normalizeCatalogWriteManufacturerAndFilm,
  normalizeFilmKeyInput,
  normalizeCatalogWriteFilmKeyInput,
  isFilmNameAliasLookupUnavailableError,
  resolveCanonicalFilmNameAlias,
  resolveCanonicalFilmEntry,
  resolveCatalogWriteFilmEntry,
  dedupeNormalizedJobRequirements,
  canonicalizeJobRequirementEntriesWithAliases,
  normalizeJobRequirementEntriesForWrite,
  normalizeJobRequirementInput,
};

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(backendDir, '..');
const envPath = path.join(backendDir, '.env');

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      options[key] = true;
      continue;
    }
    options[key] = next;
    i += 1;
  }
  return options;
}

function parseEnv(filePath) {
  const out = {};
  const content = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    out[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return out;
}

function normalizeCollapsed(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function normalizeLookup(value) {
  return normalizeCollapsed(value).toLowerCase();
}

function canonicalizeManufacturer(rawManufacturer) {
  const normalized = normalizeLookup(rawManufacturer);
  if (!normalized) return '';
  if (normalized === '3m' || normalized === '3m solar') return '3M Solar';
  if (normalized === '3m fasara' || normalized === 'fasara') return '3M Fasara';
  if (normalized === 'avery' || normalized === 'avery dennison') return 'Avery Dennison';
  if (normalized === 'di-noc' || normalized === 'dinoc') return 'Di-Noc';
  if (normalized === 'llumar' || normalized === 'llumar vista') return 'Llumar';
  if (normalized === 'madico') return 'Madico';
  if (normalized === 'security') return 'Security';
  if (normalized === 'solar gard' || normalized === 'solar guard' || normalized === 'solargard' || normalized === 'sg') return 'Solar Gard';
  if (normalized === 'solyx' || normalized === 'sol') return 'SOLYX';
  if (normalized === 'vinyl') return 'Vinyl';
  if (normalized === 'aswfvkool' || normalized === 'v-kool' || normalized === 'vkool') return 'ASWFVKOOL';
  return normalizeCollapsed(rawManufacturer);
}

function manufacturerPrefixPatterns(manufacturer) {
  if (manufacturer === '3M Solar') {
    return [/^3m\s+/i];
  }
  if (manufacturer === '3M Fasara') {
    return [/^3m\s+fasara\s+/i, /^fasara\s+/i, /^3m\s+/i];
  }
  if (manufacturer === 'Solar Gard') {
    return [/^solar\s*guard\s+/i, /^solar\s+gard\s+/i, /^solarguard\s+/i, /^sg\s+/i];
  }
  if (manufacturer === 'Llumar') {
    return [/^llumar\s+vista\s+/i, /^llumarvista\s+/i, /^llumar\s+/i];
  }
  if (manufacturer === 'Avery Dennison') {
    return [/^avery\s+dennison\s+/i, /^avery\s+/i, /^ad\s+/i];
  }
  if (manufacturer === 'SOLYX') {
    return [/^solyx\s+/i, /^sol\s+/i];
  }
  if (manufacturer === 'Security') {
    return [/^security\s+/i];
  }
  return [];
}

function stripManufacturerPrefixes(manufacturer, rawFilmName) {
  let filmName = normalizeCollapsed(rawFilmName);
  let changed = true;
  const patterns = manufacturerPrefixPatterns(manufacturer);

  while (changed) {
    changed = false;
    for (const pattern of patterns) {
      const next = normalizeCollapsed(filmName.replace(pattern, ''));
      if (next && next !== filmName) {
        filmName = next;
        changed = true;
      }
    }
  }

  return filmName;
}

function cleanVariantText(rawText) {
  return normalizeCollapsed(
    String(rawText ?? '')
      .replace(/["'`]/g, ' ')
      .replace(/[\u2013\u2014]/g, '-')
      .replace(/\bexterior\b/gi, 'ext')
      .replace(/\((.*?)\)/g, ' ')
      .replace(/\[(.*?)\]/g, ' ')
      .replace(/\s*[-|/]\s*/g, ' ')
  );
}

function toFingerprint(rawText) {
  return cleanVariantText(rawText)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function addVariant(set, rawText) {
  const fingerprint = toFingerprint(rawText);
  if (fingerprint) {
    set.add(fingerprint);
  }
}

function buildFingerprints(manufacturer, rawFilmName) {
  const fingerprints = new Set();
  const base = normalizeCollapsed(rawFilmName);
  if (!base) return fingerprints;

  addVariant(fingerprints, base);

  const withoutPrefix = stripManufacturerPrefixes(manufacturer, base);
  if (withoutPrefix && withoutPrefix !== base) {
    addVariant(fingerprints, withoutPrefix);
  }

  const withoutLeadingDigits = normalizeCollapsed(base.replace(/^\d+\s+/, ''));
  if (withoutLeadingDigits && withoutLeadingDigits !== base) {
    addVariant(fingerprints, withoutLeadingDigits);
    addVariant(fingerprints, stripManufacturerPrefixes(manufacturer, withoutLeadingDigits));
  }

  const splitAtMetadata = normalizeCollapsed(base.split('  ')[0]);
  if (splitAtMetadata && splitAtMetadata !== base) {
    addVariant(fingerprints, splitAtMetadata);
  }

  return fingerprints;
}

function tokenFromMatch(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function extractModelTokens(rawFilmName) {
  const text = normalizeCollapsed(rawFilmName).toUpperCase();
  const tokens = new Set();

  const add = (value) => {
    const token = tokenFromMatch(value);
    if (!token) return;
    if (token.length < 4) return;
    if (!/\d/.test(token)) return;
    tokens.add(token);
  };

  for (const match of text.matchAll(/\b(?:SH|SX|SXC|SXR|SXP|SXJ|SXWF|SXD|SXF|SXSC|SXL|SXMD|SXWV|SXO|SXSG|SXGF)[A-Z0-9-]*\b/g)) {
    add(match[0]);
  }
  for (const match of text.matchAll(/\bPR\s*-?\s*(\d{1,3})(\s*EXT)?\b/g)) {
    add(`PR${match[1]}${match[2] ? 'EXT' : ''}`);
  }
  for (const match of text.matchAll(/\bNV\s*-?\s*(\d{1,3})\b/g)) {
    add(`NV${match[1]}`);
  }
  for (const match of text.matchAll(/\bAG\s*-?\s*(\d{1,3})\b/g)) {
    add(`AG${match[1]}`);
  }
  for (const match of text.matchAll(/\bV\s*-?\s*(\d{2,3})\b/g)) {
    add(`V${match[1]}`);
  }
  for (const match of text.matchAll(/\bNRM[VW]?\s*PS?\s*\d+\b/g)) {
    add(match[0]);
  }
  for (const match of text.matchAll(/\bN\d{3,4}[A-Z]?\b/g)) {
    add(match[0]);
  }
  for (const match of text.matchAll(/\bDX\s*-?\s*\d{1,3}\b/g)) {
    add(match[0]);
  }

  return tokens;
}

function csvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function writeCsv(filePath, rows, headers) {
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((header) => csvCell(row[header])).join(','));
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = normalizeLookup(value);
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

async function loadCatalog(client, orgId) {
  const { rows } = await client.query(
    `
      select id, manufacturer, film_name, film_key
      from app.film_catalog
      where org_id = $1
    `,
    [orgId],
  );

  return rows.map((row) => {
    const canonicalManufacturer = canonicalizeManufacturer(row.manufacturer);
    return {
      ...row,
      canonical_manufacturer: canonicalManufacturer,
      fingerprints: buildFingerprints(canonicalManufacturer, row.film_name),
      model_tokens: extractModelTokens(row.film_name),
    };
  });
}

async function loadUnmatchedCombos(client, orgId) {
  const { rows } = await client.query(
    `
      with catalog as (
        select
          lower(trim(regexp_replace(manufacturer, '\\s+', ' ', 'g'))) as manufacturer_key,
          lower(trim(regexp_replace(film_name, '\\s+', ' ', 'g'))) as film_key
        from app.film_catalog
        where org_id = $1
      ),
      combos as (
        select
          manufacturer,
          film_name,
          count(*)::int as box_count,
          lower(trim(regexp_replace(manufacturer, '\\s+', ' ', 'g'))) as manufacturer_key,
          lower(trim(regexp_replace(film_name, '\\s+', ' ', 'g'))) as film_key
        from app.boxes
        where org_id = $1
        group by manufacturer, film_name
      )
      select
        c.manufacturer,
        c.film_name,
        c.box_count
      from combos c
      left join catalog k
        on k.manufacturer_key = c.manufacturer_key
       and k.film_key = c.film_key
      where k.manufacturer_key is null
      order by c.box_count desc, c.manufacturer, c.film_name
    `,
    [orgId],
  );
  return rows;
}

function chooseCandidate(unmatchedRow, catalogByManufacturer) {
  const canonicalManufacturer = canonicalizeManufacturer(unmatchedRow.manufacturer);
  const catalogEntries = catalogByManufacturer.get(canonicalManufacturer) || [];
  if (!catalogEntries.length) {
    return null;
  }

  const sourceFingerprints = buildFingerprints(canonicalManufacturer, unmatchedRow.film_name);
  const fingerprintMatches = [];
  for (const entry of catalogEntries) {
    let found = false;
    for (const fingerprint of sourceFingerprints) {
      if (entry.fingerprints.has(fingerprint)) {
        found = true;
        break;
      }
    }
    if (found) {
      fingerprintMatches.push(entry);
    }
  }

  if (fingerprintMatches.length === 1) {
    return {
      reason: 'fingerprint_unique_match',
      target: fingerprintMatches[0],
    };
  }

  if (fingerprintMatches.length > 1) {
    return null;
  }

  const sourceTokens = extractModelTokens(unmatchedRow.film_name);
  if (!sourceTokens.size) {
    return null;
  }

  const tokenMatches = [];
  for (const entry of catalogEntries) {
    let shared = false;
    for (const token of sourceTokens) {
      if (entry.model_tokens.has(token)) {
        shared = true;
        break;
      }
    }
    if (shared) {
      tokenMatches.push(entry);
    }
  }

  if (tokenMatches.length === 1) {
    return {
      reason: 'model_token_unique_match',
      target: tokenMatches[0],
    };
  }

  return null;
}

async function applyMappings(client, orgId, mappings) {
  const results = [];
  let totalUpdated = 0;

  for (const mapping of mappings) {
    const updateResult = await client.query(
      `
        update app.boxes
        set
          manufacturer = $1,
          film_name = $2,
          film_key = $3,
          updated_at = now()
        where org_id = $4
          and manufacturer = $5
          and film_name = $6
      `,
      [
        mapping.target_manufacturer,
        mapping.target_film_name,
        mapping.target_film_key,
        orgId,
        mapping.source_manufacturer,
        mapping.source_film_name,
      ],
    );

    const affectedRows = Number(updateResult.rowCount || 0);
    totalUpdated += affectedRows;
    results.push({ ...mapping, affected_rows: affectedRows });
  }

  return {
    total_updated_rows: totalUpdated,
    mapping_results: results,
  };
}

async function loadCoverage(client, orgId) {
  const { rows } = await client.query(
    `
      with catalog as (
        select
          lower(trim(regexp_replace(manufacturer, '\\s+', ' ', 'g'))) as manufacturer_key,
          lower(trim(regexp_replace(film_name, '\\s+', ' ', 'g'))) as film_key
        from app.film_catalog
        where org_id = $1
      ),
      boxes_norm as (
        select
          warehouse,
          lower(trim(regexp_replace(manufacturer, '\\s+', ' ', 'g'))) as manufacturer_key,
          lower(trim(regexp_replace(film_name, '\\s+', ' ', 'g'))) as film_key
        from app.boxes
        where org_id = $1
      )
      select
        warehouse,
        count(*)::int as total_boxes,
        count(*) filter (where c.manufacturer_key is not null)::int as matched_boxes,
        count(*) filter (where c.manufacturer_key is null)::int as unmatched_boxes
      from boxes_norm b
      left join catalog c
        on c.manufacturer_key = b.manufacturer_key
       and c.film_key = b.film_key
      group by warehouse
      order by warehouse
    `,
    [orgId],
  );

  const aggregate = rows.reduce(
    (accumulator, row) => {
      accumulator.total_boxes += Number(row.total_boxes || 0);
      accumulator.matched_boxes += Number(row.matched_boxes || 0);
      accumulator.unmatched_boxes += Number(row.unmatched_boxes || 0);
      return accumulator;
    },
    { total_boxes: 0, matched_boxes: 0, unmatched_boxes: 0 },
  );

  const unmatchedDistinctResult = await client.query(
    `
      with catalog as (
        select
          lower(trim(regexp_replace(manufacturer, '\\s+', ' ', 'g'))) as manufacturer_key,
          lower(trim(regexp_replace(film_name, '\\s+', ' ', 'g'))) as film_key
        from app.film_catalog
        where org_id = $1
      ),
      combos as (
        select
          manufacturer,
          film_name,
          lower(trim(regexp_replace(manufacturer, '\\s+', ' ', 'g'))) as manufacturer_key,
          lower(trim(regexp_replace(film_name, '\\s+', ' ', 'g'))) as film_key
        from app.boxes
        where org_id = $1
        group by manufacturer, film_name
      )
      select count(*)::int as unmatched_distinct_combos
      from combos b
      left join catalog c
        on c.manufacturer_key = b.manufacturer_key
       and c.film_key = b.film_key
      where c.manufacturer_key is null
    `,
    [orgId],
  );

  return {
    aggregate,
    by_warehouse: rows,
    unmatched_distinct_combos: Number(unmatchedDistinctResult.rows[0]?.unmatched_distinct_combos || 0),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apply = parseBoolean(args.apply, false);
  const limit = args.limit ? Number(args.limit) : Number.POSITIVE_INFINITY;
  const reportPath = args.report
    ? path.resolve(repoRoot, String(args.report))
    : path.join(backendDir, 'docs', 'inventory_catalog_auto_mappings_pass2.csv');

  if (!fs.existsSync(envPath)) {
    throw new Error(`Missing env file at ${envPath}`);
  }
  const env = parseEnv(envPath);
  const databaseUrl = env.DATABASE_URL || env.SUPABASE_DB_URL;
  const orgId = env.DEFAULT_ORG_ID;
  if (!databaseUrl) throw new Error('DATABASE_URL (or SUPABASE_DB_URL) missing in backend/.env');
  if (!orgId) throw new Error('DEFAULT_ORG_ID missing in backend/.env');

  const client = new Client({
    connectionString: databaseUrl,
    ssl: /localhost|127\.0\.0\.1/i.test(databaseUrl) ? undefined : { rejectUnauthorized: false },
  });

  await client.connect();
  try {
    await client.query('begin');

    const coverageBefore = await loadCoverage(client, orgId);

    const catalogRows = await loadCatalog(client, orgId);
    const catalogByManufacturer = new Map();
    for (const row of catalogRows) {
      if (!catalogByManufacturer.has(row.canonical_manufacturer)) {
        catalogByManufacturer.set(row.canonical_manufacturer, []);
      }
      catalogByManufacturer.get(row.canonical_manufacturer).push(row);
    }

    const unmatchedRows = await loadUnmatchedCombos(client, orgId);
    const candidateMappings = [];
    for (const unmatchedRow of unmatchedRows) {
      const selection = chooseCandidate(unmatchedRow, catalogByManufacturer);
      if (!selection) continue;

      candidateMappings.push({
        reason: selection.reason,
        source_manufacturer: unmatchedRow.manufacturer,
        source_film_name: unmatchedRow.film_name,
        source_box_count: Number(unmatchedRow.box_count || 0),
        target_manufacturer: selection.target.manufacturer,
        target_film_name: selection.target.film_name,
        target_film_key: selection.target.film_key,
      });

      if (candidateMappings.length >= limit) {
        break;
      }
    }

    let applyResults = {
      total_updated_rows: 0,
      mapping_results: candidateMappings.map((mapping) => ({ ...mapping, affected_rows: 0 })),
    };

    if (apply && candidateMappings.length > 0) {
      applyResults = await applyMappings(client, orgId, candidateMappings);
    }

    const coverageAfter = apply ? await loadCoverage(client, orgId) : coverageBefore;

    if (apply) {
      await client.query('commit');
    } else {
      await client.query('rollback');
    }

    writeCsv(
      reportPath,
      applyResults.mapping_results,
      [
        'reason',
        'source_manufacturer',
        'source_film_name',
        'source_box_count',
        'target_manufacturer',
        'target_film_name',
        'target_film_key',
        'affected_rows',
      ],
    );

    console.log(
      JSON.stringify(
        {
          apply,
          org_id: orgId,
          candidate_mapping_count: candidateMappings.length,
          updated_box_rows: applyResults.total_updated_rows,
          report_path: reportPath.replace(/\\/g, '/'),
          coverage_before: coverageBefore,
          coverage_after: coverageAfter,
        },
        null,
        2,
      ),
    );
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error?.message ?? error);
  process.exitCode = 1;
});

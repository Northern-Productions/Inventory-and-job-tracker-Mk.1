// Purpose: DEV-only read audit for caulk AUTO_PLANNED suppression smoke checks.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from 'pg';

const DEV_PROJECT_REF = 'uxiltcpbhthhinonttrc';
const PROD_PROJECT_REF = 'tiwpulgvxtwlmqdnyuzd';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BACKEND_DIR = path.resolve(__dirname, '..');

function asText(value) {
  return String(value ?? '').trim();
}

function integerOrZero(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.max(0, Math.floor(numeric));
}

function productLabel(entry) {
  return [entry?.manufacturer, entry?.productName, entry?.productCode]
    .map(asText)
    .filter(Boolean)
    .join(' ');
}

function classifySuppression(entry) {
  const currentRequirementFound = Boolean(entry?.requirementId);
  const neededTubes = integerOrZero(entry?.neededTubes);
  const availablePlannerTubes = integerOrZero(entry?.availablePlannerTubes);
  const activeAutoRows = Array.isArray(entry?.activeAutoPlannedRows) ? entry.activeAutoPlannedRows : [];
  const recreatedRows = activeAutoRows.filter((row) => row.createdAfterSuppression === true);
  const plannerWouldRecreateWithoutSuppression =
    currentRequirementFound && neededTubes > 0 && (availablePlannerTubes > 0 || activeAutoRows.length > 0);

  let state = 'not_needed';
  if (!currentRequirementFound) {
    state = 'stale_suppression';
  } else if (recreatedRows.length > 0) {
    state = 'leaked_active_row_after_suppression';
  } else if (plannerWouldRecreateWithoutSuppression) {
    state = 'blocked_by_suppression';
  }

  return {
    state,
    plannerWouldRecreateWithoutSuppression,
    projectedBlockedAutoPlannedRows:
      state === 'blocked_by_suppression'
        ? [
            {
              allocatedTubes: Math.min(neededTubes, availablePlannerTubes),
            },
          ].filter((row) => row.allocatedTubes > 0)
        : [],
    recreatedRows,
  };
}

function summarizeReports(reports) {
  const summary = {
    activeSuppressions: reports.length,
    blockedSuppressions: 0,
    staleSuppressions: 0,
    leakedSuppressions: 0,
    plannerWouldRecreateWithoutSuppression: 0,
    projectedBlockedRows: 0,
    projectedBlockedTubes: 0,
  };

  for (const report of reports) {
    if (report.state === 'blocked_by_suppression') {
      summary.blockedSuppressions += 1;
    }
    if (report.state === 'stale_suppression') {
      summary.staleSuppressions += 1;
    }
    if (report.state === 'leaked_active_row_after_suppression') {
      summary.leakedSuppressions += 1;
    }
    if (report.plannerWouldRecreateWithoutSuppression) {
      summary.plannerWouldRecreateWithoutSuppression += 1;
    }
    summary.projectedBlockedRows += report.projectedBlockedAutoPlannedRows.length;
    for (const row of report.projectedBlockedAutoPlannedRows) {
      summary.projectedBlockedTubes += integerOrZero(row.allocatedTubes);
    }
  }

  return summary;
}

function parseArgs(argv) {
  const args = {
    json: false,
    orgId: '',
    jobNumber: '',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      args.json = true;
    } else if (arg === '--org-id') {
      args.orgId = asText(argv[index + 1]);
      index += 1;
    } else if (arg.startsWith('--org-id=')) {
      args.orgId = asText(arg.slice('--org-id='.length));
    } else if (arg === '--job-number') {
      args.jobNumber = asText(argv[index + 1]);
      index += 1;
    } else if (arg.startsWith('--job-number=')) {
      args.jobNumber = asText(arg.slice('--job-number='.length));
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function parseEnvValue(rawValue, filePath, lineNumber) {
  let value = rawValue.trim();
  if (!value) {
    return '';
  }

  const quote = value[0];
  if (quote === '"' || quote === "'") {
    if (value.length === 1 || value[value.length - 1] !== quote) {
      throw new Error(`${filePath}:${lineNumber} has a quoted env value that appears to span multiple lines.`);
    }
    value = value.slice(1, -1);
  }

  return value;
}

function readEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const values = {};
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith('#')) {
      continue;
    }

    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) {
      continue;
    }

    values[match[1]] = parseEnvValue(match[2], filePath, index + 1);
  }

  return values;
}

function loadBackendEnv() {
  const values = {};
  for (const envPath of [path.join(BACKEND_DIR, '.env'), path.join(BACKEND_DIR, '.env.dev')]) {
    Object.assign(values, readEnvFile(envPath));
  }
  Object.assign(values, process.env);
  return values;
}

function parseUrl(value, fieldName) {
  const text = asText(value);
  if (!text) {
    return null;
  }

  try {
    return new URL(text);
  } catch {
    throw new Error(`${fieldName} is not a valid URL.`);
  }
}

function extractProjectRefFromUrl(value) {
  const url = parseUrl(value, 'Supabase URL');
  if (!url) {
    return '';
  }

  const directMatch = url.hostname.match(/^([a-z0-9]{20})\.supabase\.co$/i);
  if (directMatch) {
    return directMatch[1];
  }

  const dbMatch = url.hostname.match(/^db\.([a-z0-9]{20})\.supabase\.co$/i);
  if (dbMatch) {
    return dbMatch[1];
  }

  return url.hostname.includes(PROD_PROJECT_REF) ? PROD_PROJECT_REF : '';
}

function validateDevDatabaseSelection(envValues) {
  const databaseUrlKey = asText(envValues.DEV_DATABASE_URL) ? 'DEV_DATABASE_URL' : 'DATABASE_URL';
  const databaseUrl = asText(envValues[databaseUrlKey] || envValues.SUPABASE_DB_URL);
  if (!databaseUrl) {
    throw new Error('DEV_DATABASE_URL or DATABASE_URL is required for the DEV caulk suppression audit.');
  }

  const parsedDatabaseUrl = parseUrl(databaseUrl, databaseUrlKey);
  if (!/^postgres(?:ql)?:$/i.test(parsedDatabaseUrl.protocol)) {
    throw new Error(`${databaseUrlKey} must use the postgres:// or postgresql:// protocol.`);
  }

  if (!parsedDatabaseUrl.hostname) {
    throw new Error(`${databaseUrlKey} is missing a database host.`);
  }

  if (!parsedDatabaseUrl.port) {
    throw new Error(`${databaseUrlKey} is missing an explicit database port.`);
  }

  if (!parsedDatabaseUrl.searchParams.has('sslmode')) {
    throw new Error(`${databaseUrlKey} must include sslmode for this DEV audit.`);
  }

  const projectUrlKey = asText(envValues.DEV_SUPABASE_URL) ? 'DEV_SUPABASE_URL' : 'SUPABASE_URL';
  const projectRef = extractProjectRefFromUrl(envValues[projectUrlKey]);
  const dbRef = extractProjectRefFromUrl(databaseUrl);
  const hostIncludesProdRef = parsedDatabaseUrl.hostname.includes(PROD_PROJECT_REF);
  const hostIncludesDevRef = parsedDatabaseUrl.hostname.includes(DEV_PROJECT_REF);

  if (hostIncludesProdRef || dbRef === PROD_PROJECT_REF || projectRef === PROD_PROJECT_REF) {
    throw new Error('Refusing to run: selected environment resolves to the PROD Supabase project.');
  }

  if (dbRef && dbRef !== DEV_PROJECT_REF) {
    throw new Error(`Refusing to run: ${databaseUrlKey} is not the DEV Supabase project.`);
  }

  if (projectRef && projectRef !== DEV_PROJECT_REF && !hostIncludesDevRef && dbRef !== DEV_PROJECT_REF) {
    throw new Error(`Refusing to run: ${projectUrlKey} is not the DEV Supabase project.`);
  }

  if (!hostIncludesDevRef && dbRef !== DEV_PROJECT_REF && projectRef !== DEV_PROJECT_REF) {
    throw new Error('Refusing to run: unable to prove selected database is the DEV Supabase project.');
  }

  return {
    databaseUrl,
    databaseUrlKey,
    databaseHost: parsedDatabaseUrl.hostname,
    databasePort: parsedDatabaseUrl.port,
    projectRef: projectRef || dbRef || DEV_PROJECT_REF,
  };
}

async function runAudit(client, options = {}) {
  const params = [];
  let nextParam = 1;
  const filters = [];
  if (options.orgId) {
    filters.push(`s.org_id = $${nextParam}::uuid`);
    params.push(options.orgId);
    nextParam += 1;
  }
  if (options.jobNumber) {
    filters.push(`upper(trim(s.job_number)) = upper(trim($${nextParam}))`);
    params.push(options.jobNumber);
    nextParam += 1;
  }
  const filterSql = filters.length ? `and ${filters.join('\n        and ')}` : '';

  const result = await client.query(
    `
      with active_suppressions as (
        select
          s.id,
          s.org_id,
          s.job_id,
          s.job_number,
          s.requirement_id as stored_requirement_id,
          s.requirement_signature,
          s.source_allocation_id,
          s.source_inventory_id,
          s.reason,
          s.suppressed_at,
          s.suppressed_by
        from app.allocation_planner_suppressions s
        where s.material_type = 'CAULK'
          and s.cleared_at is null
          ${filterSql}
      )
      select
        s.id::text as suppression_id,
        s.org_id::text as org_id,
        s.job_number,
        s.requirement_signature,
        s.source_allocation_id,
        s.source_inventory_id,
        s.reason,
        s.suppressed_at,
        s.suppressed_by,
        r.id::text as requirement_id,
        r.product_id::text as product_id,
        j.warehouse,
        m.name as manufacturer,
        p.name as product_name,
        p.code as product_code,
        coalesce(r.required_tubes, 0)::integer as required_tubes,
        coalesce(strict_coverage.allocated_tubes, 0)::integer as strict_coverage_tubes,
        greatest(coalesce(r.required_tubes, 0) - coalesce(strict_coverage.allocated_tubes, 0), 0)::integer as needed_tubes,
        coalesce(stock.tubes_on_hand, 0)::integer as tubes_on_hand,
        coalesce(auto_totals.allocated_tubes, 0)::integer as active_auto_planned_tubes_for_product_warehouse,
        greatest(coalesce(stock.tubes_on_hand, 0) - coalesce(auto_totals.allocated_tubes, 0), 0)::integer as available_planner_tubes,
        coalesce(active_rows.rows, '[]'::jsonb) as active_auto_planned_rows
      from active_suppressions s
      join app.jobs j
        on j.org_id = s.org_id
       and j.id = s.job_id
      left join app.job_caulk_requirements r
        on r.org_id = s.org_id
       and r.job_id = s.job_id
       and app_api.caulk_requirement_planner_signature(
         r.product_id,
         j.warehouse,
         r.required_tubes
       ) = s.requirement_signature
      left join app.caulk_products p
        on p.org_id = s.org_id
       and p.id = r.product_id
      left join app.caulk_manufacturers m
        on m.org_id = p.org_id
       and m.id = p.manufacturer_id
      left join lateral (
        select coalesce(sum(a.allocated_tubes), 0)::integer as allocated_tubes
        from app.caulk_job_allocations a
        where a.org_id = s.org_id
          and a.status = 'ACTIVE'
          and a.job_id = s.job_id
          and a.requirement_id = r.id
          and a.product_id = r.product_id
          and (
            coalesce(a.allocation_source::text, 'MANUAL') <> 'AUTO_PLANNED'
            or greatest(a.checked_out_tubes_total - a.returned_unused_tubes_total - a.used_tubes_total, 0) > 0
          )
      ) strict_coverage on true
      left join app.caulk_stock stock
        on stock.org_id = s.org_id
       and stock.product_id = r.product_id
       and upper(stock.warehouse) = upper(j.warehouse)
      left join lateral (
        select coalesce(sum(a.allocated_tubes), 0)::integer as allocated_tubes
        from app.caulk_job_allocations a
        where a.org_id = s.org_id
          and a.status = 'ACTIVE'
          and coalesce(a.allocation_source::text, 'MANUAL') = 'AUTO_PLANNED'
          and a.product_id = r.product_id
          and upper(a.warehouse) = upper(j.warehouse)
      ) auto_totals on true
      left join lateral (
        select coalesce(
          jsonb_agg(
            jsonb_build_object(
              'caulkAllocationId', a.caulk_allocation_id,
              'allocatedTubes', a.allocated_tubes,
              'reservedTubesRemaining', a.reserved_tubes_remaining,
              'createdAt', a.created_at,
              'createdAfterSuppression', a.created_at >= s.suppressed_at
            )
            order by a.created_at, a.caulk_allocation_id
          ),
          '[]'::jsonb
        ) as rows
        from app.caulk_job_allocations a
        where a.org_id = s.org_id
          and a.status = 'ACTIVE'
          and coalesce(a.allocation_source::text, 'MANUAL') = 'AUTO_PLANNED'
          and a.job_id = s.job_id
          and a.requirement_id = r.id
          and a.product_id = r.product_id
          and upper(a.warehouse) = upper(j.warehouse)
      ) active_rows on true
      order by s.job_number, m.name nulls last, p.name nulls last, s.suppressed_at
    `,
    params
  );

  return result.rows.map((row) => {
    const activeAutoPlannedRows = Array.isArray(row.active_auto_planned_rows)
      ? row.active_auto_planned_rows
      : [];
    const base = {
      suppressionId: asText(row.suppression_id),
      orgId: asText(row.org_id),
      jobNumber: asText(row.job_number),
      product: productLabel({
        manufacturer: row.manufacturer,
        productName: row.product_name,
        productCode: row.product_code,
      }),
      productId: asText(row.product_id),
      warehouse: asText(row.warehouse),
      requirementId: asText(row.requirement_id),
      suppressionSignature: asText(row.requirement_signature),
      sourceAllocationId: asText(row.source_allocation_id),
      sourceInventoryId: asText(row.source_inventory_id),
      reason: asText(row.reason),
      suppressedAt: row.suppressed_at ? new Date(row.suppressed_at).toISOString() : '',
      suppressedBy: asText(row.suppressed_by),
      requiredTubes: integerOrZero(row.required_tubes),
      strictCoverageTubes: integerOrZero(row.strict_coverage_tubes),
      neededTubes: integerOrZero(row.needed_tubes),
      tubesOnHand: integerOrZero(row.tubes_on_hand),
      activeAutoPlannedTubesForProductWarehouse: integerOrZero(row.active_auto_planned_tubes_for_product_warehouse),
      availablePlannerTubes: integerOrZero(row.available_planner_tubes),
      activeAutoPlannedRows,
    };
    return {
      ...base,
      ...classifySuppression(base),
    };
  });
}

function printTextReport(reports, envSelection) {
  const summary = summarizeReports(reports);
  console.log('DEV caulk suppression audit');
  console.log(`Project ref: ${envSelection.projectRef}`);
  console.log(`Database host: ${envSelection.databaseHost}:${envSelection.databasePort}`);
  console.log(`Database URL key: ${envSelection.databaseUrlKey}`);
  console.log('');
  console.log(
    `Summary: ${summary.activeSuppressions} active suppression(s), ${summary.blockedSuppressions} blocked, ` +
      `${summary.leakedSuppressions} leaked active row(s), ${summary.staleSuppressions} stale, ` +
      `${summary.projectedBlockedRows} projected row(s) / ${summary.projectedBlockedTubes} tube(s) blocked.`
  );

  if (!reports.length) {
    console.log('');
    console.log('No active caulk planner suppressions found in DEV.');
    return;
  }

  for (const report of reports) {
    console.log('');
    console.log(`Job ${report.jobNumber}: ${report.product || 'unknown product'} @ ${report.warehouse || 'no warehouse'}`);
    console.log(`  State: ${report.state}`);
    console.log(`  Signature: ${report.suppressionSignature}`);
    console.log(`  Requirement: ${report.requirementId || 'not matched'}`);
    console.log(`  Planner would recreate without suppression: ${report.plannerWouldRecreateWithoutSuppression ? 'yes' : 'no'}`);
    console.log(
      `  Needed/available: ${report.neededTubes} needed, ${report.availablePlannerTubes} available planner tube(s)`
    );
    console.log(
      `  Active AUTO_PLANNED rows after suppression: ${report.activeAutoPlannedRows.length}`
    );
    for (const row of report.activeAutoPlannedRows) {
      console.log(
        `    ${row.caulkAllocationId}: allocated ${integerOrZero(row.allocatedTubes)}, ` +
          `reserved ${integerOrZero(row.reservedTubesRemaining)}, createdAfterSuppression=${row.createdAfterSuppression === true}`
      );
    }
    for (const row of report.projectedBlockedAutoPlannedRows) {
      console.log(`  Projected blocked AUTO_PLANNED row: ${integerOrZero(row.allocatedTubes)} tube(s)`);
    }
  }
}

function redactEnvSelection(envSelection) {
  const { databaseUrl, ...safeSelection } = envSelection || {};
  void databaseUrl;
  return safeSelection;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: npm --prefix backend run audit:caulk:suppressions:dev -- [--json] [--org-id <uuid>] [--job-number <job>]');
    return;
  }

  const envSelection = validateDevDatabaseSelection(loadBackendEnv());
  const client = new Client({
    connectionString: envSelection.databaseUrl,
    ssl: /localhost|127\.0\.0\.1/i.test(envSelection.databaseUrl)
      ? undefined
      : { rejectUnauthorized: false },
  });

  await client.connect();
  try {
    await client.query('begin read only');
    await client.query(`set local statement_timeout = '60s'`);
    const reports = await runAudit(client, args);
    await client.query('rollback');

    if (args.json) {
      console.log(JSON.stringify({ env: redactEnvSelection(envSelection), summary: summarizeReports(reports), reports }, null, 2));
    } else {
      printTextReport(reports, envSelection);
    }
  } catch (error) {
    try {
      await client.query('rollback');
    } catch {
      // Ignore rollback errors; the original audit failure is more useful.
    }
    throw error;
  } finally {
    await client.end();
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error?.message || error);
    process.exitCode = 1;
  });
}

export {
  classifySuppression,
  extractProjectRefFromUrl,
  summarizeReports,
  validateDevDatabaseSelection,
};

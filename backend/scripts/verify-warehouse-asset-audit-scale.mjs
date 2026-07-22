#!/usr/bin/env node

import {
  buildTargetEnvReport,
  loadEnvFile,
} from './lib/target-env-guards.mjs';

const OPERATIONAL_STATUSES = ['IN_STOCK', 'CHECKED_OUT', 'TRANSFER'];
const UNASSIGNED_OWNER_FILTER = 'UNASSIGNED';

function asText(value) {
  return String(value ?? '').trim();
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const [rawKey, inlineValue] = token.slice(2).split('=', 2);
    if (inlineValue !== undefined) {
      options[rawKey] = inlineValue;
    } else if (argv[index + 1] && !argv[index + 1].startsWith('--')) {
      options[rawKey] = argv[index + 1];
      index += 1;
    } else {
      options[rawKey] = true;
    }
  }
  return options;
}

function installEnv(values) {
  for (const [key, value] of Object.entries(values)) {
    process.env[key] = value;
  }
}

function elapsedMs(startedAt) {
  return Math.round((performance.now() - startedAt) * 10) / 10;
}

async function timedReport(buildReport, client, orgId, filters) {
  const startedAt = performance.now();
  const report = await buildReport(
    client,
    orgId,
    filters,
    {
      generatedAt: new Date().toISOString(),
      generatedBy: 'Read-only scale verifier',
    },
  );
  return { report, durationMs: elapsedMs(startedAt) };
}

function assertExactCount(label, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${label} did not return every matching row.`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const expect = asText(options.expect || 'dev').toLowerCase();
  const envPath = asText(options.env || (expect === 'prod' ? '../.secrets/prod.env' : '.env.dev'));
  const allowProd = options['allow-prod'] === true || asText(options['allow-prod']).toLowerCase() === 'true';
  const loaded = loadEnvFile(envPath);
  const target = buildTargetEnvReport({
    envPath: loaded.path,
    envValues: loaded.values,
    expect,
    allowProd,
  });
  if (!target.ok) {
    throw new Error('The database target guard did not pass.');
  }
  installEnv(loaded.values);

  const [{ pool }, { buildWarehouseAssetAuditFromDatabase }] = await Promise.all([
    import('../src/config/runtime.mjs'),
    import('../src/app/services/runtime/runtimeWarehouseAssetAudit.mjs'),
  ]);
  if (!pool) {
    throw new Error('The guarded database connection is not configured.');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query(`SET LOCAL statement_timeout = '60s'`);

    const largestResult = await client.query(
      `
        select org_id::text as org_id, count(*)::integer as matching_boxes
        from app.boxes
        where status::text = any($1::text[])
        group by org_id
        order by count(*) desc, org_id
        limit 1
      `,
      [OPERATIONAL_STATUSES],
    );
    const largest = largestResult.rows[0];
    if (!largest?.org_id) {
      throw new Error('No organization with operational boxes was available for scale verification.');
    }

    const warehouseResult = await client.query(
      `
        select warehouse::text as warehouse, count(*)::integer as matching_boxes
        from app.boxes
        where org_id = $1::uuid
          and status::text = any($2::text[])
        group by warehouse
        order by count(*) asc, warehouse
      `,
      [largest.org_id, OPERATIONAL_STATUSES],
    );
    if (!warehouseResult.rows.length) {
      throw new Error('No warehouse filter was available for scale verification.');
    }
    const typicalWarehouse = warehouseResult.rows[Math.floor((warehouseResult.rows.length - 1) / 2)];

    const ownerWarehouseResult = await client.query(
      `
        select
          warehouse::text as warehouse,
          owner_company_id::text as owner_company_id,
          count(*)::integer as matching_boxes
        from app.boxes
        where org_id = $1::uuid
          and status::text = any($2::text[])
        group by warehouse, owner_company_id
        order by count(*) desc, warehouse, owner_company_id nulls first
        limit 1
      `,
      [largest.org_id, OPERATIONAL_STATUSES],
    );
    const ownerWarehouse = ownerWarehouseResult.rows[0];
    if (!ownerWarehouse?.warehouse) {
      throw new Error('No owner and warehouse filter pair was available for scale verification.');
    }

    const all = await timedReport(
      buildWarehouseAssetAuditFromDatabase,
      client,
      largest.org_id,
      {},
    );
    const typical = await timedReport(
      buildWarehouseAssetAuditFromDatabase,
      client,
      largest.org_id,
      { warehouse: typicalWarehouse.warehouse },
    );
    const ownerAndWarehouse = await timedReport(
      buildWarehouseAssetAuditFromDatabase,
      client,
      largest.org_id,
      {
        warehouse: ownerWarehouse.warehouse,
        ownerCompanyId: ownerWarehouse.owner_company_id || UNASSIGNED_OWNER_FILTER,
      },
    );

    assertExactCount('Largest organization report', all.report.rows.length, Number(largest.matching_boxes));
    assertExactCount('Typical warehouse report', typical.report.rows.length, Number(typicalWarehouse.matching_boxes));
    assertExactCount(
      'Owner and warehouse report',
      ownerAndWarehouse.report.rows.length,
      Number(ownerWarehouse.matching_boxes),
    );

    const serializedBytes = Buffer.byteLength(JSON.stringify(all.report), 'utf8');
    const pageCountAtFiftyRows = Math.ceil(all.report.rows.length / 50);
    console.log(JSON.stringify({
      ok: true,
      target: expect,
      transaction: 'REPEATABLE_READ_READ_ONLY',
      largestOrganization: {
        matchingBoxes: all.report.rows.length,
        durationMs: all.durationMs,
        returnedAllRows: true,
      },
      typicalWarehouseFilter: {
        matchingBoxes: typical.report.rows.length,
        durationMs: typical.durationMs,
        returnedAllRows: true,
      },
      ownerAndWarehouseFilter: {
        matchingBoxes: ownerAndWarehouse.report.rows.length,
        durationMs: ownerAndWarehouse.durationMs,
        returnedAllRows: true,
      },
      multiPagePayload: {
        rows: all.report.rows.length,
        pagesAtFiftyRows: pageCountAtFiftyRows,
        serializedBytes,
        requiresMultiplePages: pageCountAtFiftyRows > 1,
      },
    }, null, 2));
  } finally {
    try {
      await client.query('ROLLBACK');
    } finally {
      client.release();
      await pool.end();
    }
  }
}

main().catch(() => {
  console.error('Warehouse asset audit scale verification failed without emitting business row data.');
  process.exitCode = 1;
});

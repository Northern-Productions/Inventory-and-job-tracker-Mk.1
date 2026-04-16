import '../load-env.mjs';
import { Client } from 'pg';
import { fileURLToPath } from 'node:url';

function asTrimmedString(value) {
  return String(value || '').trim();
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function requireDatabaseUrl() {
  const databaseUrl = asTrimmedString(process.env.DATABASE_URL || process.env.SUPABASE_DB_URL);
  assert(databaseUrl, 'DATABASE_URL or SUPABASE_DB_URL is required.');
  return databaseUrl;
}

function requireOrgId() {
  const orgId = asTrimmedString(process.env.DEFAULT_ORG_ID || process.env.VERIFY_DB_PARITY_ORG_ID);
  assert(orgId, 'DEFAULT_ORG_ID or VERIFY_DB_PARITY_ORG_ID is required.');
  return orgId;
}

function assertSmokeTag(tag) {
  const normalizedTag = asTrimmedString(tag);
  assert(normalizedTag, 'A smoke tag is required.');
  assert(
    /^SMOKE_CAULK_[A-Z0-9_:-]+$/i.test(normalizedTag),
    `Refusing cleanup for an unexpected tag: ${normalizedTag || '<empty>'}`
  );
  return normalizedTag;
}

async function connectClient() {
  const connectionString = requireDatabaseUrl();
  const client = new Client({
    connectionString,
    ssl: /localhost|127\.0\.0\.1/i.test(connectionString)
      ? undefined
      : { rejectUnauthorized: false }
  });
  await client.connect();
  return client;
}

async function tableExists(client, qualifiedTableName) {
  const result = await client.query('select to_regclass($1) is not null as exists', [qualifiedTableName]);
  return Boolean(result.rows[0]?.exists);
}

async function collectArtifactIds(client, orgId, tag) {
  const productsResult = await client.query(
    `
      select
        p.id::text as product_id,
        p.name as product_name,
        p.code as product_code
      from app.caulk_products p
      where p.org_id = $1::uuid
        and p.notes = $2::text
      order by p.updated_at desc, p.id desc
    `,
    [orgId, tag]
  );
  const jobsResult = await client.query(
    `
      select
        j.id::text as job_id,
        j.job_number
      from app.jobs j
      where j.org_id = $1::uuid
        and j.notes = $2::text
      order by j.updated_at desc, j.id desc
    `,
    [orgId, tag]
  );

  return {
    productIds: productsResult.rows
      .map((row) => asTrimmedString(row.product_id))
      .filter(Boolean),
    jobIds: jobsResult.rows
      .map((row) => asTrimmedString(row.job_id))
      .filter(Boolean),
    jobNumbers: jobsResult.rows
      .map((row) => asTrimmedString(row.job_number))
      .filter(Boolean)
  };
}

async function queryAllocationRowIds(client, orgId, productIds, jobIds) {
  if (!productIds.length && !jobIds.length) {
    return [];
  }

  const result = await client.query(
    `
      select a.id::text as allocation_row_id
      from app.caulk_job_allocations a
      where a.org_id = $1::uuid
        and (
          (
            coalesce(array_length($2::uuid[], 1), 0) > 0
            and a.product_id = any($2::uuid[])
          )
          or (
            coalesce(array_length($3::uuid[], 1), 0) > 0
            and a.job_id = any($3::uuid[])
          )
        )
    `,
    [orgId, productIds, jobIds]
  );

  return result.rows
    .map((row) => asTrimmedString(row.allocation_row_id))
    .filter(Boolean);
}

async function deleteByScope(client, sql, params) {
  const result = await client.query(sql, params);
  return Number(result.rowCount || 0);
}

export async function cleanupCaulkSmokeArtifacts({
  client: providedClient,
  orgId: providedOrgId,
  tag,
  logger = console
} = {}) {
  const normalizedTag = assertSmokeTag(tag);
  const orgId = asTrimmedString(providedOrgId) || requireOrgId();
  const client = providedClient || (await connectClient());
  const ownsClient = !providedClient;

  try {
    const { productIds, jobIds, jobNumbers } = await collectArtifactIds(client, orgId, normalizedTag);
    const allocationRowIds = await queryAllocationRowIds(client, orgId, productIds, jobIds);
    const hasBackfillMap = await tableExists(client, 'app.caulk_backfill_map');

    const summary = {
      tag: normalizedTag,
      orgId,
      productIds,
      jobNumbers,
      counts: {
        caulkJobCheckouts: 0,
        caulkTransfers: 0,
        caulkJobAllocations: 0,
        jobCaulkRequirements: 0,
        caulkTransactions: 0,
        caulkStock: 0,
        caulkBackfillMap: 0,
        caulkProducts: 0,
        jobs: 0
      }
    };

    if (!productIds.length && !jobIds.length) {
      logger.log?.(`[caulk-smoke-cleanup] tag=${normalizedTag} no matching artifacts found.`);
      return summary;
    }

    await client.query('begin');
    try {
      summary.counts.caulkJobCheckouts = await deleteByScope(
        client,
        `
          delete from app.caulk_job_checkouts
          where org_id = $1::uuid
            and coalesce(array_length($2::uuid[], 1), 0) > 0
            and caulk_allocation_id = any($2::uuid[])
        `,
        [orgId, allocationRowIds]
      );

      summary.counts.caulkTransfers = await deleteByScope(
        client,
        `
          delete from app.caulk_transfers
          where org_id = $1::uuid
            and (
              (
                coalesce(array_length($2::uuid[], 1), 0) > 0
                and caulk_allocation_id = any($2::uuid[])
              )
              or (
                coalesce(array_length($3::uuid[], 1), 0) > 0
                and product_id = any($3::uuid[])
              )
              or (
                coalesce(array_length($4::uuid[], 1), 0) > 0
                and job_id = any($4::uuid[])
              )
            )
        `,
        [orgId, allocationRowIds, productIds, jobIds]
      );

      summary.counts.caulkJobAllocations = await deleteByScope(
        client,
        `
          delete from app.caulk_job_allocations
          where org_id = $1::uuid
            and (
              (
                coalesce(array_length($2::uuid[], 1), 0) > 0
                and job_id = any($2::uuid[])
              )
              or (
                coalesce(array_length($3::uuid[], 1), 0) > 0
                and product_id = any($3::uuid[])
              )
            )
        `,
        [orgId, jobIds, productIds]
      );

      summary.counts.jobCaulkRequirements = await deleteByScope(
        client,
        `
          delete from app.job_caulk_requirements
          where org_id = $1::uuid
            and (
              (
                coalesce(array_length($2::uuid[], 1), 0) > 0
                and job_id = any($2::uuid[])
              )
              or (
                coalesce(array_length($3::uuid[], 1), 0) > 0
                and product_id = any($3::uuid[])
              )
            )
        `,
        [orgId, jobIds, productIds]
      );

      summary.counts.caulkTransactions = await deleteByScope(
        client,
        `
          delete from app.caulk_transactions
          where org_id = $1::uuid
            and coalesce(array_length($2::uuid[], 1), 0) > 0
            and product_id = any($2::uuid[])
        `,
        [orgId, productIds]
      );

      summary.counts.caulkStock = await deleteByScope(
        client,
        `
          delete from app.caulk_stock
          where org_id = $1::uuid
            and coalesce(array_length($2::uuid[], 1), 0) > 0
            and product_id = any($2::uuid[])
        `,
        [orgId, productIds]
      );

      if (hasBackfillMap) {
        summary.counts.caulkBackfillMap = await deleteByScope(
          client,
          `
            delete from app.caulk_backfill_map
            where org_id = $1::uuid
              and coalesce(array_length($2::uuid[], 1), 0) > 0
              and product_id = any($2::uuid[])
          `,
          [orgId, productIds]
        );
      }

      summary.counts.caulkProducts = await deleteByScope(
        client,
        `
          delete from app.caulk_products
          where org_id = $1::uuid
            and coalesce(array_length($2::uuid[], 1), 0) > 0
            and id = any($2::uuid[])
        `,
        [orgId, productIds]
      );

      summary.counts.jobs = await deleteByScope(
        client,
        `
          delete from app.jobs
          where org_id = $1::uuid
            and coalesce(array_length($2::uuid[], 1), 0) > 0
            and id = any($2::uuid[])
        `,
        [orgId, jobIds]
      );

      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    }

    logger.log?.(
      `[caulk-smoke-cleanup] tag=${normalizedTag} jobs=${summary.counts.jobs} products=${summary.counts.caulkProducts} transfers=${summary.counts.caulkTransfers}`
    );

    return summary;
  } finally {
    if (ownsClient) {
      await providedClient?.end?.();
      if (!providedClient) {
        await client.end();
      }
    }
  }
}

function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv : [];
  let tag = '';

  for (let index = 0; index < args.length; index += 1) {
    const entry = asTrimmedString(args[index]);
    if (entry === '--tag') {
      tag = asTrimmedString(args[index + 1]);
      index += 1;
    }
  }

  return { tag };
}

async function main() {
  const { tag } = parseArgs(process.argv.slice(2));
  const summary = await cleanupCaulkSmokeArtifacts({ tag });
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error('[caulk-smoke-cleanup] failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

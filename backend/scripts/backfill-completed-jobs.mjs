import '../load-env.mjs';
import { Client } from 'pg';
import { normalizeCompletedJobBackfillCandidate } from './lib/completed-job-backfill.mjs';

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      options[key] = true;
      continue;
    }

    options[key] = next;
    index += 1;
  }
  return options;
}

function asTrimmedString(value) {
  return String(value ?? '').trim();
}

async function loadLegacyCompletedCandidates(client, orgId) {
  const { rows } = await client.query(
    `
      with active_allocations as (
        select
          org_id,
          upper(trim(job_number)) as job_number_key,
          count(*)::integer as active_allocation_count
        from app.allocations
        where org_id = $1
          and nullif(trim(job_number), '') is not null
          and status = 'ACTIVE'
        group by org_id, upper(trim(job_number))
      ),
      open_film_orders as (
        select
          org_id,
          upper(trim(job_number)) as job_number_key,
          count(*)::integer as open_film_order_count
        from app.film_orders
        where org_id = $1
          and nullif(trim(job_number), '') is not null
          and status in ('FILM_ORDER', 'FILM_ON_THE_WAY')
        group by org_id, upper(trim(job_number))
      ),
      fulfilled_allocations as (
        select
          org_id,
          upper(trim(job_number)) as job_number_key,
          count(*)::integer as fulfilled_allocation_count
        from app.allocations
        where org_id = $1
          and nullif(trim(job_number), '') is not null
          and status = 'FULFILLED'
        group by org_id, upper(trim(job_number))
      ),
      fulfilled_film_orders as (
        select
          org_id,
          upper(trim(job_number)) as job_number_key,
          count(*)::integer as fulfilled_film_order_count
        from app.film_orders
        where org_id = $1
          and nullif(trim(job_number), '') is not null
          and status = 'FULFILLED'
        group by org_id, upper(trim(job_number))
      )
      select
        j.id,
        j.job_number,
        j.due_date,
        j.lifecycle_status,
        coalesce(a.active_allocation_count, 0) as active_allocation_count,
        coalesce(o.open_film_order_count, 0) as open_film_order_count,
        coalesce(fa.fulfilled_allocation_count, 0) as fulfilled_allocation_count,
        coalesce(ffo.fulfilled_film_order_count, 0) as fulfilled_film_order_count
      from app.jobs j
      left join active_allocations a
        on a.org_id = j.org_id
       and a.job_number_key = upper(trim(j.job_number))
      left join open_film_orders o
        on o.org_id = j.org_id
       and o.job_number_key = upper(trim(j.job_number))
      left join fulfilled_allocations fa
        on fa.org_id = j.org_id
       and fa.job_number_key = upper(trim(j.job_number))
      left join fulfilled_film_orders ffo
        on ffo.org_id = j.org_id
       and ffo.job_number_key = upper(trim(j.job_number))
      where j.org_id = $1
        and coalesce(upper(trim(j.lifecycle_status::text)), 'ACTIVE') = 'ACTIVE'
      order by j.due_date desc nulls last, j.updated_at desc, j.job_number desc
    `,
    [orgId]
  );

  const evaluated = rows.map((row) => normalizeCompletedJobBackfillCandidate(row));
  const candidates = evaluated.filter((row) => Boolean(row.id) && Boolean(row.jobNumber) && row.shouldBackfill);

  return {
    evaluatedCount: evaluated.length,
    candidates
  };
}

async function applyLegacyCompletedBackfill(client, orgId, actor, candidates) {
  const targetIds = candidates.map((candidate) => candidate.id).filter(Boolean);
  if (!targetIds.length) {
    return [];
  }

  await client.query('begin');
  try {
    const { rows } = await client.query(
      `
        update app.jobs
        set
          lifecycle_status = 'COMPLETED',
          updated_at = now(),
          updated_by = $3
        where org_id = $1
          and id = any($2::uuid[])
          and coalesce(upper(trim(lifecycle_status::text)), 'ACTIVE') = 'ACTIVE'
        returning
          job_number,
          lifecycle_status,
          updated_at,
          updated_by
      `,
      [orgId, targetIds, actor]
    );
    await client.query('commit');
    return rows.map((row) => ({
      jobNumber: asTrimmedString(row.job_number),
      lifecycleStatus: asTrimmedString(row.lifecycle_status),
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : asTrimmedString(row.updated_at),
      updatedBy: asTrimmedString(row.updated_by)
    }));
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const applyMode = args.apply === true;
  const databaseUrl = asTrimmedString(args['database-url'] || process.env.DATABASE_URL || process.env.SUPABASE_DB_URL);
  const orgId = asTrimmedString(args['org-id'] || process.env.DEFAULT_ORG_ID);
  const actor = asTrimmedString(args.actor || 'completed-job-backfill-script');

  if (!databaseUrl) {
    throw new Error('DATABASE_URL (or SUPABASE_DB_URL) is required.');
  }
  if (!orgId) {
    throw new Error('DEFAULT_ORG_ID is required.');
  }

  const client = new Client({
    connectionString: databaseUrl,
    ssl: /localhost|127\.0\.0\.1/i.test(databaseUrl) ? undefined : { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    const { evaluatedCount, candidates } = await loadLegacyCompletedCandidates(client, orgId);
    const updatedJobs = applyMode
      ? await applyLegacyCompletedBackfill(client, orgId, actor, candidates)
      : [];

    const report = {
      mode: applyMode ? 'apply' : 'dry-run',
      orgId,
      actor,
      evaluatedCount,
      candidateCount: candidates.length,
      candidates: candidates.map((candidate) => ({
        jobNumber: candidate.jobNumber,
        dueDate: candidate.dueDate,
        activeAllocationCount: candidate.activeAllocationCount,
        openFilmOrderCount: candidate.openFilmOrderCount,
        fulfilledAllocationCount: candidate.fulfilledAllocationCount,
        fulfilledFilmOrderCount: candidate.fulfilledFilmOrderCount,
        fulfilledRecordCount: candidate.fulfilledRecordCount
      })),
      updatedCount: updatedJobs.length,
      updatedJobs
    };

    console.log(JSON.stringify(report, null, 2));
  } finally {
    await client.end().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

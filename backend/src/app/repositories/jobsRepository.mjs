import crypto from 'node:crypto';
import { queryRow, queryRows } from '../../db/client.mjs';
import { HttpError } from '../../lib/http.mjs';
import {
  asTrimmedString,
  integerOrZero,
  parseIntegerInput,
  parseStrictBooleanFlag,
  requireUuid,
} from '../core/helpers.mjs';
import { resolveCatalogWriteFilmEntry } from '../core/catalog.mjs';
import {
  mapDbCaulkJobAllocationRow,
  mapDbCaulkJobCheckoutRow,
  mapDbCaulkTransferRow,
  mapDbCaulkJobRequirementRow,
  mapDbJobRow,
  mapDbRequirementRow,
} from './mappers.mjs';

async function listJobs(client, orgId) {
  const rows = await queryRows(
    client,
    `
      select *
      from app.jobs
      where org_id = $1
      order by due_date desc nulls last, updated_at desc, job_number desc
    `,
    [orgId]
  );

  return rows.map(mapDbJobRow);
}

async function findJobByNumber(client, orgId, jobNumber) {
  const row = await queryRow(
    client,
    `
      select *
      from app.jobs
      where org_id = $1
        and upper(trim(job_number)) = upper(trim($2))
    `,
    [orgId, jobNumber]
  );

  return mapDbJobRow(row);
}

async function listJobsByNumber(client, orgId, jobNumber) {
  const rows = await queryRows(
    client,
    `
      select *
      from app.jobs
      where org_id = $1
        and upper(trim(job_number)) = upper(trim($2))
      order by due_date desc nulls last, updated_at desc, job_number desc, id asc
    `,
    [orgId, jobNumber]
  );

  return rows.map(mapDbJobRow);
}

async function findJobById(client, orgId, jobId) {
  const row = await queryRow(
    client,
    `
      select *
      from app.jobs
      where org_id = $1
        and id = $2
    `,
    [orgId, requireUuid(jobId, 'JobId')]
  );

  return mapDbJobRow(row);
}

async function saveJobRecord(client, orgId, job) {
  const row = await queryRow(
    client,
    `
      insert into app.jobs (
        id,
        org_id,
        job_number,
        warehouse,
        sections,
        due_date,
        crew_leader,
        lifecycle_status,
        is_labor_only,
        is_staged_for_pickup,
        notes,
        created_at,
        created_by,
        updated_at,
        updated_by
      )
      values (
        coalesce(nullif($2, '')::uuid, gen_random_uuid()),
        $1,$3,$4,$5,
        nullif($6, '')::date,
        $7,$8,$9,$10,$11,
        coalesce($12::timestamptz, now()),
        $13,
        coalesce($14::timestamptz, now()),
        $15
      )
      on conflict (id) do update set
        job_number = excluded.job_number,
        warehouse = excluded.warehouse,
        sections = excluded.sections,
        due_date = excluded.due_date,
        crew_leader = excluded.crew_leader,
        lifecycle_status = excluded.lifecycle_status,
        is_labor_only = excluded.is_labor_only,
        is_staged_for_pickup = excluded.is_staged_for_pickup,
        notes = excluded.notes,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
      returning *
    `,
    [
      orgId,
      job.id || job.jobId || '',
      job.jobNumber,
      job.warehouse,
      job.sections,
      job.installDate,
      job.crewLeader,
      job.lifecycleStatus,
      Boolean(job.isLaborOnly),
      Boolean(job.isStagedForPickup),
      job.notes,
      job.createdAt,
      job.createdBy,
      job.updatedAt,
      job.updatedBy,
    ]
  );

  return mapDbJobRow(row);
}

async function saveJobRecordById(client, orgId, job) {
  const row = await queryRow(
    client,
    `
      update app.jobs
      set
        warehouse = $3,
        sections = $4,
        due_date = nullif($5, '')::date,
        crew_leader = $6,
        lifecycle_status = $7,
        is_labor_only = $8,
        is_staged_for_pickup = $9,
        notes = $10,
        updated_at = coalesce($11::timestamptz, now()),
        updated_by = $12
      where org_id = $1
        and id = $2
      returning *
    `,
    [
      orgId,
      requireUuid(job.id || job.jobId || job.job_id, 'JobId'),
      job.warehouse,
      job.sections,
      job.installDate,
      job.crewLeader,
      job.lifecycleStatus,
      Boolean(job.isLaborOnly),
      Boolean(job.isStagedForPickup),
      job.notes,
      job.updatedAt,
      job.updatedBy,
    ]
  );

  return mapDbJobRow(row);
}

async function listJobRequirements(client, orgId) {
  const rows = await queryRows(
    client,
    `
      select
        r.*,
        j.job_number,
        exists (
          select 1
          from app.allocation_planner_suppressions s
          where s.org_id = r.org_id
            and s.job_id = r.job_id
            and s.material_type = 'FILM'
            and s.cleared_at is null
            and s.requirement_signature = app_api.film_requirement_planner_signature(
              r.manufacturer,
              r.film_name,
              r.width_in,
              r.required_feet
            )
        ) as auto_planning_suppressed
      from app.job_requirements r
      join app.jobs j on j.id = r.job_id
      where r.org_id = $1
      order by j.job_number asc, r.manufacturer asc, r.film_name asc, r.width_in asc
    `,
    [orgId]
  );

  return rows.map(mapDbRequirementRow);
}

async function listJobRequirementsByJob(client, orgId, jobNumber) {
  const rows = await queryRows(
    client,
    `
      select
        r.*,
        j.job_number,
        exists (
          select 1
          from app.allocation_planner_suppressions s
          where s.org_id = r.org_id
            and s.job_id = r.job_id
            and s.material_type = 'FILM'
            and s.cleared_at is null
            and s.requirement_signature = app_api.film_requirement_planner_signature(
              r.manufacturer,
              r.film_name,
              r.width_in,
              r.required_feet
            )
        ) as auto_planning_suppressed
      from app.job_requirements r
      join app.jobs j on j.id = r.job_id
      where r.org_id = $1
        and upper(trim(j.job_number)) = upper(trim($2))
      order by r.manufacturer asc, r.film_name asc, r.width_in asc
    `,
    [orgId, jobNumber]
  );

  return rows.map(mapDbRequirementRow);
}

async function listJobRequirementsByJobId(client, orgId, jobId) {
  const rows = await queryRows(
    client,
    `
      select
        r.*,
        j.job_number,
        exists (
          select 1
          from app.allocation_planner_suppressions s
          where s.org_id = r.org_id
            and s.job_id = r.job_id
            and s.material_type = 'FILM'
            and s.cleared_at is null
            and s.requirement_signature = app_api.film_requirement_planner_signature(
              r.manufacturer,
              r.film_name,
              r.width_in,
              r.required_feet
            )
        ) as auto_planning_suppressed
      from app.job_requirements r
      join app.jobs j on j.id = r.job_id
      where r.org_id = $1
        and r.job_id = $2
      order by r.manufacturer asc, r.film_name asc, r.width_in asc
    `,
    [orgId, jobId]
  );

  return rows.map(mapDbRequirementRow);
}

async function listJobCaulkRequirements(client, orgId) {
  const rows = await queryRows(
    client,
    `
      select
        r.id as requirement_id,
        r.job_id,
        j.job_number,
        r.product_id,
        p.manufacturer_id,
        m.name as manufacturer,
        p.name as product_name,
        p.code as product_code,
        p.tubes_per_case,
        r.required_tubes,
        r.notes,
        r.updated_at,
        exists (
          select 1
          from app.allocation_planner_suppressions s
          where s.org_id = r.org_id
            and s.job_id = r.job_id
            and s.material_type = 'CAULK'
            and s.cleared_at is null
            and s.requirement_signature = app_api.caulk_requirement_planner_signature(
              r.product_id,
              j.warehouse,
              r.required_tubes
            )
        ) as auto_planning_suppressed
      from app.job_caulk_requirements r
      join app.jobs j
        on j.id = r.job_id
       and j.org_id = r.org_id
      join app.caulk_products p
        on p.id = r.product_id
       and p.org_id = r.org_id
      join app.caulk_manufacturers m
        on m.id = p.manufacturer_id
       and m.org_id = p.org_id
      where r.org_id = $1
      order by j.job_number asc, lower(m.name), lower(p.name), lower(p.code)
    `,
    [orgId]
  );

  return rows.map(mapDbCaulkJobRequirementRow);
}

async function listJobCaulkRequirementsByJob(client, orgId, jobNumber) {
  const rows = await queryRows(
    client,
    `
      select
        r.id as requirement_id,
        r.job_id,
        j.job_number,
        r.product_id,
        p.manufacturer_id,
        m.name as manufacturer,
        p.name as product_name,
        p.code as product_code,
        p.tubes_per_case,
        r.required_tubes,
        r.notes,
        r.updated_at,
        exists (
          select 1
          from app.allocation_planner_suppressions s
          where s.org_id = r.org_id
            and s.job_id = r.job_id
            and s.material_type = 'CAULK'
            and s.cleared_at is null
            and s.requirement_signature = app_api.caulk_requirement_planner_signature(
              r.product_id,
              j.warehouse,
              r.required_tubes
            )
        ) as auto_planning_suppressed
      from app.job_caulk_requirements r
      join app.jobs j
        on j.id = r.job_id
       and j.org_id = r.org_id
      join app.caulk_products p
        on p.id = r.product_id
       and p.org_id = r.org_id
      join app.caulk_manufacturers m
        on m.id = p.manufacturer_id
       and m.org_id = p.org_id
      where r.org_id = $1
        and upper(j.job_number) = upper(trim($2))
      order by lower(m.name), lower(p.name), lower(p.code)
    `,
    [orgId, jobNumber]
  );

  return rows.map(mapDbCaulkJobRequirementRow);
}

async function listJobCaulkRequirementsByJobId(client, orgId, jobId) {
  const rows = await queryRows(
    client,
    `
      select
        r.id as requirement_id,
        r.job_id,
        j.job_number,
        r.product_id,
        p.manufacturer_id,
        m.name as manufacturer,
        p.name as product_name,
        p.code as product_code,
        p.tubes_per_case,
        r.required_tubes,
        r.notes,
        r.updated_at,
        exists (
          select 1
          from app.allocation_planner_suppressions s
          where s.org_id = r.org_id
            and s.job_id = r.job_id
            and s.material_type = 'CAULK'
            and s.cleared_at is null
            and s.requirement_signature = app_api.caulk_requirement_planner_signature(
              r.product_id,
              j.warehouse,
              r.required_tubes
            )
        ) as auto_planning_suppressed
      from app.job_caulk_requirements r
      join app.jobs j
        on j.id = r.job_id
       and j.org_id = r.org_id
      join app.caulk_products p
        on p.id = r.product_id
       and p.org_id = r.org_id
      join app.caulk_manufacturers m
        on m.id = p.manufacturer_id
       and m.org_id = p.org_id
      where r.org_id = $1
        and r.job_id = $2
      order by lower(m.name), lower(p.name), lower(p.code)
    `,
    [orgId, jobId]
  );

  return rows.map(mapDbCaulkJobRequirementRow);
}

async function listCaulkJobAllocations(client, orgId) {
  const rows = await queryRows(
    client,
    `
      with open_counts as (
        select
          c.caulk_allocation_id,
          count(*)::integer as open_checkout_count
        from app.caulk_job_checkouts c
        where c.org_id = $1
          and c.status = 'OPEN'
        group by c.caulk_allocation_id
      ),
      pending_transfers as (
        select distinct on (t.caulk_allocation_id)
          t.caulk_allocation_id,
          t.transfer_id,
          t.source_warehouse,
          t.destination_warehouse,
          t.pending_tubes,
          t.created_at,
          t.created_by,
          t.notes
        from app.caulk_transfers t
        where t.org_id = $1
          and t.status = 'PENDING'
        order by t.caulk_allocation_id, t.created_at desc, t.id desc
      )
      select
        a.caulk_allocation_id,
        a.requirement_id,
        a.job_id,
        a.product_id,
        p.manufacturer_id,
        m.name as manufacturer,
        p.name as product_name,
        p.code as product_code,
        p.tubes_per_case,
        a.job_number,
        a.warehouse,
        a.allocated_tubes,
        a.reserved_tubes_remaining,
        a.checked_out_tubes_total,
        a.returned_unused_tubes_total,
        a.used_tubes_total,
        a.overage_tubes_total,
        greatest(a.checked_out_tubes_total - a.returned_unused_tubes_total - a.used_tubes_total, 0)::integer as outstanding_checkout_tubes,
        coalesce(o.open_checkout_count, 0) as open_checkout_count,
        pt.transfer_id as pending_transfer_id,
        pt.source_warehouse as pending_transfer_source_warehouse,
        pt.destination_warehouse as pending_transfer_destination_warehouse,
        pt.pending_tubes as pending_transfer_tubes,
        pt.created_at as pending_transfer_started_at,
        pt.created_by as pending_transfer_started_by,
        pt.notes as pending_transfer_notes,
        a.status::text as status,
        a.allocation_source::text as allocation_source,
        a.created_at,
        a.created_by,
        a.updated_at,
        a.updated_by,
        a.resolved_at,
        a.resolved_by,
        a.notes
      from app.caulk_job_allocations a
      join app.caulk_products p
        on p.id = a.product_id
       and p.org_id = a.org_id
      join app.caulk_manufacturers m
        on m.id = p.manufacturer_id
       and m.org_id = p.org_id
      left join open_counts o
        on o.caulk_allocation_id = a.id
      left join pending_transfers pt
        on pt.caulk_allocation_id = a.id
      where a.org_id = $1
      order by a.created_at desc, a.caulk_allocation_id desc
    `,
    [orgId]
  );

  return rows.map(mapDbCaulkJobAllocationRow);
}

async function listCaulkJobAllocationsByJob(client, orgId, jobNumber) {
  const rows = await queryRows(
    client,
    `
      with open_counts as (
        select
          c.caulk_allocation_id,
          count(*)::integer as open_checkout_count
        from app.caulk_job_checkouts c
        where c.org_id = $1
          and c.status = 'OPEN'
        group by c.caulk_allocation_id
      ),
      pending_transfers as (
        select distinct on (t.caulk_allocation_id)
          t.caulk_allocation_id,
          t.transfer_id,
          t.source_warehouse,
          t.destination_warehouse,
          t.pending_tubes,
          t.created_at,
          t.created_by,
          t.notes
        from app.caulk_transfers t
        where t.org_id = $1
          and t.status = 'PENDING'
        order by t.caulk_allocation_id, t.created_at desc, t.id desc
      )
      select
        a.caulk_allocation_id,
        a.requirement_id,
        a.job_id,
        a.product_id,
        p.manufacturer_id,
        m.name as manufacturer,
        p.name as product_name,
        p.code as product_code,
        p.tubes_per_case,
        a.job_number,
        a.warehouse,
        a.allocated_tubes,
        a.reserved_tubes_remaining,
        a.checked_out_tubes_total,
        a.returned_unused_tubes_total,
        a.used_tubes_total,
        a.overage_tubes_total,
        greatest(a.checked_out_tubes_total - a.returned_unused_tubes_total - a.used_tubes_total, 0)::integer as outstanding_checkout_tubes,
        coalesce(o.open_checkout_count, 0) as open_checkout_count,
        pt.transfer_id as pending_transfer_id,
        pt.source_warehouse as pending_transfer_source_warehouse,
        pt.destination_warehouse as pending_transfer_destination_warehouse,
        pt.pending_tubes as pending_transfer_tubes,
        pt.created_at as pending_transfer_started_at,
        pt.created_by as pending_transfer_started_by,
        pt.notes as pending_transfer_notes,
        a.status::text as status,
        a.allocation_source::text as allocation_source,
        a.created_at,
        a.created_by,
        a.updated_at,
        a.updated_by,
        a.resolved_at,
        a.resolved_by,
        a.notes
      from app.caulk_job_allocations a
      join app.caulk_products p
        on p.id = a.product_id
       and p.org_id = a.org_id
      join app.caulk_manufacturers m
        on m.id = p.manufacturer_id
       and m.org_id = p.org_id
      left join open_counts o
        on o.caulk_allocation_id = a.id
      left join pending_transfers pt
        on pt.caulk_allocation_id = a.id
      where a.org_id = $1
        and upper(a.job_number) = upper(trim($2))
      order by a.created_at desc, a.caulk_allocation_id desc
    `,
    [orgId, jobNumber]
  );

  return rows.map(mapDbCaulkJobAllocationRow);
}

async function listCaulkJobAllocationsByJobId(client, orgId, jobId) {
  const rows = await queryRows(
    client,
    `
      with open_counts as (
        select
          c.caulk_allocation_id,
          count(*)::integer as open_checkout_count
        from app.caulk_job_checkouts c
        join app.caulk_job_allocations a
          on a.id = c.caulk_allocation_id
         and a.org_id = c.org_id
        where c.org_id = $1
          and a.job_id = $2
          and c.status = 'OPEN'
        group by c.caulk_allocation_id
      ),
      pending_transfers as (
        select distinct on (t.caulk_allocation_id)
          t.caulk_allocation_id,
          t.transfer_id,
          t.source_warehouse,
          t.destination_warehouse,
          t.pending_tubes,
          t.created_at,
          t.created_by,
          t.notes
        from app.caulk_transfers t
        join app.caulk_job_allocations a
          on a.id = t.caulk_allocation_id
         and a.org_id = t.org_id
        where t.org_id = $1
          and a.job_id = $2
          and t.status = 'PENDING'
        order by t.caulk_allocation_id, t.created_at desc, t.id desc
      )
      select
        a.caulk_allocation_id,
        a.requirement_id,
        a.job_id,
        a.product_id,
        p.manufacturer_id,
        m.name as manufacturer,
        p.name as product_name,
        p.code as product_code,
        p.tubes_per_case,
        a.job_number,
        a.warehouse,
        a.allocated_tubes,
        a.reserved_tubes_remaining,
        a.checked_out_tubes_total,
        a.returned_unused_tubes_total,
        a.used_tubes_total,
        a.overage_tubes_total,
        greatest(a.checked_out_tubes_total - a.returned_unused_tubes_total - a.used_tubes_total, 0)::integer as outstanding_checkout_tubes,
        coalesce(o.open_checkout_count, 0) as open_checkout_count,
        pt.transfer_id as pending_transfer_id,
        pt.source_warehouse as pending_transfer_source_warehouse,
        pt.destination_warehouse as pending_transfer_destination_warehouse,
        pt.pending_tubes as pending_transfer_tubes,
        pt.created_at as pending_transfer_started_at,
        pt.created_by as pending_transfer_started_by,
        pt.notes as pending_transfer_notes,
        a.status::text as status,
        a.allocation_source::text as allocation_source,
        a.created_at,
        a.created_by,
        a.updated_at,
        a.updated_by,
        a.resolved_at,
        a.resolved_by,
        a.notes
      from app.caulk_job_allocations a
      join app.caulk_products p
        on p.id = a.product_id
       and p.org_id = a.org_id
      join app.caulk_manufacturers m
        on m.id = p.manufacturer_id
       and m.org_id = p.org_id
      left join open_counts o
        on o.caulk_allocation_id = a.id
      left join pending_transfers pt
        on pt.caulk_allocation_id = a.id
      where a.org_id = $1
        and a.job_id = $2
      order by a.created_at desc, a.caulk_allocation_id desc
    `,
    [orgId, jobId]
  );

  return rows.map(mapDbCaulkJobAllocationRow);
}

async function listCaulkJobCheckoutsByJob(client, orgId, jobNumber) {
  const rows = await queryRows(
    client,
    `
      select
        c.caulk_checkout_id,
        a.caulk_allocation_id,
        c.product_id,
        p.manufacturer_id,
        m.name as manufacturer,
        p.name as product_name,
        p.code as product_code,
        p.tubes_per_case,
        c.warehouse,
        c.checkout_tubes,
        c.overage_tubes,
        c.status::text as status,
        c.checked_out_at,
        c.checked_out_by,
        c.checked_in_at,
        c.checked_in_by,
        c.unused_tubes,
        c.used_tubes,
        c.notes
      from app.caulk_job_checkouts c
      join app.caulk_job_allocations a
        on a.id = c.caulk_allocation_id
       and a.org_id = c.org_id
      join app.caulk_products p
        on p.id = c.product_id
       and p.org_id = c.org_id
      join app.caulk_manufacturers m
        on m.id = p.manufacturer_id
       and m.org_id = p.org_id
      where c.org_id = $1
        and upper(c.job_number) = upper(trim($2))
      order by c.checked_out_at desc, c.caulk_checkout_id desc
    `,
    [orgId, jobNumber]
  );

  return rows.map(mapDbCaulkJobCheckoutRow);
}

async function listCaulkJobCheckoutsByJobId(client, orgId, jobId) {
  const rows = await queryRows(
    client,
    `
      select
        c.caulk_checkout_id,
        a.caulk_allocation_id,
        c.product_id,
        p.manufacturer_id,
        m.name as manufacturer,
        p.name as product_name,
        p.code as product_code,
        p.tubes_per_case,
        c.warehouse,
        c.checkout_tubes,
        c.overage_tubes,
        c.status::text as status,
        c.checked_out_at,
        c.checked_out_by,
        c.checked_in_at,
        c.checked_in_by,
        c.unused_tubes,
        c.used_tubes,
        c.notes
      from app.caulk_job_checkouts c
      join app.caulk_job_allocations a
        on a.id = c.caulk_allocation_id
       and a.org_id = c.org_id
      join app.caulk_products p
        on p.id = c.product_id
       and p.org_id = c.org_id
      join app.caulk_manufacturers m
        on m.id = p.manufacturer_id
       and m.org_id = p.org_id
      where c.org_id = $1
        and a.job_id = $2
      order by c.checked_out_at desc, c.caulk_checkout_id desc
    `,
    [orgId, jobId]
  );

  return rows.map(mapDbCaulkJobCheckoutRow);
}

async function listPendingCaulkTransfersByAllocationIds(client, orgId, allocationIds) {
  const normalizedIds = Array.from(new Set((Array.isArray(allocationIds) ? allocationIds : []).filter(Boolean)));
  if (normalizedIds.length === 0) {
    return [];
  }

  const rows = await queryRows(
    client,
    `
      select
        t.*,
        a.caulk_allocation_id as caulk_allocation_public_id,
        a.job_number,
        j.warehouse as job_warehouse,
        p.id as product_id,
        p.manufacturer_id,
        m.name as manufacturer,
        p.name as product_name,
        p.code as product_code,
        p.tubes_per_case
      from app.caulk_transfers t
      join app.caulk_job_allocations a
        on a.org_id = t.org_id
       and a.id = t.caulk_allocation_id
      join app.caulk_products p
        on p.org_id = t.org_id
       and p.id = t.product_id
      left join app.jobs j
        on j.org_id = a.org_id
       and upper(trim(j.job_number)) = upper(trim(a.job_number))
      join app.caulk_manufacturers m
        on m.org_id = p.org_id
       and m.id = p.manufacturer_id
      where t.org_id = $1
        and t.status = 'PENDING'
        and t.caulk_allocation_id = any($2::uuid[])
      order by t.created_at desc, t.id desc
    `,
    [orgId, normalizedIds]
  );

  return rows.map(mapDbCaulkTransferRow);
}

function indexPendingCaulkTransfersByAllocationId(transfers) {
  const indexed = {};
  const entries = Array.isArray(transfers) ? transfers : [];
  for (let index = 0; index < entries.length; index += 1) {
    const transfer = entries[index];
    if (!transfer?.caulkAllocationRowId || indexed[transfer.caulkAllocationRowId]) {
      continue;
    }
    indexed[transfer.caulkAllocationRowId] = transfer;
  }
  return indexed;
}

async function listPendingCaulkTransfersByWarehouseProduct(client, orgId, warehouse, productId = '') {
  const rows = await queryRows(
    client,
    `
      select
        t.*,
        a.caulk_allocation_id as caulk_allocation_public_id,
        a.job_number,
        j.warehouse as job_warehouse,
        p.id as product_id,
        p.manufacturer_id,
        m.name as manufacturer,
        p.name as product_name,
        p.code as product_code,
        p.tubes_per_case
      from app.caulk_transfers t
      join app.caulk_job_allocations a
        on a.org_id = t.org_id
       and a.id = t.caulk_allocation_id
      join app.caulk_products p
        on p.org_id = t.org_id
       and p.id = t.product_id
      left join app.jobs j
        on j.org_id = a.org_id
       and upper(trim(j.job_number)) = upper(trim(a.job_number))
      join app.caulk_manufacturers m
        on m.org_id = p.org_id
       and m.id = p.manufacturer_id
      where t.org_id = $1
        and t.status = 'PENDING'
        and t.destination_warehouse = $2
        and ($3::uuid is null or t.product_id = $3::uuid)
      order by t.created_at desc, t.id desc
    `,
    [orgId, asTrimmedString(warehouse).toUpperCase(), productId ? requireUuid(productId, 'ProductId') : null]
  );

  return rows.map(mapDbCaulkTransferRow);
}

async function replaceJobRequirementsForJob(client, orgId, jobHeader, entries) {
  await client.query(
    `
      delete from app.job_requirements
      where org_id = $1
        and job_id = $2
    `,
    [orgId, jobHeader.id]
  );

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const canonical = await resolveCatalogWriteFilmEntry(client, orgId, entry.manufacturer, entry.filmName);
    const manufacturer = canonical.manufacturer;
    const filmName = canonical.filmName;
    await client.query(
      `
        insert into app.job_requirements (
          id,
          org_id,
          job_id,
          manufacturer,
          film_name,
          width_in,
          required_feet,
          notes,
          created_at,
          created_by,
          updated_at,
          updated_by
        )
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz,$10,$11::timestamptz,$12)
      `,
      [
        entry.id || crypto.randomUUID(),
        orgId,
        jobHeader.id,
        manufacturer,
        filmName,
        entry.widthIn,
        entry.requiredFeet,
        entry.notes || '',
        entry.createdAt || new Date().toISOString(),
        entry.createdBy || '',
        entry.updatedAt || new Date().toISOString(),
        entry.updatedBy || '',
      ]
    );
  }
}

async function normalizeJobCaulkRequirementEntries(client, orgId, entries) {
  const source = Array.isArray(entries) ? entries : [];
  if (!source.length) {
    return [];
  }

  const mergedByProductId = {};
  for (let index = 0; index < source.length; index += 1) {
    const entry = source[index] || {};
    const productId = requireUuid(entry.productId, `CaulkRequirements[${index + 1}].ProductId`);
    const requiredTubes = parseIntegerInput(
      entry.requiredTubes,
      `CaulkRequirements[${index + 1}].RequiredTubes`
    );

    if (requiredTubes <= 0) {
      throw new HttpError(400, `CaulkRequirements[${index + 1}].RequiredTubes must be greater than zero.`);
    }

    if (!mergedByProductId[productId]) {
      mergedByProductId[productId] = {
        requirementId: asTrimmedString(entry.requirementId),
        productId,
        requiredTubes: 0,
      };
    }

    mergedByProductId[productId].requiredTubes += Math.floor(requiredTubes);
  }

  const productIds = Object.keys(mergedByProductId);
  const rows = await queryRows(
    client,
    `
      select id
      from app.caulk_products
      where org_id = $1::uuid
        and id = any($2::uuid[])
    `,
    [orgId, productIds]
  );
  const existingById = {};
  for (let index = 0; index < rows.length; index += 1) {
    existingById[asTrimmedString(rows[index].id)] = true;
  }

  for (let index = 0; index < productIds.length; index += 1) {
    if (!existingById[productIds[index]]) {
      throw new HttpError(404, `Caulk product ${productIds[index]} was not found.`);
    }
  }

  return productIds.map((productId) => mergedByProductId[productId]);
}

async function replaceJobCaulkRequirementsForJob(client, orgId, jobHeader, entries, actor, nowIso) {
  await client.query(
    `
      delete from app.job_caulk_requirements
      where org_id = $1
        and job_id = $2
    `,
    [orgId, jobHeader.id]
  );

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    await client.query(
      `
        insert into app.job_caulk_requirements (
          id,
          org_id,
          job_id,
          product_id,
          required_tubes,
          notes,
          created_at,
          created_by,
          updated_at,
          updated_by
        )
        values (
          $1,$2,$3,$4,$5,$6,
          $7::timestamptz,$8,
          $9::timestamptz,$10
        )
      `,
      [
        entry.requirementId || crypto.randomUUID(),
        orgId,
        jobHeader.id,
        entry.productId,
        entry.requiredTubes,
        '',
        nowIso,
        actor,
        nowIso,
        actor,
      ]
    );
  }
}

function parseExplicitJobLaborOnlyValue(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const hasCamel = Object.prototype.hasOwnProperty.call(source, 'isLaborOnly');
  const hasSnake = Object.prototype.hasOwnProperty.call(source, 'is_labor_only');
  if (!hasCamel && !hasSnake) {
    return {
      hasValue: false,
      value: false,
    };
  }

  return {
    hasValue: true,
    value: parseStrictBooleanFlag(
      hasCamel ? source.isLaborOnly : source.is_labor_only,
      'isLaborOnly'
    ),
  };
}

function hasJobMaterialRequirements(requirements, caulkRequirements) {
  return (
    (Array.isArray(requirements) ? requirements : []).some(
      (entry) => integerOrZero(entry && entry.requiredFeet) > 0
    ) ||
    (Array.isArray(caulkRequirements) ? caulkRequirements : []).some(
      (entry) => integerOrZero(entry && entry.requiredTubes) > 0
    )
  );
}

function derivePersistedJobMaterialFlags(existingHeader, payload, requirements, caulkRequirements) {
  const explicitLaborOnly = parseExplicitJobLaborOnlyValue(payload);
  const previouslyLaborOnly = Boolean(existingHeader?.isLaborOnly);
  const hasMaterials = hasJobMaterialRequirements(requirements, caulkRequirements);
  let isLaborOnly = explicitLaborOnly.hasValue ? explicitLaborOnly.value : previouslyLaborOnly;
  let isStagedForPickup = Boolean(existingHeader?.isStagedForPickup);

  if (hasMaterials) {
    isLaborOnly = false;
    if (previouslyLaborOnly) {
      isStagedForPickup = false;
    }
  } else {
    isLaborOnly = true;
    isStagedForPickup = false;
  }

  return {
    isLaborOnly,
    isStagedForPickup,
  };
}

async function deleteJobRequirementsByJobId(client, orgId, jobId) {
  await client.query(
    `
      delete from app.job_requirements
      where org_id = $1
        and job_id = $2
    `,
    [orgId, jobId]
  );

  await client.query(
    `
      delete from app.job_caulk_requirements
      where org_id = $1
        and job_id = $2
    `,
    [orgId, jobId]
  );
}

async function deleteJobRecord(client, orgId, jobNumber) {
  await client.query(
    `
      delete from app.jobs
      where org_id = $1
        and upper(trim(job_number)) = upper(trim($2))
    `,
    [orgId, jobNumber]
  );
}

async function deleteJobRecordById(client, orgId, jobId) {
  await client.query(
    `
      delete from app.jobs
      where org_id = $1
        and id = $2
    `,
    [orgId, jobId]
  );
}

export {
  listJobs,
  listJobsByNumber,
  findJobByNumber,
  findJobById,
  saveJobRecord,
  saveJobRecordById,
  listJobRequirements,
  listJobRequirementsByJob,
  listJobRequirementsByJobId,
  listJobCaulkRequirements,
  listJobCaulkRequirementsByJob,
  listJobCaulkRequirementsByJobId,
  listCaulkJobAllocations,
  listCaulkJobAllocationsByJob,
  listCaulkJobAllocationsByJobId,
  listCaulkJobCheckoutsByJob,
  listCaulkJobCheckoutsByJobId,
  listPendingCaulkTransfersByAllocationIds,
  indexPendingCaulkTransfersByAllocationId,
  listPendingCaulkTransfersByWarehouseProduct,
  replaceJobRequirementsForJob,
  normalizeJobCaulkRequirementEntries,
  replaceJobCaulkRequirementsForJob,
  parseExplicitJobLaborOnlyValue,
  hasJobMaterialRequirements,
  derivePersistedJobMaterialFlags,
  deleteJobRequirementsByJobId,
  deleteJobRecord,
  deleteJobRecordById,
};

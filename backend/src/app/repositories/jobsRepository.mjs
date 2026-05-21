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
  normalizeJobPhaseLaborStatus,
  normalizeJobPhaseNumber,
  normalizeJobRequirementLookupKey,
} from '../core/jobs.mjs';
import {
  mapDbCaulkJobAllocationRow,
  mapDbCaulkJobCheckoutRow,
  mapDbCaulkTransferRow,
  mapDbCaulkJobRequirementRow,
  mapDbJobPhaseRow,
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

async function listJobPhases(client, orgId) {
  const rows = await queryRows(
    client,
    `
      select *
      from app.job_phases
      where org_id = $1
      order by job_id asc, phase_number asc, created_at asc, id asc
    `,
    [orgId]
  );

  return rows.map(mapDbJobPhaseRow);
}

async function listJobPhasesByJobId(client, orgId, jobId) {
  const rows = await queryRows(
    client,
    `
      select *
      from app.job_phases
      where org_id = $1
        and job_id = $2
      order by phase_number asc, created_at asc, id asc
    `,
    [orgId, requireUuid(jobId, 'JobId')]
  );

  return rows.map(mapDbJobPhaseRow);
}

async function findJobPhaseById(client, orgId, jobId, phaseId) {
  const row = await queryRow(
    client,
    `
      select *
      from app.job_phases
      where org_id = $1
        and job_id = $2
        and id = $3
    `,
    [orgId, requireUuid(jobId, 'JobId'), requireUuid(phaseId, 'PhaseId')]
  );

  return mapDbJobPhaseRow(row);
}

async function saveJobPhaseRecord(client, orgId, jobId, phase) {
  const row = await queryRow(
    client,
    `
      insert into app.job_phases (
        id,
        org_id,
        job_id,
        phase_number,
        sections,
        install_date,
        crew_leader,
        labor_status,
        is_primary,
        created_at,
        created_by,
        updated_at,
        updated_by
      )
      values (
        coalesce(nullif($3, '')::uuid, gen_random_uuid()),
        $1,$2,$4,$5,
        nullif($6, '')::date,
        $7,$8,$9,
        coalesce($10::timestamptz, now()),
        $11,
        coalesce($12::timestamptz, now()),
        $13
      )
      on conflict (id) do update set
        phase_number = excluded.phase_number,
        sections = excluded.sections,
        install_date = excluded.install_date,
        crew_leader = excluded.crew_leader,
        labor_status = excluded.labor_status,
        is_primary = excluded.is_primary,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
      returning *
    `,
    [
      orgId,
      requireUuid(jobId, 'JobId'),
      asTrimmedString(phase.phaseId || phase.id),
      normalizeJobPhaseNumber(phase.phaseNumber, 'PhaseNumber'),
      phase.sections ?? phase.workScope ?? null,
      phase.installDate || '',
      asTrimmedString(phase.crewLeader),
      normalizeJobPhaseLaborStatus(phase.laborStatus || phase.status),
      phase.isPrimary === true,
      phase.createdAt || '',
      asTrimmedString(phase.createdBy),
      phase.updatedAt || new Date().toISOString(),
      asTrimmedString(phase.updatedBy),
    ]
  );

  return mapDbJobPhaseRow(row);
}

async function ensureDefaultJobPhase(client, orgId, jobHeader, actor = '', nowIso = '') {
  const phases = await listJobPhasesByJobId(client, orgId, jobHeader.id);
  if (phases.length) {
    return phases[0];
  }

  return saveJobPhaseRecord(client, orgId, jobHeader.id, {
    phaseNumber: 1,
    sections: jobHeader.sections ?? jobHeader.workScope ?? null,
    installDate: jobHeader.installDate || '',
    crewLeader: jobHeader.crewLeader || '',
    laborStatus: jobHeader.isLaborOnly ? 'ACTIVE' : 'ACTIVE',
    isPrimary: true,
    createdAt: jobHeader.createdAt || nowIso || new Date().toISOString(),
    createdBy: jobHeader.createdBy || actor || '',
    updatedAt: nowIso || new Date().toISOString(),
    updatedBy: actor || '',
  });
}

async function replaceJobPhasesForJob(client, orgId, jobHeader, phases, actor, nowIso) {
  const source = Array.isArray(phases) && phases.length
    ? phases
    : [{
        phaseNumber: 1,
        sections: jobHeader.sections ?? jobHeader.workScope ?? null,
        installDate: jobHeader.installDate || '',
        crewLeader: jobHeader.crewLeader || '',
        laborStatus: jobHeader.isLaborOnly ? 'ACTIVE' : 'ACTIVE',
        isPrimary: true,
      }];
  const seenPhaseNumbers = new Set();
  const saved = [];

  await client.query('SET CONSTRAINTS job_phases_org_job_phase_number_unique DEFERRED');
  await client.query(
    `
      update app.job_phases
      set is_primary = false,
          updated_at = $3::timestamptz,
          updated_by = $4
      where org_id = $1
        and job_id = $2
        and is_primary
    `,
    [orgId, jobHeader.id, nowIso || new Date().toISOString(), asTrimmedString(actor)]
  );

  for (let index = 0; index < source.length; index += 1) {
    const entry = source[index] || {};
    const phaseNumber = normalizeJobPhaseNumber(entry.phaseNumber ?? index + 1, `Phases[${index + 1}].PhaseNumber`);
    if (seenPhaseNumbers.has(phaseNumber)) {
      throw new HttpError(400, `Phase ${phaseNumber} already exists on this job.`);
    }
    seenPhaseNumbers.add(phaseNumber);
    saved.push(await saveJobPhaseRecord(client, orgId, jobHeader.id, {
      ...entry,
      phaseNumber,
      sections: entry.sections ?? entry.workScope ?? null,
      laborStatus: entry.laborStatus || entry.status,
      isPrimary: index === 0 || entry.isPrimary === true,
      updatedAt: nowIso,
      updatedBy: actor,
      createdAt: entry.createdAt || nowIso,
      createdBy: entry.createdBy || actor,
    }));
  }

  if (saved.length && !saved.some((entry) => entry.isPrimary)) {
    saved[0].isPrimary = true;
    await saveJobPhaseRecord(client, orgId, jobHeader.id, {
      ...saved[0],
      updatedAt: nowIso,
      updatedBy: actor,
    });
  }

  return listJobPhasesByJobId(client, orgId, jobHeader.id);
}

async function setJobPhaseLaborState(client, orgId, params, actor) {
  const jobId = requireUuid(params.jobId, 'JobId');
  const phaseId = requireUuid(params.phaseId, 'PhaseId');
  const status = normalizeJobPhaseLaborStatus(params.status);

  const row = await queryRow(
    client,
    `
      update app.job_phases p
      set
        labor_status = $4,
        updated_at = now(),
        updated_by = $5
      from app.jobs j
      where p.org_id = $1
        and p.job_id = $2
        and p.id = $3
        and j.org_id = p.org_id
        and j.id = p.job_id
      returning p.*, j.job_number
    `,
    [orgId, jobId, phaseId, status, asTrimmedString(actor)]
  );

  if (!row) {
    throw new HttpError(404, 'Job phase was not found.');
  }

  return mapDbJobPhaseRow(row);
}

async function listJobRequirements(client, orgId) {
  const rows = await queryRows(
    client,
    `
      select
        r.*,
        j.job_number,
        p.phase_number,
        p.sections as phase_sections,
        p.install_date as phase_install_date,
        p.crew_leader as phase_crew_leader,
        exists (
          select 1
          from app.allocation_planner_suppressions s
          where s.org_id = r.org_id
            and s.job_id = r.job_id
            and (s.phase_id is null or s.phase_id = r.phase_id)
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
      left join app.job_phases p
        on p.org_id = r.org_id
       and p.id = r.phase_id
      where r.org_id = $1
      order by j.job_number asc, p.phase_number asc nulls last, r.manufacturer asc, r.film_name asc, r.width_in asc
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
        p.phase_number,
        p.sections as phase_sections,
        p.install_date as phase_install_date,
        p.crew_leader as phase_crew_leader,
        exists (
          select 1
          from app.allocation_planner_suppressions s
          where s.org_id = r.org_id
            and s.job_id = r.job_id
            and (s.phase_id is null or s.phase_id = r.phase_id)
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
      left join app.job_phases p
        on p.org_id = r.org_id
       and p.id = r.phase_id
      where r.org_id = $1
        and upper(trim(j.job_number)) = upper(trim($2))
      order by p.phase_number asc nulls last, r.manufacturer asc, r.film_name asc, r.width_in asc
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
        p.phase_number,
        p.sections as phase_sections,
        p.install_date as phase_install_date,
        p.crew_leader as phase_crew_leader,
        exists (
          select 1
          from app.allocation_planner_suppressions s
          where s.org_id = r.org_id
            and s.job_id = r.job_id
            and (s.phase_id is null or s.phase_id = r.phase_id)
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
      left join app.job_phases p
        on p.org_id = r.org_id
       and p.id = r.phase_id
      where r.org_id = $1
        and r.job_id = $2
      order by p.phase_number asc nulls last, r.manufacturer asc, r.film_name asc, r.width_in asc
    `,
    [orgId, jobId]
  );

  return rows.map(mapDbRequirementRow);
}

async function findJobRequirementByIdForJob(client, orgId, jobId, requirementId) {
  const row = await queryRow(
    client,
    `
      select
        r.*,
        j.job_number,
        p.phase_number,
        p.sections as phase_sections,
        p.install_date as phase_install_date,
        p.crew_leader as phase_crew_leader,
        exists (
          select 1
          from app.allocation_planner_suppressions s
          where s.org_id = r.org_id
            and s.job_id = r.job_id
            and (s.phase_id is null or s.phase_id = r.phase_id)
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
      left join app.job_phases p
        on p.org_id = r.org_id
       and p.id = r.phase_id
      where r.org_id = $1
        and r.job_id = $2
        and r.id = $3
    `,
    [orgId, requireUuid(jobId, 'JobId'), requireUuid(requirementId, 'RequirementId')]
  );

  return mapDbRequirementRow(row);
}

async function listJobCaulkRequirements(client, orgId) {
  const rows = await queryRows(
    client,
    `
      select
        r.id as requirement_id,
        r.job_id,
        r.phase_id,
        ph.phase_number,
        ph.sections as phase_sections,
        ph.install_date as phase_install_date,
        ph.crew_leader as phase_crew_leader,
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
            and (s.phase_id is null or s.phase_id = r.phase_id)
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
      left join app.job_phases ph
        on ph.org_id = r.org_id
       and ph.id = r.phase_id
      join app.caulk_products p
        on p.id = r.product_id
       and p.org_id = r.org_id
      join app.caulk_manufacturers m
        on m.id = p.manufacturer_id
       and m.org_id = p.org_id
      where r.org_id = $1
      order by j.job_number asc, ph.phase_number asc nulls last, lower(m.name), lower(p.name), lower(p.code)
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
        r.phase_id,
        ph.phase_number,
        ph.sections as phase_sections,
        ph.install_date as phase_install_date,
        ph.crew_leader as phase_crew_leader,
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
            and (s.phase_id is null or s.phase_id = r.phase_id)
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
      left join app.job_phases ph
        on ph.org_id = r.org_id
       and ph.id = r.phase_id
      join app.caulk_products p
        on p.id = r.product_id
       and p.org_id = r.org_id
      join app.caulk_manufacturers m
        on m.id = p.manufacturer_id
       and m.org_id = p.org_id
      where r.org_id = $1
        and upper(j.job_number) = upper(trim($2))
      order by ph.phase_number asc nulls last, lower(m.name), lower(p.name), lower(p.code)
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
        r.phase_id,
        ph.phase_number,
        ph.sections as phase_sections,
        ph.install_date as phase_install_date,
        ph.crew_leader as phase_crew_leader,
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
            and (s.phase_id is null or s.phase_id = r.phase_id)
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
      left join app.job_phases ph
        on ph.org_id = r.org_id
       and ph.id = r.phase_id
      join app.caulk_products p
        on p.id = r.product_id
       and p.org_id = r.org_id
      join app.caulk_manufacturers m
        on m.id = p.manufacturer_id
       and m.org_id = p.org_id
      where r.org_id = $1
        and r.job_id = $2
      order by ph.phase_number asc nulls last, lower(m.name), lower(p.name), lower(p.code)
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
  const defaultPhase = await ensureDefaultJobPhase(client, orgId, jobHeader);
  const phases = await listJobPhasesByJobId(client, orgId, jobHeader.id);
  const phasesById = {};
  const phasesByNumber = {};
  for (let index = 0; index < phases.length; index += 1) {
    phasesById[asTrimmedString(phases[index].phaseId)] = phases[index];
    phasesByNumber[String(phases[index].phaseNumber)] = phases[index];
  }
  const existingRequirements = await listJobRequirementsByJobId(client, orgId, jobHeader.id);
  const existingById = {};
  const unusedExistingByKey = new Map();
  for (let index = 0; index < existingRequirements.length; index += 1) {
    const existing = existingRequirements[index];
    if (existing?.id) {
      existingById[existing.id] = existing;
    }
    const key = [
      asTrimmedString(existing.phaseId || defaultPhase.phaseId),
      normalizeJobRequirementLookupKey(existing.manufacturer, existing.filmName, existing.widthIn),
    ].join('|');
    const matches = unusedExistingByKey.get(key) || [];
    matches.push(existing);
    unusedExistingByKey.set(key, matches);
  }

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
    const explicitRequirementId = asTrimmedString(entry.id || entry.requirementId);
    const requestedPhaseId = asTrimmedString(entry.phaseId);
    const requestedPhaseNumber = asTrimmedString(entry.phaseNumber);
    const phase = requestedPhaseId
      ? phasesById[requestedPhaseId]
      : requestedPhaseNumber
        ? phasesByNumber[requestedPhaseNumber]
        : defaultPhase;
    if (!phase) {
      throw new HttpError(400, 'Requirement phase does not belong to this job.');
    }
    const phaseId = asTrimmedString(phase.phaseId);
    const lookupKey = [
      phaseId,
      normalizeJobRequirementLookupKey(manufacturer, filmName, entry.widthIn),
    ].join('|');
    const matchedExisting = explicitRequirementId
      ? existingById[explicitRequirementId] || null
      : (unusedExistingByKey.get(lookupKey) || [])[0] || null;
    if (!explicitRequirementId && matchedExisting) {
      const remainingMatches = (unusedExistingByKey.get(lookupKey) || []).filter(
        (candidate) => candidate.id !== matchedExisting.id
      );
      unusedExistingByKey.set(lookupKey, remainingMatches);
    }
    const nextStatus = asTrimmedString(entry.status || matchedExisting?.status).toUpperCase() === 'COMPLETE'
      ? 'COMPLETE'
      : 'ACTIVE';
    await client.query(
      `
        insert into app.job_requirements (
          id,
          org_id,
          job_id,
          phase_id,
          manufacturer,
          film_name,
          width_in,
          required_feet,
          status,
          actual_used_feet,
          completed_at,
          completed_by,
          notes,
          created_at,
          created_by,
          updated_at,
          updated_by
        )
        values (
          $1,$2,$3,$4,$5,$6,$7,$8,
          $9,$10::integer,
          nullif($11, '')::timestamptz,
          $12,
          $13,
          $14::timestamptz,$15,
          $16::timestamptz,$17
        )
      `,
      [
        explicitRequirementId || matchedExisting?.id || crypto.randomUUID(),
        orgId,
        jobHeader.id,
        phaseId,
        manufacturer,
        filmName,
        entry.widthIn,
        entry.requiredFeet,
        nextStatus,
        matchedExisting
          ? Math.max(integerOrZero(matchedExisting.actualUsedFeet), integerOrZero(entry.actualUsedFeet))
          : integerOrZero(entry.actualUsedFeet),
        nextStatus === 'COMPLETE'
          ? asTrimmedString(entry.completedAt || matchedExisting?.completedAt)
          : '',
        nextStatus === 'COMPLETE'
          ? asTrimmedString(entry.completedBy || matchedExisting?.completedBy)
          : '',
        entry.notes || '',
        entry.createdAt || matchedExisting?.createdAt || new Date().toISOString(),
        entry.createdBy || matchedExisting?.createdBy || '',
        entry.updatedAt || new Date().toISOString(),
        entry.updatedBy || '',
      ]
    );
  }
}

async function setJobRequirementState(client, orgId, params, actor) {
  const jobId = requireUuid(params.jobId, 'JobId');
  const requirementId = requireUuid(params.requirementId, 'RequirementId');
  const status = asTrimmedString(params.status).toUpperCase();
  if (status !== 'ACTIVE' && status !== 'COMPLETE') {
    throw new HttpError(400, 'Requirement status must be ACTIVE or COMPLETE.');
  }

  const row = await queryRow(
    client,
    `
      update app.job_requirements r
      set
        status = $4,
        completed_at = case when $4 = 'COMPLETE' then coalesce(r.completed_at, now()) else null end,
        completed_by = case when $4 = 'COMPLETE' then $5 else '' end,
        updated_at = now(),
        updated_by = $5
      from app.jobs j
      where r.org_id = $1
        and r.job_id = $2
        and r.id = $3
        and j.org_id = r.org_id
        and j.id = r.job_id
      returning r.*, j.job_number
    `,
    [orgId, jobId, requirementId, status, asTrimmedString(actor)]
  );

  if (!row) {
    throw new HttpError(404, 'Job requirement was not found.');
  }

  return mapDbRequirementRow(row);
}

async function recordRequirementActualUsageForCheckin(client, orgId, params, actor) {
  const boxId = asTrimmedString(params?.boxId).toUpperCase();
  const usedFeet = Math.max(0, Math.floor(Number(params?.usedFeet || 0)));
  const jobId = asTrimmedString(params?.jobId);
  const jobNumber = asTrimmedString(params?.jobNumber);
  const warnings = [];

  if (!boxId || usedFeet <= 0) {
    return { recordedFeet: 0, requirementIds: [], warnings };
  }

  const allocationRows = await queryRows(
    client,
    `
      with active_allocations as (
        select a.*
        from app.allocations a
        where a.org_id = $1
          and upper(trim(a.box_id)) = upper(trim($2))
          and a.status = 'ACTIVE'
          and coalesce(a.allocation_kind::text, 'REQUIREMENT') = 'REQUIREMENT'
          and (
            (
              nullif($3, '')::uuid is not null
              and (
                a.job_id = nullif($3, '')::uuid
                or (
                  a.job_id is null
                  and upper(trim(a.job_number)) = upper(trim($4))
                )
              )
            )
            or (
              nullif($3, '')::uuid is null
              and upper(trim(a.job_number)) = upper(trim($4))
            )
          )
      ),
      candidate_requirements as (
        select
          a.allocation_id,
          a.requirement_id,
          a.created_at
        from active_allocations a
        join app.job_requirements r
          on r.org_id = a.org_id
         and r.id = a.requirement_id
        where a.requirement_id is not null
          and (
            nullif($3, '')::uuid is null
            or r.job_id = nullif($3, '')::uuid
          )
        union all
        select
          a.allocation_id,
          legacy_match.requirement_id,
          a.created_at
        from active_allocations a
        left join lateral (
          select
            count(*)::integer as box_match_count,
            (array_agg(b.manufacturer order by b.updated_at desc, b.id))[1] as manufacturer,
            (array_agg(b.film_name order by b.updated_at desc, b.id))[1] as film_name,
            (array_agg(b.width_in order by b.updated_at desc, b.id))[1] as width_in
          from app.boxes b
          where b.org_id = a.org_id
            and upper(trim(b.box_id)) = upper(trim(a.box_id))
            and (
              upper(coalesce(b.status::text, '')) = 'CHECKED_OUT'
              or (
                nullif($3, '')::uuid is not null
                and b.last_checkout_job_id = nullif($3, '')::uuid
              )
              or (
                nullif($3, '')::uuid is null
                and upper(trim(coalesce(b.last_checkout_job, ''))) = upper(trim($4))
              )
            )
        ) box_match on true
        left join lateral (
          select
            count(*)::integer as requirement_match_count,
            (array_agg(r.id order by r.created_at, r.id))[1] as requirement_id
          from app.job_requirements r
          where r.org_id = a.org_id
            and r.job_id = coalesce(a.job_id, nullif($3, '')::uuid)
            and box_match.box_match_count = 1
            and r.width_in = box_match.width_in
            and app_api.normalize_requirement_film_key(r.org_id, r.manufacturer, r.film_name) =
              app_api.normalize_requirement_film_key(a.org_id, box_match.manufacturer, box_match.film_name)
        ) legacy_match on true
        where a.requirement_id is null
          and box_match.box_match_count = 1
          and legacy_match.requirement_match_count = 1
      )
      select
        a.allocation_id,
        cr.requirement_id,
        greatest(coalesce(nullif(a.covered_feet, 0), a.allocated_feet, 0), 0)::integer as usage_basis_feet,
        a.created_at,
        r.job_id,
        j.job_number
      from candidate_requirements cr
      join app.allocations a
        on a.org_id = $1
       and a.allocation_id = cr.allocation_id
      join app.job_requirements r
        on r.org_id = a.org_id
       and r.id = cr.requirement_id
      join app.jobs j
        on j.org_id = r.org_id
       and j.id = r.job_id
      order by a.created_at asc, a.allocation_id asc
    `,
    [orgId, boxId, jobId, jobNumber]
  );

  if (!allocationRows.length) {
    warnings.push(
      `Actual used LF from box ${boxId} was preserved in roll history but was not assigned to a requirement because no active requirement allocation matched the check-out job.`
    );
    return { recordedFeet: 0, requirementIds: [], warnings };
  }

  const distinctJobIds = new Set(allocationRows.map((entry) => asTrimmedString(entry.job_id)).filter(Boolean));
  if (!jobId && distinctJobIds.size > 1) {
    warnings.push(
      `Actual used LF from box ${boxId} was preserved in roll history but was not assigned to a requirement because job number ${jobNumber || 'UNKNOWN'} maps to multiple jobs.`
    );
    return { recordedFeet: 0, requirementIds: [], warnings };
  }

  const appliedByRequirementId = new Map();
  let remainingFeet = usedFeet;
  for (let index = 0; index < allocationRows.length && remainingFeet > 0; index += 1) {
    const row = allocationRows[index];
    const basisFeet = Math.max(0, integerOrZero(row.usage_basis_feet));
    const isLastRow = index === allocationRows.length - 1;
    const appliedFeet = isLastRow ? remainingFeet : Math.min(remainingFeet, basisFeet);
    if (appliedFeet <= 0) {
      continue;
    }

    const requirementId = asTrimmedString(row.requirement_id);
    appliedByRequirementId.set(
      requirementId,
      Math.max(0, Number(appliedByRequirementId.get(requirementId) || 0)) + appliedFeet
    );
    remainingFeet -= appliedFeet;
  }

  let recordedFeet = 0;
  const requirementIds = [];
  for (const [requirementId, appliedFeet] of appliedByRequirementId.entries()) {
    await client.query(
      `
        update app.job_requirements
        set actual_used_feet = greatest(coalesce(actual_used_feet, 0), 0) + $4,
            updated_at = now(),
            updated_by = $5
        where org_id = $1
          and job_id = $2
          and id = $3
      `,
      [
        orgId,
        jobId || asTrimmedString(allocationRows[0]?.job_id),
        requireUuid(requirementId, 'RequirementId'),
        Math.max(0, Math.floor(Number(appliedFeet || 0))),
        asTrimmedString(actor),
      ]
    );
    recordedFeet += Math.max(0, Math.floor(Number(appliedFeet || 0)));
    requirementIds.push(requirementId);
  }

  return { recordedFeet, requirementIds, warnings };
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

    const phaseKey = asTrimmedString(entry.phaseId) || asTrimmedString(entry.phaseNumber) || 'default';
    const mergeKey = `${phaseKey}|${productId}`;

    if (!mergedByProductId[mergeKey]) {
      mergedByProductId[mergeKey] = {
        requirementId: asTrimmedString(entry.requirementId),
        phaseId: asTrimmedString(entry.phaseId),
        phaseNumber: asTrimmedString(entry.phaseNumber),
        productId,
        requiredTubes: 0,
      };
    }

    mergedByProductId[mergeKey].requiredTubes += Math.floor(requiredTubes);
  }

  const productIds = Array.from(new Set(Object.values(mergedByProductId).map((entry) => entry.productId)));
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

  return Object.values(mergedByProductId);
}

async function replaceJobCaulkRequirementsForJob(client, orgId, jobHeader, entries, actor, nowIso) {
  const defaultPhase = await ensureDefaultJobPhase(client, orgId, jobHeader, actor, nowIso);
  const phases = await listJobPhasesByJobId(client, orgId, jobHeader.id);
  const phasesById = {};
  const phasesByNumber = {};
  for (let index = 0; index < phases.length; index += 1) {
    phasesById[asTrimmedString(phases[index].phaseId)] = phases[index];
    phasesByNumber[String(phases[index].phaseNumber)] = phases[index];
  }
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
    const requestedPhaseId = asTrimmedString(entry.phaseId);
    const requestedPhaseNumber = asTrimmedString(entry.phaseNumber);
    const phase = requestedPhaseId
      ? phasesById[requestedPhaseId]
      : requestedPhaseNumber
        ? phasesByNumber[requestedPhaseNumber]
        : defaultPhase;
    if (!phase) {
      throw new HttpError(400, 'Caulk requirement phase does not belong to this job.');
    }
    await client.query(
      `
        insert into app.job_caulk_requirements (
          id,
          org_id,
          job_id,
          phase_id,
          product_id,
          required_tubes,
          notes,
          created_at,
          created_by,
          updated_at,
          updated_by
        )
        values (
          $1,$2,$3,$4,$5,$6,$7,
          $8::timestamptz,$9,
          $10::timestamptz,$11
        )
      `,
      [
        entry.requirementId || crypto.randomUUID(),
        orgId,
        jobHeader.id,
        asTrimmedString(phase.phaseId),
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
      (entry) =>
        asTrimmedString(entry && entry.status).toUpperCase() !== 'COMPLETE' &&
        integerOrZero(entry && entry.requiredFeet) > 0
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
  listJobPhases,
  listJobPhasesByJobId,
  findJobPhaseById,
  saveJobPhaseRecord,
  ensureDefaultJobPhase,
  replaceJobPhasesForJob,
  setJobPhaseLaborState,
  listJobRequirements,
  listJobRequirementsByJob,
  listJobRequirementsByJobId,
  findJobRequirementByIdForJob,
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
  setJobRequirementState,
  recordRequirementActualUsageForCheckin,
  normalizeJobCaulkRequirementEntries,
  replaceJobCaulkRequirementsForJob,
  parseExplicitJobLaborOnlyValue,
  hasJobMaterialRequirements,
  derivePersistedJobMaterialFlags,
  deleteJobRequirementsByJobId,
  deleteJobRecord,
  deleteJobRecordById,
};

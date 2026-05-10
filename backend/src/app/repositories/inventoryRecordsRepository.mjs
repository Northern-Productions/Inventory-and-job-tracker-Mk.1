import { queryRow, queryRows } from '../../db/client.mjs';
import {
  asTrimmedString,
  createLogId,
  integerOrZero,
  normalizeAllocationKind,
  normalizeAllocationSource,
} from '../core/helpers.mjs';
import {
  normalizeCatalogWriteFilmKeyInput,
  normalizeCatalogWriteManufacturerAndFilm,
  resolveCatalogWriteFilmEntry,
} from '../core/catalog.mjs';
import { resolveBoxIdAlias } from './boxesRepository.mjs';
import {
  mapDbAllocationRow,
  mapDbFilmCatalogRow,
  mapDbFilmOrderLinkRow,
  mapDbFilmOrderRow,
} from './mappers.mjs';

async function listFilmCatalog(client, orgId) {
  const rows = await queryRows(
    client,
    `
      select *
      from app.film_catalog
      where org_id = $1
      order by manufacturer asc, film_name asc, film_key asc
    `,
    [orgId]
  );

  return rows.map(mapDbFilmCatalogRow);
}

async function findFilmCatalogByFilmKey(client, orgId, filmKey) {
  const row = await queryRow(
    client,
    `
      select *
      from app.film_catalog
      where org_id = $1
        and film_key = $2
    `,
    [orgId, filmKey]
  );

  return mapDbFilmCatalogRow(row);
}

async function seedFilmCatalogRecordIfMissing(client, orgId, record) {
  const normalized = normalizeCatalogWriteManufacturerAndFilm(record.manufacturer, record.filmName);
  const normalizedManufacturer = normalized.manufacturer;
  const normalizedFilmName = normalized.filmName;
  const normalizedFilmKey = normalizeCatalogWriteFilmKeyInput(
    normalizedManufacturer,
    normalizedFilmName,
    record.filmKey
  );
  const normalizedSourceBoxId = asTrimmedString(record.sourceBoxId);

  if (!normalizedFilmKey || !normalizedManufacturer || !normalizedFilmName) {
    return;
  }

  await client.query(
    `
      insert into app.film_catalog (
        org_id,
        film_key,
        manufacturer,
        film_name,
        source_box_id,
        notes,
        updated_at
      )
      values ($1,$2,$3,$4,$5,'', now())
      on conflict (org_id, film_key) do nothing
    `,
    [orgId, normalizedFilmKey, normalizedManufacturer, normalizedFilmName, normalizedSourceBoxId]
  );
}

async function upsertFilmCatalogRecord(client, orgId, record) {
  const canonical = await resolveCatalogWriteFilmEntry(client, orgId, record.manufacturer, record.filmName);
  const manufacturer = canonical.manufacturer;
  const filmName = canonical.filmName;
  const filmKey = normalizeCatalogWriteFilmKeyInput(manufacturer, filmName, record.filmKey);
  const row = await queryRow(
    client,
    `
      insert into app.film_catalog (
        org_id,
        film_key,
        manufacturer,
        film_name,
        sq_ft_weight_lbs_per_sq_ft,
        default_core_type,
        source_width_in,
        source_initial_feet,
        source_initial_weight_lbs,
        source_box_id,
        notes,
        updated_at
      )
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, coalesce($12::timestamptz, now()))
      on conflict (org_id, film_key) do update set
        manufacturer = excluded.manufacturer,
        film_name = excluded.film_name,
        sq_ft_weight_lbs_per_sq_ft = excluded.sq_ft_weight_lbs_per_sq_ft,
        default_core_type = excluded.default_core_type,
        source_width_in = excluded.source_width_in,
        source_initial_feet = excluded.source_initial_feet,
        source_initial_weight_lbs = excluded.source_initial_weight_lbs,
        source_box_id = excluded.source_box_id,
        notes = excluded.notes,
        updated_at = excluded.updated_at
      returning *
    `,
    [
      orgId,
      filmKey,
      manufacturer,
      filmName,
      record.sqFtWeightLbsPerSqFt,
      record.defaultCoreType,
      record.sourceWidthIn,
      record.sourceInitialFeet,
      record.sourceInitialWeightLbs,
      record.sourceBoxId,
      record.notes,
      record.updatedAt || new Date().toISOString(),
    ]
  );

  return mapDbFilmCatalogRow(row);
}

async function listAllocations(client, orgId) {
  const rows = await queryRows(
    client,
    `
      select *
      from app.allocations
      where org_id = $1
      order by created_at desc, allocation_id desc
    `,
    [orgId]
  );

  return rows.map(mapDbAllocationRow);
}

async function listAllocationsByJob(client, orgId, jobNumber) {
  const rows = await queryRows(
    client,
    `
      select *
      from app.allocations
      where org_id = $1
        and upper(trim(job_number)) = upper(trim($2))
      order by created_at desc, allocation_id desc
    `,
    [orgId, jobNumber]
  );

  return rows.map(mapDbAllocationRow);
}

async function listAllocationsByJobId(client, orgId, jobId) {
  const rows = await queryRows(
    client,
    `
      select *
      from app.allocations
      where org_id = $1
        and job_id = $2
      order by created_at desc, allocation_id desc
    `,
    [orgId, jobId]
  );

  return rows.map(mapDbAllocationRow);
}

async function listAllocationsByFilmOrderId(client, orgId, filmOrderId) {
  const rows = await queryRows(
    client,
    `
      select *
      from app.allocations
      where org_id = $1
        and film_order_id = $2
      order by created_at desc, allocation_id desc
    `,
    [orgId, filmOrderId]
  );

  return rows.map(mapDbAllocationRow);
}

async function listActiveAllocations(client, orgId) {
  const rows = await queryRows(
    client,
    `
      select *
      from app.allocations
      where org_id = $1
        and status = 'ACTIVE'
      order by created_at desc, allocation_id desc
    `,
    [orgId]
  );

  return rows.map(mapDbAllocationRow);
}

async function listManualRequirementAllocationMergeCandidates(client, orgId, entry) {
  const normalizedRequirementId = asTrimmedString(entry?.requirementId);
  const normalizedBoxId = asTrimmedString(entry?.boxId);
  const normalizedJobNumber = asTrimmedString(entry?.jobNumber);
  if (!normalizedRequirementId || !normalizedBoxId || !normalizedJobNumber) {
    return [];
  }

  const rows = await queryRows(
    client,
    `
      select *
      from app.allocations
      where org_id = $1
        and box_id = $2
        and status = 'ACTIVE'
        and coalesce(allocation_kind::text, 'REQUIREMENT') = 'REQUIREMENT'
        and requirement_id = $3::uuid
        and coalesce(film_order_id, '') = coalesce($6::text, '')
        and coalesce(allocation_source::text, 'MANUAL') in ('MANUAL', 'AUTO_PLANNED')
        and case
          when $4::uuid is not null and job_id is not null then job_id = $4::uuid
          else upper(trim(coalesce(job_number, ''))) = upper(trim($5::text))
        end
      order by
        case coalesce(allocation_source::text, 'MANUAL')
          when 'MANUAL' then 0
          when 'AUTO_PLANNED' then 1
          else 2
        end,
        created_at asc,
        allocation_id asc
      for update
    `,
    [
      orgId,
      normalizedBoxId,
      normalizedRequirementId,
      entry?.jobId || null,
      normalizedJobNumber,
      asTrimmedString(entry?.filmOrderId),
    ]
  );

  return rows.map(mapDbAllocationRow);
}

async function listActiveAllocationsForJobConflictCheck(
  client,
  orgId,
  boxIds,
  installDate,
  jobNumber,
  crewLeader
) {
  const normalizedBoxIds = Array.from(
    new Set(
      (Array.isArray(boxIds) ? boxIds : [])
        .map((entry) => asTrimmedString(entry).toUpperCase())
        .filter(Boolean)
    )
  );
  const normalizedInstallDate = asTrimmedString(installDate);
  if (!normalizedBoxIds.length || !normalizedInstallDate) {
    return [];
  }

  const rows = await queryRows(
    client,
    `
      select *
      from app.allocations
      where org_id = $1
        and status = 'ACTIVE'
        and box_id = any($2::text[])
        and job_date = $3::date
        and upper(trim(coalesce(job_number, ''))) <> upper(trim($4))
        and upper(trim(coalesce(crew_leader, ''))) <> upper(trim($5))
      order by created_at desc, allocation_id desc
    `,
    [orgId, normalizedBoxIds, normalizedInstallDate, asTrimmedString(jobNumber), asTrimmedString(crewLeader)]
  );

  return rows.map(mapDbAllocationRow);
}

async function listActiveAllocationsForJobIdConflictCheck(
  client,
  orgId,
  boxIds,
  installDate,
  jobId,
  crewLeader
) {
  const normalizedBoxIds = Array.from(
    new Set(
      (Array.isArray(boxIds) ? boxIds : [])
        .map((entry) => asTrimmedString(entry).toUpperCase())
        .filter(Boolean)
    )
  );
  const normalizedInstallDate = asTrimmedString(installDate);
  if (!normalizedBoxIds.length || !normalizedInstallDate) {
    return [];
  }

  const rows = await queryRows(
    client,
    `
      select *
      from app.allocations
      where org_id = $1
        and status = 'ACTIVE'
        and box_id = any($2::text[])
        and job_date = $3::date
        and (job_id is null or job_id <> $4::uuid)
        and upper(trim(coalesce(crew_leader, ''))) <> upper(trim($5))
      order by created_at desc, allocation_id desc
    `,
    [orgId, normalizedBoxIds, normalizedInstallDate, jobId, asTrimmedString(crewLeader)]
  );

  return rows.map(mapDbAllocationRow);
}

async function saveAllocationRecord(client, orgId, entry) {
  const row = await queryRow(
    client,
    `
      insert into app.allocations (
        org_id,
        allocation_id,
        box_id,
        job_id,
        job_number,
        warehouse,
        job_date,
        allocated_feet,
        covered_feet,
        requirement_id,
        status,
        created_at,
        created_by,
        resolved_at,
        resolved_by,
        notes,
        crew_leader,
        film_order_id,
        allocation_kind,
        allocation_source
      )
      values (
        $1,$2,$3,$4,$5,$6,
        nullif($7, '')::date,
        $8,$9,
        nullif($10, '')::uuid,
        $11,
        coalesce($12::timestamptz, now()),
        $13,
        nullif($14, '')::timestamptz,
        $15,$16,$17,$18,$19,$20
      )
      on conflict (org_id, allocation_id) do update set
        box_id = excluded.box_id,
        job_id = excluded.job_id,
        job_number = excluded.job_number,
        warehouse = excluded.warehouse,
        job_date = excluded.job_date,
        allocated_feet = excluded.allocated_feet,
        covered_feet = excluded.covered_feet,
        requirement_id = excluded.requirement_id,
        status = excluded.status,
        created_at = excluded.created_at,
        created_by = excluded.created_by,
        resolved_at = excluded.resolved_at,
        resolved_by = excluded.resolved_by,
        notes = excluded.notes,
        crew_leader = excluded.crew_leader,
        film_order_id = excluded.film_order_id,
        allocation_kind = excluded.allocation_kind,
        allocation_source = excluded.allocation_source
      returning *
    `,
    [
      orgId,
      entry.allocationId,
      entry.boxId,
      entry.jobId,
      entry.jobNumber,
      entry.warehouse,
      entry.installDate,
      entry.allocatedFeet,
      integerOrZero(entry.coveredFeet) || entry.allocatedFeet,
      asTrimmedString(entry.requirementId),
      entry.status,
      entry.createdAt,
      entry.createdBy,
      entry.resolvedAt,
      entry.resolvedBy,
      entry.notes,
      entry.crewLeader,
      entry.filmOrderId,
      normalizeAllocationKind(entry.allocationKind),
      normalizeAllocationSource(entry.allocationSource),
    ]
  );

  if (row?.status === 'ACTIVE') {
    await queryRow(
      client,
      `
        select app_api.assert_film_box_allocation_capacity($1::uuid, $2::text, $3::text) as ok
      `,
      [orgId, row.box_id, row.allocation_id]
    );
  }

  return mapDbAllocationRow(row);
}

async function listFilmOrders(client, orgId) {
  const rows = await queryRows(
    client,
    `
      select *
      from app.film_orders
      where org_id = $1
      order by created_at desc, film_order_id desc
    `,
    [orgId]
  );

  return rows.map(mapDbFilmOrderRow);
}

async function listFilmOrdersByJob(client, orgId, jobNumber) {
  const rows = await queryRows(
    client,
    `
      select *
      from app.film_orders
      where org_id = $1
        and upper(trim(job_number)) = upper(trim($2))
      order by created_at desc, film_order_id desc
    `,
    [orgId, jobNumber]
  );

  return rows.map(mapDbFilmOrderRow);
}

async function listFilmOrdersByJobId(client, orgId, jobId) {
  const rows = await queryRows(
    client,
    `
      select *
      from app.film_orders
      where org_id = $1
        and job_id = $2
      order by created_at desc, film_order_id desc
    `,
    [orgId, jobId]
  );

  return rows.map(mapDbFilmOrderRow);
}

async function findFilmOrderById(client, orgId, filmOrderId) {
  const row = await queryRow(
    client,
    `
      select *
      from app.film_orders
      where org_id = $1
        and film_order_id = $2
    `,
    [orgId, filmOrderId]
  );

  return mapDbFilmOrderRow(row);
}

async function saveFilmOrderRecord(client, orgId, entry) {
  const canonical = await resolveCatalogWriteFilmEntry(client, orgId, entry.manufacturer, entry.filmName);
  const manufacturer = canonical.manufacturer;
  const filmName = canonical.filmName;
  const filmOrderId = asTrimmedString(entry.filmOrderId) || createLogId();
  const row = await queryRow(
    client,
    `
      insert into app.film_orders (
        org_id,
        film_order_id,
        requirement_id,
        job_id,
        job_number,
        warehouse,
        manufacturer,
        film_name,
        width_in,
        requested_feet,
        covered_feet,
        ordered_feet,
        remaining_to_order_feet,
        job_date,
        crew_leader,
        status,
        source_box_id,
        resolved_at,
        resolved_by,
        notes,
        created_at,
        created_by
      )
      values (
        $1,$2,nullif($3, '')::uuid,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
        nullif($14, '')::date,
        $15,$16,$17,
        nullif($18, '')::timestamptz,
        $19,$20,
        coalesce($21::timestamptz, now()),
        $22
      )
      on conflict (org_id, film_order_id) do update set
        requirement_id = excluded.requirement_id,
        job_id = excluded.job_id,
        job_number = excluded.job_number,
        warehouse = excluded.warehouse,
        manufacturer = excluded.manufacturer,
        film_name = excluded.film_name,
        width_in = excluded.width_in,
        requested_feet = excluded.requested_feet,
        covered_feet = excluded.covered_feet,
        ordered_feet = excluded.ordered_feet,
        remaining_to_order_feet = excluded.remaining_to_order_feet,
        job_date = excluded.job_date,
        crew_leader = excluded.crew_leader,
        status = excluded.status,
        source_box_id = excluded.source_box_id,
        resolved_at = excluded.resolved_at,
        resolved_by = excluded.resolved_by,
        notes = excluded.notes,
        created_at = excluded.created_at,
        created_by = excluded.created_by
      returning *
    `,
    [
      orgId,
      filmOrderId,
      asTrimmedString(entry.requirementId),
      entry.jobId,
      entry.jobNumber,
      entry.warehouse,
      manufacturer,
      filmName,
      entry.widthIn,
      entry.requestedFeet,
      entry.coveredFeet,
      entry.orderedFeet,
      entry.remainingToOrderFeet,
      entry.installDate,
      entry.crewLeader,
      entry.status,
      entry.sourceBoxId,
      entry.resolvedAt,
      entry.resolvedBy,
      entry.notes,
      entry.createdAt,
      entry.createdBy,
    ]
  );

  return mapDbFilmOrderRow(row);
}

async function reconcileBoxCheckinAllocations(client, orgId, entry, actor) {
  const row = await queryRow(
    client,
    `
      select app_api.reconcile_box_checkin_allocations(
        $1::uuid,
        $2::text,
        $3::text,
        $4::integer
      ) as result
    `,
    [
      orgId,
      asTrimmedString(actor),
      asTrimmedString(entry?.boxId),
      integerOrZero(entry?.physicalFeetAfter),
    ]
  );

  return row?.result || {
    warnings: [],
    affectedJobNumbers: [],
    reducedAllocationIds: [],
    cancelledAllocationIds: [],
    updatedFilmOrderIds: [],
    feetAvailable: Math.max(0, integerOrZero(entry?.physicalFeetAfter)),
  };
}

async function deleteFilmOrderRecord(client, orgId, filmOrderId) {
  await client.query(
    `
      delete from app.film_orders
      where org_id = $1
        and film_order_id = $2
    `,
    [orgId, filmOrderId]
  );
}

async function listFilmOrderLinks(client, orgId) {
  const rows = await queryRows(
    client,
    `
      select *
      from app.film_order_box_links
      where org_id = $1
      order by created_at desc, link_id desc
    `,
    [orgId]
  );

  return rows.map(mapDbFilmOrderLinkRow);
}

async function listFilmOrderLinksByFilmOrderId(client, orgId, filmOrderId) {
  const rows = await queryRows(
    client,
    `
      select *
      from app.film_order_box_links
      where org_id = $1
        and film_order_id = $2
      order by created_at desc, link_id desc
    `,
    [orgId, filmOrderId]
  );

  return rows.map(mapDbFilmOrderLinkRow);
}

async function listFilmOrderLinksByFilmOrderIds(client, orgId, filmOrderIds) {
  const normalizedFilmOrderIds = Array.from(
    new Set(
      (Array.isArray(filmOrderIds) ? filmOrderIds : [])
        .map((entry) => asTrimmedString(entry))
        .filter(Boolean)
    )
  );
  if (normalizedFilmOrderIds.length === 0) {
    return [];
  }

  const rows = await queryRows(
    client,
    `
      select *
      from app.film_order_box_links
      where org_id = $1
        and film_order_id = any($2::text[])
      order by created_at desc, link_id desc
    `,
    [orgId, normalizedFilmOrderIds]
  );

  return rows.map(mapDbFilmOrderLinkRow);
}

async function listFilmOrderLinksByBoxId(client, orgId, boxId) {
  const canonicalBoxId = await resolveBoxIdAlias(client, orgId, boxId);
  const rows = await queryRows(
    client,
    `
      select *
      from app.film_order_box_links
      where org_id = $1
        and box_id = $2
      order by created_at desc, link_id desc
    `,
    [orgId, canonicalBoxId]
  );

  return rows.map(mapDbFilmOrderLinkRow);
}

async function saveFilmOrderLinkRecord(client, orgId, link) {
  const row = await queryRow(
    client,
    `
      insert into app.film_order_box_links (
        org_id,
        link_id,
        film_order_id,
        box_id,
        ordered_feet,
        auto_allocated_feet,
        created_at,
        created_by
      )
      values ($1,$2,$3,$4,$5,$6,coalesce($7::timestamptz, now()),$8)
      on conflict (org_id, link_id) do update set
        film_order_id = excluded.film_order_id,
        box_id = excluded.box_id,
        ordered_feet = excluded.ordered_feet,
        auto_allocated_feet = excluded.auto_allocated_feet,
        created_at = excluded.created_at,
        created_by = excluded.created_by
      returning *
    `,
    [
      orgId,
      link.linkId,
      link.filmOrderId,
      link.boxId,
      link.orderedFeet,
      link.autoAllocatedFeet,
      link.createdAt,
      link.createdBy,
    ]
  );

  return mapDbFilmOrderLinkRow(row);
}

async function deleteFilmOrderLinksByFilmOrderId(client, orgId, filmOrderId) {
  await client.query(
    `
      delete from app.film_order_box_links
      where org_id = $1
        and film_order_id = $2
    `,
    [orgId, filmOrderId]
  );
}

export {
  listFilmCatalog,
  findFilmCatalogByFilmKey,
  seedFilmCatalogRecordIfMissing,
  upsertFilmCatalogRecord,
  listAllocations,
  listAllocationsByJob,
  listAllocationsByJobId,
  listAllocationsByFilmOrderId,
  listActiveAllocations,
  listManualRequirementAllocationMergeCandidates,
  listActiveAllocationsForJobConflictCheck,
  listActiveAllocationsForJobIdConflictCheck,
  saveAllocationRecord,
  listFilmOrders,
  listFilmOrdersByJob,
  listFilmOrdersByJobId,
  findFilmOrderById,
  saveFilmOrderRecord,
  reconcileBoxCheckinAllocations,
  deleteFilmOrderRecord,
  listFilmOrderLinks,
  listFilmOrderLinksByFilmOrderId,
  listFilmOrderLinksByFilmOrderIds,
  listFilmOrderLinksByBoxId,
  saveFilmOrderLinkRecord,
  deleteFilmOrderLinksByFilmOrderId,
};

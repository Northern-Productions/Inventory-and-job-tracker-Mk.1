import { queryRow, queryRows } from '../../db/client.mjs';
import { HttpError } from '../../lib/http.mjs';
import { buildTransferredBoxId as buildSharedTransferredBoxId } from '../../../../shared/domain/boxTransferPlanner.mjs';
import {
  asTrimmedString,
  assertLegalBoxWeightState,
  integerOrZero,
  normalizeWarehouseCodeFormat,
  requireString,
} from '../core/helpers.mjs';
import {
  normalizeCatalogWriteFilmKeyInput,
  resolveCatalogWriteFilmEntry,
} from '../core/catalog.mjs';
import {
  mapDbAllocationRow,
  mapDbBoxRow,
  mapDbBoxTransferRow,
} from './mappers.mjs';

async function listWarehouseCodes(client, orgId) {
  const rows = await queryRows(
    client,
    `
      select code
      from app.warehouses
      where org_id = $1
      order by code
    `,
    [orgId]
  );

  return rows
    .map((row) => asTrimmedString(row.code).toUpperCase())
    .filter((code) => code.length > 0);
}

async function listWarehouseBoxIdPrefixes(client, orgId) {
  const rows = await queryRows(
    client,
    `
      select
        code,
        box_id_prefix
      from app.warehouses
      where org_id = $1
      order by code
    `,
    [orgId]
  );

  return rows
    .map((row) =>
      normalizeWarehouseCodeFormat(
        asTrimmedString(row.box_id_prefix) || asTrimmedString(row.code),
        'BoxID prefix'
      )
    )
    .filter((prefix) => prefix.length > 0);
}

async function requireConfiguredWarehouse(client, orgId, warehouse, fieldName) {
  const normalized = normalizeWarehouseCodeFormat(warehouse, fieldName || 'Warehouse');
  const configured = await listWarehouseCodes(client, orgId);
  if (!configured.includes(normalized)) {
    throw new HttpError(400, `${fieldName || 'Warehouse'} is not configured.`);
  }
  return normalized;
}

async function findWarehouseEntry(client, orgId, warehouseCode, fieldName = 'Warehouse') {
  const normalizedCode = await requireConfiguredWarehouse(client, orgId, warehouseCode, fieldName);
  const row = await queryRow(
    client,
    `
      select
        code,
        name,
        box_id_prefix
      from app.warehouses
      where org_id = $1
        and code = $2
    `,
    [orgId, normalizedCode]
  );

  if (!row) {
    throw new HttpError(400, `${fieldName} is not configured.`);
  }

  return {
    code: asTrimmedString(row.code).toUpperCase(),
    name: asTrimmedString(row.name),
    boxIdPrefix: asTrimmedString(row.box_id_prefix).toUpperCase(),
  };
}

function getBoxIdPrefixToken(prefix) {
  const normalizedPrefix = normalizeWarehouseCodeFormat(prefix, 'BoxID prefix');
  return `${normalizedPrefix.replace(/-+$/g, '')}-`;
}

function getTransferredBoxIdSuffix(boxId, sourcePrefix) {
  const normalizedBoxId = requireString(boxId, 'BoxID').toUpperCase();
  const sourcePrefixToken = getBoxIdPrefixToken(sourcePrefix);
  if (normalizedBoxId.startsWith(sourcePrefixToken)) {
    return normalizedBoxId.slice(sourcePrefixToken.length);
  }

  const prefixedMatch = normalizedBoxId.match(/^[A-Z0-9]+-(.+)$/);
  if (prefixedMatch?.[1]) {
    return prefixedMatch[1];
  }

  return normalizedBoxId;
}

function buildTransferredBoxId(boxId, sourcePrefix, destinationPrefix, warehousePrefixes = []) {
  return buildSharedTransferredBoxId(boxId, sourcePrefix, destinationPrefix, warehousePrefixes);
}

async function resolveBoxIdAlias(client, orgId, boxId) {
  const trimmed = requireString(boxId, 'BoxID').toUpperCase();
  const row = await queryRow(
    client,
    `
      select app_api.resolve_box_id_alias($1::uuid, $2::text) as box_id
    `,
    [orgId, trimmed]
  );
  return asTrimmedString(row?.box_id) || trimmed;
}

async function resolveWarehouseFromBoxId(client, orgId, boxId) {
  const normalizedBoxId = requireString(boxId, 'BoxID').toUpperCase();
  const row = await queryRow(
    client,
    `
      select app_api.resolve_warehouse_from_box_id($1::uuid, $2::text) as warehouse
    `,
    [orgId, normalizedBoxId]
  );
  const resolved = asTrimmedString(row?.warehouse).toUpperCase();
  if (!resolved) {
    throw new HttpError(400, 'Unable to resolve warehouse from BoxID.');
  }
  return resolved;
}

function buildBoxSelectColumns(alias) {
  return `
    ${alias}.*,
    coalesce(active_allocations.active_allocated_feet, 0)::integer as active_allocated_feet,
    app_api.box_physical_feet_available(${alias})::integer as physical_feet_available,
    app_api.box_allocatable_now_feet(${alias})::integer as allocatable_now_feet,
    app_api.box_allocatable_now_feet(${alias})::integer as allocation_planning_feet
  `;
}

function buildReservationAllocationLateral(boxAlias) {
  return `
      left join lateral (
        select coalesce(sum(a.allocated_feet), 0)::integer as active_allocated_feet
        from app.allocations a
        where a.org_id = ${boxAlias}.org_id
          and a.box_id = ${boxAlias}.box_id
          and coalesce(a.allocation_kind::text, 'REQUIREMENT') = 'REQUIREMENT'
          and a.requirement_id is not null
          and coalesce(a.allocated_feet, 0) > 0
          and (
            (
              a.status = 'ACTIVE'
              and (
                a.job_date is not null
                or upper(coalesce(${boxAlias}.status::text, '')) = 'CHECKED_OUT'
              )
            )
            or (
              a.status = 'FULFILLED'
              and upper(coalesce(${boxAlias}.status::text, '')) = 'CHECKED_OUT'
              and app_api.trim_text(a.job_number) <> ''
            )
          )
      ) active_allocations on true
  `;
}

async function listBoxes(client, orgId) {
  const rows = await queryRows(
    client,
    `
      select ${buildBoxSelectColumns('b')}
      from app.boxes b
      ${buildReservationAllocationLateral('b')}
      where b.org_id = $1
    `,
    [orgId]
  );

  return rows.map(mapDbBoxRow);
}

async function listBoxesByWarehouses(client, orgId, warehouses) {
  const normalizedWarehouses = Array.from(
    new Set(
      (Array.isArray(warehouses) ? warehouses : [])
        .map((entry) => asTrimmedString(entry).toUpperCase())
        .filter(Boolean)
    )
  );
  if (normalizedWarehouses.length === 0) {
    return [];
  }

  const rows = await queryRows(
    client,
    `
      select ${buildBoxSelectColumns('b')}
      from app.boxes b
      ${buildReservationAllocationLateral('b')}
      where b.org_id = $1
        and b.warehouse = any($2::text[])
      order by b.box_id
    `,
    [orgId, normalizedWarehouses]
  );

  return rows.map(mapDbBoxRow);
}

async function listBoxesByIds(client, orgId, boxIds) {
  const normalizedBoxIds = Array.from(
    new Set(
      (Array.isArray(boxIds) ? boxIds : [])
        .map((entry) => asTrimmedString(entry).toUpperCase())
        .filter(Boolean)
    )
  );
  if (normalizedBoxIds.length === 0) {
    return [];
  }

  const rows = await queryRows(
    client,
    `
      select ${buildBoxSelectColumns('b')}
      from app.boxes b
      ${buildReservationAllocationLateral('b')}
      where b.org_id = $1
        and b.box_id = any($2::text[])
    `,
    [orgId, normalizedBoxIds]
  );

  return rows.map(mapDbBoxRow);
}

async function findBoxById(client, orgId, boxId) {
  const canonicalBoxId = await resolveBoxIdAlias(client, orgId, boxId);
  const row = await queryRow(
    client,
    `
      select ${buildBoxSelectColumns('b')}
      from app.boxes b
      ${buildReservationAllocationLateral('b')}
      where b.org_id = $1
        and b.box_id = $2
    `,
    [orgId, canonicalBoxId]
  );

  return mapDbBoxRow(row);
}

async function saveBoxRecord(client, orgId, box) {
  assertLegalBoxWeightState(box);

  const canonical = await resolveCatalogWriteFilmEntry(client, orgId, box.manufacturer, box.filmName);
  const manufacturer = canonical.manufacturer;
  const filmName = canonical.filmName;
  const filmKey = normalizeCatalogWriteFilmKeyInput(manufacturer, filmName, box.filmKey);
  const dealer = asTrimmedString(box.dealer);

  if (dealer) {
    await queryRow(
      client,
      `
        insert into app.box_dealers (
          org_id,
          name,
          lookup_key
        )
        values (
          $1::uuid,
          $2::text,
          app_api.normalize_catalog_lookup_key($2::text)
        )
        on conflict (org_id, lookup_key) do update set
          name = excluded.name,
          updated_at = timezone('utc', now())
        returning id
      `,
      [orgId, dealer]
    );
  }

  const row = await queryRow(
    client,
    `
      with saved_box as (
        insert into app.boxes (
          org_id,
          box_id,
          warehouse,
          dealer,
          manufacturer,
          film_name,
          width_in,
          initial_feet,
          feet_available,
          lot_run,
          status,
          order_date,
          received_date,
          initial_weight_lbs,
          last_roll_weight_lbs,
          last_weighed_date,
          film_key,
          core_type,
          core_weight_lbs,
          lf_weight_lbs_per_ft,
          price_per_lf,
          purchase_cost,
          notes,
          direct_to_job_site,
          has_ever_been_checked_out,
          last_checkout_job,
          last_checkout_date,
          zeroed_date,
          zeroed_reason,
          zeroed_by
        )
        values (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
          nullif($13, '')::date,
          $14,$15,
          nullif($16, '')::date,
          $17,$18,$19,$20,$21,$22,$23,$24,$25,
          $26,
          nullif($27, '')::date,
          nullif($28, '')::date,
          $29,$30
        )
        on conflict (org_id, box_id) do update set
          warehouse = excluded.warehouse,
          dealer = excluded.dealer,
          manufacturer = excluded.manufacturer,
          film_name = excluded.film_name,
          width_in = excluded.width_in,
          initial_feet = excluded.initial_feet,
          feet_available = excluded.feet_available,
          lot_run = excluded.lot_run,
          status = excluded.status,
          order_date = excluded.order_date,
          received_date = excluded.received_date,
          initial_weight_lbs = excluded.initial_weight_lbs,
          last_roll_weight_lbs = excluded.last_roll_weight_lbs,
          last_weighed_date = excluded.last_weighed_date,
          film_key = excluded.film_key,
          core_type = excluded.core_type,
          core_weight_lbs = excluded.core_weight_lbs,
          lf_weight_lbs_per_ft = excluded.lf_weight_lbs_per_ft,
          price_per_lf = excluded.price_per_lf,
          purchase_cost = excluded.purchase_cost,
          notes = excluded.notes,
          direct_to_job_site = excluded.direct_to_job_site,
          has_ever_been_checked_out = excluded.has_ever_been_checked_out,
          last_checkout_job = excluded.last_checkout_job,
          last_checkout_date = excluded.last_checkout_date,
          zeroed_date = excluded.zeroed_date,
          zeroed_reason = excluded.zeroed_reason,
          zeroed_by = excluded.zeroed_by
        returning *
      )
      select ${buildBoxSelectColumns('saved_box')}
      from saved_box
      ${buildReservationAllocationLateral('saved_box')}
    `,
    [
      orgId,
      box.boxId,
      box.warehouse,
      dealer,
      manufacturer,
      filmName,
      box.widthIn,
      box.initialFeet,
      box.feetAvailable,
      box.lotRun,
      box.status,
      box.orderDate,
      box.receivedDate,
      box.initialWeightLbs,
      box.lastRollWeightLbs,
      box.lastWeighedDate,
      filmKey,
      box.coreType,
      box.coreWeightLbs,
      box.lfWeightLbsPerFt,
      box.pricePerLf,
      box.purchaseCost,
      box.notes,
      box.directToJobSite === true,
      box.hasEverBeenCheckedOut,
      box.lastCheckoutJob,
      box.lastCheckoutDate,
      box.zeroedDate,
      box.zeroedReason,
      box.zeroedBy,
    ]
  );

  return mapDbBoxRow(row);
}

async function findBoxByRecordId(client, orgId, boxRecordId) {
  if (!boxRecordId) {
    return null;
  }

  const row = await queryRow(
    client,
    `
      select ${buildBoxSelectColumns('b')}
      from app.boxes b
      ${buildReservationAllocationLateral('b')}
      where b.org_id = $1
        and b.id = $2::uuid
    `,
    [orgId, boxRecordId]
  );

  return mapDbBoxRow(row);
}

async function findBoxTransferByTransferId(client, orgId, transferId) {
  const normalizedTransferId = requireString(transferId, 'TransferID').toUpperCase();
  const row = await queryRow(
    client,
    `
      select *
      from app.box_transfers
      where org_id = $1
        and transfer_id = $2
    `,
    [orgId, normalizedTransferId]
  );

  return mapDbBoxTransferRow(row);
}

async function listBoxTransfersByBoxRecordId(client, orgId, boxRecordId) {
  if (!boxRecordId) {
    return [];
  }

  const rows = await queryRows(
    client,
    `
      select *
      from app.box_transfers
      where org_id = $1
        and box_record_id = $2
      order by created_at desc, id desc
    `,
    [orgId, boxRecordId]
  );

  return rows.map(mapDbBoxTransferRow);
}

async function getLatestBoxTransferByBoxId(client, orgId, boxId) {
  const box = await findBoxById(client, orgId, boxId);
  if (!box) {
    return { box: null, transfer: null };
  }

  const transfers = await listBoxTransfersByBoxRecordId(client, orgId, box.id);
  return {
    box,
    transfer: transfers[0] || null,
  };
}

async function findPendingBoxTransferByBoxRecordId(client, orgId, boxRecordId) {
  if (!boxRecordId) {
    return null;
  }

  const row = await queryRow(
    client,
    `
      select *
      from app.box_transfers
      where org_id = $1
        and box_record_id = $2
        and status = 'PENDING'
      order by created_at desc, id desc
      limit 1
    `,
    [orgId, boxRecordId]
  );

  return mapDbBoxTransferRow(row);
}

async function findPendingBoxTransferByDestinationBoxId(client, orgId, destinationBoxId) {
  const normalizedDestinationBoxId = requireString(destinationBoxId, 'DestinationBoxID').toUpperCase();
  const row = await queryRow(
    client,
    `
      select *
      from app.box_transfers
      where org_id = $1
        and status = 'PENDING'
        and destination_box_id = $2
      order by created_at desc, id desc
      limit 1
    `,
    [orgId, normalizedDestinationBoxId]
  );

  return mapDbBoxTransferRow(row);
}

async function listPendingBoxTransfersByBoxRecordIds(client, orgId, boxRecordIds) {
  const normalizedIds = Array.from(new Set((Array.isArray(boxRecordIds) ? boxRecordIds : []).filter(Boolean)));
  if (normalizedIds.length === 0) {
    return [];
  }

  const rows = await queryRows(
    client,
    `
      select *
      from app.box_transfers
      where org_id = $1
        and status = 'PENDING'
        and box_record_id = any($2::uuid[])
      order by created_at desc, id desc
    `,
    [orgId, normalizedIds]
  );

  return rows.map(mapDbBoxTransferRow);
}

function indexPendingBoxTransfersByBoxRecordId(transfers) {
  const indexed = {};
  const entries = Array.isArray(transfers) ? transfers : [];
  for (let index = 0; index < entries.length; index += 1) {
    const transfer = entries[index];
    if (!transfer?.boxRecordId || indexed[transfer.boxRecordId]) {
      continue;
    }
    indexed[transfer.boxRecordId] = transfer;
  }
  return indexed;
}

async function saveBoxTransferRecord(client, orgId, transfer) {
  const row = await queryRow(
    client,
    `
      insert into app.box_transfers (
        org_id,
        transfer_id,
        box_record_id,
        source_box_id,
        destination_box_id,
        source_warehouse,
        destination_warehouse,
        status,
        notes,
        created_at,
        created_by,
        received_at,
        received_by,
        cancelled_at,
        cancelled_by,
        updated_at,
        updated_by
      )
      values (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,
        $10::timestamptz,$11,
        nullif($12, '')::timestamptz,$13,
        nullif($14, '')::timestamptz,$15,
        $16::timestamptz,$17
      )
      on conflict (org_id, transfer_id) do update set
        destination_box_id = excluded.destination_box_id,
        status = excluded.status,
        notes = excluded.notes,
        received_at = excluded.received_at,
        received_by = excluded.received_by,
        cancelled_at = excluded.cancelled_at,
        cancelled_by = excluded.cancelled_by,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
      returning *
    `,
    [
      orgId,
      requireString(transfer.transferId, 'TransferID').toUpperCase(),
      transfer.boxRecordId,
      requireString(transfer.sourceBoxId, 'SourceBoxID').toUpperCase(),
      requireString(transfer.destinationBoxId, 'DestinationBoxID').toUpperCase(),
      normalizeWarehouseCodeFormat(transfer.sourceWarehouse, 'SourceWarehouse'),
      normalizeWarehouseCodeFormat(transfer.destinationWarehouse, 'DestinationWarehouse'),
      requireString(transfer.status, 'TransferStatus').toUpperCase(),
      asTrimmedString(transfer.notes),
      transfer.createdAt || new Date().toISOString(),
      asTrimmedString(transfer.createdBy),
      asTrimmedString(transfer.receivedAt),
      asTrimmedString(transfer.receivedBy),
      asTrimmedString(transfer.cancelledAt),
      asTrimmedString(transfer.cancelledBy),
      transfer.updatedAt || new Date().toISOString(),
      asTrimmedString(transfer.updatedBy || transfer.createdBy),
    ]
  );

  return mapDbBoxTransferRow(row);
}

async function deleteBoxRecord(client, orgId, boxId) {
  await client.query(
    `
      delete from app.boxes
      where org_id = $1
        and box_id = $2
    `,
    [orgId, boxId]
  );
}

async function listAllocationsByBox(client, orgId, boxId) {
  const canonicalBoxId = await resolveBoxIdAlias(client, orgId, boxId);
  const rows = await queryRows(
    client,
    `
      select *
      from app.allocations
      where org_id = $1
        and box_id = $2
      order by created_at desc, allocation_id desc
    `,
    [orgId, canonicalBoxId]
  );

  return rows.map(mapDbAllocationRow);
}

export {
  listWarehouseCodes,
  listWarehouseBoxIdPrefixes,
  requireConfiguredWarehouse,
  findWarehouseEntry,
  getBoxIdPrefixToken,
  getTransferredBoxIdSuffix,
  buildTransferredBoxId,
  resolveBoxIdAlias,
  resolveWarehouseFromBoxId,
  buildBoxSelectColumns,
  listBoxes,
  listBoxesByWarehouses,
  listBoxesByIds,
  findBoxById,
  saveBoxRecord,
  findBoxByRecordId,
  findBoxTransferByTransferId,
  listBoxTransfersByBoxRecordId,
  getLatestBoxTransferByBoxId,
  findPendingBoxTransferByBoxRecordId,
  findPendingBoxTransferByDestinationBoxId,
  listPendingBoxTransfersByBoxRecordIds,
  indexPendingBoxTransfersByBoxRecordId,
  saveBoxTransferRecord,
  deleteBoxRecord,
  listAllocationsByBox,
};

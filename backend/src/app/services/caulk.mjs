import { queryRow, queryRows } from '../../db/client.mjs';
import { HttpError } from '../../lib/http.mjs';
import {
  asTrimmedString,
  integerOrZero,
  normalizeWarehouseCodeFormat,
  parseBooleanFlag,
  parseIntegerInput,
  requireUuid,
  requireString,
} from '../core/helpers.mjs';
import {
  mapCaulkManufacturerRow,
  mapCaulkProductRow,
  mapCaulkStockRow,
  mapDbCaulkTransferRow,
  mapCaulkTransactionRow,
  normalizeCaulkCaseMath as normalizeCaulkCaseMathFromMappers,
} from '../repositories/mappers.mjs';

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

async function requireConfiguredWarehouse(client, orgId, warehouse, fieldName) {
  const normalized = normalizeWarehouseCodeFormat(warehouse, fieldName || 'Warehouse');
  const configured = await listWarehouseCodes(client, orgId);
  if (!configured.includes(normalized)) {
    throw new HttpError(400, `${fieldName || 'Warehouse'} is not configured.`);
  }
  return normalized;
}

async function requireOwnerCompany(client, orgId, ownerCompanyId, fieldName = 'OwnerCompanyId') {
  const normalizedOwnerCompanyId = requireUuid(ownerCompanyId, fieldName);
  const row = await queryRow(
    client,
    `
      select *
      from app.owner_companies
      where org_id = $1::uuid
        and id = $2::uuid
      limit 1
    `,
    [orgId, normalizedOwnerCompanyId]
  );

  if (!row) {
    throw new HttpError(400, 'Owner company was not found.');
  }
  if (row.is_active !== true) {
    throw new HttpError(400, 'Owner company is inactive and cannot be selected for new assignments.');
  }
  return row;
}

async function resolveCaulkStockOwner(client, orgId, productId, warehouse, payload = {}) {
  const stockIdRaw = asTrimmedString(payload.stockId);
  if (stockIdRaw) {
    const row = await queryRow(
      client,
      `
        select owner_company_id
        from app.caulk_stock
        where org_id = $1::uuid
          and id = $2::uuid
          and product_id = $3::uuid
          and warehouse = $4::text
        limit 1
      `,
      [orgId, requireUuid(stockIdRaw, 'stockId'), productId, warehouse]
    );
    if (!row) {
      throw new HttpError(400, 'Caulk stock row was not found for this product and warehouse.');
    }
    return row.owner_company_id;
  }

  const ownerCompanyIdRaw = asTrimmedString(payload.ownerCompanyId);
  if (ownerCompanyIdRaw) {
    const owner = await requireOwnerCompany(client, orgId, ownerCompanyIdRaw);
    return owner.id;
  }

  const rows = await queryRows(
    client,
    `
      select owner_company_id
      from app.caulk_stock
      where org_id = $1::uuid
        and product_id = $2::uuid
        and warehouse = $3::text
      order by updated_at desc, id desc
    `,
    [orgId, productId, warehouse]
  );

  if (rows.length === 1) {
    return rows[0].owner_company_id;
  }
  if (rows.length === 0) {
    const owner = await queryRow(
      client,
      `
        select id
        from app.owner_companies
        where org_id = $1::uuid
          and lookup_key = lower(app_api.default_owner_company_code_for_warehouse($2::text))
        limit 1
      `,
      [orgId, warehouse]
    );
    if (owner?.id) {
      return owner.id;
    }
  }

  throw new HttpError(
    400,
    'Multiple owner rows exist for this caulk product and warehouse. Select an exact owner row.'
  );
}

async function listCaulkManufacturers(client, orgId) {
  const rows = await queryRows(
    client,
    `
      select
        m.id as manufacturer_id,
        m.name,
        m.lookup_key,
        m.is_active,
        m.updated_at
      from app.caulk_manufacturers m
      where m.org_id = $1::uuid
      order by lower(m.name)
    `,
    [orgId]
  );

  return rows.map(mapCaulkManufacturerRow);
}

async function listCaulkProducts(client, orgId) {
  const rows = await queryRows(
    client,
    `
      select
        p.id as product_id,
        p.manufacturer_id,
        m.name as manufacturer,
        p.name as product_name,
        p.code as product_code,
        p.lookup_key,
        p.tubes_per_case,
        p.is_active,
        p.notes,
        p.updated_at
      from app.caulk_products p
      join app.caulk_manufacturers m
        on m.org_id = p.org_id
       and m.id = p.manufacturer_id
      where p.org_id = $1::uuid
      order by lower(m.name), lower(p.name), lower(p.code)
    `,
    [orgId]
  );

  return rows.map(mapCaulkProductRow);
}

async function listCaulkStock(client, orgId, params) {
  const warehouseFilterRaw = asTrimmedString(params.warehouse).toUpperCase();
  const warehouseFilter =
    warehouseFilterRaw && warehouseFilterRaw !== 'ALL'
      ? await requireConfiguredWarehouse(client, orgId, warehouseFilterRaw, 'Warehouse')
      : '';
  const manufacturerFilter = asTrimmedString(params.manufacturer);
  const productIdRaw = asTrimmedString(params.productId);
  const productId = productIdRaw ? requireUuid(productIdRaw, 'ProductId') : null;
  const stockIdRaw = asTrimmedString(params.stockId);
  const stockId = stockIdRaw ? requireUuid(stockIdRaw, 'stockId') : null;
  const ownerCompanyIdRaw = asTrimmedString(params.ownerCompanyId);
  const ownerCompanyId = ownerCompanyIdRaw ? requireUuid(ownerCompanyIdRaw, 'OwnerCompanyId') : null;
  const queryText = asTrimmedString(params.q);

  const rows = await queryRows(
    client,
    `
      select
        s.id as stock_id,
        s.warehouse,
        p.id as product_id,
        p.manufacturer_id,
        m.name as manufacturer,
        p.name as product_name,
        p.code as product_code,
        p.tubes_per_case,
        s.owner_company_id,
        owner_company.code as owner_company_code,
        owner_company.display_name as owner_company_display_name,
        owner_company.is_active as owner_company_is_active,
        s.tubes_on_hand,
        floor(s.tubes_on_hand::numeric / p.tubes_per_case::numeric)::integer as cases_on_hand,
        mod(s.tubes_on_hand, p.tubes_per_case) as loose_tubes,
        s.updated_at,
        s.updated_by
      from app.caulk_stock s
      join app.caulk_products p
        on p.org_id = s.org_id
       and p.id = s.product_id
      join app.caulk_manufacturers m
        on m.org_id = p.org_id
       and m.id = p.manufacturer_id
      join app.owner_companies owner_company
        on owner_company.org_id = s.org_id
       and owner_company.id = s.owner_company_id
      where s.org_id = $1::uuid
        and ($2::text = '' or s.warehouse = $2::text)
        and ($3::text = '' or lower(m.name) = lower($3::text))
        and ($5::uuid is null or p.id = $5::uuid)
        and ($6::uuid is null or s.id = $6::uuid)
        and ($7::uuid is null or s.owner_company_id = $7::uuid)
        and (
          $4::text = ''
          or p.name ilike ('%' || $4::text || '%')
          or p.code ilike ('%' || $4::text || '%')
          or m.name ilike ('%' || $4::text || '%')
        )
      order by s.warehouse asc, owner_company.code asc, lower(m.name), lower(p.name), lower(p.code)
    `,
    [orgId, warehouseFilter, manufacturerFilter, queryText, productId, stockId, ownerCompanyId]
  );

  return rows.map(mapCaulkStockRow);
}

async function listCaulkTransactions(client, orgId, params) {
  const warehouseFilterRaw = asTrimmedString(params.warehouse).toUpperCase();
  const warehouseFilter =
    warehouseFilterRaw && warehouseFilterRaw !== 'ALL'
      ? await requireConfiguredWarehouse(client, orgId, warehouseFilterRaw, 'Warehouse')
      : '';
  const productIdRaw = asTrimmedString(params.productId);
  const productId = productIdRaw ? requireUuid(productIdRaw, 'ProductId') : null;
  const limitValue = Number(params.limit);
  const limit = Number.isFinite(limitValue) && limitValue > 0 ? Math.min(Math.trunc(limitValue), 1000) : 200;

  const rows = await queryRows(
    client,
    `
      select
        t.transaction_id,
        t.product_id,
        t.warehouse,
        t.owner_company_id,
        owner_company.code as owner_company_code,
        owner_company.display_name as owner_company_display_name,
        m.name as manufacturer,
        p.name as product_name,
        p.code as product_code,
        t.action,
        t.delta_tubes,
        t.resulting_tubes_on_hand,
        t.tubes_per_case,
        case
          when t.action = 'JOB_CHECKIN_UNUSED'
            and btrim(coalesce(source_allocation.job_number, '')) <> ''
            then format('Checked in unused caulk from job %s.', source_allocation.job_number)
          when t.action = 'ADJUST'
            and lower(btrim(coalesce(t.reason, ''))) = 'inventory edit'
            and btrim(coalesce(t.notes, '')) <> ''
            then btrim(t.notes)
          else t.reason
        end as reason,
        t.notes,
        t.transfer_id,
        t.source_box_id,
        resolved_job.id as job_id,
        resolved_job.job_number,
        resolved_job.warehouse as job_warehouse,
        t.created_at,
        t.created_by
      from app.caulk_transactions t
      join app.caulk_products p
        on p.org_id = t.org_id
       and p.id = t.product_id
      join app.caulk_manufacturers m
        on m.org_id = p.org_id
       and m.id = p.manufacturer_id
      left join app.owner_companies owner_company
        on owner_company.org_id = t.org_id
       and owner_company.id = t.owner_company_id
      left join app.caulk_job_allocations source_allocation
        on source_allocation.org_id = t.org_id
       and source_allocation.caulk_allocation_id = t.source_box_id
      left join app.caulk_transfers source_transfer
        on source_transfer.org_id = t.org_id
       and source_transfer.transfer_id = t.transfer_id
       and btrim(coalesce(t.transfer_id, '')) <> ''
      left join app.caulk_job_allocations transfer_allocation
        on transfer_allocation.org_id = source_transfer.org_id
       and transfer_allocation.id = source_transfer.caulk_allocation_id
      left join app.jobs resolved_job
        on resolved_job.org_id = t.org_id
       and resolved_job.id = coalesce(source_allocation.job_id, source_transfer.job_id, transfer_allocation.job_id)
      where t.org_id = $1::uuid
        and ($2::text = '' or t.warehouse = $2::text)
        and ($3::uuid is null or t.product_id = $3::uuid)
      order by t.created_at desc
      limit $4::integer
    `,
    [orgId, warehouseFilter, productId, limit]
  );

  return rows.map(mapCaulkTransactionRow);
}

async function listPendingCaulkTransfers(client, orgId, params) {
  const warehouse = await requireConfiguredWarehouse(client, orgId, params.warehouse, 'Warehouse');
  const productIdRaw = asTrimmedString(params.productId);
  const productId = productIdRaw ? requireUuid(productIdRaw, 'ProductId') : null;

  const rows = await queryRows(
    client,
    `
      select
        t.*,
        coalesce(t.job_id, a.job_id) as resolved_job_id,
        a.caulk_allocation_id as caulk_allocation_public_id,
        a.job_number,
        coalesce(job_by_id.warehouse, legacy_job.warehouse) as job_warehouse,
        p.id as product_id,
        p.manufacturer_id,
        m.name as manufacturer,
        p.name as product_name,
        p.code as product_code,
        p.tubes_per_case,
        t.owner_company_id,
        owner_company.code as owner_company_code,
        owner_company.display_name as owner_company_display_name
      from app.caulk_transfers t
      join app.caulk_job_allocations a
        on a.org_id = t.org_id
       and a.id = t.caulk_allocation_id
      join app.caulk_products p
        on p.org_id = t.org_id
       and p.id = t.product_id
      left join app.jobs job_by_id
        on job_by_id.org_id = t.org_id
       and job_by_id.id = coalesce(t.job_id, a.job_id)
      left join app.jobs legacy_job
        on legacy_job.org_id = a.org_id
       and coalesce(t.job_id, a.job_id) is null
       and upper(trim(legacy_job.job_number)) = upper(trim(a.job_number))
      join app.caulk_manufacturers m
        on m.org_id = p.org_id
       and m.id = p.manufacturer_id
      left join app.owner_companies owner_company
        on owner_company.org_id = t.org_id
       and owner_company.id = t.owner_company_id
      where t.org_id = $1::uuid
        and t.status = 'PENDING'
        and t.destination_warehouse = $2::text
        and ($3::uuid is null or t.product_id = $3::uuid)
      order by t.created_at desc, t.id desc
    `,
    [orgId, warehouse, productId]
  );

  return rows.map(mapDbCaulkTransferRow);
}

async function ownerUpsertCaulkManufacturer(client, orgId, actor, payload) {
  const name = requireString(payload.name, 'Name');
  const isActive = payload.isActive === undefined ? true : parseBooleanFlag(payload.isActive);
  const row = await queryRow(
    client,
    `
      select *
      from app_api.caulk_upsert_manufacturer($1::uuid, $2::text, $3::text, $4::boolean)
    `,
    [orgId, actor, name, isActive]
  );

  return mapCaulkManufacturerRow(row);
}

async function upsertCaulkProduct(client, orgId, actor, payload) {
  const productIdRaw = asTrimmedString(payload.productId);
  const productId = productIdRaw ? requireUuid(productIdRaw, 'ProductId') : null;
  const manufacturerId = requireUuid(payload.manufacturerId, 'ManufacturerId');
  const productName = requireString(payload.productName, 'ProductName');
  const productCode = asTrimmedString(payload.productCode);
  const warehouseRaw = asTrimmedString(payload.warehouse);
  const notes = asTrimmedString(payload.notes);
  const isActive = payload.isActive === undefined ? true : parseBooleanFlag(payload.isActive);
  const tubesPerCaseValue = payload.tubesPerCase === undefined ? 16 : payload.tubesPerCase;
  const tubesPerCase = parseIntegerInput(tubesPerCaseValue, 'TubesPerCase');
  if (tubesPerCase <= 0) {
    throw new HttpError(400, 'TubesPerCase must be greater than zero.');
  }

  const row = await queryRow(
    client,
    `
      select *
      from app_api.caulk_upsert_product(
        $1::uuid,
        $2::text,
        $3::uuid,
        $4::uuid,
        $5::text,
        $6::text,
        $7::integer,
        $8::boolean,
        $9::text
      )
    `,
    [orgId, actor, productId, manufacturerId, productName, productCode, tubesPerCase, isActive, notes]
  );

  if (warehouseRaw && row?.id) {
    const warehouse = await requireConfiguredWarehouse(client, orgId, warehouseRaw, 'Warehouse');
    const owner = await requireOwnerCompany(client, orgId, payload.ownerCompanyId);
    await queryRow(
      client,
      `
        insert into app.caulk_stock (
          org_id,
          product_id,
          warehouse,
          owner_company_id,
          tubes_on_hand,
          updated_by
        )
        values (
          $1::uuid,
          $2::uuid,
          $3::text,
          $4::uuid,
          0,
          $5::text
        )
        on conflict (org_id, product_id, warehouse, owner_company_id) do nothing
        returning id
      `,
      [orgId, row.id, warehouse, owner.id, actor]
    );
  }

  const product = mapCaulkProductRow(row);
  const manufacturer = await queryRow(
    client,
    `
      select name
      from app.caulk_manufacturers
      where org_id = $1::uuid
        and id = $2::uuid
    `,
    [orgId, manufacturerId]
  );
  if (product) {
    product.manufacturer = asTrimmedString(manufacturer?.name);
  }
  return product;
}

async function getCaulkProductTubesPerCase(client, orgId, productId) {
  const row = await queryRow(
    client,
    `
      select tubes_per_case
      from app.caulk_products
      where org_id = $1::uuid
        and id = $2::uuid
    `,
    [orgId, productId]
  );
  if (!row) {
    throw new HttpError(404, 'Caulk product was not found.');
  }
  const tubesPerCase = integerOrZero(row.tubes_per_case);
  if (tubesPerCase <= 0) {
    throw new HttpError(400, 'Caulk product tubes-per-case must be greater than zero.');
  }
  return tubesPerCase;
}

async function applyCaulkDelta(
  client,
  orgId,
  actor,
  productId,
  warehouse,
  ownerCompanyId,
  action,
  deltaTubes,
  reason,
  transferId = '',
  sourceBoxId = '',
  notes = ''
) {
  const row = await queryRow(
    client,
    `
      select app_api.caulk_apply_stock_delta_for_owner(
        $1::uuid,
        $2::text,
        $3::uuid,
        $4::text,
        $5::uuid,
        $6::text,
        $7::integer,
        $8::text,
        $9::text,
        $10::text,
        $11::text
      ) as result
    `,
    [orgId, actor, productId, warehouse, ownerCompanyId, action, deltaTubes, reason, transferId, sourceBoxId, notes]
  );

  return normalizeCaulkCaseMathFromMappers(row?.result || {});
}

async function mutateCaulkStock(client, orgId, actor, payload) {
  const action = requireString(payload.action, 'Action').toUpperCase();
  if (!['RECEIVE', 'USE', 'ADJUST'].includes(action)) {
    throw new HttpError(400, 'Action must be RECEIVE, USE, or ADJUST.');
  }

  const productId = requireUuid(payload.productId, 'ProductId');
  const warehouse = await requireConfiguredWarehouse(client, orgId, payload.warehouse, 'Warehouse');
  const ownerCompanyId = await resolveCaulkStockOwner(client, orgId, productId, warehouse, payload);
  const tubesPerCase = await getCaulkProductTubesPerCase(client, orgId, productId);
  const cases = payload.cases === undefined || payload.cases === '' ? 0 : parseIntegerInput(payload.cases, 'Cases');
  const tubes = payload.tubes === undefined || payload.tubes === '' ? 0 : parseIntegerInput(payload.tubes, 'Tubes');
  const deltaOverride =
    payload.deltaTubes === undefined || payload.deltaTubes === ''
      ? null
      : parseIntegerInput(payload.deltaTubes, 'DeltaTubes');
  const notes = asTrimmedString(payload.notes);
  let reason = asTrimmedString(payload.reason) || action;
  if (action === 'ADJUST' && notes && reason.toLowerCase() === 'inventory edit') {
    reason = notes;
  }

  let delta = deltaOverride !== null ? deltaOverride : cases * tubesPerCase + tubes;
  if (action === 'RECEIVE') {
    if (delta <= 0) {
      throw new HttpError(400, 'Receive requires a positive quantity.');
    }
    return applyCaulkDelta(
      client,
      orgId,
      actor,
      productId,
      warehouse,
      ownerCompanyId,
      'RECEIVE',
      delta,
      reason,
      '',
      '',
      notes
    );
  }
  if (action === 'USE') {
    if (delta <= 0) {
      throw new HttpError(400, 'Use requires a positive quantity.');
    }
    return applyCaulkDelta(
      client,
      orgId,
      actor,
      productId,
      warehouse,
      ownerCompanyId,
      'USE',
      -delta,
      reason,
      '',
      '',
      notes
    );
  }

  if (delta === 0) {
    throw new HttpError(400, 'Adjust requires a non-zero delta.');
  }
  return applyCaulkDelta(
    client,
    orgId,
    actor,
    productId,
    warehouse,
    ownerCompanyId,
    'ADJUST',
    delta,
    reason,
    '',
    '',
    notes
  );
}

async function transferCaulkStock(client, orgId, actor, payload) {
  const productId = requireUuid(payload.productId, 'ProductId');
  const fromWarehouse = await requireConfiguredWarehouse(client, orgId, payload.fromWarehouse, 'FromWarehouse');
  const toWarehouse = await requireConfiguredWarehouse(client, orgId, payload.toWarehouse, 'ToWarehouse');
  const ownerCompanyId = await resolveCaulkStockOwner(client, orgId, productId, fromWarehouse, payload);
  if (fromWarehouse === toWarehouse) {
    throw new HttpError(400, 'Transfer source and destination warehouse must differ.');
  }

  const tubesPerCase = await getCaulkProductTubesPerCase(client, orgId, productId);
  const cases = payload.cases === undefined || payload.cases === '' ? 0 : parseIntegerInput(payload.cases, 'Cases');
  const tubes = payload.tubes === undefined || payload.tubes === '' ? 0 : parseIntegerInput(payload.tubes, 'Tubes');
  const deltaOverride =
    payload.deltaTubes === undefined || payload.deltaTubes === ''
      ? null
      : parseIntegerInput(payload.deltaTubes, 'DeltaTubes');
  const reason = asTrimmedString(payload.reason) || 'TRANSFER';
  const notes = asTrimmedString(payload.notes);
  const delta = deltaOverride !== null ? deltaOverride : cases * tubesPerCase + tubes;
  if (delta <= 0) {
    throw new HttpError(400, 'Transfer requires a positive quantity.');
  }

  const transferRow = await queryRow(client, 'select app_api.caulk_create_transaction_id() as transfer_id');
  const transferId = asTrimmedString(transferRow?.transfer_id);
  const from = await applyCaulkDelta(
    client,
    orgId,
    actor,
    productId,
    fromWarehouse,
    ownerCompanyId,
    'TRANSFER_OUT',
    -delta,
    reason,
    transferId,
    '',
    notes
  );
  const to = await applyCaulkDelta(
    client,
    orgId,
    actor,
    productId,
    toWarehouse,
    ownerCompanyId,
    'TRANSFER_IN',
    delta,
    reason,
    transferId,
    '',
    notes
  );

  return {
    transferId,
    movedTubes: delta,
    from,
    to,
  };
}

export {
  listCaulkManufacturers,
  listCaulkProducts,
  listCaulkStock,
  listCaulkTransactions,
  listPendingCaulkTransfers,
  ownerUpsertCaulkManufacturer,
  upsertCaulkProduct,
  mutateCaulkStock,
  transferCaulkStock,
};

import { queryRow, queryRows } from '../../../db/client.mjs';
import { HttpError } from '../../../lib/http.mjs';
import {
  WarehouseAssetAuditError,
  buildWarehouseAssetAuditReport,
} from '../../../../../shared/domain/warehouseAssetAudit.mjs';

async function buildWarehouseAssetAuditFromDatabase(
  client,
  orgId,
  params = {},
  metadata = {},
  deps = {},
) {
  const readRow = deps.queryRow || queryRow;
  const readRows = deps.queryRows || queryRows;

  const organization = await readRow(
    client,
    `
      select id as org_id, name
      from app.organizations
      where id = $1::uuid
    `,
    [orgId],
  );
  const warehouses = await readRows(
    client,
    `
      select org_id, code, name
      from app.warehouses
      where org_id = $1::uuid
      order by code
    `,
    [orgId],
  );
  const owners = await readRows(
    client,
    `
      select id, org_id, code, display_name, is_active
      from app.owner_companies
      where org_id = $1::uuid
      order by code, id
    `,
    [orgId],
  );
  const boxes = await readRows(
    client,
    `
      select
        b.id,
        b.org_id,
        b.box_id,
        b.warehouse,
        b.owner_company_id,
        b.manufacturer,
        b.film_name,
        b.width_in,
        b.initial_feet,
        b.feet_available,
        b.status,
        b.last_roll_weight_lbs,
        b.core_weight_lbs,
        b.lf_weight_lbs_per_ft,
        b.price_per_lf,
        b.purchase_cost,
        app_api.box_physical_feet_available(b)::integer as physical_feet_available
      from app.boxes b
      where b.org_id = $1::uuid
      order by b.box_id, b.id
    `,
    [orgId],
  );
  const pendingTransfers = await readRows(
    client,
    `
      select
        org_id,
        box_record_id,
        source_warehouse,
        destination_warehouse,
        status
      from app.box_transfers
      where org_id = $1::uuid
        and status = 'PENDING'
      order by box_record_id, created_at, id
    `,
    [orgId],
  );

  try {
    return buildWarehouseAssetAuditReport({
      expectedOrgId: orgId,
      organizationName: organization?.name,
      generatedAt: metadata.generatedAt || new Date().toISOString(),
      generatedBy: metadata.generatedBy,
      boxes,
      owners,
      warehouses,
      pendingTransfers,
      allocations: [],
      filters: params,
    });
  } catch (error) {
    if (error instanceof WarehouseAssetAuditError) {
      throw new HttpError(error.statusCode, error.message, [], { code: error.code });
    }
    throw error;
  }
}

export { buildWarehouseAssetAuditFromDatabase };

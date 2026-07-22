import { HttpError } from '../http.ts';
import {
  WarehouseAssetAuditError,
  buildWarehouseAssetAuditReport,
} from '../../../../shared/domain/warehouseAssetAudit.mjs';

const DEFAULT_PAGE_SIZE = 1000;

type QueryBuilder = {
  eq: (column: string, value: unknown) => QueryBuilder;
  order: (column: string, options: { ascending: boolean }) => QueryBuilder;
  range: (from: number, to: number) => Promise<{ data: unknown[] | null; error: unknown }>;
};

async function fetchAllRows(
  client: any,
  table: string,
  columns: string,
  orgId: string,
  options: {
    pageSize?: number;
    orderColumn?: string;
    filters?: Array<{ column: string; value: unknown }>;
  } = {},
) {
  const pageSize = Math.max(1, Math.floor(options.pageSize || DEFAULT_PAGE_SIZE));
  const rows: unknown[] = [];
  for (let from = 0; ; from += pageSize) {
    let query = client
      .schema('app')
      .from(table)
      .select(columns)
      .eq('org_id', orgId) as QueryBuilder;
    for (const filter of options.filters || []) {
      query = query.eq(filter.column, filter.value);
    }
    const { data, error } = await query
      .order(options.orderColumn || 'id', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) {
      throw new HttpError(502, 'Unable to load warehouse asset audit data.');
    }
    const page = Array.isArray(data) ? data : [];
    rows.push(...page);
    if (page.length < pageSize) {
      break;
    }
  }
  return rows;
}

async function buildWarehouseAssetAuditFromEdge(
  serviceClient: any,
  orgId: string,
  params: Record<string, unknown> = {},
  metadata: { generatedBy?: string; generatedAt?: string } = {},
  options: { pageSize?: number } = {},
) {
  const pageSize = options.pageSize || DEFAULT_PAGE_SIZE;
  const organizationPromise = serviceClient
    .schema('app')
    .from('organizations')
    .select('id, name')
    .eq('id', orgId)
    .maybeSingle();
  const [organizationResult, warehouses, owners, boxes, pendingTransfers, allocations] = await Promise.all([
    organizationPromise,
    fetchAllRows(serviceClient, 'warehouses', 'org_id, code, name', orgId, { pageSize, orderColumn: 'code' }),
    fetchAllRows(
      serviceClient,
      'owner_companies',
      'id, org_id, code, display_name, is_active',
      orgId,
      { pageSize },
    ),
    fetchAllRows(
      serviceClient,
      'boxes',
      [
        'id',
        'org_id',
        'box_id',
        'warehouse',
        'owner_company_id',
        'manufacturer',
        'film_name',
        'width_in',
        'initial_feet',
        'feet_available',
        'status',
        'last_roll_weight_lbs',
        'core_weight_lbs',
        'lf_weight_lbs_per_ft',
        'price_per_lf',
        'purchase_cost',
      ].join(', '),
      orgId,
      { pageSize },
    ),
    fetchAllRows(
      serviceClient,
      'box_transfers',
      'id, org_id, box_record_id, source_warehouse, destination_warehouse, status',
      orgId,
      { pageSize, filters: [{ column: 'status', value: 'PENDING' }] },
    ),
    fetchAllRows(
      serviceClient,
      'allocations',
      [
        'id',
        'org_id',
        'allocation_id',
        'box_id',
        'allocated_feet',
        'allocation_kind',
        'requirement_id',
        'job_id',
        'job_number',
        'status',
      ].join(', '),
      orgId,
      { pageSize, filters: [{ column: 'status', value: 'ACTIVE' }] },
    ),
  ]);

  if (organizationResult.error || !organizationResult.data) {
    throw new HttpError(502, 'Unable to load warehouse asset audit metadata.');
  }

  try {
    return buildWarehouseAssetAuditReport({
      expectedOrgId: orgId,
      organizationName: organizationResult.data.name,
      generatedAt: metadata.generatedAt || new Date().toISOString(),
      generatedBy: metadata.generatedBy,
      boxes,
      owners,
      warehouses,
      pendingTransfers,
      allocations,
      filters: params,
    });
  } catch (error) {
    if (error instanceof WarehouseAssetAuditError) {
      throw new HttpError(error.statusCode, error.message, [], { code: error.code });
    }
    throw error;
  }
}

export { buildWarehouseAssetAuditFromEdge, fetchAllRows };

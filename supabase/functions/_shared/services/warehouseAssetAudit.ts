import { HttpError } from '../http.ts';
import {
  WarehouseAssetAuditError,
  buildWarehouseAssetAuditReport,
} from '../../../../shared/domain/warehouseAssetAudit.mjs';

const DEFAULT_PAGE_SIZE = 1000;

type QueryBuilder = {
  eq: (column: string, value: unknown) => QueryBuilder;
  in: (column: string, values: unknown[]) => QueryBuilder;
  is: (column: string, value: null) => QueryBuilder;
  order: (column: string, options: { ascending: boolean }) => QueryBuilder;
  range: (from: number, to: number) => Promise<{ data: unknown[] | null; error: unknown }>;
};

type AuditReadFilter =
  | { column: string; value: unknown; operator?: "eq" }
  | { column: string; values: unknown[]; operator: "in" }
  | { column: string; value: null; operator: "is" };

async function fetchAllRows(
  client: any,
  table: string,
  columns: string,
  orgId: string,
  options: {
    pageSize?: number;
    orderColumn?: string;
    filters?: AuditReadFilter[];
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
      if (filter.operator === "in") {
        query = query.in(filter.column, filter.values);
      } else if (filter.operator === "is") {
        query = query.is(filter.column, filter.value);
      } else {
        query = query.eq(filter.column, filter.value);
      }
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

function asTrimmedString(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

function normalizeUpper(value: unknown): string {
  return asTrimmedString(value).toUpperCase();
}

function getJobNumberVariants(value: unknown, warehouse: unknown): string[] {
  const normalized = normalizeUpper(value);
  if (!normalized) {
    return [];
  }
  const values = new Set([normalized]);
  const normalizedWarehouse = normalizeUpper(warehouse);
  const prefix = `${normalizedWarehouse}-`;
  if (normalizedWarehouse && normalized.startsWith(prefix) && normalized.length > prefix.length) {
    values.add(normalized.slice(prefix.length));
  } else if (normalizedWarehouse) {
    values.add(`${normalizedWarehouse}-${normalized}`);
  }
  return [...values];
}

function valuesIntersect(left: string[], right: string[]): boolean {
  const rightSet = new Set(right);
  return left.some((value) => rightSet.has(value));
}

function dedupeRows(rows: unknown[], keys: string[]): unknown[] {
  const result = new Map<string, unknown>();
  for (const row of rows) {
    const entry = row as Record<string, unknown>;
    const key = keys.map((name) => asTrimmedString(entry?.[name])).find(Boolean);
    if (key && !result.has(key)) {
      result.set(key, row);
    }
  }
  return [...result.values()];
}

function sortContextRows(rows: unknown[]): unknown[] {
  return rows.slice().sort((left, right) => {
    const leftEntry = left as Record<string, unknown>;
    const rightEntry = right as Record<string, unknown>;
    const leftCreated = asTrimmedString(leftEntry.created_at);
    const rightCreated = asTrimmedString(rightEntry.created_at);
    if (leftCreated !== rightCreated) {
      return leftCreated < rightCreated ? -1 : 1;
    }
    const leftId = asTrimmedString(leftEntry.id);
    const rightId = asTrimmedString(rightEntry.id);
    return leftId === rightId ? 0 : leftId < rightId ? -1 : 1;
  });
}

async function loadCheckedOutContext(
  readAll: (
    name: string,
    table: string,
    columns: string,
    options?: {
      pageSize?: number;
      orderColumn?: string;
      filters?: AuditReadFilter[];
    },
  ) => Promise<unknown[]>,
  checkedOutBoxes: Array<Record<string, unknown>>,
  pageSize: number,
) {
  const noUuidMatch = "00000000-0000-0000-0000-000000000000";
  const noTextMatch = "__WAREHOUSE_ASSET_AUDIT_NO_MATCH__";
  const boxIds = checkedOutBoxes.map((box) => normalizeUpper(box.box_id)).filter(Boolean);
  const links = await readAll(
    "checkout-film-order-links",
    "film_order_box_links",
    "id, org_id, box_id, film_order_id",
    {
      pageSize,
      filters: [{ column: "box_id", values: boxIds.length ? boxIds : [noTextMatch], operator: "in" }],
    },
  );
  const linkedFilmOrderIds = links
    .map((row) => asTrimmedString((row as Record<string, unknown>).film_order_id))
    .filter(Boolean);
  const linkedFilmOrders = await readAll(
    "checkout-linked-film-orders",
    "film_orders",
    "id, org_id, film_order_id, job_id, job_number, warehouse, crew_leader, created_at",
    {
      pageSize,
      orderColumn: "created_at",
      filters: [{
        column: "film_order_id",
        values: linkedFilmOrderIds.length ? linkedFilmOrderIds : [noTextMatch],
        operator: "in",
      }],
    },
  );
  const jobs = await readAll(
    "checkout-jobs",
    "jobs",
    "id, org_id, job_number, warehouse, crew_leader",
    { pageSize, orderColumn: "job_number" },
  );

  const candidateIds = new Set<string>();
  const candidateNumberVariants: string[][] = [];
  for (const box of checkedOutBoxes) {
    const durableId = asTrimmedString(box.last_checkout_job_id);
    if (durableId) {
      candidateIds.add(durableId);
    }
    const variants = getJobNumberVariants(box.last_checkout_job, box.warehouse);
    if (variants.length) {
      candidateNumberVariants.push(variants);
    }
  }
  for (const row of linkedFilmOrders) {
    const entry = row as Record<string, unknown>;
    const jobId = asTrimmedString(entry.job_id);
    if (jobId) {
      candidateIds.add(jobId);
    }
    const variants = getJobNumberVariants(entry.job_number, entry.warehouse);
    if (variants.length) {
      candidateNumberVariants.push(variants);
    }
  }
  const candidateJobs = jobs.filter((row) => {
    const job = row as Record<string, unknown>;
    const id = asTrimmedString(job.id);
    if (candidateIds.has(id)) {
      return true;
    }
    const variants = getJobNumberVariants(job.job_number, job.warehouse);
    return candidateNumberVariants.some((candidate) => valuesIntersect(candidate, variants));
  });
  for (const row of candidateJobs) {
    candidateIds.add(asTrimmedString((row as Record<string, unknown>).id));
  }
  const candidateJobIds = [...candidateIds].filter(Boolean);
  const uuidValues = candidateJobIds.length ? candidateJobIds : [noUuidMatch];

  const [
    phases,
    requirements,
    caulkRequirements,
    allocationsById,
    legacyAllocations,
    filmOrdersById,
    legacyFilmOrders,
  ] = await Promise.all([
    readAll(
      "checkout-phases",
      "job_phases",
      "id, org_id, job_id, phase_number, install_date, crew_leader, labor_status, workflow_status, is_primary",
      {
        pageSize,
        orderColumn: "phase_number",
        filters: [{ column: "job_id", values: uuidValues, operator: "in" }],
      },
    ),
    readAll(
      "checkout-requirements",
      "job_requirements",
      "id, org_id, job_id, phase_id, status",
      {
        pageSize,
        filters: [{ column: "job_id", values: uuidValues, operator: "in" }],
      },
    ),
    readAll(
      "checkout-caulk-requirements",
      "job_caulk_requirements",
      "id, org_id, job_id, phase_id, status",
      {
        pageSize,
        filters: [{ column: "job_id", values: uuidValues, operator: "in" }],
      },
    ),
    readAll(
      "checkout-allocations-by-id",
      "allocations",
      "id, org_id, job_id, job_number, warehouse, crew_leader, created_at",
      {
        pageSize,
        orderColumn: "created_at",
        filters: [{ column: "job_id", values: uuidValues, operator: "in" }],
      },
    ),
    readAll(
      "checkout-legacy-allocations",
      "allocations",
      "id, org_id, job_id, job_number, warehouse, crew_leader, created_at",
      {
        pageSize,
        orderColumn: "created_at",
        filters: [{ column: "job_id", value: null, operator: "is" }],
      },
    ),
    readAll(
      "checkout-film-orders-by-id",
      "film_orders",
      "id, org_id, film_order_id, job_id, job_number, warehouse, crew_leader, created_at",
      {
        pageSize,
        orderColumn: "created_at",
        filters: [{ column: "job_id", values: uuidValues, operator: "in" }],
      },
    ),
    readAll(
      "checkout-legacy-film-orders",
      "film_orders",
      "id, org_id, film_order_id, job_id, job_number, warehouse, crew_leader, created_at",
      {
        pageSize,
        orderColumn: "created_at",
        filters: [{ column: "job_id", value: null, operator: "is" }],
      },
    ),
  ]);
  const matchesCandidateJob = (row: unknown) => {
    const entry = row as Record<string, unknown>;
    const variants = getJobNumberVariants(entry.job_number, entry.warehouse);
    return candidateJobs.some((jobRow) => {
      const job = jobRow as Record<string, unknown>;
      return valuesIntersect(variants, getJobNumberVariants(job.job_number, job.warehouse));
    });
  };

  return {
    jobs: candidateJobs,
    filmOrderBoxLinks: links,
    filmOrders: sortContextRows(
      dedupeRows(
        [...linkedFilmOrders, ...filmOrdersById, ...legacyFilmOrders.filter(matchesCandidateJob)],
        ["id", "film_order_id"],
      ),
    ),
    phases,
    requirements,
    caulkRequirements,
    allocations: sortContextRows(
      dedupeRows([...allocationsById, ...legacyAllocations.filter(matchesCandidateJob)], ["id"]),
    ),
  };
}

async function buildWarehouseAssetAuditFromEdge(
  serviceClient: any,
  orgId: string,
  params: Record<string, unknown> = {},
  metadata: { generatedBy?: string; generatedAt?: string } = {},
  options: { pageSize?: number; onLogicalRead?: (name: string) => void } = {},
) {
  const pageSize = options.pageSize || DEFAULT_PAGE_SIZE;
  const onLogicalRead =
    typeof options.onLogicalRead === "function" ? options.onLogicalRead : () => {};
  const readAll = async (
    name: string,
    table: string,
    columns: string,
    readOptions: {
      pageSize?: number;
      orderColumn?: string;
      filters?: AuditReadFilter[];
    } = {},
  ) => {
    onLogicalRead(name);
    return fetchAllRows(serviceClient, table, columns, orgId, readOptions);
  };
  onLogicalRead("organization");
  const organizationPromise = serviceClient
    .schema('app')
    .from('organizations')
    .select('id, name')
    .eq('id', orgId)
    .maybeSingle();
  const [organizationResult, warehouses, owners, boxes, pendingTransfers, allocations] = await Promise.all([
    organizationPromise,
    readAll('warehouses', 'warehouses', 'org_id, code, name', { pageSize, orderColumn: 'code' }),
    readAll(
      'owners',
      'owner_companies',
      'id, org_id, code, display_name, is_active',
      { pageSize },
    ),
    readAll(
      'boxes',
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
        'direct_to_job_site',
        'last_checkout_job_id',
        'last_checkout_job',
        'last_roll_weight_lbs',
        'core_weight_lbs',
        'lf_weight_lbs_per_ft',
        'price_per_lf',
        'purchase_cost',
      ].join(', '),
      { pageSize },
    ),
    readAll(
      'pending-transfers',
      'box_transfers',
      'id, org_id, box_record_id, source_warehouse, destination_warehouse, status',
      { pageSize, filters: [{ column: 'status', value: 'PENDING' }] },
    ),
    readAll(
      'active-allocations',
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
      { pageSize, filters: [{ column: 'status', value: 'ACTIVE' }] },
    ),
  ]);

  if (organizationResult.error || !organizationResult.data) {
    throw new HttpError(502, 'Unable to load warehouse asset audit metadata.');
  }
  const checkedOutBoxes = (boxes as Array<Record<string, unknown>>).filter(
    (box) => normalizeUpper(box.status) === "CHECKED_OUT",
  );
  const checkoutContext = checkedOutBoxes.length
    ? await loadCheckedOutContext(readAll, checkedOutBoxes, pageSize)
    : null;

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
      checkoutContext,
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

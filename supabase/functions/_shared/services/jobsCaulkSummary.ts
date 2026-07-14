import { asTrimmedString, integerOrZero } from "../core/index.ts";
import { HttpError } from "../http.ts";

// Builds the Jobs List/Calendar caulk read model from org-scoped, read-only snapshots.

export type JobsCaulkSummaryContext = {
  jobNumber: string;
  header: any;
  legacy: boolean;
};

type BuildPublicCaulkRequirements = (
  requirements: any[],
  allocations: any[],
  context: { jobNumber: string; jobWarehouse: string },
) => any[];

export type JobsCaulkSummaryDependencies = {
  loadRequirements: (orgId: string) => Promise<any[]>;
  loadAllocations: (orgId: string) => Promise<any[]>;
  buildPublicRequirements: BuildPublicCaulkRequirements;
};

type SnapshotLoadBaseOptions = {
  client: any;
  orgId: string;
  pageSize: number;
  batchSize: number;
  throwOnError: (error: unknown, message: string) => void;
  loadProductsById: (
    orgId: string,
    productIds: string[],
  ) => Promise<Record<string, any>>;
};

export type JobCaulkRequirementSnapshotOptions = SnapshotLoadBaseOptions & {
  loadSuppressionSignaturesByJobId: (
    orgId: string,
    jobIds: string[],
    materialType: "CAULK",
  ) => Promise<Record<string, Set<string>>>;
  buildPlannerSignature: (
    productId: unknown,
    warehouse: unknown,
    requiredTubes: unknown,
  ) => string;
  hasPlannerSuppression: (
    signatures: Set<string>,
    phaseId: unknown,
    signature: unknown,
  ) => boolean;
  mapRequirementRow: (row: any) => any;
};

export type CaulkJobAllocationSnapshotOptions = SnapshotLoadBaseOptions & {
  mapAllocationRow: (row: any) => any;
};

type ProjectJobsCaulkSummaryOptions = {
  jobContexts: JobsCaulkSummaryContext[];
  requirements: any[];
  allocations: any[];
  buildPublicRequirements: BuildPublicCaulkRequirements;
  jobNumberFilters?: unknown[];
};

function chunkValues<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  const chunkSize = Math.max(1, Math.floor(size));
  for (let index = 0; index < values.length; index += chunkSize) {
    chunks.push(values.slice(index, index + chunkSize));
  }
  return chunks;
}

export async function listJobCaulkRequirementsSnapshot(
  options: JobCaulkRequirementSnapshotOptions,
) {
  const rows: any[] = [];
  for (let from = 0;; from += options.pageSize) {
    const { data, error } = await options.client
      .schema("app")
      .from("job_caulk_requirements")
      .select(
        "id, job_id, phase_id, product_id, required_tubes, status, actual_used_tubes, completed_at, completed_by, notes, updated_at",
      )
      .eq("org_id", options.orgId)
      .order("updated_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, from + options.pageSize - 1);
    options.throwOnError(
      error,
      "Unable to load jobs caulk requirement snapshot",
    );
    const pageRows = Array.isArray(data) ? data : [];
    rows.push(...pageRows);
    if (pageRows.length < options.pageSize) {
      break;
    }
  }

  const jobIds = Array.from(
    new Set(rows.map((row) => asTrimmedString(row?.job_id)).filter(Boolean)),
  );
  const headersByJobId: Record<string, any> = {};
  const phaseRowsByJobId: Record<string, any[]> = {};
  for (const batchIds of chunkValues(jobIds, options.batchSize)) {
    const [
      { data: headersRaw, error: headersError },
      { data: phasesRaw, error: phasesError },
    ] = await Promise.all([
      options.client
        .schema("app")
        .from("jobs")
        .select("id, job_number, warehouse")
        .eq("org_id", options.orgId)
        .in("id", batchIds),
      options.client
        .schema("app")
        .from("job_phases")
        .select("*")
        .eq("org_id", options.orgId)
        .in("job_id", batchIds)
        .order("phase_number", { ascending: true }),
    ]);
    options.throwOnError(
      headersError,
      "Unable to load jobs for caulk requirement summaries",
    );
    options.throwOnError(
      phasesError,
      "Unable to load job phases for caulk requirement summaries",
    );
    for (const header of Array.isArray(headersRaw) ? headersRaw : []) {
      const jobId = asTrimmedString(header?.id);
      if (jobId) {
        headersByJobId[jobId] = {
          jobNumber: asTrimmedString(header?.job_number),
          warehouse: asTrimmedString(header?.warehouse),
        };
      }
    }
    for (const phase of Array.isArray(phasesRaw) ? phasesRaw : []) {
      const jobId = asTrimmedString(phase?.job_id);
      if (!jobId) {
        continue;
      }
      if (!phaseRowsByJobId[jobId]) {
        phaseRowsByJobId[jobId] = [];
      }
      phaseRowsByJobId[jobId].push(phase);
    }
  }

  const [productsById, suppressedSignaturesByJobId] = await Promise.all([
    options.loadProductsById(
      options.orgId,
      rows.map((row) => asTrimmedString(row?.product_id)),
    ),
    options.loadSuppressionSignaturesByJobId(options.orgId, jobIds, "CAULK"),
  ]);

  const mappedRows = rows.map((row) => {
    const jobId = asTrimmedString(row?.job_id);
    const header = headersByJobId[jobId];
    if (!header) {
      throw new HttpError(
        500,
        "Unable to map jobs caulk requirement summary row to its canonical job.",
      );
    }
    const product = productsById[asTrimmedString(row?.product_id)] || {};
    const phase = (phaseRowsByJobId[jobId] || []).find((entry) =>
      entry?.id === row?.phase_id
    ) || {};
    return options.mapRequirementRow({
      requirement_id: row.id,
      job_id: jobId,
      phase_id: row.phase_id,
      phase_number: phase.phase_number,
      phase_sections: phase.sections,
      phase_install_date: phase.install_date,
      phase_install_end_date: phase.install_end_date,
      phase_crew_leader: phase.crew_leader,
      job_number: header.jobNumber,
      product_id: row.product_id,
      manufacturer_id: product.manufacturer_id,
      manufacturer: product.manufacturer || "",
      product_name: product.name,
      product_code: product.code,
      tubes_per_case: product.tubes_per_case,
      required_tubes: row.required_tubes,
      status: row.status,
      actual_used_tubes: row.actual_used_tubes,
      completed_at: row.completed_at,
      completed_by: row.completed_by,
      notes: row.notes,
      updated_at: row.updated_at,
      auto_planning_suppressed: options.hasPlannerSuppression(
        suppressedSignaturesByJobId[jobId] || new Set<string>(),
        row.phase_id,
        options.buildPlannerSignature(
          row.product_id,
          header.warehouse,
          row.required_tubes,
        ),
      ),
    });
  });
  if (mappedRows.some((row) => !row)) {
    throw new HttpError(
      500,
      "Unable to map jobs caulk requirement summary row.",
    );
  }
  return mappedRows;
}

export async function listCaulkJobAllocationsSnapshot(
  options: CaulkJobAllocationSnapshotOptions,
) {
  const allocations: any[] = [];
  for (let from = 0;; from += options.pageSize) {
    const { data, error } = await options.client
      .schema("app")
      .from("caulk_job_allocations")
      .select("*")
      .eq("org_id", options.orgId)
      .order("created_at", { ascending: false })
      .order("caulk_allocation_id", { ascending: false })
      .range(from, from + options.pageSize - 1);
    options.throwOnError(
      error,
      "Unable to load jobs caulk allocation snapshot",
    );
    const pageRows = Array.isArray(data) ? data : [];
    allocations.push(...pageRows);
    if (pageRows.length < options.pageSize) {
      break;
    }
  }

  const internalIds = allocations.map((entry) => asTrimmedString(entry?.id))
    .filter(Boolean);
  const productsById = await options.loadProductsById(
    options.orgId,
    allocations.map((entry) => asTrimmedString(entry?.product_id)),
  );
  const openCountsByAllocationId: Record<string, number> = {};
  const pendingTransfersByAllocationId: Record<string, any> = {};

  for (const batchIds of chunkValues(internalIds, options.batchSize)) {
    const [
      { data: checkoutsRaw, error: checkoutsError },
      { data: transfersRaw, error: transfersError },
    ] = await Promise.all([
      options.client
        .schema("app")
        .from("caulk_job_checkouts")
        .select("caulk_allocation_id")
        .eq("org_id", options.orgId)
        .eq("status", "OPEN")
        .in("caulk_allocation_id", batchIds),
      options.client
        .schema("app")
        .from("caulk_transfers")
        .select(
          "caulk_allocation_id, transfer_id, source_warehouse, destination_warehouse, pending_tubes, created_at, created_by, notes",
        )
        .eq("org_id", options.orgId)
        .eq("status", "PENDING")
        .in("caulk_allocation_id", batchIds)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false }),
    ]);
    options.throwOnError(
      checkoutsError,
      "Unable to load open caulk checkout counts",
    );
    options.throwOnError(
      transfersError,
      "Unable to load pending caulk transfers for job summaries",
    );
    for (const checkout of Array.isArray(checkoutsRaw) ? checkoutsRaw : []) {
      const allocationId = asTrimmedString(checkout?.caulk_allocation_id);
      openCountsByAllocationId[allocationId] =
        (openCountsByAllocationId[allocationId] || 0) + 1;
    }
    for (const transfer of Array.isArray(transfersRaw) ? transfersRaw : []) {
      const allocationId = asTrimmedString(transfer?.caulk_allocation_id);
      if (allocationId && !pendingTransfersByAllocationId[allocationId]) {
        pendingTransfersByAllocationId[allocationId] = transfer;
      }
    }
  }

  const mappedRows = allocations.map((allocation) => {
    const product = productsById[asTrimmedString(allocation?.product_id)] || {};
    const pendingTransfer =
      pendingTransfersByAllocationId[asTrimmedString(allocation?.id)] || {};
    return options.mapAllocationRow({
      caulk_allocation_id: allocation.caulk_allocation_id,
      requirement_id: allocation.requirement_id,
      job_id: allocation.job_id,
      product_id: allocation.product_id,
      manufacturer_id: product.manufacturer_id,
      manufacturer: product.manufacturer || "",
      product_name: product.name,
      product_code: product.code,
      tubes_per_case: product.tubes_per_case,
      job_number: allocation.job_number,
      warehouse: allocation.warehouse,
      allocated_tubes: allocation.allocated_tubes,
      reserved_tubes_remaining: allocation.reserved_tubes_remaining,
      checked_out_tubes_total: allocation.checked_out_tubes_total,
      returned_unused_tubes_total: allocation.returned_unused_tubes_total,
      used_tubes_total: allocation.used_tubes_total,
      overage_tubes_total: allocation.overage_tubes_total,
      outstanding_checkout_tubes: Math.max(
        integerOrZero(allocation.checked_out_tubes_total) -
          integerOrZero(allocation.returned_unused_tubes_total) -
          integerOrZero(allocation.used_tubes_total),
        0,
      ),
      open_checkout_count:
        openCountsByAllocationId[asTrimmedString(allocation.id)] || 0,
      pending_transfer_id: pendingTransfer.transfer_id,
      pending_transfer_source_warehouse: pendingTransfer.source_warehouse,
      pending_transfer_destination_warehouse:
        pendingTransfer.destination_warehouse,
      pending_transfer_tubes: pendingTransfer.pending_tubes,
      pending_transfer_started_at: pendingTransfer.created_at,
      pending_transfer_started_by: pendingTransfer.created_by,
      pending_transfer_notes: pendingTransfer.notes,
      status: allocation.status,
      allocation_source: allocation.allocation_source,
      created_at: allocation.created_at,
      created_by: allocation.created_by,
      updated_at: allocation.updated_at,
      updated_by: allocation.updated_by,
      resolved_at: allocation.resolved_at,
      resolved_by: allocation.resolved_by,
      notes: allocation.notes,
    });
  });
  if (mappedRows.some((row) => !row)) {
    throw new HttpError(
      500,
      "Unable to map jobs caulk allocation summary row.",
    );
  }
  return mappedRows;
}

function getSummaryRowJobId(entry: any): string {
  return asTrimmedString(entry?.jobId);
}

function getHeaderJobId(entry: any): string {
  return getSummaryRowJobId(entry) || asTrimmedString(entry?.id);
}

function getJobNumber(entry: any): string {
  return asTrimmedString(entry?.jobNumber);
}

function assertSummaryRowIdentity(entry: any, rowType: string): void {
  if (getSummaryRowJobId(entry) || getJobNumber(entry)) {
    return;
  }

  throw new HttpError(
    500,
    `Unable to map jobs caulk ${rowType} summary row to a job.`,
  );
}

function groupByJobId(entries: any[]): Record<string, any[]> {
  const grouped: Record<string, any[]> = {};
  for (const entry of entries) {
    const jobId = getSummaryRowJobId(entry);
    if (!jobId) {
      continue;
    }
    if (!grouped[jobId]) {
      grouped[jobId] = [];
    }
    grouped[jobId].push(entry);
  }
  return grouped;
}

function groupByJobNumber(
  entries: any[],
  includeScopedRows: boolean,
): Record<string, any[]> {
  const grouped: Record<string, any[]> = {};
  for (const entry of entries) {
    if (!includeScopedRows && getSummaryRowJobId(entry)) {
      continue;
    }
    const jobNumber = getJobNumber(entry);
    if (!jobNumber) {
      continue;
    }
    if (!grouped[jobNumber]) {
      grouped[jobNumber] = [];
    }
    grouped[jobNumber].push(entry);
  }
  return grouped;
}

function rowsForHeader(
  header: any,
  rowsByJobId: Record<string, any[]>,
  unscopedRowsByJobNumber: Record<string, any[]>,
  jobNumberHeaderCounts: Record<string, number>,
): any[] {
  const jobId = getHeaderJobId(header);
  const jobNumber = getJobNumber(header);
  const scopedRows = rowsByJobId[jobId] || [];
  const fallbackRows = jobNumberHeaderCounts[jobNumber] === 1
    ? unscopedRowsByJobNumber[jobNumber] || []
    : [];
  return fallbackRows.length ? [...scopedRows, ...fallbackRows] : scopedRows;
}

function collectLegacyJobNumbers(
  entries: any[],
  legacyJobNumbers: Set<string>,
  jobNumberFilterSet: Set<string>,
): void {
  for (const entry of entries) {
    const jobNumber = getJobNumber(entry);
    if (
      !jobNumber ||
      (jobNumberFilterSet.size > 0 && !jobNumberFilterSet.has(jobNumber))
    ) {
      continue;
    }
    legacyJobNumbers.add(jobNumber);
  }
}

function assertNoAmbiguousUnscopedRows(
  entries: any[],
  rowType: string,
  jobNumberHeaderCounts: Record<string, number>,
): void {
  for (const entry of entries) {
    if (getSummaryRowJobId(entry)) {
      continue;
    }
    const jobNumber = getJobNumber(entry);
    if (jobNumber && jobNumberHeaderCounts[jobNumber] > 1) {
      throw new HttpError(
        500,
        `Unable to map jobs caulk ${rowType} summary row to a unique canonical job.`,
      );
    }
  }
}

export function projectJobsCaulkSummary(
  options: ProjectJobsCaulkSummaryOptions,
) {
  const requirements = Array.isArray(options.requirements)
    ? options.requirements
    : [];
  const allocations = Array.isArray(options.allocations)
    ? options.allocations
    : [];
  const jobNumberFilterSet = new Set(
    (Array.isArray(options.jobNumberFilters) ? options.jobNumberFilters : [])
      .map((entry) => asTrimmedString(entry))
      .filter(Boolean),
  );
  const jobContexts =
    (Array.isArray(options.jobContexts) ? options.jobContexts : []).map((
      context,
    ) => ({
      jobNumber: asTrimmedString(
        context?.jobNumber || context?.header?.jobNumber,
      ),
      header: context?.header || null,
      legacy: Boolean(context?.legacy),
    }));
  const jobNumberHeaderCounts: Record<string, number> = {};
  const legacyJobNumbers = new Set<string>();

  for (const context of jobContexts) {
    if (!context.jobNumber) {
      throw new HttpError(
        500,
        "Unable to map jobs caulk summary context to a job number.",
      );
    }
    if (context.header) {
      if (!getHeaderJobId(context.header)) {
        throw new HttpError(
          500,
          "Unable to map jobs caulk summary context to a canonical job.",
        );
      }
      jobNumberHeaderCounts[context.jobNumber] =
        (jobNumberHeaderCounts[context.jobNumber] || 0) + 1;
    } else {
      legacyJobNumbers.add(context.jobNumber);
    }
  }

  for (const requirement of requirements) {
    assertSummaryRowIdentity(requirement, "requirement");
  }
  for (const allocation of allocations) {
    assertSummaryRowIdentity(allocation, "allocation");
  }
  assertNoAmbiguousUnscopedRows(
    requirements,
    "requirement",
    jobNumberHeaderCounts,
  );
  assertNoAmbiguousUnscopedRows(
    allocations,
    "allocation",
    jobNumberHeaderCounts,
  );

  collectLegacyJobNumbers(requirements, legacyJobNumbers, jobNumberFilterSet);
  collectLegacyJobNumbers(allocations, legacyJobNumbers, jobNumberFilterSet);
  const existingLegacyJobNumbers = new Set(
    jobContexts.filter((context) => !context.header).map((context) =>
      context.jobNumber
    ),
  );
  for (const jobNumber of legacyJobNumbers) {
    if (
      !jobNumberHeaderCounts[jobNumber] &&
      !existingLegacyJobNumbers.has(jobNumber)
    ) {
      jobContexts.push({ jobNumber, header: null, legacy: true });
      existingLegacyJobNumbers.add(jobNumber);
    }
  }

  const requirementsByCanonicalJobId = groupByJobId(requirements);
  const allocationsByCanonicalJobId = groupByJobId(allocations);
  const unscopedRequirementsByJobNumber = groupByJobNumber(requirements, false);
  const unscopedAllocationsByJobNumber = groupByJobNumber(allocations, false);
  const allRequirementsByJobNumber = groupByJobNumber(requirements, true);
  const allAllocationsByJobNumber = groupByJobNumber(allocations, true);
  const requirementsByJob: Record<string, any[]> = {};
  const requirementsByJobId: Record<string, any[]> = {};
  const allocationsByJob: Record<string, any[]> = {};
  const allocationsByJobId: Record<string, any[]> = {};

  for (const context of jobContexts) {
    const jobNumber = context.jobNumber;
    const jobId = context.header ? getHeaderJobId(context.header) : "";
    const scopedRequirements = context.header
      ? rowsForHeader(
        context.header,
        requirementsByCanonicalJobId,
        unscopedRequirementsByJobNumber,
        jobNumberHeaderCounts,
      )
      : allRequirementsByJobNumber[jobNumber] || [];
    const scopedAllocations = context.header
      ? rowsForHeader(
        context.header,
        allocationsByCanonicalJobId,
        unscopedAllocationsByJobNumber,
        jobNumberHeaderCounts,
      )
      : allAllocationsByJobNumber[jobNumber] || [];
    const publicRequirements = options.buildPublicRequirements(
      scopedRequirements,
      scopedAllocations,
      {
        jobNumber,
        jobWarehouse: asTrimmedString(context.header?.warehouse),
      },
    );

    if (jobId) {
      requirementsByJobId[jobId] = publicRequirements;
      allocationsByJobId[jobId] = scopedAllocations;
    } else {
      requirementsByJob[jobNumber] = publicRequirements;
      allocationsByJob[jobNumber] = scopedAllocations;
    }
  }

  return {
    jobContexts,
    requirementsByJob,
    requirementsByJobId,
    allocationsByJob,
    allocationsByJobId,
  };
}

export async function loadJobsCaulkSummary(
  orgId: string,
  jobContexts: JobsCaulkSummaryContext[],
  jobNumberFilters: unknown,
  deps: JobsCaulkSummaryDependencies,
) {
  const [requirements, allocations] = await Promise.all([
    deps.loadRequirements(orgId),
    deps.loadAllocations(orgId),
  ]);

  return projectJobsCaulkSummary({
    jobContexts,
    requirements,
    allocations,
    buildPublicRequirements: deps.buildPublicRequirements,
    jobNumberFilters: Array.isArray(jobNumberFilters) ? jobNumberFilters : [],
  });
}

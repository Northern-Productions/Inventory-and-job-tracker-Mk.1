// Purpose: DB row mappers and table-family repository functions for Edge inventory domain.
type RepositoryDeps = {
  rpcOrThrow: <T>(client: any, fn: string, params?: Record<string, unknown>) => Promise<T>;
  asTrimmedString: (value: unknown) => string;
  numericOrNull: (value: unknown) => number | null;
  integerOrZero: (value: unknown) => number;
  integerOrNull: (value: unknown) => number | null;
  formatDateValue: (value: unknown) => string;
  formatTimestamp: (value: unknown) => string;
};

export function createInventoryRepositories(deps: RepositoryDeps) {
  function normalizeAllocationKind(value: unknown) {
    return deps.asTrimmedString(value).toUpperCase() === "EXTRA" ? "EXTRA" : "REQUIREMENT";
  }

  function mapDbBoxRow(row: any) {
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      orgId: row.org_id,
      boxId: deps.asTrimmedString(row.box_id),
      warehouse: deps.asTrimmedString(row.warehouse),
      manufacturer: deps.asTrimmedString(row.manufacturer),
      filmName: deps.asTrimmedString(row.film_name),
      widthIn: deps.numericOrNull(row.width_in) ?? 0,
      initialFeet: deps.integerOrZero(row.initial_feet),
      feetAvailable: deps.integerOrZero(row.feet_available),
      lotRun: deps.asTrimmedString(row.lot_run),
      status: deps.asTrimmedString(row.status) || "ORDERED",
      orderDate: deps.formatDateValue(row.order_date),
      receivedDate: deps.formatDateValue(row.received_date),
      initialWeightLbs: deps.numericOrNull(row.initial_weight_lbs),
      lastRollWeightLbs: deps.numericOrNull(row.last_roll_weight_lbs),
      lastWeighedDate: deps.formatDateValue(row.last_weighed_date),
      filmKey: deps.asTrimmedString(row.film_key).toUpperCase(),
      coreType: deps.asTrimmedString(row.core_type),
      coreWeightLbs: deps.numericOrNull(row.core_weight_lbs),
      lfWeightLbsPerFt: deps.numericOrNull(row.lf_weight_lbs_per_ft),
      pricePerLf: deps.numericOrNull(row.price_per_lf),
      purchaseCost: deps.numericOrNull(row.purchase_cost),
      notes: deps.asTrimmedString(row.notes),
      hasEverBeenCheckedOut: Boolean(row.has_ever_been_checked_out),
      lastCheckoutJob: deps.asTrimmedString(row.last_checkout_job),
      lastCheckoutDate: deps.formatDateValue(row.last_checkout_date),
      zeroedDate: deps.formatDateValue(row.zeroed_date),
      zeroedReason: deps.asTrimmedString(row.zeroed_reason),
      zeroedBy: deps.asTrimmedString(row.zeroed_by),
      createdAt: deps.formatTimestamp(row.created_at),
      updatedAt: deps.formatTimestamp(row.updated_at),
    };
  }

  function toPublicBox(box: any) {
    return {
      boxId: box.boxId,
      warehouse: box.warehouse,
      manufacturer: box.manufacturer,
      filmName: box.filmName,
      widthIn: box.widthIn,
      initialFeet: box.initialFeet,
      feetAvailable: box.feetAvailable,
      lotRun: box.lotRun,
      status: box.status,
      orderDate: box.orderDate,
      receivedDate: box.receivedDate,
      initialWeightLbs: box.initialWeightLbs,
      lastRollWeightLbs: box.lastRollWeightLbs,
      lastWeighedDate: box.lastWeighedDate,
      filmKey: box.filmKey,
      coreType: box.coreType,
      coreWeightLbs: box.coreWeightLbs,
      lfWeightLbsPerFt: box.lfWeightLbsPerFt,
      pricePerLf: box.pricePerLf,
      purchaseCost: box.purchaseCost,
      notes: box.notes,
      hasEverBeenCheckedOut: box.hasEverBeenCheckedOut,
      lastCheckoutJob: box.lastCheckoutJob,
      lastCheckoutDate: box.lastCheckoutDate,
      zeroedDate: box.zeroedDate,
      zeroedReason: box.zeroedReason,
      zeroedBy: box.zeroedBy,
    };
  }

  function mapDbFilmCatalogRow(row: any) {
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      orgId: row.org_id,
      filmKey: deps.asTrimmedString(row.film_key).toUpperCase(),
      manufacturer: deps.asTrimmedString(row.manufacturer),
      filmName: deps.asTrimmedString(row.film_name),
      sqFtWeightLbsPerSqFt: deps.numericOrNull(row.sq_ft_weight_lbs_per_sq_ft),
      defaultCoreType: deps.asTrimmedString(row.default_core_type),
      sourceWidthIn: deps.numericOrNull(row.source_width_in),
      sourceInitialFeet: deps.integerOrNull(row.source_initial_feet),
      sourceInitialWeightLbs: deps.numericOrNull(row.source_initial_weight_lbs),
      sourceBoxId: deps.asTrimmedString(row.source_box_id),
      notes: deps.asTrimmedString(row.notes),
      updatedAt: deps.formatTimestamp(row.updated_at),
    };
  }

  function mapDbAllocationRow(row: any) {
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      orgId: row.org_id,
      allocationId: deps.asTrimmedString(row.allocation_id),
      boxId: deps.asTrimmedString(row.box_id),
      warehouse: deps.asTrimmedString(row.warehouse),
      jobId: row.job_id || null,
      jobNumber: deps.asTrimmedString(row.job_number),
      jobDate: deps.formatDateValue(row.job_date),
      allocatedFeet: deps.integerOrZero(row.allocated_feet),
      allocationKind: normalizeAllocationKind(row.allocation_kind),
      status: deps.asTrimmedString(row.status) || "ACTIVE",
      createdAt: deps.formatTimestamp(row.created_at),
      createdBy: deps.asTrimmedString(row.created_by),
      resolvedAt: deps.formatTimestamp(row.resolved_at),
      resolvedBy: deps.asTrimmedString(row.resolved_by),
      notes: deps.asTrimmedString(row.notes),
      crewLeader: deps.asTrimmedString(row.crew_leader),
      filmOrderId: deps.asTrimmedString(row.film_order_id),
    };
  }

  function toPublicAllocation(entry: any) {
    return {
      allocationId: entry.allocationId,
      boxId: entry.boxId,
      warehouse: entry.warehouse,
      jobNumber: entry.jobNumber,
      jobDate: entry.jobDate,
      crewLeader: entry.crewLeader,
      allocatedFeet: entry.allocatedFeet,
      allocationKind: normalizeAllocationKind(entry.allocationKind),
      status: entry.status,
      createdAt: entry.createdAt,
      createdBy: entry.createdBy,
      resolvedAt: entry.resolvedAt,
      resolvedBy: entry.resolvedBy,
      filmOrderId: entry.filmOrderId,
      notes: entry.notes,
    };
  }

  function mapDbFilmOrderRow(row: any) {
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      orgId: row.org_id,
      filmOrderId: deps.asTrimmedString(row.film_order_id),
      jobId: row.job_id || null,
      jobNumber: deps.asTrimmedString(row.job_number),
      warehouse: deps.asTrimmedString(row.warehouse),
      manufacturer: deps.asTrimmedString(row.manufacturer),
      filmName: deps.asTrimmedString(row.film_name),
      widthIn: deps.numericOrNull(row.width_in) ?? 0,
      requestedFeet: deps.integerOrZero(row.requested_feet),
      coveredFeet: deps.integerOrZero(row.covered_feet),
      orderedFeet: deps.integerOrZero(row.ordered_feet),
      remainingToOrderFeet: deps.integerOrZero(row.remaining_to_order_feet),
      jobDate: deps.formatDateValue(row.job_date),
      crewLeader: deps.asTrimmedString(row.crew_leader),
      status: deps.asTrimmedString(row.status) || "FILM_ORDER",
      sourceBoxId: deps.asTrimmedString(row.source_box_id),
      createdAt: deps.formatTimestamp(row.created_at),
      createdBy: deps.asTrimmedString(row.created_by),
      resolvedAt: deps.formatTimestamp(row.resolved_at),
      resolvedBy: deps.asTrimmedString(row.resolved_by),
      notes: deps.asTrimmedString(row.notes),
    };
  }

  function toPublicFilmOrder(entry: any, linkedBoxes: any[]) {
    return {
      filmOrderId: entry.filmOrderId,
      jobNumber: entry.jobNumber,
      warehouse: entry.warehouse,
      manufacturer: entry.manufacturer,
      filmName: entry.filmName,
      widthIn: entry.widthIn,
      requestedFeet: entry.requestedFeet,
      coveredFeet: entry.coveredFeet,
      orderedFeet: entry.orderedFeet,
      remainingToOrderFeet: entry.remainingToOrderFeet,
      jobDate: entry.jobDate,
      crewLeader: entry.crewLeader,
      status: entry.status,
      sourceBoxId: entry.sourceBoxId,
      createdAt: entry.createdAt,
      createdBy: entry.createdBy,
      resolvedAt: entry.resolvedAt,
      resolvedBy: entry.resolvedBy,
      notes: entry.notes,
      linkedBoxes,
    };
  }

  function mapDbJobRow(row: any) {
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      orgId: row.org_id,
      jobNumber: deps.asTrimmedString(row.job_number),
      warehouse: deps.asTrimmedString(row.warehouse),
      sections: deps.asTrimmedString(row.sections) || null,
      dueDate: deps.formatDateValue(row.due_date),
      crewLeader: deps.asTrimmedString(row.crew_leader),
      lifecycleStatus: deps.asTrimmedString(row.lifecycle_status) || "ACTIVE",
      notes: deps.asTrimmedString(row.notes),
      createdAt: deps.formatTimestamp(row.created_at),
      createdBy: deps.asTrimmedString(row.created_by),
      updatedAt: deps.formatTimestamp(row.updated_at),
      updatedBy: deps.asTrimmedString(row.updated_by),
    };
  }

  function mapDbRequirementRow(row: any) {
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      orgId: row.org_id,
      jobId: row.job_id,
      jobNumber: deps.asTrimmedString(row.job_number),
      manufacturer: deps.asTrimmedString(row.manufacturer),
      filmName: deps.asTrimmedString(row.film_name),
      widthIn: deps.numericOrNull(row.width_in) ?? 0,
      requiredFeet: deps.integerOrZero(row.required_feet),
      notes: deps.asTrimmedString(row.notes),
      createdAt: deps.formatTimestamp(row.created_at),
      createdBy: deps.asTrimmedString(row.created_by),
      updatedAt: deps.formatTimestamp(row.updated_at),
      updatedBy: deps.asTrimmedString(row.updated_by),
    };
  }

  function mapDbCaulkJobRequirementRow(row: any) {
    if (!row) {
      return null;
    }
    return {
      requirementId: deps.asTrimmedString(row.requirement_id),
      jobNumber: deps.asTrimmedString(row.job_number),
      productId: deps.asTrimmedString(row.product_id),
      manufacturerId: deps.asTrimmedString(row.manufacturer_id),
      manufacturer: deps.asTrimmedString(row.manufacturer),
      productName: deps.asTrimmedString(row.product_name),
      productCode: deps.asTrimmedString(row.product_code),
      tubesPerCase: deps.integerOrZero(row.tubes_per_case),
      requiredTubes: deps.integerOrZero(row.required_tubes),
      notes: deps.asTrimmedString(row.notes),
      updatedAt: deps.formatTimestamp(row.updated_at),
    };
  }

  function mapDbCaulkJobAllocationRow(row: any) {
    if (!row) {
      return null;
    }
    return {
      caulkAllocationId: deps.asTrimmedString(row.caulk_allocation_id),
      requirementId: deps.asTrimmedString(row.requirement_id),
      productId: deps.asTrimmedString(row.product_id),
      manufacturerId: deps.asTrimmedString(row.manufacturer_id),
      manufacturer: deps.asTrimmedString(row.manufacturer),
      productName: deps.asTrimmedString(row.product_name),
      productCode: deps.asTrimmedString(row.product_code),
      tubesPerCase: deps.integerOrZero(row.tubes_per_case),
      warehouse: deps.asTrimmedString(row.warehouse),
      allocatedTubes: deps.integerOrZero(row.allocated_tubes),
      reservedTubesRemaining: deps.integerOrZero(row.reserved_tubes_remaining),
      checkedOutTubesTotal: deps.integerOrZero(row.checked_out_tubes_total),
      returnedUnusedTubesTotal: deps.integerOrZero(row.returned_unused_tubes_total),
      usedTubesTotal: deps.integerOrZero(row.used_tubes_total),
      overageTubesTotal: deps.integerOrZero(row.overage_tubes_total),
      outstandingCheckoutTubes: deps.integerOrZero(row.outstanding_checkout_tubes),
      openCheckoutCount: deps.integerOrZero(row.open_checkout_count),
      status: deps.asTrimmedString(row.status) || "ACTIVE",
      createdAt: deps.formatTimestamp(row.created_at),
      createdBy: deps.asTrimmedString(row.created_by),
      updatedAt: deps.formatTimestamp(row.updated_at),
      updatedBy: deps.asTrimmedString(row.updated_by),
      resolvedAt: deps.formatTimestamp(row.resolved_at),
      resolvedBy: deps.asTrimmedString(row.resolved_by),
      notes: deps.asTrimmedString(row.notes),
    };
  }

  function mapDbCaulkJobCheckoutRow(row: any) {
    if (!row) {
      return null;
    }
    return {
      caulkCheckoutId: deps.asTrimmedString(row.caulk_checkout_id),
      caulkAllocationId: deps.asTrimmedString(row.caulk_allocation_id),
      productId: deps.asTrimmedString(row.product_id),
      manufacturerId: deps.asTrimmedString(row.manufacturer_id),
      manufacturer: deps.asTrimmedString(row.manufacturer),
      productName: deps.asTrimmedString(row.product_name),
      productCode: deps.asTrimmedString(row.product_code),
      tubesPerCase: deps.integerOrZero(row.tubes_per_case),
      warehouse: deps.asTrimmedString(row.warehouse),
      checkoutTubes: deps.integerOrZero(row.checkout_tubes),
      overageTubes: deps.integerOrZero(row.overage_tubes),
      status: deps.asTrimmedString(row.status) || "OPEN",
      checkedOutAt: deps.formatTimestamp(row.checked_out_at),
      checkedOutBy: deps.asTrimmedString(row.checked_out_by),
      checkedInAt: deps.formatTimestamp(row.checked_in_at),
      checkedInBy: deps.asTrimmedString(row.checked_in_by),
      unusedTubes: deps.integerOrZero(row.unused_tubes),
      usedTubes: deps.integerOrZero(row.used_tubes),
      notes: deps.asTrimmedString(row.notes),
    };
  }

  function mapDbAuditRow(row: any) {
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      orgId: row.org_id,
      logId: deps.asTrimmedString(row.log_id),
      date: deps.formatTimestamp(row.created_at),
      action: deps.asTrimmedString(row.action),
      boxId: deps.asTrimmedString(row.box_id),
      before: row.before_state || null,
      after: row.after_state || null,
      user: deps.asTrimmedString(row.actor),
      notes: deps.asTrimmedString(row.notes),
    };
  }

  function mapDbRollHistoryRow(row: any) {
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      orgId: row.org_id,
      logId: deps.asTrimmedString(row.log_id),
      boxId: deps.asTrimmedString(row.box_id),
      warehouse: deps.asTrimmedString(row.warehouse),
      manufacturer: deps.asTrimmedString(row.manufacturer),
      filmName: deps.asTrimmedString(row.film_name),
      widthIn: deps.numericOrNull(row.width_in) ?? 0,
      jobNumber: deps.asTrimmedString(row.job_number),
      checkedOutAt: deps.formatTimestamp(row.checked_out_at),
      checkedOutBy: deps.asTrimmedString(row.checked_out_by),
      checkedOutWeightLbs: deps.numericOrNull(row.checked_out_weight_lbs),
      checkedInAt: deps.formatTimestamp(row.checked_in_at),
      checkedInBy: deps.asTrimmedString(row.checked_in_by),
      checkedInWeightLbs: deps.numericOrNull(row.checked_in_weight_lbs),
      weightDeltaLbs: deps.numericOrNull(row.weight_delta_lbs),
      feetBefore: deps.integerOrZero(row.feet_before),
      feetAfter: deps.integerOrZero(row.feet_after),
      notes: deps.asTrimmedString(row.notes),
    };
  }

  async function listBoxes(client: any, orgId: string) {
    const rows = await deps.rpcOrThrow<any[]>(client, "api_acl_list_boxes", { p_org_id: orgId });
    return rows.map(mapDbBoxRow);
  }

  async function findBoxById(client: any, orgId: string, boxId: string) {
    const row = await deps.rpcOrThrow<any | null>(client, "api_acl_find_box_by_id", {
      p_org_id: orgId,
      p_box_id: boxId,
    });
    return mapDbBoxRow(row);
  }

  async function listFilmCatalog(client: any, orgId: string) {
    const rows = await deps.rpcOrThrow<any[]>(client, "api_acl_list_film_catalog", { p_org_id: orgId });
    return rows.map(mapDbFilmCatalogRow);
  }

  async function listAllocations(client: any, orgId: string) {
    const rows = await deps.rpcOrThrow<any[]>(client, "api_acl_list_allocations", { p_org_id: orgId });
    return rows.map(mapDbAllocationRow);
  }

  async function listAllocationsByBox(client: any, orgId: string, boxId: string) {
    const rows = await deps.rpcOrThrow<any[]>(client, "api_acl_list_allocations_by_box", {
      p_org_id: orgId,
      p_box_id: boxId,
    });
    return rows.map(mapDbAllocationRow);
  }

  async function listAllocationsByJob(client: any, orgId: string, jobNumber: string) {
    const rows = await deps.rpcOrThrow<any[]>(client, "api_acl_list_allocations_by_job", {
      p_org_id: orgId,
      p_job_number: jobNumber,
    });
    return rows.map(mapDbAllocationRow);
  }

  async function listAllocationsByFilmOrderId(client: any, orgId: string, filmOrderId: string) {
    const rows = await deps.rpcOrThrow<any[]>(client, "api_acl_list_allocations_by_film_order_id", {
      p_org_id: orgId,
      p_film_order_id: filmOrderId,
    });
    return rows.map(mapDbAllocationRow);
  }

  async function listAllocationsByIds(client: any, orgId: string, allocationIds: string[]) {
    const rows = await deps.rpcOrThrow<any[]>(client, "api_acl_list_allocations_by_ids", {
      p_org_id: orgId,
      p_allocation_ids: allocationIds,
    });
    return rows.map(mapDbAllocationRow);
  }

  async function listActiveAllocations(client: any, orgId: string) {
    const rows = await deps.rpcOrThrow<any[]>(client, "api_acl_list_active_allocations", { p_org_id: orgId });
    return rows.map(mapDbAllocationRow);
  }

  async function listFilmOrders(client: any, orgId: string) {
    const rows = await deps.rpcOrThrow<any[]>(client, "api_acl_list_film_orders", { p_org_id: orgId });
    return rows.map(mapDbFilmOrderRow);
  }

  async function listFilmOrdersByJob(client: any, orgId: string, jobNumber: string) {
    const rows = await deps.rpcOrThrow<any[]>(client, "api_acl_list_film_orders_by_job", {
      p_org_id: orgId,
      p_job_number: jobNumber,
    });
    return rows.map(mapDbFilmOrderRow);
  }

  async function findFilmOrderById(client: any, orgId: string, filmOrderId: string) {
    const row = await deps.rpcOrThrow<any | null>(client, "api_acl_find_film_order_by_id", {
      p_org_id: orgId,
      p_film_order_id: filmOrderId,
    });
    return mapDbFilmOrderRow(row);
  }

  async function listFilmOrderLinksByFilmOrderId(client: any, orgId: string, filmOrderId: string) {
    return await deps.rpcOrThrow<any[]>(client, "api_acl_list_film_order_links_by_film_order_id", {
      p_org_id: orgId,
      p_film_order_id: filmOrderId,
    });
  }

  async function listJobs(client: any, orgId: string) {
    const rows = await deps.rpcOrThrow<any[]>(client, "api_acl_list_jobs", { p_org_id: orgId });
    return rows.map(mapDbJobRow);
  }

  async function findJobByNumber(client: any, orgId: string, jobNumber: string) {
    const row = await deps.rpcOrThrow<any | null>(client, "api_acl_find_job_by_number", {
      p_org_id: orgId,
      p_job_number: jobNumber,
    });
    return mapDbJobRow(row);
  }

  async function listJobRequirements(client: any, orgId: string) {
    const rows = await deps.rpcOrThrow<any[]>(client, "api_acl_list_job_requirements", { p_org_id: orgId });
    return rows.map(mapDbRequirementRow);
  }

  async function listJobRequirementsByJob(client: any, orgId: string, jobNumber: string) {
    const rows = await deps.rpcOrThrow<any[]>(client, "api_acl_list_job_requirements_by_job", {
      p_org_id: orgId,
      p_job_number: jobNumber,
    });
    return rows.map(mapDbRequirementRow);
  }

  async function listJobCaulkRequirementsByJob(client: any, orgId: string, jobNumber: string) {
    const rows = await deps.rpcOrThrow<any[]>(client, "api_acl_list_job_caulk_requirements_by_job", {
      p_org_id: orgId,
      p_job_number: jobNumber,
    });
    return rows.map(mapDbCaulkJobRequirementRow);
  }

  async function listCaulkJobAllocationsByJob(client: any, orgId: string, jobNumber: string) {
    const rows = await deps.rpcOrThrow<any[]>(client, "api_acl_list_caulk_job_allocations_by_job", {
      p_org_id: orgId,
      p_job_number: jobNumber,
    });
    return rows.map(mapDbCaulkJobAllocationRow);
  }

  async function listCaulkJobCheckoutsByJob(client: any, orgId: string, jobNumber: string) {
    const rows = await deps.rpcOrThrow<any[]>(client, "api_acl_list_caulk_job_checkouts_by_job", {
      p_org_id: orgId,
      p_job_number: jobNumber,
    });
    return rows.map(mapDbCaulkJobCheckoutRow);
  }

  async function listAuditEntries(client: any, orgId: string) {
    const rows = await deps.rpcOrThrow<any[]>(client, "api_acl_list_audit_entries", { p_org_id: orgId });
    return rows.map(mapDbAuditRow);
  }

  async function listAuditEntriesByBox(client: any, orgId: string, boxId: string) {
    const rows = await deps.rpcOrThrow<any[]>(client, "api_acl_list_audit_entries_by_box", {
      p_org_id: orgId,
      p_box_id: boxId,
    });
    return rows.map(mapDbAuditRow);
  }

  async function listRollHistoryByBox(client: any, orgId: string, boxId: string) {
    const rows = await deps.rpcOrThrow<any[]>(client, "api_acl_list_roll_history_by_box", {
      p_org_id: orgId,
      p_box_id: boxId,
    });
    return rows.map(mapDbRollHistoryRow);
  }

  return {
    mapDbBoxRow,
    toPublicBox,
    mapDbFilmCatalogRow,
    mapDbAllocationRow,
    toPublicAllocation,
    mapDbFilmOrderRow,
    toPublicFilmOrder,
    mapDbJobRow,
    mapDbRequirementRow,
    mapDbCaulkJobRequirementRow,
    mapDbCaulkJobAllocationRow,
    mapDbCaulkJobCheckoutRow,
    mapDbAuditRow,
    mapDbRollHistoryRow,
    listBoxes,
    findBoxById,
    listFilmCatalog,
    listAllocations,
    listAllocationsByBox,
    listAllocationsByJob,
    listAllocationsByFilmOrderId,
    listAllocationsByIds,
    listActiveAllocations,
    listFilmOrders,
    listFilmOrdersByJob,
    findFilmOrderById,
    listFilmOrderLinksByFilmOrderId,
    listJobs,
    findJobByNumber,
    listJobRequirements,
    listJobRequirementsByJob,
    listJobCaulkRequirementsByJob,
    listCaulkJobAllocationsByJob,
    listCaulkJobCheckoutsByJob,
    listAuditEntries,
    listAuditEntriesByBox,
    listRollHistoryByBox,
  };
}

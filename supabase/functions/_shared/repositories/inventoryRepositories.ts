// Purpose: DB row mappers and table-family repository functions for Edge inventory domain.
type RepositoryDeps = {
  rpcOrThrow: <T>(client: any, fn: string, params?: Record<string, unknown>) => Promise<T>;
  asTrimmedString: (value: unknown) => string;
  numericOrNull: (value: unknown) => number | null;
  integerOrZero: (value: unknown) => number;
  integerOrNull: (value: unknown) => number | null;
  formatDateValue: (value: unknown) => string;
  formatTimestamp: (value: unknown) => string;
  listInternalBoxRecordIdsByBoxId: (orgId: string, boxIds: string[]) => Promise<Record<string, string>>;
  findRawBoxRowByBoxId?: (orgId: string, boxId: string) => Promise<Record<string, unknown> | null>;
};

export function createInventoryRepositories(deps: RepositoryDeps) {
  function isPresent<T>(value: T | null | undefined): value is T {
    return value !== null && value !== undefined;
  }

  function mapRows<T>(rows: any[], mapper: (row: any) => T | null): T[] {
    return rows.map(mapper).filter(isPresent);
  }

  function normalizeAllocationKind(value: unknown) {
    return deps.asTrimmedString(value).toUpperCase() === "EXTRA" ? "EXTRA" : "REQUIREMENT";
  }

  function normalizeAllocationSource(value: unknown) {
    const normalized = deps.asTrimmedString(value).toUpperCase();
    if (
      normalized === "AUTO_PLANNED" ||
      normalized === "FILM_ORDER_RECEIPT" ||
      normalized === "DIRECT_TO_JOB_SITE"
    ) {
      return normalized;
    }
    return "MANUAL";
  }

  function computeAllocationPlanningFeet(
    status: unknown,
    initialFeet: unknown,
    feetAvailable: unknown,
    activeAllocatedFeet: unknown,
  ) {
    const normalizedStatus = deps.asTrimmedString(status).toUpperCase();
    if (normalizedStatus === "IN_STOCK" || normalizedStatus === "TRANSFER") {
      return Math.max(0, deps.integerOrZero(feetAvailable));
    }

    if (normalizedStatus === "ORDERED") {
      return Math.max(0, deps.integerOrZero(initialFeet) - deps.integerOrZero(activeAllocatedFeet));
    }

    if (normalizedStatus === "CHECKED_OUT") {
      return Math.max(0, deps.integerOrZero(feetAvailable) - deps.integerOrZero(activeAllocatedFeet));
    }

    return 0;
  }

  function mapDbBoxRow(row: any) {
    if (!row) {
      return null;
    }
    const readValue = (...keys: string[]) => {
      for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(row, key)) {
          return row[key];
        }
      }
      return undefined;
    };
    const status = readValue("status");
    const initialFeet = readValue("initial_feet", "initialFeet");
    const feetAvailable = readValue("feet_available", "feetAvailable");
    const storedFeetAvailable = readValue("stored_feet_available", "storedFeetAvailable");
    const activeAllocatedFeet = readValue("active_allocated_feet", "activeAllocatedFeet");
    const allocationPlanningFeet = readValue("allocation_planning_feet", "allocationPlanningFeet");
    const allocatableNowFeet = readValue("allocatable_now_feet", "allocatableNowFeet");
    const allocatedWithInstallDateFeet = readValue(
      "allocated_with_install_date_feet",
      "allocatedWithInstallDateFeet",
    );
    const allocatedWithoutInstallDateFeet = readValue(
      "allocated_without_install_date_feet",
      "allocatedWithoutInstallDateFeet",
    );
    const physicalFeetAvailable = readValue("physical_feet_available", "physicalFeetAvailable");
    return {
      id: readValue("id"),
      orgId: readValue("org_id", "orgId"),
      boxId: deps.asTrimmedString(readValue("box_id", "boxId")),
      warehouse: deps.asTrimmedString(readValue("warehouse")),
      ownerCompanyId: deps.asTrimmedString(readValue("owner_company_id", "ownerCompanyId")),
      ownerCompanyCode: deps.asTrimmedString(readValue("owner_company_code", "ownerCompanyCode")).toUpperCase(),
      ownerCompanyDisplayName: deps.asTrimmedString(
        readValue("owner_company_display_name", "ownerCompanyDisplayName", "owner_company_name", "ownerCompanyName"),
      ),
      ownerCompanyIsActive:
        readValue("owner_company_is_active", "ownerCompanyIsActive") === undefined
          ? undefined
          : readValue("owner_company_is_active", "ownerCompanyIsActive") === true,
      dealer: deps.asTrimmedString(readValue("dealer")),
      manufacturer: deps.asTrimmedString(readValue("manufacturer")),
      filmName: deps.asTrimmedString(readValue("film_name", "filmName")),
      widthIn: deps.numericOrNull(readValue("width_in", "widthIn")) ?? 0,
      initialFeet: deps.integerOrZero(initialFeet),
      feetAvailable: deps.integerOrZero(feetAvailable),
      storedFeetAvailable:
        storedFeetAvailable === undefined || storedFeetAvailable === null
          ? Object.prototype.hasOwnProperty.call(row, "feet_available")
            ? deps.integerOrZero(row.feet_available)
            : null
          : deps.integerOrZero(storedFeetAvailable),
      activeAllocatedFeet: deps.integerOrZero(activeAllocatedFeet),
      allocatableNowFeet:
        allocatableNowFeet === undefined || allocatableNowFeet === null
          ? null
          : deps.integerOrZero(allocatableNowFeet),
      allocatedWithInstallDateFeet:
        allocatedWithInstallDateFeet === undefined || allocatedWithInstallDateFeet === null
          ? 0
          : deps.integerOrZero(allocatedWithInstallDateFeet),
      allocatedWithoutInstallDateFeet:
        allocatedWithoutInstallDateFeet === undefined || allocatedWithoutInstallDateFeet === null
          ? 0
          : deps.integerOrZero(allocatedWithoutInstallDateFeet),
      physicalFeetAvailable:
        physicalFeetAvailable === undefined || physicalFeetAvailable === null
          ? null
          : deps.integerOrZero(physicalFeetAvailable),
      allocationPlanningFeet:
        allocatableNowFeet !== undefined && allocatableNowFeet !== null
          ? deps.integerOrZero(allocatableNowFeet)
          : allocationPlanningFeet === undefined || allocationPlanningFeet === null
            ? computeAllocationPlanningFeet(
                status,
                initialFeet,
                feetAvailable,
                activeAllocatedFeet,
              )
            : deps.integerOrZero(allocationPlanningFeet),
      lotRun: deps.asTrimmedString(readValue("lot_run", "lotRun")),
      status: deps.asTrimmedString(status) || "ORDERED",
      orderDate: deps.formatDateValue(readValue("order_date", "orderDate")),
      receivedDate: deps.formatDateValue(readValue("received_date", "receivedDate")),
      initialWeightLbs: deps.numericOrNull(readValue("initial_weight_lbs", "initialWeightLbs")),
      lastRollWeightLbs: deps.numericOrNull(readValue("last_roll_weight_lbs", "lastRollWeightLbs")),
      lastWeighedDate: deps.formatDateValue(readValue("last_weighed_date", "lastWeighedDate")),
      filmKey: deps.asTrimmedString(readValue("film_key", "filmKey")).toUpperCase(),
      coreType: deps.asTrimmedString(readValue("core_type", "coreType")),
      coreWeightLbs: deps.numericOrNull(readValue("core_weight_lbs", "coreWeightLbs")),
      lfWeightLbsPerFt: deps.numericOrNull(readValue("lf_weight_lbs_per_ft", "lfWeightLbsPerFt")),
      pricePerLf: deps.numericOrNull(readValue("price_per_lf", "pricePerLf")),
      purchaseCost: deps.numericOrNull(readValue("purchase_cost", "purchaseCost")),
      notes: deps.asTrimmedString(readValue("notes")),
      directToJobSite: Boolean(readValue("direct_to_job_site", "directToJobSite")),
      hasLabel: readValue("has_label", "hasLabel") !== false,
      hasEverBeenCheckedOut: Boolean(readValue("has_ever_been_checked_out", "hasEverBeenCheckedOut")),
      lastCheckoutJobId: deps.asTrimmedString(readValue("last_checkout_job_id", "lastCheckoutJobId")),
      lastCheckoutJob: deps.asTrimmedString(readValue("last_checkout_job", "lastCheckoutJob")),
      lastCheckoutDate: deps.formatDateValue(readValue("last_checkout_date", "lastCheckoutDate")),
      zeroedDate: deps.formatDateValue(readValue("zeroed_date", "zeroedDate")),
      zeroedReason: deps.asTrimmedString(readValue("zeroed_reason", "zeroedReason")),
      zeroedBy: deps.asTrimmedString(readValue("zeroed_by", "zeroedBy")),
      createdAt: deps.formatTimestamp(readValue("created_at", "createdAt")),
      updatedAt: deps.formatTimestamp(readValue("updated_at", "updatedAt")),
    };
  }

  async function enrichBoxesWithInternalIds(orgId: string, boxes: any[]) {
    const missingBoxIds = Array.from(
      new Set(
        boxes
          .filter((box) => !deps.asTrimmedString(box?.id))
          .map((box) => deps.asTrimmedString(box?.boxId).toUpperCase())
          .filter(Boolean),
      ),
    );
    if (!missingBoxIds.length) {
      return boxes;
    }

    const internalIdsByBoxId = await deps.listInternalBoxRecordIdsByBoxId(orgId, missingBoxIds);
    return boxes.map((box) => {
      if (!box || deps.asTrimmedString(box.id)) {
        return box;
      }

      const normalizedBoxId = deps.asTrimmedString(box.boxId).toUpperCase();
      const internalId = deps.asTrimmedString(internalIdsByBoxId[normalizedBoxId]);
      return internalId ? { ...box, id: internalId } : box;
    });
  }

  function toPublicBox(box: any) {
    const orderedForJobs = Array.isArray(box.orderedForJobs)
      ? box.orderedForJobs
          .map((entry: any) => {
            const jobId = deps.asTrimmedString(entry?.jobId);
            const jobNumber = deps.asTrimmedString(entry?.jobNumber);
            const workScope = deps.asTrimmedString(entry?.workScope || entry?.sections);
            const sections = deps.asTrimmedString(entry?.sections || entry?.workScope);
            const phaseId = deps.asTrimmedString(entry?.phaseId);
            const phaseNumber = Number(entry?.phaseNumber);
            const orderedDate = deps.asTrimmedString(entry?.orderedDate);
            const receivedDate = deps.asTrimmedString(entry?.receivedDate);
            if (!jobNumber) {
              return null;
            }

            const orderedFeet =
              entry?.orderedFeet === null || entry?.orderedFeet === undefined || entry?.orderedFeet === ""
                ? NaN
                : Number(entry.orderedFeet);
            return {
              ...(jobId ? { jobId } : {}),
              jobNumber,
              ...(workScope ? { workScope } : {}),
              ...(sections ? { sections } : {}),
              ...(phaseId ? { phaseId } : {}),
              ...(Number.isFinite(phaseNumber) ? { phaseNumber: Math.trunc(phaseNumber) } : {}),
              filmOrderId: deps.asTrimmedString(entry?.filmOrderId),
              orderedFeet: Number.isFinite(orderedFeet) ? Math.max(0, Math.trunc(orderedFeet)) : null,
              ...(orderedDate ? { orderedDate } : {}),
              ...(receivedDate ? { receivedDate } : {}),
            };
          })
          .filter(Boolean)
      : undefined;
    const lastCheckoutWorkScope = deps.asTrimmedString(box.lastCheckoutWorkScope || box.lastCheckoutSections);
    const lastCheckoutSections = deps.asTrimmedString(box.lastCheckoutSections || box.lastCheckoutWorkScope);
    const normalizedStatus = deps.asTrimmedString(box.status).toUpperCase();
    const publicBox = {
      boxId: box.boxId,
      warehouse: box.warehouse,
      ownerCompanyId: deps.asTrimmedString(box.ownerCompanyId),
      ownerCompanyCode: deps.asTrimmedString(box.ownerCompanyCode).toUpperCase(),
      ownerCompanyDisplayName:
        deps.asTrimmedString(box.ownerCompanyDisplayName) || deps.asTrimmedString(box.ownerCompanyCode).toUpperCase(),
      ...(box.ownerCompanyIsActive === undefined ? {} : { ownerCompanyIsActive: box.ownerCompanyIsActive === true }),
      dealer: deps.asTrimmedString(box.dealer),
      manufacturer: box.manufacturer,
      filmName: box.filmName,
      widthIn: box.widthIn,
      initialFeet: box.initialFeet,
      feetAvailable: box.feetAvailable,
      physicalFeetAvailable:
        box.physicalFeetAvailable === undefined || box.physicalFeetAvailable === null
          ? normalizedStatus === "CHECKED_OUT"
            ? deps.integerOrZero(box.feetAvailable)
            : Math.max(0, deps.integerOrZero(box.feetAvailable) + deps.integerOrZero(box.allocatedWithInstallDateFeet))
          : deps.integerOrZero(box.physicalFeetAvailable),
      allocatableNowFeet:
        box.allocatableNowFeet === undefined || box.allocatableNowFeet === null
          ? computeAllocationPlanningFeet(
              box.status,
              box.initialFeet,
              box.feetAvailable,
              box.activeAllocatedFeet,
            )
          : deps.integerOrZero(box.allocatableNowFeet),
      allocatedWithInstallDateFeet: deps.integerOrZero(box.allocatedWithInstallDateFeet),
      allocatedWithoutInstallDateFeet: deps.integerOrZero(box.allocatedWithoutInstallDateFeet),
      allocationPlanningFeet:
        box.allocatableNowFeet === undefined || box.allocatableNowFeet === null
          ? computeAllocationPlanningFeet(
              box.status,
              box.initialFeet,
              box.feetAvailable,
              box.activeAllocatedFeet,
            )
          : deps.integerOrZero(box.allocatableNowFeet),
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
      directToJobSite: box.directToJobSite === true,
      hasLabel: box.hasLabel !== false,
      hasEverBeenCheckedOut: box.hasEverBeenCheckedOut,
      lastCheckoutJobId: deps.asTrimmedString(box.lastCheckoutJobId),
      lastCheckoutJob: box.lastCheckoutJob,
      ...(lastCheckoutWorkScope ? { lastCheckoutWorkScope } : {}),
      ...(lastCheckoutSections ? { lastCheckoutSections } : {}),
      lastCheckoutDate: box.lastCheckoutDate,
      zeroedDate: box.zeroedDate,
      zeroedReason: box.zeroedReason,
      zeroedBy: box.zeroedBy,
    };

    if (orderedForJobs) {
      return {
        ...publicBox,
        orderedForJobs,
      };
    }

    return publicBox;
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

  function deriveFilmOrderOrigin(sourceBoxId: unknown) {
    return deps.asTrimmedString(sourceBoxId) ? "AUTO_SHORTAGE" : "MANUAL";
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
      installDate: deps.formatDateValue(row.job_date),
      allocatedFeet: deps.integerOrZero(row.allocated_feet),
      coveredFeet: deps.integerOrZero(row.covered_feet),
      backedPhysicalFeet:
        row.backed_physical_feet === undefined || row.backed_physical_feet === null
          ? null
          : deps.integerOrZero(row.backed_physical_feet),
      reservationState: deps.asTrimmedString(row.reservation_state),
      requirementId: deps.asTrimmedString(row.requirement_id),
      allocationKind: normalizeAllocationKind(row.allocation_kind ?? row.allocationKind),
      allocationSource: normalizeAllocationSource(row.allocation_source ?? row.allocationSource),
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
    const jobId = deps.asTrimmedString(entry.jobId);
    return {
      allocationId: entry.allocationId,
      boxId: entry.boxId,
      warehouse: entry.warehouse,
      ...(jobId ? { jobId } : {}),
      jobNumber: entry.jobNumber,
      installDate: entry.installDate,
      crewLeader: entry.crewLeader,
      allocatedFeet: entry.allocatedFeet,
      coveredFeet: entry.coveredFeet,
      backedPhysicalFeet:
        entry.backedPhysicalFeet === undefined || entry.backedPhysicalFeet === null
          ? deps.integerOrZero(entry.allocatedFeet)
          : deps.integerOrZero(entry.backedPhysicalFeet),
      reservationState: deps.asTrimmedString(entry.reservationState) || "WITHOUT_INSTALL_DATE",
      requirementId: deps.asTrimmedString(entry.requirementId),
      allocationKind: normalizeAllocationKind(entry.allocationKind),
      allocationSource: normalizeAllocationSource(entry.allocationSource),
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
    const sourceBoxId = deps.asTrimmedString(row.source_box_id);
    const status = deps.asTrimmedString(row.status) || "FILM_ORDER";
    const displayStatus = deps.asTrimmedString(row.display_status ?? row.displayStatus);
    const needSource = deps.asTrimmedString(row.need_source ?? row.needSource);
    return {
      id: row.id,
      orgId: row.org_id,
      filmOrderId: deps.asTrimmedString(row.film_order_id),
      requirementId: deps.asTrimmedString(row.requirement_id),
      jobId: row.job_id || null,
      jobNumber: deps.asTrimmedString(row.job_number),
      warehouse: deps.asTrimmedString(row.warehouse),
      workScope: deps.asTrimmedString(row.work_scope || row.workScope || row.sections) || null,
      sections: deps.asTrimmedString(row.sections || row.work_scope || row.workScope) || null,
      manufacturer: deps.asTrimmedString(row.manufacturer),
      filmName: deps.asTrimmedString(row.film_name),
      widthIn: deps.numericOrNull(row.width_in) ?? 0,
      requestedFeet: deps.integerOrZero(row.requested_feet),
      coveredFeet: deps.integerOrZero(row.covered_feet),
      orderedFeet: deps.integerOrZero(row.ordered_feet),
      remainingToOrderFeet: deps.integerOrZero(row.remaining_to_order_feet),
      installDate: deps.formatDateValue(row.job_date),
      crewLeader: deps.asTrimmedString(row.crew_leader),
      status,
      ...(displayStatus
        ? {
            storedStatus: deps.asTrimmedString(row.stored_status ?? row.storedStatus) || status,
            displayStatus,
            needSource,
            neededFeet: deps.integerOrZero(row.needed_feet ?? row.neededFeet),
            fulfilledFeet: deps.integerOrZero(row.fulfilled_feet ?? row.fulfilledFeet),
            remainingFeet: deps.integerOrZero(row.remaining_feet ?? row.remainingFeet),
            overageFeet: deps.integerOrZero(row.overage_feet ?? row.overageFeet),
            manualFulfilledAt: deps.formatTimestamp(row.manual_fulfilled_at ?? row.manualFulfilledAt),
            manualFulfilledBy: deps.asTrimmedString(row.manual_fulfilled_by ?? row.manualFulfilledBy),
          }
        : {}),
      sourceBoxId,
      origin: deriveFilmOrderOrigin(sourceBoxId),
      createdAt: deps.formatTimestamp(row.created_at),
      createdBy: deps.asTrimmedString(row.created_by),
      resolvedAt: deps.formatTimestamp(row.resolved_at),
      resolvedBy: deps.asTrimmedString(row.resolved_by),
      notes: deps.asTrimmedString(row.notes),
    };
  }

  function toPublicFilmOrder(entry: any, linkedBoxes: any[]) {
    const jobId = deps.asTrimmedString(entry.jobId);
    const workScope = deps.asTrimmedString(entry.workScope || entry.sections);
    const sections = deps.asTrimmedString(entry.sections || entry.workScope);
    const displayStatus = deps.asTrimmedString(entry.displayStatus);

    return {
      filmOrderId: entry.filmOrderId,
      ...(jobId ? { jobId } : {}),
      requirementId: deps.asTrimmedString(entry.requirementId),
      jobNumber: entry.jobNumber,
      warehouse: entry.warehouse,
      ...(workScope ? { workScope } : {}),
      ...(sections ? { sections } : {}),
      manufacturer: entry.manufacturer,
      filmName: entry.filmName,
      widthIn: entry.widthIn,
      requestedFeet: entry.requestedFeet,
      coveredFeet: entry.coveredFeet,
      orderedFeet: entry.orderedFeet,
      remainingToOrderFeet: entry.remainingToOrderFeet,
      installDate: entry.installDate,
      crewLeader: entry.crewLeader,
      status: entry.status,
      ...(displayStatus
        ? {
            storedStatus: deps.asTrimmedString(entry.storedStatus) || entry.status,
            displayStatus,
            needSource: deps.asTrimmedString(entry.needSource),
            neededFeet: deps.integerOrZero(entry.neededFeet),
            fulfilledFeet: deps.integerOrZero(entry.fulfilledFeet),
            remainingFeet: deps.integerOrZero(entry.remainingFeet),
            overageFeet: deps.integerOrZero(entry.overageFeet),
            ...(deps.asTrimmedString(entry.manualFulfilledAt)
              ? { manualFulfilledAt: entry.manualFulfilledAt }
              : {}),
            ...(deps.asTrimmedString(entry.manualFulfilledBy)
              ? { manualFulfilledBy: entry.manualFulfilledBy }
              : {}),
          }
        : {}),
      sourceBoxId: entry.sourceBoxId,
      origin: deriveFilmOrderOrigin(entry.sourceBoxId),
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
      workScope: deps.asTrimmedString(row.sections) || null,
      workScopeKey: deps.asTrimmedString(row.work_scope_key) || undefined,
      sections: deps.asTrimmedString(row.sections) || null,
      installDate: deps.formatDateValue(row.due_date),
      crewLeader: deps.asTrimmedString(row.crew_leader),
      lifecycleStatus: deps.asTrimmedString(row.lifecycle_status) || "ACTIVE",
      isLaborOnly: row.is_labor_only === true,
      isStagedForPickup: row.is_staged_for_pickup === true,
      notes: deps.asTrimmedString(row.notes),
      createdAt: deps.formatTimestamp(row.created_at),
      createdBy: deps.asTrimmedString(row.created_by),
      updatedAt: deps.formatTimestamp(row.updated_at),
      updatedBy: deps.asTrimmedString(row.updated_by),
    };
  }

  function mapDbJobPhaseRow(row: any) {
    if (!row) {
      return null;
    }
    const laborStatus = deps.asTrimmedString(row.labor_status).toUpperCase() === "COMPLETE" ? "COMPLETE" : "ACTIVE";
    const workflowStatus = deps.asTrimmedString(row.workflow_status).toUpperCase() === "PLACEHOLDER" ? "PLACEHOLDER" : "ACTIVE";
    return {
      phaseId: row.id,
      id: row.id,
      orgId: row.org_id,
      jobId: row.job_id,
      phaseNumber: deps.integerOrZero(row.phase_number),
      workScope: deps.asTrimmedString(row.sections) || null,
      sections: deps.asTrimmedString(row.sections) || null,
      installDate: deps.formatDateValue(row.install_date),
      installEndDate: deps.formatDateValue(row.install_end_date),
      crewLeader: deps.asTrimmedString(row.crew_leader),
      laborStatus,
      workflowStatus,
      isPlaceholder: workflowStatus === "PLACEHOLDER",
      isWorkflowActive: workflowStatus === "ACTIVE",
      isComplete: laborStatus === "COMPLETE",
      isPrimary: row.is_primary === true,
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
    const status = deps.asTrimmedString(row.status).toUpperCase() === "COMPLETE" ? "COMPLETE" : "ACTIVE";
    return {
      id: row.id,
      orgId: row.org_id,
      jobId: row.job_id,
      phaseId: deps.asTrimmedString(row.phase_id),
      phaseNumber: deps.integerOrZero(row.phase_number),
      phaseWorkScope: deps.asTrimmedString(row.phase_sections || row.phase_work_scope) || null,
      phaseInstallDate: deps.formatDateValue(row.phase_install_date),
      phaseCrewLeader: deps.asTrimmedString(row.phase_crew_leader),
      jobNumber: deps.asTrimmedString(row.job_number),
      manufacturer: deps.asTrimmedString(row.manufacturer),
      filmName: deps.asTrimmedString(row.film_name),
      widthIn: deps.numericOrNull(row.width_in) ?? 0,
      requiredFeet: deps.integerOrZero(row.required_feet),
      status,
      isComplete: status === "COMPLETE",
      actualUsedFeet: deps.integerOrZero(row.actual_used_feet),
      completedAt: deps.formatTimestamp(row.completed_at),
      completedBy: deps.asTrimmedString(row.completed_by),
      notes: deps.asTrimmedString(row.notes),
      autoPlanningSuppressed: row.auto_planning_suppressed === true,
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
    const status = deps.asTrimmedString(row.status).toUpperCase() === "COMPLETE" ? "COMPLETE" : "ACTIVE";
    return {
      requirementId: deps.asTrimmedString(row.requirement_id),
      jobId: row.job_id || null,
      phaseId: deps.asTrimmedString(row.phase_id),
      phaseNumber: deps.integerOrZero(row.phase_number),
      phaseWorkScope: deps.asTrimmedString(row.phase_sections || row.phase_work_scope) || null,
      phaseInstallDate: deps.formatDateValue(row.phase_install_date),
      phaseCrewLeader: deps.asTrimmedString(row.phase_crew_leader),
      jobNumber: deps.asTrimmedString(row.job_number),
      productId: deps.asTrimmedString(row.product_id),
      manufacturerId: deps.asTrimmedString(row.manufacturer_id),
      manufacturer: deps.asTrimmedString(row.manufacturer),
      productName: deps.asTrimmedString(row.product_name),
      productCode: deps.asTrimmedString(row.product_code),
      tubesPerCase: deps.integerOrZero(row.tubes_per_case),
      requiredTubes: deps.integerOrZero(row.required_tubes),
      status,
      isComplete: status === "COMPLETE",
      actualUsedTubes: deps.integerOrZero(row.actual_used_tubes),
      completedAt: deps.formatTimestamp(row.completed_at),
      completedBy: deps.asTrimmedString(row.completed_by),
      autoPlanningSuppressed: row.auto_planning_suppressed === true,
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
      jobId: row.job_id || null,
      jobNumber: deps.asTrimmedString(row.job_number),
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
      allocationSource: normalizeAllocationSource(row.allocation_source ?? row.allocationSource),
      createdAt: deps.formatTimestamp(row.created_at),
      createdBy: deps.asTrimmedString(row.created_by),
      updatedAt: deps.formatTimestamp(row.updated_at),
      updatedBy: deps.asTrimmedString(row.updated_by),
      resolvedAt: deps.formatTimestamp(row.resolved_at),
      resolvedBy: deps.asTrimmedString(row.resolved_by),
      notes: deps.asTrimmedString(row.notes),
      pendingTransfer: deps.asTrimmedString(row.pending_transfer_id)
        ? {
            transferId: deps.asTrimmedString(row.pending_transfer_id),
            status: "PENDING",
            sourceWarehouse: deps.asTrimmedString(row.pending_transfer_source_warehouse).toUpperCase(),
            destinationWarehouse: deps.asTrimmedString(
              row.pending_transfer_destination_warehouse || row.warehouse
            ).toUpperCase(),
            pendingTubes: deps.integerOrZero(row.pending_transfer_tubes),
            startedAt: deps.formatTimestamp(row.pending_transfer_started_at),
            startedBy: deps.asTrimmedString(row.pending_transfer_started_by),
            notes: deps.asTrimmedString(row.pending_transfer_notes),
          }
        : null,
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
      jobId: deps.asTrimmedString(row.job_id),
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
    return await enrichBoxesWithInternalIds(orgId, mapRows(rows, mapDbBoxRow));
  }

  async function loadAllocationPreviewCandidateSnapshot(
    client: any,
    orgId: string,
    payload: Record<string, unknown>,
  ) {
    const result = await deps.rpcOrThrow<Record<string, unknown>>(
      client,
      "api_acl_allocation_preview_candidates",
      {
        p_org_id: orgId,
        p_payload: payload,
      },
    );
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new Error("Allocation preview candidates did not return a valid snapshot.");
    }

    const source = mapDbBoxRow(result.source);
    if (!source) {
      throw new Error("The allocation source changed while preview was loading. Reload and retry.");
    }

    return {
      source,
      boxes: mapRows(Array.isArray(result.boxes) ? result.boxes : [], mapDbBoxRow),
      allocations: Array.isArray(result.allocations) ? result.allocations : [],
      pendingTransfersByBoxRecordId:
        result.pendingTransfersByBoxRecordId &&
        typeof result.pendingTransfersByBoxRecordId === "object" &&
        !Array.isArray(result.pendingTransfersByBoxRecordId)
          ? result.pendingTransfersByBoxRecordId
          : {},
      candidateMetadata: Array.isArray(result.candidateMetadata) ? result.candidateMetadata : [],
      context:
        result.context && typeof result.context === "object" && !Array.isArray(result.context)
          ? result.context
          : {},
      scope:
        result.scope && typeof result.scope === "object" && !Array.isArray(result.scope)
          ? result.scope
          : {},
    };
  }

  async function findBoxById(client: any, orgId: string, boxId: string) {
    const row = await deps.rpcOrThrow<any | null>(client, "api_acl_find_box_by_id", {
      p_org_id: orgId,
      p_box_id: boxId,
    });
    const boxes = await enrichBoxesWithInternalIds(orgId, mapRows([row], mapDbBoxRow));
    const box = boxes[0] || null;
    if (!box || typeof deps.findRawBoxRowByBoxId !== "function") {
      return box;
    }

    const rawRow = await deps.findRawBoxRowByBoxId(orgId, box.boxId);
    if (!rawRow || !Object.prototype.hasOwnProperty.call(rawRow, "feet_available")) {
      return box;
    }

    return {
      ...box,
      storedFeetAvailable: deps.integerOrZero(rawRow.feet_available),
    };
  }

  async function listFilmCatalog(client: any, orgId: string) {
    const rows = await deps.rpcOrThrow<any[]>(client, "api_acl_list_film_catalog", { p_org_id: orgId });
    return mapRows(rows, mapDbFilmCatalogRow);
  }

  async function listAllocations(client: any, orgId: string) {
    const rows = await deps.rpcOrThrow<any[]>(client, "api_acl_list_allocations", { p_org_id: orgId });
    return mapRows(rows, mapDbAllocationRow);
  }

  async function listAllocationsByBox(client: any, orgId: string, boxId: string) {
    const rows = await deps.rpcOrThrow<any[]>(client, "api_acl_list_allocations_by_box", {
      p_org_id: orgId,
      p_box_id: boxId,
    });
    return mapRows(rows, mapDbAllocationRow);
  }

  async function listAllocationsByJob(client: any, orgId: string, jobNumber: string) {
    const rows = await deps.rpcOrThrow<any[]>(client, "api_acl_list_allocations_by_job", {
      p_org_id: orgId,
      p_job_number: jobNumber,
    });
    return mapRows(rows, mapDbAllocationRow);
  }

  async function listAllocationsByFilmOrderId(client: any, orgId: string, filmOrderId: string) {
    const rows = await deps.rpcOrThrow<any[]>(client, "api_acl_list_allocations_by_film_order_id", {
      p_org_id: orgId,
      p_film_order_id: filmOrderId,
    });
    return mapRows(rows, mapDbAllocationRow);
  }

  async function listAllocationsByIds(client: any, orgId: string, allocationIds: string[]) {
    const rows = await deps.rpcOrThrow<any[]>(client, "api_acl_list_allocations_by_ids", {
      p_org_id: orgId,
      p_allocation_ids: allocationIds,
    });
    return mapRows(rows, mapDbAllocationRow);
  }

  async function listActiveAllocations(client: any, orgId: string) {
    const rows = await deps.rpcOrThrow<any[]>(client, "api_acl_list_active_allocations", { p_org_id: orgId });
    return mapRows(rows, mapDbAllocationRow);
  }

  async function listFilmOrders(client: any, orgId: string, options: { warehouse?: unknown } = {}) {
    const rows = await deps.rpcOrThrow<any[]>(client, "api_acl_list_film_orders", {
      p_org_id: orgId,
      p_warehouse: deps.asTrimmedString(options.warehouse) || null,
    });
    return mapRows(rows, mapDbFilmOrderRow);
  }

  async function listFilmOrdersByJob(client: any, orgId: string, jobNumber: string) {
    const rows = await deps.rpcOrThrow<any[]>(client, "api_acl_list_film_orders_by_job", {
      p_org_id: orgId,
      p_job_number: jobNumber,
    });
    return mapRows(rows, mapDbFilmOrderRow);
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

  async function listJobs(client: any, orgId: string, options: { warehouse?: unknown } = {}) {
    const rows = await deps.rpcOrThrow<any[]>(client, "api_acl_list_jobs", {
      p_org_id: orgId,
      p_warehouse: deps.asTrimmedString(options.warehouse) || null,
    });
    return mapRows(rows, mapDbJobRow);
  }

  async function listJobsByIds(client: any, orgId: string, jobIds: string[]) {
    const normalizedJobIds = Array.from(
      new Set((Array.isArray(jobIds) ? jobIds : []).map((entry) => deps.asTrimmedString(entry)).filter(Boolean)),
    );
    if (!normalizedJobIds.length) {
      return [];
    }
    const rows = await deps.rpcOrThrow<any[]>(client, "api_acl_list_jobs_by_ids", {
      p_org_id: orgId,
      p_job_ids: normalizedJobIds,
    });
    return mapRows(rows, mapDbJobRow);
  }

  async function listJobsByNumbers(client: any, orgId: string, jobNumbers: string[]) {
    const normalizedJobNumbers = Array.from(
      new Set((Array.isArray(jobNumbers) ? jobNumbers : []).map((entry) => deps.asTrimmedString(entry)).filter(Boolean)),
    );
    if (!normalizedJobNumbers.length) {
      return [];
    }
    const rows = await deps.rpcOrThrow<any[]>(client, "api_acl_list_jobs_by_numbers", {
      p_org_id: orgId,
      p_job_numbers: normalizedJobNumbers,
    });
    return mapRows(rows, mapDbJobRow);
  }

  function mapJobNumberCandidates(value: unknown) {
    return Array.from(
      new Set(
        (Array.isArray(value) ? value : [])
          .map((entry) => deps.asTrimmedString(entry))
          .filter(Boolean),
      ),
    );
  }

  async function listJobSearchCandidateNumbers(
    client: any,
    orgId: string,
    query: string,
    lifecycleStatus: string,
    warehouse?: unknown,
  ) {
    return mapJobNumberCandidates(
      await deps.rpcOrThrow<unknown>(client, "api_acl_job_search_candidate_numbers", {
        p_org_id: orgId,
        p_query: query,
        p_lifecycle_status: lifecycleStatus,
        p_warehouse: deps.asTrimmedString(warehouse) || null,
      }),
    );
  }

  async function listJobCalendarCandidateNumbers(
    client: any,
    orgId: string,
    rangeStart: string,
    rangeEnd: string,
    lifecycleStatus: string,
    warehouse?: unknown,
  ) {
    return mapJobNumberCandidates(
      await deps.rpcOrThrow<unknown>(client, "api_acl_job_calendar_candidate_numbers", {
        p_org_id: orgId,
        p_range_start: rangeStart,
        p_range_end: rangeEnd,
        p_lifecycle_status: lifecycleStatus,
        p_warehouse: deps.asTrimmedString(warehouse) || null,
      }),
    );
  }

  async function listJobAttentionCandidateNumbers(client: any, orgId: string) {
    return mapJobNumberCandidates(
      await deps.rpcOrThrow<unknown>(client, "api_acl_job_attention_candidate_numbers", {
        p_org_id: orgId,
      }),
    );
  }

  async function loadJobSummarySnapshot(
    client: any,
    orgId: string,
    jobIds: string[],
    options: { includeLegacy?: boolean; legacyJobNumbers?: string[]; includePhases?: boolean } = {},
  ) {
    const normalizedJobIds = Array.from(
      new Set((Array.isArray(jobIds) ? jobIds : []).map((entry) => deps.asTrimmedString(entry)).filter(Boolean)),
    );
    const normalizedLegacyJobNumbers = Array.from(
      new Set(
        (Array.isArray(options.legacyJobNumbers) ? options.legacyJobNumbers : [])
          .map((entry) => deps.asTrimmedString(entry))
          .filter(Boolean),
      ),
    );
    const snapshot = await deps.rpcOrThrow<Record<string, unknown>>(client, "api_acl_job_summary_snapshot", {
      p_org_id: orgId,
      p_job_ids: normalizedJobIds,
      p_include_legacy: options.includeLegacy !== false,
      p_legacy_job_numbers: normalizedLegacyJobNumbers,
      p_include_phases: options.includePhases !== false,
    });
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
      throw new Error("Job summary snapshot did not return a valid object.");
    }

    return {
      allocations: mapRows(Array.isArray(snapshot.allocations) ? snapshot.allocations : [], mapDbAllocationRow),
      filmOrders: mapRows(Array.isArray(snapshot.filmOrders) ? snapshot.filmOrders : [], mapDbFilmOrderRow),
      phases: mapRows(Array.isArray(snapshot.phases) ? snapshot.phases : [], mapDbJobPhaseRow),
      requirements: mapRows(Array.isArray(snapshot.requirements) ? snapshot.requirements : [], mapDbRequirementRow),
    };
  }

  async function loadBoxReservationSnapshot(
    client: any,
    orgId: string,
    options: { boxIds?: string[]; allocationIds?: string[] } = {},
  ) {
    const boxIds = Array.from(
      new Set(
        (Array.isArray(options.boxIds) ? options.boxIds : [])
          .map((entry) => deps.asTrimmedString(entry).toUpperCase())
          .filter(Boolean),
      ),
    );
    const allocationIds = Array.from(
      new Set(
        (Array.isArray(options.allocationIds) ? options.allocationIds : [])
          .map((entry) => deps.asTrimmedString(entry))
          .filter(Boolean),
      ),
    );
    if (!boxIds.length && !allocationIds.length) {
      return { selectedAllocations: [], allocations: [], boxes: [], jobs: [] };
    }

    const snapshot = await deps.rpcOrThrow<Record<string, unknown>>(client, "api_acl_box_reservation_snapshot", {
      p_org_id: orgId,
      p_box_ids: boxIds,
      p_allocation_ids: allocationIds,
    });
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
      throw new Error("Box reservation snapshot did not return a valid object.");
    }

    return {
      selectedAllocations: mapRows(
        Array.isArray(snapshot.selectedAllocations) ? snapshot.selectedAllocations : [],
        mapDbAllocationRow,
      ),
      allocations: mapRows(Array.isArray(snapshot.allocations) ? snapshot.allocations : [], mapDbAllocationRow),
      boxes: await enrichBoxesWithInternalIds(
        orgId,
        mapRows(Array.isArray(snapshot.boxes) ? snapshot.boxes : [], mapDbBoxRow),
      ),
      jobs: mapRows(Array.isArray(snapshot.jobs) ? snapshot.jobs : [], mapDbJobRow),
    };
  }

  async function hasFilmOrdersNeedingAttention(client: any, orgId: string) {
    return Boolean(
      await deps.rpcOrThrow<boolean>(client, "api_acl_has_film_orders_needing_attention", {
        p_org_id: orgId,
      }),
    );
  }

  async function listJobsCalendar(client: any, orgId: string, month: string, lifecycleStatus?: unknown) {
    const rows = await deps.rpcOrThrow<any[]>(client, "api_acl_list_jobs_calendar", {
      p_org_id: orgId,
      p_month: month,
      p_lifecycle_status: lifecycleStatus ?? null,
    });
    return mapRows(rows, mapDbJobRow);
  }

  async function findJobByNumber(client: any, orgId: string, jobNumber: string) {
    const row = await deps.rpcOrThrow<any | null>(client, "api_acl_find_job_by_number", {
      p_org_id: orgId,
      p_job_number: jobNumber,
    });
    return mapDbJobRow(row);
  }

  async function findJobById(client: any, orgId: string, jobId: string) {
    const row = await deps.rpcOrThrow<any | null>(client, "api_acl_find_job_by_id", {
      p_org_id: orgId,
      p_job_id: jobId,
    });
    return mapDbJobRow(row);
  }

  async function listJobPhases(client: any, orgId: string) {
    const rows = await deps.rpcOrThrow<any[]>(client, "api_acl_list_job_phases", { p_org_id: orgId });
    return mapRows(rows, mapDbJobPhaseRow);
  }

  async function listJobPhasesByJob(client: any, orgId: string, jobNumber: string) {
    const rows = await deps.rpcOrThrow<any[]>(client, "api_acl_list_job_phases_by_job", {
      p_org_id: orgId,
      p_job_number: jobNumber,
    });
    return mapRows(rows, mapDbJobPhaseRow);
  }

  async function listJobPhasesByJobId(client: any, orgId: string, jobId: string) {
    const rows = await deps.rpcOrThrow<any[]>(client, "api_acl_list_job_phases_by_job_id", {
      p_org_id: orgId,
      p_job_id: jobId,
    });
    return mapRows(rows, mapDbJobPhaseRow);
  }

  async function listJobRequirements(client: any, orgId: string) {
    const rows = await deps.rpcOrThrow<any[]>(client, "api_acl_list_job_requirements", { p_org_id: orgId });
    return mapRows(rows, mapDbRequirementRow);
  }

  async function listJobRequirementsByJob(client: any, orgId: string, jobNumber: string) {
    const rows = await deps.rpcOrThrow<any[]>(client, "api_acl_list_job_requirements_by_job", {
      p_org_id: orgId,
      p_job_number: jobNumber,
    });
    return mapRows(rows, mapDbRequirementRow);
  }

  async function listJobCaulkRequirementsByJob(client: any, orgId: string, jobNumber: string) {
    const rows = await deps.rpcOrThrow<any[]>(client, "api_acl_list_job_caulk_requirements_by_job", {
      p_org_id: orgId,
      p_job_number: jobNumber,
    });
    return mapRows(rows, mapDbCaulkJobRequirementRow);
  }

  async function listCaulkJobAllocationsByJob(client: any, orgId: string, jobNumber: string) {
    const rows = await deps.rpcOrThrow<any[]>(client, "api_acl_list_caulk_job_allocations_by_job", {
      p_org_id: orgId,
      p_job_number: jobNumber,
    });
    return mapRows(rows, mapDbCaulkJobAllocationRow);
  }

  async function listCaulkJobCheckoutsByJob(client: any, orgId: string, jobNumber: string) {
    const rows = await deps.rpcOrThrow<any[]>(client, "api_acl_list_caulk_job_checkouts_by_job", {
      p_org_id: orgId,
      p_job_number: jobNumber,
    });
    return mapRows(rows, mapDbCaulkJobCheckoutRow);
  }

  async function listAuditEntries(client: any, orgId: string) {
    const rows = await deps.rpcOrThrow<any[]>(client, "api_acl_list_audit_entries", { p_org_id: orgId });
    return mapRows(rows, mapDbAuditRow);
  }

  async function listAuditEntriesByBox(client: any, orgId: string, boxId: string) {
    const rows = await deps.rpcOrThrow<any[]>(client, "api_acl_list_audit_entries_by_box", {
      p_org_id: orgId,
      p_box_id: boxId,
    });
    return mapRows(rows, mapDbAuditRow);
  }

  async function listRollHistoryByBox(client: any, orgId: string, boxId: string) {
    const rows = await deps.rpcOrThrow<any[]>(client, "api_acl_list_roll_history_by_box", {
      p_org_id: orgId,
      p_box_id: boxId,
    });
    return mapRows(rows, mapDbRollHistoryRow);
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
    mapDbJobPhaseRow,
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
    listJobsByIds,
    listJobsByNumbers,
    listJobSearchCandidateNumbers,
    listJobCalendarCandidateNumbers,
    listJobAttentionCandidateNumbers,
    loadJobSummarySnapshot,
    loadBoxReservationSnapshot,
    hasFilmOrdersNeedingAttention,
    listJobsCalendar,
    findJobByNumber,
    findJobById,
    listJobPhases,
    listJobPhasesByJob,
    listJobPhasesByJobId,
    listJobRequirements,
    listJobRequirementsByJob,
    listJobCaulkRequirementsByJob,
    listCaulkJobAllocationsByJob,
    listCaulkJobCheckoutsByJob,
    listAuditEntries,
    listAuditEntriesByBox,
    listRollHistoryByBox,
    loadAllocationPreviewCandidateSnapshot,
  };
}

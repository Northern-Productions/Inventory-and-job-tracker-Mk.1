import {
  asTrimmedString,
  computeAllocationPlanningFeet,
  formatDateValue,
  formatTimestamp,
  getBoxAllocationPlanningFeet,
  integerOrNull,
  integerOrZero,
  normalizeAllocationKind,
  normalizeAllocationSource,
  numericOrNull,
} from '../core/helpers.mjs';
import { canonicalizeManufacturerLabel } from '../core/catalog.mjs';

function mapDbBoxRow(row) {
  if (!row) {
    return null;
  }

  const readValue = (...keys) => {
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(row, key)) {
        return row[key];
      }
    }
    return undefined;
  };

  const status = readValue('status');
  const initialFeet = readValue('initial_feet', 'initialFeet');
  const feetAvailable = readValue('feet_available', 'feetAvailable');
  const activeAllocatedFeet = readValue('active_allocated_feet', 'activeAllocatedFeet');
  const allocationPlanningFeet = readValue('allocation_planning_feet', 'allocationPlanningFeet');
  const allocatableNowFeet = readValue('allocatable_now_feet', 'allocatableNowFeet');
  const allocatedWithInstallDateFeet = readValue(
    'allocated_with_install_date_feet',
    'allocatedWithInstallDateFeet'
  );
  const allocatedWithoutInstallDateFeet = readValue(
    'allocated_without_install_date_feet',
    'allocatedWithoutInstallDateFeet'
  );
  const physicalFeetAvailable = readValue('physical_feet_available', 'physicalFeetAvailable');

  return {
    id: readValue('id'),
    orgId: readValue('org_id', 'orgId'),
    boxId: asTrimmedString(readValue('box_id', 'boxId')),
    warehouse: asTrimmedString(readValue('warehouse')),
    dealer: asTrimmedString(readValue('dealer')),
    manufacturer: canonicalizeManufacturerLabel(readValue('manufacturer')),
    filmName: asTrimmedString(readValue('film_name', 'filmName')),
    widthIn: numericOrNull(readValue('width_in', 'widthIn')) ?? 0,
    initialFeet: integerOrZero(initialFeet),
    feetAvailable: integerOrZero(feetAvailable),
    activeAllocatedFeet: integerOrZero(activeAllocatedFeet),
    allocatableNowFeet:
      allocatableNowFeet === undefined || allocatableNowFeet === null
        ? null
        : integerOrZero(allocatableNowFeet),
    allocatedWithInstallDateFeet:
      allocatedWithInstallDateFeet === undefined || allocatedWithInstallDateFeet === null
        ? 0
        : integerOrZero(allocatedWithInstallDateFeet),
    allocatedWithoutInstallDateFeet:
      allocatedWithoutInstallDateFeet === undefined || allocatedWithoutInstallDateFeet === null
        ? 0
        : integerOrZero(allocatedWithoutInstallDateFeet),
    physicalFeetAvailable:
      physicalFeetAvailable === undefined || physicalFeetAvailable === null
        ? null
        : integerOrZero(physicalFeetAvailable),
    allocationPlanningFeet:
      allocatableNowFeet !== undefined && allocatableNowFeet !== null
        ? integerOrZero(allocatableNowFeet)
        : allocationPlanningFeet === undefined || allocationPlanningFeet === null
          ? computeAllocationPlanningFeet(
              status,
              initialFeet,
              feetAvailable,
              activeAllocatedFeet
            )
          : integerOrZero(allocationPlanningFeet),
    lotRun: asTrimmedString(readValue('lot_run', 'lotRun')),
    status: asTrimmedString(status) || 'ORDERED',
    orderDate: formatDateValue(readValue('order_date', 'orderDate')),
    receivedDate: formatDateValue(readValue('received_date', 'receivedDate')),
    initialWeightLbs: numericOrNull(readValue('initial_weight_lbs', 'initialWeightLbs')),
    lastRollWeightLbs: numericOrNull(readValue('last_roll_weight_lbs', 'lastRollWeightLbs')),
    lastWeighedDate: formatDateValue(readValue('last_weighed_date', 'lastWeighedDate')),
    filmKey: asTrimmedString(readValue('film_key', 'filmKey')).toUpperCase(),
    coreType: asTrimmedString(readValue('core_type', 'coreType')),
    coreWeightLbs: numericOrNull(readValue('core_weight_lbs', 'coreWeightLbs')),
    lfWeightLbsPerFt: numericOrNull(readValue('lf_weight_lbs_per_ft', 'lfWeightLbsPerFt')),
    pricePerLf: numericOrNull(readValue('price_per_lf', 'pricePerLf')),
    purchaseCost: numericOrNull(readValue('purchase_cost', 'purchaseCost')),
    notes: asTrimmedString(readValue('notes')),
    directToJobSite: Boolean(readValue('direct_to_job_site', 'directToJobSite')),
    hasLabel: readValue('has_label', 'hasLabel') !== false,
    hasEverBeenCheckedOut: Boolean(readValue('has_ever_been_checked_out', 'hasEverBeenCheckedOut')),
    lastCheckoutJobId: asTrimmedString(readValue('last_checkout_job_id', 'lastCheckoutJobId')),
    lastCheckoutJob: asTrimmedString(readValue('last_checkout_job', 'lastCheckoutJob')),
    lastCheckoutDate: formatDateValue(readValue('last_checkout_date', 'lastCheckoutDate')),
    zeroedDate: formatDateValue(readValue('zeroed_date', 'zeroedDate')),
    zeroedReason: asTrimmedString(readValue('zeroed_reason', 'zeroedReason')),
    zeroedBy: asTrimmedString(readValue('zeroed_by', 'zeroedBy')),
    createdAt: formatTimestamp(readValue('created_at', 'createdAt')),
    updatedAt: formatTimestamp(readValue('updated_at', 'updatedAt')),
  };
}

function toPublicBox(box) {
  const orderedForJobs = Array.isArray(box.orderedForJobs)
    ? box.orderedForJobs
        .map((entry) => {
          const jobId = asTrimmedString(entry?.jobId);
          const jobNumber = asTrimmedString(entry?.jobNumber);
          if (!jobNumber) {
            return null;
          }

          const orderedFeet =
            entry?.orderedFeet === null || entry?.orderedFeet === undefined || entry?.orderedFeet === ''
              ? NaN
              : Number(entry.orderedFeet);
          return {
            ...(jobId ? { jobId } : {}),
            jobNumber,
            filmOrderId: asTrimmedString(entry?.filmOrderId),
            orderedFeet: Number.isFinite(orderedFeet) ? Math.max(0, Math.trunc(orderedFeet)) : null,
          };
        })
        .filter(Boolean)
    : undefined;
  const publicBox = {
    boxId: box.boxId,
    warehouse: box.warehouse,
    dealer: asTrimmedString(box.dealer),
    manufacturer: box.manufacturer,
    filmName: box.filmName,
    widthIn: box.widthIn,
    initialFeet: box.initialFeet,
    feetAvailable: box.feetAvailable,
    physicalFeetAvailable:
      box.physicalFeetAvailable === undefined || box.physicalFeetAvailable === null
        ? Math.max(0, integerOrZero(box.feetAvailable) + integerOrZero(box.allocatedWithInstallDateFeet))
        : integerOrZero(box.physicalFeetAvailable),
    allocatableNowFeet:
      box.allocatableNowFeet === undefined || box.allocatableNowFeet === null
        ? getBoxAllocationPlanningFeet(box)
        : integerOrZero(box.allocatableNowFeet),
    allocatedWithInstallDateFeet: integerOrZero(box.allocatedWithInstallDateFeet),
    allocatedWithoutInstallDateFeet: integerOrZero(box.allocatedWithoutInstallDateFeet),
    allocationPlanningFeet:
      box.allocatableNowFeet === undefined || box.allocatableNowFeet === null
        ? getBoxAllocationPlanningFeet(box)
        : integerOrZero(box.allocatableNowFeet),
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
    lastCheckoutJobId: asTrimmedString(box.lastCheckoutJobId),
    lastCheckoutJob: box.lastCheckoutJob,
    lastCheckoutDate: box.lastCheckoutDate,
    zeroedDate: box.zeroedDate,
    zeroedReason: box.zeroedReason,
    zeroedBy: box.zeroedBy,
  };

  if (orderedForJobs) {
    publicBox.orderedForJobs = orderedForJobs;
  }

  return publicBox;
}

function mapDbBoxTransferRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    orgId: row.org_id,
    transferId: asTrimmedString(row.transfer_id).toUpperCase(),
    boxRecordId: row.box_record_id,
    sourceBoxId: asTrimmedString(row.source_box_id).toUpperCase(),
    destinationBoxId: asTrimmedString(row.destination_box_id).toUpperCase(),
    sourceWarehouse: asTrimmedString(row.source_warehouse).toUpperCase(),
    destinationWarehouse: asTrimmedString(row.destination_warehouse).toUpperCase(),
    status: asTrimmedString(row.status).toUpperCase() || 'PENDING',
    notes: asTrimmedString(row.notes),
    autoPlanningSuppressed: row.auto_planning_suppressed === true,
    createdAt: formatTimestamp(row.created_at),
    createdBy: asTrimmedString(row.created_by),
    receivedAt: formatTimestamp(row.received_at),
    receivedBy: asTrimmedString(row.received_by),
    cancelledAt: formatTimestamp(row.cancelled_at),
    cancelledBy: asTrimmedString(row.cancelled_by),
    updatedAt: formatTimestamp(row.updated_at),
    updatedBy: asTrimmedString(row.updated_by),
  };
}

function toPublicBoxTransfer(transfer) {
  if (!transfer) {
    return null;
  }

  return {
    transferId: transfer.transferId,
    boxId: transfer.status === 'RECEIVED' ? transfer.destinationBoxId : transfer.sourceBoxId,
    sourceBoxId: transfer.sourceBoxId,
    destinationBoxId: transfer.destinationBoxId,
    sourceWarehouse: transfer.sourceWarehouse,
    destinationWarehouse: transfer.destinationWarehouse,
    status: transfer.status,
    createdAt: transfer.createdAt,
    createdBy: transfer.createdBy,
    receivedAt: transfer.receivedAt,
    receivedBy: transfer.receivedBy,
    cancelledAt: transfer.cancelledAt,
    cancelledBy: transfer.cancelledBy,
    notes: transfer.notes,
  };
}

function mapDbFilmCatalogRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    orgId: row.org_id,
    filmKey: asTrimmedString(row.film_key).toUpperCase(),
    manufacturer: canonicalizeManufacturerLabel(row.manufacturer),
    filmName: asTrimmedString(row.film_name),
    sqFtWeightLbsPerSqFt: numericOrNull(row.sq_ft_weight_lbs_per_sq_ft),
    defaultCoreType: asTrimmedString(row.default_core_type),
    sourceWidthIn: numericOrNull(row.source_width_in),
    sourceInitialFeet: integerOrNull(row.source_initial_feet),
    sourceInitialWeightLbs: numericOrNull(row.source_initial_weight_lbs),
    sourceBoxId: asTrimmedString(row.source_box_id),
    notes: asTrimmedString(row.notes),
    updatedAt: formatTimestamp(row.updated_at),
  };
}

function deriveFilmOrderOrigin(sourceBoxId) {
  return asTrimmedString(sourceBoxId) ? 'AUTO_SHORTAGE' : 'MANUAL';
}

function mapDbAllocationRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    orgId: row.org_id,
    allocationId: asTrimmedString(row.allocation_id),
    boxId: asTrimmedString(row.box_id),
    warehouse: asTrimmedString(row.warehouse),
    jobId: row.job_id || null,
    jobNumber: asTrimmedString(row.job_number),
    installDate: formatDateValue(row.job_date),
    allocatedFeet: integerOrZero(row.allocated_feet),
    coveredFeet: integerOrZero(row.covered_feet),
    backedPhysicalFeet:
      row.backed_physical_feet === undefined || row.backed_physical_feet === null
        ? null
        : integerOrZero(row.backed_physical_feet),
    reservationState: asTrimmedString(row.reservation_state),
    requirementId: asTrimmedString(row.requirement_id),
    allocationKind: normalizeAllocationKind(row.allocation_kind ?? row.allocationKind),
    allocationSource: normalizeAllocationSource(row.allocation_source ?? row.allocationSource),
    status: asTrimmedString(row.status) || 'ACTIVE',
    createdAt: formatTimestamp(row.created_at),
    createdBy: asTrimmedString(row.created_by),
    resolvedAt: formatTimestamp(row.resolved_at),
    resolvedBy: asTrimmedString(row.resolved_by),
    notes: asTrimmedString(row.notes),
    crewLeader: asTrimmedString(row.crew_leader),
    filmOrderId: asTrimmedString(row.film_order_id),
  };
}

function toPublicAllocation(entry) {
  return {
    allocationId: entry.allocationId,
    boxId: entry.boxId,
    warehouse: entry.warehouse,
    jobNumber: entry.jobNumber,
    installDate: entry.installDate,
    crewLeader: entry.crewLeader,
    allocatedFeet: entry.allocatedFeet,
    coveredFeet: integerOrZero(entry.coveredFeet) || entry.allocatedFeet,
    backedPhysicalFeet:
      entry.backedPhysicalFeet === undefined || entry.backedPhysicalFeet === null
        ? integerOrZero(entry.allocatedFeet)
        : integerOrZero(entry.backedPhysicalFeet),
    reservationState: asTrimmedString(entry.reservationState) || 'WITHOUT_INSTALL_DATE',
    requirementId: asTrimmedString(entry.requirementId),
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

function mapDbFilmOrderRow(row) {
  if (!row) {
    return null;
  }

  const sourceBoxId = asTrimmedString(row.source_box_id);

  return {
    id: row.id,
    orgId: row.org_id,
    filmOrderId: asTrimmedString(row.film_order_id),
    requirementId: asTrimmedString(row.requirement_id),
    jobId: row.job_id || null,
    jobNumber: asTrimmedString(row.job_number),
    warehouse: asTrimmedString(row.warehouse),
    workScope: asTrimmedString(row.work_scope || row.workScope || row.sections) || null,
    sections: asTrimmedString(row.sections || row.work_scope || row.workScope) || null,
    manufacturer: canonicalizeManufacturerLabel(row.manufacturer),
    filmName: asTrimmedString(row.film_name),
    widthIn: numericOrNull(row.width_in) ?? 0,
    requestedFeet: integerOrZero(row.requested_feet),
    coveredFeet: integerOrZero(row.covered_feet),
    orderedFeet: integerOrZero(row.ordered_feet),
    remainingToOrderFeet: integerOrZero(row.remaining_to_order_feet),
    installDate: formatDateValue(row.job_date),
    crewLeader: asTrimmedString(row.crew_leader),
    status: asTrimmedString(row.status) || 'FILM_ORDER',
    sourceBoxId,
    origin: deriveFilmOrderOrigin(sourceBoxId),
    createdAt: formatTimestamp(row.created_at),
    createdBy: asTrimmedString(row.created_by),
    resolvedAt: formatTimestamp(row.resolved_at),
    resolvedBy: asTrimmedString(row.resolved_by),
    notes: asTrimmedString(row.notes),
  };
}

function toPublicFilmOrder(entry, linkedBoxes) {
  const jobId = asTrimmedString(entry.jobId);
  const workScope = asTrimmedString(entry.workScope || entry.sections);
  const sections = asTrimmedString(entry.sections || entry.workScope);

  return {
    filmOrderId: entry.filmOrderId,
    ...(jobId ? { jobId } : {}),
    requirementId: asTrimmedString(entry.requirementId),
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

function mapDbFilmOrderLinkRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    orgId: row.org_id,
    linkId: asTrimmedString(row.link_id),
    filmOrderId: asTrimmedString(row.film_order_id),
    boxId: asTrimmedString(row.box_id),
    orderedFeet: integerOrZero(row.ordered_feet),
    autoAllocatedFeet: integerOrZero(row.auto_allocated_feet),
    createdAt: formatTimestamp(row.created_at),
    createdBy: asTrimmedString(row.created_by),
  };
}

function mapDbJobRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    orgId: row.org_id,
    jobNumber: asTrimmedString(row.job_number),
    warehouse: asTrimmedString(row.warehouse),
    workScope: asTrimmedString(row.sections) || null,
    sections: asTrimmedString(row.sections) || null,
    installDate: formatDateValue(row.due_date),
    crewLeader: asTrimmedString(row.crew_leader),
    lifecycleStatus: asTrimmedString(row.lifecycle_status) || 'ACTIVE',
    isLaborOnly: row.is_labor_only === true,
    isStagedForPickup: row.is_staged_for_pickup === true,
    notes: asTrimmedString(row.notes),
    createdAt: formatTimestamp(row.created_at),
    createdBy: asTrimmedString(row.created_by),
    updatedAt: formatTimestamp(row.updated_at),
    updatedBy: asTrimmedString(row.updated_by),
  };
}

function mapDbRequirementRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    orgId: row.org_id,
    jobId: row.job_id,
    jobNumber: asTrimmedString(row.job_number),
    manufacturer: canonicalizeManufacturerLabel(row.manufacturer),
    filmName: asTrimmedString(row.film_name),
    widthIn: numericOrNull(row.width_in) ?? 0,
    requiredFeet: integerOrZero(row.required_feet),
    notes: asTrimmedString(row.notes),
    createdAt: formatTimestamp(row.created_at),
    createdBy: asTrimmedString(row.created_by),
    updatedAt: formatTimestamp(row.updated_at),
    updatedBy: asTrimmedString(row.updated_by),
  };
}

function mapDbCaulkJobRequirementRow(row) {
  if (!row) {
    return null;
  }

  return {
    requirementId: asTrimmedString(row.requirement_id || row.id),
    jobNumber: asTrimmedString(row.job_number),
    productId: asTrimmedString(row.product_id),
    manufacturerId: asTrimmedString(row.manufacturer_id),
    manufacturer: asTrimmedString(row.manufacturer),
    productName: asTrimmedString(row.product_name),
    productCode: asTrimmedString(row.product_code),
    tubesPerCase: integerOrZero(row.tubes_per_case),
    requiredTubes: integerOrZero(row.required_tubes),
    autoPlanningSuppressed: row.auto_planning_suppressed === true,
    notes: asTrimmedString(row.notes),
    updatedAt: formatTimestamp(row.updated_at),
  };
}

function mapDbCaulkJobAllocationRow(row) {
  if (!row) {
    return null;
  }

  return {
    caulkAllocationId: asTrimmedString(row.caulk_allocation_id),
    requirementId: asTrimmedString(row.requirement_id),
    jobNumber: asTrimmedString(row.job_number),
    productId: asTrimmedString(row.product_id),
    manufacturerId: asTrimmedString(row.manufacturer_id),
    manufacturer: asTrimmedString(row.manufacturer),
    productName: asTrimmedString(row.product_name),
    productCode: asTrimmedString(row.product_code),
    tubesPerCase: integerOrZero(row.tubes_per_case),
    warehouse: asTrimmedString(row.warehouse),
    allocatedTubes: integerOrZero(row.allocated_tubes),
    reservedTubesRemaining: integerOrZero(row.reserved_tubes_remaining),
    checkedOutTubesTotal: integerOrZero(row.checked_out_tubes_total),
    returnedUnusedTubesTotal: integerOrZero(row.returned_unused_tubes_total),
    usedTubesTotal: integerOrZero(row.used_tubes_total),
    overageTubesTotal: integerOrZero(row.overage_tubes_total),
    outstandingCheckoutTubes: integerOrZero(row.outstanding_checkout_tubes),
    openCheckoutCount: integerOrZero(row.open_checkout_count),
    status: asTrimmedString(row.status) || 'ACTIVE',
    allocationSource: normalizeAllocationSource(row.allocation_source ?? row.allocationSource),
    createdAt: formatTimestamp(row.created_at),
    createdBy: asTrimmedString(row.created_by),
    updatedAt: formatTimestamp(row.updated_at),
    updatedBy: asTrimmedString(row.updated_by),
    resolvedAt: formatTimestamp(row.resolved_at),
    resolvedBy: asTrimmedString(row.resolved_by),
    notes: asTrimmedString(row.notes),
    pendingTransfer: asTrimmedString(row.pending_transfer_id)
      ? {
          transferId: asTrimmedString(row.pending_transfer_id),
          status: 'PENDING',
          sourceWarehouse: asTrimmedString(row.pending_transfer_source_warehouse).toUpperCase(),
          destinationWarehouse: asTrimmedString(
            row.pending_transfer_destination_warehouse || row.warehouse
          ).toUpperCase(),
          pendingTubes: integerOrZero(row.pending_transfer_tubes),
          startedAt: formatTimestamp(row.pending_transfer_started_at),
          startedBy: asTrimmedString(row.pending_transfer_started_by),
          notes: asTrimmedString(row.pending_transfer_notes),
        }
      : null,
  };
}

function mapDbCaulkTransferRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    orgId: row.org_id,
    caulkAllocationRowId: row.caulk_allocation_id,
    transferId: asTrimmedString(row.transfer_id),
    caulkAllocationId: asTrimmedString(row.caulk_allocation_public_id || row.caulk_allocation_id_text),
    jobNumber: asTrimmedString(row.job_number),
    jobWarehouse: asTrimmedString(row.job_warehouse).toUpperCase(),
    productId: asTrimmedString(row.product_id),
    manufacturerId: asTrimmedString(row.manufacturer_id),
    manufacturer: asTrimmedString(row.manufacturer),
    productName: asTrimmedString(row.product_name),
    productCode: asTrimmedString(row.product_code),
    tubesPerCase: integerOrZero(row.tubes_per_case),
    sourceWarehouse: asTrimmedString(row.source_warehouse).toUpperCase(),
    destinationWarehouse: asTrimmedString(row.destination_warehouse).toUpperCase(),
    pendingTubes: integerOrZero(row.pending_tubes),
    status: asTrimmedString(row.status).toUpperCase() || 'PENDING',
    createdAt: formatTimestamp(row.created_at),
    createdBy: asTrimmedString(row.created_by),
    receivedAt: formatTimestamp(row.received_at),
    receivedBy: asTrimmedString(row.received_by),
    cancelledAt: formatTimestamp(row.cancelled_at),
    cancelledBy: asTrimmedString(row.cancelled_by),
    updatedAt: formatTimestamp(row.updated_at),
    updatedBy: asTrimmedString(row.updated_by),
    notes: asTrimmedString(row.notes),
  };
}

function mapDbCaulkJobCheckoutRow(row) {
  if (!row) {
    return null;
  }

  return {
    caulkCheckoutId: asTrimmedString(row.caulk_checkout_id),
    caulkAllocationId: asTrimmedString(row.caulk_allocation_id),
    productId: asTrimmedString(row.product_id),
    manufacturerId: asTrimmedString(row.manufacturer_id),
    manufacturer: asTrimmedString(row.manufacturer),
    productName: asTrimmedString(row.product_name),
    productCode: asTrimmedString(row.product_code),
    tubesPerCase: integerOrZero(row.tubes_per_case),
    warehouse: asTrimmedString(row.warehouse),
    checkoutTubes: integerOrZero(row.checkout_tubes),
    overageTubes: integerOrZero(row.overage_tubes),
    status: asTrimmedString(row.status) || 'OPEN',
    checkedOutAt: formatTimestamp(row.checked_out_at),
    checkedOutBy: asTrimmedString(row.checked_out_by),
    checkedInAt: formatTimestamp(row.checked_in_at),
    checkedInBy: asTrimmedString(row.checked_in_by),
    unusedTubes: integerOrZero(row.unused_tubes),
    usedTubes: integerOrZero(row.used_tubes),
    notes: asTrimmedString(row.notes),
  };
}

function mapDbAuditRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    orgId: row.org_id,
    logId: asTrimmedString(row.log_id),
    date: formatTimestamp(row.created_at),
    action: asTrimmedString(row.action),
    boxId: asTrimmedString(row.box_id),
    before: row.before_state || null,
    after: row.after_state || null,
    user: asTrimmedString(row.actor),
    notes: asTrimmedString(row.notes),
  };
}

function mapDbRollHistoryRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    orgId: row.org_id,
    logId: asTrimmedString(row.log_id),
    boxId: asTrimmedString(row.box_id),
    warehouse: asTrimmedString(row.warehouse),
    manufacturer: canonicalizeManufacturerLabel(row.manufacturer),
    filmName: asTrimmedString(row.film_name),
    widthIn: numericOrNull(row.width_in) ?? 0,
    jobId: asTrimmedString(row.job_id),
    jobNumber: asTrimmedString(row.job_number),
    checkedOutAt: formatTimestamp(row.checked_out_at),
    checkedOutBy: asTrimmedString(row.checked_out_by),
    checkedOutWeightLbs: numericOrNull(row.checked_out_weight_lbs),
    checkedInAt: formatTimestamp(row.checked_in_at),
    checkedInBy: asTrimmedString(row.checked_in_by),
    checkedInWeightLbs: numericOrNull(row.checked_in_weight_lbs),
    weightDeltaLbs: numericOrNull(row.weight_delta_lbs),
    feetBefore: integerOrZero(row.feet_before),
    feetAfter: integerOrZero(row.feet_after),
    notes: asTrimmedString(row.notes),
  };
}

function mapBoxDealerRow(row) {
  if (!row) {
    return null;
  }

  return {
    dealerId: asTrimmedString(row.dealer_id || row.id),
    name: asTrimmedString(row.name),
    lookupKey: asTrimmedString(row.lookup_key),
    updatedAt: formatTimestamp(row.updated_at),
  };
}

function mapCaulkManufacturerRow(row) {
  if (!row) {
    return null;
  }

  return {
    manufacturerId: asTrimmedString(row.manufacturer_id || row.id),
    name: asTrimmedString(row.name),
    lookupKey: asTrimmedString(row.lookup_key),
    isActive: Boolean(row.is_active),
    updatedAt: formatTimestamp(row.updated_at),
  };
}

function mapCaulkProductRow(row) {
  if (!row) {
    return null;
  }

  return {
    productId: asTrimmedString(row.product_id || row.id),
    manufacturerId: asTrimmedString(row.manufacturer_id),
    manufacturer: asTrimmedString(row.manufacturer),
    productName: asTrimmedString(row.product_name || row.name),
    productCode: asTrimmedString(row.product_code || row.code),
    lookupKey: asTrimmedString(row.lookup_key),
    tubesPerCase: integerOrZero(row.tubes_per_case),
    isActive: Boolean(row.is_active),
    notes: asTrimmedString(row.notes),
    updatedAt: formatTimestamp(row.updated_at),
  };
}

function mapCaulkStockRow(row) {
  if (!row) {
    return null;
  }

  const tubesOnHand = Math.max(0, integerOrZero(row.tubes_on_hand));
  const casesOnHand = Math.floor(tubesOnHand / 16);
  const looseTubes = Math.max(0, tubesOnHand - casesOnHand * 16);

  return {
    warehouse: asTrimmedString(row.warehouse).toUpperCase(),
    productId: asTrimmedString(row.product_id),
    manufacturerId: asTrimmedString(row.manufacturer_id),
    manufacturer: asTrimmedString(row.manufacturer),
    productName: asTrimmedString(row.product_name),
    productCode: asTrimmedString(row.product_code),
    tubesPerCase: integerOrZero(row.tubes_per_case),
    tubesOnHand,
    casesOnHand,
    looseTubes,
    updatedAt: formatTimestamp(row.updated_at),
    updatedBy: asTrimmedString(row.updated_by),
  };
}

function mapCaulkTransactionRow(row) {
  if (!row) {
    return null;
  }

  return {
    transactionId: asTrimmedString(row.transaction_id),
    productId: asTrimmedString(row.product_id),
    warehouse: asTrimmedString(row.warehouse).toUpperCase(),
    manufacturer: asTrimmedString(row.manufacturer),
    productName: asTrimmedString(row.product_name),
    productCode: asTrimmedString(row.product_code),
    action: asTrimmedString(row.action),
    deltaTubes: integerOrZero(row.delta_tubes),
    resultingTubesOnHand: integerOrZero(row.resulting_tubes_on_hand),
    tubesPerCase: integerOrZero(row.tubes_per_case),
    reason: asTrimmedString(row.reason),
    notes: asTrimmedString(row.notes),
    transferId: asTrimmedString(row.transfer_id),
    sourceBoxId: asTrimmedString(row.source_box_id),
    createdAt: formatTimestamp(row.created_at),
    createdBy: asTrimmedString(row.created_by),
  };
}

function normalizeCaulkCaseMath(result) {
  if (!result || typeof result !== 'object') {
    return result || {};
  }

  const tubesOnHand = Math.max(0, integerOrZero(result.tubesOnHand ?? result.tubes_on_hand));
  const casesOnHand = Math.floor(tubesOnHand / 16);
  const looseTubes = Math.max(0, tubesOnHand - casesOnHand * 16);

  return {
    ...result,
    tubesOnHand,
    casesOnHand,
    looseTubes,
  };
}

export {
  mapDbBoxRow,
  toPublicBox,
  mapBoxDealerRow,
  mapDbBoxTransferRow,
  toPublicBoxTransfer,
  mapDbFilmCatalogRow,
  mapDbAllocationRow,
  toPublicAllocation,
  mapDbFilmOrderRow,
  toPublicFilmOrder,
  mapDbFilmOrderLinkRow,
  mapDbJobRow,
  mapDbRequirementRow,
  mapDbCaulkJobRequirementRow,
  mapDbCaulkJobAllocationRow,
  mapDbCaulkJobCheckoutRow,
  mapDbCaulkTransferRow,
  mapDbAuditRow,
  mapDbRollHistoryRow,
  mapCaulkManufacturerRow,
  mapCaulkProductRow,
  mapCaulkStockRow,
  mapCaulkTransactionRow,
  normalizeCaulkCaseMath,
};

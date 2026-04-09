import {
  asTrimmedString,
  computeAllocationPlanningFeet,
  formatDateValue,
  formatTimestamp,
  getBoxAllocationPlanningFeet,
  integerOrNull,
  integerOrZero,
  normalizeAllocationKind,
  numericOrNull,
} from '../core/helpers.mjs';
import { canonicalizeManufacturerLabel } from '../core/catalog.mjs';

function mapDbBoxRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    orgId: row.org_id,
    boxId: asTrimmedString(row.box_id),
    warehouse: asTrimmedString(row.warehouse),
    manufacturer: canonicalizeManufacturerLabel(row.manufacturer),
    filmName: asTrimmedString(row.film_name),
    widthIn: numericOrNull(row.width_in) ?? 0,
    initialFeet: integerOrZero(row.initial_feet),
    feetAvailable: integerOrZero(row.feet_available),
    activeAllocatedFeet: integerOrZero(row.active_allocated_feet),
    allocationPlanningFeet:
      row.allocation_planning_feet === undefined || row.allocation_planning_feet === null
        ? computeAllocationPlanningFeet(
            row.status,
            row.initial_feet,
            row.feet_available,
            row.active_allocated_feet
          )
        : integerOrZero(row.allocation_planning_feet),
    lotRun: asTrimmedString(row.lot_run),
    status: asTrimmedString(row.status) || 'ORDERED',
    orderDate: formatDateValue(row.order_date),
    receivedDate: formatDateValue(row.received_date),
    initialWeightLbs: numericOrNull(row.initial_weight_lbs),
    lastRollWeightLbs: numericOrNull(row.last_roll_weight_lbs),
    lastWeighedDate: formatDateValue(row.last_weighed_date),
    filmKey: asTrimmedString(row.film_key).toUpperCase(),
    coreType: asTrimmedString(row.core_type),
    coreWeightLbs: numericOrNull(row.core_weight_lbs),
    lfWeightLbsPerFt: numericOrNull(row.lf_weight_lbs_per_ft),
    pricePerLf: numericOrNull(row.price_per_lf),
    purchaseCost: numericOrNull(row.purchase_cost),
    notes: asTrimmedString(row.notes),
    hasEverBeenCheckedOut: Boolean(row.has_ever_been_checked_out),
    lastCheckoutJob: asTrimmedString(row.last_checkout_job),
    lastCheckoutDate: formatDateValue(row.last_checkout_date),
    zeroedDate: formatDateValue(row.zeroed_date),
    zeroedReason: asTrimmedString(row.zeroed_reason),
    zeroedBy: asTrimmedString(row.zeroed_by),
    createdAt: formatTimestamp(row.created_at),
    updatedAt: formatTimestamp(row.updated_at),
  };
}

function toPublicBox(box) {
  return {
    boxId: box.boxId,
    warehouse: box.warehouse,
    manufacturer: box.manufacturer,
    filmName: box.filmName,
    widthIn: box.widthIn,
    initialFeet: box.initialFeet,
    feetAvailable: box.feetAvailable,
    allocationPlanningFeet: getBoxAllocationPlanningFeet(box),
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
    jobDate: formatDateValue(row.job_date),
    allocatedFeet: integerOrZero(row.allocated_feet),
    coveredFeet: integerOrZero(row.covered_feet),
    requirementId: asTrimmedString(row.requirement_id),
    allocationKind: normalizeAllocationKind(row.allocation_kind),
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
    jobDate: entry.jobDate,
    crewLeader: entry.crewLeader,
    allocatedFeet: entry.allocatedFeet,
    coveredFeet: integerOrZero(entry.coveredFeet) || entry.allocatedFeet,
    requirementId: asTrimmedString(entry.requirementId),
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

function mapDbFilmOrderRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    orgId: row.org_id,
    filmOrderId: asTrimmedString(row.film_order_id),
    jobId: row.job_id || null,
    jobNumber: asTrimmedString(row.job_number),
    warehouse: asTrimmedString(row.warehouse),
    manufacturer: canonicalizeManufacturerLabel(row.manufacturer),
    filmName: asTrimmedString(row.film_name),
    widthIn: numericOrNull(row.width_in) ?? 0,
    requestedFeet: integerOrZero(row.requested_feet),
    coveredFeet: integerOrZero(row.covered_feet),
    orderedFeet: integerOrZero(row.ordered_feet),
    remainingToOrderFeet: integerOrZero(row.remaining_to_order_feet),
    jobDate: formatDateValue(row.job_date),
    crewLeader: asTrimmedString(row.crew_leader),
    status: asTrimmedString(row.status) || 'FILM_ORDER',
    sourceBoxId: asTrimmedString(row.source_box_id),
    createdAt: formatTimestamp(row.created_at),
    createdBy: asTrimmedString(row.created_by),
    resolvedAt: formatTimestamp(row.resolved_at),
    resolvedBy: asTrimmedString(row.resolved_by),
    notes: asTrimmedString(row.notes),
  };
}

function toPublicFilmOrder(entry, linkedBoxes) {
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
    sections: asTrimmedString(row.sections) || null,
    dueDate: formatDateValue(row.due_date),
    crewLeader: asTrimmedString(row.crew_leader),
    lifecycleStatus: asTrimmedString(row.lifecycle_status) || 'ACTIVE',
    isLaborOnly: row.is_labor_only === true,
    isLaborAssigned: row.is_labor_assigned === true,
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
    createdAt: formatTimestamp(row.created_at),
    createdBy: asTrimmedString(row.created_by),
    updatedAt: formatTimestamp(row.updated_at),
    updatedBy: asTrimmedString(row.updated_by),
    resolvedAt: formatTimestamp(row.resolved_at),
    resolvedBy: asTrimmedString(row.resolved_by),
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
  mapDbAuditRow,
  mapDbRollHistoryRow,
  mapCaulkManufacturerRow,
  mapCaulkProductRow,
  mapCaulkStockRow,
  mapCaulkTransactionRow,
  normalizeCaulkCaseMath,
};

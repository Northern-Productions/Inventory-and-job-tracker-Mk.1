// Paste into Apps Script file: boxes.gs

function determineWarehouseFromBoxId_(boxId) {
  return requireString_(boxId, 'BoxID').charAt(0).toUpperCase() === 'M' ? 'MS' : 'IL';
}

function buildFilmKey_(manufacturer, filmName) {
  return manufacturer.toUpperCase() + '|' + filmName.toUpperCase();
}

function getTodayDateString_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function deriveAddFeetAvailable_(initialFeet, receivedDate) {
  return receivedDate && receivedDate <= getTodayDateString_() ? initialFeet : 0;
}

function deriveLifecycleStatus_(receivedDate) {
  return receivedDate && receivedDate <= getTodayDateString_() ? 'IN_STOCK' : 'ORDERED';
}

function deriveStoredStatus_(statusValue, receivedDate) {
  var stored = asTrimmedString_(statusValue);
  if (!stored) {
    return deriveLifecycleStatus_(receivedDate);
  }

  return assertBoxStatus_(stored);
}

var CORE_WEIGHT_REFERENCE_WIDTH_IN_ = 72;
var CORE_WEIGHT_AT_REFERENCE_WIDTH_LBS_ = {
  White: 2,
  Red: 1.85,
  Cardboard: 2.05
};
var LOW_STOCK_THRESHOLD_LF_ = 10;

function roundToDecimals_(value, decimals) {
  var factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

function normalizeCoreType_(value, allowBlank) {
  var trimmed = asTrimmedString_(value);
  if (!trimmed) {
    if (allowBlank) {
      return '';
    }

    throw new Error('CoreType is required.');
  }

  var normalized = trimmed.toLowerCase();
  if (normalized === 'white') {
    return 'White';
  }

  if (normalized === 'red') {
    return 'Red';
  }

  if (normalized === 'cardboard') {
    return 'Cardboard';
  }

  throw new Error('CoreType must be White, Red, or Cardboard.');
}

function deriveCoreWeightLbs_(coreType, widthIn) {
  return roundToDecimals_(
    (CORE_WEIGHT_AT_REFERENCE_WIDTH_LBS_[coreType] / CORE_WEIGHT_REFERENCE_WIDTH_IN_) * widthIn,
    4
  );
}

function deriveLfWeightLbsPerFt_(sqFtWeightLbsPerSqFt, widthIn) {
  return roundToDecimals_(sqFtWeightLbsPerSqFt * (widthIn / 12), 6);
}

function deriveInitialWeightLbs_(lfWeightLbsPerFt, initialFeet, coreWeightLbs) {
  return roundToDecimals_(lfWeightLbsPerFt * initialFeet + coreWeightLbs, 2);
}

function deriveSqFtWeightLbsPerSqFt_(initialWeightLbs, coreWeightLbs, widthIn, initialFeet) {
  var areaSqFt = (widthIn / 12) * initialFeet;
  if (areaSqFt <= 0) {
    throw new Error('WidthIn and InitialFeet must be greater than zero to derive film weight.');
  }

  var filmOnlyWeightLbs = initialWeightLbs - coreWeightLbs;
  if (filmOnlyWeightLbs < 0) {
    throw new Error('InitialWeightLbs must be greater than or equal to the derived core weight.');
  }

  return roundToDecimals_(filmOnlyWeightLbs / areaSqFt, 8);
}

function deriveFeetAvailableFromRollWeight_(lastRollWeightLbs, coreWeightLbs, lfWeightLbsPerFt, initialFeet) {
  if (lfWeightLbsPerFt <= 0) {
    throw new Error('LfWeightLbsPerFt must be greater than zero to calculate FeetAvailable.');
  }

  var rawFeet = (lastRollWeightLbs - coreWeightLbs) / lfWeightLbsPerFt;
  if (rawFeet <= 0) {
    return 0;
  }

  var flooredFeet = Math.floor(rawFeet);
  if (flooredFeet > initialFeet) {
    return initialFeet;
  }

  return flooredFeet;
}

function isLowStockBox_(box) {
  return box.status === 'IN_STOCK' && box.feetAvailable > 0 && box.feetAvailable < LOW_STOCK_THRESHOLD_LF_;
}

function hasPositivePhysicalFeet_(box) {
  if (!box || !box.receivedDate) {
    return false;
  }

  if (
    box.lastRollWeightLbs !== null &&
    box.coreWeightLbs !== null &&
    box.lfWeightLbsPerFt !== null &&
    box.lfWeightLbsPerFt > 0
  ) {
    return (
      deriveFeetAvailableFromRollWeight_(
        box.lastRollWeightLbs,
        box.coreWeightLbs,
        box.lfWeightLbsPerFt,
        box.initialFeet
      ) > 0
    );
  }

  return box.initialFeet > 0;
}

function shouldAutoMoveToZeroed_(existingBox, nextBox) {
  return (
    Boolean(nextBox.receivedDate) &&
    existingBox &&
    hasPositivePhysicalFeet_(existingBox) &&
    (nextBox.feetAvailable === 0 || nextBox.lastRollWeightLbs === 0)
  );
}

function determineZeroedReason_(box) {
  if (box.feetAvailable === 0 && box.lastRollWeightLbs === 0) {
    return 'Auto-zeroed because Available Feet and Last Roll Weight reached 0.';
  }

  if (box.feetAvailable === 0) {
    return 'Auto-zeroed because Available Feet reached 0.';
  }

  return 'Auto-zeroed because Last Roll Weight reached 0.';
}

function normalizeMeaningfulZeroedNote_(note) {
  var trimmed = asTrimmedString_(note);
  if (!trimmed) {
    return '';
  }

  if (
    /^Checked in at /i.test(trimmed) ||
    /^Auto-moved to zeroed out inventory$/i.test(trimmed)
  ) {
    return '';
  }

  return trimmed;
}

function stampZeroedMetadata_(box, user, auditNote) {
  var note = normalizeMeaningfulZeroedNote_(auditNote);
  box.status = 'ZEROED';
  box.feetAvailable = 0;
  box.zeroedDate = getTodayDateString_();
  box.zeroedReason = determineZeroedReason_(box) + (note ? ' Additional note: ' + note : '');
  box.zeroedBy = asTrimmedString_(user);
}

function applyAddOrEditWarnings_(warnings, currentBox, nextBox) {
  if (nextBox.receivedDate && nextBox.orderDate && nextBox.receivedDate < nextBox.orderDate) {
    warnings.push('Received Date is earlier than Order Date.');
  }

  if (
    nextBox.lastWeighedDate &&
    nextBox.receivedDate &&
    nextBox.lastWeighedDate < nextBox.receivedDate
  ) {
    warnings.push('Last Weighed Date is earlier than Received Date.');
  }

  if (nextBox.feetAvailable > nextBox.initialFeet) {
    warnings.push('Available Feet is greater than Initial Feet.');
  }

  if (
    nextBox.receivedDate &&
    nextBox.feetAvailable === 0 &&
    nextBox.lastRollWeightLbs !== null &&
    nextBox.lastRollWeightLbs > 0
  ) {
    warnings.push('Available Feet is 0 while Last Roll Weight is still above 0.');
  }

  if (nextBox.receivedDate && nextBox.lastRollWeightLbs === 0 && nextBox.feetAvailable > 0) {
    warnings.push('Last Roll Weight is 0 while Available Feet is still above 0.');
  }

  if (
    currentBox &&
    currentBox.receivedDate &&
    (currentBox.initialWeightLbs !== null ||
      currentBox.lastRollWeightLbs !== null ||
      currentBox.lfWeightLbsPerFt !== null) &&
    (currentBox.manufacturer !== nextBox.manufacturer ||
      currentBox.filmName !== nextBox.filmName ||
      currentBox.widthIn !== nextBox.widthIn ||
      currentBox.initialFeet !== nextBox.initialFeet)
  ) {
    warnings.push('Film identity, width, or initial feet changed after weights were already established.');
  }
}

function applyCheckoutWarnings_(warnings, box) {
  if (box.lastRollWeightLbs === null) {
    warnings.push('This box does not have a current Last Roll Weight saved yet.');
  }

  if (!box.lastWeighedDate) {
    warnings.push('This box does not have a Last Weighed Date saved yet.');
  }
}

function applyCheckInWarnings_(warnings, existingBox, updatedBox, willAutoZero) {
  if (
    existingBox.lastRollWeightLbs !== null &&
    updatedBox.lastRollWeightLbs !== null &&
    updatedBox.lastRollWeightLbs > existingBox.lastRollWeightLbs
  ) {
    warnings.push('The new Last Roll Weight is greater than the box’s previous Last Roll Weight.');
  }

  if (
    existingBox.initialWeightLbs !== null &&
    updatedBox.lastRollWeightLbs !== null &&
    updatedBox.lastRollWeightLbs > existingBox.initialWeightLbs
  ) {
    warnings.push('The new Last Roll Weight is greater than the box’s Initial Weight.');
  }

  if (
    updatedBox.lastRollWeightLbs !== null &&
    updatedBox.lastRollWeightLbs > 0 &&
    updatedBox.coreWeightLbs !== null &&
    updatedBox.lastRollWeightLbs < updatedBox.coreWeightLbs
  ) {
    warnings.push('The new Last Roll Weight is below the derived core weight.');
  }

  if (updatedBox.feetAvailable > existingBox.feetAvailable) {
    warnings.push('The recalculated Available Feet would increase compared with the current box.');
  }

  if (willAutoZero) {
    warnings.push('This check-in will auto-move the box into zeroed out inventory.');
  }
}

function getActiveAllocationsForBox_(boxId) {
  var entries = readAllocationsByBox_(boxId);
  var active = [];

  for (var index = 0; index < entries.length; index += 1) {
    if (entries[index].status === 'ACTIVE') {
      active.push(entries[index]);
    }
  }

  return active;
}

function getActiveAllocatedFeetForBox_(boxId) {
  var active = getActiveAllocationsForBox_(boxId);
  var total = 0;

  for (var index = 0; index < active.length; index += 1) {
    total += active[index].allocatedFeet;
  }

  return total;
}

function normalizeJobNumberKey_(jobNumber) {
  return asTrimmedString_(jobNumber).toUpperCase();
}

function resolveAllocationsForCheckout_(boxId, jobNumber, user) {
  var active = getActiveAllocationsForBox_(boxId);
  var normalizedJobNumber = normalizeJobNumberKey_(jobNumber);
  var resolvedAt = new Date().toISOString();
  var result = {
    fulfilledCount: 0,
    fulfilledFeet: 0,
    otherJobs: []
  };
  var otherJobs = {};

  for (var index = 0; index < active.length; index += 1) {
    var entry = cloneObject_(active[index]);
    if (normalizeJobNumberKey_(entry.jobNumber) === normalizedJobNumber) {
      entry.status = 'FULFILLED';
      entry.resolvedAt = resolvedAt;
      entry.resolvedBy = asTrimmedString_(user);
      entry.notes = 'Fulfilled by checkout for job ' + jobNumber + '.';
      updateAllocationRow_(entry.rowIndex, entry);
      result.fulfilledCount += 1;
      result.fulfilledFeet += entry.allocatedFeet;
      continue;
    }

    if (entry.jobNumber && !otherJobs[entry.jobNumber]) {
      otherJobs[entry.jobNumber] = true;
      result.otherJobs.push(entry.jobNumber);
    }
  }

  return result;
}

function cancelActiveAllocationsForBox_(boxId, user, reason) {
  var active = getActiveAllocationsForBox_(boxId);
  var resolvedAt = new Date().toISOString();
  var trimmedReason = asTrimmedString_(reason);
  var affectedFilmOrders = {};

  for (var index = 0; index < active.length; index += 1) {
    var entry = cloneObject_(active[index]);
    entry.status = 'CANCELLED';
    entry.resolvedAt = resolvedAt;
    entry.resolvedBy = asTrimmedString_(user);
    entry.notes = trimmedReason || entry.notes;
    updateAllocationRow_(entry.rowIndex, entry);

    if (entry.filmOrderId) {
      affectedFilmOrders[entry.filmOrderId] = true;
    }
  }

  for (var filmOrderId in affectedFilmOrders) {
    if (Object.prototype.hasOwnProperty.call(affectedFilmOrders, filmOrderId)) {
      recalculateFilmOrder_(filmOrderId, user);
    }
  }

  return active.length;
}

function reactivateFulfilledAllocationsForUndo_(boxId, jobNumber) {
  var entries = readAllocationsByBox_(boxId);
  var expectedNote = 'Fulfilled by checkout for job ' + jobNumber + '.';
  var count = 0;

  for (var index = 0; index < entries.length; index += 1) {
    var entry = cloneObject_(entries[index]);
    if (
      entry.status === 'FULFILLED' &&
      normalizeJobNumberKey_(entry.jobNumber) === normalizeJobNumberKey_(jobNumber) &&
      entry.notes === expectedNote
    ) {
      entry.status = 'ACTIVE';
      entry.resolvedAt = '';
      entry.resolvedBy = '';
      entry.notes = '';
      updateAllocationRow_(entry.rowIndex, entry);
      count += 1;
    }
  }

  return count;
}

function reactivateCancelledAllocationsForZeroUndo_(boxId) {
  var entries = readAllocationsByBox_(boxId);
  var expectedNote = 'Auto-cancelled because the box was moved to zeroed out inventory.';
  var count = 0;
  var affectedFilmOrders = {};

  for (var index = 0; index < entries.length; index += 1) {
    var entry = cloneObject_(entries[index]);
    if (entry.status === 'CANCELLED' && entry.notes === expectedNote) {
      entry.status = 'ACTIVE';
      entry.resolvedAt = '';
      entry.resolvedBy = '';
      entry.notes = '';
      updateAllocationRow_(entry.rowIndex, entry);
      if (entry.filmOrderId) {
        affectedFilmOrders[entry.filmOrderId] = true;
      }
      count += 1;
    }
  }

  for (var filmOrderId in affectedFilmOrders) {
    if (Object.prototype.hasOwnProperty.call(affectedFilmOrders, filmOrderId)) {
      recalculateFilmOrder_(filmOrderId, '');
    }
  }

  return count;
}

function normalizeCrewLeaderKey_(crewLeader) {
  return asTrimmedString_(crewLeader).toUpperCase();
}

function resolveJobContext_(jobNumber, jobDate, crewLeader) {
  var normalizedJobNumber = requireString_(jobNumber, 'JobNumber');
  var normalizedJobDate = normalizeDateString_(jobDate, 'JobDate', true);
  var normalizedCrewLeader = asTrimmedString_(crewLeader);
  var existingAllocations = readAllocationsByJob_(normalizedJobNumber);
  var existingFilmOrders = readFilmOrdersByJob_(normalizedJobNumber);
  var existingJobDate = '';
  var existingCrewLeader = '';
  var index;

  for (index = 0; index < existingAllocations.length; index += 1) {
    if (!existingJobDate && existingAllocations[index].jobDate) {
      existingJobDate = existingAllocations[index].jobDate;
    }

    if (!existingCrewLeader && existingAllocations[index].crewLeader) {
      existingCrewLeader = existingAllocations[index].crewLeader;
    }
  }

  for (index = 0; index < existingFilmOrders.length; index += 1) {
    if (!existingJobDate && existingFilmOrders[index].jobDate) {
      existingJobDate = existingFilmOrders[index].jobDate;
    }

    if (!existingCrewLeader && existingFilmOrders[index].crewLeader) {
      existingCrewLeader = existingFilmOrders[index].crewLeader;
    }
  }

  if (existingJobDate && normalizedJobDate && existingJobDate !== normalizedJobDate) {
    throw new Error('JobDate must stay the same for an existing Job Number.');
  }

  if (
    existingCrewLeader &&
    normalizedCrewLeader &&
    normalizeCrewLeaderKey_(existingCrewLeader) !== normalizeCrewLeaderKey_(normalizedCrewLeader)
  ) {
    throw new Error('CrewLeader must stay the same for an existing Job Number.');
  }

  var resolvedJobDate = normalizedJobDate || existingJobDate;
  var resolvedCrewLeader = normalizedCrewLeader || existingCrewLeader;

  if (resolvedJobDate && !resolvedCrewLeader) {
    throw new Error('CrewLeader is required when JobDate is set.');
  }

  return {
    jobNumber: normalizedJobNumber,
    jobDate: resolvedJobDate,
    crewLeader: resolvedCrewLeader
  };
}

function getDateConflictJobsForBox_(boxId, jobContext) {
  if (!jobContext.jobDate) {
    return [];
  }

  var active = getActiveAllocationsForBox_(boxId);
  var conflicts = [];
  var seen = {};

  for (var index = 0; index < active.length; index += 1) {
    var entry = active[index];
    if (
      entry.jobDate !== jobContext.jobDate ||
      normalizeJobNumberKey_(entry.jobNumber) === normalizeJobNumberKey_(jobContext.jobNumber)
    ) {
      continue;
    }

    if (normalizeCrewLeaderKey_(entry.crewLeader) === normalizeCrewLeaderKey_(jobContext.crewLeader)) {
      continue;
    }

    if (!seen[entry.jobNumber]) {
      seen[entry.jobNumber] = true;
      conflicts.push(entry.jobNumber);
    }
  }

  return conflicts;
}

function compareBoxesByOldestStock_(a, b) {
  var aDate = a.receivedDate || a.orderDate || '9999-12-31';
  var bDate = b.receivedDate || b.orderDate || '9999-12-31';

  if (aDate !== bDate) {
    return aDate < bDate ? -1 : 1;
  }

  return a.boxId < b.boxId ? -1 : a.boxId > b.boxId ? 1 : 0;
}

function buildAllocationPreviewPlan_(sourceBox, requestedFeet, jobContext) {
  var requested = coerceFeetValue_(requestedFeet, 'RequestedFeet', [], true);
  if (requested <= 0) {
    throw new Error('RequestedFeet must be greater than zero.');
  }

  var sourceConflicts = getDateConflictJobsForBox_(sourceBox.boxId, jobContext);
  var sourceAllocationFeet = sourceConflicts.length ? 0 : Math.min(sourceBox.feetAvailable, requested);
  var remaining = requested - sourceAllocationFeet;
  var candidates = [];
  var warehouseBoxes = readWarehouseBoxes_(sourceBox.warehouse);

  warehouseBoxes.sort(compareBoxesByOldestStock_);

  for (var index = 0; index < warehouseBoxes.length; index += 1) {
    var candidate = warehouseBoxes[index];
    if (
      candidate.boxId === sourceBox.boxId ||
      candidate.status !== 'IN_STOCK' ||
      candidate.feetAvailable <= 0 ||
      candidate.manufacturer !== sourceBox.manufacturer ||
      candidate.filmName !== sourceBox.filmName ||
      candidate.widthIn !== sourceBox.widthIn
    ) {
      continue;
    }

    var candidateConflicts = getDateConflictJobsForBox_(candidate.boxId, jobContext);
    if (candidateConflicts.length) {
      continue;
    }

    candidates.push({
      boxId: candidate.boxId,
      availableFeet: candidate.feetAvailable,
      suggestedFeet: remaining > 0 ? Math.min(candidate.feetAvailable, remaining) : 0,
      receivedDate: candidate.receivedDate,
      orderDate: candidate.orderDate
    });

    if (remaining > 0) {
      remaining -= Math.min(candidate.feetAvailable, remaining);
    }
  }

  return {
    jobNumber: jobContext.jobNumber,
    jobDate: jobContext.jobDate,
    crewLeader: jobContext.crewLeader,
    requestedFeet: requested,
    sourceBoxId: sourceBox.boxId,
    sourceBoxFeetAvailable: sourceBox.feetAvailable,
    sourceSuggestedFeet: sourceAllocationFeet,
    sourceConflicts: sourceConflicts,
    suggestions: candidates,
    defaultCoveredFeet: requested - remaining,
    defaultRemainingFeet: remaining
  };
}

function calculateSelectedSuggestionAllocations_(plan, selectedBoxIds) {
  var selectedMap = {};
  var allocations = [];
  var remaining = plan.requestedFeet;
  var index;

  if (plan.sourceSuggestedFeet > 0) {
    allocations.push({
      boxId: plan.sourceBoxId,
      allocatedFeet: plan.sourceSuggestedFeet
    });
    remaining -= plan.sourceSuggestedFeet;
  }

  for (index = 0; index < selectedBoxIds.length; index += 1) {
    selectedMap[selectedBoxIds[index]] = true;
  }

  for (index = 0; index < plan.suggestions.length; index += 1) {
    var suggestion = plan.suggestions[index];
    if (!selectedMap[suggestion.boxId] || remaining <= 0) {
      continue;
    }

    var allocatedFeet = Math.min(suggestion.availableFeet, remaining);
    allocations.push({
      boxId: suggestion.boxId,
      allocatedFeet: allocatedFeet
    });
    remaining -= allocatedFeet;
  }

  return {
    allocations: allocations,
    remainingFeet: remaining
  };
}

function decrementBoxFeetAvailableForAllocation_(foundBoxRecord, allocatedFeet) {
  var updatedBox = cloneObject_(foundBoxRecord.box);
  updatedBox.feetAvailable = Math.max(updatedBox.feetAvailable - allocatedFeet, 0);
  updateBoxRow_(foundBoxRecord.warehouse, foundBoxRecord.rowIndex, updatedBox, false);
  foundBoxRecord.box = updatedBox;
  return updatedBox;
}

function createAllocationRecord_(foundBoxRecord, jobContext, allocatedFeet, user, filmOrderId) {
  return appendAllocation_({
    allocationId: '',
    boxId: foundBoxRecord.box.boxId,
    warehouse: foundBoxRecord.box.warehouse,
    jobNumber: jobContext.jobNumber,
    jobDate: jobContext.jobDate,
    allocatedFeet: allocatedFeet,
    status: 'ACTIVE',
    createdAt: new Date().toISOString(),
    createdBy: asTrimmedString_(user),
    resolvedAt: '',
    resolvedBy: '',
    notes: '',
    crewLeader: jobContext.crewLeader,
    filmOrderId: asTrimmedString_(filmOrderId)
  });
}

function sumFilmOrderCoveredFeet_(filmOrderId) {
  var allocations = readAllocationsByFilmOrderId_(filmOrderId);
  var total = 0;

  for (var index = 0; index < allocations.length; index += 1) {
    if (allocations[index].status !== 'CANCELLED') {
      total += allocations[index].allocatedFeet;
    }
  }

  return total;
}

function sumFilmOrderOrderedFeet_(filmOrderId) {
  var links = readFilmOrderBoxLinksByFilmOrderId_(filmOrderId);
  var total = 0;

  for (var index = 0; index < links.length; index += 1) {
    if (findRowByBoxIdAcrossWarehouses_(links[index].boxId, true)) {
      total += links[index].orderedFeet;
    }
  }

  return total;
}

function recalculateFilmOrder_(filmOrderId, user) {
  var existing = findFilmOrderById_(filmOrderId);
  if (!existing) {
    return null;
  }

  var updated = cloneObject_(existing);
  updated.coveredFeet = sumFilmOrderCoveredFeet_(filmOrderId);
  updated.orderedFeet = sumFilmOrderOrderedFeet_(filmOrderId);
  updated.remainingToOrderFeet = Math.max(updated.requestedFeet - updated.orderedFeet, 0);

  if (updated.status !== 'CANCELLED') {
    if (updated.coveredFeet >= updated.requestedFeet) {
      updated.status = 'FULFILLED';
      if (!updated.resolvedAt) {
        updated.resolvedAt = new Date().toISOString();
        updated.resolvedBy = asTrimmedString_(user);
      }
    } else if (updated.orderedFeet >= updated.requestedFeet) {
      updated.status = 'FILM_ON_THE_WAY';
      updated.resolvedAt = '';
      updated.resolvedBy = '';
    } else {
      updated.status = 'FILM_ORDER';
      updated.resolvedAt = '';
      updated.resolvedBy = '';
    }
  }

  updateFilmOrderRow_(updated.rowIndex, updated);
  return updated;
}

function createFilmOrderForShortage_(sourceBox, jobContext, requestedFeet, shortageFeet, user) {
  if (shortageFeet <= 0) {
    return null;
  }

  return appendFilmOrder_({
    filmOrderId: '',
    jobNumber: jobContext.jobNumber,
    warehouse: sourceBox.warehouse,
    manufacturer: sourceBox.manufacturer,
    filmName: sourceBox.filmName,
    widthIn: sourceBox.widthIn,
    requestedFeet: shortageFeet,
    coveredFeet: 0,
    orderedFeet: 0,
    remainingToOrderFeet: shortageFeet,
    jobDate: jobContext.jobDate,
    crewLeader: jobContext.crewLeader,
    status: 'FILM_ORDER',
    sourceBoxId: sourceBox.boxId,
    createdAt: new Date().toISOString(),
    createdBy: asTrimmedString_(user),
    resolvedAt: '',
    resolvedBy: '',
    notes: 'Created from a shortage while trying to allocate ' + requestedFeet + ' LF.'
  });
}

function linkBoxToFilmOrder_(filmOrderId, box, user) {
  var existing = findFilmOrderById_(filmOrderId);
  if (!existing) {
    throw new Error('Film Order not found.');
  }

  if (existing.status === 'CANCELLED') {
    throw new Error('Cancelled Film Orders cannot receive new boxes.');
  }

  appendFilmOrderBoxLink_({
    linkId: '',
    filmOrderId: existing.filmOrderId,
    boxId: box.boxId,
    orderedFeet: box.initialFeet,
    autoAllocatedFeet: 0,
    createdAt: new Date().toISOString(),
    createdBy: asTrimmedString_(user)
  });

  return recalculateFilmOrder_(existing.filmOrderId, user);
}

function processLinkedFilmOrderReceipt_(box, user, warnings) {
  var links = readFilmOrderBoxLinksByBoxId_(box.boxId);
  var recalculatedOrders = {};

  if (!box.receivedDate || box.status !== 'IN_STOCK' || box.feetAvailable <= 0) {
    return box;
  }

  for (var index = 0; index < links.length; index += 1) {
    var link = cloneObject_(links[index]);
    var filmOrder = findFilmOrderById_(link.filmOrderId);
    if (!filmOrder || filmOrder.status === 'CANCELLED' || filmOrder.status === 'FULFILLED') {
      continue;
    }

    var remainingNeed = Math.max(filmOrder.requestedFeet - filmOrder.coveredFeet, 0);
    var linkCapacity = Math.max(link.orderedFeet - link.autoAllocatedFeet, 0);
    var allocationFeet = Math.min(remainingNeed, linkCapacity, box.feetAvailable);

    if (allocationFeet <= 0) {
      continue;
    }

    createAllocationRecord_(
      {
        warehouse: box.warehouse,
        rowIndex: box.rowIndex,
        box: box
      },
      {
        jobNumber: filmOrder.jobNumber,
        jobDate: filmOrder.jobDate,
        crewLeader: filmOrder.crewLeader
      },
      allocationFeet,
      user,
      filmOrder.filmOrderId
    );
    box.feetAvailable = Math.max(box.feetAvailable - allocationFeet, 0);
    link.autoAllocatedFeet += allocationFeet;
    updateFilmOrderBoxLinkRow_(link.rowIndex, link);
    warnings.push(
      allocationFeet +
        ' LF from ' +
        box.boxId +
        ' was automatically allocated to job ' +
        filmOrder.jobNumber +
        ' for Film Order ' +
        filmOrder.filmOrderId +
        '.'
    );
    recalculatedOrders[filmOrder.filmOrderId] = true;
  }

  for (var filmOrderId in recalculatedOrders) {
    if (Object.prototype.hasOwnProperty.call(recalculatedOrders, filmOrderId)) {
      recalculateFilmOrder_(filmOrderId, user);
    }
  }

  return box;
}

function cancelJobAndReleaseAllocations_(jobNumber, user, reason) {
  var allocations = readAllocationsByJob_(jobNumber);
  var activeByBoxId = {};
  var activeCount = 0;
  var filmOrders = readFilmOrdersByJob_(jobNumber);
  var resolvedAt = new Date().toISOString();
  var note = asTrimmedString_(reason) || 'Job cancelled.';

  for (var index = 0; index < allocations.length; index += 1) {
    var entry = cloneObject_(allocations[index]);
    if (entry.status !== 'ACTIVE') {
      continue;
    }

    activeByBoxId[entry.boxId] = (activeByBoxId[entry.boxId] || 0) + entry.allocatedFeet;
    entry.status = 'CANCELLED';
    entry.resolvedAt = resolvedAt;
    entry.resolvedBy = asTrimmedString_(user);
    entry.notes = note;
    updateAllocationRow_(entry.rowIndex, entry);
    activeCount += 1;
  }

  for (var boxId in activeByBoxId) {
    if (!Object.prototype.hasOwnProperty.call(activeByBoxId, boxId)) {
      continue;
    }

    var found = findRowByBoxIdAcrossWarehouses_(boxId, false);
    if (!found) {
      continue;
    }

    var updatedBox = cloneObject_(found.box);
    updatedBox.feetAvailable += activeByBoxId[boxId];
    updateBoxRow_(found.warehouse, found.rowIndex, updatedBox, false);
  }

  for (index = 0; index < filmOrders.length; index += 1) {
    var order = cloneObject_(filmOrders[index]);
    if (order.status === 'CANCELLED') {
      continue;
    }

    order.status = 'CANCELLED';
    order.resolvedAt = resolvedAt;
    order.resolvedBy = asTrimmedString_(user);
    order.notes = note;
    updateFilmOrderRow_(order.rowIndex, order);
  }

  return {
    releasedAllocationCount: activeCount,
    affectedBoxCount: Object.keys(activeByBoxId).length
  };
}

function cancelActiveFilmOrderAllocationsForBox_(boxId, user, reason) {
  var entries = readAllocationsByBox_(boxId);
  var resolvedAt = new Date().toISOString();
  var affectedFilmOrders = {};
  var count = 0;

  for (var index = 0; index < entries.length; index += 1) {
    var entry = cloneObject_(entries[index]);
    if (entry.status !== 'ACTIVE' || !entry.filmOrderId) {
      continue;
    }

    entry.status = 'CANCELLED';
    entry.resolvedAt = resolvedAt;
    entry.resolvedBy = asTrimmedString_(user);
    entry.notes = asTrimmedString_(reason) || 'Cancelled because linked box state was undone.';
    updateAllocationRow_(entry.rowIndex, entry);
    affectedFilmOrders[entry.filmOrderId] = true;
    count += 1;
  }

  for (var filmOrderId in affectedFilmOrders) {
    if (Object.prototype.hasOwnProperty.call(affectedFilmOrders, filmOrderId)) {
      recalculateFilmOrder_(filmOrderId, user);
    }
  }

  return count;
}

function recalculateFilmOrdersForBoxLinks_(boxId, user) {
  var links = readFilmOrderBoxLinksByBoxId_(boxId);
  var seen = {};

  for (var index = 0; index < links.length; index += 1) {
    if (!seen[links[index].filmOrderId]) {
      seen[links[index].filmOrderId] = true;
      recalculateFilmOrder_(links[index].filmOrderId, user);
    }
  }
}

function buildBoxFromPayload_(payload, warnings, existingBox) {
  var boxId = existingBox ? existingBox.boxId : requireString_(payload.boxId, 'BoxID');
  var manufacturer = requireString_(payload.manufacturer, 'Manufacturer');
  var filmName = requireString_(payload.filmName, 'FilmName');
  var widthIn = coerceNonNegativeNumber_(payload.widthIn, 'WidthIn');
  var initialFeet = coerceFeetValue_(payload.initialFeet, 'InitialFeet', warnings, false);
  var orderDate = normalizeDateString_(payload.orderDate, 'OrderDate', false);
  var receivedDate = normalizeDateString_(payload.receivedDate, 'ReceivedDate', true);
  var feetAvailableInput = asTrimmedString_(payload.feetAvailable);
  var filmKey = asTrimmedString_(payload.filmKey) || buildFilmKey_(manufacturer, filmName);
  var initialWeightInput = coerceOptionalNonNegativeNumber_(payload.initialWeightLbs, 'InitialWeightLbs');
  var lastRollWeightInput = coerceOptionalNonNegativeNumber_(payload.lastRollWeightLbs, 'LastRollWeightLbs');
  var lastWeighedDateInput = normalizeDateString_(payload.lastWeighedDate, 'LastWeighedDate', true);
  var coreTypeInput = normalizeCoreType_(payload.coreType, true);
  var existingCoreType = existingBox ? normalizeCoreType_(existingBox.coreType, true) : '';
  var feetAvailable;
  var resolvedInitialWeightLbs = initialWeightInput;
  var resolvedLastRollWeightLbs = lastRollWeightInput;
  var resolvedLastWeighedDate = lastWeighedDateInput;
  var resolvedCoreType = coreTypeInput || existingCoreType;
  var resolvedCoreWeightLbs = null;
  var resolvedLfWeightLbsPerFt = null;

  if (!feetAvailableInput) {
    if (existingBox) {
      feetAvailable = existingBox.feetAvailable;
    } else {
      feetAvailable = deriveAddFeetAvailable_(initialFeet, receivedDate);
    }
  } else {
    feetAvailable = coerceFeetValue_(payload.feetAvailable, 'FeetAvailable', warnings, true);
  }

  if (existingBox && existingBox.receivedDate && !receivedDate) {
    throw new Error('ReceivedDate cannot be cleared after a box has been received.');
  }

  if (receivedDate) {
    if (widthIn <= 0) {
      throw new Error('WidthIn must be greater than zero for received boxes.');
    }

    if (initialFeet <= 0) {
      throw new Error('InitialFeet must be greater than zero for received boxes.');
    }

    var shouldRefreshReceivingMetrics =
      !existingBox ||
      !existingBox.receivedDate ||
      existingBox.filmKey !== filmKey ||
      existingBox.widthIn !== widthIn ||
      existingBox.initialFeet !== initialFeet ||
      (coreTypeInput && coreTypeInput !== existingCoreType) ||
      initialWeightInput !== null;

    if (shouldRefreshReceivingMetrics) {
      var filmData = findFilmDataByFilmKey_(filmKey);
      var filmDataCoreType = filmData ? normalizeCoreType_(filmData.defaultCoreType, true) : '';
      var effectiveCoreType = coreTypeInput || filmDataCoreType || existingCoreType;

      if (filmData && filmData.sqFtWeightLbsPerSqFt !== null) {
        if (!effectiveCoreType) {
          throw new Error('CoreType is required before this film can be received.');
        }

        var knownSqFtWeight = coerceNonNegativeNumber_(
          filmData.sqFtWeightLbsPerSqFt,
          'SqFtWeightLbsPerSqFt'
        );
        resolvedCoreType = effectiveCoreType;
        resolvedCoreWeightLbs = deriveCoreWeightLbs_(effectiveCoreType, widthIn);
        resolvedLfWeightLbsPerFt = deriveLfWeightLbsPerFt_(knownSqFtWeight, widthIn);
        resolvedInitialWeightLbs = deriveInitialWeightLbs_(
          resolvedLfWeightLbsPerFt,
          initialFeet,
          resolvedCoreWeightLbs
        );

        if (resolvedLastRollWeightLbs === null) {
          resolvedLastRollWeightLbs =
            existingBox && existingBox.lastRollWeightLbs !== null
              ? existingBox.lastRollWeightLbs
              : resolvedInitialWeightLbs;
        }

        if (!resolvedLastWeighedDate) {
          resolvedLastWeighedDate =
            existingBox && existingBox.lastWeighedDate ? existingBox.lastWeighedDate : receivedDate;
        }

        if ((!existingBox || !existingBox.receivedDate) && initialWeightInput === null) {
          warnings.push('Initial and last roll weights were auto-filled from FILM DATA.');
        }

        if (!filmDataCoreType || filmDataCoreType !== effectiveCoreType) {
          upsertFilmDataRecord_({
            filmKey: filmKey,
            manufacturer: filmData.manufacturer || manufacturer,
            filmName: filmData.filmName || filmName,
            sqFtWeightLbsPerSqFt: knownSqFtWeight,
            defaultCoreType: effectiveCoreType,
            sourceWidthIn: filmData.sourceWidthIn,
            sourceInitialFeet: filmData.sourceInitialFeet,
            sourceInitialWeightLbs: filmData.sourceInitialWeightLbs,
            updatedAt: new Date().toISOString(),
            sourceBoxId: filmData.sourceBoxId || boxId,
            notes: filmData.notes
          });
          warnings.push('FILM DATA was updated with the selected core type.');
        }
      } else {
        if (!effectiveCoreType) {
          throw new Error('CoreType is required the first time a received film is saved.');
        }

        var seedInitialWeight =
          initialWeightInput !== null
            ? initialWeightInput
            : existingBox && existingBox.initialWeightLbs !== null
              ? existingBox.initialWeightLbs
              : null;

        if (seedInitialWeight === null) {
          throw new Error('InitialWeightLbs is required the first time a received film is saved.');
        }

        resolvedCoreType = effectiveCoreType;
        resolvedCoreWeightLbs = deriveCoreWeightLbs_(effectiveCoreType, widthIn);
        var derivedSqFtWeight = deriveSqFtWeightLbsPerSqFt_(
          seedInitialWeight,
          resolvedCoreWeightLbs,
          widthIn,
          initialFeet
        );
        resolvedLfWeightLbsPerFt = deriveLfWeightLbsPerFt_(derivedSqFtWeight, widthIn);
        resolvedInitialWeightLbs = roundToDecimals_(seedInitialWeight, 2);

        if (resolvedLastRollWeightLbs === null) {
          resolvedLastRollWeightLbs =
            existingBox && existingBox.lastRollWeightLbs !== null
              ? existingBox.lastRollWeightLbs
              : resolvedInitialWeightLbs;
        }

        if (!resolvedLastWeighedDate) {
          resolvedLastWeighedDate = receivedDate;
        }

        upsertFilmDataRecord_({
          filmKey: filmKey,
          manufacturer: manufacturer,
          filmName: filmName,
          sqFtWeightLbsPerSqFt: derivedSqFtWeight,
          defaultCoreType: effectiveCoreType,
          sourceWidthIn: widthIn,
          sourceInitialFeet: initialFeet,
          sourceInitialWeightLbs: resolvedInitialWeightLbs,
          updatedAt: new Date().toISOString(),
          sourceBoxId: boxId,
          notes: ''
        });
        warnings.push('FILM DATA was created from the first received weight for ' + filmKey + '.');
      }
    } else {
      resolvedInitialWeightLbs = existingBox ? existingBox.initialWeightLbs : resolvedInitialWeightLbs;
      resolvedCoreType = coreTypeInput || existingCoreType;
      resolvedCoreWeightLbs = existingBox ? existingBox.coreWeightLbs : null;
      resolvedLfWeightLbsPerFt = existingBox ? existingBox.lfWeightLbsPerFt : null;
      resolvedLastRollWeightLbs =
        resolvedLastRollWeightLbs !== null
          ? resolvedLastRollWeightLbs
          : existingBox
            ? existingBox.lastRollWeightLbs
            : resolvedInitialWeightLbs;
      resolvedLastWeighedDate =
        resolvedLastWeighedDate || (existingBox ? existingBox.lastWeighedDate : receivedDate);
    }
  } else {
    resolvedInitialWeightLbs = null;
    resolvedLastRollWeightLbs = null;
    resolvedLastWeighedDate = '';
    resolvedCoreType = '';
    resolvedCoreWeightLbs = null;
    resolvedLfWeightLbsPerFt = null;
  }

  return {
    boxId: boxId,
    warehouse: determineWarehouseFromBoxId_(boxId),
    manufacturer: manufacturer,
    filmName: filmName,
    widthIn: widthIn,
    initialFeet: initialFeet,
    feetAvailable: feetAvailable,
    lotRun: asTrimmedString_(payload.lotRun),
    status:
      existingBox &&
      (existingBox.status === 'CHECKED_OUT' ||
        existingBox.status === 'ZEROED' ||
        existingBox.status === 'RETIRED')
        ? existingBox.status
        : deriveLifecycleStatus_(receivedDate),
    orderDate: orderDate,
    receivedDate: receivedDate,
    initialWeightLbs: resolvedInitialWeightLbs,
    lastRollWeightLbs: resolvedLastRollWeightLbs,
    lastWeighedDate: resolvedLastWeighedDate,
    filmKey: filmKey,
    coreType: resolvedCoreType,
    coreWeightLbs: resolvedCoreWeightLbs,
    lfWeightLbsPerFt: resolvedLfWeightLbsPerFt,
    purchaseCost: coerceOptionalNonNegativeNumber_(payload.purchaseCost, 'PurchaseCost'),
    notes: asTrimmedString_(payload.notes),
    hasEverBeenCheckedOut: existingBox ? existingBox.hasEverBeenCheckedOut === true : false,
    lastCheckoutJob: existingBox ? existingBox.lastCheckoutJob : '',
    lastCheckoutDate: existingBox ? existingBox.lastCheckoutDate : '',
    zeroedDate: '',
    zeroedReason: '',
    zeroedBy: ''
  };
}

function healthService_() {
  var sheetNames = getRequiredSheetNames_();

  for (var index = 0; index < sheetNames.length; index += 1) {
    if (sheetNames[index] === 'AuditLog') {
      getAuditSheet_();
    } else if (sheetNames[index] === 'FILM DATA') {
      getFilmDataSheet_();
    } else if (sheetNames[index] === 'ROLL WEIGHT LOG') {
      getRollWeightLogSheet_();
    } else if (sheetNames[index] === 'ALLOCATIONS') {
      getAllocationsSheet_();
    } else if (sheetNames[index] === 'FILM ORDERS') {
      getFilmOrdersSheet_();
    } else if (sheetNames[index] === 'FILM ORDER BOXES') {
      getFilmOrderBoxesSheet_();
    } else {
      getRequiredSheet_(sheetNames[index], BOX_HEADERS_);
    }
  }

  return {
    data: {
      status: 'ok',
      timestamp: new Date().toISOString(),
      sheets: sheetNames
    }
  };
}

function searchBoxesService_(params) {
  var warehouse = requireString_(params.warehouse, 'warehouse').toUpperCase();
  if (warehouse !== 'IL' && warehouse !== 'MS') {
    throw new Error('warehouse must be IL or MS.');
  }

  var query = asTrimmedString_(params.q).toLowerCase();
  var status = asTrimmedString_(params.status).toUpperCase();
  var film = asTrimmedString_(params.film).toLowerCase();
  var width = asTrimmedString_(params.width);
  var showRetired = String(params.showRetired) === 'true';

  var boxes = readWarehouseBoxes_(warehouse);
  if (showRetired || status === 'ZEROED') {
    boxes = boxes.concat(readSheetBoxes_(warehouse, true));
  }
  var filtered = [];

  for (var index = 0; index < boxes.length; index += 1) {
    var box = boxes[index];

    if (!showRetired && !status && (box.status === 'ZEROED' || box.status === 'RETIRED')) {
      continue;
    }

    if (status && box.status !== status) {
      continue;
    }

    if (width && String(box.widthIn) !== width) {
      continue;
    }

    if (
      film &&
      box.filmName.toLowerCase().indexOf(film) === -1 &&
      box.manufacturer.toLowerCase().indexOf(film) === -1 &&
      box.filmKey.toLowerCase().indexOf(film) === -1
    ) {
      continue;
    }

    if (query) {
      var haystack = [box.boxId, box.manufacturer, box.filmName, box.lotRun, box.filmKey]
        .join(' ')
        .toLowerCase();

      if (haystack.indexOf(query) === -1) {
        continue;
      }
    }

    filtered.push(toPublicBox_(cloneObject_(box)));
  }

  if (film) {
    var lowStock = [];
    var remaining = [];

    for (var filteredIndex = 0; filteredIndex < filtered.length; filteredIndex += 1) {
      if (isLowStockBox_(filtered[filteredIndex])) {
        lowStock.push(filtered[filteredIndex]);
      } else {
        remaining.push(filtered[filteredIndex]);
      }
    }

    lowStock.sort(function(a, b) {
      if (a.feetAvailable !== b.feetAvailable) {
        return a.feetAvailable - b.feetAvailable;
      }

      return a.boxId < b.boxId ? -1 : a.boxId > b.boxId ? 1 : 0;
    });

    filtered = lowStock.concat(remaining);
  }

  return { data: filtered };
}

function getBoxService_(params) {
  var found = findRowByBoxIdAcrossWarehouses_(params.boxId, true);
  if (!found) {
    throw new Error('Box not found.');
  }

  return {
    data: toPublicBox_(found.box)
  };
}

function getAllocationsByBoxService_(params) {
  var boxId = requireString_(params.boxId, 'boxId');
  var entries = readAllocationsByBox_(boxId);
  var response = [];

  for (var index = 0; index < entries.length; index += 1) {
    response.push(cloneObject_(entries[index]));
    delete response[response.length - 1].rowIndex;
  }

  return {
    data: {
      entries: response
    }
  };
}

function getAllocationPreviewService_(payload) {
  var source = findRowByBoxIdAcrossWarehouses_(payload.boxId, false);
  if (!source) {
    throw new Error('Box not found.');
  }

  if (source.box.status !== 'IN_STOCK') {
    throw new Error('Only in-stock boxes can be allocated.');
  }

  var jobContext = resolveJobContext_(payload.jobNumber, payload.jobDate, payload.crewLeader);
  var plan = buildAllocationPreviewPlan_(source.box, payload.requestedFeet, jobContext);

  return {
    data: plan
  };
}

function applyAllocationPlanService_(payload) {
  var warnings = [];
  var user = getAuthenticatedAuditUser_(payload);
  var boxId = requireString_(payload.boxId, 'BoxID');
  var lock = LockService.getScriptLock();

  lock.waitLock(30000);

  try {
    var source = findRowByBoxIdAcrossWarehouses_(boxId, false);
    if (!source) {
      throw new Error('Box not found.');
    }

    if (source.box.status !== 'IN_STOCK') {
      throw new Error('Only in-stock boxes can be allocated.');
    }

    var jobContext = resolveJobContext_(payload.jobNumber, payload.jobDate, payload.crewLeader);
    var plan = buildAllocationPreviewPlan_(source.box, payload.requestedFeet, jobContext);
    var selectedSuggestionBoxIds = [];

    if (Object.prototype.toString.call(payload.selectedSuggestionBoxIds) === '[object Array]') {
      for (var selectedIndex = 0; selectedIndex < payload.selectedSuggestionBoxIds.length; selectedIndex += 1) {
        selectedSuggestionBoxIds.push(asTrimmedString_(payload.selectedSuggestionBoxIds[selectedIndex]));
      }
    } else {
      for (var planIndex = 0; planIndex < plan.suggestions.length; planIndex += 1) {
        selectedSuggestionBoxIds.push(plan.suggestions[planIndex].boxId);
      }
    }

    var selection = calculateSelectedSuggestionAllocations_(plan, selectedSuggestionBoxIds);
    var createdAllocations = [];

    for (var index = 0; index < selection.allocations.length; index += 1) {
      var plannedAllocation = selection.allocations[index];
      if (plannedAllocation.allocatedFeet <= 0) {
        continue;
      }

      var found = findRowByBoxIdAcrossWarehouses_(plannedAllocation.boxId, false);
      if (!found || found.box.status !== 'IN_STOCK') {
        throw new Error('One of the suggested boxes is no longer available for allocation.');
      }

      if (found.box.feetAvailable < plannedAllocation.allocatedFeet) {
        throw new Error(
          found.box.boxId +
            ' no longer has enough Available Feet to cover the requested allocation.'
        );
      }

      var conflicts = getDateConflictJobsForBox_(found.box.boxId, jobContext);
      if (conflicts.length) {
        throw new Error(
          found.box.boxId +
            ' is already allocated to another job on ' +
            jobContext.jobDate +
            ' with a different crew leader.'
        );
      }

      var created = createAllocationRecord_(found, jobContext, plannedAllocation.allocatedFeet, user, '');
      decrementBoxFeetAvailableForAllocation_(found, plannedAllocation.allocatedFeet);
      var publicEntry = cloneObject_(created);
      delete publicEntry.rowIndex;
      createdAllocations.push(publicEntry);
    }

    var filmOrder = null;
    if (selection.remainingFeet > 0) {
      filmOrder = createFilmOrderForShortage_(
        source.box,
        jobContext,
        plan.requestedFeet,
        selection.remainingFeet,
        user
      );
      warnings.push(
        'A Film Order alert was created for the remaining ' +
          selection.remainingFeet +
          ' LF needed for job ' +
          jobContext.jobNumber +
          '.'
      );
    }

    if (createdAllocations.length > 0) {
      warnings.push(
        createdAllocations.length +
          ' allocation' +
          (createdAllocations.length === 1 ? ' was' : 's were') +
          ' created for job ' +
          jobContext.jobNumber +
          '.'
      );
    }

    return {
      data: {
        allocations: createdAllocations,
        filmOrder: filmOrder ? cloneObject_(filmOrder) : null,
        remainingUncoveredFeet: selection.remainingFeet
      },
      warnings: warnings
    };
  } finally {
    lock.releaseLock();
  }
}

function allocateBoxService_(payload) {
  return applyAllocationPlanService_(payload);
}

function buildPublicFilmOrderLinkedBoxes_(filmOrderId) {
  var links = readFilmOrderBoxLinksByFilmOrderId_(filmOrderId);
  var response = [];

  for (var index = 0; index < links.length; index += 1) {
    var link = links[index];
    if (!link.boxId) {
      continue;
    }

    if (!findRowByBoxIdAcrossWarehouses_(link.boxId, false) && !findZeroedRowByBoxIdAcrossWarehouses_(link.boxId)) {
      continue;
    }

    response.push({
      boxId: link.boxId,
      orderedFeet: link.orderedFeet,
      autoAllocatedFeet: link.autoAllocatedFeet
    });
  }

  response.sort(function(a, b) {
    return a.boxId < b.boxId ? -1 : a.boxId > b.boxId ? 1 : 0;
  });

  return response;
}

function resolveAllocationJobMetadata_(allocations, filmOrders) {
  var jobDate = '';
  var crewLeader = '';

  for (var index = 0; index < allocations.length; index += 1) {
    if (!jobDate && allocations[index].jobDate) {
      jobDate = allocations[index].jobDate;
    }

    if (!crewLeader && allocations[index].crewLeader) {
      crewLeader = allocations[index].crewLeader;
    }
  }

  for (var filmOrderIndex = 0; filmOrderIndex < filmOrders.length; filmOrderIndex += 1) {
    if (!jobDate && filmOrders[filmOrderIndex].jobDate) {
      jobDate = filmOrders[filmOrderIndex].jobDate;
    }

    if (!crewLeader && filmOrders[filmOrderIndex].crewLeader) {
      crewLeader = filmOrders[filmOrderIndex].crewLeader;
    }
  }

  return {
    jobDate: jobDate,
    crewLeader: crewLeader
  };
}

function buildAllocationJobSummary_(jobNumber, allocations, filmOrders) {
  var metadata = resolveAllocationJobMetadata_(allocations, filmOrders);
  var hasFilmOrder = false;
  var hasFilmOnTheWay = false;
  var hasActiveAllocation = false;
  var hasCancelledRecord = false;
  var hasFulfilledRecord = false;
  var activeAllocatedFeet = 0;
  var fulfilledAllocatedFeet = 0;
  var openFilmOrderCount = 0;
  var distinctBoxes = {};

  for (var allocationIndex = 0; allocationIndex < allocations.length; allocationIndex += 1) {
    var allocation = allocations[allocationIndex];
    if (allocation.boxId) {
      distinctBoxes[allocation.boxId] = true;
    }

    if (allocation.status === 'ACTIVE') {
      hasActiveAllocation = true;
      activeAllocatedFeet += allocation.allocatedFeet;
    } else if (allocation.status === 'FULFILLED') {
      hasFulfilledRecord = true;
      fulfilledAllocatedFeet += allocation.allocatedFeet;
    } else if (allocation.status === 'CANCELLED') {
      hasCancelledRecord = true;
    }
  }

  for (var filmOrderIndex = 0; filmOrderIndex < filmOrders.length; filmOrderIndex += 1) {
    var filmOrder = filmOrders[filmOrderIndex];

    if (filmOrder.status === 'FILM_ORDER') {
      hasFilmOrder = true;
      openFilmOrderCount += 1;
    } else if (filmOrder.status === 'FILM_ON_THE_WAY') {
      hasFilmOnTheWay = true;
      openFilmOrderCount += 1;
    } else if (filmOrder.status === 'FULFILLED') {
      hasFulfilledRecord = true;
    } else if (filmOrder.status === 'CANCELLED') {
      hasCancelledRecord = true;
    }
  }

  var status = 'READY';
  if (hasFilmOrder) {
    status = 'FILM_ORDER';
  } else if (hasFilmOnTheWay) {
    status = 'ON_ORDER';
  } else if (hasActiveAllocation) {
    status = 'READY';
  } else if (hasCancelledRecord) {
    status = 'CANCELLED';
  } else if (hasFulfilledRecord) {
    status = 'COMPLETED';
  }

  return {
    jobNumber: jobNumber,
    jobDate: metadata.jobDate,
    crewLeader: metadata.crewLeader,
    status: status,
    activeAllocatedFeet: activeAllocatedFeet,
    fulfilledAllocatedFeet: fulfilledAllocatedFeet,
    openFilmOrderCount: openFilmOrderCount,
    boxCount: Object.keys(distinctBoxes).length
  };
}

function compareAllocationJobSummaries_(a, b) {
  if (a.jobDate && b.jobDate && a.jobDate !== b.jobDate) {
    return a.jobDate < b.jobDate ? -1 : 1;
  }

  if (a.jobDate && !b.jobDate) {
    return -1;
  }

  if (!a.jobDate && b.jobDate) {
    return 1;
  }

  return a.jobNumber < b.jobNumber ? -1 : a.jobNumber > b.jobNumber ? 1 : 0;
}

function buildPublicAllocationJobEntry_(entry) {
  var publicEntry = cloneObject_(entry);
  delete publicEntry.rowIndex;
  publicEntry.manufacturer = '';
  publicEntry.filmName = '';
  publicEntry.widthIn = 0;
  publicEntry.boxStatus = '';

  var boxRecord = findRowByBoxIdAcrossWarehouses_(entry.boxId, true);
  if (boxRecord && boxRecord.box) {
    publicEntry.manufacturer = boxRecord.box.manufacturer;
    publicEntry.filmName = boxRecord.box.filmName;
    publicEntry.widthIn = boxRecord.box.widthIn;
    publicEntry.boxStatus = boxRecord.box.status;
  }

  return publicEntry;
}

function groupEntriesByJobNumber_(entries) {
  var grouped = {};

  for (var index = 0; index < entries.length; index += 1) {
    var entry = entries[index];
    if (!entry.jobNumber) {
      continue;
    }

    if (!grouped[entry.jobNumber]) {
      grouped[entry.jobNumber] = [];
    }

    grouped[entry.jobNumber].push(entry);
  }

  return grouped;
}

function getAllocationJobsService_() {
  var allAllocations = readAllocations_();
  var allFilmOrders = readFilmOrders_();
  var groupedAllocations = groupEntriesByJobNumber_(allAllocations);
  var groupedFilmOrders = groupEntriesByJobNumber_(allFilmOrders);
  var jobNumbers = {};
  var response = [];

  for (var allocationIndex = 0; allocationIndex < allAllocations.length; allocationIndex += 1) {
    if (allAllocations[allocationIndex].jobNumber) {
      jobNumbers[allAllocations[allocationIndex].jobNumber] = true;
    }
  }

  for (var filmOrderIndex = 0; filmOrderIndex < allFilmOrders.length; filmOrderIndex += 1) {
    if (allFilmOrders[filmOrderIndex].jobNumber) {
      jobNumbers[allFilmOrders[filmOrderIndex].jobNumber] = true;
    }
  }

  var keys = Object.keys(jobNumbers);
  for (var keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
    var jobNumber = keys[keyIndex];
    response.push(
      buildAllocationJobSummary_(
        jobNumber,
        groupedAllocations[jobNumber] || [],
        groupedFilmOrders[jobNumber] || []
      )
    );
  }

  response.sort(compareAllocationJobSummaries_);

  return {
    data: {
      entries: response
    }
  };
}

function getAllocationByJobService_(params) {
  var jobNumber = requireString_(params.jobNumber, 'jobNumber');
  var allocations = readAllocationsByJob_(jobNumber);
  var filmOrders = readFilmOrdersByJob_(jobNumber);
  var publicAllocations = [];
  var publicFilmOrders = [];

  if (!allocations.length && !filmOrders.length) {
    throw new Error('Job not found.');
  }

  allocations.sort(function(a, b) {
    if (a.status !== b.status) {
      return a.status === 'ACTIVE' ? -1 : b.status === 'ACTIVE' ? 1 : a.status < b.status ? -1 : 1;
    }

    if (a.jobDate !== b.jobDate) {
      if (a.jobDate && b.jobDate) {
        return a.jobDate < b.jobDate ? -1 : 1;
      }

      if (a.jobDate) {
        return -1;
      }

      if (b.jobDate) {
        return 1;
      }
    }

    return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
  });

  for (var allocationIndex = 0; allocationIndex < allocations.length; allocationIndex += 1) {
    publicAllocations.push(buildPublicAllocationJobEntry_(allocations[allocationIndex]));
  }

  filmOrders.sort(function(a, b) {
    return compareAllocationJobSummaries_(
      { jobDate: a.createdAt, jobNumber: a.filmOrderId },
      { jobDate: b.createdAt, jobNumber: b.filmOrderId }
    );
  });

  for (var filmOrderIndex = 0; filmOrderIndex < filmOrders.length; filmOrderIndex += 1) {
    var publicFilmOrder = cloneObject_(filmOrders[filmOrderIndex]);
    delete publicFilmOrder.rowIndex;
    publicFilmOrder.linkedBoxes = buildPublicFilmOrderLinkedBoxes_(publicFilmOrder.filmOrderId);
    publicFilmOrders.push(publicFilmOrder);
  }

  return {
    data: {
      summary: buildAllocationJobSummary_(jobNumber, allocations, filmOrders),
      allocations: publicAllocations,
      filmOrders: publicFilmOrders
    }
  };
}

function getFilmOrdersService_() {
  var entries = readFilmOrders_();
  var response = [];

  entries.sort(function(a, b) {
    var aOpen = a.status === 'FILM_ORDER' || a.status === 'FILM_ON_THE_WAY';
    var bOpen = b.status === 'FILM_ORDER' || b.status === 'FILM_ON_THE_WAY';

    if (aOpen !== bOpen) {
      return aOpen ? -1 : 1;
    }

    if (aOpen) {
      return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
    }

    var aResolved = a.resolvedAt || a.createdAt;
    var bResolved = b.resolvedAt || b.createdAt;
    return aResolved < bResolved ? -1 : aResolved > bResolved ? 1 : 0;
  });

  for (var index = 0; index < entries.length; index += 1) {
    var publicEntry = cloneObject_(entries[index]);
    delete publicEntry.rowIndex;
    publicEntry.linkedBoxes = buildPublicFilmOrderLinkedBoxes_(publicEntry.filmOrderId);
    response.push(publicEntry);
  }

  return {
    data: {
      entries: response
    }
  };
}

function createFilmOrderService_(payload) {
  var warnings = [];
  var user = getAuthenticatedAuditUser_(payload);
  var warehouse = requireString_(payload.warehouse, 'Warehouse').toUpperCase();
  var jobNumber = requireString_(payload.jobNumber, 'JobNumber');
  var manufacturer = requireString_(payload.manufacturer, 'Manufacturer');
  var filmName = requireString_(payload.filmName, 'FilmName');
  var widthIn = coerceNonNegativeNumber_(payload.widthIn, 'WidthIn');
  var requestedFeet = coerceFeetValue_(payload.requestedFeet, 'RequestedFeet', warnings, false);
  var lock = LockService.getScriptLock();
  var entry;
  var publicEntry;

  if (warehouse !== 'IL' && warehouse !== 'MS') {
    throw new Error('Warehouse must be IL or MS.');
  }

  if (widthIn <= 0) {
    throw new Error('WidthIn must be greater than zero.');
  }

  if (requestedFeet <= 0) {
    throw new Error('RequestedFeet must be greater than zero.');
  }

  lock.waitLock(30000);

  try {
    entry = appendFilmOrder_({
      filmOrderId: '',
      jobNumber: jobNumber,
      warehouse: warehouse,
      manufacturer: manufacturer,
      filmName: filmName,
      widthIn: widthIn,
      requestedFeet: requestedFeet,
      coveredFeet: 0,
      orderedFeet: 0,
      remainingToOrderFeet: requestedFeet,
      jobDate: '',
      crewLeader: '',
      status: 'FILM_ORDER',
      sourceBoxId: '',
      createdAt: new Date().toISOString(),
      createdBy: asTrimmedString_(user),
      resolvedAt: '',
      resolvedBy: '',
      notes: 'Created manually from Film Orders.'
    });

    publicEntry = cloneObject_(entry);
    delete publicEntry.rowIndex;
    publicEntry.linkedBoxes = [];

    return {
      data: publicEntry,
      warnings: warnings
    };
  } finally {
    lock.releaseLock();
  }
}

function cancelJobService_(payload) {
  var warnings = [];
  var user = getAuthenticatedAuditUser_(payload);
  var jobNumber = requireString_(payload.jobNumber, 'JobNumber');
  var lock = LockService.getScriptLock();

  lock.waitLock(30000);

  try {
    var result = cancelJobAndReleaseAllocations_(jobNumber, user, payload.reason);
    warnings.push(
      'Cancelled job ' +
        jobNumber +
        '. Released ' +
        result.releasedAllocationCount +
        ' active allocation' +
        (result.releasedAllocationCount === 1 ? '' : 's') +
        ' across ' +
        result.affectedBoxCount +
        ' box' +
        (result.affectedBoxCount === 1 ? '' : 'es') +
        '.'
    );

    return {
      data: {
        jobNumber: jobNumber
      },
      warnings: warnings
    };
  } finally {
    lock.releaseLock();
  }
}

function getRollHistoryByBoxService_(params) {
  var boxId = requireString_(params.boxId, 'boxId');
  var entries = readRollWeightLogByBox_(boxId);
  var response = [];

  for (var index = 0; index < entries.length; index += 1) {
    response.push(cloneObject_(entries[index]));
    delete response[response.length - 1].rowIndex;
  }

  return {
    data: {
      entries: response
    }
  };
}

function boxMatchesReportFilters_(box, filters) {
  if (filters.warehouse && box.warehouse !== filters.warehouse) {
    return false;
  }

  if (
    filters.manufacturer &&
    box.manufacturer.toLowerCase().indexOf(filters.manufacturer.toLowerCase()) === -1
  ) {
    return false;
  }

  if (
    filters.film &&
    box.filmName.toLowerCase().indexOf(filters.film.toLowerCase()) === -1 &&
    box.filmKey.toLowerCase().indexOf(filters.film.toLowerCase()) === -1 &&
    box.manufacturer.toLowerCase().indexOf(filters.film.toLowerCase()) === -1
  ) {
    return false;
  }

  if (filters.width && String(box.widthIn) !== filters.width) {
    return false;
  }

  return true;
}

function getReportsSummaryService_(params) {
  var filters = {
    warehouse: asTrimmedString_(params.warehouse).toUpperCase(),
    manufacturer: asTrimmedString_(params.manufacturer),
    film: asTrimmedString_(params.film),
    width: asTrimmedString_(params.width),
    from: asTrimmedString_(params.from),
    to: asTrimmedString_(params.to)
  };
  var allBoxes = listAllBoxes_().concat(readSheetBoxes_('IL', true)).concat(readSheetBoxes_('MS', true));
  var activeBoxes = listAllBoxes_();
  var widthGroups = {};
  var availableFeetByWidth = [];
  var neverCheckedOut = [];
  var zeroedByMonthMap = {};
  var zeroedByMonth = [];
  var index;

  for (index = 0; index < activeBoxes.length; index += 1) {
    var activeBox = activeBoxes[index];
    if (!boxMatchesReportFilters_(activeBox, filters)) {
      continue;
    }

    var widthKey = String(activeBox.widthIn);
    if (!widthGroups[widthKey]) {
      widthGroups[widthKey] = {
        widthIn: activeBox.widthIn,
        totalFeetAvailable: 0,
        boxCount: 0
      };
    }

    widthGroups[widthKey].totalFeetAvailable += activeBox.feetAvailable;
    widthGroups[widthKey].boxCount += 1;
  }

  for (var widthGroupKey in widthGroups) {
    if (Object.prototype.hasOwnProperty.call(widthGroups, widthGroupKey)) {
      availableFeetByWidth.push(widthGroups[widthGroupKey]);
    }
  }

  availableFeetByWidth.sort(function(a, b) {
    return a.widthIn - b.widthIn;
  });

  for (index = 0; index < allBoxes.length; index += 1) {
    var box = allBoxes[index];
    if (!boxMatchesReportFilters_(box, filters)) {
      continue;
    }

    if (box.receivedDate && !box.hasEverBeenCheckedOut) {
      if (filters.from && box.receivedDate < filters.from) {
        continue;
      }

      if (filters.to && box.receivedDate > filters.to) {
        continue;
      }

      neverCheckedOut.push({
        boxId: box.boxId,
        warehouse: box.warehouse,
        manufacturer: box.manufacturer,
        filmName: box.filmName,
        widthIn: box.widthIn,
        receivedDate: box.receivedDate,
        status: box.status,
        feetAvailable: box.feetAvailable
      });
    }

    if (box.status === 'ZEROED' && box.zeroedDate) {
      if (filters.from && box.zeroedDate < filters.from) {
        continue;
      }

      if (filters.to && box.zeroedDate > filters.to) {
        continue;
      }

      var monthKey = box.zeroedDate.slice(0, 7);
      zeroedByMonthMap[monthKey] = (zeroedByMonthMap[monthKey] || 0) + 1;
    }
  }

  neverCheckedOut.sort(function(a, b) {
    if (a.receivedDate !== b.receivedDate) {
      return a.receivedDate < b.receivedDate ? -1 : 1;
    }

    return a.boxId < b.boxId ? -1 : a.boxId > b.boxId ? 1 : 0;
  });

  for (var month in zeroedByMonthMap) {
    if (Object.prototype.hasOwnProperty.call(zeroedByMonthMap, month)) {
      zeroedByMonth.push({
        month: month,
        zeroedCount: zeroedByMonthMap[month]
      });
    }
  }

  zeroedByMonth.sort(function(a, b) {
    return a.month < b.month ? -1 : a.month > b.month ? 1 : 0;
  });

  return {
    data: {
      availableFeetByWidth: availableFeetByWidth,
      neverCheckedOut: neverCheckedOut,
      zeroedByMonth: zeroedByMonth
    }
  };
}

function addBoxService_(payload) {
  var warnings = [];
  var user = getAuthenticatedAuditUser_(payload);
  var boxId = requireString_(payload.boxId, 'BoxID');
  var lock = LockService.getScriptLock();

  lock.waitLock(30000);

  try {
    if (findRowByBoxIdAcrossWarehouses_(boxId, true)) {
      throw new Error('A box with this BoxID already exists.');
    }

    var box = buildBoxFromPayload_(payload, warnings, null);
    applyAddOrEditWarnings_(warnings, null, box);
    var rowIndex = appendBoxRow_(box.warehouse, box);

    if (asTrimmedString_(payload.filmOrderId)) {
      var linkedOrder = linkBoxToFilmOrder_(payload.filmOrderId, box, user);
      warnings.push(
        'Box ' +
          box.boxId +
          ' was linked to Film Order ' +
          linkedOrder.filmOrderId +
          ' for job ' +
          linkedOrder.jobNumber +
          '.'
      );

      if (box.receivedDate && box.status === 'IN_STOCK') {
        box.rowIndex = rowIndex;
        box = processLinkedFilmOrderReceipt_(box, user, warnings);
        updateBoxRow_(box.warehouse, rowIndex, box);
      }
    }

    var publicBox = toPublicBox_(box);
    var logId = appendAudit_(
      'ADD_BOX',
      box.boxId,
      null,
      publicBox,
      user,
      asTrimmedString_(payload.auditNote)
    );

    return {
      data: {
        box: publicBox,
        logId: logId
      },
      warnings: warnings
    };
  } finally {
    lock.releaseLock();
  }
}

function updateBoxService_(payload) {
  var warnings = [];
  var user = getAuthenticatedAuditUser_(payload);
  var existing = findRowByBoxIdAcrossWarehouses_(payload.boxId, true);
  var lock = LockService.getScriptLock();
  var requestedMoveToZeroed = payload.moveToZeroed === true || String(payload.moveToZeroed) === 'true';

  if (!existing) {
    throw new Error('Box not found.');
  }

  lock.waitLock(30000);

  try {
    existing = findRowByBoxIdAcrossWarehouses_(payload.boxId, true);
    if (!existing) {
      throw new Error('Box not found.');
    }

    if (existing.useZeroed || existing.box.status === 'ZEROED') {
      throw new Error('Zeroed boxes cannot be edited directly. Use audit undo instead.');
    }

    var updatedBox = buildBoxFromPayload_(payload, warnings, existing.box);
    if (
      existing.box.status !== 'CHECKED_OUT' &&
      existing.box.status !== 'RETIRED' &&
      deriveLifecycleStatus_(existing.box.receivedDate) === 'ORDERED' &&
      updatedBox.status === 'IN_STOCK'
    ) {
      updatedBox.feetAvailable = updatedBox.initialFeet;
    }

    applyAddOrEditWarnings_(warnings, existing.box, updatedBox);

    var auditAction = 'UPDATE_BOX';
    var autoMoveToZeroed = shouldAutoMoveToZeroed_(existing.box, updatedBox);
    var moveToZeroed = requestedMoveToZeroed || autoMoveToZeroed;
    var reachedZeroState =
      Boolean(updatedBox.receivedDate) &&
      (updatedBox.feetAvailable === 0 || updatedBox.lastRollWeightLbs === 0);

    if (moveToZeroed) {
      if (!autoMoveToZeroed) {
        throw new Error(
          'Received boxes move to zeroed out inventory only after they have had Available Feet above 0 and then reach 0 Available Feet or 0 Last Roll Weight.'
        );
      }

      if (findZeroedRowByBoxIdAcrossWarehouses_(updatedBox.boxId)) {
        throw new Error('A box with this BoxID already exists in zeroed out inventory.');
      }

      stampZeroedMetadata_(updatedBox, user, payload.auditNote);
      var cancelledAllocationCount = cancelActiveAllocationsForBox_(
        updatedBox.boxId,
        user,
        'Auto-cancelled because the box was moved to zeroed out inventory.'
      );
      appendBoxRow_(existing.warehouse, updatedBox, true);
      deleteBoxRow_(existing.warehouse, existing.rowIndex);
      auditAction = 'ZERO_OUT_BOX';

      if (autoMoveToZeroed && !requestedMoveToZeroed) {
        warnings.push(
          'Box was automatically moved to zeroed out inventory because Available Feet or Last Roll Weight reached 0.'
        );
      }

      if (cancelledAllocationCount > 0) {
        warnings.push(
          cancelledAllocationCount +
            ' active allocation' +
            (cancelledAllocationCount === 1 ? ' was' : 's were') +
            ' cancelled because the box moved to zeroed out inventory.'
        );
      }
    } else {
      if (reachedZeroState && !hasPositivePhysicalFeet_(existing.box)) {
        warnings.push(
          'Box stayed in active inventory because it has not had Available Feet above 0 yet.'
        );
      }
      updatedBox.rowIndex = existing.rowIndex;
      updatedBox = processLinkedFilmOrderReceipt_(updatedBox, user, warnings);
      updateBoxRow_(existing.warehouse, existing.rowIndex, updatedBox);
    }

    var publicBefore = toPublicBox_(existing.box);
    var publicAfter = toPublicBox_(updatedBox);
    var logId = appendAudit_(
      auditAction,
      updatedBox.boxId,
      publicBefore,
      publicAfter,
      user,
      asTrimmedString_(payload.auditNote)
    );

    return {
      data: {
        box: publicAfter,
        logId: logId
      },
      warnings: warnings
    };
  } finally {
    lock.releaseLock();
  }
}

function setBoxStatusService_(payload) {
  var warnings = [];
  var user = getAuthenticatedAuditUser_(payload);
  var status = assertBoxStatus_(payload.status);
  var lock = LockService.getScriptLock();

  if (status === 'ORDERED') {
    throw new Error('ORDERED is derived from ReceivedDate and cannot be set manually.');
  }

  if (status === 'RETIRED') {
    throw new Error('RETIRED status is no longer supported.');
  }

  if (status === 'ZEROED') {
    throw new Error('ZEROED status is assigned automatically when a received box reaches 0.');
  }

  lock.waitLock(30000);

  try {
    var existing = findRowByBoxIdAcrossWarehouses_(payload.boxId, true);
    if (!existing) {
      throw new Error('Box not found.');
    }

    if (deriveLifecycleStatus_(existing.box.receivedDate) === 'ORDERED') {
      throw new Error('Add a ReceivedDate on or before today before changing status.');
    }

    if (existing.useZeroed || existing.box.status === 'ZEROED') {
      throw new Error('Zeroed boxes cannot change status directly. Use audit undo instead.');
    }

    if (existing.box.status === 'RETIRED') {
      throw new Error('Retired boxes cannot change status directly. Use audit undo instead.');
    }

    var updatedBox = cloneObject_(existing.box);
    var auditAction = 'SET_STATUS';

    if (status === 'CHECKED_OUT') {
      var jobNumber = getCheckoutJobNumberFromAuditNotes_(payload.auditNote);
      if (!jobNumber) {
        throw new Error('A checkout job number is required.');
      }

      updatedBox.status = 'CHECKED_OUT';
      updatedBox.hasEverBeenCheckedOut = true;
      updatedBox.lastCheckoutJob = jobNumber;
      updatedBox.lastCheckoutDate = getTodayDateString_();
      updatedBox.zeroedDate = '';
      updatedBox.zeroedReason = '';
      updatedBox.zeroedBy = '';
      applyCheckoutWarnings_(warnings, existing.box);
      var allocationResolution = resolveAllocationsForCheckout_(updatedBox.boxId, jobNumber, user);
      if (allocationResolution.fulfilledCount > 0) {
        warnings.push(
          'Fulfilled ' +
            allocationResolution.fulfilledCount +
            ' allocation' +
            (allocationResolution.fulfilledCount === 1 ? '' : 's') +
            ' totaling ' +
            allocationResolution.fulfilledFeet +
            ' LF for job ' +
            jobNumber +
            '.'
        );
      }

      if (allocationResolution.otherJobs.length > 0) {
        warnings.push(
          'This box still has active allocations for ' +
            allocationResolution.otherJobs.join(', ') +
            '.'
        );
      }
      updateBoxRow_(existing.warehouse, existing.rowIndex, updatedBox);
    } else {
      updatedBox.status = 'IN_STOCK';
      updatedBox.lastRollWeightLbs = coerceNonNegativeNumber_(payload.lastRollWeightLbs, 'LastRollWeightLbs');
      updatedBox.lastWeighedDate = getTodayDateString_();
      var physicalFeetAvailable = updatedBox.feetAvailable;

      if (
        updatedBox.coreWeightLbs !== null &&
        updatedBox.lfWeightLbsPerFt !== null &&
        updatedBox.lfWeightLbsPerFt > 0
      ) {
        physicalFeetAvailable = deriveFeetAvailableFromRollWeight_(
          updatedBox.lastRollWeightLbs,
          updatedBox.coreWeightLbs,
          updatedBox.lfWeightLbsPerFt,
          updatedBox.initialFeet
        );
      } else {
        warnings.push(
          'Available Feet could not be recalculated because this box is missing core or LF weight metadata.'
        );
      }

      var activeAllocatedFeetAfterCheckIn = getActiveAllocatedFeetForBox_(updatedBox.boxId);
      updatedBox.feetAvailable = Math.max(physicalFeetAvailable - activeAllocatedFeetAfterCheckIn, 0);
      var willAutoZero =
        Boolean(updatedBox.receivedDate) &&
        existing.box.initialFeet > 0 &&
        (physicalFeetAvailable === 0 || updatedBox.lastRollWeightLbs === 0);

      applyCheckInWarnings_(warnings, existing.box, updatedBox, willAutoZero);
      if (activeAllocatedFeetAfterCheckIn > physicalFeetAvailable) {
        warnings.push(
          'This box now has more LF allocated to future jobs than the weight-based remaining feet.'
        );
      } else if (activeAllocatedFeetAfterCheckIn > 0 && updatedBox.feetAvailable === 0) {
        warnings.push('All remaining LF on this box is reserved by active allocations.');
      }

      var checkoutAudit = findLatestCheckoutAuditEntryByBoxId_(updatedBox.boxId);
      var checkoutJob = asTrimmedString_(existing.box.lastCheckoutJob);
      var checkoutDate = asTrimmedString_(existing.box.lastCheckoutDate);
      var checkoutUser = '';

      if (checkoutAudit) {
        if (!checkoutJob) {
          checkoutJob = getCheckoutJobNumberFromAuditNotes_(checkoutAudit.notes);
        }

        if (!checkoutDate) {
          checkoutDate = asTrimmedString_(checkoutAudit.date);
        }

        checkoutUser = asTrimmedString_(checkoutAudit.user);
      }

      if (!checkoutJob) {
        checkoutJob = 'UNKNOWN';
        warnings.push('Roll history was logged with UNKNOWN job number because no checkout job was saved.');
      }

      if (!checkoutDate) {
        checkoutDate = getTodayDateString_();
      }

      var checkedOutWeight = existing.box.lastRollWeightLbs;
      var weightDelta =
        checkedOutWeight === null
          ? null
          : roundToDecimals_(checkedOutWeight - updatedBox.lastRollWeightLbs, 2);

      if (checkedOutWeight === null) {
        warnings.push(
          'Roll history was logged without an outbound weight because no Last Roll Weight was saved at checkout.'
        );
      }

      appendRollWeightLog_({
        logId: '',
        boxId: updatedBox.boxId,
        warehouse: updatedBox.warehouse,
        manufacturer: updatedBox.manufacturer,
        filmName: updatedBox.filmName,
        widthIn: updatedBox.widthIn,
        jobNumber: checkoutJob,
        checkedOutAt: checkoutDate,
        checkedOutBy: checkoutUser,
        checkedOutWeightLbs: checkedOutWeight,
        checkedInAt: new Date().toISOString(),
        checkedInBy: asTrimmedString_(user),
        checkedInWeightLbs: updatedBox.lastRollWeightLbs,
        weightDeltaLbs: weightDelta,
        feetBefore: existing.box.feetAvailable,
        feetAfter: updatedBox.feetAvailable,
        notes: asTrimmedString_(payload.auditNote)
      });

      updatedBox.lastCheckoutJob = '';
      updatedBox.lastCheckoutDate = '';

      var reachedZeroState =
        Boolean(updatedBox.receivedDate) &&
        (physicalFeetAvailable === 0 || updatedBox.lastRollWeightLbs === 0);
      var autoMoveToZeroed = willAutoZero;

      if (autoMoveToZeroed) {
        if (findZeroedRowByBoxIdAcrossWarehouses_(updatedBox.boxId)) {
          throw new Error('A box with this BoxID already exists in zeroed out inventory.');
        }

        stampZeroedMetadata_(updatedBox, user, payload.auditNote);
        var cancelledAllocationCount = cancelActiveAllocationsForBox_(
          updatedBox.boxId,
          user,
          'Auto-cancelled because the box was moved to zeroed out inventory.'
        );
        appendBoxRow_(existing.warehouse, updatedBox, true);
        deleteBoxRow_(existing.warehouse, existing.rowIndex);
        auditAction = 'ZERO_OUT_BOX';
        warnings.push(
          'Box was automatically moved to zeroed out inventory because Available Feet or Last Roll Weight reached 0.'
        );

        if (cancelledAllocationCount > 0) {
          warnings.push(
            cancelledAllocationCount +
              ' active allocation' +
              (cancelledAllocationCount === 1 ? ' was' : 's were') +
              ' cancelled because the box moved to zeroed out inventory.'
          );
        }
      } else {
        if (reachedZeroState && existing.box.feetAvailable <= 0) {
          warnings.push(
            'Box stayed in active inventory because it has not had Available Feet above 0 yet.'
          );
        }

        updateBoxRow_(existing.warehouse, existing.rowIndex, updatedBox);
      }
    }

    var publicBefore = toPublicBox_(existing.box);
    var publicAfter = toPublicBox_(updatedBox);
    var logId = appendAudit_(
      auditAction,
      updatedBox.boxId,
      publicBefore,
      publicAfter,
      user,
      asTrimmedString_(payload.auditNote)
    );

    return {
      data: {
        box: publicAfter,
        logId: logId
      },
      warnings: warnings
    };
  } finally {
    lock.releaseLock();
  }
}

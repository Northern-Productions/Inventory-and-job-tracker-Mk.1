// Purpose: Transfer guard, usage timeline, and roll-history runtime helpers.
import {
  HttpError,
  ZEROED_BOX_AUTO_CANCEL_NOTE,
  queryRow,
  queryRows,
  ok,
  asTrimmedString,
  requireString,
  normalizeStringArrayParam,
  normalizeUsername,
  normalizeDateString,
  coerceNonNegativeNumber,
  coerceOptionalNonNegativeNumber,
  coerceFeetValue,
  assertBoxStatus,
  isAllocatableBoxStatus,
  computeAllocationPlanningFeet,
  getBoxAllocationPlanningFeet,
  boxUsesOrderedPlanning,
  boxCanReceiveReleasedAllocationFeet,
  applyPlanningAllocationToBox,
  releaseAllocationFeetFromBox,
  hasActiveOrderedAllocations,
  hasActiveOrderedRequirementAllocations,
  buildOrderedAllocationReceiptMessage,
  parseBooleanFlag,
  parseStrictBooleanFlag,
  numericOrNull,
  integerOrZero,
  integerOrNull,
  normalizeAllocationKind,
  parseIntegerInput,
  requireUuid,
  cloneValue,
  createLogId,
  createTransferId,
  roundToDecimals,
  normalizeWarehouseCodeFormat,
  buildFilmKey,
  todayDateString,
  deriveAddFeetAvailable,
  deriveLifecycleStatus,
  normalizeCoreType,
  deriveCoreWeightLbs,
  deriveLfWeightLbsPerFt,
  deriveInitialWeightLbs,
  deriveSqFtWeightLbsPerSqFt,
  deriveFeetAvailableFromRollWeight,
  clampFeetToInitialRange,
  deriveLfWeightLbsPerFtIfPossible,
  isLowStockBox,
  hasPositivePhysicalFeet,
  hasIncompleteBoxHistoryForZeroedEdit,
  hasExplicitZeroNumericInput,
  hasExplicitZeroFeetAvailableInput,
  determineZeroedReason,
  normalizeMeaningfulZeroedNote,
  stampZeroedMetadata,
  applyAddOrEditWarnings,
  applyCheckoutWarnings,
  applyCheckInWarnings,
  compareCatalogStrings,
  normalizeRequirementWidthKey,
  canonicalizeNumericDigits,
  normalizeCollapsedCatalogLabel,
  canonicalizeManufacturerLabel,
  normalizeCatalogLookupKey,
  normalizeCatalogManufacturerLookupKey,
  assertAveryNaturaShadeForWrite,
  normalizeCanonicalManufacturerAndFilm,
  normalizeCatalogWriteManufacturerAndFilm,
  normalizeFilmKeyInput,
  normalizeCatalogWriteFilmKeyInput,
  resolveCanonicalFilmNameAlias,
  resolveCanonicalFilmEntry,
  resolveCatalogWriteFilmEntry,
  dedupeNormalizedJobRequirements,
  canonicalizeJobRequirementEntriesWithAliases,
  normalizeJobRequirementInput,
  normalizeJobNumberDigits,
  normalizeJobWarehouse,
  normalizeJobSections,
  normalizeJobLifecycleStatus,
  normalizeJobLifecycleFilter,
  normalizeJobRequirementLookupKey,
  dedupeJobRequirements,
  normalizeJobNumberKey,
  normalizeCrewLeaderKey,
  compareBoxesByOldestStock,
  compareAllocationJobSummaries,
  compareJobsListEntries,
  extractJobNumberDigitsForSearch,
  compareBigInt,
  absoluteBigInt,
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
  listWarehouseCodes,
  requireConfiguredWarehouse,
  findWarehouseEntry,
  getBoxIdPrefixToken,
  getTransferredBoxIdSuffix,
  buildTransferredBoxId,
  resolveBoxIdAlias,
  resolveWarehouseFromBoxId,
  buildBoxSelectColumns,
  listBoxes,
  findBoxById,
  saveBoxRecord,
  findBoxByRecordId,
  findBoxTransferByTransferId,
  listBoxTransfersByBoxRecordId,
  getLatestBoxTransferByBoxId,
  findPendingBoxTransferByBoxRecordId,
  findPendingBoxTransferByDestinationBoxId,
  listPendingBoxTransfersByBoxRecordIds,
  indexPendingBoxTransfersByBoxRecordId,
  saveBoxTransferRecord,
  deleteBoxRecord,
  listAllocationsByBox,
  listFilmCatalog,
  findFilmCatalogByFilmKey,
  seedFilmCatalogRecordIfMissing,
  upsertFilmCatalogRecord,
  listAllocations,
  listAllocationsByJob,
  listAllocationsByFilmOrderId,
  listActiveAllocations,
  saveAllocationRecord,
  listFilmOrders,
  listFilmOrdersByJob,
  findFilmOrderById,
  saveFilmOrderRecord,
  deleteFilmOrderRecord,
  listFilmOrderLinks,
  listFilmOrderLinksByFilmOrderId,
  listFilmOrderLinksByBoxId,
  saveFilmOrderLinkRecord,
  deleteFilmOrderLinksByFilmOrderId,
  listJobs,
  findJobByNumber,
  saveJobRecord,
  listJobRequirements,
  listJobRequirementsByJob,
  listJobCaulkRequirements,
  listJobCaulkRequirementsByJob,
  listCaulkJobAllocations,
  listCaulkJobAllocationsByJob,
  listCaulkJobCheckoutsByJob,
  replaceJobRequirementsForJob,
  normalizeJobCaulkRequirementEntries,
  replaceJobCaulkRequirementsForJob,
  parseExplicitJobLaborOnlyValue,
  hasJobMaterialRequirements,
  derivePersistedJobMaterialFlags,
  deleteJobRequirementsByJobId,
  deleteJobRecord,
  listAuditEntries,
  listAuditEntriesByBox,
  findAuditEntryByLogId,
  appendAuditEntry,
  listRollHistoryByBox,
  listRollHistoryByJob,
  computeCoveredFeetForAllocation,
  isSplitCoveragePair,
  planCoverageAllocation,
  matchesBoxSearchQuery,
  rankBoxSearchCandidates,
  canSharedJobPlanningFilmSatisfyRequirement,
  compareSharedJobPlanningFilmMatches,
  describeSharedJobPlanningFilm,
  getSharedJobPlanningFilmMatch,
  rankJobNumberSearchCandidates,
} from '../runtimeDeps.mjs';

async function listActiveAllocationTransferTargetsForBox(client, orgId, boxId) {
  const canonicalBoxId = await resolveBoxIdAlias(client, orgId, boxId);
  const rows = await queryRows(
    client,
    `
      select
        a.allocation_id,
        a.job_number,
        j.warehouse as job_warehouse
      from app.allocations a
      left join app.jobs j
        on j.org_id = a.org_id
       and upper(trim(j.job_number)) = upper(trim(a.job_number))
      where a.org_id = $1
        and a.box_id = $2
        and a.status = 'ACTIVE'
      order by a.created_at asc, a.allocation_id asc
    `,
    [orgId, canonicalBoxId]
  );

  return rows.map((row) => ({
    allocationId: asTrimmedString(row.allocation_id),
    jobNumber: asTrimmedString(row.job_number),
    jobWarehouse: asTrimmedString(row.job_warehouse).toUpperCase()
  }));
}

function getTransferStartGuardForBox(box, activeTargets) {
  const sourceWarehouse = asTrimmedString(box?.warehouse).toUpperCase();
  const normalizedTargets = Array.isArray(activeTargets) ? activeTargets : [];
  const distinctDestinations = new Set();
  let hasSameWarehouseAllocation = false;

  for (let index = 0; index < normalizedTargets.length; index += 1) {
    const destinationWarehouse = asTrimmedString(normalizedTargets[index]?.jobWarehouse).toUpperCase();
    if (!destinationWarehouse) {
      continue;
    }

    if (destinationWarehouse === sourceWarehouse) {
      hasSameWarehouseAllocation = true;
      continue;
    }

    distinctDestinations.add(destinationWarehouse);
  }

  if (hasSameWarehouseAllocation) {
    return {
      suggestedDestinationWarehouse: '',
      blockingMessage:
        `Box ${box.boxId} still has active allocations for jobs in ${sourceWarehouse}. Remove those same-warehouse allocations before starting a transfer.`
    };
  }

  if (distinctDestinations.size > 1) {
    return {
      suggestedDestinationWarehouse: '',
      blockingMessage:
        `Box ${box.boxId} has active allocations for multiple destination warehouses. Clear the conflicting allocations before starting a transfer.`
    };
  }

  return {
    suggestedDestinationWarehouse: Array.from(distinctDestinations)[0] || '',
    blockingMessage: ''
  };
}

async function findBoxIdConflict(
  client,
  orgId,
  boxId,
  { excludedBoxRecordId = '', excludedTransferId = '' } = {}
) {
  const normalizedBoxId = requireString(boxId, 'BoxID').toUpperCase();
  const existingBox = await queryRow(
    client,
    `
      select id
      from app.boxes
      where org_id = $1
        and box_id = $2
      limit 1
    `,
    [orgId, normalizedBoxId]
  );

  const aliasRow = await queryRow(
    client,
    `
      select
        a.canonical_box_id,
        b.id as canonical_box_record_id
      from app.box_id_aliases a
      left join app.boxes b
        on b.org_id = a.org_id
       and b.box_id = a.canonical_box_id
      where a.org_id = $1
        and a.old_box_id = $2
      limit 1
    `,
    [orgId, normalizedBoxId]
  );

  if (existingBox) {
    if (!excludedBoxRecordId || asTrimmedString(existingBox.id) !== asTrimmedString(excludedBoxRecordId)) {
      return {
        conflictType: 'box',
        conflictBoxId: normalizedBoxId
      };
    }
  }

  if (
    aliasRow &&
    excludedBoxRecordId &&
    asTrimmedString(aliasRow.canonical_box_record_id) === asTrimmedString(excludedBoxRecordId)
  ) {
    return null;
  }

  if (aliasRow) {
    return {
      conflictType: 'alias',
      conflictBoxId: asTrimmedString(aliasRow.canonical_box_id).toUpperCase() || normalizedBoxId
    };
  }

  const pendingTransfer = await findPendingBoxTransferByDestinationBoxId(client, orgId, normalizedBoxId);
  if (
    pendingTransfer &&
    asTrimmedString(pendingTransfer.transferId) !== asTrimmedString(excludedTransferId)
  ) {
    return {
      conflictType: 'pending_transfer',
      conflictBoxId: asTrimmedString(pendingTransfer.destinationBoxId).toUpperCase() || normalizedBoxId
    };
  }

  return null;
}

async function boxIdOrAliasExists(client, orgId, boxId, excludedBoxRecordId = '') {
  return Boolean(
    await findBoxIdConflict(client, orgId, boxId, {
      excludedBoxRecordId
    })
  );
}

async function releaseReusableBoxIdAlias(client, orgId, boxId, boxRecordId) {
  const normalizedBoxId = requireString(boxId, 'BoxID').toUpperCase();
  const normalizedBoxRecordId = requireString(boxRecordId, 'Box record ID');
  const aliasRow = await queryRow(
    client,
    `
      select
        a.old_box_id,
        a.canonical_box_id,
        b.id as canonical_box_record_id
      from app.box_id_aliases a
      left join app.boxes b
        on b.org_id = a.org_id
       and b.box_id = a.canonical_box_id
      where a.org_id = $1
        and a.old_box_id = $2
      limit 1
    `,
    [orgId, normalizedBoxId]
  );

  if (!aliasRow) {
    return false;
  }

  if (asTrimmedString(aliasRow.canonical_box_record_id) !== normalizedBoxRecordId) {
    return false;
  }

  await client.query(
    `
      delete from app.box_id_aliases
      where org_id = $1
        and old_box_id = $2
    `,
    [orgId, normalizedBoxId]
  );

  return true;
}

async function applyReceivedBoxTransfer(client, orgId, box, destinationWarehouse, destinationBoxId, actor) {
  const sourceBoxId = requireString(box?.boxId, 'SourceBoxID').toUpperCase();
  const sourceBoxRecordId = requireString(box?.id, 'Box record ID');
  const normalizedDestinationWarehouse = normalizeWarehouseCodeFormat(destinationWarehouse, 'ToWarehouse');
  const normalizedDestinationBoxId = requireString(destinationBoxId, 'DestinationBoxID').toUpperCase();
  const normalizedActor = asTrimmedString(actor);
  const nowIso = new Date().toISOString();

  await client.query(
    `
      update app.boxes
      set
        box_id = $3,
        warehouse = $4,
        status = 'IN_STOCK',
        updated_at = $5::timestamptz,
        updated_by = $6
      where org_id = $1
        and id = $2::uuid
    `,
    [orgId, sourceBoxRecordId, normalizedDestinationBoxId, normalizedDestinationWarehouse, nowIso, normalizedActor]
  );

  await client.query(
    `
      update app.allocations
      set
        box_id = $3,
        warehouse = $4
      where org_id = $1
        and box_id = $2
    `,
    [orgId, sourceBoxId, normalizedDestinationBoxId, normalizedDestinationWarehouse]
  );

  await client.query(
    `
      update app.audit_log
      set box_id = $3
      where org_id = $1
        and box_id = $2
    `,
    [orgId, sourceBoxId, normalizedDestinationBoxId]
  );

  await client.query(
    `
      update app.roll_weight_log
      set box_id = $3
      where org_id = $1
        and box_id = $2
    `,
    [orgId, sourceBoxId, normalizedDestinationBoxId]
  );

  await client.query(
    `
      update app.film_order_box_links
      set box_id = $3
      where org_id = $1
        and box_id = $2
    `,
    [orgId, sourceBoxId, normalizedDestinationBoxId]
  );

  await client.query(
    `
      update app.film_orders
      set source_box_id = $3
      where org_id = $1
        and source_box_id = $2
    `,
    [orgId, sourceBoxId, normalizedDestinationBoxId]
  );

  await client.query(
    `
      update app.film_catalog
      set
        source_box_id = $3,
        updated_at = $4::timestamptz
      where org_id = $1
        and source_box_id = $2
    `,
    [orgId, sourceBoxId, normalizedDestinationBoxId, nowIso]
  );

  await client.query(
    `
      update app.box_id_aliases
      set
        updated_at = $3::timestamptz,
        updated_by = $4
      where org_id = $1
        and canonical_box_id = $2
    `,
    [orgId, normalizedDestinationBoxId, nowIso, normalizedActor]
  );

  await client.query(
    `
      insert into app.box_id_aliases (
        org_id,
        old_box_id,
        canonical_box_id,
        expires_at,
        created_by,
        updated_by,
        updated_at
      )
      values (
        $1,
        $2,
        $3,
        now() + interval '365 days',
        $4,
        $4,
        $5::timestamptz
      )
      on conflict (org_id, old_box_id) do update set
        canonical_box_id = excluded.canonical_box_id,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
    `,
    [orgId, sourceBoxId, normalizedDestinationBoxId, normalizedActor, nowIso]
  );

  return findBoxById(client, orgId, normalizedDestinationBoxId);
}

function buildFilmTransferAlertMessage(alerts, context) {
  if (!Array.isArray(alerts) || alerts.length === 0) {
    return '';
  }

  const actionLabel = context === 'staging' ? 'staging this job' : 'checking out this job';
  return `Receive transferred film before ${actionLabel}.`;
}

function buildJobFilmTransferAlerts(jobWarehouse, allocations, boxById, pendingTransferByBoxRecordId = {}) {
  const normalizedJobWarehouse = asTrimmedString(jobWarehouse).toUpperCase();
  if (!normalizedJobWarehouse) {
    return [];
  }

  const entries = Array.isArray(allocations) ? allocations : [];
  const alerts = [];
  const seen = new Set();

  for (let index = 0; index < entries.length; index += 1) {
    const allocation = entries[index];
    if (!allocation || allocation.status !== 'ACTIVE' || !allocation.boxId) {
      continue;
    }

    const box = boxById[allocation.boxId] || null;
    if (!box) {
      continue;
    }

    const sourceWarehouse = asTrimmedString(box.warehouse).toUpperCase();
    if (!sourceWarehouse || sourceWarehouse === normalizedJobWarehouse) {
      continue;
    }

    const pendingTransfer = box.id ? pendingTransferByBoxRecordId[box.id] || null : null;
    const state =
      pendingTransfer && pendingTransfer.destinationWarehouse === normalizedJobWarehouse
        ? 'TRANSFER_PENDING'
        : 'NEEDS_TRANSFER';
    const dedupeKey = `${box.boxId}:${normalizedJobWarehouse}:${state}`;
    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    alerts.push({
      boxId: box.boxId,
      sourceWarehouse,
      destinationWarehouse: normalizedJobWarehouse,
      state,
      transferId: pendingTransfer ? pendingTransfer.transferId : '',
      startedAt: pendingTransfer ? pendingTransfer.createdAt : '',
      startedBy: pendingTransfer ? pendingTransfer.createdBy : ''
    });
  }

  return alerts;
}

function toUsageTimestampSortValue(entry) {
  return asTrimmedString(entry.checkedInAt) || asTrimmedString(entry.checkedOutAt) || '';
}

function buildPublicJobUsageEntries(rollHistoryEntries, boxById) {
  const grouped = {};
  const normalizedEntries = Array.isArray(rollHistoryEntries) ? rollHistoryEntries : [];

  for (let index = 0; index < normalizedEntries.length; index += 1) {
    const entry = normalizedEntries[index];
    if (!entry || !entry.boxId) {
      continue;
    }

    const usedFeet = Math.max(integerOrZero(entry.feetBefore) - integerOrZero(entry.feetAfter), 0);
    const timestampSortValue = toUsageTimestampSortValue(entry);
    const box = boxById[entry.boxId] || null;
    const rollEntryNormalized = normalizeCanonicalManufacturerAndFilm(entry.manufacturer, entry.filmName);

    if (!grouped[entry.boxId]) {
      grouped[entry.boxId] = {
        boxId: entry.boxId,
        manufacturer: box ? box.manufacturer : rollEntryNormalized.manufacturer,
        filmName: box ? box.filmName : rollEntryNormalized.filmName,
        widthIn: box ? box.widthIn : numericOrNull(entry.widthIn) ?? 0,
        usedFeet: 0,
        usageEventCount: 0,
        latestCheckedInAt: '',
        latestCheckedOutAt: '',
        lastActivityAt: ''
      };
    }

    grouped[entry.boxId].usedFeet += usedFeet;
    grouped[entry.boxId].usageEventCount += 1;

    if (asTrimmedString(entry.checkedInAt) > grouped[entry.boxId].latestCheckedInAt) {
      grouped[entry.boxId].latestCheckedInAt = asTrimmedString(entry.checkedInAt);
    }

    if (asTrimmedString(entry.checkedOutAt) > grouped[entry.boxId].latestCheckedOutAt) {
      grouped[entry.boxId].latestCheckedOutAt = asTrimmedString(entry.checkedOutAt);
    }

    if (timestampSortValue > grouped[entry.boxId].lastActivityAt) {
      grouped[entry.boxId].lastActivityAt = timestampSortValue;
    }
  }

  const response = Object.values(grouped);
  response.sort((left, right) => {
    if (left.lastActivityAt !== right.lastActivityAt) {
      return left.lastActivityAt > right.lastActivityAt ? -1 : 1;
    }

    return left.boxId < right.boxId ? -1 : left.boxId > right.boxId ? 1 : 0;
  });

  return response;
}

function buildPublicJobUsageTimelineEntries(rollHistoryEntries, boxById, caulkCheckouts) {
  const response = [];
  const normalizedRollHistory = Array.isArray(rollHistoryEntries) ? rollHistoryEntries : [];
  const normalizedCaulkCheckouts = Array.isArray(caulkCheckouts) ? caulkCheckouts : [];

  for (let index = 0; index < normalizedRollHistory.length; index += 1) {
    const entry = normalizedRollHistory[index];
    if (!entry || !entry.boxId) {
      continue;
    }

    const usedFeet = Math.max(integerOrZero(entry.feetBefore) - integerOrZero(entry.feetAfter), 0);
    const occurredAt = asTrimmedString(entry.checkedInAt) || asTrimmedString(entry.checkedOutAt);
    if (!occurredAt) {
      continue;
    }

    const box = boxById[entry.boxId] || null;
    response.push({
      usageType: 'FILM',
      occurredAt,
      actor: asTrimmedString(entry.checkedInBy) || asTrimmedString(entry.checkedOutBy),
      warehouse: box ? asTrimmedString(box.warehouse) : asTrimmedString(entry.warehouse),
      referenceId: asTrimmedString(entry.boxId),
      manufacturer: box ? asTrimmedString(box.manufacturer) : asTrimmedString(entry.manufacturer),
      itemName: box ? asTrimmedString(box.filmName) : asTrimmedString(entry.filmName),
      itemCode: '',
      unit: 'LF',
      checkedOutQuantity: integerOrZero(entry.feetBefore),
      returnedQuantity: integerOrZero(entry.feetAfter),
      usedQuantity: usedFeet,
      notes: asTrimmedString(entry.notes)
    });
  }

  for (let index = 0; index < normalizedCaulkCheckouts.length; index += 1) {
    const entry = normalizedCaulkCheckouts[index];
    if (!entry || asTrimmedString(entry.status).toUpperCase() !== 'CLOSED') {
      continue;
    }

    const occurredAt = asTrimmedString(entry.checkedInAt) || asTrimmedString(entry.checkedOutAt);
    if (!occurredAt) {
      continue;
    }

    response.push({
      usageType: 'CAULK',
      occurredAt,
      actor: asTrimmedString(entry.checkedInBy) || asTrimmedString(entry.checkedOutBy),
      warehouse: asTrimmedString(entry.warehouse),
      referenceId: asTrimmedString(entry.caulkCheckoutId),
      manufacturer: asTrimmedString(entry.manufacturer),
      itemName: asTrimmedString(entry.productName),
      itemCode: asTrimmedString(entry.productCode),
      unit: 'TUBES',
      checkedOutQuantity: integerOrZero(entry.checkoutTubes),
      returnedQuantity: integerOrZero(entry.unusedTubes),
      usedQuantity: integerOrZero(entry.usedTubes),
      notes: asTrimmedString(entry.notes)
    });
  }

  response.sort((left, right) => {
    if (left.occurredAt !== right.occurredAt) {
      return left.occurredAt > right.occurredAt ? -1 : 1;
    }

    return compareCatalogStrings(left.referenceId, right.referenceId);
  });

  return response;
}

async function appendRollHistoryEntry(client, orgId, entry) {
  const normalized = normalizeCanonicalManufacturerAndFilm(entry.manufacturer, entry.filmName);
  const manufacturer = normalized.manufacturer;
  const filmName = normalized.filmName;
  await client.query(
    `
      insert into app.roll_weight_log (
        org_id,
        log_id,
        box_id,
        warehouse,
        manufacturer,
        film_name,
        width_in,
        job_number,
        checked_out_at,
        checked_out_by,
        checked_out_weight_lbs,
        checked_in_at,
        checked_in_by,
        checked_in_weight_lbs,
        weight_delta_lbs,
        feet_before,
        feet_after,
        notes,
        created_at
      )
      values (
        $1,$2,$3,$4,$5,$6,$7,$8,
        nullif($9, '')::timestamptz,
        $10,$11,
        nullif($12, '')::timestamptz,
        $13,$14,$15,$16,$17,$18,now()
      )
    `,
    [
      orgId,
      entry.logId || createLogId(),
      entry.boxId,
      entry.warehouse,
      manufacturer,
      filmName,
      entry.widthIn,
      entry.jobNumber,
      entry.checkedOutAt,
      entry.checkedOutBy,
      entry.checkedOutWeightLbs,
      entry.checkedInAt,
      entry.checkedInBy,
      entry.checkedInWeightLbs,
      entry.weightDeltaLbs,
      entry.feetBefore,
      entry.feetAfter,
      entry.notes
    ]
  );
}

export {
  listActiveAllocationTransferTargetsForBox,
  getTransferStartGuardForBox,
  findBoxIdConflict,
  boxIdOrAliasExists,
  releaseReusableBoxIdAlias,
  applyReceivedBoxTransfer,
  buildFilmTransferAlertMessage,
  buildJobFilmTransferAlerts,
  toUsageTimestampSortValue,
  buildPublicJobUsageEntries,
  buildPublicJobUsageTimelineEntries,
  appendRollHistoryEntry,
};

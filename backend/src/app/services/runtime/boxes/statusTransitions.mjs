import {
  HttpError,
  ok,
  asTrimmedString,
  assertBoxStatus,
  requireUuid,
  integerOrZero,
  normalizeJobNumberKey,
  cloneValue,
  roundToDecimals,
  todayDateString,
  deriveLifecycleStatus,
  stampZeroedMetadata,
  assertCanCheckoutBoxFromWarehouse,
  assertLegalBoxWeightState,
  requiresFirstReturnCalibration,
  applyCheckoutWarnings,
  applyCheckInWarnings,
  toPublicBox,
  findBoxById,
  findJobById,
  listJobs,
  saveBoxRecord,
  listAllocationsByBox,
  reconcileBoxCheckinAllocations,
  appendAuditEntry,
  appendRollHistoryEntry,
} from '../../runtimeDeps.mjs';
import {
  listCheckoutCrewConflictJobsForBox,
  autoLinkRemainingJobFeetToCheckedOutBox,
} from '../runtimeAllocationLinks.mjs';
import { resolveAllocationsForCheckout } from '../checkout/checkoutFlow.mjs';
import {
  findLatestCheckoutAuditEntryByBoxId,
  getCheckoutJobNumberFromAuditNotes,
} from '../checkout/audit.mjs';
import { planBoxCheckIn } from '../runtimeBoxCheckin.mjs';
import { recalculateFilmOrdersForBoxLinks } from '../runtimeAllocationCleanup.mjs';
import { processLinkedFilmOrderReceipt } from '../runtimeAllocationPlanning.mjs';
import { applyReservationMetricsToBox } from '../runtimeAllocationReservations.mjs';
import {
  assertDirectToJobSiteFlagIsServerOwned,
  assertNoShipDirectToJobSiteFlag,
  buildDirectToJobSiteFirstReturnNote,
} from './directToJobSite.mjs';

async function assertLegacyCheckoutJobNumberIsUnambiguous(client, orgId, jobNumber) {
  const normalizedJobNumber = normalizeJobNumberKey(jobNumber);
  if (!normalizedJobNumber) {
    return;
  }

  const matches = (await listJobs(client, orgId)).filter(
    (entry) => normalizeJobNumberKey(entry?.jobNumber) === normalizedJobNumber
  );

  if (matches.length > 1) {
    throw new HttpError(
      409,
      `Job number ${jobNumber} matches multiple jobs. Choose a Work Scope to continue.`
    );
  }
}

async function setBoxStatus(client, orgId, payload, actor) {
  assertDirectToJobSiteFlagIsServerOwned(payload, 'Set Box Status');
  assertNoShipDirectToJobSiteFlag(payload, 'Set Box Status');
  const warnings = [];
  const status = assertBoxStatus(payload.status);

  if (status === 'ORDERED') {
    throw new HttpError(400, 'ORDERED is derived from ReceivedDate and cannot be set manually.');
  }

  if (status === 'RETIRED') {
    throw new HttpError(400, 'RETIRED status is no longer supported.');
  }

  if (status === 'ZEROED') {
    throw new HttpError(400, 'ZEROED status is assigned automatically when a received box reaches 0.');
  }

  const existing = await findBoxById(client, orgId, payload.boxId);
  if (!existing) {
    throw new HttpError(404, 'Box not found.');
  }
  const allowsFirstReturnCalibration = requiresFirstReturnCalibration(existing) && status === 'IN_STOCK';

  if (existing.status === 'TRANSFER') {
    throw new HttpError(
      400,
      `Box ${existing.boxId} has a pending transfer and can only be received or have the transfer cancelled.`
    );
  }

  if (deriveLifecycleStatus(existing.receivedDate) === 'ORDERED' && !allowsFirstReturnCalibration) {
    throw new HttpError(400, 'Add a ReceivedDate on or before today before changing status.');
  }

  if (existing.status === 'ZEROED') {
    throw new HttpError(400, 'Zeroed boxes cannot change status directly. Use audit undo instead.');
  }

  if (existing.status === 'RETIRED') {
    throw new HttpError(400, 'Retired boxes cannot change status directly. Use audit undo instead.');
  }

  let updatedBox = cloneValue(existing);
  let auditAction = 'SET_STATUS';
  let finalAuditNote = asTrimmedString(payload.auditNote);
  let responseJobId = '';
  let responseJobNumber = '';

  if (status === 'CHECKED_OUT') {
    assertCanCheckoutBoxFromWarehouse(existing);
    const suppliedJobId = asTrimmedString(payload.jobId);
    let selectedJob = null;
    let selectedJobId = '';
    let jobNumber = getCheckoutJobNumberFromAuditNotes(payload.auditNote);

    if (suppliedJobId) {
      selectedJobId = requireUuid(suppliedJobId, 'jobId');
      selectedJob = await findJobById(client, orgId, selectedJobId);
      if (!selectedJob) {
        throw new HttpError(404, `Job ${selectedJobId} was not found.`);
      }

      const selectedJobNumber = asTrimmedString(selectedJob.jobNumber);
      if (jobNumber && normalizeJobNumberKey(jobNumber) !== normalizeJobNumberKey(selectedJobNumber)) {
        throw new HttpError(400, 'jobId does not match jobNumber.');
      }
      jobNumber = selectedJobNumber;
    }

    if (!jobNumber) {
      throw new HttpError(400, 'A checkout job number is required.');
    }

    if (!selectedJobId) {
      await assertLegacyCheckoutJobNumberIsUnambiguous(client, orgId, jobNumber);
    }

    const crewConflictJobs = await listCheckoutCrewConflictJobsForBox(
      client,
      orgId,
      existing.boxId,
      jobNumber,
      {
        jobId: selectedJobId,
        selectedJob
      }
    );
    if (crewConflictJobs.length > 0) {
      throw new HttpError(
        400,
        `Box ${existing.boxId} is already allocated to ${crewConflictJobs.join(', ')} on the same install date for a different crew leader. Clear that same-day crew conflict before checkout.`
      );
    }

    updatedBox.status = 'CHECKED_OUT';
    updatedBox.hasEverBeenCheckedOut = true;
    updatedBox.lastCheckoutJobId = selectedJob ? selectedJobId : '';
    updatedBox.lastCheckoutJob = jobNumber;
    responseJobId = selectedJobId;
    responseJobNumber = selectedJob ? jobNumber : '';
    updatedBox.lastCheckoutDate = todayDateString();
    updatedBox.zeroedDate = '';
    updatedBox.zeroedReason = '';
    updatedBox.zeroedBy = '';
    assertLegalBoxWeightState(updatedBox);
    applyCheckoutWarnings(warnings, existing);

    const autoLinkResult = await autoLinkRemainingJobFeetToCheckedOutBox(
      client,
      orgId,
      updatedBox,
      jobNumber,
      actor,
      'checkout',
      {
        jobId: selectedJobId,
        selectedJob
      }
    );
    if (autoLinkResult.created) {
      warnings.push(
        `Auto-linked ${autoLinkResult.allocatedFeet} LF from ${updatedBox.boxId} to job ${jobNumber} at checkout.`
      );
    } else if (autoLinkResult.skippedReason === 'NO_REQUIREMENTS') {
      warnings.push(`No job requirements were found for job ${jobNumber}, so no LF was auto-linked.`);
    }

    const allocationResolution = await resolveAllocationsForCheckout(
      client,
      orgId,
      updatedBox.boxId,
      jobNumber,
      actor,
      selectedJobId
    );
    if (allocationResolution.fulfilledCount > 0) {
      warnings.push(
        `Kept ${allocationResolution.fulfilledCount} allocation${allocationResolution.fulfilledCount === 1 ? '' : 's'} totaling ${allocationResolution.fulfilledFeet} LF linked to job ${jobNumber} after checkout.`
      );
    }

    if (allocationResolution.otherJobs.length > 0) {
      warnings.push(`This box still has active allocations for ${allocationResolution.otherJobs.join(', ')}.`);
    }

    updatedBox = await saveBoxRecord(client, orgId, updatedBox);
  } else {
    const checkoutAudit = await findLatestCheckoutAuditEntryByBoxId(client, orgId, updatedBox.boxId);
    let checkoutJobId = asTrimmedString(existing.lastCheckoutJobId);
    let checkoutJob = asTrimmedString(existing.lastCheckoutJob);
    let checkoutDate = asTrimmedString(existing.lastCheckoutDate);
    let checkoutUser = '';

    if (checkoutJobId) {
      const checkoutJobRecord = await findJobById(client, orgId, checkoutJobId);
      if (checkoutJobRecord) {
        checkoutJob = asTrimmedString(checkoutJobRecord.jobNumber);
        checkoutJobId = asTrimmedString(checkoutJobRecord.id || checkoutJobId);
      } else {
        checkoutJobId = '';
      }
    }

    if (checkoutAudit) {
      if (!checkoutJob) {
        checkoutJob = getCheckoutJobNumberFromAuditNotes(checkoutAudit.notes);
      }

      if (!checkoutDate) {
        checkoutDate = asTrimmedString(checkoutAudit.date);
      }

      checkoutUser = asTrimmedString(checkoutAudit.user);
    }

    if (!checkoutJob) {
      checkoutJob = 'UNKNOWN';
      warnings.push('Roll history was logged with UNKNOWN job number because no checkout job was saved.');
    }
    responseJobId = checkoutJobId;
    responseJobNumber = checkoutJobId ? checkoutJob : '';

    if (!checkoutDate) {
      checkoutDate = todayDateString();
    }

    const existingAllocations = await listAllocationsByBox(client, orgId, updatedBox.boxId);
    const checkInPlan = planBoxCheckIn(existing, payload, existingAllocations, checkoutJob, {
      jobId: checkoutJobId
    });
    const directToSiteFirstReturnNote = allowsFirstReturnCalibration
      ? buildDirectToJobSiteFirstReturnNote({
          jobNumber: checkoutJob,
          lastRollWeightLbs: checkInPlan.lastRollWeightLbs,
          currentFeetOnRoll: checkInPlan.currentFeetOnRoll ?? checkInPlan.physicalFeetAfterCheckIn,
          userNote: payload.auditNote
        })
      : asTrimmedString(payload.auditNote);
    finalAuditNote = directToSiteFirstReturnNote;

    const reconciliationResult = await reconcileBoxCheckinAllocations(
      client,
      orgId,
      {
        boxId: updatedBox.boxId,
        physicalFeetAfter: checkInPlan.physicalFeetAfterCheckIn
      },
      actor
    );
    if (Array.isArray(reconciliationResult.warnings) && reconciliationResult.warnings.length > 0) {
      warnings.push(...reconciliationResult.warnings);
    }

    if (checkInPlan.otherJobs.length > 0) {
      warnings.push(`This box still has active allocations for ${checkInPlan.otherJobs.join(', ')}.`);
    }
    if (checkInPlan.autoPlannedReservationOverageFeet > 0) {
      warnings.push(
        `${checkInPlan.autoPlannedReservationOverageFeet} LF of AUTO_PLANNED reservations no longer fit this box and were reconciled by reservation order.`
      );
    }
    if (checkInPlan.manualReservationOverageFeet > 0) {
      warnings.push(
        `${checkInPlan.manualReservationOverageFeet} LF of manual reservations no longer fit this box and were reconciled by reservation order.`
      );
    }

    updatedBox.status = 'IN_STOCK';
    if (allowsFirstReturnCalibration) {
      updatedBox.receivedDate = todayDateString();
    }
    updatedBox.lastRollWeightLbs = checkInPlan.lastRollWeightLbs;
    updatedBox.lastWeighedDate = todayDateString();
    updatedBox.coreType = checkInPlan.coreType || updatedBox.coreType;
    updatedBox.coreWeightLbs = checkInPlan.coreWeightLbs;
    updatedBox.lfWeightLbsPerFt = checkInPlan.lfWeightLbsPerFt;
    updatedBox.feetAvailable = Math.max(
      0,
      Number(reconciliationResult.feetAvailable ?? checkInPlan.feetAvailableAfterCheckIn) || 0
    );

    const warningBeforeBox = { ...existing, feetAvailable: checkInPlan.physicalFeetBeforeCheckIn };
    const warningAfterBox = { ...updatedBox, feetAvailable: checkInPlan.physicalFeetAfterCheckIn };
    applyCheckInWarnings(warnings, warningBeforeBox, warningAfterBox, checkInPlan.autoMoveToZeroed);
    if (checkInPlan.otherActiveAllocatedFeet > 0 && updatedBox.feetAvailable === 0) {
      warnings.push('All remaining LF on this box is reserved by active allocations.');
    }

    const checkedOutWeight = existing.lastRollWeightLbs;
    const weightDelta =
      checkedOutWeight === null ? null : roundToDecimals(checkedOutWeight - checkInPlan.lastRollWeightLbs, 2);

    if (checkedOutWeight === null) {
      warnings.push(
        'Roll history was logged without an outbound weight because no Last Roll Weight was saved at checkout.'
      );
    }

    await appendRollHistoryEntry(client, orgId, {
      logId: '',
      boxId: updatedBox.boxId,
      warehouse: updatedBox.warehouse,
      manufacturer: updatedBox.manufacturer,
      filmName: updatedBox.filmName,
      widthIn: updatedBox.widthIn,
      jobId: checkoutJobId,
      jobNumber: checkoutJob,
      checkedOutAt: checkoutDate,
      checkedOutBy: checkoutUser,
      checkedOutWeightLbs: checkedOutWeight,
      checkedInAt: new Date().toISOString(),
      checkedInBy: actor,
      checkedInWeightLbs: checkInPlan.lastRollWeightLbs,
      weightDeltaLbs: weightDelta,
      feetBefore: checkInPlan.physicalFeetBeforeCheckIn,
      feetAfter: checkInPlan.physicalFeetAfterCheckIn,
      notes: directToSiteFirstReturnNote
    });

    updatedBox.lastCheckoutJob = '';
    updatedBox.lastCheckoutJobId = '';
    updatedBox.lastCheckoutDate = '';

    const reachedZeroState =
      Boolean(updatedBox.receivedDate) &&
      (checkInPlan.physicalFeetAfterCheckIn === 0 || updatedBox.lastRollWeightLbs === 0);
    const autoMoveToZeroed = checkInPlan.autoMoveToZeroed;

    if (autoMoveToZeroed) {
      stampZeroedMetadata(updatedBox, actor, payload.auditNote);
      updatedBox = await saveBoxRecord(client, orgId, updatedBox);
      auditAction = 'ZERO_OUT_BOX';
      warnings.push(
        'Box was automatically moved to zeroed out inventory because Available Feet or Last Roll Weight reached 0.'
      );
    } else {
      if (reachedZeroState && existing.feetAvailable <= 0) {
        warnings.push('Box stayed in active inventory because it has not had Available Feet above 0 yet.');
      }

      if (updatedBox.status === 'IN_STOCK') {
        updatedBox = await processLinkedFilmOrderReceipt(client, orgId, updatedBox, actor, warnings);
      }
      updatedBox = await saveBoxRecord(client, orgId, updatedBox);
    }

    if (updatedBox.status !== 'CHECKED_OUT') {
      await recalculateFilmOrdersForBoxLinks(client, orgId, updatedBox.boxId, actor);
    }

  }

  const publicBefore = toPublicBox(
    applyReservationMetricsToBox(existing, await listAllocationsByBox(client, orgId, existing.boxId))
  );
  const publicAfter = toPublicBox(
    applyReservationMetricsToBox(updatedBox, await listAllocationsByBox(client, orgId, updatedBox.boxId))
  );
  const logId = await appendAuditEntry(
    client,
    orgId,
    auditAction,
    updatedBox.boxId,
    publicBefore,
    publicAfter,
    actor,
    finalAuditNote
  );

  return ok(
    {
      box: publicAfter,
      logId,
      ...(responseJobId ? { jobId: responseJobId } : {}),
      ...(responseJobNumber ? { jobNumber: responseJobNumber } : {})
    },
    warnings
  );
}

export { setBoxStatus };

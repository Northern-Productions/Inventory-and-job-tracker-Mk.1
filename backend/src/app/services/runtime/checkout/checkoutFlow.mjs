import {
  buildFilmCheckoutActionPlan,
  getPendingTransferCheckoutDenial,
  isPendingTransferCheckoutConflict,
} from '../../../../../../shared/checkoutSemantics.mjs';
import {
  HttpError,
  queryRow,
  asTrimmedString,
  normalizeJobNumberDigits,
  normalizeJobNumberKey,
  integerOrZero,
  cloneValue,
  todayDateString,
  normalizeJobLifecycleStatus,
  boxUsesOrderedPlanning,
  assertCanCheckoutBoxFromWarehouse,
  assertLegalBoxWeightState,
  findBoxById,
  saveBoxRecord,
  listAllocationsByBox,
  listAllocationsByJobId,
  listFilmOrdersByJobId,
  listJobPhasesByJobId,
  listJobRequirementsByJobId,
  listJobCaulkRequirementsByJobId,
  listCaulkJobAllocationsByJobId,
  saveAllocationRecord,
  findJobByNumber,
  findJobById,
  applyCheckoutWarnings,
  requireUuid,
} from '../../runtimeDeps.mjs';
import { autoLinkRemainingJobFeetToCheckedOutBox } from '../runtimeAllocationLinks.mjs';
import {
  loadJobStagingValidationState,
  resolveExistingOrLegacyJobHeader,
} from './stagingValidation.mjs';

async function resolveAllocationsForCheckout(client, orgId, boxId, jobNumber, user, jobId = '') {
  const active = (await listAllocationsByBox(client, orgId, boxId)).filter((entry) => entry.status === 'ACTIVE');
  const normalizedJobNumber = normalizeJobNumberKey(jobNumber);
  const normalizedJobId = asTrimmedString(jobId).toLowerCase();
  const resolvedAt = new Date().toISOString();
  const resolvedBy = asTrimmedString(user);
  const checkoutMarkerNote = `Checked out for job ${jobNumber}.`;
  const result = {
    fulfilledCount: 0,
    fulfilledFeet: 0,
    otherJobs: []
  };
  const otherJobs = {};

  for (let index = 0; index < active.length; index += 1) {
    const entry = cloneValue(active[index]);
    const isSelectedJob = normalizedJobId
      ? asTrimmedString(entry.jobId).toLowerCase() === normalizedJobId
      : normalizeJobNumberKey(entry.jobNumber) === normalizedJobNumber;
    if (isSelectedJob) {
      let shouldSave = false;

      if (!entry.resolvedAt) {
        entry.resolvedAt = resolvedAt;
        shouldSave = true;
      }

      if (!entry.resolvedBy && resolvedBy) {
        entry.resolvedBy = resolvedBy;
        shouldSave = true;
      }

      if (entry.notes !== checkoutMarkerNote) {
        entry.notes = checkoutMarkerNote;
        shouldSave = true;
      }

      if (shouldSave) {
        await saveAllocationRecord(client, orgId, entry);
      }

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

function shouldRecalculateReceivedFeetFromState(
  existingBox,
  initialFeet,
  resolvedLastRollWeightLbs,
  resolvedCoreWeightLbs,
  resolvedLfWeightLbsPerFt,
  reactivateFromZeroed
) {
  if (!existingBox || !existingBox.receivedDate) {
    return true;
  }

  return (
    existingBox.initialFeet !== initialFeet ||
    existingBox.lastRollWeightLbs !== resolvedLastRollWeightLbs ||
    existingBox.coreWeightLbs !== resolvedCoreWeightLbs ||
    existingBox.lfWeightLbsPerFt !== resolvedLfWeightLbsPerFt ||
    reactivateFromZeroed
  );
}

function hasPositiveReactivationSignal(box) {
  return (
    integerOrZero(box?.feetAvailable) > 0 ||
    (box && box.lastRollWeightLbs !== null && Number(box.lastRollWeightLbs) > 0)
  );
}

async function checkoutBoxForJob(client, orgId, boxId, jobNumber, user, options = {}) {
  const normalizedJobNumber = normalizeJobNumberDigits(jobNumber, 'JobNumber');
  const normalizedJobKey = normalizeJobNumberKey(normalizedJobNumber);
  const selectedJobId = asTrimmedString(options.jobId);
  const box = await findBoxById(client, orgId, boxId);
  if (!box) {
    throw new HttpError(404, `Box ${boxId} was not found.`);
  }

  const warnings = [];
  const jobHeader = options.selectedJob ||
    (selectedJobId ? await findJobById(client, orgId, selectedJobId) : await findJobByNumber(client, orgId, normalizedJobNumber));
  const jobWarehouse = asTrimmedString(jobHeader?.warehouse).toUpperCase();
  if (box.status === 'TRANSFER') {
    throw new HttpError(
      400,
      `Box ${box.boxId} is pending transfer and must be received before it can be checked out.`
    );
  }

  if (jobWarehouse && asTrimmedString(box.warehouse).toUpperCase() !== jobWarehouse) {
    throw new HttpError(
      400,
      `Box ${box.boxId} must be transferred from ${box.warehouse} to ${jobWarehouse} before checkout.`
    );
  }

  const isCheckedOutOnThisJob =
    box.status === 'CHECKED_OUT' &&
    (
      (selectedJobId && asTrimmedString(box.lastCheckoutJobId).toLowerCase() === selectedJobId.toLowerCase()) ||
      (!asTrimmedString(box.lastCheckoutJobId) && normalizeJobNumberKey(box.lastCheckoutJob) === normalizedJobKey) ||
      (!selectedJobId && normalizeJobNumberKey(box.lastCheckoutJob) === normalizedJobKey)
    );

  if (box.status !== 'IN_STOCK' && !isCheckedOutOnThisJob) {
    throw new HttpError(
      400,
      `Box ${box.boxId} is ${box.status || 'not in stock'} and cannot be checked out from this view.`
    );
  }

  const workingBox = cloneValue(box);
  if (box.status === 'IN_STOCK') {
    assertCanCheckoutBoxFromWarehouse(workingBox);
    workingBox.status = 'CHECKED_OUT';
    workingBox.hasEverBeenCheckedOut = true;
    workingBox.lastCheckoutJobId = selectedJobId;
    workingBox.lastCheckoutJob = normalizedJobNumber;
    workingBox.lastCheckoutDate = todayDateString();
    workingBox.zeroedDate = '';
    workingBox.zeroedReason = '';
    workingBox.zeroedBy = '';
    assertLegalBoxWeightState(workingBox);
    applyCheckoutWarnings(warnings, workingBox);

    const autoLinkResult = await autoLinkRemainingJobFeetToCheckedOutBox(
      client,
      orgId,
      workingBox,
      normalizedJobNumber,
      user,
      'checkout',
      {
        jobId: selectedJobId,
        selectedJob: jobHeader
      }
    );
    if (autoLinkResult.created) {
      warnings.push(
        `Auto-linked ${autoLinkResult.allocatedFeet} LF from ${workingBox.boxId} to job ${normalizedJobNumber} at checkout.`
      );
    } else if (autoLinkResult.skippedReason === 'NO_REQUIREMENTS') {
      warnings.push(`No job requirements were found for job ${normalizedJobNumber}, so no LF was auto-linked.`);
    }

    const allocationResolution = await resolveAllocationsForCheckout(
      client,
      orgId,
      workingBox.boxId,
      normalizedJobNumber,
      user,
      selectedJobId
    );
    if (allocationResolution.fulfilledCount > 0) {
      warnings.push(
        `Kept ${allocationResolution.fulfilledCount} allocation${allocationResolution.fulfilledCount === 1 ? '' : 's'} totaling ${allocationResolution.fulfilledFeet} LF linked to job ${normalizedJobNumber} after checkout.`
      );
    }

    if (allocationResolution.otherJobs.length > 0) {
      warnings.push(`This box still has active allocations for ${allocationResolution.otherJobs.join(', ')}.`);
    }

    const savedBox = await saveBoxRecord(client, orgId, workingBox);
    return {
      box: savedBox,
      warnings,
      checkedOut: true,
      successfullyHandled: true
    };
  }

  const allocationResolution = await resolveAllocationsForCheckout(
    client,
    orgId,
    workingBox.boxId,
    normalizedJobNumber,
    user,
    selectedJobId
  );
  if (allocationResolution.fulfilledCount > 0) {
    warnings.push(
      `Kept ${allocationResolution.fulfilledCount} allocation${allocationResolution.fulfilledCount === 1 ? '' : 's'} totaling ${allocationResolution.fulfilledFeet} LF linked to job ${normalizedJobNumber} after checkout.`
    );
  }

  if (allocationResolution.otherJobs.length > 0) {
    warnings.push(`This box still has active allocations for ${allocationResolution.otherJobs.join(', ')}.`);
  }

  return {
    box: workingBox,
    warnings,
    checkedOut: false,
    successfullyHandled: allocationResolution.fulfilledCount > 0
  };
}

async function checkoutCaulkAllocationForJob(client, orgId, jobNumber, caulkAllocation, user) {
  const allocation = cloneValue(caulkAllocation);
  const remaining = Math.max(0, integerOrZero(allocation.reservedTubesRemaining));
  const openCount = Math.max(0, integerOrZero(allocation.openCheckoutCount));

  if (allocation.status !== 'ACTIVE') {
    return {
      checkoutCreated: false,
      warnings: []
    };
  }

  if (remaining <= 0) {
    return {
      checkoutCreated: false,
      warnings: []
    };
  }

  if (openCount > 0) {
    throw new HttpError(
      400,
      `Caulk allocation ${allocation.caulkAllocationId} already has an open checkout and cannot be bulk checked out again until that cycle is closed.`
    );
  }

  const response = await queryRow(
    client,
    `select public.api_acl_allocations_caulk_checkout($1::uuid, $2::text, $3::jsonb) as payload`,
    [
      orgId,
      user,
      JSON.stringify({
        caulkAllocationId: allocation.caulkAllocationId,
        checkoutTubes: remaining,
        notes: `Checked out all remaining caulk for job ${jobNumber}.`
      })
    ]
  );

  const payload = response && typeof response.payload === 'object' ? cloneValue(response.payload) : null;
  const warnings = Array.isArray(payload?.warnings)
    ? payload.warnings.map((entry) => asTrimmedString(entry)).filter(Boolean)
    : [];
  return {
    checkoutCreated: true,
    warnings
  };
}

async function runCheckoutAllItem(client, operation) {
  await client.query('SAVEPOINT checkout_all_item');
  try {
    const result = await operation();
    await client.query('RELEASE SAVEPOINT checkout_all_item');
    return { blockedByPendingTransfer: false, result };
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT checkout_all_item');
    await client.query('RELEASE SAVEPOINT checkout_all_item');
    if (isPendingTransferCheckoutConflict(error)) {
      return { blockedByPendingTransfer: true, result: null };
    }
    throw error;
  }
}

async function resolveCheckoutAllTarget(client, orgId, payloadOrJobNumber, user) {
  const payload = payloadOrJobNumber && typeof payloadOrJobNumber === 'object'
    ? payloadOrJobNumber
    : { jobNumber: payloadOrJobNumber };
  const suppliedJobId = asTrimmedString(payload.jobId);
  const suppliedJobNumber = asTrimmedString(payload.jobNumber)
    ? normalizeJobNumberDigits(payload.jobNumber, 'JobNumber')
    : '';

  if (suppliedJobId) {
    const jobId = requireUuid(suppliedJobId, 'jobId');
    const selectedJob = await findJobById(client, orgId, jobId);
    if (!selectedJob) {
      throw new HttpError(404, `Job ${jobId} was not found.`);
    }
    const selectedJobNumber = normalizeJobNumberDigits(selectedJob.jobNumber, 'JobNumber');
    if (suppliedJobNumber && normalizeJobNumberKey(suppliedJobNumber) !== normalizeJobNumberKey(selectedJobNumber)) {
      throw new HttpError(409, `Job identity mismatch: jobId ${jobId} belongs to job ${selectedJobNumber}, not ${suppliedJobNumber}.`);
    }
    return {
      usedJobId: true,
      jobId,
      jobNumber: selectedJobNumber,
      existingJob: selectedJob,
      resolvedContext: {
        header: selectedJob,
        allocations: null,
        filmOrders: null,
      },
    };
  }

  const normalizedJobNumber = normalizeJobNumberDigits(payload.jobNumber, 'JobNumber');
  const resolvedContext = await resolveExistingOrLegacyJobHeader(
    client,
    orgId,
    normalizedJobNumber,
    user,
    new Date().toISOString()
  );
  return {
    usedJobId: false,
    jobId: '',
    jobNumber: normalizedJobNumber,
    existingJob: resolvedContext.header,
    resolvedContext,
  };
}

async function loadCheckoutAllStagingState(client, orgId, target) {
  if (!target.usedJobId) {
    return loadJobStagingValidationState(
      client,
      orgId,
      target.jobNumber,
      target.existingJob.warehouse,
      {
        jobId: target.existingJob.id,
        allocations: target.resolvedContext.allocations || undefined,
        filmOrders: target.resolvedContext.filmOrders || undefined
      }
    );
  }

  const [
    allocations,
    filmOrders,
    phases,
    requirements,
    caulkRequirements,
    caulkAllocations,
  ] = await Promise.all([
    listAllocationsByJobId(client, orgId, target.jobId),
    listFilmOrdersByJobId(client, orgId, target.jobId),
    listJobPhasesByJobId(client, orgId, target.jobId),
    listJobRequirementsByJobId(client, orgId, target.jobId),
    listJobCaulkRequirementsByJobId(client, orgId, target.jobId),
    listCaulkJobAllocationsByJobId(client, orgId, target.jobId),
  ]);

  return loadJobStagingValidationState(
    client,
    orgId,
    target.jobNumber,
    target.existingJob.warehouse,
    {
      jobId: target.jobId,
      allocations,
      filmOrders,
      phases,
      requirements,
      caulkRequirements,
      caulkAllocations,
    }
  );
}

async function checkoutAllJobMaterials(client, orgId, payloadOrJobNumber, user) {
  const target = await resolveCheckoutAllTarget(client, orgId, payloadOrJobNumber, user);
  const normalizedJobNumber = target.jobNumber;
  const existingJob = target.existingJob;
  if (!existingJob) {
    throw new HttpError(404, `Job ${normalizedJobNumber} was not found.`);
  }

  if (normalizeJobLifecycleStatus(existingJob.lifecycleStatus) !== 'ACTIVE') {
    throw new HttpError(400, `Job ${normalizedJobNumber} is closed and checkout-all cannot be changed.`);
  }

  const preCheckoutState = await loadCheckoutAllStagingState(client, orgId, target);
  const boxById = preCheckoutState.boxById;
  const warnings = [];
  let checkedOutBoxCount = 0;
  let checkedOutCaulkCount = 0;
  let successfullyHandledCount = 0;
  let skippedFilmTransferCount = 0;
  let skippedOrderedFilmCount = 0;
  let skippedUnavailableFilmCount = 0;
  let skippedCaulkTransferCount = 0;
  let skippedOpenCaulkCheckoutCount = 0;
  const filmTransferBoxIds = new Set(
    (preCheckoutState.filmTransferAlerts || []).map((entry) => asTrimmedString(entry.boxId).toUpperCase()).filter(Boolean)
  );
  const caulkTransferAllocationIds = new Set(
    (preCheckoutState.caulkTransferAlerts || [])
      .map((entry) => asTrimmedString(entry.caulkAllocationId))
      .filter(Boolean)
  );

  const checkoutPlan = buildFilmCheckoutActionPlan(
    preCheckoutState.allocations,
    boxById,
    normalizedJobNumber
  );

  for (let index = 0; index < checkoutPlan.length; index += 1) {
    const step = checkoutPlan[index];
    const currentBox = boxById[step.boxId];
    if (boxUsesOrderedPlanning(currentBox)) {
      skippedOrderedFilmCount += 1;
      continue;
    }

    if (filmTransferBoxIds.has(asTrimmedString(step.boxId).toUpperCase())) {
      skippedFilmTransferCount += 1;
      continue;
    }

    if (step.action === 'CHECK_OUT' && (!currentBox || currentBox.status !== 'IN_STOCK')) {
      skippedUnavailableFilmCount += 1;
      continue;
    }

    if (currentBox && currentBox.status === 'IN_STOCK') {
      assertCanCheckoutBoxFromWarehouse(currentBox);
    }

    const checkoutAttempt = await runCheckoutAllItem(client, () =>
      checkoutBoxForJob(
        client,
        orgId,
        step.boxId,
        normalizedJobNumber,
        user,
        {
          jobId: target.jobId,
          selectedJob: target.existingJob
        }
      )
    );
    if (checkoutAttempt.blockedByPendingTransfer) {
      skippedFilmTransferCount += 1;
      continue;
    }
    const checkoutResult = checkoutAttempt.result;
    warnings.push(...checkoutResult.warnings);
    if (checkoutResult.successfullyHandled) {
      successfullyHandledCount += 1;
    }
    if (checkoutResult.checkedOut) {
      checkedOutBoxCount += 1;
    }
  }

  for (let index = 0; index < preCheckoutState.caulkAllocations.length; index += 1) {
    const allocation = preCheckoutState.caulkAllocations[index];
    if (allocation.status !== 'ACTIVE') {
      continue;
    }

    const remaining = Math.max(0, integerOrZero(allocation.reservedTubesRemaining));
    const openCount = Math.max(0, integerOrZero(allocation.openCheckoutCount));
    if (remaining <= 0) {
      continue;
    }

    if (caulkTransferAllocationIds.has(asTrimmedString(allocation.caulkAllocationId))) {
      skippedCaulkTransferCount += 1;
      continue;
    }

    if (openCount > 0) {
      skippedOpenCaulkCheckoutCount += 1;
      continue;
    }

    const checkoutAttempt = await runCheckoutAllItem(client, () =>
      checkoutCaulkAllocationForJob(
        client,
        orgId,
        normalizedJobNumber,
        allocation,
        user
      )
    );
    if (checkoutAttempt.blockedByPendingTransfer) {
      skippedCaulkTransferCount += 1;
      continue;
    }
    const checkoutResult = checkoutAttempt.result;
    warnings.push(...checkoutResult.warnings);
    if (checkoutResult.checkoutCreated) {
      successfullyHandledCount += 1;
      checkedOutCaulkCount += 1;
    }
  }

  const pendingTransferDenial = getPendingTransferCheckoutDenial({
    successfullyHandledCount,
    blockedFilmCount: skippedFilmTransferCount,
    blockedCaulkCount: skippedCaulkTransferCount,
  });
  if (pendingTransferDenial) {
    throw new HttpError(
      pendingTransferDenial.statusCode,
      pendingTransferDenial.message,
      [],
      { code: pendingTransferDenial.code }
    );
  }

  const refreshedState = await loadCheckoutAllStagingState(client, orgId, target);
  const skippedCount =
    skippedFilmTransferCount +
    skippedOrderedFilmCount +
    skippedUnavailableFilmCount +
    skippedCaulkTransferCount +
    skippedOpenCaulkCheckoutCount;
  const checkedOutCount = checkedOutBoxCount + checkedOutCaulkCount;
  if (checkedOutCount > 0) {
    warnings.push(`Checked out ${checkedOutCount} item${checkedOutCount === 1 ? '' : 's'} for job ${normalizedJobNumber}.`);
  }
  if (skippedOrderedFilmCount > 0) {
    warnings.push(`Skipped ${skippedOrderedFilmCount} film box${skippedOrderedFilmCount === 1 ? '' : 'es'} waiting for receipt.`);
  }
  if (skippedFilmTransferCount > 0) {
    warnings.push(`Skipped ${skippedFilmTransferCount} film box${skippedFilmTransferCount === 1 ? '' : 'es'} waiting for transfer.`);
  }
  if (skippedUnavailableFilmCount > 0) {
    warnings.push(`Skipped ${skippedUnavailableFilmCount} unavailable film box${skippedUnavailableFilmCount === 1 ? '' : 'es'}.`);
  }
  if (skippedCaulkTransferCount > 0) {
    warnings.push(`Skipped ${skippedCaulkTransferCount} caulk allocation${skippedCaulkTransferCount === 1 ? '' : 's'} waiting for transfer.`);
  }
  if (skippedOpenCaulkCheckoutCount > 0) {
    warnings.push(`Skipped ${skippedOpenCaulkCheckoutCount} caulk allocation${skippedOpenCaulkCheckoutCount === 1 ? '' : 's'} with an open checkout.`);
  }
  if (checkedOutCount === 0 && skippedCount === 0) {
    warnings.push('No eligible material was available to check out.');
  }
  if (refreshedState.blockingReason) {
    warnings.push(refreshedState.blockingReason);
  }

  return {
    ...(target.jobId ? { jobId: target.jobId } : {}),
    jobNumber: normalizedJobNumber,
    warnings,
    stagingState: refreshedState
  };
}

export {
  resolveAllocationsForCheckout,
  shouldRecalculateReceivedFeetFromState,
  hasPositiveReactivationSignal,
  checkoutBoxForJob,
  checkoutCaulkAllocationForJob,
  checkoutAllJobMaterials,
};

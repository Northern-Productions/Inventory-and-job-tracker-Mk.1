import { buildFilmCheckoutActionPlan } from '../../../../../../shared/checkoutSemantics.mjs';
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
  hasActiveOrderedRequirementAllocations,
  buildOrderedAllocationReceiptMessage,
  boxUsesOrderedPlanning,
  assertCanCheckoutBoxFromWarehouse,
  assertLegalBoxWeightState,
  findBoxById,
  saveBoxRecord,
  listAllocationsByBox,
  saveAllocationRecord,
  findJobByNumber,
  applyCheckoutWarnings,
} from '../../runtimeDeps.mjs';
import { autoLinkRemainingJobFeetToCheckedOutBox } from '../runtimeAllocationLinks.mjs';
import { buildCaulkTransferAlertMessage, buildFilmTransferAlertMessage } from '../runtimeTransferUsage.mjs';
import {
  loadJobStagingValidationState,
  resolveExistingOrLegacyJobHeader,
} from './stagingValidation.mjs';

async function resolveAllocationsForCheckout(client, orgId, boxId, jobNumber, user) {
  const active = (await listAllocationsByBox(client, orgId, boxId)).filter((entry) => entry.status === 'ACTIVE');
  const normalizedJobNumber = normalizeJobNumberKey(jobNumber);
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
    if (normalizeJobNumberKey(entry.jobNumber) === normalizedJobNumber) {
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

async function checkoutBoxForJob(client, orgId, boxId, jobNumber, user) {
  const normalizedJobNumber = normalizeJobNumberDigits(jobNumber, 'JobNumber');
  const normalizedJobKey = normalizeJobNumberKey(normalizedJobNumber);
  const box = await findBoxById(client, orgId, boxId);
  if (!box) {
    throw new HttpError(404, `Box ${boxId} was not found.`);
  }

  const warnings = [];
  const jobHeader = await findJobByNumber(client, orgId, normalizedJobNumber);
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
    box.status === 'CHECKED_OUT' && normalizeJobNumberKey(box.lastCheckoutJob) === normalizedJobKey;

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
      'checkout'
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
      user
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
      checkedOut: true
    };
  }

  const allocationResolution = await resolveAllocationsForCheckout(
    client,
    orgId,
    workingBox.boxId,
    normalizedJobNumber,
    user
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
    checkedOut: false
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

async function checkoutAllJobMaterials(client, orgId, jobNumber, user) {
  const normalizedJobNumber = normalizeJobNumberDigits(jobNumber, 'JobNumber');
  const resolvedContext = await resolveExistingOrLegacyJobHeader(
    client,
    orgId,
    normalizedJobNumber,
    user,
    new Date().toISOString()
  );
  const existingJob = resolvedContext.header;
  if (!existingJob) {
    throw new HttpError(404, `Job ${normalizedJobNumber} was not found.`);
  }

  if (normalizeJobLifecycleStatus(existingJob.lifecycleStatus) !== 'ACTIVE') {
    throw new HttpError(400, `Job ${normalizedJobNumber} is closed and checkout-all cannot be changed.`);
  }

  const preCheckoutState = await loadJobStagingValidationState(
    client,
    orgId,
    normalizedJobNumber,
    existingJob.warehouse,
    {
      allocations: resolvedContext.allocations || undefined,
      filmOrders: resolvedContext.filmOrders || undefined
    }
  );
  const boxById = preCheckoutState.boxById;
  const warnings = [];
  let checkedOutBoxCount = 0;
  let checkedOutCaulkCount = 0;

  if (
    preCheckoutState.filmTransferAlerts.length > 0 &&
    Array.isArray(preCheckoutState.caulkTransferAlerts) &&
    preCheckoutState.caulkTransferAlerts.length > 0
  ) {
    throw new HttpError(400, 'Receive transferred film and caulk before checking out this job.');
  }

  if (preCheckoutState.filmTransferAlerts.length > 0) {
    throw new HttpError(400, buildFilmTransferAlertMessage(preCheckoutState.filmTransferAlerts, 'checkout'));
  }

  if (Array.isArray(preCheckoutState.caulkTransferAlerts) && preCheckoutState.caulkTransferAlerts.length > 0) {
    throw new HttpError(400, buildCaulkTransferAlertMessage(preCheckoutState.caulkTransferAlerts, 'checkout'));
  }

  if (hasActiveOrderedRequirementAllocations(preCheckoutState.allocations, boxById)) {
    throw new HttpError(400, buildOrderedAllocationReceiptMessage('checkout'));
  }

  const checkoutPlan = buildFilmCheckoutActionPlan(
    preCheckoutState.allocations,
    boxById,
    normalizedJobNumber
  );

  for (let index = 0; index < checkoutPlan.length; index += 1) {
    const step = checkoutPlan[index];
    const currentBox = boxById[step.boxId];
    if (boxUsesOrderedPlanning(currentBox)) {
      continue;
    }

    if (currentBox && currentBox.status === 'IN_STOCK') {
      assertCanCheckoutBoxFromWarehouse(currentBox);
    }

    const checkoutResult = await checkoutBoxForJob(
      client,
      orgId,
      step.boxId,
      normalizedJobNumber,
      user
    );
    warnings.push(...checkoutResult.warnings);
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

    if (openCount > 0) {
      throw new HttpError(
        400,
        `Caulk allocation ${allocation.caulkAllocationId} already has an open checkout and cannot be bulk checked out again until that cycle is closed.`
      );
    }

    const checkoutResult = await checkoutCaulkAllocationForJob(
      client,
      orgId,
      normalizedJobNumber,
      allocation,
      user
    );
    warnings.push(...checkoutResult.warnings);
    if (checkoutResult.checkoutCreated) {
      checkedOutCaulkCount += 1;
    }
  }

  const refreshedState = await loadJobStagingValidationState(
    client,
    orgId,
    normalizedJobNumber,
    existingJob.warehouse
  );
  if (refreshedState.blockingReason) {
    throw new HttpError(400, refreshedState.blockingReason);
  }

  if (checkedOutBoxCount > 0 || checkedOutCaulkCount > 0) {
    warnings.push(
      `Checked out ${checkedOutBoxCount} film box${checkedOutBoxCount === 1 ? '' : 'es'} and ${checkedOutCaulkCount} caulk allocation${checkedOutCaulkCount === 1 ? '' : 's'} for job ${normalizedJobNumber}.`
    );
  }

  return {
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

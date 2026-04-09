// Purpose: Keep read-time allocation reconciliation isolated from the transport entrypoint.
import { withReadClient } from '../../db/client.mjs';
import {
  reconcileCheckedOutBoxAllocationLinkByBoxId,
  reconcileCheckedOutBoxAllocationLinksForJob,
  reconcileZeroedBoxAllocationStateByBoxId,
  reconcileZeroedBoxAllocationStateForJob,
} from '../services/allocations.mjs';

export async function runAutomaticAllocationReconciliationForRead(logicalPath, params, authContext) {
  if (logicalPath !== '/boxes/get' && logicalPath !== '/allocations/by-job' && logicalPath !== '/jobs/get') {
    return;
  }

  await withReadClient(async (client) => {
    if (logicalPath === '/boxes/get') {
      const boxId = params && params.boxId;
      await reconcileCheckedOutBoxAllocationLinkByBoxId(client, authContext.orgId, boxId, authContext.actor);
      await reconcileZeroedBoxAllocationStateByBoxId(client, authContext.orgId, boxId, authContext.actor);
      return;
    }

    const jobNumber = params && params.jobNumber;
    await reconcileCheckedOutBoxAllocationLinksForJob(
      client,
      authContext.orgId,
      jobNumber,
      authContext.actor
    );
    await reconcileZeroedBoxAllocationStateForJob(client, authContext.orgId, jobNumber, authContext.actor);
  });
}

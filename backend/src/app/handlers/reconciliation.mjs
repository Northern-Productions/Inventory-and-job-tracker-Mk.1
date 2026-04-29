// Purpose: Keep read-time checked-out allocation linking isolated from the transport entrypoint.
import { withReadClient } from '../../db/client.mjs';
import {
  reconcileCheckedOutBoxAllocationLinkByBoxId,
  reconcileCheckedOutBoxAllocationLinksForJob,
} from '../services/allocations.mjs';

export async function runAutomaticAllocationReconciliationForRead(logicalPath, params, authContext) {
  if (logicalPath !== '/boxes/get' && logicalPath !== '/allocations/by-job' && logicalPath !== '/jobs/get') {
    return;
  }

  await withReadClient(async (client) => {
    if (logicalPath === '/boxes/get') {
      const boxId = params && params.boxId;
      await reconcileCheckedOutBoxAllocationLinkByBoxId(client, authContext.orgId, boxId, authContext.actor);
      return;
    }

    const jobNumber = params && params.jobNumber;
    await reconcileCheckedOutBoxAllocationLinksForJob(
      client,
      authContext.orgId,
      jobNumber,
      authContext.actor
    );
  });
}

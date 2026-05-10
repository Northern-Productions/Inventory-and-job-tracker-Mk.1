// Purpose: Keep read-time checked-out allocation linking isolated from the transport entrypoint.
import { withReadClient } from '../../db/client.mjs';
import { findJobById } from '../repositories/jobsRepository.mjs';
import {
  reconcileCheckedOutBoxAllocationLinkByBoxId,
  reconcileCheckedOutBoxAllocationLinksForJob,
} from '../services/allocations.mjs';

export async function runAutomaticAllocationReconciliationForRead(logicalPath, params, authContext) {
  if (
    logicalPath !== '/boxes/get' &&
    logicalPath !== '/allocations/by-job' &&
    logicalPath !== '/jobs/get' &&
    logicalPath !== '/jobs/get-by-id'
  ) {
    return;
  }

  await withReadClient(async (client) => {
    if (logicalPath === '/boxes/get') {
      const boxId = params && params.boxId;
      await reconcileCheckedOutBoxAllocationLinkByBoxId(client, authContext.orgId, boxId, authContext.actor);
      return;
    }

    let jobNumber = params && params.jobNumber;
    if (logicalPath === '/jobs/get-by-id') {
      const header = await findJobById(client, authContext.orgId, params && params.jobId);
      if (!header) {
        return;
      }
      jobNumber = header?.jobNumber || '';
    }
    await reconcileCheckedOutBoxAllocationLinksForJob(
      client,
      authContext.orgId,
      jobNumber,
      authContext.actor
    );
  });
}

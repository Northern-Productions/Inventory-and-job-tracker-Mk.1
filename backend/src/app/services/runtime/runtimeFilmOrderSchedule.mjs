// Purpose: Shared film-order schedule enrichment helpers used across runtime services.
import { asTrimmedString, findJobByNumber } from '../runtimeDeps.mjs';

function isUnresolvedFilmOrderStatus(status) {
  const normalizedStatus = asTrimmedString(status).toUpperCase();
  return normalizedStatus === 'FILM_ORDER' || normalizedStatus === 'FILM_ON_THE_WAY';
}

async function enrichOpenFilmOrdersWithJobSchedule(client, orgId, filmOrders) {
  const jobHeaderCache = {};
  const response = [];

  for (let index = 0; index < filmOrders.length; index += 1) {
    const entry = filmOrders[index];
    if (!entry || !isUnresolvedFilmOrderStatus(entry.status)) {
      response.push(entry);
      continue;
    }

    const needsJobDate = !asTrimmedString(entry.jobDate);
    const needsCrewLeader = !asTrimmedString(entry.crewLeader);
    if (!needsJobDate && !needsCrewLeader) {
      response.push(entry);
      continue;
    }

    const normalizedJobNumber = asTrimmedString(entry.jobNumber);
    if (!normalizedJobNumber) {
      response.push(entry);
      continue;
    }

    if (!(normalizedJobNumber in jobHeaderCache)) {
      jobHeaderCache[normalizedJobNumber] =
        (await findJobByNumber(client, orgId, normalizedJobNumber)) || null;
    }

    const jobHeader = jobHeaderCache[normalizedJobNumber];
    if (!jobHeader) {
      response.push(entry);
      continue;
    }

    response.push({
      ...entry,
      ...(needsJobDate && asTrimmedString(jobHeader.dueDate)
        ? { jobDate: asTrimmedString(jobHeader.dueDate) }
        : {}),
      ...(needsCrewLeader && asTrimmedString(jobHeader.crewLeader)
        ? { crewLeader: asTrimmedString(jobHeader.crewLeader) }
        : {}),
    });
  }

  return response;
}

export {
  enrichOpenFilmOrdersWithJobSchedule,
  isUnresolvedFilmOrderStatus,
};

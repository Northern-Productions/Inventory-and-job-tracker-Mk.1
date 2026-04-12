// Purpose: Shared film-order schedule enrichment helpers used across runtime services.
import { asTrimmedString, findJobByNumber } from '../runtimeDeps.mjs';

function isUnresolvedFilmOrderStatus(status) {
  const normalizedStatus = asTrimmedString(status).toUpperCase();
  return normalizedStatus === 'FILM_ORDER' || normalizedStatus === 'FILM_ON_THE_WAY';
}

function isFilmOrderNeedingAttention(order) {
  const normalizedStatus = asTrimmedString(order?.status).toUpperCase();
  if (normalizedStatus !== 'FILM_ORDER') {
    return false;
  }

  if (!asTrimmedString(order?.installDate)) {
    return false;
  }

  const remainingToOrderFeet = Number(order?.remainingToOrderFeet);
  return Number.isFinite(remainingToOrderFeet) ? remainingToOrderFeet > 0 : true;
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

    const needsInstallDate = !asTrimmedString(entry.installDate);
    const needsCrewLeader = !asTrimmedString(entry.crewLeader);
    if (!needsInstallDate && !needsCrewLeader) {
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
      ...(needsInstallDate && asTrimmedString(jobHeader.installDate)
        ? { installDate: asTrimmedString(jobHeader.installDate) }
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
  isFilmOrderNeedingAttention,
  isUnresolvedFilmOrderStatus,
};

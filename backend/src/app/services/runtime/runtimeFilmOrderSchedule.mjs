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
  const jobNumbersNeedingSchedule = Array.from(
    new Set(
      (Array.isArray(filmOrders) ? filmOrders : [])
        .filter((entry) => {
          if (!entry || !isUnresolvedFilmOrderStatus(entry.status)) {
            return false;
          }

          return !asTrimmedString(entry.installDate) || !asTrimmedString(entry.crewLeader);
        })
        .map((entry) => asTrimmedString(entry.jobNumber))
        .filter(Boolean)
    )
  );
  const jobHeaderEntries = await Promise.all(
    jobNumbersNeedingSchedule.map(async (jobNumber) => [
      jobNumber,
      (await findJobByNumber(client, orgId, jobNumber)) || null,
    ])
  );
  const jobHeaderCache = Object.fromEntries(jobHeaderEntries);

  return (Array.isArray(filmOrders) ? filmOrders : []).map((entry) => {
    if (!entry || !isUnresolvedFilmOrderStatus(entry.status)) {
      return entry;
    }

    const needsInstallDate = !asTrimmedString(entry.installDate);
    const needsCrewLeader = !asTrimmedString(entry.crewLeader);
    if (!needsInstallDate && !needsCrewLeader) {
      return entry;
    }

    const jobHeader = jobHeaderCache[asTrimmedString(entry.jobNumber)];
    if (!jobHeader) {
      return entry;
    }

    return {
      ...entry,
      ...(needsInstallDate && asTrimmedString(jobHeader.installDate)
        ? { installDate: asTrimmedString(jobHeader.installDate) }
        : {}),
      ...(needsCrewLeader && asTrimmedString(jobHeader.crewLeader)
        ? { crewLeader: asTrimmedString(jobHeader.crewLeader) }
        : {}),
    };
  });
}

export {
  enrichOpenFilmOrdersWithJobSchedule,
  isFilmOrderNeedingAttention,
  isUnresolvedFilmOrderStatus,
};

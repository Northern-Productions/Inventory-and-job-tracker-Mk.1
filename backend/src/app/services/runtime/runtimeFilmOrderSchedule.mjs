// Purpose: Shared film-order schedule enrichment helpers used across runtime services.
import { asTrimmedString, findJobById, findJobByNumber } from '../runtimeDeps.mjs';

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
  const entries = Array.isArray(filmOrders) ? filmOrders : [];
  const jobIdsNeedingHeader = Array.from(
    new Set(
      entries
        .filter((entry) => {
          if (!entry) {
            return false;
          }

          const jobId = asTrimmedString(entry.jobId);
          if (!jobId) {
            return false;
          }

          const needsScope = !asTrimmedString(entry.workScope || entry.sections);
          const needsSchedule =
            isUnresolvedFilmOrderStatus(entry.status) &&
            (!asTrimmedString(entry.installDate) || !asTrimmedString(entry.crewLeader));
          return needsScope || needsSchedule;
        })
        .map((entry) => asTrimmedString(entry.jobId))
        .filter(Boolean)
    )
  );
  const jobHeaderById = {};
  for (let index = 0; index < jobIdsNeedingHeader.length; index += 1) {
    const jobId = jobIdsNeedingHeader[index];
    // Shared pg clients are request-scoped; keep these lookups serialized.
    jobHeaderById[jobId] = (await findJobById(client, orgId, jobId)) || null;
  }

  const jobNumbersNeedingSchedule = Array.from(
    new Set(
      entries
        .filter((entry) => {
          if (!entry || !isUnresolvedFilmOrderStatus(entry.status)) {
            return false;
          }

          if (asTrimmedString(entry.jobId)) {
            return false;
          }

          return !asTrimmedString(entry.installDate) || !asTrimmedString(entry.crewLeader);
        })
        .map((entry) => asTrimmedString(entry.jobNumber))
        .filter(Boolean)
    )
  );
  const jobHeaderCache = {};
  for (let index = 0; index < jobNumbersNeedingSchedule.length; index += 1) {
    const jobNumber = jobNumbersNeedingSchedule[index];
    // Shared pg clients are request-scoped; keep these lookups serialized.
    jobHeaderCache[jobNumber] = (await findJobByNumber(client, orgId, jobNumber)) || null;
  }

  return entries.map((entry) => {
    if (!entry) {
      return entry;
    }

    const jobId = asTrimmedString(entry.jobId);
    const jobHeaderByJobId = jobId ? jobHeaderById[jobId] : null;
    const existingScope = asTrimmedString(entry.workScope || entry.sections);
    const headerScope = jobHeaderByJobId
      ? asTrimmedString(jobHeaderByJobId.workScope || jobHeaderByJobId.sections)
      : '';
    const scopePatch = !existingScope && headerScope
      ? {
          workScope: headerScope,
          sections: headerScope,
        }
      : {};

    if (!isUnresolvedFilmOrderStatus(entry.status)) {
      return Object.keys(scopePatch).length ? { ...entry, ...scopePatch } : entry;
    }

    const needsInstallDate = !asTrimmedString(entry.installDate);
    const needsCrewLeader = !asTrimmedString(entry.crewLeader);
    if (!needsInstallDate && !needsCrewLeader) {
      return Object.keys(scopePatch).length ? { ...entry, ...scopePatch } : entry;
    }

    const jobHeader = jobHeaderByJobId || jobHeaderCache[asTrimmedString(entry.jobNumber)];
    if (!jobHeader) {
      return Object.keys(scopePatch).length ? { ...entry, ...scopePatch } : entry;
    }

    return {
      ...entry,
      ...scopePatch,
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

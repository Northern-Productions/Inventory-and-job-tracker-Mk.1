function integerOrZero(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.trunc(parsed);
}

function asTrimmedString(value) {
  return String(value ?? '').trim();
}

export function normalizeCompletedJobBackfillCandidate(row) {
  const candidate = {
    id: row?.id ?? null,
    jobNumber: asTrimmedString(row?.jobNumber || row?.job_number),
    installDate: row?.installDate || row?.due_date || '',
    lifecycleStatus: asTrimmedString(row?.lifecycleStatus || row?.lifecycle_status || 'ACTIVE').toUpperCase() || 'ACTIVE',
    activeAllocationCount: integerOrZero(row?.activeAllocationCount ?? row?.active_allocation_count),
    openFilmOrderCount: integerOrZero(row?.openFilmOrderCount ?? row?.open_film_order_count),
    fulfilledAllocationCount: integerOrZero(row?.fulfilledAllocationCount ?? row?.fulfilled_allocation_count),
    fulfilledFilmOrderCount: integerOrZero(row?.fulfilledFilmOrderCount ?? row?.fulfilled_film_order_count),
  };

  candidate.fulfilledRecordCount =
    candidate.fulfilledAllocationCount + candidate.fulfilledFilmOrderCount;
  candidate.shouldBackfill = isLegacyCompletedJobCandidate(candidate);

  return candidate;
}

export function isLegacyCompletedJobCandidate(row) {
  const activeAllocationCount = integerOrZero(row?.activeAllocationCount ?? row?.active_allocation_count);
  const openFilmOrderCount = integerOrZero(row?.openFilmOrderCount ?? row?.open_film_order_count);
  const fulfilledRecordCount = integerOrZero(
    row?.fulfilledRecordCount ??
      row?.fulfilled_record_count ??
      integerOrZero(row?.fulfilledAllocationCount ?? row?.fulfilled_allocation_count) +
        integerOrZero(row?.fulfilledFilmOrderCount ?? row?.fulfilled_film_order_count)
  );

  return activeAllocationCount === 0 && openFilmOrderCount === 0 && fulfilledRecordCount > 0;
}

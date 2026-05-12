// Purpose: Shared film-order ownership validation for jobId-transition mutation guards.
function asTrimmedString(value) {
  return String(value ?? '').trim();
}

function readFirst(record, keys) {
  const source = record && typeof record === 'object' && !Array.isArray(record) ? record : {};
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      return source[key];
    }
  }
  return undefined;
}

function normalizeJobNumberValue(value, options = {}) {
  const trimmed = asTrimmedString(value);
  if (!trimmed) {
    return '';
  }

  if (typeof options.normalizeJobNumberDigits === 'function') {
    return options.normalizeJobNumberDigits(trimmed, 'JobNumber');
  }

  if (typeof options.normalizeJobNumber === 'function') {
    return options.normalizeJobNumber(trimmed, 'JobNumber');
  }

  return trimmed;
}

export function getFilmOrderJobIdentity(filmOrder = {}, options = {}) {
  return {
    filmOrderId: asTrimmedString(readFirst(filmOrder, ['filmOrderId', 'film_order_id', 'id'])),
    jobId: asTrimmedString(readFirst(filmOrder, ['jobId', 'job_id'])),
    jobNumber: normalizeJobNumberValue(readFirst(filmOrder, ['jobNumber', 'job_number']), options),
  };
}

export function validateFilmOrderJobMutationOwnership({
  filmOrder,
  filmOrderId,
  target,
  normalizeJobNumberDigits,
  normalizeJobNumber,
} = {}) {
  const requestedFilmOrderId = asTrimmedString(filmOrderId);
  if (!filmOrder) {
    return {
      ok: false,
      reason: 'FILM_ORDER_NOT_FOUND',
      status: 404,
      message: `Film order ${requestedFilmOrderId || '(unknown)'} was not found.`,
    };
  }

  const options = { normalizeJobNumberDigits, normalizeJobNumber };
  const filmOrderIdentity = getFilmOrderJobIdentity(filmOrder, options);
  const targetJobId = asTrimmedString(readFirst(target, ['jobId', 'job_id', 'id']));
  const targetJobNumber = normalizeJobNumberValue(readFirst(target, ['jobNumber', 'job_number']), options);

  if (!targetJobId) {
    return {
      ok: false,
      reason: 'MISSING_TARGET_JOB_ID',
      status: 400,
      message: 'A jobId is required to validate film order ownership.',
    };
  }

  if (!filmOrderIdentity.jobId) {
    return {
      ok: false,
      reason: 'MISSING_FILM_ORDER_JOB_ID',
      status: 409,
      message: `Film order ${filmOrderIdentity.filmOrderId || requestedFilmOrderId || '(unknown)'} does not have job ownership and cannot be safely deleted from a canonical jobId route.`,
    };
  }

  if (filmOrderIdentity.jobId !== targetJobId) {
    return {
      ok: false,
      reason: 'FILM_ORDER_JOB_ID_MISMATCH',
      status: 409,
      message: `Film order ${filmOrderIdentity.filmOrderId || requestedFilmOrderId || '(unknown)'} belongs to a different job.`,
      filmOrderJobId: filmOrderIdentity.jobId,
      targetJobId,
    };
  }

  if (
    filmOrderIdentity.jobNumber &&
    targetJobNumber &&
    filmOrderIdentity.jobNumber !== targetJobNumber
  ) {
    return {
      ok: false,
      reason: 'FILM_ORDER_JOB_NUMBER_MISMATCH',
      status: 409,
      message: `Film order ${filmOrderIdentity.filmOrderId || requestedFilmOrderId || '(unknown)'} belongs to job ${filmOrderIdentity.jobNumber}, not ${targetJobNumber}.`,
      filmOrderJobNumber: filmOrderIdentity.jobNumber,
      targetJobNumber,
    };
  }

  return {
    ok: true,
    reason: 'MATCH',
    filmOrderId: filmOrderIdentity.filmOrderId || requestedFilmOrderId,
    jobId: targetJobId,
    jobNumber: targetJobNumber || filmOrderIdentity.jobNumber,
  };
}

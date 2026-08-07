const DELETE_JOB_FAILURE_MESSAGE = 'The job could not be deleted. Refresh the job and try again.';

function readValue(entry, ...keys) {
  if (!entry || typeof entry !== 'object') {
    return '';
  }
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(entry, key)) {
      return entry[key];
    }
  }
  return '';
}

function normalizeText(value) {
  return String(value ?? '').trim();
}

function normalizeJobNumber(value) {
  return normalizeText(value).toUpperCase();
}

function isCheckedOutBoxAssignedToJob(entry, { jobId = '', jobNumber = '' } = {}) {
  if (normalizeText(readValue(entry, 'status')).toUpperCase() !== 'CHECKED_OUT') {
    return false;
  }

  const targetJobId = normalizeText(jobId).toLowerCase();
  const targetJobNumber = normalizeJobNumber(jobNumber);
  const boxJobId = normalizeText(readValue(entry, 'last_checkout_job_id', 'lastCheckoutJobId')).toLowerCase();
  const boxJobNumber = normalizeJobNumber(readValue(entry, 'last_checkout_job', 'lastCheckoutJob'));

  if (!targetJobId) {
    return Boolean(targetJobNumber) && boxJobNumber === targetJobNumber;
  }

  return boxJobId === targetJobId || (!boxJobId && Boolean(targetJobNumber) && boxJobNumber === targetJobNumber);
}

function isExpectedDeleteJobHttpStatus(statusCode) {
  const normalized = Number(statusCode);
  return Number.isInteger(normalized) && normalized >= 400 && normalized < 500;
}

export {
  DELETE_JOB_FAILURE_MESSAGE,
  isCheckedOutBoxAssignedToJob,
  isExpectedDeleteJobHttpStatus,
};

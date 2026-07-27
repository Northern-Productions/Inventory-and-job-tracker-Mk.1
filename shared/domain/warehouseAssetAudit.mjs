import {
  getStoredPhysicalFootprintEntries,
  sumAllocatedFeet,
} from './filmAllocationReservations.mjs';
import {
  getJobPhaseWorkflowStatus,
  isJobPhaseComplete,
  resolveCurrentJobCrewLeader,
  selectCurrentJobPhase,
} from './jobCurrentAssignment.mjs';

const OPERATIONAL_BOX_STATUSES = Object.freeze(['IN_STOCK', 'CHECKED_OUT', 'TRANSFER']);
const COST_BASIS_CATEGORIES = Object.freeze([
  'DIRECT_PRICE_PER_LF',
  'DERIVED_FROM_PURCHASE_COST',
  'MISSING',
]);
const UNASSIGNED_OWNER_FILTER = 'UNASSIGNED';
const CHECKOUT_CONTEXT_INTEGRITY_CODE = 'WAREHOUSE_ASSET_AUDIT_CHECKOUT_CONTEXT_INTEGRITY';
const CHECKOUT_CONTEXT_INTEGRITY_MESSAGE =
  'Checked-out assignment context is inconsistent. The warehouse asset audit is unavailable.';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STATUS_LABELS = Object.freeze({
  IN_STOCK: 'In Stock',
  CHECKED_OUT: 'Checked Out',
  TRANSFER: 'Pending Transfer',
});

class WarehouseAssetAuditError extends Error {
  constructor(message, code = 'INTEGRITY_CHECK_FAILED', statusCode = 409) {
    super(message);
    this.name = 'WarehouseAssetAuditError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function asTrimmedString(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function readValue(source, ...keys) {
  for (const key of keys) {
    if (source && Object.prototype.hasOwnProperty.call(source, key)) {
      return source[key];
    }
  }
  return undefined;
}

function failCheckoutContextIntegrity() {
  throw new WarehouseAssetAuditError(
    CHECKOUT_CONTEXT_INTEGRITY_MESSAGE,
    CHECKOUT_CONTEXT_INTEGRITY_CODE,
    409,
  );
}

function assertCheckoutContextOrg(entry, expectedOrgId) {
  if (asTrimmedString(readValue(entry, 'orgId', 'org_id')) !== expectedOrgId) {
    failCheckoutContextIntegrity();
  }
}

function normalizeJobNumberKey(value) {
  return asTrimmedString(value).toUpperCase();
}

function getCompatibleJobNumberKeys(value, warehouse) {
  const normalized = normalizeJobNumberKey(value);
  if (!normalized) {
    return [];
  }
  const keys = new Set([normalized]);
  const prefix = `${normalizeUpper(warehouse)}-`;
  if (prefix !== '-' && normalized.startsWith(prefix) && normalized.length > prefix.length) {
    keys.add(normalized.slice(prefix.length));
  }
  return [...keys];
}

function jobNumbersAreCompatible(leftValue, leftWarehouse, rightValue, rightWarehouse) {
  const rightKeys = new Set(getCompatibleJobNumberKeys(rightValue, rightWarehouse));
  return getCompatibleJobNumberKeys(leftValue, leftWarehouse).some((key) => rightKeys.has(key));
}

function formatCheckedOutJobNumber(job) {
  const jobNumber = asTrimmedString(readValue(job, 'jobNumber', 'job_number'));
  if (!jobNumber || UUID_PATTERN.test(jobNumber)) {
    failCheckoutContextIntegrity();
  }
  const warehouse = normalizeUpper(readValue(job, 'warehouse'));
  const prefix = `${warehouse}-`;
  if (
    warehouse &&
    jobNumber.toUpperCase().startsWith(prefix) &&
    jobNumber.length > prefix.length
  ) {
    return jobNumber.slice(prefix.length);
  }
  return jobNumber;
}

function indexCheckoutJobs(jobs, expectedOrgId) {
  const byId = new Map();
  const entries = [];
  for (const job of Array.isArray(jobs) ? jobs : []) {
    assertCheckoutContextOrg(job, expectedOrgId);
    const id = asTrimmedString(readValue(job, 'id', 'jobId', 'job_id'));
    const jobNumber = asTrimmedString(readValue(job, 'jobNumber', 'job_number'));
    if (!id || !jobNumber || byId.has(id)) {
      failCheckoutContextIntegrity();
    }
    const normalized = {
      ...job,
      id,
      jobNumber,
      warehouse: normalizeUpper(readValue(job, 'warehouse')),
      crewLeader: asTrimmedString(readValue(job, 'crewLeader', 'crew_leader')),
    };
    byId.set(id, normalized);
    entries.push(normalized);
  }
  return { byId, entries };
}

function findCompatibleJobs(jobs, jobNumber, warehouse) {
  if (!asTrimmedString(jobNumber)) {
    return [];
  }
  return jobs.filter((job) =>
    jobNumbersAreCompatible(jobNumber, warehouse, job.jobNumber, job.warehouse)
  );
}

function resolveJobEvidence(entry, jobsById, jobs, fallbackWarehouse = '') {
  const jobId = asTrimmedString(readValue(entry, 'jobId', 'job_id'));
  const jobNumber = asTrimmedString(readValue(entry, 'jobNumber', 'job_number'));
  if (jobId) {
    const job = jobsById.get(jobId);
    if (
      !job ||
      (jobNumber &&
        !jobNumbersAreCompatible(jobNumber, fallbackWarehouse, job.jobNumber, job.warehouse))
    ) {
      failCheckoutContextIntegrity();
    }
    return job;
  }
  const matches = findCompatibleJobs(jobs, jobNumber, fallbackWarehouse);
  if (matches.length !== 1) {
    failCheckoutContextIntegrity();
  }
  return matches[0];
}

function indexFilmOrders(filmOrders, expectedOrgId) {
  const byBusinessId = new Map();
  for (const entry of Array.isArray(filmOrders) ? filmOrders : []) {
    assertCheckoutContextOrg(entry, expectedOrgId);
    const filmOrderId = asTrimmedString(readValue(entry, 'filmOrderId', 'film_order_id'));
    if (!filmOrderId || byBusinessId.has(filmOrderId)) {
      failCheckoutContextIntegrity();
    }
    byBusinessId.set(filmOrderId, entry);
  }
  return byBusinessId;
}

function buildDirectJobsByBox(
  links,
  filmOrdersByBusinessId,
  jobsById,
  jobs,
  boxesByBusinessId,
  expectedOrgId,
) {
  const result = new Map();
  const seenLinks = new Set();
  for (const link of Array.isArray(links) ? links : []) {
    assertCheckoutContextOrg(link, expectedOrgId);
    const linkId = asTrimmedString(readValue(link, 'id', 'linkId', 'link_id'));
    const boxId = normalizeUpper(readValue(link, 'boxId', 'box_id'));
    const filmOrderId = asTrimmedString(readValue(link, 'filmOrderId', 'film_order_id'));
    if (!linkId || seenLinks.has(linkId) || !boxId || !filmOrderId) {
      failCheckoutContextIntegrity();
    }
    seenLinks.add(linkId);
    const box = boxesByBusinessId.get(boxId);
    if (!box) {
      failCheckoutContextIntegrity();
    }
    if (readValue(box, 'directToJobSite', 'direct_to_job_site') !== true) {
      continue;
    }
    const filmOrder = filmOrdersByBusinessId.get(filmOrderId);
    if (!filmOrder) {
      failCheckoutContextIntegrity();
    }
    const job = resolveJobEvidence(
      filmOrder,
      jobsById,
      jobs,
      readValue(filmOrder, 'warehouse'),
    );
    const current = result.get(boxId) || new Map();
    current.set(job.id, job);
    result.set(boxId, current);
  }
  return result;
}

function groupCheckoutRowsByJob(rows, expectedOrgId, jobsById, jobs) {
  const result = new Map();
  for (const entry of Array.isArray(rows) ? rows : []) {
    assertCheckoutContextOrg(entry, expectedOrgId);
    const job = resolveJobEvidence(entry, jobsById, jobs, readValue(entry, 'warehouse'));
    const current = result.get(job.id) || [];
    current.push(entry);
    result.set(job.id, current);
  }
  return result;
}

function buildCurrentPhase(job, phases, filmRequirements, caulkRequirements, today) {
  const phaseEntries = (Array.isArray(phases) ? phases : []).map((phase) => {
    const phaseId = asTrimmedString(readValue(phase, 'phaseId', 'phase_id', 'id'));
    if (!phaseId) {
      failCheckoutContextIntegrity();
    }
    return {
      phaseId,
      phaseNumber: Number(readValue(phase, 'phaseNumber', 'phase_number')) || 1,
      installDate: asTrimmedString(readValue(phase, 'installDate', 'install_date')),
      crewLeader: asTrimmedString(readValue(phase, 'crewLeader', 'crew_leader')),
      laborStatus: asTrimmedString(readValue(phase, 'laborStatus', 'labor_status')),
      workflowStatus: getJobPhaseWorkflowStatus(phase),
      isPrimary: readValue(phase, 'isPrimary', 'is_primary') === true,
    };
  });
  const phaseIds = new Set(phaseEntries.map((phase) => phase.phaseId));
  const fallbackPhaseId =
    phaseEntries.find((phase) => phase.isPrimary)?.phaseId || phaseEntries[0]?.phaseId || '';
  const getRequirementsForPhase = (entries, phaseId) =>
    (Array.isArray(entries) ? entries : []).filter((entry) => {
      const entryPhaseId = asTrimmedString(readValue(entry, 'phaseId', 'phase_id'));
      if (entryPhaseId && !phaseIds.has(entryPhaseId)) {
        failCheckoutContextIntegrity();
      }
      return entryPhaseId ? entryPhaseId === phaseId : fallbackPhaseId === phaseId;
    });
  const resolvedPhases = phaseEntries.map((phase) => ({
    ...phase,
    isComplete: isJobPhaseComplete(
      phase,
      getRequirementsForPhase(filmRequirements, phase.phaseId),
      getRequirementsForPhase(caulkRequirements, phase.phaseId),
    ),
  }));
  return selectCurrentJobPhase(resolvedPhases, { today });
}

function firstLegacyCrewLeader(allocations, filmOrders) {
  for (const entry of Array.isArray(allocations) ? allocations : []) {
    const crewLeader = asTrimmedString(readValue(entry, 'crewLeader', 'crew_leader'));
    if (crewLeader) {
      return crewLeader;
    }
  }
  for (const entry of Array.isArray(filmOrders) ? filmOrders : []) {
    const crewLeader = asTrimmedString(readValue(entry, 'crewLeader', 'crew_leader'));
    if (crewLeader) {
      return crewLeader;
    }
  }
  return '';
}

function buildCheckedOutContextByBox({
  expectedOrgId,
  boxes,
  checkoutContext,
  today,
}) {
  const checkedOutBoxes = (Array.isArray(boxes) ? boxes : []).filter(
    (box) => normalizeUpper(readValue(box, 'status')) === 'CHECKED_OUT',
  );
  if (!checkedOutBoxes.length) {
    return new Map();
  }
  if (!checkoutContext || typeof checkoutContext !== 'object') {
    failCheckoutContextIntegrity();
  }

  try {
    const boxesByBusinessId = new Map();
    for (const box of checkedOutBoxes) {
      assertCheckoutContextOrg(box, expectedOrgId);
      const boxId = normalizeUpper(readValue(box, 'boxId', 'box_id'));
      if (!boxId || boxesByBusinessId.has(boxId)) {
        failCheckoutContextIntegrity();
      }
      boxesByBusinessId.set(boxId, box);
    }

    const { byId: jobsById, entries: jobs } = indexCheckoutJobs(
      checkoutContext.jobs,
      expectedOrgId,
    );
    const filmOrdersByBusinessId = indexFilmOrders(
      checkoutContext.filmOrders,
      expectedOrgId,
    );
    const directJobsByBox = buildDirectJobsByBox(
      checkoutContext.filmOrderBoxLinks,
      filmOrdersByBusinessId,
      jobsById,
      jobs,
      boxesByBusinessId,
      expectedOrgId,
    );
    const phasesByJob = groupCheckoutRowsByJob(
      checkoutContext.phases,
      expectedOrgId,
      jobsById,
      jobs,
    );
    const requirementsByJob = groupCheckoutRowsByJob(
      checkoutContext.requirements,
      expectedOrgId,
      jobsById,
      jobs,
    );
    const caulkRequirementsByJob = groupCheckoutRowsByJob(
      checkoutContext.caulkRequirements,
      expectedOrgId,
      jobsById,
      jobs,
    );
    const allocationsByJob = groupCheckoutRowsByJob(
      checkoutContext.allocations,
      expectedOrgId,
      jobsById,
      jobs,
    );
    const filmOrdersByJob = groupCheckoutRowsByJob(
      checkoutContext.filmOrders,
      expectedOrgId,
      jobsById,
      jobs,
    );
    const result = new Map();

    for (const box of checkedOutBoxes) {
      const boxRecordId = asTrimmedString(readValue(box, 'id', 'boxRecordId', 'box_record_id'));
      const boxId = normalizeUpper(readValue(box, 'boxId', 'box_id'));
      const warehouse = normalizeUpper(readValue(box, 'warehouse'));
      const durableJobId = asTrimmedString(
        readValue(box, 'lastCheckoutJobId', 'last_checkout_job_id'),
      );
      const legacyJobNumber = asTrimmedString(
        readValue(box, 'lastCheckoutJob', 'last_checkout_job'),
      );
      const legacyMatches = findCompatibleJobs(jobs, legacyJobNumber, warehouse);
      if (legacyMatches.length > 1) {
        failCheckoutContextIntegrity();
      }
      const directJobs = [...(directJobsByBox.get(boxId)?.values() || [])];
      if (directJobs.length > 1) {
        failCheckoutContextIntegrity();
      }

      let selectedJob = null;
      if (durableJobId) {
        selectedJob = jobsById.get(durableJobId) || null;
        if (!selectedJob) {
          failCheckoutContextIntegrity();
        }
        if (
          legacyJobNumber &&
          !jobNumbersAreCompatible(
            legacyJobNumber,
            warehouse,
            selectedJob.jobNumber,
            selectedJob.warehouse,
          )
        ) {
          failCheckoutContextIntegrity();
        }
      } else if (legacyJobNumber) {
        if (legacyMatches.length !== 1) {
          failCheckoutContextIntegrity();
        }
        selectedJob = legacyMatches[0];
      } else if (readValue(box, 'directToJobSite', 'direct_to_job_site') === true) {
        if (directJobs.length !== 1) {
          failCheckoutContextIntegrity();
        }
        selectedJob = directJobs[0];
      } else {
        failCheckoutContextIntegrity();
      }

      if (
        legacyMatches.some((job) => job.id !== selectedJob.id) ||
        directJobs.some((job) => job.id !== selectedJob.id)
      ) {
        failCheckoutContextIntegrity();
      }

      const currentPhase = buildCurrentPhase(
        selectedJob,
        phasesByJob.get(selectedJob.id) || [],
        requirementsByJob.get(selectedJob.id) || [],
        caulkRequirementsByJob.get(selectedJob.id) || [],
        today,
      );
      const legacyCrewLeader = firstLegacyCrewLeader(
        allocationsByJob.get(selectedJob.id) || [],
        filmOrdersByJob.get(selectedJob.id) || [],
      );
      const crewLeader =
        resolveCurrentJobCrewLeader({
          currentPhase,
          jobCrewLeader: selectedJob.crewLeader,
          legacyCrewLeader,
        }) || null;
      if (crewLeader && UUID_PATTERN.test(crewLeader)) {
        failCheckoutContextIntegrity();
      }
      result.set(boxRecordId, {
        checkedOutJobNumber: formatCheckedOutJobNumber(selectedJob),
        checkedOutCrewLeaderName: crewLeader,
      });
    }

    return result;
  } catch (error) {
    if (
      error instanceof WarehouseAssetAuditError &&
      error.code === CHECKOUT_CONTEXT_INTEGRITY_CODE
    ) {
      throw error;
    }
    failCheckoutContextIntegrity();
  }
}

function normalizeUpper(value) {
  return asTrimmedString(value).toUpperCase();
}

function normalizeOrgId(source) {
  return asTrimmedString(readValue(source, 'orgId', 'org_id'));
}

function assertSameOrg(source, expectedOrgId, category) {
  const rowOrgId = normalizeOrgId(source);
  if (!rowOrgId || rowOrgId !== expectedOrgId) {
    throw new WarehouseAssetAuditError(`${category} organization scope is inconsistent.`);
  }
}

function integerOrNull(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    return null;
  }
  return parsed;
}

function nonNegativeInteger(value, fieldName) {
  const parsed = integerOrNull(value);
  if (parsed === null || parsed < 0) {
    throw new WarehouseAssetAuditError(`${fieldName} is missing or invalid.`);
  }
  return parsed;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function gcd(left, right) {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a || 1n;
}

function rational(numerator, denominator = 1n) {
  if (denominator === 0n) {
    throw new WarehouseAssetAuditError('A financial denominator is invalid.');
  }
  const sign = denominator < 0n ? -1n : 1n;
  const normalizedNumerator = numerator * sign;
  const normalizedDenominator = denominator * sign;
  const divisor = gcd(normalizedNumerator, normalizedDenominator);
  return {
    numerator: normalizedNumerator / divisor,
    denominator: normalizedDenominator / divisor,
  };
}

function expandExponentialDecimal(value) {
  const match = /^([+-]?)(\d+)(?:\.(\d*))?[eE]([+-]?\d+)$/.exec(value);
  if (!match) {
    return value;
  }
  const sign = match[1];
  const integerPart = match[2];
  const fractionalPart = match[3] || '';
  const exponent = Number(match[4]);
  const digits = `${integerPart}${fractionalPart}`;
  const decimalIndex = integerPart.length + exponent;
  if (decimalIndex <= 0) {
    return `${sign}0.${'0'.repeat(-decimalIndex)}${digits}`;
  }
  if (decimalIndex >= digits.length) {
    return `${sign}${digits}${'0'.repeat(decimalIndex - digits.length)}`;
  }
  return `${sign}${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
}

function decimalToRational(value, fieldName) {
  const normalized = expandExponentialDecimal(asTrimmedString(value));
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(normalized);
  if (!match) {
    throw new WarehouseAssetAuditError(`${fieldName} is invalid.`);
  }
  const scale = match[3]?.length || 0;
  const sign = match[1] === '-' ? -1n : 1n;
  const numerator = sign * BigInt(`${match[2]}${match[3] || ''}`);
  return rational(numerator, 10n ** BigInt(scale));
}

function addRationals(left, right) {
  return rational(
    left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
}

function subtractRationals(left, right) {
  return rational(
    left.numerator * right.denominator - right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
}

function multiplyRationals(left, right) {
  return rational(left.numerator * right.numerator, left.denominator * right.denominator);
}

function divideRationals(left, right) {
  return rational(left.numerator * right.denominator, left.denominator * right.numerator);
}

function compareRationalToZero(value) {
  if (value.numerator === 0n) return 0;
  return value.numerator < 0n ? -1 : 1;
}

function roundRationalToScaledInteger(value, scale) {
  const scaledNumerator = value.numerator * BigInt(scale);
  const sign = scaledNumerator < 0n ? -1n : 1n;
  const absoluteNumerator = scaledNumerator < 0n ? -scaledNumerator : scaledNumerator;
  const rounded = (absoluteNumerator * 2n + value.denominator) / (value.denominator * 2n);
  return rounded * sign;
}

function rationalToCents(value) {
  if (compareRationalToZero(value) < 0) {
    throw new WarehouseAssetAuditError('A calculated asset cost is negative.');
  }
  return roundRationalToScaledInteger(value, 100).toString();
}

function derivePhysicalFeetFromWeight(box, initialFeet) {
  const lastRollWeight = readValue(box, 'lastRollWeightLbs', 'last_roll_weight_lbs');
  const coreWeight = readValue(box, 'coreWeightLbs', 'core_weight_lbs');
  const lfWeight = readValue(box, 'lfWeightLbsPerFt', 'lf_weight_lbs_per_ft');
  const lastRollNumber = numberOrNull(lastRollWeight);
  const coreNumber = numberOrNull(coreWeight);
  const lfWeightNumber = numberOrNull(lfWeight);
  if (
    lastRollNumber === null ||
    coreNumber === null ||
    lfWeightNumber === null ||
    lfWeightNumber <= 0
  ) {
    return null;
  }

  const rawFeet = divideRationals(
    subtractRationals(
      decimalToRational(lastRollWeight, 'Last roll weight'),
      decimalToRational(coreWeight, 'Core weight'),
    ),
    decimalToRational(lfWeight, 'LF weight'),
  );
  const roundedHundredths = roundRationalToScaledInteger(rawFeet, 100);
  if (roundedHundredths <= 0n) {
    return 0;
  }
  return Math.min(Number(roundedHundredths / 100n), initialFeet);
}

function normalizeAllocation(entry) {
  return {
    allocationId: asTrimmedString(readValue(entry, 'allocationId', 'allocation_id')),
    allocatedFeet: nonNegativeInteger(readValue(entry, 'allocatedFeet', 'allocated_feet'), 'Allocation LF'),
    allocationKind: normalizeUpper(readValue(entry, 'allocationKind', 'allocation_kind')) || 'REQUIREMENT',
    requirementId: asTrimmedString(readValue(entry, 'requirementId', 'requirement_id')),
    jobId: asTrimmedString(readValue(entry, 'jobId', 'job_id')),
    jobNumber: asTrimmedString(readValue(entry, 'jobNumber', 'job_number')),
    status: normalizeUpper(readValue(entry, 'status')),
  };
}

function buildAllocationsByBox(allocations, expectedOrgId) {
  const result = new Map();
  for (const rawEntry of Array.isArray(allocations) ? allocations : []) {
    assertSameOrg(rawEntry, expectedOrgId, 'Allocation');
    const boxId = normalizeUpper(readValue(rawEntry, 'boxId', 'box_id'));
    if (!boxId) {
      throw new WarehouseAssetAuditError('An allocation box reference is missing.');
    }
    const entry = normalizeAllocation(rawEntry);
    const current = result.get(boxId) || [];
    current.push(entry);
    result.set(boxId, current);
  }
  return result;
}

function buildWarehouseMap(warehouses, expectedOrgId) {
  const result = new Map();
  for (const entry of Array.isArray(warehouses) ? warehouses : []) {
    assertSameOrg(entry, expectedOrgId, 'Warehouse');
    const code = normalizeUpper(readValue(entry, 'code', 'warehouse'));
    if (!code) {
      throw new WarehouseAssetAuditError('A warehouse reference is missing.');
    }
    result.set(code, {
      code,
      label: asTrimmedString(readValue(entry, 'name', 'displayName', 'display_name')) || code,
    });
  }
  return result;
}

function formatOwnerLabel(owner) {
  const code = normalizeUpper(readValue(owner, 'code'));
  const name = asTrimmedString(readValue(owner, 'displayName', 'display_name', 'name'));
  const label = code && name && code.toLowerCase() !== name.toLowerCase() ? `${code} - ${name}` : code || name;
  const isActive = readValue(owner, 'isActive', 'is_active') !== false;
  return `${label}${isActive ? '' : ' (inactive)'}`;
}

function buildOwnerMap(owners, expectedOrgId) {
  const result = new Map();
  for (const entry of Array.isArray(owners) ? owners : []) {
    assertSameOrg(entry, expectedOrgId, 'Owner');
    const id = asTrimmedString(readValue(entry, 'ownerCompanyId', 'owner_company_id', 'id'));
    const label = formatOwnerLabel(entry);
    if (!id || !label) {
      throw new WarehouseAssetAuditError('An owner reference is incomplete.');
    }
    result.set(id, {
      id,
      label,
      isActive: readValue(entry, 'isActive', 'is_active') !== false,
    });
  }
  return result;
}

function buildPendingTransfersByBox(transfers, expectedOrgId) {
  const result = new Map();
  for (const entry of Array.isArray(transfers) ? transfers : []) {
    assertSameOrg(entry, expectedOrgId, 'Transfer');
    if (normalizeUpper(readValue(entry, 'status')) !== 'PENDING') {
      continue;
    }
    const boxRecordId = asTrimmedString(readValue(entry, 'boxRecordId', 'box_record_id'));
    if (!boxRecordId) {
      throw new WarehouseAssetAuditError('A pending transfer box reference is missing.');
    }
    const current = result.get(boxRecordId) || [];
    current.push({
      boxRecordId,
      sourceWarehouse: normalizeUpper(readValue(entry, 'sourceWarehouse', 'source_warehouse')),
      destinationWarehouse: normalizeUpper(readValue(entry, 'destinationWarehouse', 'destination_warehouse')),
    });
    result.set(boxRecordId, current);
  }
  return result;
}

function resolveOwner(box, ownerMap) {
  const ownerCompanyId = asTrimmedString(readValue(box, 'ownerCompanyId', 'owner_company_id'));
  if (!ownerCompanyId) {
    return {
      ownerCompanyId: null,
      ownerCompanyLabel: 'Unassigned',
      ownerCategory: 'UNASSIGNED',
    };
  }
  const owner = ownerMap.get(ownerCompanyId);
  if (!owner) {
    throw new WarehouseAssetAuditError('A box owner reference is dangling or outside the organization.');
  }
  return {
    ownerCompanyId,
    ownerCompanyLabel: owner.label,
    ownerCategory: 'ASSIGNED',
  };
}

function resolveCustody(box, pendingTransfers, warehouseMap) {
  const status = normalizeUpper(readValue(box, 'status'));
  const currentWarehouse = normalizeUpper(readValue(box, 'warehouse'));
  if (!warehouseMap.has(currentWarehouse)) {
    throw new WarehouseAssetAuditError('A box custody warehouse reference is invalid.');
  }

  if (pendingTransfers.length > 1) {
    throw new WarehouseAssetAuditError('A box has multiple pending transfers.');
  }

  if (status === 'TRANSFER') {
    if (pendingTransfers.length !== 1) {
      throw new WarehouseAssetAuditError('A transfer-state box does not have exactly one pending transfer.');
    }
    const transfer = pendingTransfers[0];
    if (
      !transfer.sourceWarehouse ||
      !transfer.destinationWarehouse ||
      transfer.sourceWarehouse === transfer.destinationWarehouse ||
      transfer.sourceWarehouse !== currentWarehouse ||
      !warehouseMap.has(transfer.sourceWarehouse) ||
      !warehouseMap.has(transfer.destinationWarehouse)
    ) {
      throw new WarehouseAssetAuditError('A pending transfer has ambiguous custody.');
    }
    return {
      warehouse: transfer.sourceWarehouse,
      custodyBasis: 'PENDING_TRANSFER_SOURCE',
      pendingTransferDestination: transfer.destinationWarehouse,
      statusLabel: `Pending Transfer to ${transfer.destinationWarehouse}`,
    };
  }

  if (pendingTransfers.length !== 0) {
    throw new WarehouseAssetAuditError('A box has conflicting transfer and custody state.');
  }

  if (status === 'CHECKED_OUT') {
    return {
      warehouse: currentWarehouse,
      custodyBasis: 'CHECKOUT_SOURCE',
      pendingTransferDestination: null,
      statusLabel: STATUS_LABELS.CHECKED_OUT,
    };
  }

  return {
    warehouse: currentWarehouse,
    custodyBasis: 'CURRENT_WAREHOUSE',
    pendingTransferDestination: null,
    statusLabel: STATUS_LABELS.IN_STOCK,
  };
}

function resolvePhysicalFeet(box, allocations) {
  const explicitPhysicalFeet = readValue(box, 'physicalFeetAvailable', 'physical_feet_available');
  if (explicitPhysicalFeet !== null && explicitPhysicalFeet !== undefined && explicitPhysicalFeet !== '') {
    return nonNegativeInteger(explicitPhysicalFeet, 'Physical LF');
  }

  const initialFeet = nonNegativeInteger(readValue(box, 'initialFeet', 'initial_feet'), 'Initial LF');
  const fromWeight = derivePhysicalFeetFromWeight(box, initialFeet);
  if (fromWeight !== null) {
    return fromWeight;
  }

  const storedFeetValue = readValue(box, 'storedFeetAvailable', 'feetAvailable', 'feet_available');
  const storedFeet = integerOrNull(storedFeetValue);
  if (storedFeet === null || storedFeet < 0) {
    throw new WarehouseAssetAuditError('A box is missing canonical on-hand LF.');
  }
  if (normalizeUpper(readValue(box, 'status')) === 'CHECKED_OUT') {
    return storedFeet;
  }

  const mappedBox = { status: normalizeUpper(readValue(box, 'status')) };
  return storedFeet + sumAllocatedFeet(getStoredPhysicalFootprintEntries(allocations, mappedBox));
}

function resolveCost(box, onHandLf) {
  const directPrice = readValue(box, 'pricePerLf', 'price_per_lf');
  const purchaseCost = readValue(box, 'purchaseCost', 'purchase_cost');
  const initialFeet = integerOrNull(readValue(box, 'initialFeet', 'initial_feet'));

  let unitCost = null;
  let costBasis = 'MISSING';
  if (directPrice !== null && directPrice !== undefined && directPrice !== '') {
    unitCost = decimalToRational(directPrice, 'Direct price per LF');
    costBasis = 'DIRECT_PRICE_PER_LF';
  } else if (purchaseCost !== null && purchaseCost !== undefined && purchaseCost !== '') {
    if (initialFeet === null || initialFeet <= 0) {
      throw new WarehouseAssetAuditError('A purchase-cost box is missing valid initial LF.');
    }
    unitCost = divideRationals(
      decimalToRational(purchaseCost, 'Purchase cost'),
      rational(BigInt(initialFeet)),
    );
    costBasis = 'DERIVED_FROM_PURCHASE_COST';
  }

  if (!COST_BASIS_CATEGORIES.includes(costBasis)) {
    throw new WarehouseAssetAuditError('A cost basis category is invalid.');
  }
  if (unitCost && compareRationalToZero(unitCost) < 0) {
    throw new WarehouseAssetAuditError('A box cost basis is negative.');
  }
  const exactAssetCost = unitCost
    ? multiplyRationals(unitCost, rational(BigInt(onHandLf)))
    : null;
  return {
    costBasis,
    exactAssetCost,
    onHandAssetCostCents: exactAssetCost ? rationalToCents(exactAssetCost) : null,
  };
}

function compareText(left, right) {
  const leftText = asTrimmedString(left).toLowerCase();
  const rightText = asTrimmedString(right).toLowerCase();
  if (leftText === rightText) {
    const leftOriginal = asTrimmedString(left);
    const rightOriginal = asTrimmedString(right);
    return leftOriginal === rightOriginal ? 0 : leftOriginal < rightOriginal ? -1 : 1;
  }
  return leftText < rightText ? -1 : 1;
}

function compareRows(left, right) {
  return (
    compareText(left.warehouse, right.warehouse) ||
    compareText(left.ownerCompanyLabel, right.ownerCompanyLabel) ||
    compareText(left.manufacturer, right.manufacturer) ||
    compareText(left.filmName, right.filmName) ||
    left.widthIn - right.widthIn ||
    compareText(left.boxId, right.boxId)
  );
}

function uniqueSorted(values, compare = compareText) {
  return Array.from(new Set(values)).sort(compare);
}

function normalizeStatuses(value) {
  const entries = Array.isArray(value)
    ? value
    : asTrimmedString(value)
      ? asTrimmedString(value).split(',')
      : [];
  const statuses = uniqueSorted(entries.map(normalizeUpper).filter(Boolean));
  const normalized = statuses.length ? statuses : [...OPERATIONAL_BOX_STATUSES];
  if (normalized.some((status) => !OPERATIONAL_BOX_STATUSES.includes(status))) {
    throw new WarehouseAssetAuditError('A requested status filter is invalid.', 'INVALID_FILTER', 400);
  }
  return OPERATIONAL_BOX_STATUSES.filter((status) => normalized.includes(status));
}

function normalizeFilters(filters, rows, warehouseMap) {
  const warehouse = normalizeUpper(readValue(filters, 'warehouse'));
  const ownerCompanyId = asTrimmedString(readValue(filters, 'ownerCompanyId', 'owner_company_id'));
  const manufacturer = asTrimmedString(readValue(filters, 'manufacturer'));
  const filmName = asTrimmedString(readValue(filters, 'filmName', 'film'));
  const widthRaw = readValue(filters, 'width');
  const width = widthRaw === null || widthRaw === undefined || widthRaw === '' ? null : numberOrNull(widthRaw);
  const statuses = normalizeStatuses(readValue(filters, 'statuses', 'status'));
  const q = asTrimmedString(readValue(filters, 'q'));

  if (warehouse && !warehouseMap.has(warehouse)) {
    throw new WarehouseAssetAuditError('The requested warehouse is not available.', 'INVALID_FILTER', 400);
  }
  if (widthRaw !== null && widthRaw !== undefined && widthRaw !== '' && (width === null || width <= 0)) {
    throw new WarehouseAssetAuditError('The requested width is invalid.', 'INVALID_FILTER', 400);
  }
  if (
    ownerCompanyId &&
    ownerCompanyId !== UNASSIGNED_OWNER_FILTER &&
    !rows.some((row) => row.ownerCompanyId === ownerCompanyId)
  ) {
    throw new WarehouseAssetAuditError('The requested owner is not available.', 'INVALID_FILTER', 400);
  }

  return { warehouse, ownerCompanyId, manufacturer, filmName, width, statuses, q };
}

function rowMatchesFilters(row, filters) {
  if (filters.warehouse && row.warehouse !== filters.warehouse) return false;
  if (filters.ownerCompanyId === UNASSIGNED_OWNER_FILTER && row.ownerCompanyId !== null) return false;
  if (
    filters.ownerCompanyId &&
    filters.ownerCompanyId !== UNASSIGNED_OWNER_FILTER &&
    row.ownerCompanyId !== filters.ownerCompanyId
  ) return false;
  if (filters.manufacturer && compareText(row.manufacturer, filters.manufacturer) !== 0) return false;
  if (filters.filmName && compareText(row.filmName, filters.filmName) !== 0) return false;
  if (filters.width !== null && row.widthIn !== filters.width) return false;
  if (!filters.statuses.includes(row.status)) return false;
  if (filters.q) {
    const search = filters.q.toLowerCase();
    const haystack = [
      row.boxId,
      row.ownerCompanyLabel,
      row.warehouse,
      row.manufacturer,
      row.filmName,
      row.statusLabel,
    ].join(' ').toLowerCase();
    if (!haystack.includes(search)) return false;
  }
  return true;
}

function buildFilterOptions(rows, warehouseMap) {
  const ownerOptionsByValue = new Map([
    [UNASSIGNED_OWNER_FILTER, {
      value: UNASSIGNED_OWNER_FILTER,
      label: 'Unassigned',
    }],
  ]);
  for (const row of rows) {
    const value = row.ownerCompanyId || UNASSIGNED_OWNER_FILTER;
    ownerOptionsByValue.set(value, {
      value,
      label: row.ownerCompanyLabel,
    });
  }
  return {
    warehouses: uniqueSorted(rows.map((row) => row.warehouse)).map((code) => ({
      value: code,
      label: warehouseMap.get(code)?.label || code,
    })),
    owners: Array.from(ownerOptionsByValue.values()).sort((left, right) => compareText(left.label, right.label)),
    manufacturers: uniqueSorted(rows.map((row) => row.manufacturer)),
    filmNames: uniqueSorted(rows.map((row) => row.filmName)),
    widths: uniqueSorted(rows.map((row) => row.widthIn), (left, right) => left - right),
    statuses: OPERATIONAL_BOX_STATUSES.map((value) => ({ value, label: STATUS_LABELS[value] })),
  };
}

function buildAppliedFilterLabels(filters, options) {
  return {
    warehouse: options.warehouses.find((entry) => entry.value === filters.warehouse)?.label || 'All Warehouses',
    owner:
      options.owners.find((entry) => entry.value === filters.ownerCompanyId)?.label || 'All Owners',
    manufacturer: filters.manufacturer || 'All Manufacturers',
    filmName: filters.filmName || 'All Films',
    width: filters.width === null ? 'All Widths' : `${filters.width}\"`,
    statuses: filters.statuses.map((status) => STATUS_LABELS[status]),
    search: filters.q || 'None',
  };
}

function buildWarehouseAssetAuditReport({
  expectedOrgId,
  organizationName,
  generatedAt,
  generatedBy,
  boxes,
  owners,
  warehouses,
  pendingTransfers,
  allocations,
  checkoutContext,
  filters = {},
}) {
  const orgId = asTrimmedString(expectedOrgId);
  if (!orgId || !asTrimmedString(organizationName)) {
    throw new WarehouseAssetAuditError('Organization report metadata is unavailable.');
  }
  const warehouseMap = buildWarehouseMap(warehouses, orgId);
  const ownerMap = buildOwnerMap(owners, orgId);
  const transfersByBox = buildPendingTransfersByBox(pendingTransfers, orgId);
  const allocationsByBox = buildAllocationsByBox(allocations, orgId);
  const checkedOutContextByBox = buildCheckedOutContextByBox({
    expectedOrgId: orgId,
    boxes,
    checkoutContext,
    today: asTrimmedString(generatedAt).slice(0, 10) || undefined,
  });
  const boxRecordIds = new Set();
  const boxIds = new Set();
  const operationalRows = [];

  for (const box of Array.isArray(boxes) ? boxes : []) {
    assertSameOrg(box, orgId, 'Box');
    const boxRecordId = asTrimmedString(readValue(box, 'id', 'boxRecordId', 'box_record_id'));
    const boxId = normalizeUpper(readValue(box, 'boxId', 'box_id'));
    const status = normalizeUpper(readValue(box, 'status'));
    if (!boxRecordId || !boxId) {
      throw new WarehouseAssetAuditError('A box identity is incomplete.');
    }
    if (boxRecordIds.has(boxRecordId)) {
      throw new WarehouseAssetAuditError('A canonical box identity is duplicated.');
    }
    if (boxIds.has(boxId)) {
      throw new WarehouseAssetAuditError('A business box identity is duplicated.');
    }
    boxRecordIds.add(boxRecordId);
    boxIds.add(boxId);
    const boxTransfers = transfersByBox.get(boxRecordId) || [];

    if (!OPERATIONAL_BOX_STATUSES.includes(status)) {
      if (boxTransfers.length) {
        throw new WarehouseAssetAuditError('A pending transfer conflicts with box status.');
      }
      continue;
    }

    const owner = resolveOwner(box, ownerMap);
    const custody = resolveCustody(box, boxTransfers, warehouseMap);
    const boxAllocations = allocationsByBox.get(boxId) || [];
    const onHandLf = resolvePhysicalFeet(box, boxAllocations);
    const widthIn = numberOrNull(readValue(box, 'widthIn', 'width_in'));
    if (widthIn === null || widthIn <= 0) {
      throw new WarehouseAssetAuditError('A box width is missing or invalid.');
    }
    const manufacturer = asTrimmedString(readValue(box, 'manufacturer'));
    const filmName = asTrimmedString(readValue(box, 'filmName', 'film_name'));
    if (!manufacturer || !filmName) {
      throw new WarehouseAssetAuditError('A box film identity is incomplete.');
    }
    const cost = resolveCost(box, onHandLf);
    const checkedOutContext =
      status === 'CHECKED_OUT' ? checkedOutContextByBox.get(boxRecordId) : null;
    if (status === 'CHECKED_OUT' && !checkedOutContext) {
      failCheckoutContextIntegrity();
    }
    operationalRows.push({
      boxId,
      ...owner,
      ...custody,
      manufacturer,
      filmName,
      widthIn,
      status,
      checkedOutJobNumber: checkedOutContext?.checkedOutJobNumber || null,
      checkedOutCrewLeaderName: checkedOutContext?.checkedOutCrewLeaderName || null,
      onHandLf,
      costBasis: cost.costBasis,
      onHandAssetCostCents: cost.onHandAssetCostCents,
      _exactAssetCost: cost.exactAssetCost,
    });
  }

  for (const boxRecordId of transfersByBox.keys()) {
    if (!boxRecordIds.has(boxRecordId)) {
      throw new WarehouseAssetAuditError('A pending transfer has a dangling box reference.');
    }
  }
  for (const boxId of allocationsByBox.keys()) {
    if (!boxIds.has(boxId)) {
      throw new WarehouseAssetAuditError('An active allocation has a dangling box reference.');
    }
  }

  operationalRows.sort(compareRows);
  const filterOptions = buildFilterOptions(operationalRows, warehouseMap);
  const appliedFilters = normalizeFilters(filters, operationalRows, warehouseMap);
  const matchingRows = operationalRows.filter((row) => rowMatchesFilters(row, appliedFilters));
  let exactKnownCost = rational(0n);
  let missingCostCount = 0;
  let totalOnHandLf = 0;
  for (const row of matchingRows) {
    totalOnHandLf += row.onHandLf;
    if (row._exactAssetCost) {
      exactKnownCost = addRationals(exactKnownCost, row._exactAssetCost);
    } else {
      missingCostCount += 1;
    }
  }

  return {
    snapshotVersion: 2,
    metadata: {
      organizationName: asTrimmedString(organizationName),
      generatedAt: asTrimmedString(generatedAt) || new Date().toISOString(),
      generatedBy: asTrimmedString(generatedBy) || 'Authenticated user',
    },
    appliedFilters,
    appliedFilterLabels: buildAppliedFilterLabels(appliedFilters, filterOptions),
    filterOptions,
    rows: matchingRows.map(({ _exactAssetCost, ...row }) => row),
    totals: {
      matchingBoxes: matchingRows.length,
      totalOnHandLf,
      totalKnownOnHandAssetCostCents: rationalToCents(exactKnownCost),
      boxesMissingCostBasis: missingCostCount,
    },
  };
}

export {
  CHECKOUT_CONTEXT_INTEGRITY_CODE as WAREHOUSE_ASSET_AUDIT_CHECKOUT_CONTEXT_INTEGRITY_CODE,
  COST_BASIS_CATEGORIES,
  OPERATIONAL_BOX_STATUSES,
  STATUS_LABELS as WAREHOUSE_ASSET_AUDIT_STATUS_LABELS,
  UNASSIGNED_OWNER_FILTER,
  WarehouseAssetAuditError,
  buildWarehouseAssetAuditReport,
  derivePhysicalFeetFromWeight,
  rationalToCents,
};

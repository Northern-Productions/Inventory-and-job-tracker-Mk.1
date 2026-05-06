// Purpose: DEV-only read audit for caulk requirement fallback coverage candidates.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from 'pg';

import { listBoxesByIds } from '../src/app/repositories/boxesRepository.mjs';
import {
  listAllocationsByJob,
  listFilmOrdersByJob,
} from '../src/app/repositories/inventoryRecordsRepository.mjs';
import {
  findJobByNumber,
  listCaulkJobAllocationsByJob,
  listJobRequirementsByJob,
} from '../src/app/repositories/jobsRepository.mjs';
import { buildPublicCaulkRequirementEntries } from '../src/app/services/runtime/runtimeAllocationCoverage.mjs';
import { deriveInStockReadinessStatus } from '../src/app/services/runtime/runtimeJobSummaries.mjs';

const DEV_PROJECT_REF = 'uxiltcpbhthhinonttrc';
const PROD_PROJECT_REF = 'tiwpulgvxtwlmqdnyuzd';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BACKEND_DIR = path.resolve(__dirname, '..');

function asText(value) {
  return String(value ?? '').trim();
}

function integerOrZero(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.max(0, Math.floor(numeric));
}

function normalizeJobNumberKey(value) {
  return asText(value).toUpperCase();
}

function normalizeId(value) {
  return asText(value);
}

function compareText(left, right) {
  return asText(left).localeCompare(asText(right), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

function isCancelledStatus(value) {
  return asText(value).toUpperCase() === 'CANCELLED';
}

function getRequirementId(requirement) {
  return normalizeId(requirement?.requirementId || requirement?.id);
}

function getAllocationId(allocation, index = 0) {
  return asText(allocation?.caulkAllocationId || allocation?.allocationId || allocation?.id || `allocation-${index}`);
}

function getOutstandingCheckoutTubes(allocation) {
  const storedOutstanding = integerOrZero(allocation?.outstandingCheckoutTubes);
  if (storedOutstanding > 0) {
    return storedOutstanding;
  }

  return Math.max(
    0,
    integerOrZero(allocation?.checkedOutTubesTotal) -
      integerOrZero(allocation?.returnedUnusedTubesTotal) -
      integerOrZero(allocation?.usedTubesTotal)
  );
}

function getCaulkAllocationCoverageTubes(allocation) {
  const allocatedTubes = integerOrZero(allocation?.allocatedTubes);
  if (allocatedTubes <= 0 || isCancelledStatus(allocation?.status)) {
    return 0;
  }

  const committedTubes =
    integerOrZero(allocation?.reservedTubesRemaining) +
    getOutstandingCheckoutTubes(allocation) +
    integerOrZero(allocation?.usedTubesTotal);

  return Math.min(allocatedTubes, Math.max(0, committedTubes));
}

function productLabel(entry) {
  return [entry?.manufacturer, entry?.productName, entry?.productCode]
    .map(asText)
    .filter(Boolean)
    .join(' ');
}

function allocationMatchesJob(allocation, jobNumber) {
  const expectedJobNumber = normalizeJobNumberKey(jobNumber);
  return !expectedJobNumber || normalizeJobNumberKey(allocation?.jobNumber) === expectedJobNumber;
}

function allocationWarehouseMatchesJob(allocation, jobWarehouse) {
  const expectedWarehouse = asText(jobWarehouse).toUpperCase();
  const allocationWarehouse = asText(allocation?.warehouse).toUpperCase();
  return !expectedWarehouse || !allocationWarehouse || allocationWarehouse === expectedWarehouse;
}

function compareCaulkRequirements(left, right) {
  const leftOrder = Number.isFinite(left?._inputOrder) ? left._inputOrder : 0;
  const rightOrder = Number.isFinite(right?._inputOrder) ? right._inputOrder : 0;
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }

  return compareText(getRequirementId(left), getRequirementId(right));
}

function compareCaulkAllocations(left, right) {
  const createdCompare = compareText(left?.createdAt, right?.createdAt);
  if (createdCompare !== 0) {
    return createdCompare;
  }

  return compareText(getAllocationId(left), getAllocationId(right));
}

function addCoverage(coverageByRequirementId, requirementId, tubes) {
  const normalizedId = normalizeId(requirementId);
  if (!normalizedId) {
    return;
  }

  coverageByRequirementId[normalizedId] =
    integerOrZero(coverageByRequirementId[normalizedId]) + integerOrZero(tubes);
}

function buildStrictCommittedCoverage(caulkRequirements, caulkAllocations, options = {}) {
  const coverageByRequirementId = {};
  const requirementById = {};
  const requirements = Array.isArray(caulkRequirements) ? caulkRequirements : [];
  const jobNumber = options.jobNumber || '';

  for (let index = 0; index < requirements.length; index += 1) {
    const requirement = requirements[index];
    const requirementId = getRequirementId(requirement);
    if (!requirementId) {
      continue;
    }

    requirementById[requirementId] = requirement;
  }

  const allocations = Array.isArray(caulkAllocations) ? caulkAllocations : [];
  for (let index = 0; index < allocations.length; index += 1) {
    const allocation = allocations[index];
    const requirementId = normalizeId(allocation?.requirementId);
    const requirement = requirementById[requirementId];
    if (!requirement || !allocationMatchesJob(allocation, jobNumber)) {
      continue;
    }

    if (normalizeId(allocation?.productId) !== normalizeId(requirement?.productId)) {
      continue;
    }

    addCoverage(coverageByRequirementId, requirementId, getCaulkAllocationCoverageTubes(allocation));
  }

  return coverageByRequirementId;
}

function buildRequirementRows(caulkRequirements, coverageByRequirementId) {
  return (Array.isArray(caulkRequirements) ? caulkRequirements : []).map((requirement) => {
    const requirementId = getRequirementId(requirement);
    const requiredTubes = integerOrZero(requirement?.requiredTubes);
    const allocatedTubes = Math.min(requiredTubes, integerOrZero(coverageByRequirementId[requirementId]));
    return {
      requirementId,
      jobNumber: asText(requirement?.jobNumber),
      productId: normalizeId(requirement?.productId),
      manufacturerId: normalizeId(requirement?.manufacturerId),
      manufacturer: asText(requirement?.manufacturer),
      productName: asText(requirement?.productName),
      productCode: asText(requirement?.productCode),
      tubesPerCase: integerOrZero(requirement?.tubesPerCase),
      requiredTubes,
      allocatedTubes,
      remainingTubes: Math.max(0, requiredTubes - allocatedTubes),
      notes: asText(requirement?.notes),
      updatedAt: asText(requirement?.updatedAt),
    };
  });
}

function buildSyntheticCaulkAllocationsFromCoverage(caulkRequirements, coverageByRequirementId, jobNumber) {
  return (Array.isArray(caulkRequirements) ? caulkRequirements : [])
    .map((requirement) => {
      const requirementId = getRequirementId(requirement);
      const allocatedTubes = integerOrZero(coverageByRequirementId[requirementId]);
      if (!requirementId || allocatedTubes <= 0) {
        return null;
      }

      return {
        caulkAllocationId: `projected-${requirementId}`,
        requirementId,
        jobNumber: asText(requirement?.jobNumber) || asText(jobNumber),
        productId: normalizeId(requirement?.productId),
        allocatedTubes,
        reservedTubesRemaining: allocatedTubes,
        checkedOutTubesTotal: 0,
        returnedUnusedTubesTotal: 0,
        usedTubesTotal: 0,
        status: 'ACTIVE',
      };
    })
    .filter(Boolean);
}

function projectCaulkFallbackCoverage(caulkRequirements, caulkAllocations, options = {}) {
  const requirements = (Array.isArray(caulkRequirements) ? caulkRequirements : []).map((entry, index) => ({
    ...entry,
    _inputOrder: index,
  }));
  const allocations = Array.isArray(caulkAllocations) ? caulkAllocations : [];
  const jobNumber = options.jobNumber || '';
  const jobWarehouse = options.jobWarehouse || '';
  const coverageBeforeFallback = buildStrictCommittedCoverage(requirements, allocations, {
    jobNumber,
  });
  const projectedCoverage = { ...coverageBeforeFallback };
  const requirementsByProductId = {};
  const allocationImpacts = {};

  for (let index = 0; index < requirements.length; index += 1) {
    const requirement = requirements[index];
    const productId = normalizeId(requirement?.productId);
    if (!productId) {
      continue;
    }

    if (!requirementsByProductId[productId]) {
      requirementsByProductId[productId] = [];
    }
    requirementsByProductId[productId].push(requirement);
  }

  for (const productId of Object.keys(requirementsByProductId)) {
    requirementsByProductId[productId].sort(compareCaulkRequirements);
  }

  const fallbackAllocations = allocations
    .filter((allocation) => {
      if (normalizeId(allocation?.requirementId)) {
        return false;
      }
      if (asText(allocation?.status).toUpperCase() !== 'ACTIVE') {
        return false;
      }
      if (!allocationMatchesJob(allocation, jobNumber)) {
        return false;
      }
      if (!allocationWarehouseMatchesJob(allocation, jobWarehouse)) {
        return false;
      }
      return getCaulkAllocationCoverageTubes(allocation) > 0;
    })
    .sort(compareCaulkAllocations);

  for (let index = 0; index < fallbackAllocations.length; index += 1) {
    const allocation = fallbackAllocations[index];
    const allocationId = getAllocationId(allocation, index);
    const productId = normalizeId(allocation?.productId);
    const matchingRequirements = requirementsByProductId[productId] || [];
    let remainingAllocationTubes = getCaulkAllocationCoverageTubes(allocation);

    for (let reqIndex = 0; reqIndex < matchingRequirements.length && remainingAllocationTubes > 0; reqIndex += 1) {
      const requirement = matchingRequirements[reqIndex];
      const requirementId = getRequirementId(requirement);
      const requiredTubes = integerOrZero(requirement?.requiredTubes);
      const coveredBefore = Math.min(requiredTubes, integerOrZero(projectedCoverage[requirementId]));
      const remainingRequirementTubes = Math.max(0, requiredTubes - coveredBefore);
      if (remainingRequirementTubes <= 0) {
        continue;
      }

      const appliedTubes = Math.min(remainingAllocationTubes, remainingRequirementTubes);
      addCoverage(projectedCoverage, requirementId, appliedTubes);
      remainingAllocationTubes -= appliedTubes;

      if (!allocationImpacts[allocationId]) {
        allocationImpacts[allocationId] = [];
      }
      allocationImpacts[allocationId].push({
        requirementId,
        productId,
        product: productLabel(requirement),
        requiredTubes,
        currentAllocatedTubes: coveredBefore,
        projectedAllocatedTubes: coveredBefore + appliedTubes,
        currentRemainingTubes: remainingRequirementTubes,
        projectedRemainingTubes: Math.max(0, remainingRequirementTubes - appliedTubes),
        appliedTubes,
      });
    }
  }

  return {
    coverageBeforeFallback,
    projectedCoverage,
    currentRequirementRows: buildRequirementRows(requirements, coverageBeforeFallback),
    projectedRequirementRows: buildRequirementRows(requirements, projectedCoverage),
    allocationImpacts,
  };
}

function parseArgs(argv) {
  const args = {
    json: false,
    orgId: '',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      args.json = true;
    } else if (arg === '--org-id') {
      args.orgId = asText(argv[index + 1]);
      index += 1;
    } else if (arg.startsWith('--org-id=')) {
      args.orgId = asText(arg.slice('--org-id='.length));
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function parseEnvValue(rawValue, filePath, lineNumber) {
  let value = rawValue.trim();
  if (!value) {
    return '';
  }

  const quote = value[0];
  if (quote === '"' || quote === "'") {
    if (value.length === 1 || value[value.length - 1] !== quote) {
      throw new Error(`${filePath}:${lineNumber} has a quoted env value that appears to span multiple lines.`);
    }
    value = value.slice(1, -1);
  }

  return value;
}

function readEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const values = {};
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith('#')) {
      continue;
    }

    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) {
      continue;
    }

    values[match[1]] = parseEnvValue(match[2], filePath, index + 1);
  }

  return values;
}

function loadBackendEnv() {
  const envPaths = [
    path.join(BACKEND_DIR, '.env'),
    path.join(BACKEND_DIR, '.env.dev'),
  ];
  const sources = [];
  const values = {};

  for (const envPath of envPaths) {
    const sourceValues = readEnvFile(envPath);
    if (Object.keys(sourceValues).length > 0) {
      sources.push({ path: envPath, values: sourceValues });
      Object.assign(values, sourceValues);
    }
  }

  Object.assign(values, process.env);
  return { values, sources };
}

function parseUrl(value, fieldName) {
  const text = asText(value);
  if (!text) {
    return null;
  }

  try {
    return new URL(text);
  } catch {
    throw new Error(`${fieldName} is not a valid URL.`);
  }
}

function extractProjectRefFromUrl(value) {
  const url = parseUrl(value, 'Supabase URL');
  if (!url) {
    return '';
  }

  const directMatch = url.hostname.match(/^([a-z0-9]{20})\.supabase\.co$/i);
  if (directMatch) {
    return directMatch[1];
  }

  const dbMatch = url.hostname.match(/^db\.([a-z0-9]{20})\.supabase\.co$/i);
  if (dbMatch) {
    return dbMatch[1];
  }

  return '';
}

function validateDevDatabaseSelection(envValues) {
  const databaseUrlKey = asText(envValues.DEV_DATABASE_URL) ? 'DEV_DATABASE_URL' : 'DATABASE_URL';
  const databaseUrl = asText(envValues[databaseUrlKey] || envValues.SUPABASE_DB_URL);
  if (!databaseUrl) {
    throw new Error('DEV_DATABASE_URL or DATABASE_URL is required for the DEV caulk fallback audit.');
  }

  const parsedDatabaseUrl = parseUrl(databaseUrl, databaseUrlKey);
  if (!/^postgres(?:ql)?:$/i.test(parsedDatabaseUrl.protocol)) {
    throw new Error(`${databaseUrlKey} must use the postgres:// or postgresql:// protocol.`);
  }

  if (!parsedDatabaseUrl.hostname) {
    throw new Error(`${databaseUrlKey} is missing a database host.`);
  }

  if (!parsedDatabaseUrl.port) {
    throw new Error(`${databaseUrlKey} is missing an explicit database port.`);
  }

  if (!parsedDatabaseUrl.searchParams.has('sslmode')) {
    throw new Error(`${databaseUrlKey} must include sslmode for this DEV audit.`);
  }

  const projectUrlKey = asText(envValues.DEV_SUPABASE_URL) ? 'DEV_SUPABASE_URL' : 'SUPABASE_URL';
  const projectRef = extractProjectRefFromUrl(envValues[projectUrlKey]);
  const dbRef = extractProjectRefFromUrl(databaseUrl);
  const hostIncludesProdRef = parsedDatabaseUrl.hostname.includes(PROD_PROJECT_REF);
  const hostIncludesDevRef = parsedDatabaseUrl.hostname.includes(DEV_PROJECT_REF);

  if (hostIncludesProdRef || dbRef === PROD_PROJECT_REF || projectRef === PROD_PROJECT_REF) {
    throw new Error('Refusing to run: selected environment resolves to the PROD Supabase project.');
  }

  if (dbRef && dbRef !== DEV_PROJECT_REF) {
    throw new Error(`Refusing to run: ${databaseUrlKey} is not the DEV Supabase project.`);
  }

  if (projectRef && projectRef !== DEV_PROJECT_REF && !hostIncludesDevRef && dbRef !== DEV_PROJECT_REF) {
    throw new Error(`Refusing to run: ${projectUrlKey} is not the DEV Supabase project.`);
  }

  if (!hostIncludesDevRef && dbRef !== DEV_PROJECT_REF && projectRef !== DEV_PROJECT_REF) {
    throw new Error('Refusing to run: unable to prove selected database is the DEV Supabase project.');
  }

  return {
    databaseUrl,
    databaseUrlKey,
    projectUrlKey,
    databaseHost: parsedDatabaseUrl.hostname,
    databasePort: parsedDatabaseUrl.port,
    projectRef: projectRef || dbRef || DEV_PROJECT_REF,
  };
}

async function loadCandidateJobKeys(client, orgId = '') {
  const params = [];
  const orgFilter = orgId ? 'and a.org_id = $1::uuid' : '';
  if (orgId) {
    params.push(orgId);
  }

  const result = await client.query(
    `
      select distinct
        a.org_id::text as org_id,
        a.job_number
      from app.caulk_job_allocations a
      join app.jobs j
        on j.org_id = a.org_id
       and j.id = a.job_id
      where a.status = 'ACTIVE'
        and a.requirement_id is null
        and coalesce(a.allocated_tubes, 0) > 0
        ${orgFilter}
        and exists (
          select 1
          from app.job_caulk_requirements r
          where r.org_id = a.org_id
            and r.job_id = a.job_id
            and r.product_id = a.product_id
            and coalesce(r.required_tubes, 0) > 0
        )
      order by a.job_number asc
    `,
    params
  );

  return result.rows.map((row) => ({
    orgId: asText(row.org_id),
    jobNumber: asText(row.job_number),
  }));
}

async function listJobCaulkRequirementsForAudit(client, orgId, jobNumber) {
  const result = await client.query(
    `
      select
        r.id::text as requirement_id,
        j.job_number,
        r.product_id::text as product_id,
        p.manufacturer_id::text as manufacturer_id,
        m.name as manufacturer,
        p.name as product_name,
        p.code as product_code,
        p.tubes_per_case,
        r.required_tubes,
        r.notes,
        r.created_at,
        r.updated_at
      from app.job_caulk_requirements r
      join app.jobs j
        on j.id = r.job_id
       and j.org_id = r.org_id
      join app.caulk_products p
        on p.id = r.product_id
       and p.org_id = r.org_id
      join app.caulk_manufacturers m
        on m.id = p.manufacturer_id
       and m.org_id = p.org_id
      where r.org_id = $1::uuid
        and upper(trim(j.job_number)) = upper(trim($2))
      order by lower(m.name), lower(p.name), lower(p.code), r.created_at asc, r.id asc
    `,
    [orgId, jobNumber]
  );

  return result.rows.map((row) => ({
    requirementId: asText(row.requirement_id),
    jobNumber: asText(row.job_number),
    productId: asText(row.product_id),
    manufacturerId: asText(row.manufacturer_id),
    manufacturer: asText(row.manufacturer),
    productName: asText(row.product_name),
    productCode: asText(row.product_code),
    tubesPerCase: integerOrZero(row.tubes_per_case),
    requiredTubes: integerOrZero(row.required_tubes),
    notes: asText(row.notes),
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : '',
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : '',
  }));
}

async function loadJobAuditSnapshot(client, jobKey) {
  const job = await findJobByNumber(client, jobKey.orgId, jobKey.jobNumber);
  if (!job) {
    return null;
  }

  const requirements = await listJobRequirementsByJob(client, jobKey.orgId, jobKey.jobNumber);
  const allocations = await listAllocationsByJob(client, jobKey.orgId, jobKey.jobNumber);
  const filmOrders = await listFilmOrdersByJob(client, jobKey.orgId, jobKey.jobNumber);
  const caulkRequirements = await listJobCaulkRequirementsForAudit(client, jobKey.orgId, jobKey.jobNumber);
  const caulkAllocations = await listCaulkJobAllocationsByJob(client, jobKey.orgId, jobKey.jobNumber);

  const boxIds = Array.from(
    new Set(
      allocations
        .map((entry) => asText(entry?.boxId).toUpperCase())
        .filter(Boolean)
    )
  );
  const boxes = boxIds.length ? await listBoxesByIds(client, jobKey.orgId, boxIds) : [];

  return {
    job,
    requirements,
    allocations,
    filmOrders,
    caulkRequirements,
    caulkAllocations,
    boxes,
  };
}

function indexBoxesById(boxes) {
  const indexed = {};
  for (const box of Array.isArray(boxes) ? boxes : []) {
    const boxId = asText(box?.boxId).toUpperCase();
    if (!boxId) {
      continue;
    }
    indexed[boxId] = box;
    indexed[asText(box?.boxId)] = box;
  }
  return indexed;
}

function deriveStatus(snapshot, caulkAllocations) {
  return deriveInStockReadinessStatus({
    jobNumber: snapshot.job.jobNumber,
    lifecycleStatus: snapshot.job.lifecycleStatus,
    isLaborOnly: snapshot.job.isLaborOnly,
    requirements: snapshot.requirements,
    caulkRequirements: snapshot.caulkRequirements,
    allocations: snapshot.allocations,
    caulkAllocations,
    filmOrders: snapshot.filmOrders,
    allBoxes: snapshot.boxes,
    boxById: indexBoxesById(snapshot.boxes),
    jobWarehouse: snapshot.job.warehouse,
  });
}

function buildJobAuditReport(snapshot) {
  const projection = projectCaulkFallbackCoverage(snapshot.caulkRequirements, snapshot.caulkAllocations, {
    jobNumber: snapshot.job.jobNumber,
    jobWarehouse: snapshot.job.warehouse,
  });
  const currentStatus = deriveStatus(snapshot, snapshot.caulkAllocations);
  const projectedAllocations = buildSyntheticCaulkAllocationsFromCoverage(
    snapshot.caulkRequirements,
    projection.projectedCoverage,
    snapshot.job.jobNumber
  );
  const projectedStatus = deriveStatus(snapshot, projectedAllocations);
  const currentRowsFromRuntime = buildPublicCaulkRequirementEntries(
    snapshot.caulkRequirements,
    snapshot.caulkAllocations,
    { jobNumber: snapshot.job.jobNumber, jobWarehouse: snapshot.job.warehouse }
  );
  const affectedAllocations = [];

  for (const allocation of snapshot.caulkAllocations) {
    const allocationId = getAllocationId(allocation);
    const impacts = projection.allocationImpacts[allocationId] || [];
    if (!impacts.length) {
      continue;
    }

    affectedAllocations.push({
      caulkAllocationId: allocation.caulkAllocationId,
      product: productLabel(allocation),
      warehouse: asText(allocation.warehouse),
      allocatedTubes: integerOrZero(allocation.allocatedTubes),
      reservedTubesRemaining: integerOrZero(allocation.reservedTubesRemaining),
      coverageTubes: getCaulkAllocationCoverageTubes(allocation),
      createdAt: asText(allocation.createdAt),
      impacts,
    });
  }

  return {
    orgId: snapshot.job.orgId,
    jobNumber: snapshot.job.jobNumber,
    jobWarehouse: snapshot.job.warehouse,
    currentStatus,
    projectedStatus,
    affectedAllocations,
    currentCaulkRequirements: projection.currentRequirementRows,
    projectedCaulkRequirements: projection.projectedRequirementRows,
    runtimeCurrentCaulkRequirements: currentRowsFromRuntime,
  };
}

async function runAudit(client, options = {}) {
  const jobKeys = await loadCandidateJobKeys(client, options.orgId);
  const reports = [];

  for (const jobKey of jobKeys) {
    const snapshot = await loadJobAuditSnapshot(client, jobKey);
    if (!snapshot) {
      continue;
    }

    const report = buildJobAuditReport(snapshot);
    if (report.affectedAllocations.length > 0) {
      reports.push(report);
    }
  }

  return reports;
}

function summarizeReports(reports) {
  let affectedAllocations = 0;
  let fallbackAppliedTubes = 0;
  let filmOrderToReadyJobs = 0;

  for (const report of reports) {
    for (const allocation of report.affectedAllocations) {
      affectedAllocations += 1;
      for (const impact of allocation.impacts) {
        fallbackAppliedTubes += integerOrZero(impact.appliedTubes);
      }
    }

    if (report.currentStatus === 'FILM_ORDER' && report.projectedStatus === 'READY') {
      filmOrderToReadyJobs += 1;
    }
  }

  return {
    affectedJobs: reports.length,
    affectedAllocations,
    fallbackAppliedTubes,
    filmOrderToReadyJobs,
  };
}

function redactEnvSelection(envSelection) {
  const { databaseUrl, ...safeSelection } = envSelection || {};
  void databaseUrl;
  return safeSelection;
}

function printTextReport(reports, envSelection) {
  const summary = summarizeReports(reports);
  console.log('DEV caulk fallback coverage audit');
  console.log(`Project ref: ${envSelection.projectRef}`);
  console.log(`Database host: ${envSelection.databaseHost}:${envSelection.databasePort}`);
  console.log(`Database URL key: ${envSelection.databaseUrlKey}`);
  console.log('');
  console.log(
    `Summary: ${summary.affectedJobs} affected job(s), ${summary.affectedAllocations} active unbound allocation(s), ` +
      `${summary.fallbackAppliedTubes} projected fallback tube(s), ${summary.filmOrderToReadyJobs} FILM_ORDER -> READY job(s).`
  );

  if (reports.length === 0) {
    console.log('');
    console.log('No active unbound caulk allocations would newly satisfy same-product requirements in DEV.');
    return;
  }

  for (const report of reports) {
    console.log('');
    console.log(
      `Job ${report.jobNumber} (${report.jobWarehouse || 'no warehouse'}): ${report.currentStatus} -> ${report.projectedStatus}`
    );
    for (const allocation of report.affectedAllocations) {
      console.log(
        `  Allocation ${allocation.caulkAllocationId}: ${allocation.product} @ ${allocation.warehouse || 'no warehouse'}; ` +
          `allocated ${allocation.allocatedTubes}, reserved ${allocation.reservedTubesRemaining}, projected coverage ${allocation.coverageTubes}`
      );
      for (const impact of allocation.impacts) {
        console.log(
          `    Requirement ${impact.requirementId}: ${impact.product}; ` +
            `applies ${impact.appliedTubes}, remaining ${impact.currentRemainingTubes} -> ${impact.projectedRemainingTubes}`
        );
      }
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: npm --prefix backend run audit:caulk:fallback:dev -- [--json] [--org-id <uuid>]');
    return;
  }

  const { values } = loadBackendEnv();
  const envSelection = validateDevDatabaseSelection(values);
  const client = new Client({
    connectionString: envSelection.databaseUrl,
    ssl: /localhost|127\.0\.0\.1/i.test(envSelection.databaseUrl)
      ? undefined
      : { rejectUnauthorized: false },
  });

  await client.connect();
  try {
    await client.query('begin read only');
    await client.query(`set local statement_timeout = '60s'`);
    const reports = await runAudit(client, { orgId: args.orgId });
    await client.query('rollback');

    if (args.json) {
      console.log(JSON.stringify({ env: redactEnvSelection(envSelection), summary: summarizeReports(reports), reports }, null, 2));
    } else {
      printTextReport(reports, envSelection);
    }
  } catch (error) {
    try {
      await client.query('rollback');
    } catch {
      // Ignore rollback errors; the original audit failure is more useful.
    }
    throw error;
  } finally {
    await client.end();
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error?.message || error);
    process.exitCode = 1;
  });
}

export {
  getCaulkAllocationCoverageTubes,
  projectCaulkFallbackCoverage,
  buildSyntheticCaulkAllocationsFromCoverage,
  summarizeReports,
};

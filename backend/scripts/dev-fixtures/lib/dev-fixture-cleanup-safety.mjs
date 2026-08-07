import { asText, isUuidLike, normalizeFixtureTag } from './dev-fixture-guard.mjs';
import {
  V3_ID_GROUPS,
  normalizeDealerTableIntegrity,
  normalizeFixtureDealer,
  normalizeIdList,
  normalizeV3Manifest,
} from './dev-fixture-manifest.mjs';

const PENDING_TRANSFER_INITIAL_BUDGET = Object.freeze({
  manufacturers: 1,
  products: 1,
  caulkStock: 2,
  caulkRequirements: 1,
  caulkAllocations: 1,
  pendingCaulkTransfers: 1,
  dealers: 1,
  filmCatalog: 1,
  boxes: 1,
  jobs: 1,
  phases: 1,
  filmRequirements: 1,
  filmAllocations: 0,
  receiveTransactions: 2,
  jobAllocateTransactions: 1,
  transferOutTransactions: 1,
  addBoxAudit: 1,
  setStatusAudit: 0,
  unexpectedAudit: 0,
  caulkCheckouts: 0,
  plannerSuppressions: 0,
  rollHistory: 0,
  aliases: 0,
  boxTransfers: 0,
  filmOrders: 0,
  filmOrderLinks: 0,
  filmOrderEvents: 0,
});

const PENDING_TRANSFER_STAGE_BUDGETS = Object.freeze({
  initial: PENDING_TRANSFER_INITIAL_BUDGET,
  allocation_applied: Object.freeze({
    ...PENDING_TRANSFER_INITIAL_BUDGET,
    filmAllocations: 1,
  }),
  mixed_checkout_complete: Object.freeze({
    ...PENDING_TRANSFER_INITIAL_BUDGET,
    filmAllocations: 1,
    setStatusAudit: 1,
  }),
});

const PENDING_TRANSFER_ID_CARDINALITIES = Object.freeze({
  manufacturerIds: 1,
  productIds: 1,
  caulkStockIds: 2,
  caulkTransactionIds: 4,
  caulkTransferRowIds: 1,
  caulkTransferIds: 1,
  caulkRequirementIds: 1,
  caulkAllocationRowIds: 1,
  caulkAllocationIds: 1,
  dealerIds: 1,
  filmCatalogIds: 1,
  boxRecordIds: 1,
  boxIds: 1,
  jobIds: 1,
  jobNumbers: 1,
  phaseIds: 1,
  requirementIds: 1,
});

function hasFixtureDealer(value = {}) {
  return Boolean(asText(value.id) || asText(value.code) || asText(value.name));
}

function mergeFixtureDealer(manifestDealer = {}, discoveredDealer = {}) {
  const candidates = [manifestDealer, discoveredDealer]
    .map(normalizeFixtureDealer)
    .filter(hasFixtureDealer);
  if (candidates.length === 0) {
    return normalizeFixtureDealer();
  }
  const [first, ...rest] = candidates;
  if (rest.some((candidate) => (
    candidate.id !== first.id || candidate.code !== first.code || candidate.name !== first.name
  ))) {
    throw new Error('Fixture dealer manifest and discovered identity do not match exactly.');
  }
  return first;
}

function normalizeFixtureIdentity({ tag, manifest = {}, discovered = {} } = {}) {
  const normalizedTag = normalizeFixtureTag(tag || manifest.tag || discovered.tag);
  const manifestIds = manifest?.ids || {};
  const discoveredIds = discovered?.ids || {};
  return {
    tag: normalizedTag,
    fixtureDealer: mergeFixtureDealer(manifest?.fixtureDealer, discovered?.fixtureDealer),
    integrity: {
      dealerTableBefore: normalizeDealerTableIntegrity(manifest?.integrity?.dealerTableBefore),
    },
    ids: {
      jobIds: normalizeIdList([...(manifestIds.jobIds || []), ...(discoveredIds.jobIds || [])]).filter(isUuidLike),
      jobNumbers: normalizeIdList([...(manifestIds.jobNumbers || []), ...(discoveredIds.jobNumbers || [])]),
      phaseIds: normalizeIdList([...(manifestIds.phaseIds || []), ...(discoveredIds.phaseIds || [])]).filter(isUuidLike),
      requirementIds: normalizeIdList([...(manifestIds.requirementIds || []), ...(discoveredIds.requirementIds || [])]).filter(isUuidLike),
      allocationIds: normalizeIdList([...(manifestIds.allocationIds || []), ...(discoveredIds.allocationIds || [])]),
      boxIds: normalizeIdList([...(manifestIds.boxIds || []), ...(discoveredIds.boxIds || [])]),
      filmOrderIds: normalizeIdList([...(manifestIds.filmOrderIds || []), ...(discoveredIds.filmOrderIds || [])]),
    },
  };
}

function assertSafeFixtureIdentity(identity) {
  const tag = normalizeFixtureTag(identity?.tag);
  const idGroups = identity?.ids || {};
  const allIds = Object.values(idGroups).flat().map(asText).filter(Boolean);
  if (!tag) {
    throw new Error('Cleanup requires an exact fixture tag.');
  }
  if (!tag.startsWith('CODEX_DEV_FIXTURE_')) {
    throw new Error('Cleanup tag must be a CODEX_DEV_FIXTURE tag.');
  }
  if (allIds.some((value) => /[%*]/.test(value))) {
    throw new Error('Cleanup IDs must not contain wildcard characters.');
  }
  const dealer = normalizeFixtureDealer(identity?.fixtureDealer);
  if (hasFixtureDealer(dealer)) {
    const normalizedName = dealer.name.trim().replace(/\s+/g, ' ').toLowerCase();
    if (!isUuidLike(dealer.id) || !dealer.code || !dealer.name) {
      throw new Error('Tagged dealer cleanup requires an exact id, code, and name.');
    }
    if (!dealer.name.includes(tag) || !dealer.code.includes(tag.toLowerCase())) {
      throw new Error('Tagged dealer cleanup identity must contain the exact fixture tag.');
    }
    if (dealer.code !== normalizedName || /[%*]/.test(`${dealer.code}${dealer.name}`)) {
      throw new Error('Tagged dealer cleanup identity is not canonical and exact.');
    }
  }
  return true;
}

function dealerTableIntegrityMatches(before = {}, after = {}) {
  const normalizedBefore = normalizeDealerTableIntegrity(before);
  const normalizedAfter = normalizeDealerTableIntegrity(after);
  return Boolean(
    normalizedBefore.rowCount !== null &&
    normalizedBefore.fingerprint &&
    normalizedBefore.rowCount === normalizedAfter.rowCount &&
    normalizedBefore.fingerprint === normalizedAfter.fingerprint
  );
}

function assertPendingTransferManifestIdBudget(manifest) {
  const normalized = normalizeV3Manifest(manifest);
  const runtime = normalized.state.runtime;
  const expectedBudget = PENDING_TRANSFER_STAGE_BUDGETS[
    runtime === 'not_started' ? 'initial' : runtime
  ];
  if (!expectedBudget || JSON.stringify(normalized.budgets) !== JSON.stringify(expectedBudget)) {
    throw new Error('Pending-transfer fixture manifest row budget is invalid.');
  }
  const expectedAllocationIds = runtime === 'initial' || runtime === 'not_started' ? 0 : 1;
  const expectedAuditIds = runtime === 'mixed_checkout_complete' ? 2 : 1;
  for (const group of V3_ID_GROUPS) {
    const expected = group === 'allocationIds'
      ? expectedAllocationIds
      : group === 'auditLogIds'
        ? expectedAuditIds
        : PENDING_TRANSFER_ID_CARDINALITIES[group];
    if (!Number.isInteger(expected) || normalized.ids[group].length !== expected) {
      throw new Error('Pending-transfer fixture manifest identifier budget is invalid.');
    }
  }
  if (normalized.fixtureDealer.id !== normalized.ids.dealerIds[0]) {
    throw new Error('Pending-transfer fixture dealer identity is invalid.');
  }
  return true;
}

function assertPendingTransferStageBudget(counts = {}, runtimeStage = '') {
  const expected = PENDING_TRANSFER_STAGE_BUDGETS[asText(runtimeStage)];
  if (!expected) {
    throw new Error('Pending-transfer fixture runtime stage is invalid.');
  }
  const actualKeys = Object.keys(counts).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error('Pending-transfer fixture count categories are invalid.');
  }
  for (const key of expectedKeys) {
    if (!Number.isSafeInteger(counts[key]) || counts[key] !== expected[key]) {
      throw new Error('Pending-transfer fixture exact row budget did not match.');
    }
  }
  return true;
}

function normalizePendingTransferCleanupIdentity(manifest) {
  const normalized = normalizeV3Manifest(manifest);
  assertPendingTransferManifestIdBudget(normalized);
  if (
    normalized.state.setup !== 'ready' ||
    normalized.state.cleanup !== 'not_started' ||
    !['initial', 'allocation_applied', 'mixed_checkout_complete'].includes(
      normalized.state.runtime
    )
  ) {
    throw new Error('Pending-transfer fixture is not in an ordinary cleanup state.');
  }
  return {
    tag: normalized.tag,
    orgId: normalized.orgId,
    runtimeStage: normalized.state.runtime,
    fixtureDealer: normalized.fixtureDealer,
    ids: Object.fromEntries(
      V3_ID_GROUPS.map((group) => [group, [...normalized.ids[group]]])
    ),
  };
}

function assertNoDiscoveredCleanupTargets(identity, discovered = null) {
  if (!discovered) {
    return true;
  }
  const discoveredIds = discovered.ids || {};
  for (const group of V3_ID_GROUPS) {
    const values = normalizeIdList(discoveredIds[group]);
    if (values.some((entry) => !identity.ids[group].includes(entry))) {
      throw new Error('Cleanup discovery found an identity outside the private manifest.');
    }
  }
  return true;
}

export {
  PENDING_TRANSFER_INITIAL_BUDGET,
  PENDING_TRANSFER_STAGE_BUDGETS,
  assertSafeFixtureIdentity,
  assertNoDiscoveredCleanupTargets,
  assertPendingTransferManifestIdBudget,
  assertPendingTransferStageBudget,
  dealerTableIntegrityMatches,
  normalizeFixtureIdentity,
  normalizePendingTransferCleanupIdentity,
};

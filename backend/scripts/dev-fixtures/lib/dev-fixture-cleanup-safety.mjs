import { asText, isUuidLike, normalizeFixtureTag } from './dev-fixture-guard.mjs';
import { normalizeIdList } from './dev-fixture-manifest.mjs';

function normalizeFixtureIdentity({ tag, manifest = {}, discovered = {} } = {}) {
  const normalizedTag = normalizeFixtureTag(tag || manifest.tag || discovered.tag);
  const manifestIds = manifest?.ids || {};
  const discoveredIds = discovered?.ids || {};
  return {
    tag: normalizedTag,
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
  return true;
}

export {
  assertSafeFixtureIdentity,
  normalizeFixtureIdentity,
};

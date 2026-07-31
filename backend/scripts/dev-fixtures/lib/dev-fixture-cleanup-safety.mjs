import { asText, isUuidLike, normalizeFixtureTag } from './dev-fixture-guard.mjs';
import {
  normalizeDealerTableIntegrity,
  normalizeFixtureDealer,
  normalizeIdList,
} from './dev-fixture-manifest.mjs';

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

export {
  assertSafeFixtureIdentity,
  dealerTableIntegrityMatches,
  normalizeFixtureIdentity,
};

import fs from 'node:fs';
import path from 'node:path';
import {
  assertIgnoredPath,
  assertNotRunlogPath,
  asText,
  normalizeFixtureTag,
} from './dev-fixture-guard.mjs';

function sanitizeFileTag(tag) {
  return normalizeFixtureTag(tag).toLowerCase();
}

function getManifestPath(config, tag) {
  const manifestPath = path.resolve(config.manifestDir, `${sanitizeFileTag(tag)}.json`);
  assertNotRunlogPath(manifestPath);
  assertIgnoredPath(manifestPath);
  return manifestPath;
}

function normalizeIdList(values = []) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => asText(value))
        .filter(Boolean)
    )
  ).sort();
}

function normalizeManifest(manifest = {}) {
  const tag = normalizeFixtureTag(manifest.tag);
  return {
    version: 1,
    tag,
    scenario: asText(manifest.scenario),
    createdAt: asText(manifest.createdAt),
    updatedAt: asText(manifest.updatedAt || new Date().toISOString()),
    cleanedAt: asText(manifest.cleanedAt),
    projectRef: asText(manifest.projectRef),
    orgId: asText(manifest.orgId),
    ids: {
      jobIds: normalizeIdList(manifest.ids?.jobIds),
      jobNumbers: normalizeIdList(manifest.ids?.jobNumbers),
      phaseIds: normalizeIdList(manifest.ids?.phaseIds),
      requirementIds: normalizeIdList(manifest.ids?.requirementIds),
      allocationIds: normalizeIdList(manifest.ids?.allocationIds),
      boxIds: normalizeIdList(manifest.ids?.boxIds),
      filmOrderIds: normalizeIdList(manifest.ids?.filmOrderIds),
    },
    routes: {
      jobDetails: normalizeIdList(manifest.routes?.jobDetails),
      boxDetails: normalizeIdList(manifest.routes?.boxDetails),
      qrPayloads: normalizeIdList(manifest.routes?.qrPayloads),
    },
    summary: manifest.summary && typeof manifest.summary === 'object' ? manifest.summary : {},
    cleanup: manifest.cleanup && typeof manifest.cleanup === 'object' ? manifest.cleanup : {},
  };
}

function writeManifest(config, manifest) {
  const normalized = normalizeManifest(manifest);
  const manifestPath = getManifestPath(config, normalized.tag);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(normalized, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  return {
    manifest: normalized,
    manifestPath,
  };
}

function readManifest(config, tag) {
  const normalizedTag = normalizeFixtureTag(tag);
  const manifestPath = getManifestPath(config, normalizedTag);
  if (!fs.existsSync(manifestPath)) {
    return {
      manifest: null,
      manifestPath,
    };
  }
  return {
    manifest: normalizeManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8'))),
    manifestPath,
  };
}

export {
  getManifestPath,
  normalizeIdList,
  normalizeManifest,
  readManifest,
  writeManifest,
};

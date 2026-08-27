import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  decryptBaselineBytes,
  readWrappedBaselineDataKey
} from './encrypted-baseline.mjs';
import { verifyAuthenticatedManifest } from './manifest.mjs';
import {
  privateArtifactPath,
  verifyPrivateArtifactProtection,
  writePrivateBytesExclusive
} from './private-artifacts.mjs';
import { GOLDEN_BASELINE_ID } from './constants.mjs';

const RETAINED_KEY_MAGIC = Buffer.from('ESKEY001', 'ascii');

function categoricalError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function digest(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function readJsonPrivate(filePath) {
  verifyPrivateArtifactProtection(filePath);
  const bytes = fs.readFileSync(filePath);
  try {
    return JSON.parse(bytes.toString('utf8'));
  } finally {
    bytes.fill(0);
  }
}

function verifyComponent(manifest, name, filePath) {
  verifyPrivateArtifactProtection(filePath);
  const expected = manifest.components?.find((entry) => entry.name === name);
  const bytes = fs.readFileSync(filePath);
  try {
    if (!expected || expected.size !== bytes.length || expected.digest !== digest(bytes)) {
      throw categoricalError('RETAINED_GOLDEN_COMPONENT_MISMATCH');
    }
    return expected;
  } finally {
    bytes.fill(0);
  }
}

function materializeRetainedGolden({ retainedRoot, privateDirectory } = {}) {
  const root = path.resolve(String(retainedRoot || ''));
  const goldenDirectory = path.join(root, 'golden-x');
  const keyPath = path.join(root, 'external-keys', 'golden-x.keys');
  const manifestPath = path.join(goldenDirectory, 'golden-x.manifest.json');
  const wrappedKeyPath = path.join(goldenDirectory, 'golden-x.data-key.enc');
  const encryptedArchivePath = path.join(goldenDirectory, 'golden-x.pgdump.enc');
  for (const filePath of [keyPath, manifestPath, wrappedKeyPath, encryptedArchivePath]) {
    verifyPrivateArtifactProtection(filePath);
  }
  const keyBundle = fs.readFileSync(keyPath);
  let wrappingKey;
  let manifestKey;
  let dataKey;
  let encrypted;
  let plaintext;
  try {
    if (
      keyBundle.length !== 72 ||
      !keyBundle.subarray(0, RETAINED_KEY_MAGIC.length).equals(RETAINED_KEY_MAGIC)
    ) throw categoricalError('RETAINED_GOLDEN_KEY_BUNDLE_INVALID');
    wrappingKey = Buffer.from(keyBundle.subarray(8, 40));
    manifestKey = Buffer.from(keyBundle.subarray(40, 72));
    const manifest = readJsonPrivate(manifestPath);
    verifyAuthenticatedManifest(manifest, manifestKey);
    if (manifest?.baselineId !== GOLDEN_BASELINE_ID) {
      throw categoricalError('RETAINED_GOLDEN_IDENTITY_MISMATCH');
    }
    const wrappedComponent = verifyComponent(
      manifest,
      'postgres-data-key-wrapped',
      wrappedKeyPath
    );
    const encryptedComponent = verifyComponent(
      manifest,
      'postgres-logical-custom-encrypted',
      encryptedArchivePath
    );
    dataKey = readWrappedBaselineDataKey({ wrappingKey, artifactPath: wrappedKeyPath });
    encrypted = fs.readFileSync(encryptedArchivePath);
    plaintext = decryptBaselineBytes(encrypted, dataKey);
    const archivePath = privateArtifactPath(
      privateDirectory,
      `golden-source-${crypto.randomBytes(8).toString('hex')}.private.pgdump`
    );
    writePrivateBytesExclusive(archivePath, plaintext);
    return {
      archivePath,
      manifest,
      components: {
        wrappedKey: wrappedComponent,
        encryptedArchive: encryptedComponent,
        plaintext: {
          name: 'postgres-logical-custom-private-materialization',
          size: plaintext.length,
          digest: digest(plaintext)
        }
      }
    };
  } finally {
    keyBundle.fill(0);
    wrappingKey?.fill(0);
    manifestKey?.fill(0);
    dataKey?.fill(0);
    encrypted?.fill(0);
    plaintext?.fill(0);
  }
}

export { RETAINED_KEY_MAGIC, materializeRetainedGolden };

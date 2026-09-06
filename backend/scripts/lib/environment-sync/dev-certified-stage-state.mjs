import fs from 'node:fs';
import path from 'node:path';

import { canonicalSerialize } from '../readonly-diagnostics.mjs';
import {
  privateArtifactPath,
  verifyPrivateArtifactProtection,
  writePrivateJsonExclusive
} from './private-artifacts.mjs';
import { signPayload } from './dev-certified-state.mjs';

const STAGE_STATE_FORMAT = 'dev-certified-stage-state-v1';
const SAFE_STAGE = /^[A-Z][A-Z0-9_]{1,63}$/;

function categoricalError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function assertKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw categoricalError('DEV_REFRESH_STAGE_STATE_KEY_INVALID');
  }
}

function statePath(rootDirectory, stage) {
  if (!SAFE_STAGE.test(String(stage || ''))) {
    throw categoricalError('DEV_REFRESH_STAGE_STATE_NAME_INVALID');
  }
  return privateArtifactPath(path.resolve(rootDirectory), `stage-${stage.toLowerCase()}.private.json`);
}

function writeStageState({ rootDirectory, key, attemptId, stage, value } = {}) {
  assertKey(key);
  const payload = {
    format: STAGE_STATE_FORMAT,
    version: 1,
    attemptId: String(attemptId || ''),
    stage,
    value
  };
  const record = {
    payload,
    authentication: {
      algorithm: 'hmac-sha256-v1',
      digest: signPayload(payload, key)
    }
  };
  writePrivateJsonExclusive(statePath(rootDirectory, stage), record);
  return payload;
}

function readStageState({ rootDirectory, key, attemptId, stage } = {}) {
  assertKey(key);
  const filePath = statePath(rootDirectory, stage);
  verifyPrivateArtifactProtection(filePath);
  const bytes = fs.readFileSync(filePath);
  try {
    const record = JSON.parse(bytes.toString('utf8'));
    const payload = record?.payload;
    if (
      payload?.format !== STAGE_STATE_FORMAT ||
      payload?.version !== 1 ||
      payload?.attemptId !== attemptId ||
      payload?.stage !== stage ||
      record?.authentication?.algorithm !== 'hmac-sha256-v1' ||
      record.authentication.digest !== signPayload(payload, key)
    ) throw categoricalError('DEV_REFRESH_STAGE_STATE_INVALID');
    return payload.value;
  } finally {
    bytes.fill(0);
  }
}

function readOptionalStageState(options = {}) {
  const filePath = statePath(options.rootDirectory, options.stage);
  if (!fs.existsSync(filePath)) return null;
  return readStageState(options);
}

function assertImmutableStageState({ before, after } = {}) {
  if (canonicalSerialize(before) !== canonicalSerialize(after)) {
    throw categoricalError('DEV_REFRESH_STAGE_STATE_CHANGED');
  }
  return true;
}

export {
  STAGE_STATE_FORMAT,
  assertImmutableStageState,
  readOptionalStageState,
  readStageState,
  statePath,
  writeStageState
};

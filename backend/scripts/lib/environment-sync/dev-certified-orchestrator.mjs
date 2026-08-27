import { canonicalDigest } from '../readonly-diagnostics.mjs';
import {
  assertStageEvidence,
  verifyCertifiedRefreshContract
} from './dev-certified-contract.mjs';
import {
  INTERNAL_TRANSITIONS,
  appendState,
  freezeManifests,
  initializeJournal,
  publishAttemptMarker,
  publishDestructiveBoundary,
  publishRecoveryMarker,
  readJournal,
  restartDisposition
} from './dev-certified-state.mjs';
import {
  CANONICAL_APPLICATION_SOURCE_COMMIT,
  GOLDEN_BASELINE_ID,
  POST_GOLDEN_MIGRATIONS
} from './constants.mjs';

function categoricalError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function requireExecutor(executor) {
  if (!executor || typeof executor.run !== 'function') {
    throw categoricalError('DEV_REFRESH_EXECUTOR_INVALID');
  }
  return executor;
}

async function runStage(executor, stage, context) {
  const evidence = await executor.run(stage, Object.freeze({ ...context }));
  assertStageEvidence(evidence, { contract: context.contract, stage });
  return evidence;
}

function evidenceDigest(evidence) {
  return canonicalDigest(evidence);
}

async function notifyDurableTransition(callback, journal) {
  if (typeof callback === 'function') {
    await callback(Object.freeze({
      state: journal.current.state,
      sequence: journal.current.sequence,
      mutationCrossed: journal.current.mutationCrossed
    }));
  }
}

function requireY2Evidence(evidence) {
  if (
    !/^[a-z0-9][a-z0-9._-]{7,127}$/.test(String(evidence?.details?.y2RecoveryId || '')) ||
    evidence.details?.encrypted !== true ||
    evidence.details?.authenticated !== true ||
    evidence.details?.digestVerified !== true ||
    evidence.details?.restoreTested !== true ||
    evidence.details?.attemptBound !== true ||
    !Array.isArray(evidence.details?.frozenManifests) ||
    evidence.details.frozenManifests.length < 8
  ) throw categoricalError('DEV_REFRESH_Y2_EVIDENCE_INCOMPLETE');
  return evidence;
}

function appendRecoveryRequired(rootDirectory, key, category) {
  const journal = readJournal(rootDirectory, key);
  if (journal.current.state === 'RECOVERY_REQUIRED') return journal;
  if (!journal.boundary) throw categoricalError('DEV_REFRESH_RECOVERY_WITHOUT_BOUNDARY_REJECTED');
  return appendState(rootDirectory, key, 'RECOVERY_REQUIRED', { failureCategory: category });
}

async function runCertifiedDevRefresh({
  rootDirectory,
  key,
  contract,
  executor,
  afterDurableTransition
} = {}) {
  verifyCertifiedRefreshContract(contract);
  requireExecutor(executor);
  let journal = initializeJournal({
    rootDirectory,
    key,
    attemptId: contract.attemptId,
    contractDigest: contract.contractDigest
  });
  await notifyDurableTransition(afterDurableTransition, journal);
  const context = { rootDirectory: journal.paths.root, contract };
  let currentStage = 'PRECHECK';
  try {
    let evidence = await runStage(executor, 'PRECHECK', context);
    journal = appendState(rootDirectory, key, 'QUIET_WINDOW', { evidenceDigest: evidenceDigest(evidence) });
    await notifyDurableTransition(afterDurableTransition, journal);

    currentStage = 'QUIET_WINDOW';
    evidence = await runStage(executor, 'QUIET_WINDOW', context);
    journal = appendState(rootDirectory, key, 'Y2_CAPTURE', { evidenceDigest: evidenceDigest(evidence) });
    await notifyDurableTransition(afterDurableTransition, journal);

    currentStage = 'Y2_CAPTURE';
    evidence = await runStage(executor, 'Y2_CAPTURE', context);
    journal = appendState(rootDirectory, key, 'Y2_VALIDATED', { evidenceDigest: evidenceDigest(evidence) });
    await notifyDurableTransition(afterDurableTransition, journal);

    currentStage = 'Y2_VALIDATED';
    evidence = requireY2Evidence(await runStage(executor, 'Y2_VALIDATED', context));
    freezeManifests(rootDirectory, key, evidence.details.frozenManifests);
    journal = appendState(rootDirectory, key, 'MANIFESTS_FROZEN', { evidenceDigest: evidenceDigest(evidence) });
    await notifyDurableTransition(afterDurableTransition, journal);

    publishAttemptMarker(rootDirectory, key, {
      goldenBaselineId: GOLDEN_BASELINE_ID,
      y2RecoveryId: evidence.details.y2RecoveryId,
      canonicalMainCommit: CANONICAL_APPLICATION_SOURCE_COMMIT,
      toolingCommit: contract.candidate.toolingCommit,
      migrationVersions: POST_GOLDEN_MIGRATIONS.map((entry) => entry.version)
    });
    journal = appendState(rootDirectory, key, 'ATTEMPT_MARKED', {
      evidenceDigest: canonicalDigest(readJournal(rootDirectory, key).marker)
    });
    await notifyDurableTransition(afterDurableTransition, journal);

    currentStage = 'DESTRUCTIVE_BOUNDARY';
    publishDestructiveBoundary(rootDirectory, key);
    journal = appendState(rootDirectory, key, 'DESTRUCTIVE_BOUNDARY', {
      evidenceDigest: canonicalDigest(readJournal(rootDirectory, key).boundary)
    });
    await notifyDurableTransition(afterDurableTransition, journal);

    const destructiveStages = [
      'SIDE_EFFECTS_QUARANTINED',
      'DATABASE_CUTOVER',
      'DATABASE_VERIFIED',
      'AUTH_RUNTIME',
      'EDGE_RUNTIME',
      'WORKFLOW_CERTIFICATION',
      'FIXTURE_CLEANUP',
      'FINAL_PARITY'
    ];
    journal = appendState(rootDirectory, key, 'SIDE_EFFECTS_QUARANTINED');
    await notifyDurableTransition(afterDurableTransition, journal);
    for (let index = 0; index < destructiveStages.length; index += 1) {
      currentStage = destructiveStages[index];
      evidence = await runStage(executor, currentStage, context);
      const nextState = destructiveStages[index + 1] || 'COMPLETE';
      journal = appendState(rootDirectory, key, nextState, { evidenceDigest: evidenceDigest(evidence) });
      await notifyDurableTransition(afterDurableTransition, journal);
    }
    if (journal.current.state !== 'COMPLETE') throw categoricalError('DEV_REFRESH_COMPLETE_STATE_MISSING');
    return {
      classification: 'DEV_REFRESH_COMPLETE',
      target: 'dev',
      stages: journal.records.length,
      recoveryRequired: false,
      destructiveResumeAllowed: false
    };
  } catch (error) {
    const category = String(error?.code || error?.message || 'DEV_REFRESH_FAILED')
      .replace(/[^A-Z0-9_]/gi, '_')
      .slice(0, 120);
    let observed;
    try {
      observed = readJournal(rootDirectory, key);
      if (observed.boundary) {
        appendRecoveryRequired(rootDirectory, key, category);
      } else if (
        observed.current.state !== 'FAILED_PRE_MUTATION' &&
        INTERNAL_TRANSITIONS[observed.current.state]?.includes('FAILED_PRE_MUTATION')
      ) {
        appendState(rootDirectory, key, 'FAILED_PRE_MUTATION', { failureCategory: category });
      }
    } catch {
      // Durable marker/state files remain the authoritative restart evidence.
    }
    const wrapped = categoricalError(observed?.boundary ? 'DEV_REFRESH_RECOVERY_REQUIRED' : category);
    wrapped.failedStage = currentStage;
    wrapped.causeCategory = category;
    throw wrapped;
  }
}

async function runCertifiedDevRecovery({ rootDirectory, key, contract, executor } = {}) {
  verifyCertifiedRefreshContract(contract);
  requireExecutor(executor);
  const disposition = restartDisposition(rootDirectory, key);
  if (disposition !== 'RECOVERY_REQUIRED') {
    throw categoricalError('DEV_REFRESH_RECOVERY_NOT_PERMITTED');
  }
  let journal = appendRecoveryRequired(rootDirectory, key, 'PROCESS_RESTART_OR_PRIOR_FAILURE');
  publishRecoveryMarker(rootDirectory, key);
  journal = appendState(rootDirectory, key, 'RECOVERY_STARTED', {
    evidenceDigest: canonicalDigest(readJournal(rootDirectory, key).recovery)
  });
  const context = { rootDirectory: journal.paths.root, contract };
  try {
    journal = appendState(rootDirectory, key, 'RECOVERY_DATABASE');
    let evidence = await runStage(executor, 'RECOVERY_DATABASE', context);
    journal = appendState(rootDirectory, key, 'RECOVERY_AUTH_RUNTIME', {
      evidenceDigest: evidenceDigest(evidence)
    });
    evidence = await runStage(executor, 'RECOVERY_AUTH_RUNTIME', context);
    journal = appendState(rootDirectory, key, 'RECOVERY_VERIFIED', {
      evidenceDigest: evidenceDigest(evidence)
    });
    evidence = await runStage(executor, 'RECOVERY_VERIFIED', context);
    if (
      evidence.details?.preCutoverParity !== true ||
      evidence.details?.fixtureResidue !== 0 ||
      evidence.details?.y2Exact !== true ||
      evidence.details?.edgeRestored !== true ||
      evidence.details?.sideEffectsRestored !== true
    ) throw categoricalError('DEV_REFRESH_RECOVERY_PARITY_INCOMPLETE');
    journal = appendState(rootDirectory, key, 'RECOVERED', { evidenceDigest: evidenceDigest(evidence) });
    return {
      classification: 'DEV_REFRESH_RECOVERED',
      target: 'dev',
      stages: journal.records.length,
      recoveryAttemptedOnce: true,
      destructiveResumeAllowed: false
    };
  } catch (error) {
    const category = String(error?.code || error?.message || 'DEV_REFRESH_RECOVERY_FAILED')
      .replace(/[^A-Z0-9_]/gi, '_')
      .slice(0, 120);
    try {
      const current = readJournal(rootDirectory, key).current;
      if ((current.state === 'RECOVERY_STARTED' || current.state === 'RECOVERY_DATABASE' ||
        current.state === 'RECOVERY_AUTH_RUNTIME' || current.state === 'RECOVERY_VERIFIED')) {
        appendState(rootDirectory, key, 'RECOVERY_FAILED', { failureCategory: category });
      }
    } catch {
      // The permanent recovery marker still prevents an ordinary retry.
    }
    const wrapped = categoricalError('DEV_REFRESH_RECOVERY_FAILED');
    wrapped.causeCategory = category;
    throw wrapped;
  }
}

export { runCertifiedDevRecovery, runCertifiedDevRefresh };

import { canonicalDigest } from '../readonly-diagnostics.mjs';
import { readOptionalStageState } from './dev-certified-stage-state.mjs';
import {
  assertRecoveryRemediationContractFresh,
  assertRecoveryRemediationEvidence,
  verifyRecoveryRemediationContract
} from './dev-recovery-remediation-contract.mjs';
import {
  REMEDIATION_TRANSITIONS,
  appendRemediationState,
  initializeRemediationJournal,
  publishRemediationBoundary,
  publishRemediationMarker,
  publishRemediationRecoveryBoundary,
  publishRemediationRecoveryMarker,
  readRemediationJournal,
  reconcileRemediationBoundaryInterruption,
  remediationRestartDisposition
} from './dev-recovery-remediation-state.mjs';

function categoricalError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function requireExecutor(executor) {
  if (!executor || typeof executor.run !== 'function') throw categoricalError('DEV_REMEDIATION_EXECUTOR_INVALID');
  return executor;
}

async function runStage(executor, stage, context) {
  const evidence = await executor.run(stage, Object.freeze({ ...context }));
  assertRecoveryRemediationEvidence(evidence, { contract: context.contract, stage });
  return evidence;
}

async function notify(callback, journal) {
  if (typeof callback === 'function') {
    await callback(Object.freeze({
      state: journal.current.state,
      sequence: journal.current.sequence,
      mutationCrossed: journal.current.mutationCrossed,
      transactionOutcome: journal.current.transactionOutcome
    }));
  }
}

function safeCategory(error, fallback) {
  return String(error?.code || error?.message || fallback)
    .toUpperCase().replace(/[^A-Z0-9_]+/g, '_').slice(0, 160);
}

function failureTransactionOutcome(error, boundary, durableOutcome = 'not_started') {
  const observed = error?.operationFailure?.transactionOutcome || error?.transactionOutcome;
  if (['committed', 'rolled_back', 'ambiguous'].includes(observed)) return observed;
  if (observed === 'not_started' && boundary && durableOutcome === 'committed') return 'committed';
  if (observed === 'not_started') return 'not_started';
  if (boundary && durableOutcome === 'committed') return 'committed';
  return boundary ? 'ambiguous' : 'not_started';
}

async function runDevRecoveryRemediation({
  rootDirectory,
  key,
  contract,
  executor,
  afterDurableTransition,
  afterBoundaryPublished,
  now = () => Date.now()
} = {}) {
  verifyRecoveryRemediationContract(contract);
  assertRecoveryRemediationContractFresh(contract, now());
  requireExecutor(executor);
  let journal = initializeRemediationJournal({
    rootDirectory,
    key,
    remediationAttemptId: contract.remediationAttemptId,
    contractDigest: contract.contractDigest,
    originalBindingDigest: canonicalDigest(contract.original)
  });
  await notify(afterDurableTransition, journal);
  const context = { rootDirectory: journal.paths.root, contract };
  let currentStage = 'REMEDIATION_PRECHECK';
  try {
    let evidence = await runStage(executor, currentStage, context);
    journal = appendRemediationState(rootDirectory, key, 'CURRENT_Y2_PARITY', {
      evidenceDigest: canonicalDigest(evidence)
    });
    await notify(afterDurableTransition, journal);

    currentStage = 'CURRENT_Y2_PARITY';
    evidence = await runStage(executor, currentStage, context);
    journal = appendRemediationState(rootDirectory, key, 'R3_CAPTURE', {
      evidenceDigest: canonicalDigest(evidence)
    });
    await notify(afterDurableTransition, journal);

    currentStage = 'R3_CAPTURE';
    evidence = await runStage(executor, currentStage, context);
    journal = appendRemediationState(rootDirectory, key, 'R3_VALIDATED', {
      evidenceDigest: canonicalDigest(evidence)
    });
    await notify(afterDurableTransition, journal);

    currentStage = 'R3_VALIDATED';
    evidence = await runStage(executor, currentStage, context);
    assertRecoveryRemediationContractFresh(contract, now());
    publishRemediationMarker(rootDirectory, key, {
      originalBinding: contract.original,
      preparationDigest: evidence.details.preparationDigest,
      operationInventoryDigest: evidence.details.operationInventoryDigest,
      stageWorkerDigest: evidence.details.stageWorkerDigest,
      r3RecoveryId: evidence.details.r3RecoveryId,
      r3ComponentDigest: evidence.details.r3ComponentDigest,
      r3RecoveryPackageDigest: evidence.details.r3RecoveryPackageDigest,
      originalY2RecoveryPackageDigest: evidence.details.originalY2RecoveryPackageDigest,
      r3StageBindingDigest: evidence.details.r3StageBindingDigest,
      toolingCommit: contract.candidate.toolingCommit,
      toolingTree: contract.candidate.toolingTree
    });
    journal = appendRemediationState(rootDirectory, key, 'REMEDIATION_MARKED', {
      evidenceDigest: canonicalDigest(readRemediationJournal(rootDirectory, key).marker)
    });
    await notify(afterDurableTransition, journal);

    publishRemediationBoundary(rootDirectory, key);
    if (typeof afterBoundaryPublished === 'function') await afterBoundaryPublished();
    journal = appendRemediationState(rootDirectory, key, 'DESTRUCTIVE_BOUNDARY', {
      evidenceDigest: canonicalDigest(readRemediationJournal(rootDirectory, key).boundary)
    });
    await notify(afterDurableTransition, journal);

    currentStage = 'RESTORE_ORIGINAL_Y2';
    journal = appendRemediationState(rootDirectory, key, 'RESTORE_ORIGINAL_Y2');
    await notify(afterDurableTransition, journal);
    evidence = await runStage(executor, currentStage, context);
    journal = appendRemediationState(rootDirectory, key, 'AUTH_RUNTIME_VERIFIED', {
      evidenceDigest: canonicalDigest(evidence),
      transactionOutcome: 'committed'
    });
    await notify(afterDurableTransition, journal);

    currentStage = 'AUTH_RUNTIME_VERIFIED';
    evidence = await runStage(executor, currentStage, context);
    journal = appendRemediationState(rootDirectory, key, 'APPLICATION_RUNTIME_VERIFIED', {
      evidenceDigest: canonicalDigest(evidence)
    });
    await notify(afterDurableTransition, journal);

    currentStage = 'APPLICATION_RUNTIME_VERIFIED';
    evidence = await runStage(executor, currentStage, context);
    journal = appendRemediationState(rootDirectory, key, 'FINAL_Y2_PARITY', {
      evidenceDigest: canonicalDigest(evidence)
    });
    await notify(afterDurableTransition, journal);

    currentStage = 'FINAL_Y2_PARITY';
    evidence = await runStage(executor, currentStage, context);
    journal = appendRemediationState(rootDirectory, key, 'REMEDIATION_COMPLETE', {
      evidenceDigest: canonicalDigest(evidence),
      transactionOutcome: 'committed'
    });
    await notify(afterDurableTransition, journal);
    return {
      classification: 'DEV_RECOVERY_REMEDIATION_COMPLETE',
      target: 'dev',
      originalRecoveryState: 'RECOVERY_FAILED',
      remediationAttemptedOnce: true,
      transactionOutcome: 'committed',
      automaticRetry: false
    };
  } catch (error) {
    const category = safeCategory(error, 'DEV_REMEDIATION_FAILED');
    let observed;
    try {
      observed = readRemediationJournal(rootDirectory, key);
      if (observed.boundary) {
        if (observed.current.state !== 'REMEDIATION_RECOVERY_REQUIRED' &&
            REMEDIATION_TRANSITIONS[observed.current.state]?.includes('REMEDIATION_RECOVERY_REQUIRED')) {
          appendRemediationState(rootDirectory, key, 'REMEDIATION_RECOVERY_REQUIRED', {
            failureCategory: category,
            transactionOutcome: failureTransactionOutcome(error, true, observed.current.transactionOutcome)
          });
        }
      } else if (observed.current.state !== 'FAILED_PRE_MUTATION' &&
                 REMEDIATION_TRANSITIONS[observed.current.state]?.includes('FAILED_PRE_MUTATION')) {
        appendRemediationState(rootDirectory, key, 'FAILED_PRE_MUTATION', {
          failureCategory: category,
          transactionOutcome: 'not_started'
        });
      }
    } catch {
      // Permanent remediation markers and journal records remain authoritative.
    }
    const wrapped = categoricalError(observed?.boundary
      ? 'DEV_REMEDIATION_RECOVERY_REQUIRED'
      : category);
    wrapped.failedStage = currentStage;
    wrapped.causeCategory = category;
    wrapped.transactionOutcome = failureTransactionOutcome(
      error,
      Boolean(observed?.boundary),
      observed?.current?.transactionOutcome
    );
    throw wrapped;
  }
}

async function runDevRecoveryRemediationRecovery({
  rootDirectory,
  key,
  contract,
  executor,
  afterRecoveryPrecheck,
  afterRecoveryMarkerPublished,
  afterRecoveryBoundaryPublished,
  afterRecoveryDatabaseCommitted,
  afterRecoveryVerificationCompleted
} = {}) {
  verifyRecoveryRemediationContract(contract);
  requireExecutor(executor);
  let journal = reconcileRemediationBoundaryInterruption(rootDirectory, key, {
    contractDigest: contract.contractDigest,
    operationInventoryDigest: contract.operationInventoryDigest,
    toolingCommit: contract.candidate.toolingCommit,
    toolingTree: contract.candidate.toolingTree
  });
  if (
    journal.current.contractDigest !== contract.contractDigest ||
    journal.marker?.operationInventoryDigest !== contract.operationInventoryDigest ||
    journal.marker?.toolingCommit !== contract.candidate.toolingCommit ||
    journal.marker?.toolingTree !== contract.candidate.toolingTree
  ) {
    throw categoricalError('DEV_REMEDIATION_RECOVERY_NOT_PERMITTED');
  }
  const context = { rootDirectory: journal.paths.root, contract };
  if (journal.current.state === 'REMEDIATION_RECOVERY_REQUIRED' && journal.recovery) {
    journal = appendRemediationState(rootDirectory, key, 'REMEDIATION_RECOVERY_AUTHORIZED', {
      evidenceDigest: canonicalDigest(journal.recovery)
    });
  }
  let disposition = remediationRestartDisposition(rootDirectory, key);
  if (!new Set([
    'REMEDIATION_RECOVERY_REQUIRED',
    'REMEDIATION_RECOVERY_AUTHORIZED',
    'REMEDIATION_RECOVERY_DATABASE_BOUNDARY',
    'REMEDIATION_RECOVERY_DATABASE_COMMITTED',
    'REMEDIATION_RECOVERY_VERIFICATION_PENDING',
    'REMEDIATION_RECOVERY_VERIFIED'
  ]).has(disposition)) throw categoricalError('DEV_REMEDIATION_RECOVERY_NOT_PERMITTED');
  try {
    if (disposition === 'REMEDIATION_RECOVERY_REQUIRED' ||
        disposition === 'REMEDIATION_RECOVERY_AUTHORIZED') {
      const precheck = await runStage(executor, 'REMEDIATION_RECOVERY_PRECHECK', context);
      if (typeof afterRecoveryPrecheck === 'function') await afterRecoveryPrecheck();
      journal = readRemediationJournal(rootDirectory, key);
      if (!journal.recovery) {
        publishRemediationRecoveryMarker(rootDirectory, key);
        if (typeof afterRecoveryMarkerPublished === 'function') await afterRecoveryMarkerPublished();
        journal = appendRemediationState(rootDirectory, key, 'REMEDIATION_RECOVERY_AUTHORIZED', {
          evidenceDigest: canonicalDigest({
            precheck,
            marker: readRemediationJournal(rootDirectory, key).recovery
          })
        });
      }
      journal = readRemediationJournal(rootDirectory, key);
      if (journal.current.state !== 'REMEDIATION_RECOVERY_AUTHORIZED' || journal.recoveryBoundary) {
        throw categoricalError('DEV_REMEDIATION_RECOVERY_PREBOUNDARY_STATE_INVALID');
      }
      publishRemediationRecoveryBoundary(rootDirectory, key);
      if (typeof afterRecoveryBoundaryPublished === 'function') await afterRecoveryBoundaryPublished();
      journal = appendRemediationState(rootDirectory, key, 'REMEDIATION_RECOVERY_DATABASE_BOUNDARY', {
        evidenceDigest: canonicalDigest(readRemediationJournal(rootDirectory, key).recoveryBoundary)
      });
      const databaseEvidence = await runStage(executor, 'REMEDIATION_RECOVERY_DATABASE', context);
      journal = appendRemediationState(rootDirectory, key, 'REMEDIATION_RECOVERY_DATABASE_COMMITTED', {
        evidenceDigest: canonicalDigest(databaseEvidence),
        transactionOutcome: 'committed'
      });
      if (typeof afterRecoveryDatabaseCommitted === 'function') await afterRecoveryDatabaseCommitted();
      journal = appendRemediationState(rootDirectory, key, 'REMEDIATION_RECOVERY_VERIFICATION_PENDING', {
        evidenceDigest: canonicalDigest(databaseEvidence),
        transactionOutcome: 'committed'
      });
    } else if (disposition === 'REMEDIATION_RECOVERY_DATABASE_BOUNDARY') {
      const committed = readOptionalStageState({
        rootDirectory,
        key,
        attemptId: contract.remediationAttemptId,
        stage: 'REMEDIATION_RECOVERY_DATABASE'
      });
      journal = readRemediationJournal(rootDirectory, key);
      if (
        !committed || committed.transactionOutcome !== 'committed' ||
        committed.retainedPackageDigest !== journal.marker.r3RecoveryPackageDigest
      ) throw categoricalError('DEV_REMEDIATION_RECOVERY_DATABASE_OUTCOME_AMBIGUOUS');
      if (journal.current.state === 'REMEDIATION_RECOVERY_AUTHORIZED') {
        journal = appendRemediationState(rootDirectory, key, 'REMEDIATION_RECOVERY_DATABASE_BOUNDARY', {
          evidenceDigest: canonicalDigest(journal.recoveryBoundary)
        });
      }
      journal = appendRemediationState(rootDirectory, key, 'REMEDIATION_RECOVERY_DATABASE_COMMITTED', {
        evidenceDigest: canonicalDigest(committed),
        transactionOutcome: 'committed'
      });
      journal = appendRemediationState(rootDirectory, key, 'REMEDIATION_RECOVERY_VERIFICATION_PENDING', {
        evidenceDigest: canonicalDigest(committed),
        transactionOutcome: 'committed'
      });
    } else if (disposition === 'REMEDIATION_RECOVERY_DATABASE_COMMITTED') {
      journal = appendRemediationState(rootDirectory, key, 'REMEDIATION_RECOVERY_VERIFICATION_PENDING', {
        evidenceDigest: journal.current.evidenceDigest,
        transactionOutcome: 'committed'
      });
    } else if (disposition === 'REMEDIATION_RECOVERY_VERIFICATION_PENDING') {
      journal = readRemediationJournal(rootDirectory, key);
    } else if (disposition === 'REMEDIATION_RECOVERY_VERIFIED') {
      journal = appendRemediationState(rootDirectory, key, 'REMEDIATION_RECOVERED', {
        evidenceDigest: journal.current.evidenceDigest,
        transactionOutcome: 'committed'
      });
      return {
        classification: 'DEV_RECOVERY_REMEDIATION_R3_RECOVERED',
        target: 'dev',
        recoveryAttemptedOnce: true,
        transactionOutcome: 'committed',
        automaticRetry: false
      };
    } else {
      throw categoricalError('DEV_REMEDIATION_RECOVERY_NOT_PERMITTED');
    }
    const evidence = await runStage(executor, 'REMEDIATION_RECOVERY_VERIFIED', context);
    if (typeof afterRecoveryVerificationCompleted === 'function') {
      await afterRecoveryVerificationCompleted();
    }
    journal = appendRemediationState(rootDirectory, key, 'REMEDIATION_RECOVERY_VERIFIED', {
      evidenceDigest: canonicalDigest(evidence),
      transactionOutcome: 'committed'
    });
    journal = appendRemediationState(rootDirectory, key, 'REMEDIATION_RECOVERED', {
      evidenceDigest: canonicalDigest(evidence),
      transactionOutcome: 'committed'
    });
    return {
      classification: 'DEV_RECOVERY_REMEDIATION_R3_RECOVERED',
      target: 'dev',
      recoveryAttemptedOnce: true,
      transactionOutcome: 'committed',
      automaticRetry: false
    };
  } catch (error) {
    const category = safeCategory(error, 'DEV_REMEDIATION_RECOVERY_FAILED');
    let observed;
    try {
      observed = readRemediationJournal(rootDirectory, key);
      if (REMEDIATION_TRANSITIONS[observed.current.state]?.includes('REMEDIATION_RECOVERY_FAILED')) {
        appendRemediationState(rootDirectory, key, 'REMEDIATION_RECOVERY_FAILED', {
          failureCategory: category,
          transactionOutcome: failureTransactionOutcome(error, true, observed.current.transactionOutcome)
        });
      }
    } catch {
      // The permanent one-shot recovery marker remains authoritative.
    }
    if (observed?.current.state === 'REMEDIATION_RECOVERY_VERIFICATION_PENDING') {
      const wrapped = categoricalError('DEV_REMEDIATION_RECOVERY_VERIFICATION_PENDING');
      wrapped.causeCategory = category;
      wrapped.transactionOutcome = 'committed';
      throw wrapped;
    }
    if (
      (observed?.current.state === 'REMEDIATION_RECOVERY_REQUIRED' && !observed.recoveryBoundary) ||
      (observed?.current.state === 'REMEDIATION_RECOVERY_AUTHORIZED' && !observed.recoveryBoundary)
    ) throw error;
    const wrapped = categoricalError('DEV_REMEDIATION_RECOVERY_FAILED');
    wrapped.causeCategory = category;
    wrapped.transactionOutcome = failureTransactionOutcome(error, true, 'ambiguous');
    throw wrapped;
  }
}

export { runDevRecoveryRemediation, runDevRecoveryRemediationRecovery };

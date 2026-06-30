import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../../../components/Button';
import type { FilmOrderEntry, JobCaulkRequirementLine, JobPhase, JobRequirementLine } from '../../../../domain';
import { formatDate } from '../../../../lib/date';
import { CaulkRequirementsSection } from './CaulkRequirementsSection';
import { FilmRequirementsSection } from './FilmRequirementsSection';
import { formatBadgeLabel } from './helpers';

interface JobPhasesSectionProps {
  phases: JobPhase[];
  focusedPhaseId?: string;
  requirements: JobRequirementLine[];
  caulkRequirements: JobCaulkRequirementLine[];
  filmOrders: FilmOrderEntry[];
  isPhoneLayout: boolean;
  isReadOnlyJob: boolean;
  isAuthenticated: boolean;
  clientIdConfigured: boolean;
  canOrderAll: boolean;
  isCreateFilmOrderPending: boolean;
  pendingFilmRequirementStateIds: Set<string>;
  pendingCaulkRequirementStateIds: Set<string>;
  isPhaseStatePending: boolean;
  isResumeAutoPlanningPending: boolean;
  filmAutoAllocatePendingRequirementId?: string;
  caulkAutoAllocatePendingRequirementId?: string;
  pendingDeleteFilmOrderIds: Set<string>;
  onOrderRequirement: (requirement: JobRequirementLine) => void;
  onAutoAllocateRequirement: (requirement: JobRequirementLine) => void;
  onAutoAllocateCaulkRequirement: (requirement: JobCaulkRequirementLine) => void;
  onSetRequirementState: (requirement: JobRequirementLine, status: 'ACTIVE' | 'COMPLETE') => void;
  onSetCaulkRequirementState: (requirement: JobCaulkRequirementLine, status: 'ACTIVE' | 'COMPLETE') => void;
  onSetPhaseState: (phase: JobPhase, status: 'ACTIVE' | 'COMPLETE') => void;
  onSetPhaseWorkflowState: (
    phase: JobPhase,
    status: 'ACTIVE' | 'PLACEHOLDER'
  ) => boolean | void | Promise<boolean | void>;
  onResumeAutoPlanning: (requirement: JobRequirementLine) => void;
  onResumeCaulkAutoPlanning: (requirement: JobCaulkRequirementLine) => void;
  onCancelRequirementOrder: (order: FilmOrderEntry) => void;
  onOrderAll: () => void;
}

type PhaseWorkflowStatus = 'ACTIVE' | 'PLACEHOLDER';

interface PhaseWorkflowOverride {
  pending: boolean;
  previousStatus: PhaseWorkflowStatus;
  status: PhaseWorkflowStatus;
}

function getPhaseId(phase: JobPhase) {
  return String(phase.phaseId || phase.id || '').trim();
}

function getPhaseKey(phase: JobPhase, index: number) {
  return getPhaseId(phase) || `phase-${index}`;
}

function getRequirementPhaseId(entry: JobRequirementLine | JobCaulkRequirementLine) {
  return String(entry.phaseId || '').trim();
}

function filterForPhase<T extends JobRequirementLine | JobCaulkRequirementLine>(
  entries: T[],
  phase: JobPhase,
  fallbackPhaseId: string
) {
  const phaseId = getPhaseId(phase);
  return entries.filter((entry) => {
    const entryPhaseId = getRequirementPhaseId(entry);
    if (phaseId) {
      return entryPhaseId === phaseId || (!entryPhaseId && fallbackPhaseId === phaseId);
    }
    return !entryPhaseId;
  });
}

function buildPhaseTitle(phase: JobPhase) {
  const workScope = String(phase.workScope ?? phase.sections ?? '').trim();
  return `Phase ${phase.phaseNumber}${workScope ? ` — ${workScope}` : ''}`;
}

function buildPhaseDomId(phaseId: string) {
  const safePhaseId = phaseId.replace(/[^A-Za-z0-9_-]/g, '-');
  return safePhaseId ? `job-phase-${safePhaseId}` : undefined;
}

function normalizePhaseWorkflowStatus(value: unknown): PhaseWorkflowStatus {
  return String(value || '').trim().toUpperCase() === 'PLACEHOLDER' ? 'PLACEHOLDER' : 'ACTIVE';
}

function getPhaseWorkflowToggleButtonClass(isSelected: boolean) {
  return `inventory-view-toggle-button phase-workflow-toggle-button ${
    isSelected ? 'inventory-view-toggle-button-active' : ''
  }`.trim();
}

function shouldReduceMotion() {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function JobPhasesSection({
  phases,
  focusedPhaseId = '',
  requirements,
  caulkRequirements,
  filmOrders,
  isPhoneLayout,
  isReadOnlyJob,
  isAuthenticated,
  clientIdConfigured,
  canOrderAll,
  isCreateFilmOrderPending,
  pendingFilmRequirementStateIds,
  pendingCaulkRequirementStateIds,
  isPhaseStatePending,
  isResumeAutoPlanningPending,
  filmAutoAllocatePendingRequirementId = '',
  caulkAutoAllocatePendingRequirementId = '',
  pendingDeleteFilmOrderIds,
  onOrderRequirement,
  onAutoAllocateRequirement,
  onAutoAllocateCaulkRequirement,
  onSetRequirementState,
  onSetCaulkRequirementState,
  onSetPhaseState,
  onSetPhaseWorkflowState,
  onResumeAutoPlanning,
  onResumeCaulkAutoPlanning,
  onCancelRequirementOrder,
  onOrderAll
}: JobPhasesSectionProps) {
  const normalizedPhases = useMemo(
    () =>
      (phases.length
        ? phases
        : [
            {
              phaseId: '',
              phaseNumber: 1,
              workScope: '',
              sections: '',
              installDate: '',
              crewLeader: '',
              laborStatus: 'ACTIVE',
              workflowStatus: 'ACTIVE',
              isPlaceholder: false,
              isWorkflowActive: true,
              status: 'READY',
              isComplete: false,
              isPrimary: true,
              isNextRelevant: true,
              isExpandedByDefault: true,
              requiredFeet: 0,
              allocatedFeet: 0,
              remainingFeet: 0,
              requiredTubes: 0,
              allocatedTubes: 0,
              remainingTubes: 0,
              requirementCount: requirements.length,
              caulkRequirementCount: caulkRequirements.length,
              filmOrderCount: 0,
              allocationCount: 0,
              createdAt: '',
              updatedAt: ''
            } satisfies JobPhase
          ]).slice().sort((left, right) => left.phaseNumber - right.phaseNumber),
    [caulkRequirements.length, phases, requirements.length]
  );
  const fallbackPhaseId = getPhaseId(
    normalizedPhases.find((phase) => phase.isPrimary) || normalizedPhases[0]
  );
  const defaultExpandedPhaseIds = useMemo(
    () =>
      new Set(
        normalizedPhases
          .filter((phase) => phase.isExpandedByDefault || phase.isNextRelevant)
          .map((phase, index) => getPhaseId(phase) || `phase-${index}`)
      ),
    [normalizedPhases]
  );
  const [expandedPhaseIds, setExpandedPhaseIds] = useState<Set<string>>(
    () => new Set(defaultExpandedPhaseIds)
  );
  const phaseCardRefs = useRef(new Map<string, HTMLElement>());
  const lastHandledFocusedPhaseIdRef = useRef('');
  const highlightTimerRef = useRef<number | null>(null);
  const pendingWorkflowPhaseKeysRef = useRef(new Set<string>());
  const [highlightedPhaseId, setHighlightedPhaseId] = useState('');
  const [workflowOverrides, setWorkflowOverrides] = useState<Record<string, PhaseWorkflowOverride>>({});
  const normalizedFocusedPhaseId = String(focusedPhaseId || '').trim();
  const phaseServerWorkflowStatuses = useMemo(() => {
    const entries = normalizedPhases.map((phase, index) => [
      getPhaseKey(phase, index),
      normalizePhaseWorkflowStatus(phase.workflowStatus)
    ]);
    return Object.fromEntries(entries) as Record<string, PhaseWorkflowStatus>;
  }, [normalizedPhases]);

  useEffect(() => {
    setExpandedPhaseIds(new Set(defaultExpandedPhaseIds));
  }, [defaultExpandedPhaseIds]);

  useEffect(() => {
    setWorkflowOverrides((current) => {
      let changed = false;
      const next = { ...current };

      Object.entries(current).forEach(([key, override]) => {
        const serverStatus = phaseServerWorkflowStatuses[key];
        if (!serverStatus) {
          delete next[key];
          changed = true;
          return;
        }

        if (override.pending) {
          return;
        }

        if (serverStatus === override.status || serverStatus !== override.previousStatus) {
          delete next[key];
          changed = true;
        }
      });

      return changed ? next : current;
    });
  }, [phaseServerWorkflowStatuses]);

  useEffect(() => {
    if (!normalizedFocusedPhaseId) {
      lastHandledFocusedPhaseIdRef.current = '';
      return undefined;
    }

    if (lastHandledFocusedPhaseIdRef.current === normalizedFocusedPhaseId) {
      return undefined;
    }

    const targetPhase = normalizedPhases.find(
      (phase) => getPhaseId(phase) === normalizedFocusedPhaseId
    );
    if (!targetPhase) {
      return undefined;
    }

    const targetKey = getPhaseId(targetPhase);
    if (!targetKey) {
      return undefined;
    }

    lastHandledFocusedPhaseIdRef.current = normalizedFocusedPhaseId;
    setExpandedPhaseIds((current) => {
      if (current.has(targetKey)) {
        return current;
      }
      const next = new Set(current);
      next.add(targetKey);
      return next;
    });
    setHighlightedPhaseId(targetKey);

    const frameId = window.requestAnimationFrame(() => {
      const node = phaseCardRefs.current.get(targetKey);
      if (!node) {
        return;
      }
      node.scrollIntoView?.({
        block: 'center',
        behavior: shouldReduceMotion() ? 'auto' : 'smooth'
      });
      node.focus?.({ preventScroll: true });
    });

    if (highlightTimerRef.current !== null) {
      window.clearTimeout(highlightTimerRef.current);
    }
    highlightTimerRef.current = window.setTimeout(() => {
      setHighlightedPhaseId((current) => (current === targetKey ? '' : current));
      highlightTimerRef.current = null;
    }, 2400);

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [normalizedFocusedPhaseId, normalizedPhases]);

  useEffect(
    () => () => {
      if (highlightTimerRef.current !== null) {
        window.clearTimeout(highlightTimerRef.current);
      }
    },
    []
  );

  function togglePhase(phase: JobPhase, index: number) {
    const key = getPhaseKey(phase, index);
    setExpandedPhaseIds((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  function getVisibleWorkflowStatus(phase: JobPhase, index: number) {
    const key = getPhaseKey(phase, index);
    return workflowOverrides[key]?.status || normalizePhaseWorkflowStatus(phase.workflowStatus);
  }

  function rollbackPhaseWorkflowState(key: string, previousStatus: PhaseWorkflowStatus) {
    pendingWorkflowPhaseKeysRef.current.delete(key);
    setWorkflowOverrides((current) => ({
      ...current,
      [key]: {
        pending: false,
        previousStatus,
        status: previousStatus
      }
    }));
  }

  function setPhaseWorkflowState(phase: JobPhase, index: number, nextStatus: PhaseWorkflowStatus) {
    const key = getPhaseKey(phase, index);
    const currentStatus = getVisibleWorkflowStatus(phase, index);
    const currentOverride = workflowOverrides[key];

    if (currentStatus === nextStatus || currentOverride?.pending || pendingWorkflowPhaseKeysRef.current.has(key)) {
      return;
    }

    pendingWorkflowPhaseKeysRef.current.add(key);
    setWorkflowOverrides((current) => ({
      ...current,
      [key]: {
        pending: true,
        previousStatus: currentStatus,
        status: nextStatus
      }
    }));

    void Promise.resolve(onSetPhaseWorkflowState(phase, nextStatus))
      .then((result) => {
        if (result === false) {
          rollbackPhaseWorkflowState(key, currentStatus);
          return;
        }

        pendingWorkflowPhaseKeysRef.current.delete(key);
        setWorkflowOverrides((current) => {
          const activeOverride = current[key];
          if (!activeOverride || activeOverride.status !== nextStatus) {
            return current;
          }
          return {
            ...current,
            [key]: {
              ...activeOverride,
              pending: false
            }
          };
        });
      })
      .catch(() => {
        rollbackPhaseWorkflowState(key, currentStatus);
      });
  }

  return (
    <section className="panel job-phases-panel">
      <div className="panel-title-row">
        <h2>Phases</h2>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={!canOrderAll}
          loading={isCreateFilmOrderPending}
          loadingLabel="Ordering"
          onClick={onOrderAll}
        >
          Order All
        </Button>
      </div>

      <div className="job-phase-list">
        {normalizedPhases.map((phase, index) => {
          const key = getPhaseKey(phase, index);
          const phaseId = getPhaseId(phase);
          const phaseRequirements = filterForPhase(requirements, phase, fallbackPhaseId);
          const phaseCaulkRequirements = filterForPhase(caulkRequirements, phase, fallbackPhaseId);
          const isExpanded = expandedPhaseIds.has(key);
          const isLaborOnlyPhase = !phaseRequirements.length && !phaseCaulkRequirements.length;
          const phaseComplete = phase.isComplete || phase.laborStatus === 'COMPLETE' || phase.status === 'COMPLETED';
          const workflowStatus = getVisibleWorkflowStatus(phase, index);
          const isPlaceholderPhase = workflowStatus === 'PLACEHOLDER';
          const phaseWorkflowPending = workflowOverrides[key]?.pending === true;
          const workflowToggleDisabled =
            isReadOnlyJob || !isAuthenticated || !clientIdConfigured || phaseWorkflowPending;
          const phaseLaborToggleDisabled =
            isReadOnlyJob || !isAuthenticated || !clientIdConfigured || isPhaseStatePending;

          return (
            <article
              className={[
                'job-phase-card',
                isPlaceholderPhase ? 'job-phase-card-placeholder' : '',
                highlightedPhaseId === key ? 'job-phase-card-targeted' : ''
              ]
                .filter(Boolean)
                .join(' ')}
              data-phase-id={phaseId || undefined}
              id={phaseId ? buildPhaseDomId(phaseId) : undefined}
              key={key}
              ref={(node) => {
                if (node) {
                  phaseCardRefs.current.set(key, node);
                } else {
                  phaseCardRefs.current.delete(key);
                }
              }}
              tabIndex={-1}
            >
              <div className="job-phase-header">
                <div className="job-phase-leading-actions">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="phase-collapse-button"
                    aria-label={isExpanded ? 'Collapse phase' : 'Expand phase'}
                    onClick={() => togglePhase(phase, index)}
                  >
                    {isExpanded ? '-' : '+'}
                  </Button>
                </div>
                <div className="job-phase-heading">
                  <h3>{buildPhaseTitle(phase)}</h3>
                  <div className="job-phase-meta">
                    <span>{formatDate(phase.installDate || '')}</span>
                    <span>{phase.crewLeader || 'No crew leader'}</span>
                    {isPlaceholderPhase ? <span className="badge badge-muted">Placeholder</span> : null}
                    <span className={`badge badge-${phase.status}`}>{formatBadgeLabel(phase.status)}</span>
                  </div>
                </div>
                <div className="job-phase-header-actions">
                  <div
                    className="inventory-view-toggle phase-workflow-toggle"
                    role="group"
                    aria-label={`Phase ${phase.phaseNumber} workflow state`}
                  >
                    <button
                      type="button"
                      className={getPhaseWorkflowToggleButtonClass(isPlaceholderPhase)}
                      disabled={workflowToggleDisabled}
                      onClick={() => {
                        setPhaseWorkflowState(phase, index, 'PLACEHOLDER');
                      }}
                      aria-pressed={isPlaceholderPhase}
                    >
                      Placeholder
                    </button>
                    <button
                      type="button"
                      className={getPhaseWorkflowToggleButtonClass(!isPlaceholderPhase)}
                      disabled={workflowToggleDisabled}
                      onClick={() => {
                        setPhaseWorkflowState(phase, index, 'ACTIVE');
                      }}
                      aria-pressed={!isPlaceholderPhase}
                    >
                      Active
                    </button>
                  </div>
                  {isLaborOnlyPhase ? (
                    <label className="requirement-state-toggle phase-labor-toggle">
                      <input
                        type="checkbox"
                        checked={phaseComplete}
                        disabled={phaseLaborToggleDisabled}
                        onChange={() => onSetPhaseState(phase, phaseComplete ? 'ACTIVE' : 'COMPLETE')}
                      />
                      <span>{phaseComplete ? 'Complete' : 'Active'}</span>
                    </label>
                  ) : null}
                </div>
              </div>

              {isExpanded ? (
                <div className="job-phase-body">
                  <FilmRequirementsSection
                    title="Film"
                    embedded
                    hideOrderAll
                    requirements={phaseRequirements}
                    filmOrders={filmOrders}
                    isPhoneLayout={isPhoneLayout}
                    isReadOnlyJob={isReadOnlyJob}
                    isAuthenticated={isAuthenticated}
                    clientIdConfigured={clientIdConfigured}
                    isCreateFilmOrderPending={isCreateFilmOrderPending}
                    pendingRequirementStateIds={pendingFilmRequirementStateIds}
                    isResumeAutoPlanningPending={isResumeAutoPlanningPending}
                    autoAllocatePendingRequirementId={filmAutoAllocatePendingRequirementId}
                    pendingDeleteFilmOrderIds={pendingDeleteFilmOrderIds}
                    onOrderRequirement={onOrderRequirement}
                    onAutoAllocateRequirement={onAutoAllocateRequirement}
                    onSetRequirementState={onSetRequirementState}
                    onResumeAutoPlanning={onResumeAutoPlanning}
                    onCancelRequirementOrder={onCancelRequirementOrder}
                    onOrderAll={onOrderAll}
                  />
                  <CaulkRequirementsSection
                    title="Caulk"
                    embedded
                    requirements={phaseCaulkRequirements}
                    isPhoneLayout={isPhoneLayout}
                    isReadOnlyJob={isReadOnlyJob}
                    isAuthenticated={isAuthenticated}
                    clientIdConfigured={clientIdConfigured}
                    pendingRequirementStateIds={pendingCaulkRequirementStateIds}
                    isResumeAutoPlanningPending={isResumeAutoPlanningPending}
                    autoAllocatePendingRequirementId={caulkAutoAllocatePendingRequirementId}
                    onSetRequirementState={onSetCaulkRequirementState}
                    onAutoAllocateRequirement={onAutoAllocateCaulkRequirement}
                    onResumeAutoPlanning={onResumeCaulkAutoPlanning}
                  />
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { Button } from '../../../../components/Button';
import type { FilmOrderEntry, JobCaulkRequirementLine, JobPhase, JobRequirementLine } from '../../../../domain';
import { formatDate } from '../../../../lib/date';
import { CaulkRequirementsSection } from './CaulkRequirementsSection';
import { FilmRequirementsSection } from './FilmRequirementsSection';

interface JobPhasesSectionProps {
  phases: JobPhase[];
  requirements: JobRequirementLine[];
  caulkRequirements: JobCaulkRequirementLine[];
  filmOrders: FilmOrderEntry[];
  isPhoneLayout: boolean;
  isReadOnlyJob: boolean;
  isAuthenticated: boolean;
  clientIdConfigured: boolean;
  canOrderAll: boolean;
  isCreateFilmOrderPending: boolean;
  isRequirementStatePending: boolean;
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
  onResumeAutoPlanning: (requirement: JobRequirementLine) => void;
  onResumeCaulkAutoPlanning: (requirement: JobCaulkRequirementLine) => void;
  onCancelRequirementOrder: (order: FilmOrderEntry) => void;
  onOrderAll: () => void;
}

function getPhaseId(phase: JobPhase) {
  return String(phase.phaseId || phase.id || '').trim();
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

export function JobPhasesSection({
  phases,
  requirements,
  caulkRequirements,
  filmOrders,
  isPhoneLayout,
  isReadOnlyJob,
  isAuthenticated,
  clientIdConfigured,
  canOrderAll,
  isCreateFilmOrderPending,
  isRequirementStatePending,
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

  useEffect(() => {
    setExpandedPhaseIds(new Set(defaultExpandedPhaseIds));
  }, [defaultExpandedPhaseIds]);

  function togglePhase(phase: JobPhase, index: number) {
    const key = getPhaseId(phase) || `phase-${index}`;
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
          const key = getPhaseId(phase) || `phase-${index}`;
          const phaseRequirements = filterForPhase(requirements, phase, fallbackPhaseId);
          const phaseCaulkRequirements = filterForPhase(caulkRequirements, phase, fallbackPhaseId);
          const isExpanded = expandedPhaseIds.has(key);
          const isLaborOnlyPhase = !phaseRequirements.length && !phaseCaulkRequirements.length;
          const phaseComplete = phase.isComplete || phase.laborStatus === 'COMPLETE' || phase.status === 'COMPLETED';

          return (
            <article className="job-phase-card" key={key}>
              <div className="job-phase-header">
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
                <div>
                  <h3>{buildPhaseTitle(phase)}</h3>
                  <div className="job-phase-meta">
                    <span>{formatDate(phase.installDate || '')}</span>
                    <span>{phase.crewLeader || 'No crew leader'}</span>
                    <span className={`badge badge-${phase.status}`}>{phase.status}</span>
                  </div>
                </div>
                {isLaborOnlyPhase ? (
                  <label className="requirement-state-toggle phase-labor-toggle">
                    <input
                      type="checkbox"
                      checked={phaseComplete}
                      disabled={isReadOnlyJob || !isAuthenticated || !clientIdConfigured || isPhaseStatePending}
                      onChange={() => onSetPhaseState(phase, phaseComplete ? 'ACTIVE' : 'COMPLETE')}
                    />
                    <span>{phaseComplete ? 'Complete' : 'Active'}</span>
                  </label>
                ) : null}
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
                    isRequirementStatePending={isRequirementStatePending}
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
                    isRequirementStatePending={isRequirementStatePending}
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

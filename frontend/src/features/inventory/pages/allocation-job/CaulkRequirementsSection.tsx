import { Button } from '../../../../components/Button';
import {
  MobileField,
  MobileFieldList,
  MobileRecordCard,
  MobileRecordHeader
} from '../../../../components/MobileRecordCard';
import type { JobCaulkRequirementLine } from '../../../../domain';
import { buildCaulkProductLabel } from '../../utils/caulkProductLabels';

interface CaulkRequirementsSectionProps {
  requirements: JobCaulkRequirementLine[];
  isPhoneLayout: boolean;
  isReadOnlyJob: boolean;
  isAuthenticated: boolean;
  clientIdConfigured: boolean;
  isRequirementStatePending: boolean;
  isResumeAutoPlanningPending: boolean;
  autoAllocatePendingRequirementId?: string;
  title?: string;
  embedded?: boolean;
  onSetRequirementState: (requirement: JobCaulkRequirementLine, status: 'ACTIVE' | 'COMPLETE') => void;
  onAutoAllocateRequirement: (requirement: JobCaulkRequirementLine) => void;
  onResumeAutoPlanning: (requirement: JobCaulkRequirementLine) => void;
}

export function CaulkRequirementsSection({
  requirements,
  isPhoneLayout,
  isReadOnlyJob,
  isAuthenticated,
  clientIdConfigured,
  isRequirementStatePending,
  isResumeAutoPlanningPending,
  autoAllocatePendingRequirementId = '',
  title = 'Caulk Requirements',
  embedded = false,
  onSetRequirementState,
  onAutoAllocateRequirement,
  onResumeAutoPlanning
}: CaulkRequirementsSectionProps) {
  function renderCompletionResult(entry: JobCaulkRequirementLine) {
    if (entry.status !== 'COMPLETE') {
      return <span className="muted-text">Active</span>;
    }

    const isOnTarget =
      (entry.completionResult || '') === 'ON_TARGET' ||
      Math.max(0, Number(entry.actualUsedTubes || 0)) <= Math.max(0, Number(entry.requiredTubes || 0));
    return (
      <span
        className={`requirement-result ${
          isOnTarget ? 'requirement-result--on-target' : 'requirement-result--overused'
        }`}
        aria-label={isOnTarget ? 'On target' : 'Overused'}
      >
        {isOnTarget ? '✓' : 'X'}
      </span>
    );
  }

  function renderStateToggle(entry: JobCaulkRequirementLine) {
    const checked = entry.status === 'COMPLETE';
    const disabled =
      isReadOnlyJob ||
      !isAuthenticated ||
      !clientIdConfigured ||
      isRequirementStatePending;

    return (
      <div className="requirement-state-cell">
        <label className="requirement-state-toggle">
          <input
            type="checkbox"
            checked={checked}
            disabled={disabled}
            onChange={() => onSetRequirementState(entry, checked ? 'ACTIVE' : 'COMPLETE')}
          />
          <span>{checked ? 'Complete' : 'Active'}</span>
        </label>
        {renderCompletionResult(entry)}
      </div>
    );
  }

  function renderRequirementAction(entry: JobCaulkRequirementLine) {
    const remainingTubes = Math.max(0, Number(entry.remainingTubes || 0));
    const isComplete = entry.status === 'COMPLETE';
    const canMutateRequirement =
      !isReadOnlyJob &&
      !isComplete &&
      remainingTubes > 0 &&
      isAuthenticated &&
      clientIdConfigured;
    const autoAllocateButton = (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={!canMutateRequirement}
        loading={autoAllocatePendingRequirementId === entry.requirementId}
        loadingLabel="Allocating"
        title={isComplete ? 'Reactivate requirement to allocate more material.' : undefined}
        onClick={() => onAutoAllocateRequirement(entry)}
      >
        Auto Allocate
      </Button>
    );

    if (isComplete || !entry.autoPlanningSuppressed || remainingTubes <= 0) {
      return autoAllocateButton;
    }

    if (isReadOnlyJob) {
      return <span className="muted-text">Auto planning paused</span>;
    }

    return (
      <div className="film-order-actions film-order-actions--stacked">
        <span className="muted-text">Auto planning paused</span>
        {autoAllocateButton}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!isAuthenticated || !clientIdConfigured}
          loading={isResumeAutoPlanningPending}
          loadingLabel="Resuming"
          onClick={() => onResumeAutoPlanning(entry)}
        >
          Resume auto-plan
        </Button>
      </div>
    );
  }

  const Wrapper = embedded ? 'div' : 'section';

  return (
    <Wrapper className={embedded ? 'phase-requirements-block' : 'panel'}>
      <div className="panel-title-row">
        <h2>{title}</h2>
      </div>
      {!requirements.length ? (
        <div className="empty-state">No caulk requirements added yet.</div>
      ) : isPhoneLayout ? (
        <div className="mobile-record-list">
          {requirements.map((entry) => (
            <MobileRecordCard key={entry.requirementId}>
              <MobileRecordHeader
                title={buildCaulkProductLabel(entry.manufacturer, entry.productName, entry.productCode)}
                subtitle={`${entry.remainingTubes} remaining`}
              />
              <MobileFieldList>
                <MobileField label="Allocated Tubes" value={entry.allocatedTubes} />
                <MobileField label="Actual Used Tubes" value={entry.actualUsedTubes ?? 0} />
                <MobileField label="Remaining Tubes" value={entry.remainingTubes} />
              </MobileFieldList>
              {renderStateToggle(entry)}
              <div className="film-order-actions">
                {renderRequirementAction(entry)}
              </div>
            </MobileRecordCard>
          ))}
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Manufacturer</th>
                <th>Product</th>
                <th>Allocated Tubes</th>
                <th>Actual Used Tubes</th>
                <th>Remaining Tubes</th>
                <th>State</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {requirements.map((entry) => (
                <tr key={entry.requirementId}>
                  <td>{entry.manufacturer}</td>
                  <td>{entry.productName}</td>
                  <td>{entry.allocatedTubes}</td>
                  <td>{entry.actualUsedTubes ?? 0}</td>
                  <td>{entry.remainingTubes}</td>
                  <td>{renderStateToggle(entry)}</td>
                  <td>{renderRequirementAction(entry)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Wrapper>
  );
}

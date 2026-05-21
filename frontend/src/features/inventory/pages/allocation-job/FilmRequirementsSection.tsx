import { Button } from '../../../../components/Button';
import {
  MobileField,
  MobileFieldList,
  MobileRecordCard,
  MobileRecordHeader
} from '../../../../components/MobileRecordCard';
import type { FilmOrderEntry, JobRequirementLine } from '../../../../domain';
import {
  findUnresolvedOrderForRequirement,
  getOrderableFilmRequirements
} from './filmRequirementOrders';

interface FilmRequirementsSectionProps {
  requirements: JobRequirementLine[];
  filmOrders: FilmOrderEntry[];
  isPhoneLayout: boolean;
  isReadOnlyJob: boolean;
  isAuthenticated: boolean;
  clientIdConfigured: boolean;
  isCreateFilmOrderPending: boolean;
  isRequirementStatePending: boolean;
  isResumeAutoPlanningPending: boolean;
  pendingDeleteFilmOrderIds: Set<string>;
  title?: string;
  embedded?: boolean;
  hideOrderAll?: boolean;
  onOrderRequirement: (requirement: JobRequirementLine) => void;
  onSetRequirementState: (requirement: JobRequirementLine, status: 'ACTIVE' | 'COMPLETE') => void;
  onResumeAutoPlanning: (requirement: JobRequirementLine) => void;
  onCancelRequirementOrder: (order: FilmOrderEntry) => void;
  onOrderAll: () => void;
}

export function FilmRequirementsSection({
  requirements,
  filmOrders,
  isPhoneLayout,
  isReadOnlyJob,
  isAuthenticated,
  clientIdConfigured,
  isCreateFilmOrderPending,
  isRequirementStatePending,
  isResumeAutoPlanningPending,
  pendingDeleteFilmOrderIds,
  title = 'Film Requirements',
  embedded = false,
  hideOrderAll = false,
  onOrderRequirement,
  onSetRequirementState,
  onResumeAutoPlanning,
  onCancelRequirementOrder,
  onOrderAll
}: FilmRequirementsSectionProps) {
  const orderableRequirements = getOrderableFilmRequirements(requirements, filmOrders);
  const canOrderAll =
    orderableRequirements.length > 0 &&
    !isReadOnlyJob &&
    isAuthenticated &&
    clientIdConfigured &&
    !isCreateFilmOrderPending;

  function renderCompletionResult(entry: JobRequirementLine) {
    if (entry.status !== 'COMPLETE') {
      return <span className="muted-text">Active</span>;
    }

    const isOnTarget =
      (entry.completionResult || '') === 'ON_TARGET' ||
      Math.max(0, Number(entry.actualUsedFeet || 0)) <= Math.max(0, Number(entry.requiredFeet || 0));
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

  function renderStateToggle(entry: JobRequirementLine) {
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

  function renderRequirementAction(entry: JobRequirementLine) {
    const matchingOrder = findUnresolvedOrderForRequirement(entry, filmOrders);
    const pendingDelete = matchingOrder
      ? pendingDeleteFilmOrderIds.has(matchingOrder.filmOrderId.trim().toUpperCase())
      : false;
    const remainingFeet = Math.max(0, Number(entry.remainingFeet || 0));
    const isComplete = entry.status === 'COMPLETE';

    if (isReadOnlyJob) {
      return <span className="muted-text">Read-only</span>;
    }

    if (matchingOrder?.status === 'FILM_ON_THE_WAY') {
      return (
        <Button type="button" variant="secondary" size="sm" disabled>
          Ordered
        </Button>
      );
    }

    if (matchingOrder) {
      return (
        <Button
          type="button"
          variant="danger"
          size="sm"
          loading={pendingDelete}
          loadingLabel="Cancelling"
          onClick={() => onCancelRequirementOrder(matchingOrder)}
        >
          Cancel Order
        </Button>
      );
    }

    const orderButton = (
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={isComplete || remainingFeet <= 0 || !isAuthenticated || !clientIdConfigured}
        loading={isCreateFilmOrderPending}
        loadingLabel="Ordering"
        onClick={() => onOrderRequirement(entry)}
      >
        Order
      </Button>
    );

    if (isComplete || !entry.autoPlanningSuppressed || remainingFeet <= 0) {
      return orderButton;
    }

    return (
      <div className="film-order-actions film-order-actions--stacked">
        <span className="muted-text">Auto planning paused</span>
        <div className="film-order-actions">
          {orderButton}
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
      </div>
    );
  }

  const Wrapper = embedded ? 'div' : 'section';

  return (
    <Wrapper className={embedded ? 'phase-requirements-block' : 'panel'}>
      <div className="panel-title-row">
        <h2>{title}</h2>
        {!hideOrderAll ? (
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
        ) : null}
      </div>
      {!requirements.length ? (
        <div className="empty-state">No film requirements added yet.</div>
      ) : isPhoneLayout ? (
        <div className="mobile-record-list">
          {requirements.map((entry) => (
            <MobileRecordCard key={entry.requirementId}>
              <MobileRecordHeader
                title={`${entry.manufacturer} ${entry.filmName}`}
                subtitle={`Width ${entry.widthIn}"`}
              />
              <MobileFieldList>
                <MobileField label="Planned LF" value={entry.requiredFeet} />
                <MobileField label="Allocated LF" value={entry.allocatedFeet} />
                <MobileField label="Actual Used LF" value={entry.actualUsedFeet} />
                <MobileField
                  label="Locked LF"
                  value={entry.allocatedWithInstallDateFeet ?? 0}
                />
                <MobileField
                  label="Placeholder LF"
                  value={entry.allocatedWithoutInstallDateFeet ?? 0}
                />
                <MobileField label="Remaining LF" value={entry.remainingFeet} />
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
                <th>Film</th>
                <th>Width</th>
                <th>Planned LF</th>
                <th>Allocated LF</th>
                <th>Actual Used LF</th>
                <th>Locked LF</th>
                <th>Placeholder LF</th>
                <th>Remaining LF</th>
                <th>State</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {requirements.map((entry) => (
                <tr key={entry.requirementId}>
                  <td>{entry.manufacturer}</td>
                  <td>{entry.filmName}</td>
                  <td>{entry.widthIn}</td>
                  <td>{entry.requiredFeet}</td>
                  <td>{entry.allocatedFeet}</td>
                  <td>{entry.actualUsedFeet}</td>
                  <td>{entry.allocatedWithInstallDateFeet ?? 0}</td>
                  <td>{entry.allocatedWithoutInstallDateFeet ?? 0}</td>
                  <td>{entry.remainingFeet}</td>
                  <td>{renderStateToggle(entry)}</td>
                  <td>
                    <div className="film-order-actions">
                      {renderRequirementAction(entry)}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Wrapper>
  );
}

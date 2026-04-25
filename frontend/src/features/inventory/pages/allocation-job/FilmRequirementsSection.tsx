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
  pendingDeleteFilmOrderIds: Set<string>;
  onOrderRequirement: (requirement: JobRequirementLine) => void;
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
  pendingDeleteFilmOrderIds,
  onOrderRequirement,
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

  function renderRequirementAction(entry: JobRequirementLine) {
    const matchingOrder = findUnresolvedOrderForRequirement(entry, filmOrders);
    const pendingDelete = matchingOrder
      ? pendingDeleteFilmOrderIds.has(matchingOrder.filmOrderId.trim().toUpperCase())
      : false;
    const remainingFeet = Math.max(0, Number(entry.remainingFeet || 0));

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
          Cancel
        </Button>
      );
    }

    return (
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={remainingFeet <= 0 || !isAuthenticated || !clientIdConfigured}
        loading={isCreateFilmOrderPending}
        loadingLabel="Ordering"
        onClick={() => onOrderRequirement(entry)}
      >
        Order
      </Button>
    );
  }

  return (
    <section className="panel">
      <div className="panel-title-row">
        <h2>Film Requirements</h2>
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
                <MobileField label="Required LF" value={entry.requiredFeet} />
                <MobileField label="Allocated LF" value={entry.allocatedFeet} />
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
                <th>Required LF</th>
                <th>Allocated LF</th>
                <th>Locked LF</th>
                <th>Placeholder LF</th>
                <th>Remaining LF</th>
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
                  <td>{entry.allocatedWithInstallDateFeet ?? 0}</td>
                  <td>{entry.allocatedWithoutInstallDateFeet ?? 0}</td>
                  <td>{entry.remainingFeet}</td>
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
    </section>
  );
}

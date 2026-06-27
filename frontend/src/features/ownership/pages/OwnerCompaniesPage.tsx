import { useState } from 'react';
import { Button } from '../../../components/Button';
import { Input } from '../../../components/Input';
import { useToast } from '../../../components/Toast';
import { formatOwnerCompanyLabel } from '../../../domain';
import {
  useDeactivateOwnerCompany,
  useOwnerCompanies,
  useUpsertOwnerCompany
} from '../../inventory/hooks/useInventoryQueries';

export default function OwnerCompaniesPage() {
  const toast = useToast();
  const ownerCompaniesQuery = useOwnerCompanies({ includeInactive: true });
  const upsertMutation = useUpsertOwnerCompany();
  const deactivateMutation = useDeactivateOwnerCompany();
  const [code, setCode] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');

  async function handleCreate() {
    const normalizedCode = code.trim().toUpperCase();
    const normalizedDisplayName = displayName.trim();
    if (!normalizedCode) {
      setError('Owner company code is required.');
      return;
    }

    try {
      setError('');
      await upsertMutation.mutateAsync({
        code: normalizedCode,
        displayName: normalizedDisplayName || undefined
      });
      setCode('');
      setDisplayName('');
      toast.push({
        title: 'Owner company saved',
        description: `${normalizedCode} is available for inventory ownership.`,
        variant: 'success'
      });
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : 'Owner company could not be saved.';
      setError(message);
      toast.push({ title: 'Unable to save owner company', description: message, variant: 'error' });
    }
  }

  async function handleDeactivate(ownerCompanyId: string, label: string) {
    const note = window.prompt(`Deactivate ${label}? Optional note:`, '') ?? '';
    try {
      await deactivateMutation.mutateAsync({
        ownerCompanyId,
        note: note.trim() || undefined
      });
      toast.push({
        title: 'Owner company deactivated',
        description: `${label} remains visible on existing inventory and history.`,
        variant: 'success'
      });
    } catch (requestError) {
      toast.push({
        title: 'Unable to deactivate owner company',
        description: requestError instanceof Error ? requestError.message : 'The owner company was not changed.',
        variant: 'error'
      });
    }
  }

  const ownerCompanies = ownerCompaniesQuery.data || [];

  return (
    <>
      <section className="panel">
        <div className="panel-title-row">
          <div>
            <p className="eyebrow">Owner Tools</p>
            <h2>Owner Companies</h2>
            <p className="muted-text">
              Manage active inventory owner companies. Deactivated companies remain on existing inventory.
            </p>
          </div>
        </div>
        <div className="form-grid">
          <Input
            label="Code"
            value={code}
            onChange={(event) => setCode(event.target.value.toUpperCase())}
            placeholder="MGT"
          />
          <Input
            label="Display Name"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder="MGT"
          />
        </div>
        {error ? <p className="error-text">{error}</p> : null}
        <div className="detail-actions">
          <Button
            type="button"
            onClick={() => void handleCreate()}
            loading={upsertMutation.isPending}
            loadingLabel="Saving..."
          >
            Save Owner Company
          </Button>
        </div>
      </section>

      <section className="panel">
        <div className="panel-title-row">
          <h2>Companies</h2>
          <span className="muted-text">{ownerCompanies.length} total</span>
        </div>
        {ownerCompaniesQuery.isError ? (
          <p className="error-text">
            {ownerCompaniesQuery.error instanceof Error
              ? ownerCompaniesQuery.error.message
              : 'Owner companies failed to load.'}
          </p>
        ) : null}
        <div className="table-wrap">
          <table className="inventory-table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Status</th>
                <th>Updated</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {ownerCompanies.length === 0 ? (
                <tr>
                  <td colSpan={5} className="muted-text">
                    No owner companies are available yet.
                  </td>
                </tr>
              ) : (
                ownerCompanies.map((entry) => {
                  const label = formatOwnerCompanyLabel(entry);
                  return (
                    <tr key={entry.ownerCompanyId}>
                      <td>{entry.code}</td>
                      <td>{entry.displayName}</td>
                      <td>
                        <span className={`badge ${entry.isActive ? 'badge-IN_STOCK' : 'badge-muted'}`}>
                          {entry.isActive ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td>{entry.updatedAt || '--'}</td>
                      <td>
                        {entry.isActive ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => void handleDeactivate(entry.ownerCompanyId, label)}
                            disabled={deactivateMutation.isPending}
                          >
                            Deactivate
                          </Button>
                        ) : (
                          <span className="muted-text">Archived</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

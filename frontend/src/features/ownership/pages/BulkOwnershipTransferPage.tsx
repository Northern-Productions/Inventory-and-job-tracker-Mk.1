import { useMemo, useState } from 'react';
import { Button } from '../../../components/Button';
import { TextArea } from '../../../components/Input';
import { Select } from '../../../components/Select';
import { useToast } from '../../../components/Toast';
import {
  useBulkOwnershipTransfer,
  useOwnerCompanies
} from '../../inventory/hooks/useInventoryQueries';

function parseLines(value: string) {
  return Array.from(
    new Set(
      value
        .split(/[\n,]+/)
        .map((entry) => entry.trim())
        .filter(Boolean)
    )
  );
}

export default function BulkOwnershipTransferPage() {
  const toast = useToast();
  const ownerCompaniesQuery = useOwnerCompanies();
  const bulkTransferMutation = useBulkOwnershipTransfer();
  const [filmBoxIdsText, setFilmBoxIdsText] = useState('');
  const [caulkStockIdsText, setCaulkStockIdsText] = useState('');
  const [ownerCompanyId, setOwnerCompanyId] = useState('');
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState(false);

  const filmBoxIds = useMemo(() => parseLines(filmBoxIdsText), [filmBoxIdsText]);
  const caulkStockIds = useMemo(() => parseLines(caulkStockIdsText), [caulkStockIdsText]);
  const selectedOwner = (ownerCompaniesQuery.data || []).find(
    (entry) => entry.ownerCompanyId === ownerCompanyId
  );
  const totalItems = filmBoxIds.length + caulkStockIds.length;

  async function handleSubmit() {
    if (!ownerCompanyId) {
      toast.push({
        title: 'Owner company required',
        description: 'Choose the new active owner company before transferring ownership.',
        variant: 'error'
      });
      return;
    }

    if (totalItems <= 0) {
      toast.push({
        title: 'No inventory selected',
        description: 'Enter at least one film box ID or caulk stock ID.',
        variant: 'error'
      });
      return;
    }

    if (!confirming) {
      setConfirming(true);
      return;
    }

    try {
      const result = await bulkTransferMutation.mutateAsync({
        filmBoxIds,
        caulkStockIds,
        ownerCompanyId,
        note: note.trim() || undefined
      });
      setConfirming(false);
      setFilmBoxIdsText('');
      setCaulkStockIdsText('');
      setOwnerCompanyId('');
      setNote('');
      toast.push({
        title: 'Ownership transfer complete',
        description: `${result.changedCount} item${result.changedCount === 1 ? '' : 's'} changed in batch ${result.batchId || 'n/a'}.`,
        variant: 'success'
      });
    } catch (requestError) {
      toast.push({
        title: 'Unable to transfer ownership',
        description: requestError instanceof Error ? requestError.message : 'Ownership transfer failed.',
        variant: 'error'
      });
    }
  }

  return (
    <section className="panel">
      <div className="panel-title-row">
        <div>
          <p className="eyebrow">Owner Tools</p>
          <h2>Bulk Ownership Transfer</h2>
          <p className="muted-text">
            Transfer ownership for explicitly listed film boxes and caulk stock rows only.
          </p>
        </div>
      </div>

      <div className="form-grid">
        <Select
          label="New Owner Company"
          value={ownerCompanyId}
          onChange={(event) => {
            setOwnerCompanyId(event.target.value);
            setConfirming(false);
          }}
          options={[
            { value: '', label: 'Select owner company' },
            ...(ownerCompaniesQuery.data || [])
              .filter((entry) => entry.isActive)
              .map((entry) => ({
                value: entry.ownerCompanyId,
                label: `${entry.code} - ${entry.displayName}`
              }))
          ]}
          disabled={ownerCompaniesQuery.isLoading || bulkTransferMutation.isPending}
        />
      </div>

      <TextArea
        label="Film Box IDs"
        value={filmBoxIdsText}
        onChange={(event) => {
          setFilmBoxIdsText(event.target.value);
          setConfirming(false);
        }}
        rows={5}
        placeholder="IL1-1001&#10;MS1-2002"
        hint="One exact BoxID per line or comma-separated. No wildcards."
        disabled={bulkTransferMutation.isPending}
      />

      <TextArea
        label="Caulk Stock IDs"
        value={caulkStockIdsText}
        onChange={(event) => {
          setCaulkStockIdsText(event.target.value);
          setConfirming(false);
        }}
        rows={5}
        placeholder="stock UUID"
        hint="Use exact caulk stock row IDs from Caulk Details or fixture data. No product/warehouse wildcards."
        disabled={bulkTransferMutation.isPending}
      />

      <TextArea
        label="Transfer Note"
        value={note}
        onChange={(event) => setNote(event.target.value)}
        rows={3}
        hint="Optional note stored with each ownership event."
        disabled={bulkTransferMutation.isPending}
      />

      <div className="notice-card">
        {confirming ? (
          <p>
            Confirm transfer of {filmBoxIds.length} film box{filmBoxIds.length === 1 ? '' : 'es'} and{' '}
            {caulkStockIds.length} caulk stock row{caulkStockIds.length === 1 ? '' : 's'} to{' '}
            {selectedOwner ? `${selectedOwner.code} - ${selectedOwner.displayName}` : 'the selected owner'}.
          </p>
        ) : (
          <p>
            Review exact IDs before continuing. Ownership changes do not alter warehouse, status, LF, tube counts,
            allocations, or checkout/check-in state.
          </p>
        )}
      </div>

      <div className="detail-actions">
        {confirming ? (
          <Button type="button" variant="ghost" onClick={() => setConfirming(false)} disabled={bulkTransferMutation.isPending}>
            Back
          </Button>
        ) : null}
        <Button
          type="button"
          onClick={() => void handleSubmit()}
          loading={bulkTransferMutation.isPending}
          loadingLabel="Transferring..."
        >
          {confirming ? 'Confirm Transfer' : 'Review Transfer'}
        </Button>
      </div>
    </section>
  );
}

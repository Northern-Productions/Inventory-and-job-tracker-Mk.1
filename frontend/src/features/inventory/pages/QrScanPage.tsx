import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getBox } from '../../../api/features/inventoryClient';
import { Button } from '../../../components/Button';
import { Input } from '../../../components/Input';
import { useIsPhoneLayout } from '../../../hooks/useIsPhoneLayout';
import { QrScanner } from '../components/QrScanner';

export default function QrScanPage() {
  const navigate = useNavigate();
  const isPhoneLayout = useIsPhoneLayout();
  const [manualBoxId, setManualBoxId] = useState('');
  const [lookupError, setLookupError] = useState('');
  const [isResolving, setIsResolving] = useState(false);

  const goToBox = useCallback(
    async (boxId: string) => {
      const normalizedBoxId = boxId.trim();
      if (!normalizedBoxId) {
        return false;
      }

      setIsResolving(true);
      setLookupError('');

      try {
        const box = await getBox(normalizedBoxId);
        const target =
          box.status === 'CHECKED_OUT'
            ? `/inventory/${encodeURIComponent(box.boxId)}?scanAction=checkin`
            : `/inventory/${encodeURIComponent(box.boxId)}`;
        setManualBoxId('');
        navigate(target);
        return true;
      } catch (_error) {
        setLookupError(`Box ${normalizedBoxId} was not found.`);
        return false;
      } finally {
        setIsResolving(false);
      }
    },
    [navigate]
  );

  return (
    <>
      <section className="panel">
        <div className="page-hero-topline">
          <span className="eyebrow">Scan Workflow</span>
        </div>
        <div className="page-hero-title-row">
          <div className="page-hero-copy">
            <h2>Scan And Open Boxes</h2>
            <p className="muted-text">
              Use the camera for fast field lookups, or fall back to BoxID entry when a label is damaged.
            </p>
          </div>
        </div>
      </section>
      <div className="scan-workspace">
        <QrScanner onResolved={goToBox} />
        <section className="panel scan-manual-panel">
        <div className="panel-title-row">
          <div>
            <h2>Manual Lookup</h2>
            <p className="muted-text">Use this when camera access is blocked or the label is unreadable.</p>
          </div>
        </div>
        {lookupError ? <p className="error-text">{lookupError}</p> : null}
        <div className="toolbar-grid">
          <Input
            label="BoxID"
            value={manualBoxId}
            onChange={(event) => setManualBoxId(event.target.value)}
            placeholder="Enter BoxID"
          />
          <div className="page-actions">
            <Button
              type="button"
              fullWidth={isPhoneLayout}
              loading={isResolving}
              onClick={() => void goToBox(manualBoxId)}
              disabled={isResolving}
            >
              Open Box
            </Button>
          </div>
        </div>
        </section>
      </div>
    </>
  );
}

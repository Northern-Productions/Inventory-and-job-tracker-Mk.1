import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getBox } from '../../../api/features/inventoryClient';
import { QrScanner } from '../components/QrScanner';

export default function QrScanPage() {
  const navigate = useNavigate();
  const [lookupError, setLookupError] = useState('');

  const goToBox = useCallback(
    async (boxId: string) => {
      const normalizedBoxId = boxId.trim();
      if (!normalizedBoxId) {
        return false;
      }

      setLookupError('');

      try {
        const box = await getBox(normalizedBoxId);
        const target =
          box.status === 'CHECKED_OUT'
            ? `/inventory/${encodeURIComponent(box.boxId)}?scanAction=checkin`
            : `/inventory/${encodeURIComponent(box.boxId)}`;
        navigate(target);
        return true;
      } catch (_error) {
        setLookupError(`Box ${normalizedBoxId} was not found.`);
        return false;
      }
    },
    [navigate]
  );

  return (
    <>
      <section className="panel scan-page-header">
        <span className="eyebrow">Scan Workflow</span>
        <h2 className="scan-page-heading">Scan And Open Boxes</h2>
      </section>
      <div className="scan-workspace">
        <QrScanner onResolved={goToBox} />
        {lookupError ? <p className="error-text scan-lookup-error">{lookupError}</p> : null}
      </div>
    </>
  );
}

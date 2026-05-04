import { Button } from '../../../../components/Button';
import type { Box } from '../../../../domain';
import { formatDate } from '../../../../lib/date';
import { LabelDraftEditor } from './LabelDraftEditor';
import {
  getLabelDisplayBoxId,
  type LabelDraft,
  type LabelSlot
} from '../../utils/labelMaker';

interface LabelSlotPanelProps {
  slot: LabelSlot;
  box: Box | null;
  draft: LabelDraft;
  warnings: string[];
  disabled?: boolean;
  onDraftChange: (slot: LabelSlot, field: keyof LabelDraft, value: string) => void;
  onClear: (slot: LabelSlot) => void;
}

export function LabelSlotPanel({
  slot,
  box,
  draft,
  warnings,
  disabled = false,
  onDraftChange,
  onClear
}: LabelSlotPanelProps) {
  const displayBoxId = box ? getLabelDisplayBoxId(box) : '';

  return (
    <section className="panel label-slot-panel" aria-labelledby={`label-slot-${slot}-title`}>
      <div className="panel-title-row label-slot-title-row">
        <div>
          <p className="eyebrow">Label {slot}</p>
          <h2 id={`label-slot-${slot}-title`}>
            {box ? displayBoxId : 'No box selected'}
          </h2>
        </div>
        <div className="page-actions label-slot-actions">
          <Button type="button" variant="ghost" onClick={() => onClear(slot)} disabled={!box}>
            Clear Selected Box
          </Button>
        </div>
      </div>

      {box ? (
        <div className="label-selected-box-summary" aria-label={`Selected box summary for Label ${slot}`}>
          <div className="key-value">
            <dt>Digital Box ID</dt>
            <dd>{displayBoxId}</dd>
          </div>
          <div className="key-value">
            <dt>Warehouse</dt>
            <dd>{box.warehouse}</dd>
          </div>
          <div className="key-value">
            <dt>Manufacturer</dt>
            <dd>{box.manufacturer || '--'}</dd>
          </div>
          <div className="key-value">
            <dt>Film</dt>
            <dd>{box.filmName || '--'}</dd>
          </div>
          <div className="key-value">
            <dt>Width</dt>
            <dd>{box.widthIn || '--'}</dd>
          </div>
          <div className="key-value">
            <dt>Lot Run</dt>
            <dd>{box.lotRun || '--'}</dd>
          </div>
          <div className="key-value">
            <dt>Status</dt>
            <dd>{box.status}</dd>
          </div>
          <div className="key-value">
            <dt>Last Weighed</dt>
            <dd>{formatDate(box.lastWeighedDate)}</dd>
          </div>
        </div>
      ) : (
        <p className="muted-text">Choose a box from the matching results before printing this label.</p>
      )}

      {warnings.length ? (
        <div className="label-warning-list" aria-label={`Label ${slot} warnings`}>
          {warnings.map((warning) => (
            <p key={warning} className="label-warning">
              {warning}
            </p>
          ))}
        </div>
      ) : null}

      <LabelDraftEditor
        draft={draft}
        disabled={disabled || !box}
        onChange={(field, value) => onDraftChange(slot, field, value)}
      />
    </section>
  );
}

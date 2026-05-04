import { Button } from '../../../../components/Button';
import { DeferredLoadingState } from '../../../../components/DeferredLoadingState';
import type { Box } from '../../../../domain';
import { getPhysicalStockFeet } from '../../../../domain';
import { formatDate } from '../../../../lib/date';
import { getLabelDisplayBoxId, type LabelSlot } from '../../utils/labelMaker';

interface LabelBoxPickerProps {
  boxes: Box[];
  totalCount: number;
  hasSearchTerm: boolean;
  loading: boolean;
  error: Error | null;
  selectedBoxesBySlot: Record<LabelSlot, Box | null>;
  onRetry: () => void;
  onSelect: (slot: LabelSlot, box: Box) => void;
}

function isSameBox(left: Box | null, right: Box): boolean {
  return Boolean(left && left.boxId === right.boxId && left.warehouse === right.warehouse);
}

export function LabelBoxPicker({
  boxes,
  totalCount,
  hasSearchTerm,
  loading,
  error,
  selectedBoxesBySlot,
  onRetry,
  onSelect
}: LabelBoxPickerProps) {
  return (
    <section className="panel label-box-picker">
      <div className="panel-title-row">
        <div>
          <h2>Matching Boxes</h2>
          <p className="muted-text">
            Pick carefully. Labels show the local Box ID, but search results keep the full digital Box ID visible.
          </p>
        </div>
        {!loading && !error && hasSearchTerm ? (
          <span className="muted-text">
            {totalCount > boxes.length
              ? `Showing ${boxes.length} of ${totalCount}`
              : `${totalCount} box(es)`}
          </span>
        ) : null}
      </div>

      <DeferredLoadingState when={loading} label="Loading inventory..." />

      {error ? (
        <div className="error-text">
          {error.message || 'The inventory could not be loaded.'}
          <div className="page-actions">
            <Button type="button" variant="ghost" onClick={onRetry}>
              Retry
            </Button>
          </div>
        </div>
      ) : null}

      {!loading && !error && !hasSearchTerm ? (
        <div className="empty-state">Search by Box ID, manufacturer, film, width, or lot run to find labels.</div>
      ) : null}

      {!loading && !error && hasSearchTerm && boxes.length === 0 ? (
        <div className="empty-state">No boxes matched the current search and filters.</div>
      ) : null}

      {!loading && !error && hasSearchTerm && boxes.length > 0 ? (
        <div className="table-wrap label-results-wrap">
          <table className="inventory-table label-results-table">
            <colgroup>
              <col className="label-results-col-id" />
              <col className="label-results-col-manufacturer" />
              <col className="label-results-col-film" />
              <col className="label-results-col-width" />
              <col className="label-results-col-lot-run" />
              <col className="label-results-col-status" />
              <col className="label-results-col-on-hand" />
              <col className="label-results-col-last-weighed" />
              <col className="label-results-col-use" />
            </colgroup>
            <thead>
              <tr>
                <th>Box ID</th>
                <th>Manufacturer</th>
                <th>Film</th>
                <th>Width</th>
                <th className="label-results-lot-run-header">Lot Run</th>
                <th>Status</th>
                <th>On Hand</th>
                <th>Last Weighed</th>
                <th className="label-results-use-cell">Use</th>
              </tr>
            </thead>
            <tbody>
              {boxes.map((box) => {
                const isSelectedForA = isSameBox(selectedBoxesBySlot.A, box);
                const isSelectedForB = isSameBox(selectedBoxesBySlot.B, box);
                const lotRun = box.lotRun || '--';

                return (
                  <tr key={`${box.warehouse}:${box.boxId}`}>
                    <td>{getLabelDisplayBoxId(box)}</td>
                    <td>{box.manufacturer || '--'}</td>
                    <td>{box.filmName || '--'}</td>
                    <td>{box.widthIn || '--'}</td>
                    <td className="label-results-lot-run-cell" title={lotRun} aria-label={`Lot run ${lotRun}`}>
                      <span className="label-results-lot-run-text">{lotRun}</span>
                    </td>
                    <td>
                      <span className={`badge badge-${box.status}`}>{box.status}</span>
                    </td>
                    <td>{getPhysicalStockFeet(box)}</td>
                    <td>{formatDate(box.lastWeighedDate)}</td>
                    <td className="label-results-use-cell">
                      <div className="label-result-actions">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className={isSelectedForA ? 'label-result-button-selected' : ''}
                          aria-pressed={isSelectedForA}
                          onClick={() => onSelect('A', box)}
                        >
                          Label A
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className={isSelectedForB ? 'label-result-button-selected' : ''}
                          aria-pressed={isSelectedForB}
                          onClick={() => onSelect('B', box)}
                        >
                          Label B
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

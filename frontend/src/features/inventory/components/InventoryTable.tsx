import type { Box } from '../../../domain';
import { formatDate } from '../../../lib/date';
import { isLowStockBox } from '../utils/boxHelpers';

interface InventoryTableProps {
  boxes: Box[];
  onSelect: (boxId: string) => void;
}

export function InventoryTable({ boxes, onSelect }: InventoryTableProps) {
  if (!boxes.length) {
    return <div className="empty-state">No boxes matched the current filters.</div>;
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>BoxID</th>
            <th>Manufacturer</th>
            <th>Film</th>
            <th>Width</th>
            <th>Linear Ft</th>
            <th>Available</th>
            <th>Lot</th>
            <th>Status</th>
            <th>Ordered</th>
            <th>Received</th>
            <th>Last Weighed</th>
          </tr>
        </thead>
        <tbody>
          {boxes.map((box) => (
            <tr key={box.boxId}>
              <td>
                <button className="row-button" type="button" onClick={() => onSelect(box.boxId)}>
                  {box.boxId}
                </button>
              </td>
              <td>{box.manufacturer}</td>
              <td>{box.filmName}</td>
              <td>{box.widthIn}</td>
              <td>{box.initialFeet}</td>
              <td>
                <div className="stock-cell">
                  <span>{box.feetAvailable}</span>
                  {isLowStockBox(box) ? <span className="stock-flag stock-flag-low">LOW STOCK</span> : null}
                </div>
              </td>
              <td>{box.lotRun || '--'}</td>
              <td>
                <span className={`badge badge-${box.status}`}>{box.status}</span>
              </td>
              <td>{formatDate(box.orderDate)}</td>
              <td>{formatDate(box.receivedDate)}</td>
              <td>{formatDate(box.lastWeighedDate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

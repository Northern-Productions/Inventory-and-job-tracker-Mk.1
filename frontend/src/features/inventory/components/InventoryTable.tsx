import { Button } from '../../../components/Button';
import {
  MobileActionStack,
  MobileField,
  MobileFieldList,
  MobileRecordCard,
  MobileRecordHeader
} from '../../../components/MobileRecordCard';
import type { Box } from '../../../domain';
import { useIsPhoneLayout } from '../../../hooks/useIsPhoneLayout';
import { formatDate } from '../../../lib/date';
import { isLowStockBox } from '../utils/boxHelpers';

interface InventoryTableProps {
  boxes: Box[];
  onSelect: (boxId: string) => void;
}

export function InventoryTable({ boxes, onSelect }: InventoryTableProps) {
  const isPhoneLayout = useIsPhoneLayout();

  if (!boxes.length) {
    return <div className="empty-state">No boxes matched the current filters.</div>;
  }

  if (isPhoneLayout) {
    return (
      <div className="mobile-record-list">
        {boxes.map((box) => (
          <MobileRecordCard key={box.boxId}>
            <MobileRecordHeader
              title={box.boxId}
              subtitle={`${box.manufacturer} ${box.filmName}`}
              badge={<span className={`badge badge-${box.status}`}>{box.status}</span>}
              onTitleClick={() => onSelect(box.boxId)}
            />
            <MobileFieldList>
              <MobileField label="Warehouse" value={box.warehouse} />
              <MobileField label="Width" value={box.widthIn} />
              <MobileField label="Initial LF" value={box.initialFeet} />
              <MobileField
                label="Available LF"
                value={
                  isLowStockBox(box) ? (
                    <>
                      {box.feetAvailable} <span className="stock-flag stock-flag-low">LOW STOCK</span>
                    </>
                  ) : (
                    box.feetAvailable
                  )
                }
              />
              <MobileField label="Lot" value={box.lotRun || '--'} />
              <MobileField label="Ordered" value={formatDate(box.orderDate)} />
              <MobileField label="Received" value={formatDate(box.receivedDate)} />
              <MobileField label="Last Weighed" value={formatDate(box.lastWeighedDate)} />
            </MobileFieldList>
            <MobileActionStack>
              <Button type="button" variant="ghost" onClick={() => onSelect(box.boxId)}>
                Open Box
              </Button>
            </MobileActionStack>
          </MobileRecordCard>
        ))}
      </div>
    );
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

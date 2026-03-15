import type { CSSProperties } from 'react';
import { useMemo } from 'react';
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
  const boxIdColumnWidth = useMemo(() => {
    const longest = boxes.reduce((maxLength, box) => Math.max(maxLength, box.boxId.length), 0);
    return `${Math.max(longest + 2, 8)}ch`;
  }, [boxes]);
  const tableStyle = useMemo(
    () =>
      ({
        '--box-id-col-width': boxIdColumnWidth
      }) as CSSProperties,
    [boxIdColumnWidth]
  );

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
              <MobileField label="On Hand Linear Ft" value={box.initialFeet} />
              <MobileField
                label="Available Linear Ft"
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
      <table className="inventory-table" style={tableStyle}>
        <thead>
          <tr>
            <th className="col-box-id">BoxID</th>
            <th>Manufacturer</th>
            <th>Film</th>
            <th>Width</th>
            <th className="col-on-hand-linear-ft">
              On Hand
              <br />
              Linear Ft
            </th>
            <th className="col-available-linear-ft">Available Linear Ft</th>
            <th>Status</th>
            <th>Last Weighed</th>
          </tr>
        </thead>
        <tbody>
          {boxes.map((box) => (
            <tr key={box.boxId}>
              <td className="col-box-id">
                <button className="row-button" type="button" onClick={() => onSelect(box.boxId)}>
                  {box.boxId}
                </button>
              </td>
              <td>{box.manufacturer}</td>
              <td>{box.filmName}</td>
              <td>{box.widthIn}</td>
              <td className="col-on-hand-linear-ft">{box.initialFeet}</td>
              <td className="col-available-linear-ft">
                <div className="stock-cell">
                  <span>{box.feetAvailable}</span>
                  {isLowStockBox(box) ? <span className="stock-flag stock-flag-low">LOW STOCK</span> : null}
                </div>
              </td>
              <td>
                <span className={`badge badge-${box.status}`}>{box.status}</span>
              </td>
              <td>{formatDate(box.lastWeighedDate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

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
import { getAllocatableStockFeet, getPhysicalStockFeet } from '../../../domain';
import type { Box } from '../../../domain';
import { useIsPhoneLayout } from '../../../hooks/useIsPhoneLayout';
import { formatDate } from '../../../lib/date';
import { formatBoxIdWithWarehousePrefix, isLowStockBox } from '../utils/boxHelpers';

interface InventoryTableProps {
  boxes: Box[];
  onSelect: (boxId: string) => void;
}

export function InventoryTable({ boxes, onSelect }: InventoryTableProps) {
  const isPhoneLayout = useIsPhoneLayout();
  const displayBoxIds = useMemo(
    () => boxes.map((box) => formatBoxIdWithWarehousePrefix(box.boxId, box.warehouse)),
    [boxes]
  );
  const boxIdColumnWidth = useMemo(() => {
    const longest = displayBoxIds.reduce((maxLength, value) => Math.max(maxLength, value.length), 0);
    return `${Math.max(longest + 2, 8)}ch`;
  }, [displayBoxIds]);
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
        {boxes.map((box, index) => {
          const displayBoxId = displayBoxIds[index] || box.boxId;
          const physicalStockFeet = getPhysicalStockFeet(box);
          const allocatableStockFeet = getAllocatableStockFeet(box);
          const lowStockBadge = isLowStockBox(box) ? (
            <span className="stock-flag stock-flag-low">LOW STOCK</span>
          ) : null;

          return (
            <MobileRecordCard key={box.boxId}>
              <MobileRecordHeader
                title={displayBoxId}
                subtitle={`${box.manufacturer} ${box.filmName}`}
                badge={<span className={`badge badge-${box.status}`}>{box.status}</span>}
                onTitleClick={() => onSelect(displayBoxId)}
              />
              <MobileFieldList>
                <MobileField label="Warehouse" value={box.warehouse} />
                <MobileField label="Width" value={box.widthIn} />
                <MobileField
                  label="On Hand Linear Ft"
                  value={
                    lowStockBadge ? (
                      <>
                        {physicalStockFeet} {lowStockBadge}
                      </>
                    ) : (
                      physicalStockFeet
                    )
                  }
                />
                <MobileField label="Available Linear Ft" value={allocatableStockFeet} />
                <MobileField label="Last Weighed" value={formatDate(box.lastWeighedDate)} />
                <MobileField label="Dealer" value={box.dealer || '--'} />
              </MobileFieldList>
              <MobileActionStack>
                <Button type="button" variant="ghost" onClick={() => onSelect(displayBoxId)}>
                  Open Box
                </Button>
              </MobileActionStack>
            </MobileRecordCard>
          );
        })}
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
            <th>Dealer</th>
          </tr>
        </thead>
        <tbody>
          {boxes.map((box, index) => {
            const displayBoxId = displayBoxIds[index] || box.boxId;
            const physicalStockFeet = getPhysicalStockFeet(box);
            const allocatableStockFeet = getAllocatableStockFeet(box);
            const lowStockBadge = isLowStockBox(box) ? (
              <span className="stock-flag stock-flag-low">LOW STOCK</span>
            ) : null;

            return (
              <tr key={box.boxId}>
                <td className="col-box-id">
                  <button className="row-button" type="button" onClick={() => onSelect(displayBoxId)}>
                    {displayBoxId}
                  </button>
                </td>
                <td>{box.manufacturer}</td>
                <td>{box.filmName}</td>
                <td>{box.widthIn}</td>
                <td className="col-on-hand-linear-ft">
                  <div className="stock-cell">
                    <span>{physicalStockFeet}</span>
                    {lowStockBadge}
                  </div>
                </td>
                <td className="col-available-linear-ft">{allocatableStockFeet}</td>
                <td>
                  <span className={`badge badge-${box.status}`}>{box.status}</span>
                </td>
                <td>{formatDate(box.lastWeighedDate)}</td>
                <td>{box.dealer || '--'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

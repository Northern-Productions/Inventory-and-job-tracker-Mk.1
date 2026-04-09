import { formatPlannedFeet } from './helpers';

interface AllocationCandidate {
  boxId: string;
  manufacturer: string;
  filmName: string;
  widthIn: number;
  allocationPlanningFeet: number;
  status: string;
}

function formatBoxStatusLabel(status: string) {
  return status.replace(/_/g, ' ');
}

interface AllocationPlanTableProps {
  boxes: AllocationCandidate[];
  requestedFeetValue: number;
  coveredFeet: number;
  remainingFeet: number;
  selectedBoxIds: string[];
  plannedFeetByBox: Map<string, { allocatedFeet: number; coveredFeet: number }>;
  onToggleBox: (boxId: string) => void;
}

export function AllocationPlanTable({
  boxes,
  requestedFeetValue,
  coveredFeet,
  remainingFeet,
  selectedBoxIds,
  plannedFeetByBox,
  onToggleBox
}: AllocationPlanTableProps) {
  return (
    <div className="allocation-preview">
      <div className="stat-grid allocation-stat-grid">
        <div className="key-value">
          <dt>Requested</dt>
          <dd>{requestedFeetValue}</dd>
        </div>
        <div className="key-value">
          <dt>Covered</dt>
          <dd>{coveredFeet}</dd>
        </div>
        <div className="key-value">
          <dt>Still Short</dt>
          <dd>{remainingFeet}</dd>
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Use</th>
              <th>Box</th>
              <th>Manufacturer</th>
              <th>Film Name</th>
              <th>Width</th>
              <th>Status</th>
              <th>Planning LF</th>
              <th>Planned LF</th>
            </tr>
          </thead>
          <tbody>
            {boxes.map((box) => (
              <tr
                key={box.boxId}
                className={selectedBoxIds.includes(box.boxId) ? 'allocation-selected-row' : undefined}
                onClick={() => onToggleBox(box.boxId)}
              >
                <td>
                  <input
                    type="checkbox"
                    checked={selectedBoxIds.includes(box.boxId)}
                    onClick={(event) => event.stopPropagation()}
                    onChange={() => onToggleBox(box.boxId)}
                  />
                </td>
                <td>{box.boxId}</td>
                <td>{box.manufacturer}</td>
                <td>{box.filmName}</td>
                <td>{box.widthIn}</td>
                <td>
                  <span className={`badge badge-${box.status}`}>{formatBoxStatusLabel(box.status)}</span>
                </td>
                <td>{box.allocationPlanningFeet}</td>
                <td>
                  {plannedFeetByBox.has(box.boxId)
                    ? formatPlannedFeet(
                        plannedFeetByBox.get(box.boxId)?.allocatedFeet || 0,
                        plannedFeetByBox.get(box.boxId)?.coveredFeet || 0
                      )
                    : '0'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

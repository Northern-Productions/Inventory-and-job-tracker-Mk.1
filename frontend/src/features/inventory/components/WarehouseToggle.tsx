import type { Warehouse } from '../../../domain';

interface WarehouseToggleProps {
  value: Warehouse;
  onChange: (warehouse: Warehouse) => void;
}

export function WarehouseToggle({ value, onChange }: WarehouseToggleProps) {
  return (
    <div className="toggle-group" role="tablist" aria-label="Warehouse">
      {(['IL', 'MS'] as const).map((warehouse) => (
        <button
          key={warehouse}
          type="button"
          className={`toggle-button ${value === warehouse ? 'toggle-button-active' : ''}`.trim()}
          onClick={() => onChange(warehouse)}
        >
          {warehouse === 'IL' ? 'Illinois' : 'Mississippi'}
        </button>
      ))}
    </div>
  );
}

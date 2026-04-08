import { Input } from '../../../../components/Input';
import type { BoxDraft } from '../../utils/boxHelpers';

interface DatesAndCostingSectionProps {
  draft: BoxDraft;
  pricePerLfHint?: string;
  shouldAutoDerivePricePerLf: boolean;
  onOrderDateChange: (value: string) => void;
  onPricePerLfChange: (value: string) => void;
  onPurchaseCostChange: (value: string) => void;
  onReceivedDateChange: (value: string) => void;
}

export function DatesAndCostingSection({
  draft,
  pricePerLfHint,
  shouldAutoDerivePricePerLf,
  onOrderDateChange,
  onPricePerLfChange,
  onPurchaseCostChange,
  onReceivedDateChange
}: DatesAndCostingSectionProps) {
  return (
    <div className="form-section">
      <div className="form-section-header">
        <h3>Dates And Costing</h3>
        <p className="muted-text">Capture order timing, purchase cost, and derived pricing.</p>
      </div>
      <div className="form-grid">
        <Input
          label="Price / LF"
          type="number"
          step="0.0001"
          min="0"
          value={draft.pricePerLf}
          onChange={(event) => onPricePerLfChange(event.target.value)}
          readOnly={shouldAutoDerivePricePerLf}
          disabled={shouldAutoDerivePricePerLf}
          hint={pricePerLfHint}
        />
        <Input
          label="Purchase Cost"
          type="number"
          step="0.01"
          min="0"
          value={draft.purchaseCost}
          onChange={(event) => onPurchaseCostChange(event.target.value)}
        />
        <Input
          label="Order Date"
          type="date"
          value={draft.orderDate}
          onChange={(event) => onOrderDateChange(event.target.value)}
          required
        />
        <Input
          label="Received Date"
          type="date"
          value={draft.receivedDate}
          onChange={(event) => onReceivedDateChange(event.target.value)}
        />
      </div>
    </div>
  );
}

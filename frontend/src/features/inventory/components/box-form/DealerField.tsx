import { Input } from '../../../../components/Input';
import { ADD_NEW_DEALER_OPTION } from './dealerFieldUtils';

interface DealerFieldProps {
  dealerHint?: string;
  dealerOptions: string[];
  dealerSelectValue: string;
  dealerValue: string;
  isCustomDealerSelected: boolean;
  onDealerInputChange: (value: string) => void;
  onDealerSelectChange: (value: string) => void;
  selectLabel?: string;
  selectPlaceholder?: string;
  customDealerLabel?: string;
  customDealerPlaceholder?: string;
  autoFocusSelect?: boolean;
}

export function DealerField({
  dealerHint,
  dealerOptions,
  dealerSelectValue,
  dealerValue,
  isCustomDealerSelected,
  onDealerInputChange,
  onDealerSelectChange,
  selectLabel = 'Dealer',
  selectPlaceholder = 'Select dealer',
  customDealerLabel = 'New Dealer',
  customDealerPlaceholder = 'Enter dealer name',
  autoFocusSelect = false
}: DealerFieldProps) {
  return (
    <>
      <label className="field">
        <span className="field-label">{selectLabel}</span>
        <select
          className="field-input"
          value={dealerSelectValue}
          onChange={(event) => onDealerSelectChange(event.target.value)}
          autoFocus={autoFocusSelect}
        >
          <option value="">{selectPlaceholder}</option>
          {dealerOptions.map((entry) => (
            <option key={entry} value={entry}>
              {entry}
            </option>
          ))}
          <option value={ADD_NEW_DEALER_OPTION}>Add New Dealer</option>
        </select>
        {dealerHint ? <span className="field-hint">{dealerHint}</span> : null}
      </label>
      {isCustomDealerSelected ? (
        <Input
          label={customDealerLabel}
          value={dealerValue}
          onChange={(event) => onDealerInputChange(event.target.value)}
          placeholder={customDealerPlaceholder}
        />
      ) : null}
    </>
  );
}

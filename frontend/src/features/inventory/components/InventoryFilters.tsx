import { Select } from '../../../components/Select';
import type { InventoryFilterValues } from '../schemas/boxSchemas';
import { InventorySearchAutocompleteInput } from './InventorySearchAutocompleteInput';
import type { InventorySearchSuggestion } from '../utils/inventorySearchSuggestions';
import { WarehouseSelectField } from './WarehouseSelectField';
import { WidthFilterField } from './WidthFilterField';

interface InventoryFiltersProps {
  values: InventoryFilterValues;
  manufacturerOptions: string[];
  searchSuggestions: InventorySearchSuggestion[];
  rememberedCustomWidth: string;
  onRememberedCustomWidthChange: (value: string) => void;
  onChange: (next: Partial<InventoryFilterValues>) => void;
}

export function InventoryFilters({
  values,
  manufacturerOptions,
  searchSuggestions,
  rememberedCustomWidth,
  onRememberedCustomWidthChange,
  onChange
}: InventoryFiltersProps) {
  return (
    <>
      <div className="filters-grid">
        <WarehouseSelectField
          label="Warehouse"
          value={values.warehouse}
          onChange={(warehouse) => onChange({ warehouse })}
          allowAll
        />
        <Select
          label="Manufacturer"
          value={values.manufacturer}
          onChange={(event) => onChange({ manufacturer: event.target.value })}
          options={[
            { label: 'All', value: '' },
            ...manufacturerOptions.map((manufacturer) => ({
              label: manufacturer,
              value: manufacturer
            }))
          ]}
        />
        <InventorySearchAutocompleteInput
          label="Search"
          value={values.q}
          suggestions={searchSuggestions}
          onChange={(value) => onChange({ q: value })}
          placeholder="BoxID, film"
        />
        <Select
          label="Status"
          value={values.status}
          onChange={(event) =>
            onChange({
              status: event.target.value as InventoryFilterValues['status']
            })
          }
          options={[
            { label: 'All', value: '' },
            { label: 'Ordered', value: 'ORDERED' },
            { label: 'In Stock', value: 'IN_STOCK' },
            { label: 'Checked Out', value: 'CHECKED_OUT' },
            { label: 'Transfer', value: 'TRANSFER' },
            { label: 'Zeroed', value: 'ZEROED' }
          ]}
        />
        <WidthFilterField
          widths={values.widths}
          rememberedCustomWidth={rememberedCustomWidth}
          onWidthsChange={(widths) => onChange({ widths })}
          onRememberedCustomWidthChange={onRememberedCustomWidthChange}
          className="inventory-width-selector"
          dialogTitle="Custom Width"
          dialogTitleId="inventory-custom-width-title"
        />
      </div>
    </>
  );
}

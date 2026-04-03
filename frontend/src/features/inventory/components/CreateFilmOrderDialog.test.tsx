import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CreateFilmOrderDialog } from './CreateFilmOrderDialog';

vi.mock('../hooks/useWarehouseRegistry', () => ({
  useWarehouseRegistry: () => ({
    entries: [{ code: 'IL1', name: 'Wauconda IL1' }]
  })
}));

vi.mock('./WarehouseSelectField', () => ({
  WarehouseSelectField: ({ label }: { label: string }) => (
    <label className="field">
      <span className="field-label">{label}</span>
      <select className="field-input">
        <option>Wauconda IL1</option>
      </select>
    </label>
  )
}));

describe('CreateFilmOrderDialog', () => {
  it('renders width selector chips with 36 active by default', () => {
    const html = renderToStaticMarkup(
      <CreateFilmOrderDialog
        open
        filmCatalogEntries={[]}
        onCancel={() => undefined}
        onSubmit={() => undefined}
      />
    );

    expect(html).toContain('width-button-grid');
    expect(html).toContain('width-chip width-chip-active');
    expect(html).toContain('>36</button>');
    expect(html).toContain('>Cust.</button>');
    expect(html).not.toContain('type="number"');
  });
});

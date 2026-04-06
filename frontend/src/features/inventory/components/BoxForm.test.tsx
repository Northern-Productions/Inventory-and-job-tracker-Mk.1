import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createEmptyBoxDraft } from '../utils/boxHelpers';
import { BoxForm } from './BoxForm';

const useWarehouseRegistryMock = vi.fn();

vi.mock('../hooks/useWarehouseRegistry', () => ({
  useWarehouseRegistry: () => useWarehouseRegistryMock()
}));

vi.mock('./FilmNameAutocompleteInput', () => ({
  FilmNameAutocompleteInput: ({ label }: { label: string }) => (
    <input aria-label={label} data-testid="film-name-autocomplete" />
  )
}));

describe('BoxForm', () => {
  beforeEach(() => {
    useWarehouseRegistryMock.mockReturnValue({
      entries: [
        { code: 'IL1', name: 'Wauconda IL1', boxIdPrefix: 'IL1' },
        { code: 'MS1', name: 'Ridgeland MS1', boxIdPrefix: 'MS1' }
      ]
    });
  });

  it('shows Lot Run in create mode beside the Linear Feet field', () => {
    const html = renderToStaticMarkup(
      <BoxForm
        initialDraft={createEmptyBoxDraft()}
        resetKey="create-box"
        mode="create"
        submitLabel="Create Box"
        onSubmit={vi.fn()}
      />
    );

    expect(html).toContain('Linear Feet');
    expect(html).toContain('Lot Run');
  });

  it('renders the create-mode box id with the warehouse-prefixed suggested value', () => {
    const html = renderToStaticMarkup(
      <BoxForm
        initialDraft={{ ...createEmptyBoxDraft(), boxId: 'IL1-7001' }}
        resetKey="create-box-il1"
        mode="create"
        createWarehouse="IL1"
        nextBoxIdForCreateWarehouse="IL1-7001"
        submitLabel="Create Box"
        onSubmit={vi.fn()}
      />
    );

    expect(html).toContain('value="IL1-7001"');
    expect(html).toContain('>BoxID<');
  });

  it('keeps BoxID disabled in edit mode', () => {
    const html = renderToStaticMarkup(
      <BoxForm
        initialDraft={{ ...createEmptyBoxDraft(), boxId: 'IL1-7001' }}
        resetKey="edit-box"
        mode="edit"
        submitLabel="Save Changes"
        onSubmit={vi.fn()}
      />
    );

    expect(html).toContain('value="IL1-7001"');
    expect(html).toContain('disabled=""');
  });
});

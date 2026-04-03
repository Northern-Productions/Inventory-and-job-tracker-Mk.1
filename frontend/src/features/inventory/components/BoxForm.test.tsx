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
    useWarehouseRegistryMock.mockReturnValue({ entries: [] });
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
});

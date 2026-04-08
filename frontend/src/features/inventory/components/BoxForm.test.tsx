// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

afterEach(() => {
  cleanup();
});

function createEditDraft() {
  return {
    ...createEmptyBoxDraft('3M Solar'),
    boxId: 'IL1-6735',
    filmName: '3M S140',
    widthIn: '60',
    initialFeet: '100',
    currentFeetOnRoll: '50',
    feetAvailable: '50',
    lotRun: '54395+40',
    orderDate: '2026-03-22',
    receivedDate: '2026-03-30',
    initialWeightLbs: '51',
    lastRollWeightLbs: '26',
    lastWeighedDate: '2026-04-07',
    coreType: 'SECURITY 1/4" Cardboard',
    coreWeightLbs: '1',
    lfWeightLbsPerFt: '0.5'
  };
}

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

  it('auto-fills roll weight from current feet until the weight field is manually edited', () => {
    render(
      <BoxForm
        initialDraft={createEditDraft()}
        resetKey="edit-roll-tracking"
        mode="edit"
        preserveInitialFeetInEdit
        submitLabel="Save Changes"
        onSubmit={vi.fn()}
      />
    );

    const currentFeetInput = screen.getByLabelText('Current Linear Feet') as HTMLInputElement;
    const lastRollWeightInput = screen.getByLabelText('Last Roll Weight (lbs)') as HTMLInputElement;

    fireEvent.change(currentFeetInput, { target: { value: '40' } });
    expect(currentFeetInput.value).toBe('40');
    expect(lastRollWeightInput.value).toBe('21');

    fireEvent.change(lastRollWeightInput, { target: { value: '18' } });
    expect(lastRollWeightInput.value).toBe('18');
    expect(currentFeetInput.value).toBe('40');

    fireEvent.change(currentFeetInput, { target: { value: '35' } });
    expect(currentFeetInput.value).toBe('35');
    expect(lastRollWeightInput.value).toBe('18');

    fireEvent.change(lastRollWeightInput, { target: { value: '' } });
    expect(lastRollWeightInput.value).toBe('');
    expect(currentFeetInput.value).toBe('35');

    fireEvent.change(currentFeetInput, { target: { value: '30' } });
    expect(currentFeetInput.value).toBe('30');
    expect(lastRollWeightInput.value).toBe('');
  });

  it('keeps initial feet editable separately in received edit mode', () => {
    render(
      <BoxForm
        initialDraft={createEditDraft()}
        resetKey="edit-initial-feet"
        mode="edit"
        preserveInitialFeetInEdit
        submitLabel="Save Changes"
        onSubmit={vi.fn()}
      />
    );

    const initialFeetInput = screen.getByLabelText('Initial Linear Feet') as HTMLInputElement;
    const currentFeetInput = screen.getByLabelText('Current Linear Feet') as HTMLInputElement;

    expect(initialFeetInput.value).toBe('100');
    expect(currentFeetInput.value).toBe('50');

    fireEvent.change(initialFeetInput, { target: { value: '125' } });

    expect(initialFeetInput.value).toBe('125');
    expect(currentFeetInput.value).toBe('50');
  });

  it('auto-fills current feet from roll weight until the feet field is manually edited', () => {
    render(
      <BoxForm
        initialDraft={createEditDraft()}
        resetKey="edit-roll-weight"
        mode="edit"
        preserveInitialFeetInEdit
        submitLabel="Save Changes"
        onSubmit={vi.fn()}
      />
    );

    const currentFeetInput = screen.getByLabelText('Current Linear Feet') as HTMLInputElement;
    const lastRollWeightInput = screen.getByLabelText('Last Roll Weight (lbs)') as HTMLInputElement;

    fireEvent.change(lastRollWeightInput, { target: { value: '16' } });
    expect(lastRollWeightInput.value).toBe('16');
    expect(currentFeetInput.value).toBe('30');
  });
});

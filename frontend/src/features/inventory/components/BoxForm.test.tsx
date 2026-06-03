// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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

function createValidCreateDraft() {
  return {
    ...createEmptyBoxDraft('3M Solar'),
    boxId: 'IL1-7001',
    filmName: 'Prestige 60'
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

  it('shows saved dealers in the dropdown and reveals the inline field for a new dealer', () => {
    render(
      <BoxForm
        initialDraft={createEmptyBoxDraft()}
        resetKey="create-dealer"
        mode="create"
        submitLabel="Create Box"
        dealerEntries={[
          {
            dealerId: 'dealer-1',
            name: 'Eastman Performance Films',
            lookupKey: 'eastman-performance-films',
            updatedAt: '2026-04-18T10:00:00Z'
          }
        ]}
        onSubmit={vi.fn()}
      />
    );

    const dealerSelect = screen.getByRole('combobox', { name: /Dealer/ }) as HTMLSelectElement;
    expect(
      screen.getByRole('option', { name: 'Eastman Performance Films' }).getAttribute('value')
    ).toBe('Eastman Performance Films');

    fireEvent.change(dealerSelect, { target: { value: '__add_new_dealer__' } });

    expect((screen.getByRole('textbox', { name: /New Dealer/ }) as HTMLInputElement).value).toBe('');
  });

  it('opens the missing-dealer dialog in create mode instead of submitting immediately', () => {
    const onSubmit = vi.fn();

    render(
      <BoxForm
        initialDraft={createValidCreateDraft()}
        resetKey="create-missing-dealer"
        mode="create"
        submitLabel="Create Box"
        onSubmit={onSubmit}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Create Box' }));

    expect(
      screen.getByText(
        "You didn't enter the dealer this film was purchased through. Enter a dealer or explain why there is no dealer."
      )
    ).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('closes the missing-dealer dialog without submitting when cancelled', () => {
    const onSubmit = vi.fn();

    render(
      <BoxForm
        initialDraft={createValidCreateDraft()}
        resetKey="create-missing-dealer-cancel"
        mode="create"
        submitLabel="Create Box"
        onSubmit={onSubmit}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Create Box' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(
      screen.queryByText(
        "You didn't enter the dealer this film was purchased through. Enter a dealer or explain why there is no dealer."
      )
    ).toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('uses the dealer picked in the modal when the user submits with a saved dealer', () => {
    const onSubmit = vi.fn();

    render(
      <BoxForm
        initialDraft={createValidCreateDraft()}
        resetKey="create-missing-dealer-saved"
        mode="create"
        submitLabel="Create Box"
        dealerEntries={[
          {
            dealerId: 'dealer-1',
            name: 'Eastman Performance Films',
            lookupKey: 'eastman-performance-films',
            updatedAt: '2026-04-18T10:00:00Z'
          }
        ]}
        onSubmit={onSubmit}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Create Box' }));
    const dialog = within(screen.getByRole('dialog'));
    fireEvent.change(dialog.getByRole('combobox', { name: 'Dealer' }), {
      target: { value: 'Eastman Performance Films' }
    });
    fireEvent.click(dialog.getByRole('button', { name: 'Submit' }));

    const [submittedDraft, submitContext] = onSubmit.mock.calls[0];
    expect(submittedDraft).toEqual(expect.objectContaining({ dealer: 'Eastman Performance Films' }));
    expect(submitContext).toBeUndefined();
    expect((screen.getByRole('combobox', { name: /Dealer/ }) as HTMLSelectElement).value).toBe(
      'Eastman Performance Films'
    );
  });

  it('uses a newly entered dealer from the modal when the user adds one there', () => {
    const onSubmit = vi.fn();

    render(
      <BoxForm
        initialDraft={createValidCreateDraft()}
        resetKey="create-missing-dealer-custom"
        mode="create"
        submitLabel="Create Box"
        dealerEntries={[
          {
            dealerId: 'dealer-1',
            name: 'Eastman Performance Films',
            lookupKey: 'eastman-performance-films',
            updatedAt: '2026-04-18T10:00:00Z'
          }
        ]}
        onSubmit={onSubmit}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Create Box' }));
    const dialog = within(screen.getByRole('dialog'));
    fireEvent.change(dialog.getByRole('combobox', { name: 'Dealer' }), {
      target: { value: '__add_new_dealer__' }
    });
    fireEvent.change(dialog.getByRole('textbox', { name: 'New Dealer' }), {
      target: { value: 'Decorative Films' }
    });
    fireEvent.click(dialog.getByRole('button', { name: 'Submit' }));

    const [submittedDraft, submitContext] = onSubmit.mock.calls[0];
    expect(submittedDraft).toEqual(expect.objectContaining({ dealer: 'Decorative Films' }));
    expect(submitContext).toBeUndefined();
  });

  it('submits the default no-dealer audit note when the modal comment is left blank', () => {
    const onSubmit = vi.fn();

    render(
      <BoxForm
        initialDraft={createValidCreateDraft()}
        resetKey="create-missing-dealer-default-reason"
        mode="create"
        submitLabel="Create Box"
        onSubmit={onSubmit}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Create Box' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Submit' }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ dealer: '' }), {
      auditNote: 'No dealer for unknown reason.'
    });
  });

  it('submits the typed no-dealer comment when the modal reason is provided', () => {
    const onSubmit = vi.fn();

    render(
      <BoxForm
        initialDraft={createValidCreateDraft()}
        resetKey="create-missing-dealer-custom-reason"
        mode="create"
        submitLabel="Create Box"
        onSubmit={onSubmit}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Create Box' }));
    const dialog = within(screen.getByRole('dialog'));
    fireEvent.change(dialog.getByRole('textbox', { name: 'Comment' }), {
      target: { value: 'Transferred from legacy stock without dealer data.' }
    });
    fireEvent.click(dialog.getByRole('button', { name: 'Submit' }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ dealer: '' }), {
      auditNote: 'Transferred from legacy stock without dealer data.'
    });
  });

  it('does not open the missing-dealer dialog in edit mode', () => {
    const onSubmit = vi.fn();

    render(
      <BoxForm
        initialDraft={createEditDraft()}
        resetKey="edit-missing-dealer"
        mode="edit"
        submitLabel="Save Changes"
        onSubmit={onSubmit}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    expect(
      screen.queryByText(
        "You didn't enter the dealer this film was purchased through. Enter a dealer or explain why there is no dealer."
      )
    ).toBeNull();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ boxId: 'IL1-6735' }));
    expect(onSubmit.mock.calls[0]?.[1]).toBeUndefined();
  });

  it('places Transfer Box between Delete and Save Changes in edit mode', () => {
    const onTransferBox = vi.fn();

    render(
      <BoxForm
        initialDraft={createEditDraft()}
        resetKey="edit-action-row"
        mode="edit"
        submitLabel="Save Changes"
        onSubmit={vi.fn()}
        onDelete={vi.fn()}
        onTransferBox={onTransferBox}
      />
    );

    const actionLabels = within(document.querySelector('.form-actions') as HTMLElement)
      .getAllByRole('button')
      .map((button) => button.textContent?.trim());

    expect(actionLabels).toEqual(['Delete', 'Transfer Box', 'Save Changes']);

    fireEvent.click(screen.getByRole('button', { name: 'Transfer Box' }));

    expect(onTransferBox).toHaveBeenCalledTimes(1);
  });
});

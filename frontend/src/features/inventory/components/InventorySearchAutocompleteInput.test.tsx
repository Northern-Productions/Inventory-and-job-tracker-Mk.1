// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InventorySearchAutocompleteInput } from './InventorySearchAutocompleteInput';

const suggestions = [
  {
    boxId: 'IL1-6727',
    manufacturer: 'SOLYX',
    filmName: 'Frosted Stripes SXC-1418'
  },
  {
    boxId: 'IL1-6854',
    manufacturer: 'SOLYX',
    filmName: 'Frosted Stripes SXC-1418'
  },
  {
    boxId: 'IL1-6901',
    manufacturer: 'SOLYX',
    filmName: 'SX-1418 Frosted'
  }
];

afterEach(() => {
  cleanup();
});

describe('InventorySearchAutocompleteInput', () => {
  it('renders the provided top-three suggestions and supports keyboard selection', () => {
    const onChange = vi.fn();

    render(
      <InventorySearchAutocompleteInput
        label="Search"
        value="sx"
        suggestions={suggestions}
        onChange={onChange}
      />
    );

    const input = screen.getByLabelText('Search');
    fireEvent.focus(input);

    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(3);
    expect(options[0].textContent).toContain('IL1-6727');
    expect(options[1].textContent).toContain('IL1-6854');
    expect(options[2].textContent).toContain('IL1-6901');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getAllByRole('option')[0].getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getAllByRole('option')[1].getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith('IL1-6854');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('supports mouse selection and escape-to-close', () => {
    const onChange = vi.fn();

    render(
      <InventorySearchAutocompleteInput
        label="Search"
        value="sx"
        suggestions={suggestions}
        onChange={onChange}
      />
    );

    const input = screen.getByLabelText('Search');
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.mouseDown(screen.getAllByRole('option')[0]);
    expect(onChange).toHaveBeenLastCalledWith('IL1-6727');
  });
});

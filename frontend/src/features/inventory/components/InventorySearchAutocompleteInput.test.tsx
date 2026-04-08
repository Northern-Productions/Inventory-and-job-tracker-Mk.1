// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InventorySearchAutocompleteInput } from './InventorySearchAutocompleteInput';

const suggestions = [
  {
    suggestionKey: 'frosted stripes sxc-1418',
    filmName: 'Frosted Stripes SXC-1418'
  },
  {
    suggestionKey: 'sx-1418 frosted',
    filmName: 'SX-1418 Frosted'
  },
  {
    suggestionKey: 'sx-1418 privacy',
    filmName: 'SX-1418 Privacy'
  }
];

afterEach(() => {
  cleanup();
});

describe('InventorySearchAutocompleteInput', () => {
  it('renders the provided top-three film suggestions and supports keyboard selection', () => {
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
    expect(options[0].textContent).toContain('Frosted Stripes SXC-1418');
    expect(options[1].textContent).toContain('SX-1418 Frosted');
    expect(options[2].textContent).toContain('SX-1418 Privacy');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getAllByRole('option')[0].getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getAllByRole('option')[1].getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith('SX-1418 Frosted');
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
    expect(onChange).toHaveBeenLastCalledWith('Frosted Stripes SXC-1418');
  });
});

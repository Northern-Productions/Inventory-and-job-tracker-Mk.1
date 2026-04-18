// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { FilmOrderLinkedBoxes } from './FilmOrderLinkedBoxes';

describe('FilmOrderLinkedBoxes', () => {
  it('renders received indicators next to received ordered boxes only', () => {
    render(
      <MemoryRouter>
        <FilmOrderLinkedBoxes
          order={{
            linkedBoxes: [
              { boxId: 'IL1-0042', orderedFeet: 42, autoAllocatedFeet: 0, isReceived: true },
              { boxId: 'MS1-0100', orderedFeet: 10, autoAllocatedFeet: 0, isReceived: false }
            ]
          }}
        />
      </MemoryRouter>
    );

    expect(screen.getByRole('link', { name: 'IL1-0042' }).getAttribute('href')).toBe('/inventory/IL1-0042');
    expect(screen.getByRole('link', { name: 'MS1-0100' }).getAttribute('href')).toBe('/inventory/MS1-0100');
    expect(screen.getByLabelText('Received IL1-0042')).toBeTruthy();
    expect(screen.queryByLabelText('Received MS1-0100')).toBeNull();
  });

  it('renders the empty placeholder when no linked ordered boxes exist', () => {
    render(
      <MemoryRouter>
        <FilmOrderLinkedBoxes order={{ linkedBoxes: [] }} />
      </MemoryRouter>
    );

    expect(screen.getByText('--')).toBeTruthy();
  });
});

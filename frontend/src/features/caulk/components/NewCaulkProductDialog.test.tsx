// @vitest-environment jsdom

import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NewCaulkProductDialog } from './NewCaulkProductDialog';

describe('NewCaulkProductDialog', () => {
  afterEach(() => {
    cleanup();
  });

  it('uses clean owner company labels in the add caulk owner dropdown', () => {
    render(
      <NewCaulkProductDialog
        open
        pending={false}
        error=""
        manufacturers={[
          {
            manufacturerId: 'manufacturer-3m',
            name: '3M',
            lookupKey: '3m',
            isActive: true,
            updatedAt: '2026-06-26T00:00:00Z'
          }
        ]}
        warehouseEntries={[{ code: 'IL1', name: 'Wauconda IL1', boxIdPrefix: 'IL1' }]}
        ownerCompanies={[
          {
            ownerCompanyId: 'owner-mgt',
            code: 'MGT',
            displayName: 'MGT',
            lookupKey: 'mgt',
            isActive: true,
            createdAt: '2026-06-26T00:00:00Z',
            createdBy: 'tester',
            updatedAt: '2026-06-26T00:00:00Z',
            updatedBy: 'tester',
            deactivatedAt: '',
            deactivatedBy: ''
          },
          {
            ownerCompanyId: 'owner-edh',
            code: 'EDH',
            displayName: 'Example Display Name',
            lookupKey: 'edh',
            isActive: true,
            createdAt: '2026-06-26T00:00:00Z',
            createdBy: 'tester',
            updatedAt: '2026-06-26T00:00:00Z',
            updatedBy: 'tester',
            deactivatedAt: '',
            deactivatedBy: ''
          }
        ]}
        onClose={vi.fn()}
        onClearError={vi.fn()}
        onSubmit={vi.fn()}
      />
    );

    const ownerSelect = screen.getByRole('combobox', { name: 'Owner Company' });
    const optionLabels = within(ownerSelect)
      .getAllByRole('option')
      .map((option) => option.textContent?.trim());

    expect(optionLabels).toEqual([
      'Select owner company',
      'EDH - Example Display Name',
      'MGT'
    ]);
    expect(optionLabels).not.toContain('MGT - MGT');
  });
});

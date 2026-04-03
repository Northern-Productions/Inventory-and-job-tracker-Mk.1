import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LaborOnlyJobConfirmDialog } from './LaborOnlyJobConfirmDialog';

describe('LaborOnlyJobConfirmDialog', () => {
  it('shows only keep-editing and labor-only actions', () => {
    const html = renderToStaticMarkup(
      <LaborOnlyJobConfirmDialog
        open
        jobNumber="55555"
        onCancel={vi.fn()}
        onConfirmLaborOnly={vi.fn()}
      />
    );

    expect(html).toContain('Keep Editing');
    expect(html).toContain('Yes, Labor Only');
    expect(html).not.toContain('>No<');
  });
});

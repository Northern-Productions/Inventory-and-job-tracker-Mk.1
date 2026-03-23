import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DeleteConfirmDialog } from './DeleteConfirmDialog';

describe('DeleteConfirmDialog', () => {
  it('renders the soft-delete confirmation copy and typed unlock field', () => {
    const html = renderToStaticMarkup(
      <DeleteConfirmDialog
        open
        title="Delete Job"
        message="Delete job 4580? This action cannot be undone."
        onCancel={() => {}}
        onConfirm={() => {}}
      />
    );

    expect(html).toContain('Warning');
    expect(html).toContain('Delete Job');
    expect(html).toContain('Type &quot;delete&quot; to unlock delete');
    expect(html).toContain('placeholder="delete"');
    expect(html).toContain('Cancel');
  });
});

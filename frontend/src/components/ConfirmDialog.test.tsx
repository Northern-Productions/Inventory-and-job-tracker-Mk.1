import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConfirmDialog } from './ConfirmDialog';

describe('ConfirmDialog', () => {
  it('does not render when closed', () => {
    const html = renderToStaticMarkup(
      <ConfirmDialog
        open={false}
        title="Delete Box"
        message="This should not appear."
        confirmLabel="Delete"
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />
    );

    expect(html).toBe('');
  });

  it('renders the current reason-select flow when options are supplied', () => {
    const html = renderToStaticMarkup(
      <ConfirmDialog
        open
        title="Check Out Box"
        message="Choose the job that should receive this checkout."
        confirmLabel="Check Out"
        requireReason
        reasonLabel="Job Number"
        reasonSelectLabel="Allocated Job"
        reasonOptions={[
          { label: '1001', value: '1001' },
          { label: '1002', value: '1002' }
        ]}
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('Check Out Box');
    expect(html).toContain('Choose the job that should receive this checkout.');
    expect(html).toContain('<option value="1001" selected="">1001</option>');
    expect(html).toContain('<option value="1002">1002</option>');
    expect(html).toContain('Allocated Job');
  });

  it('keeps input-based reasons wired to the provided native attributes', () => {
    const html = renderToStaticMarkup(
      <ConfirmDialog
        open
        title="Confirm Risky Edit"
        message="A reason is required."
        confirmLabel="Confirm Save"
        requireReason
        reasonField="input"
        reasonLabel="Reason"
        reasonInputType="number"
        reasonInputStep="0.5"
        reasonInputMin="0"
        reasonInputMode="numeric"
        reasonInputPattern="[0-9]*"
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />
    );

    expect(html).toContain('type="number"');
    expect(html).toContain('step="0.5"');
    expect(html).toContain('min="0"');
    expect(html).toContain('inputMode="numeric"');
    expect(html).toContain('pattern="[0-9]*"');
  });

  it('renders pending confirmation state with disabled actions and busy affordance', () => {
    const html = renderToStaticMarkup(
      <ConfirmDialog
        open
        title="Order All Film"
        message="Create all remaining film orders?"
        confirmLabel="Create Orders"
        pending
        pendingLabel="Creating..."
        cancelLabel="Review Requirements"
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />
    );

    expect(html).toContain('Creating...');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('button-spinner');
    expect(html).toContain('Review Requirements</button>');
    expect(html).toContain('disabled=""');
  });
});

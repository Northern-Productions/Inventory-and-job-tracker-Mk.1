import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { JobEditorDialog } from './JobEditorDialog';

vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({
    isOwner: true,
    isAdmin: true,
    hasFeatureAccess: () => true
  })
}));

describe('JobEditorDialog', () => {
  it('uses the shared sticky footer action class for the final save row', () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          staleTime: Infinity
        }
      }
    });
    queryClient.setQueryData(['warehouses'], []);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <JobEditorDialog
          open
          mode="create"
          title="New Job"
          submitLabel="Save Job"
          filmCatalogEntries={[]}
          caulkProductEntries={[]}
          onCancel={() => undefined}
          onSubmit={() => undefined}
        />
      </QueryClientProvider>
    );

    expect(html).toContain('dialog-actions dialog-actions-sticky-footer');
    queryClient.clear();
  });
});

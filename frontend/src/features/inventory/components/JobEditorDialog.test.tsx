// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps, ReactElement } from 'react';
import { JobEditorDialog } from './JobEditorDialog';

vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({
    isOwner: true,
    isAdmin: true,
    hasFeatureAccess: () => true
  })
}));

vi.mock('../../../api/features/warehouseClient', () => ({
  addWarehouse: vi.fn(),
  listWarehouses: vi.fn(async () => [])
}));

function createQueryClient() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity
      }
    }
  });

  queryClient.setQueryData(['warehouses'], [
    {
      code: 'IL1',
      name: 'Wauconda IL1',
      boxIdPrefix: 'IL1'
    }
  ]);

  return queryClient;
}

function buildDialogTree(
  queryClient: QueryClient,
  props: Partial<ComponentProps<typeof JobEditorDialog>> = {}
): ReactElement {
  return (
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
        {...props}
      />
    </QueryClientProvider>
  );
}

afterEach(() => {
  cleanup();
});

describe('JobEditorDialog', () => {
  it('uses the shared sticky footer action class for the final save row', () => {
    const queryClient = createQueryClient();
    render(buildDialogTree(queryClient));

    expect(document.querySelector('.dialog-actions.dialog-actions-sticky-footer')).not.toBeNull();
    queryClient.clear();
  });

  it('preserves create-mode typing across rerenders with fresh empty arrays', () => {
    const queryClient = createQueryClient();
    const initialProps = {
      initialRequirements: [],
      initialCaulkRequirements: []
    };
    const view = render(buildDialogTree(queryClient, initialProps));

    const jobNumberInput = screen.getByPlaceholderText('000123') as HTMLInputElement;
    const sectionsInput = screen.getByRole('textbox', { name: /Work Scope/i }) as HTMLInputElement;
    const installDateInput = screen.getByLabelText(/Install Date/i) as HTMLInputElement;
    const crewLeaderInput = screen.getByRole('textbox', { name: /Crew Leader/i }) as HTMLInputElement;
    const filmNameInput = screen.getByRole('combobox', { name: /Film Name/i }) as HTMLInputElement;

    fireEvent.change(jobNumberInput, { target: { value: '123' } });
    fireEvent.change(sectionsInput, { target: { value: 'Sections 4, 5' } });
    fireEvent.change(installDateInput, { target: { value: '2026-04-09' } });
    fireEvent.change(crewLeaderInput, { target: { value: 'Rob' } });
    fireEvent.change(filmNameInput, { target: { value: 'Prestige' } });

    expect(jobNumberInput.value).toBe('123');
    expect(sectionsInput.value).toBe('Sections 4, 5');
    expect(installDateInput.value).toBe('2026-04-09');
    expect(crewLeaderInput.value).toBe('Rob');
    expect(filmNameInput.value).toBe('Prestige');

    view.rerender(
      buildDialogTree(queryClient, {
        ...initialProps,
        initialRequirements: [],
        initialCaulkRequirements: []
      })
    );

    expect((screen.getByPlaceholderText('000123') as HTMLInputElement).value).toBe('123');
    expect((screen.getByRole('textbox', { name: /Work Scope/i }) as HTMLInputElement).value).toBe(
      'Sections 4, 5'
    );
    expect((screen.getByLabelText(/Install Date/i) as HTMLInputElement).value).toBe('2026-04-09');
    expect((screen.getByRole('textbox', { name: /Crew Leader/i }) as HTMLInputElement).value).toBe(
      'Rob'
    );
    expect((screen.getByRole('combobox', { name: /Film Name/i }) as HTMLInputElement).value).toBe(
      'Prestige'
    );

    view.rerender(
      buildDialogTree(queryClient, {
        ...initialProps,
        open: false
      })
    );

    expect(screen.queryByPlaceholderText('000123')).toBeNull();

    view.rerender(buildDialogTree(queryClient, initialProps));

    expect((screen.getByPlaceholderText('000123') as HTMLInputElement).value).toBe('');
    expect((screen.getByRole('textbox', { name: /Work Scope/i }) as HTMLInputElement).value).toBe(
      ''
    );
    expect((screen.getByLabelText(/Install Date/i) as HTMLInputElement).value).toBe('');
    expect((screen.getByRole('textbox', { name: /Crew Leader/i }) as HTMLInputElement).value).toBe(
      ''
    );
    expect((screen.getByRole('combobox', { name: /Film Name/i }) as HTMLInputElement).value).toBe(
      ''
    );

    queryClient.clear();
  });

  it('preserves edit-mode drafts for the same job and resets when switching jobs', () => {
    const queryClient = createQueryClient();
    const view = render(
      buildDialogTree(queryClient, {
        mode: 'edit',
        title: 'Edit Job 000123',
        initialJobNumber: '000123',
        initialWarehouse: 'IL1',
        initialSections: '5',
        initialInstallDate: '2026-04-10',
        initialCrewLeader: 'Rob',
        initialRequirements: [
          {
            requirementId: 'req-1',
            manufacturer: '3M Fasara',
            filmName: 'Starter Film',
            widthIn: 60,
            requiredFeet: 12
          }
        ],
        initialCaulkRequirements: []
      })
    );

    const sectionsInput = screen.getByRole('textbox', { name: /Work Scope/i }) as HTMLInputElement;
    const crewLeaderInput = screen.getByRole('textbox', { name: /Crew Leader/i }) as HTMLInputElement;
    const installDateInput = screen.getByLabelText(/Install Date/i) as HTMLInputElement;
    const requirementFilmInput = screen.getByDisplayValue('Starter Film') as HTMLInputElement;

    fireEvent.change(sectionsInput, { target: { value: 'Lobby Phase 2' } });
    fireEvent.change(crewLeaderInput, { target: { value: 'Edited Leader' } });
    fireEvent.change(installDateInput, { target: { value: '2026-05-01' } });
    fireEvent.change(requirementFilmInput, { target: { value: 'Edited Film' } });

    expect(sectionsInput.value).toBe('Lobby Phase 2');
    expect(crewLeaderInput.value).toBe('Edited Leader');
    expect(installDateInput.value).toBe('2026-05-01');
    expect(requirementFilmInput.value).toBe('Edited Film');

    view.rerender(
      buildDialogTree(queryClient, {
        mode: 'edit',
        title: 'Edit Job 000123',
        initialJobNumber: '000123',
        initialWarehouse: 'IL1',
        initialSections: '5',
        initialInstallDate: '2026-04-10',
        initialCrewLeader: 'Rob',
        initialRequirements: [
          {
            requirementId: 'req-1',
            manufacturer: '3M Fasara',
            filmName: 'Starter Film',
            widthIn: 60,
            requiredFeet: 12
          }
        ],
        initialCaulkRequirements: []
      })
    );

    expect((screen.getByRole('textbox', { name: /Work Scope/i }) as HTMLInputElement).value).toBe('Lobby Phase 2');
    expect((screen.getByRole('textbox', { name: /Crew Leader/i }) as HTMLInputElement).value).toBe(
      'Edited Leader'
    );
    expect((screen.getByLabelText(/Install Date/i) as HTMLInputElement).value).toBe('2026-05-01');
    expect((screen.getByDisplayValue('Edited Film') as HTMLInputElement).value).toBe('Edited Film');

    view.rerender(
      buildDialogTree(queryClient, {
        mode: 'edit',
        title: 'Edit Job 000123',
        open: false,
        initialJobNumber: '000123',
        initialWarehouse: 'IL1',
        initialSections: '5',
        initialInstallDate: '2026-04-10',
        initialCrewLeader: 'Rob',
        initialRequirements: [
          {
            requirementId: 'req-1',
            manufacturer: '3M Fasara',
            filmName: 'Starter Film',
            widthIn: 60,
            requiredFeet: 12
          }
        ],
        initialCaulkRequirements: []
      })
    );

    expect(screen.queryByDisplayValue('Edited Film')).toBeNull();

    view.rerender(
      buildDialogTree(queryClient, {
        mode: 'edit',
        title: 'Edit Job 000123',
        initialJobNumber: '000123',
        initialWarehouse: 'IL1',
        initialSections: '5',
        initialInstallDate: '2026-04-10',
        initialCrewLeader: 'Rob',
        initialRequirements: [
          {
            requirementId: 'req-1',
            manufacturer: '3M Fasara',
            filmName: 'Starter Film',
            widthIn: 60,
            requiredFeet: 12
          }
        ],
        initialCaulkRequirements: []
      })
    );

    expect((screen.getByRole('textbox', { name: /Work Scope/i }) as HTMLInputElement).value).toBe('5');
    expect((screen.getByRole('textbox', { name: /Crew Leader/i }) as HTMLInputElement).value).toBe(
      'Rob'
    );
    expect((screen.getByLabelText(/Install Date/i) as HTMLInputElement).value).toBe('2026-04-10');
    expect((screen.getByDisplayValue('Starter Film') as HTMLInputElement).value).toBe('Starter Film');

    view.rerender(
      buildDialogTree(queryClient, {
        mode: 'edit',
        title: 'Edit Job 000124',
        initialJobNumber: '000124',
        initialWarehouse: 'IL1',
        initialSections: '9',
        initialInstallDate: '2026-06-02',
        initialCrewLeader: 'Jamie',
        initialRequirements: [
          {
            requirementId: 'req-2',
            manufacturer: 'Llumar',
            filmName: 'Replacement Film',
            widthIn: 48,
            requiredFeet: 20
          }
        ],
        initialCaulkRequirements: []
      })
    );

    expect((screen.getByRole('textbox', { name: /Work Scope/i }) as HTMLInputElement).value).toBe('9');
    expect((screen.getByRole('textbox', { name: /Crew Leader/i }) as HTMLInputElement).value).toBe(
      'Jamie'
    );
    expect((screen.getByLabelText(/Install Date/i) as HTMLInputElement).value).toBe('2026-06-02');
    expect(
      (screen.getByDisplayValue('Replacement Film') as HTMLInputElement).value
    ).toBe('Replacement Film');

    queryClient.clear();
  });

  it('restores the last submitted draft when the edit dialog reopens after an optimistic save failure', () => {
    const queryClient = createQueryClient();
    render(
      buildDialogTree(queryClient, {
        mode: 'edit',
        title: 'Edit Job 000123',
        initialJobNumber: '000123',
        initialWarehouse: 'IL1',
        initialSections: '5',
        initialInstallDate: '2026-04-10',
        initialCrewLeader: 'Rob',
        initialRequirements: [
          {
            requirementId: 'req-1',
            manufacturer: '3M Fasara',
            filmName: 'Starter Film',
            widthIn: 60,
            requiredFeet: 12
          }
        ],
        initialCaulkRequirements: [],
        restoreDraft: {
          jobNumber: '000123',
          warehouse: 'IL1',
          workScope: '77',
          sections: '77',
          installDate: '2026-05-01',
          crewLeader: 'Edited Leader',
          requirements: [
            {
              requirementId: 'req-1',
              manufacturer: '3M Fasara',
              filmName: 'Edited Film',
              widthIn: 60,
              requiredFeet: 30
            }
          ],
          caulkRequirements: []
        }
      })
    );

    expect((screen.getByRole('textbox', { name: /Work Scope/i }) as HTMLInputElement).value).toBe(
      '77'
    );
    expect(
      (screen.getByRole('textbox', { name: /Crew Leader/i }) as HTMLInputElement).value
    ).toBe('Edited Leader');
    expect((screen.getByLabelText(/Install Date/i) as HTMLInputElement).value).toBe('2026-05-01');
    expect((screen.getByDisplayValue('Edited Film') as HTMLInputElement).value).toBe('Edited Film');

    queryClient.clear();
  });
});

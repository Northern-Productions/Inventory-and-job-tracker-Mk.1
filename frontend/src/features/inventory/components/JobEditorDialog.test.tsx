// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentProps, ReactElement } from 'react';
import { JobEditorDialog } from './JobEditorDialog';
import { warehouseRegistryScopedQueryKey } from '../hooks/useWarehouseRegistry';

vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({
    isOwner: true,
    isAdmin: true,
    isAccessReady: true,
    isApproved: true,
    session: { user: { sub: 'test-user' } },
    accessContext: { orgId: 'test-org' },
    hasFeatureAccess: () => true
  })
}));

vi.mock('../../../api/features/warehouseClient', () => ({
  addWarehouse: vi.fn(),
  listWarehouses: vi.fn(async () => [])
}));

function createQueryClient(
  warehouses = [
    {
      code: 'IL1',
      name: 'Wauconda IL1',
      boxIdPrefix: 'IL1'
    }
  ]
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity
      }
    }
  });

  queryClient.setQueryData(
    warehouseRegistryScopedQueryKey({ userId: 'test-user', orgId: 'test-org' }),
    warehouses
  );

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

function buildDialogTreeWithLauncher(
  queryClient: QueryClient,
  open: boolean,
  props: Partial<ComponentProps<typeof JobEditorDialog>> = {}
): ReactElement {
  return (
    <>
      <button type="button" data-testid="new-job-launcher">
        New Job +
      </button>
      <QueryClientProvider client={queryClient}>
        <JobEditorDialog
          open={open}
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
    </>
  );
}

function expectNoUiPhaseKeysInSubmitPayload(payload: unknown) {
  const serializedPayload = JSON.stringify(payload);
  expect(serializedPayload).not.toContain('"primary"');
  expect(serializedPayload).not.toContain('job-phase-');
}

afterEach(() => {
  cleanup();
});
describe('JobEditorDialog', () => {
  it('renders job warehouse choices from the current org registry without injecting internal defaults', () => {
    const queryClient = createQueryClient([
      {
        code: 'MI1',
        name: 'Auburn Hills',
        boxIdPrefix: 'MI1'
      }
    ]);

    render(
      buildDialogTree(queryClient, {
        initialWarehouse: 'MI1'
      })
    );

    const warehouseSelect = screen.getByRole('combobox', { name: 'Warehouse' });
    const options = within(warehouseSelect).getAllByRole('option');

    expect(options.map((option) => option.textContent)).toEqual([
      'Auburn Hills MI1',
      'Add New Warehouse...'
    ]);
    expect(screen.queryByText('Wauconda IL1')).toBeNull();
    expect(screen.queryByText('Ridgeland MS1')).toBeNull();

    queryClient.clear();
  });

  it('uses the shared sticky footer action class for the final save row', () => {
    const queryClient = createQueryClient();
    render(buildDialogTree(queryClient));

    expect(document.querySelector('.dialog-actions.dialog-actions-sticky-footer')).not.toBeNull();
    queryClient.clear();
  });

  it('uses the shared polished layout classes for job sections and requirements', () => {
    const queryClient = createQueryClient();
    render(buildDialogTree(queryClient));

    expect(document.querySelector('.dialog-job-editor .job-editor-dialog-body')).not.toBeNull();
    expect(document.querySelector('.job-editor-basics-section')).not.toBeNull();
    expect(document.querySelector('.job-editor-section')).not.toBeNull();
    expect(document.querySelectorAll('.job-editor-requirements-section')).toHaveLength(2);
    expect(document.querySelectorAll('.job-editor-requirement-builder')).toHaveLength(2);
    expect(document.querySelector('.job-editor-film-requirement-builder')).not.toBeNull();
    expect(document.querySelector('.dialog-actions.dialog-actions-sticky-footer')).not.toBeNull();
    queryClient.clear();
  });

  it('keeps focused create fields stable when parent callbacks refresh while the dialog is scrolled', () => {
    const queryClient = createQueryClient();
    const view = render(buildDialogTreeWithLauncher(queryClient, false));
    const launcher = screen.getByTestId('new-job-launcher') as HTMLButtonElement;
    launcher.focus();

    view.rerender(
      buildDialogTreeWithLauncher(queryClient, true, {
        onCancel: vi.fn(),
        onSubmit: vi.fn()
      })
    );

    const dialog = screen.getByRole('dialog', { name: 'New Job' }) as HTMLElement;
    const focusTargets = [
      () => screen.getByRole('textbox', { name: /Work Scope/i }) as HTMLInputElement,
      () => screen.getByRole('combobox', { name: /^Manufacturer$/i }) as HTMLSelectElement,
      () => screen.getByRole('combobox', { name: /Film Name/i }) as HTMLInputElement
    ];

    for (const getTarget of focusTargets) {
      const target = getTarget();
      dialog.scrollTop = 480;
      target.focus();
      expect(document.activeElement).toBe(target);

      view.rerender(
        buildDialogTreeWithLauncher(queryClient, true, {
          onCancel: vi.fn(),
          onSubmit: vi.fn()
        })
      );

      expect(document.activeElement).toBe(target);
      expect(dialog.scrollTop).toBe(480);
    }

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

  it('defaults edit mode to the closest active phase and hides the old phase grid', () => {
    const queryClient = createQueryClient();
    render(
      buildDialogTree(queryClient, {
        mode: 'edit',
        title: 'Edit Job 000123',
        initialJobNumber: '000123',
        initialWarehouse: 'IL1',
        initialSections: 'Section 1',
        initialInstallDate: '2026-05-01',
        initialCrewLeader: 'Napo',
        initialPhases: [
          {
            id: 'phase-1',
            phaseId: 'phase-1',
            phaseNumber: 1,
            workScope: 'Section 1',
            sections: 'Section 1',
            installDate: '2026-05-01',
            crewLeader: 'Napo',
            laborStatus: 'ACTIVE',
            isPrimary: true,
            isNextRelevant: false,
            status: 'READY'
          },
          {
            id: 'phase-2',
            phaseId: 'phase-2',
            phaseNumber: 2,
            workScope: 'Sections 4, 5',
            sections: 'Sections 4, 5',
            installDate: '2026-05-21',
            crewLeader: 'Alexis',
            laborStatus: 'ACTIVE',
            isPrimary: false,
            isNextRelevant: true,
            status: 'FILM_ORDER'
          }
        ],
        initialRequirements: [],
        initialCaulkRequirements: []
      })
    );

    const phaseSelect = screen.getByRole('combobox', { name: /Phase to edit/i }) as HTMLSelectElement;
    expect(phaseSelect.value).toBe('phase-2');
    expect(screen.getByRole('option', { name: 'Phase 1 — Section 1' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Phase 2 — Sections 4, 5' })).toBeTruthy();
    expect((screen.getByRole('textbox', { name: /Work Scope/i }) as HTMLInputElement).value).toBe(
      'Sections 4, 5'
    );
    expect((screen.getByLabelText(/Install Date/i) as HTMLInputElement).value).toBe('2026-05-21');
    expect((screen.getByRole('textbox', { name: /Crew Leader/i }) as HTMLInputElement).value).toBe(
      'Alexis'
    );
    expect(document.querySelector('.job-editor-phase-list')).toBeNull();
    expect(screen.queryByText(/Add requirements to phase/i)).toBeNull();

    queryClient.clear();
  });

  it('validates and submits the selected phase install end date', () => {
    const queryClient = createQueryClient();
    const onSubmit = vi.fn();
    render(
      buildDialogTree(queryClient, {
        mode: 'edit',
        title: 'Edit Job 000123',
        submitLabel: 'Save Job',
        initialJobNumber: '000123',
        initialWarehouse: 'IL1',
        initialSections: 'Section 1',
        initialInstallDate: '2026-05-01',
        initialCrewLeader: 'Napo',
        initialPhases: [
          {
            id: 'phase-1',
            phaseId: 'phase-1',
            phaseNumber: 1,
            workScope: 'Section 1',
            sections: 'Section 1',
            installDate: '2026-05-01',
            installEndDate: '2026-05-03',
            crewLeader: 'Napo',
            laborStatus: 'ACTIVE',
            isPrimary: true
          }
        ],
        initialRequirements: [],
        initialCaulkRequirements: [],
        onSubmit
      })
    );

    const endDateInput = screen.getByLabelText(/Install End Date/i) as HTMLInputElement;
    expect(endDateInput.value).toBe('2026-05-03');

    fireEvent.change(endDateInput, { target: { value: '2026-04-30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Job' }));
    expect(screen.getByText(/Install End Date must be the same day as or later than Install Date/i)).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();

    const installDateInput = screen.getByLabelText(/^Install Date$/i) as HTMLInputElement;
    fireEvent.change(installDateInput, { target: { value: '' } });
    fireEvent.change(endDateInput, { target: { value: '2026-05-04' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Job' }));
    expect(screen.getByText(/Install End Date requires an Install Date/i)).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.change(installDateInput, { target: { value: '2026-05-01' } });
    fireEvent.change(endDateInput, { target: { value: '2026-05-04' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Job' }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        phases: [
          expect.objectContaining({
            phaseId: 'phase-1',
            installDate: '2026-05-01',
            installEndDate: '2026-05-04'
          })
        ]
      })
    );

    queryClient.clear();
  });

  it('switches selected phase fields and keeps requirements scoped to that phase', () => {
    const queryClient = createQueryClient();
    render(
      buildDialogTree(queryClient, {
        mode: 'edit',
        title: 'Edit Job 000123',
        initialJobNumber: '000123',
        initialWarehouse: 'IL1',
        initialSections: 'Section 1',
        initialInstallDate: '2026-05-01',
        initialCrewLeader: 'Napo',
        initialPhases: [
          {
            id: 'phase-1',
            phaseId: 'phase-1',
            phaseNumber: 1,
            workScope: 'Section 1',
            sections: 'Section 1',
            installDate: '2026-05-01',
            crewLeader: 'Napo',
            laborStatus: 'ACTIVE',
            isPrimary: true,
            isNextRelevant: false
          },
          {
            id: 'phase-2',
            phaseId: 'phase-2',
            phaseNumber: 2,
            workScope: 'Section 7',
            sections: 'Section 7',
            installDate: '2026-06-01',
            crewLeader: 'Alexis',
            laborStatus: 'ACTIVE',
            isPrimary: false,
            isNextRelevant: true
          }
        ],
        initialRequirements: [
          {
            requirementId: 'req-1',
            phaseId: 'phase-1',
            phaseNumber: 1,
            manufacturer: '3M Fasara',
            filmName: 'First Phase Film',
            widthIn: 60,
            requiredFeet: 12
          },
          {
            requirementId: 'req-2',
            phaseId: 'phase-2',
            phaseNumber: 2,
            manufacturer: 'Llumar',
            filmName: 'Second Phase Film',
            widthIn: 48,
            requiredFeet: 20
          }
        ],
        initialCaulkRequirements: []
      })
    );

    expect(screen.queryByDisplayValue('First Phase Film')).toBeNull();
    expect(screen.getByDisplayValue('Second Phase Film')).toBeTruthy();

    fireEvent.change(screen.getByRole('combobox', { name: /Phase to edit/i }), {
      target: { value: 'phase-1' }
    });

    expect((screen.getByRole('textbox', { name: /Work Scope/i }) as HTMLInputElement).value).toBe(
      'Section 1'
    );
    expect((screen.getByLabelText(/Install Date/i) as HTMLInputElement).value).toBe('2026-05-01');
    expect((screen.getByRole('textbox', { name: /Crew Leader/i }) as HTMLInputElement).value).toBe(
      'Napo'
    );
    expect(screen.getByDisplayValue('First Phase Film')).toBeTruthy();
    expect(screen.queryByDisplayValue('Second Phase Film')).toBeNull();

    queryClient.clear();
  });

  it('adds and selects a new phase from the phase selector flow', () => {
    const queryClient = createQueryClient();
    render(
      buildDialogTree(queryClient, {
        mode: 'edit',
        title: 'Edit Job 000123',
        initialJobNumber: '000123',
        initialWarehouse: 'IL1',
        initialSections: 'Section 1',
        initialInstallDate: '2026-05-01',
        initialCrewLeader: 'Napo',
        initialPhases: [
          {
            id: 'phase-1',
            phaseId: 'phase-1',
            phaseNumber: 1,
            workScope: 'Section 1',
            sections: 'Section 1',
            installDate: '2026-05-01',
            crewLeader: 'Napo',
            laborStatus: 'ACTIVE',
            isPrimary: true
          },
          {
            id: 'phase-3',
            phaseId: 'phase-3',
            phaseNumber: 3,
            workScope: 'Section 20',
            sections: 'Section 20',
            installDate: '',
            crewLeader: '',
            laborStatus: 'ACTIVE',
            isPrimary: false
          }
        ],
        initialRequirements: [],
        initialCaulkRequirements: []
      })
    );

    fireEvent.click(screen.getByRole('button', { name: /Add New Phase/i }));

    const phaseSelect = screen.getByRole('combobox', { name: /Phase to edit/i }) as HTMLSelectElement;
    const phaseNumberInput = screen.getByRole('spinbutton', { name: /Phase Number/i }) as HTMLInputElement;
    expect(phaseSelect.value).toMatch(/^job-phase-/);
    expect(phaseNumberInput.value).toBe('4');
    expect((screen.getByRole('textbox', { name: /Work Scope/i }) as HTMLInputElement).value).toBe(
      ''
    );

    queryClient.clear();
  });

  it('keeps positive whole number phase validation in the selected phase flow', () => {
    const queryClient = createQueryClient();
    const onSubmit = vi.fn();
    render(
      buildDialogTree(queryClient, {
        mode: 'edit',
        title: 'Edit Job 000123',
        initialJobNumber: '000123',
        initialWarehouse: 'IL1',
        initialSections: 'Section 1',
        initialInstallDate: '2026-05-01',
        initialCrewLeader: 'Napo',
        initialPhases: [
          {
            id: 'phase-1',
            phaseId: 'phase-1',
            phaseNumber: 1,
            workScope: 'Section 1',
            sections: 'Section 1',
            installDate: '2026-05-01',
            crewLeader: 'Napo',
            laborStatus: 'ACTIVE',
            isPrimary: true
          }
        ],
        initialRequirements: [],
        initialCaulkRequirements: [],
        onSubmit
      })
    );

    const phaseNumberInput = screen.getByRole('spinbutton', { name: /Phase Number/i });
    for (const invalidPhaseNumber of ['0', '-1', '', '2.5', '1e2']) {
      fireEvent.change(phaseNumberInput, {
        target: { value: invalidPhaseNumber }
      });
      fireEvent.click(screen.getByRole('button', { name: /Save Job/i }));

      expect(onSubmit).not.toHaveBeenCalled();
      expect(screen.getByText(/Phase number must be a positive whole number/i)).toBeTruthy();
    }

    queryClient.clear();
  });

  it('saves a new default Phase 1 job without leaking the primary phase sentinel', () => {
    const queryClient = createQueryClient();
    const onSubmit = vi.fn();
    render(
      buildDialogTree(queryClient, {
        mode: 'create',
        title: 'New Job',
        submitLabel: 'Save Job',
        initialJobNumber: '900101',
        initialWarehouse: 'IL1',
        initialSections: 'Lobby',
        initialInstallDate: '2026-06-01',
        initialCrewLeader: 'Napo',
        initialRequirements: [
          {
            manufacturer: '3M',
            filmName: 'Prestige',
            widthIn: 60,
            requiredFeet: 12
          }
        ],
        initialCaulkRequirements: [],
        onSubmit
      })
    );

    fireEvent.click(screen.getByRole('button', { name: /Save Job/i }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const payload = onSubmit.mock.calls[0][0];
    expectNoUiPhaseKeysInSubmitPayload(payload);
    expect(payload.phases[0]).not.toHaveProperty('id');
    expect(payload.phases[0]).not.toHaveProperty('phaseId');
    expect(payload.phases[0]).toEqual(
      expect.objectContaining({
        phaseNumber: 1,
        workScope: 'Lobby',
        sections: 'Lobby',
        workflowStatus: 'ACTIVE',
        isPrimary: true,
        requirements: [
          expect.objectContaining({
            phaseNumber: 1,
            manufacturer: '3M Solar',
            filmName: 'Prestige',
            widthIn: 60,
            requiredFeet: 12
          })
        ]
      })
    );
    expect(payload.phases[0].requirements[0]).not.toHaveProperty('phaseId');

    queryClient.clear();
  });

  it('saves an edit fallback Phase 1 job without leaking the primary phase sentinel', () => {
    const queryClient = createQueryClient();
    const onSubmit = vi.fn();
    render(
      buildDialogTree(queryClient, {
        mode: 'edit',
        title: 'Edit Job 900102',
        submitLabel: 'Save Job',
        initialJobNumber: '900102',
        initialWarehouse: 'IL1',
        initialSections: 'Section 1',
        initialInstallDate: '2026-06-02',
        initialCrewLeader: 'Jamie',
        initialRequirements: [
          {
            requirementId: 'req-fallback-1',
            manufacturer: 'Llumar',
            filmName: 'Fallback Film',
            widthIn: 48,
            requiredFeet: 20
          }
        ],
        initialCaulkRequirements: [],
        onSubmit
      })
    );

    fireEvent.click(screen.getByRole('button', { name: /Save Job/i }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.jobNumber).toBe('900102');
    expectNoUiPhaseKeysInSubmitPayload(payload);
    expect(payload.phases[0]).not.toHaveProperty('id');
    expect(payload.phases[0]).not.toHaveProperty('phaseId');
    expect(payload.phases[0].requirements[0]).toEqual(
      expect.objectContaining({
        requirementId: 'req-fallback-1',
        phaseNumber: 1,
        filmName: 'Fallback Film'
      })
    );

    queryClient.clear();
  });

  it('preserves hidden phase and requirement state when saving an edit', () => {
    const queryClient = createQueryClient();
    const onSubmit = vi.fn();
    const phaseOneId = '11111111-1111-4111-8111-111111111111';
    const phaseTwoId = '22222222-2222-4222-8222-222222222222';
    const filmRequirementId = '33333333-3333-4333-8333-333333333333';
    const caulkRequirementId = '44444444-4444-4444-8444-444444444444';
    render(
      buildDialogTree(queryClient, {
        mode: 'edit',
        title: 'Edit Job 900202',
        submitLabel: 'Save Job',
        initialJobNumber: '900202',
        initialWarehouse: 'IL1',
        initialSections: 'Phase 1',
        initialInstallDate: '2026-06-10',
        initialCrewLeader: 'Rob',
        initialPhases: [
          {
            id: phaseOneId,
            phaseId: phaseOneId,
            phaseNumber: 1,
            workScope: 'Phase 1',
            sections: 'Phase 1',
            installDate: '2026-06-10',
            crewLeader: 'Rob',
            laborStatus: 'ACTIVE',
            workflowStatus: 'PLACEHOLDER',
            isPrimary: true
          },
          {
            id: phaseTwoId,
            phaseId: phaseTwoId,
            phaseNumber: 2,
            workScope: 'Phase 2',
            sections: 'Phase 2',
            installDate: '2026-06-12',
            crewLeader: 'Sage',
            laborStatus: 'ACTIVE',
            workflowStatus: 'ACTIVE',
            isPrimary: false,
            isNextRelevant: true
          }
        ],
        initialRequirements: [
          {
            requirementId: filmRequirementId,
            phaseId: phaseOneId,
            phaseNumber: 1,
            manufacturer: '3M',
            filmName: 'Stateful Film',
            widthIn: 60,
            requiredFeet: 40,
            status: 'COMPLETE',
            actualUsedFeet: 37,
            completedAt: '2026-06-11T14:00:00.000Z',
            completedBy: 'codex'
          }
        ],
        initialCaulkRequirements: [
          {
            requirementId: caulkRequirementId,
            phaseId: phaseOneId,
            phaseNumber: 1,
            productId: '55555555-5555-4555-8555-555555555555',
            requiredTubes: 3,
            status: 'COMPLETE',
            actualUsedTubes: 2,
            completedAt: '2026-06-11T15:00:00.000Z',
            completedBy: 'codex'
          }
        ],
        onSubmit
      })
    );

    fireEvent.change(screen.getByRole('textbox', { name: /Work Scope/i }), {
      target: { value: 'Phase 2 - edited' }
    });
    fireEvent.click(screen.getByRole('button', { name: /Save Job/i }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.phases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phaseId: phaseOneId,
          phaseNumber: 1,
          workflowStatus: 'PLACEHOLDER',
          requirements: [
            expect.objectContaining({
              requirementId: filmRequirementId,
              phaseId: phaseOneId,
              status: 'COMPLETE',
              actualUsedFeet: 37,
              completedAt: '2026-06-11T14:00:00.000Z',
              completedBy: 'codex'
            })
          ],
          caulkRequirements: [
            expect.objectContaining({
              requirementId: caulkRequirementId,
              phaseId: phaseOneId,
              status: 'COMPLETE',
              actualUsedTubes: 2,
              completedAt: '2026-06-11T15:00:00.000Z',
              completedBy: 'codex'
            })
          ]
        }),
        expect.objectContaining({
          phaseId: phaseTwoId,
          phaseNumber: 2,
          workflowStatus: 'ACTIVE',
          workScope: 'Phase 2 - edited'
        })
      ])
    );
    expect(payload.requirements[0]).toEqual(
      expect.objectContaining({
        requirementId: filmRequirementId,
        status: 'COMPLETE',
        actualUsedFeet: 37
      })
    );
    expect(payload.caulkRequirements[0]).toEqual(
      expect.objectContaining({
        requirementId: caulkRequirementId,
        status: 'COMPLETE',
        actualUsedTubes: 2
      })
    );

    queryClient.clear();
  });

  it('keeps Phase 1 placeholder state when adding a new phase during edit', () => {
    const queryClient = createQueryClient();
    const onSubmit = vi.fn();
    const phaseOneId = '11111111-1111-4111-8111-111111111111';
    render(
      buildDialogTree(queryClient, {
        mode: 'edit',
        title: 'Edit Job 900203',
        submitLabel: 'Save Job',
        initialJobNumber: '900203',
        initialWarehouse: 'IL1',
        initialSections: 'Phase 1',
        initialInstallDate: '2026-06-10',
        initialCrewLeader: 'Rob',
        initialPhases: [
          {
            id: phaseOneId,
            phaseId: phaseOneId,
            phaseNumber: 1,
            workScope: 'Phase 1',
            sections: 'Phase 1',
            installDate: '2026-06-10',
            crewLeader: 'Rob',
            laborStatus: 'ACTIVE',
            workflowStatus: 'PLACEHOLDER',
            isPrimary: true
          }
        ],
        initialRequirements: [],
        initialCaulkRequirements: [],
        onSubmit
      })
    );

    fireEvent.click(screen.getByRole('button', { name: /Add New Phase/i }));
    fireEvent.change(screen.getByRole('textbox', { name: /Work Scope/i }), {
      target: { value: 'Phase 2' }
    });
    fireEvent.click(screen.getByRole('button', { name: /Save Job/i }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.phases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phaseId: phaseOneId,
          phaseNumber: 1,
          workflowStatus: 'PLACEHOLDER'
        }),
        expect.objectContaining({
          phaseNumber: 2,
          workflowStatus: 'PLACEHOLDER',
          workScope: 'Phase 2'
        })
      ])
    );

    queryClient.clear();
  });

  it('preserves existing phase UUIDs while omitting local phase row keys from edit saves', () => {
    const queryClient = createQueryClient();
    const onSubmit = vi.fn();
    const primaryPhaseId = '11111111-1111-4111-8111-111111111111';
    render(
      buildDialogTree(queryClient, {
        mode: 'edit',
        title: 'Edit Job 900103',
        submitLabel: 'Save Job',
        initialJobNumber: '900103',
        initialWarehouse: 'IL1',
        initialSections: 'Section 1',
        initialInstallDate: '2026-06-03',
        initialCrewLeader: 'Rob',
        initialPhases: [
          {
            id: primaryPhaseId,
            phaseId: primaryPhaseId,
            phaseNumber: 1,
            workScope: 'Section 1',
            sections: 'Section 1',
            installDate: '2026-06-03',
            crewLeader: 'Rob',
            laborStatus: 'ACTIVE',
            isPrimary: true
          }
        ],
        initialRequirements: [
          {
            requirementId: 'req-uuid-1',
            phaseId: primaryPhaseId,
            phaseNumber: 1,
            manufacturer: '3M',
            filmName: 'UUID Film',
            widthIn: 72,
            requiredFeet: 30
          }
        ],
        initialCaulkRequirements: [],
        onSubmit
      })
    );

    fireEvent.click(screen.getByRole('button', { name: /Save Job/i }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.phases[0]).not.toHaveProperty('id');
    expect(payload.phases[0]).toEqual(
      expect.objectContaining({
        phaseId: primaryPhaseId,
        phaseNumber: 1,
        requirements: [
          expect.objectContaining({
            requirementId: 'req-uuid-1',
            phaseId: primaryPhaseId,
            phaseNumber: 1
          })
        ]
      })
    );

    queryClient.clear();
  });

  it('saves newly added phases by phase number without leaking generated local phase ids', () => {
    const queryClient = createQueryClient();
    const onSubmit = vi.fn();
    render(
      buildDialogTree(queryClient, {
        mode: 'create',
        title: 'New Job',
        submitLabel: 'Save Job',
        initialJobNumber: '900104',
        initialWarehouse: 'IL1',
        initialSections: 'Section 1',
        initialInstallDate: '2026-06-04',
        initialCrewLeader: 'Napo',
        initialRequirements: [],
        initialCaulkRequirements: [],
        onSubmit
      })
    );

    fireEvent.click(screen.getByRole('button', { name: /Add New Phase/i }));
    fireEvent.change(screen.getByRole('textbox', { name: /Work Scope/i }), {
      target: { value: 'Section 2' }
    });
    fireEvent.click(screen.getByRole('button', { name: /Save Job/i }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const payload = onSubmit.mock.calls[0][0];
    expectNoUiPhaseKeysInSubmitPayload(payload);
    expect(payload.phases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phaseNumber: 2,
          workScope: 'Section 2',
          sections: 'Section 2'
        })
      ])
    );
    expect(payload.phases[1]).not.toHaveProperty('id');
    expect(payload.phases[1]).not.toHaveProperty('phaseId');

    queryClient.clear();
  });

  it('saves selected phase scope, date, leader, and requirement edits without changing non-primary uniqueness scope', () => {
    const queryClient = createQueryClient();
    const onSubmit = vi.fn();
    render(
      buildDialogTree(queryClient, {
        mode: 'edit',
        title: 'Edit Job 000123',
        submitLabel: 'Save Job',
        initialJobNumber: '000123',
        initialWarehouse: 'IL1',
        initialSections: 'Section 1',
        initialInstallDate: '2026-05-01',
        initialCrewLeader: 'Napo',
        initialPhases: [
          {
            id: 'phase-1',
            phaseId: 'phase-1',
            phaseNumber: 1,
            workScope: 'Section 1',
            sections: 'Section 1',
            installDate: '2026-05-01',
            crewLeader: 'Napo',
            laborStatus: 'ACTIVE',
            isPrimary: true,
            isNextRelevant: false
          },
          {
            id: 'phase-2',
            phaseId: 'phase-2',
            phaseNumber: 2,
            workScope: 'Section 7',
            sections: 'Section 7',
            installDate: '2026-06-01',
            crewLeader: 'Alexis',
            laborStatus: 'ACTIVE',
            isPrimary: false,
            isNextRelevant: true
          }
        ],
        initialRequirements: [
          {
            requirementId: 'req-2',
            phaseId: 'phase-2',
            phaseNumber: 2,
            manufacturer: 'Llumar',
            filmName: 'Second Phase Film',
            widthIn: 48,
            requiredFeet: 20
          }
        ],
        initialCaulkRequirements: [],
        onSubmit
      })
    );

    fireEvent.change(screen.getByRole('textbox', { name: /Work Scope/i }), {
      target: { value: 'Section 7 Punch' }
    });
    fireEvent.change(screen.getByLabelText(/Install Date/i), {
      target: { value: '2026-06-12' }
    });
    fireEvent.change(screen.getByRole('textbox', { name: /Crew Leader/i }), {
      target: { value: 'Jamie' }
    });
    fireEvent.change(screen.getByDisplayValue('Second Phase Film'), {
      target: { value: 'Updated Second Phase Film' }
    });
    fireEvent.click(screen.getByRole('button', { name: /Save Job/i }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.workScope).toBe('Section 1');
    expect(payload.sections).toBe('Section 1');
    expect(payload.phases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phaseId: 'phase-2',
          phaseNumber: 2,
          workScope: 'Section 7 Punch',
          sections: 'Section 7 Punch',
          installDate: '2026-06-12',
          crewLeader: 'Jamie',
          requirements: [
            expect.objectContaining({
              requirementId: 'req-2',
              phaseId: 'phase-2',
              phaseNumber: 2,
              filmName: 'Updated Second Phase Film'
            })
          ]
        })
      ])
    );

    queryClient.clear();
  });

  it('updates the primary phase summary fields when the selected primary phase is saved', () => {
    const queryClient = createQueryClient();
    const onSubmit = vi.fn();
    render(
      buildDialogTree(queryClient, {
        mode: 'edit',
        title: 'Edit Job 4024',
        submitLabel: 'Save Job',
        initialJobNumber: '4024',
        initialWarehouse: 'IL1',
        initialSections: '1',
        initialInstallDate: '2026-05-21',
        initialCrewLeader: 'Napo',
        initialPhases: [
          {
            id: 'phase-1',
            phaseId: 'phase-1',
            phaseNumber: 1,
            workScope: '1',
            sections: '1',
            installDate: '2026-05-21',
            crewLeader: 'Napo',
            laborStatus: 'ACTIVE',
            isPrimary: true,
            isNextRelevant: true
          }
        ],
        initialRequirements: [],
        initialCaulkRequirements: [],
        onSubmit
      })
    );

    fireEvent.change(screen.getByRole('textbox', { name: /Work Scope/i }), {
      target: { value: 'Section 1' }
    });
    fireEvent.click(screen.getByRole('button', { name: /Save Job/i }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.workScope).toBe('Section 1');
    expect(payload.sections).toBe('Section 1');
    expect(payload.phases[0]).toEqual(
      expect.objectContaining({
        phaseId: 'phase-1',
        phaseNumber: 1,
        workScope: 'Section 1',
        sections: 'Section 1',
        isPrimary: true
      })
    );

    queryClient.clear();
  });
});

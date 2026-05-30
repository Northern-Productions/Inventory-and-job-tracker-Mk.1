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

  it('uses the shared polished layout classes for job sections and requirements', () => {
    const queryClient = createQueryClient();
    render(buildDialogTree(queryClient));

    expect(document.querySelector('.dialog-job-editor .job-editor-dialog-body')).not.toBeNull();
    expect(document.querySelector('.job-editor-basics-section')).not.toBeNull();
    expect(document.querySelector('.job-editor-section')).not.toBeNull();
    expect(document.querySelectorAll('.job-editor-requirements-section')).toHaveLength(2);
    expect(document.querySelectorAll('.job-editor-requirement-builder')).toHaveLength(2);
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

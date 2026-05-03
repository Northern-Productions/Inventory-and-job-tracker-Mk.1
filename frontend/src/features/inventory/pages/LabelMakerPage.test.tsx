// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Box } from '../../../domain';
import LabelMakerPage from './LabelMakerPage';

const useOfflineInventorySearchMock = vi.fn();
const useFilmCatalogMock = vi.fn();
const useAuthMock = vi.fn();
const useWarehouseRegistryMock = vi.fn();
const createBoxQrCodeDataUrlMock = vi.fn();

vi.mock('../hooks/useOfflineInventorySearch', () => ({
  useOfflineInventorySearch: (...args: unknown[]) => useOfflineInventorySearchMock(...args)
}));

vi.mock('../hooks/useInventoryQueries', () => ({
  useFilmCatalog: () => useFilmCatalogMock()
}));

vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => useAuthMock()
}));

vi.mock('../hooks/useWarehouseRegistry', () => ({
  useWarehouseRegistry: () => useWarehouseRegistryMock()
}));

vi.mock('../utils/qrCode', () => ({
  buildBoxQrPayload: (boxId: string) => String(boxId || '').trim(),
  createBoxQrCodeDataUrl: (...args: unknown[]) => createBoxQrCodeDataUrlMock(...args)
}));

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false }
    }
  });
}

function buildBox(overrides: Partial<Box> = {}): Box {
  return {
    boxId: 'MO1-0028',
    warehouse: 'MO1',
    dealer: '',
    manufacturer: 'Llumar',
    filmName: 'DR 15',
    widthIn: 48,
    initialFeet: 100,
    feetAvailable: 92,
    physicalFeetAvailable: 92,
    allocatableNowFeet: 92,
    allocationPlanningFeet: 92,
    lotRun: '405G021',
    status: 'IN_STOCK',
    orderDate: '2026-04-01',
    receivedDate: '2026-04-02',
    initialWeightLbs: 10,
    lastRollWeightLbs: 8.15,
    lastWeighedDate: '2026-04-29',
    filmKey: '',
    coreType: '',
    coreWeightLbs: null,
    lfWeightLbsPerFt: null,
    pricePerLf: null,
    purchaseCost: null,
    notes: '',
    hasEverBeenCheckedOut: false,
    lastCheckoutJob: '',
    lastCheckoutDate: '',
    zeroedDate: '',
    zeroedReason: '',
    zeroedBy: '',
    ...overrides
  };
}

function renderPage(initialPath = '/labels?q=MO1') {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[initialPath]}>
        <LabelMakerPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function getRowForBox(boxId: string) {
  const cell = screen.getByText(boxId);
  const row = cell.closest('tr');
  if (!(row instanceof HTMLElement)) {
    throw new Error(`Expected ${boxId} to be rendered in a table row.`);
  }
  return row;
}

function getMatchingBoxesTable() {
  const heading = screen.getByRole('heading', { name: 'Matching Boxes' });
  const section = heading.closest('section');
  if (!(section instanceof HTMLElement)) {
    throw new Error('Expected Matching Boxes to render inside a section.');
  }

  return within(section).getByRole('table');
}

function getMatchingBoxesSection() {
  const heading = screen.getByRole('heading', { name: 'Matching Boxes' });
  const section = heading.closest('section');
  if (!(section instanceof HTMLElement)) {
    throw new Error('Expected Matching Boxes to render inside a section.');
  }

  return within(section);
}

function getPreviewPanel() {
  const heading = screen.getByRole('heading', { name: 'Preview' });
  const section = heading.closest('section');
  if (!(section instanceof HTMLElement)) {
    throw new Error('Expected Preview to render inside a section.');
  }

  return section;
}

function getPrintOnlyRoot() {
  return Array.from(document.body.children).find(
    (element): element is HTMLElement =>
      element instanceof HTMLElement &&
      element.classList.contains('label-print-only-root') &&
      element.classList.contains('print-root')
  ) ?? null;
}

function formatTodayForLabelTest(): string {
  const today = new Date();
  return `${String(today.getMonth() + 1).padStart(2, '0')}/${String(today.getDate()).padStart(2, '0')}/${today.getFullYear()}`;
}

describe('LabelMakerPage', () => {
  beforeEach(() => {
    useAuthMock.mockReturnValue({
      isOwner: false,
      hasFeatureAccess: () => true
    });
    useWarehouseRegistryMock.mockReturnValue({
      entries: [
        { code: 'MO1', name: 'Missouri', boxIdPrefix: 'MO1' },
        { code: 'IL1', name: 'Illinois', boxIdPrefix: 'IL1' }
      ]
    });
    useFilmCatalogMock.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
      error: null
    });
    useOfflineInventorySearchMock.mockReturnValue({
      snapshotBoxes: [
        buildBox(),
        buildBox({ boxId: 'MO1-0029', lotRun: '405G022' })
      ],
      isError: false,
      error: null,
      isLoading: false,
      isOffline: false,
      isSyncing: false,
      syncError: null,
      hasSnapshot: true,
      lastSyncedAt: new Date().toISOString(),
      refetch: vi.fn()
    });
    createBoxQrCodeDataUrlMock.mockResolvedValue('data:image/png;base64,label');
    vi.spyOn(window, 'print').mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('renders full identity fields so boxes can be distinguished', () => {
    renderPage();

    const table = getMatchingBoxesTable();
    const headers = within(table).getAllByRole('columnheader');
    const row = getRowForBox('MO1-0028');

    expect(headers[0].textContent).toBe('Box ID');
    expect(within(table).queryByRole('columnheader', { name: 'Digital Box ID' })).toBeNull();
    expect(within(table).queryByRole('columnheader', { name: 'Warehouse' })).toBeNull();
    expect(within(row).getByText('MO1-0028')).toBeTruthy();
    expect(within(row).queryByText('MO1')).toBeNull();
    expect(within(row).getByText('Llumar')).toBeTruthy();
    expect(within(row).getByText('DR 15')).toBeTruthy();
    expect(within(row).getByText('48')).toBeTruthy();
    expect(within(row).getByText('405G021')).toBeTruthy();
    expect(within(row).getByText('IN_STOCK')).toBeTruthy();
    expect(within(row).getByText('92')).toBeTruthy();
    expect(within(row).getByText('Apr 29, 2026')).toBeTruthy();
  });

  it('shows derived physical on-hand feet in Matching Boxes and Label Balance', () => {
    useOfflineInventorySearchMock.mockReturnValue({
      snapshotBoxes: [
        buildBox({
          boxId: 'IL1-6890',
          warehouse: 'IL1',
          feetAvailable: 99,
          physicalFeetAvailable: 99,
          allocatableNowFeet: 99,
          allocationPlanningFeet: 99,
          initialFeet: 100,
          lastRollWeightLbs: 24.65,
          coreWeightLbs: 1.3333,
          lfWeightLbsPerFt: 0.233167
        })
      ],
      isError: false,
      error: null,
      isLoading: false,
      isOffline: false,
      isSyncing: false,
      syncError: null,
      hasSnapshot: true,
      lastSyncedAt: new Date().toISOString(),
      refetch: vi.fn()
    });

    renderPage('/labels?q=6890');

    const row = getRowForBox('IL1-6890');
    expect(within(row).getByText('100')).toBeTruthy();

    fireEvent.click(within(row).getByRole('button', { name: 'Label A' }));

    expect((screen.getAllByLabelText('Balance')[0] as HTMLInputElement).value).toBe('100');
  });

  it('does not show the old first-150 warning and waits for search before rendering rows', () => {
    renderPage('/labels');

    const matchingBoxes = getMatchingBoxesSection();
    expect(screen.queryByText(/Showing the first 150 matches/i)).toBeNull();
    expect(matchingBoxes.queryByRole('table')).toBeNull();
    expect(
      screen.getByText('Search by Box ID, manufacturer, film, width, or lot run to find labels.')
    ).toBeTruthy();
  });

  it('shows at most 10 searched matches and uses normal count text', () => {
    useOfflineInventorySearchMock.mockReturnValue({
      snapshotBoxes: Array.from({ length: 12 }, (_, index) =>
        buildBox({
          boxId: `MO1-${String(index + 1).padStart(4, '0')}`,
          lotRun: `SEARCH-${index + 1}`
        })
      ),
      isError: false,
      error: null,
      isLoading: false,
      isOffline: false,
      isSyncing: false,
      syncError: null,
      hasSnapshot: true,
      lastSyncedAt: new Date().toISOString(),
      refetch: vi.fn()
    });

    renderPage('/labels?q=MO1');

    const table = getMatchingBoxesTable();
    expect(within(table).getAllByRole('row')).toHaveLength(11);
    expect(screen.getByText('Showing 10 of 12')).toBeTruthy();
    expect(screen.queryByText(/Showing the first 150 matches/i)).toBeNull();
  });

  it('applies filters to searched matching boxes', () => {
    useOfflineInventorySearchMock.mockReturnValue({
      snapshotBoxes: [
        buildBox({ boxId: 'MO1-0028', warehouse: 'MO1', filmName: 'DR 15' }),
        buildBox({ boxId: 'IL1-0029', warehouse: 'IL1', filmName: 'DR 15' })
      ],
      isError: false,
      error: null,
      isLoading: false,
      isOffline: false,
      isSyncing: false,
      syncError: null,
      hasSnapshot: true,
      lastSyncedAt: new Date().toISOString(),
      refetch: vi.fn()
    });

    renderPage('/labels?q=DR&warehouse=IL1');

    const table = getMatchingBoxesTable();
    expect(within(table).getByText('IL1-0029')).toBeTruthy();
    expect(within(table).queryByText('MO1-0028')).toBeNull();
  });

  it('shows searched results after the user enters a search term', async () => {
    renderPage('/labels');

    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'MO1' } });

    await waitFor(() => expect(screen.getByText('MO1-0028')).toBeTruthy());
    expect(getMatchingBoxesTable()).toBeTruthy();
  });

  it('keeps warehouse visible in selected label summaries after removing it from Matching Boxes', () => {
    renderPage();

    const table = getMatchingBoxesTable();
    expect(within(table).queryByRole('columnheader', { name: 'Warehouse' })).toBeNull();

    fireEvent.click(within(getRowForBox('MO1-0028')).getByRole('button', { name: 'Label A' }));

    const summary = screen.getByLabelText('Selected box summary for Label A');
    expect(summary.textContent).toContain('Warehouse');
    expect(summary.textContent).toContain('MO1');
  });

  it('constrains Lot Run and keeps Label A / Label B actions visible in the table layout', () => {
    const longLotRun = '405G021-LONG-LOT-RUN-VALUE-THAT-SHOULD-TRUNCATE';
    useOfflineInventorySearchMock.mockReturnValue({
      snapshotBoxes: [buildBox({ lotRun: longLotRun })],
      isError: false,
      error: null,
      isLoading: false,
      isOffline: false,
      isSyncing: false,
      syncError: null,
      hasSnapshot: true,
      lastSyncedAt: new Date().toISOString(),
      refetch: vi.fn()
    });

    const { container } = renderPage();
    const row = getRowForBox('MO1-0028');
    const lotRunCell = within(row).getByLabelText(`Lot run ${longLotRun}`);
    const useCell = row.querySelector('.label-results-use-cell');

    expect(container.querySelector('.label-results-table')).toBeTruthy();
    expect(container.querySelector('.label-results-col-lot-run')).toBeTruthy();
    expect(container.querySelector('.label-results-col-warehouse')).toBeNull();
    expect(lotRunCell.classList.contains('label-results-lot-run-cell')).toBe(true);
    expect(lotRunCell.getAttribute('title')).toBe(longLotRun);
    expect(lotRunCell.querySelector('.label-results-lot-run-text')).toBeTruthy();
    expect(useCell).toBeTruthy();
    expect(useCell?.classList.contains('label-results-use-cell')).toBe(true);
    expect(within(row).getByRole('button', { name: 'Label A' })).toBeTruthy();
    expect(within(row).getByRole('button', { name: 'Label B' })).toBeTruthy();
  });

  it('removes template and duplicate-copy controls from the labels workspace', () => {
    renderPage();

    expect(screen.queryByLabelText('Template')).toBeNull();
    expect(screen.queryByText('Labels Workspace')).toBeNull();
    expect(screen.queryByRole('button', { name: /Duplicate A to B/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Print 2 Copies/i })).toBeNull();
  });

  it('shades selected Label A and Label B buttons for the assigned row only', () => {
    renderPage();

    const selectedRow = getRowForBox('MO1-0028');
    const otherRow = getRowForBox('MO1-0029');
    const selectedAButton = within(selectedRow).getByRole('button', { name: 'Label A' });
    const selectedBButton = within(selectedRow).getByRole('button', { name: 'Label B' });
    const otherAButton = within(otherRow).getByRole('button', { name: 'Label A' });
    const otherBButton = within(otherRow).getByRole('button', { name: 'Label B' });

    expect(selectedAButton.classList.contains('label-result-button-selected')).toBe(false);
    expect(selectedBButton.classList.contains('label-result-button-selected')).toBe(false);

    fireEvent.click(selectedAButton);

    expect(selectedAButton.classList.contains('label-result-button-selected')).toBe(true);
    expect(selectedAButton.getAttribute('aria-pressed')).toBe('true');
    expect(selectedBButton.classList.contains('label-result-button-selected')).toBe(false);
    expect(otherAButton.classList.contains('label-result-button-selected')).toBe(false);
    expect(otherBButton.classList.contains('label-result-button-selected')).toBe(false);

    fireEvent.click(selectedBButton);

    expect(selectedAButton.classList.contains('label-result-button-selected')).toBe(true);
    expect(selectedBButton.classList.contains('label-result-button-selected')).toBe(true);
    expect(selectedBButton.getAttribute('aria-pressed')).toBe('true');
    expect(otherAButton.classList.contains('label-result-button-selected')).toBe(false);
    expect(otherBButton.classList.contains('label-result-button-selected')).toBe(false);
  });

  it('shows selected-box summaries, renamed fields, and supports clearing the selected box', () => {
    renderPage();
    fireEvent.click(within(getRowForBox('MO1-0028')).getByRole('button', { name: 'Label A' }));

    expect(screen.getByRole('heading', { name: 'MO1-0028' })).toBeTruthy();
    expect(screen.getByLabelText('Selected box summary for Label A').textContent).toContain('405G021');
    expect(screen.queryByText(/Similar boxes share this manufacturer/i)).toBeNull();
    expect((screen.getAllByLabelText('Date')[0] as HTMLInputElement).value).toBe(formatTodayForLabelTest());
    expect(screen.getAllByLabelText('Film Name')).toHaveLength(2);
    expect(screen.getAllByLabelText('Box ID')).toHaveLength(2);
    expect(screen.queryByText('Film Name Display')).toBeNull();
    expect(screen.queryByText('Film ID')).toBeNull();

    const enabledClearButton = screen
      .getAllByRole('button', { name: 'Clear Selected Box' })
      .find((button) => !(button as HTMLButtonElement).disabled);
    if (!enabledClearButton) {
      throw new Error('Expected one enabled clear button.');
    }
    fireEvent.click(enabledClearButton);

    expect(screen.getAllByRole('heading', { name: 'No box selected' })).toHaveLength(2);
    expect(screen.getByText('Select a box for Label A or Label B before printing.')).toBeTruthy();
  });

  it('keeps missing-data warnings visible while required blanks disable printing', async () => {
    useOfflineInventorySearchMock.mockReturnValue({
      snapshotBoxes: [
        buildBox({
          widthIn: Number.NaN,
          lotRun: '',
          feetAvailable: Number.NaN,
          physicalFeetAvailable: null,
          initialWeightLbs: null,
          lastRollWeightLbs: null
        })
      ],
      isError: false,
      error: null,
      isLoading: false,
      isOffline: false,
      isSyncing: false,
      syncError: null,
      hasSnapshot: true,
      lastSyncedAt: new Date().toISOString(),
      refetch: vi.fn()
    });

    renderPage();
    fireEvent.click(within(getRowForBox('MO1-0028')).getByRole('button', { name: 'Label A' }));

    expect(screen.getByText('Width is missing. Confirm the label width before printing.')).toBeTruthy();
    expect(screen.getByText('Run number is missing.')).toBeTruthy();
    expect(screen.getByText("Doesn't have weight.")).toBeTruthy();
    expect(screen.getByText('Missing current feet.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Print Labels' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Complete Weight lbs, Balance, Width for Label A before printing.')).toBeTruthy();

    fireEvent.change(screen.getAllByLabelText('Weight lbs')[0], { target: { value: '9.25' } });
    fireEvent.change(screen.getAllByLabelText('Balance')[0], { target: { value: '44' } });
    fireEvent.change(screen.getAllByLabelText('Width')[0], { target: { value: '60"' } });

    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Print Labels' }) as HTMLButtonElement).disabled).toBe(false)
    );
  });

  it('renders a single Label A in the left physical position', async () => {
    renderPage();

    fireEvent.click(within(getRowForBox('MO1-0028')).getByRole('button', { name: 'Label A' }));

    const previewPanel = getPreviewPanel();
    const previewSheet = previewPanel.querySelector('.label-print-sheet-single');
    const printRoot = getPrintOnlyRoot();

    expect(previewSheet).toBeTruthy();
    expect(within(previewPanel).getByLabelText('Printable Label A')).toBeTruthy();
    expect(within(previewPanel).queryByLabelText('Printable Label B')).toBeNull();
    expect(previewPanel.querySelector('.print-label-card-empty[data-slot="B"]')).toBeTruthy();
    expect(printRoot).toBeTruthy();
    expect(printRoot?.querySelector('.label-print-sheet-single')).toBeTruthy();
    expect(printRoot?.querySelector('.print-label-card-empty[data-slot="B"]')).toBeTruthy();
    expect(printRoot?.textContent).toContain('Llumar DR 15');
    expect(previewSheet?.textContent).toContain('Llumar DR 15');
    await within(previewPanel).findByAltText('QR code for MO1-0028');
  });

  it('renders exactly one printable sheet inside the print root', async () => {
    renderPage();

    fireEvent.click(within(getRowForBox('MO1-0028')).getByRole('button', { name: 'Label A' }));

    const previewPanel = getPreviewPanel();
    const printRoots = Array.from(document.body.children).filter(
      (element) =>
        element instanceof HTMLElement &&
        element.classList.contains('label-print-only-root') &&
        element.classList.contains('print-root')
    );

    expect(previewPanel.querySelector('.label-print-root.print-root')).toBeNull();
    expect(previewPanel.querySelectorAll('.label-print-sheet')).toHaveLength(1);
    expect(printRoots).toHaveLength(1);
    expect(printRoots[0].querySelectorAll('.label-print-sheet')).toHaveLength(1);
    await within(previewPanel).findByAltText('QR code for MO1-0028');
  });

  it('renders a single Label B in the right physical position', async () => {
    renderPage();

    fireEvent.click(within(getRowForBox('MO1-0029')).getByRole('button', { name: 'Label B' }));

    const previewPanel = getPreviewPanel();
    const previewSheet = previewPanel.querySelector('.label-print-sheet-single');
    const printRoot = getPrintOnlyRoot();

    expect(previewSheet).toBeTruthy();
    expect(previewPanel.querySelector('.print-label-card-empty[data-slot="A"]')).toBeTruthy();
    expect(within(previewPanel).queryByLabelText('Printable Label A')).toBeNull();
    expect(within(previewPanel).getByLabelText('Printable Label B')).toBeTruthy();
    expect(printRoot).toBeTruthy();
    expect(printRoot?.querySelector('.label-print-sheet-single')).toBeTruthy();
    expect(printRoot?.querySelector('.print-label-card-empty[data-slot="A"]')).toBeTruthy();
    expect(printRoot?.textContent).toContain('405G022');
    expect(previewSheet?.textContent).toContain('405G022');
    await within(previewPanel).findByAltText('QR code for MO1-0029');
  });

  it('renders both selected slots as a double-label sheet and preserves Label B edits', async () => {
    renderPage();

    fireEvent.click(within(getRowForBox('MO1-0029')).getByRole('button', { name: 'Label B' }));
    fireEvent.change(screen.getAllByLabelText('Film Name')[1], { target: { value: 'Manual B Film' } });
    fireEvent.click(within(getRowForBox('MO1-0028')).getByRole('button', { name: 'Label A' }));

    const previewPanel = getPreviewPanel();
    const previewSheet = previewPanel.querySelector('.label-print-sheet-double');
    const printRoot = getPrintOnlyRoot();

    expect(previewSheet).toBeTruthy();
    expect(within(previewPanel).getByLabelText('Printable Label A')).toBeTruthy();
    expect(within(previewPanel).getByLabelText('Printable Label B')).toBeTruthy();
    expect(printRoot).toBeTruthy();
    expect(printRoot?.querySelector('.label-print-sheet-double')).toBeTruthy();
    expect(printRoot?.textContent).toContain('Llumar DR 15');
    expect(printRoot?.textContent).toContain('Manual B Film');
    expect(previewSheet?.textContent).toContain('Manual B Film');
    expect((screen.getAllByLabelText('Film Name')[1] as HTMLInputElement).value).toBe('Manual B Film');
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Print Labels' }) as HTMLButtonElement).disabled).toBe(false)
    );
  });

  it('does not disable printing for blank optional fields', async () => {
    renderPage();

    fireEvent.click(within(getRowForBox('MO1-0028')).getByRole('button', { name: 'Label A' }));
    expect((screen.getAllByLabelText('Job ID')[0] as HTMLInputElement).value).toBe('');
    expect((screen.getAllByLabelText('BY')[0] as HTMLInputElement).value).toBe('');
    expect((screen.getAllByLabelText('Checked')[0] as HTMLInputElement).value).toBe('');

    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Print Labels' }) as HTMLButtonElement).disabled).toBe(false)
    );
  });

  it('disables printing when a required field is blank', async () => {
    renderPage();

    fireEvent.click(within(getRowForBox('MO1-0028')).getByRole('button', { name: 'Label A' }));
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Print Labels' }) as HTMLButtonElement).disabled).toBe(false)
    );

    fireEvent.change(screen.getAllByLabelText('Weight lbs')[0], { target: { value: '' } });

    expect((screen.getByRole('button', { name: 'Print Labels' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Complete Weight lbs for Label A before printing.')).toBeTruthy();
  });

  it('calls window.print only after selected slots and QR codes are ready', async () => {
    renderPage();

    expect((screen.getByRole('button', { name: 'Print Labels' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(getRowForBox('MO1-0028')).getByRole('button', { name: 'Label A' }));

    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Print Labels' }) as HTMLButtonElement).disabled).toBe(false)
    );
    fireEvent.click(screen.getByRole('button', { name: 'Print Labels' }));

    expect(window.print).toHaveBeenCalledTimes(1);
    expect(createBoxQrCodeDataUrlMock).toHaveBeenCalledWith('MO1-0028');
  });

  it('shows stale inventory and QR failure states', async () => {
    createBoxQrCodeDataUrlMock.mockRejectedValueOnce(new Error('QR failed'));
    useOfflineInventorySearchMock.mockReturnValue({
      snapshotBoxes: [buildBox()],
      isError: false,
      error: null,
      isLoading: false,
      isOffline: true,
      isSyncing: false,
      syncError: null,
      hasSnapshot: true,
      lastSyncedAt: '2026-04-01T00:00:00.000Z',
      refetch: vi.fn()
    });

    renderPage();
    expect(screen.getByText('This box data may be outdated. Refresh inventory if needed.')).toBeTruthy();

    fireEvent.click(within(getRowForBox('MO1-0028')).getByRole('button', { name: 'Label A' }));

    await screen.findByText('QR code for Label A failed. Refresh or select the box again.');
    expect((screen.getByRole('button', { name: 'Print Labels' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { addWarehouse } from '../../../api/features/warehouseClient';
import { WarehouseSelectField } from './WarehouseSelectField';

const useAuthMock = vi.fn();
const useWarehouseRegistryMock = vi.fn();
const addWarehouseMock = vi.mocked(addWarehouse);

vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => useAuthMock()
}));

vi.mock('../hooks/useWarehouseRegistry', () => ({
  useWarehouseRegistry: () => useWarehouseRegistryMock(),
  warehouseRegistryQueryKey: ['warehouses']
}));

vi.mock('../../../api/features/warehouseClient', () => ({
  addWarehouse: vi.fn()
}));

function renderWarehouseField(props: Partial<ComponentProps<typeof WarehouseSelectField>> = {}) {
  const queryClient = new QueryClient();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <WarehouseSelectField
        value="IL1"
        onChange={() => {}}
        {...props}
      />
    </QueryClientProvider>
  );
  queryClient.clear();
  return html;
}

function renderWarehouseFieldDom(props: Partial<ComponentProps<typeof WarehouseSelectField>> = {}) {
  const queryClient = new QueryClient();
  const onChange = vi.fn();
  const result = render(
    <QueryClientProvider client={queryClient}>
      <WarehouseSelectField
        value=""
        onChange={onChange}
        {...props}
      />
    </QueryClientProvider>
  );
  return { ...result, queryClient, onChange };
}

function optionLabels(html: string) {
  return Array.from(html.matchAll(/<option[^>]*>(.*?)<\/option>/g)).map((match) => match[1]);
}

describe('WarehouseSelectField', () => {
  beforeEach(() => {
    cleanup();
    addWarehouseMock.mockReset();
    useWarehouseRegistryMock.mockReturnValue({
      entries: [
        { code: 'IL1', name: 'Wauconda IL1', boxIdPrefix: 'IL1' },
        { code: 'MS1', name: 'Ridgeland MS1', boxIdPrefix: 'MS1' }
      ],
      scopeReady: true,
      isSuccess: true
    });
  });

  it('shows owner add option as the final entry for filter dropdowns', () => {
    useAuthMock.mockReturnValue({ isOwner: true });

    const html = renderWarehouseField({
      value: '',
      allowAll: true
    });

    expect(optionLabels(html)).toEqual([
      'All Warehouses',
      'Wauconda IL1',
      'Ridgeland MS1',
      'Add New Warehouse...'
    ]);
  });

  it('hides owner add option for non-owners', () => {
    useAuthMock.mockReturnValue({ isOwner: false });

    const html = renderWarehouseField({
      value: '',
      allowAll: true
    });

    expect(optionLabels(html)).toEqual([
      'All Warehouses',
      'Wauconda IL1',
      'Ridgeland MS1'
    ]);
    expect(html).not.toContain('Add New Warehouse...');
  });

  it('renders only MI1 when the current org warehouse list contains only MI1', () => {
    useAuthMock.mockReturnValue({ isOwner: false });
    useWarehouseRegistryMock.mockReturnValue({
      entries: [{ code: 'MI1', name: 'Auburn Hills', boxIdPrefix: 'MI1' }],
      scopeReady: true,
      isSuccess: true
    });

    const html = renderWarehouseField({
      value: 'MI1'
    });

    expect(optionLabels(html)).toEqual(['Auburn Hills MI1']);
    expect(html).not.toContain('Wauconda IL1');
    expect(html).not.toContain('Ridgeland MS1');
  });

  it('keeps filter dropdowns scoped to All plus the current org warehouses', () => {
    useAuthMock.mockReturnValue({ isOwner: false });
    useWarehouseRegistryMock.mockReturnValue({
      entries: [{ code: 'MI1', name: 'Auburn Hills', boxIdPrefix: 'MI1' }],
      scopeReady: true,
      isSuccess: true
    });

    const html = renderWarehouseField({
      value: '',
      allowAll: true
    });

    expect(optionLabels(html)).toEqual(['All Warehouses', 'Auburn Hills MI1']);
    expect(html).not.toContain('Wauconda IL1');
    expect(html).not.toContain('Ridgeland MS1');
  });

  it('does not add a fake selected option when the value is absent from the current org registry', () => {
    useAuthMock.mockReturnValue({ isOwner: false });

    const html = renderWarehouseField({
      value: 'MI1',
      allowAll: true
    });

    expect(optionLabels(html)).toEqual([
      'All Warehouses',
      'Wauconda IL1',
      'Ridgeland MS1'
    ]);
    expect(html).not.toContain('MI1');
  });

  it('retains a syntactically valid selected warehouse while the registry is pending', () => {
    useAuthMock.mockReturnValue({ isOwner: false });
    useWarehouseRegistryMock.mockReturnValue({
      entries: [],
      scopeReady: false,
      isSuccess: false
    });

    const html = renderWarehouseField({
      value: 'MI1',
      allowAll: true
    });

    expect(optionLabels(html)).toEqual(['All Warehouses', 'MI1']);
  });

  it('allows owners to add a first warehouse without showing internal defaults', () => {
    useAuthMock.mockReturnValue({ isOwner: true });
    useWarehouseRegistryMock.mockReturnValue({
      entries: [],
      scopeReady: true,
      isSuccess: true
    });

    const html = renderWarehouseField({
      value: '',
      allowAll: true
    });

    expect(optionLabels(html)).toEqual(['All Warehouses', 'Add New Warehouse...']);
    expect(html).toContain('No warehouses are configured for this organization yet. Add a warehouse to continue.');
    expect(html).not.toContain('Wauconda IL1');
    expect(html).not.toContain('Ridgeland MS1');
  });

  it('lets owners add warehouses with city/state instead of manual code and prefix fields', async () => {
    useAuthMock.mockReturnValue({ isOwner: true });
    useWarehouseRegistryMock.mockReturnValue({
      entries: [],
      scopeReady: true,
      isSuccess: true
    });
    addWarehouseMock.mockResolvedValueOnce({
      code: 'MI1',
      name: 'Auburn Hills MI1',
      boxIdPrefix: 'MI1'
    });
    const { onChange, queryClient } = renderWarehouseFieldDom();

    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: '__add_warehouse__' }
    });

    expect(screen.getByRole('dialog', { name: 'Add Warehouse' })).toBeTruthy();
    expect(screen.getByLabelText('City')).toBeTruthy();
    expect(screen.getByLabelText('State')).toBeTruthy();
    expect(screen.queryByLabelText('Warehouse Code')).toBeNull();
    expect(screen.queryByLabelText('BoxID Prefix')).toBeNull();

    fireEvent.change(screen.getByLabelText('City'), { target: { value: 'Auburn Hills' } });
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'mi' } });

    expect((screen.getByLabelText('State') as HTMLInputElement).value).toBe('MI');
    expect(screen.getByText('This will create: Auburn Hills MI1')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Add Warehouse' }));

    await waitFor(() => {
      expect(addWarehouseMock.mock.calls[0]?.[0]).toEqual({
        code: 'MI1',
        name: 'Auburn Hills MI1',
        boxIdPrefix: 'MI1'
      });
    });
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('MI1'));
    queryClient.clear();
  });

  it('generates the next warehouse code for existing same-state warehouses', async () => {
    useAuthMock.mockReturnValue({ isOwner: true });
    useWarehouseRegistryMock.mockReturnValue({
      entries: [
        { code: 'MI1', name: 'Auburn Hills', boxIdPrefix: 'MI1' },
        { code: 'MI2', name: 'Auburn Hills MI2', boxIdPrefix: 'MI2' }
      ],
      scopeReady: true,
      isSuccess: true
    });
    addWarehouseMock.mockResolvedValueOnce({
      code: 'MI3',
      name: 'Auburn Hills MI3',
      boxIdPrefix: 'MI3'
    });
    const { queryClient } = renderWarehouseFieldDom();

    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: '__add_warehouse__' }
    });
    fireEvent.change(screen.getByLabelText('City'), { target: { value: '  Auburn Hills  ' } });
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'MI' } });

    expect(screen.getByText('This will create: Auburn Hills MI3')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add Warehouse' }));

    await waitFor(() => {
      expect(addWarehouseMock.mock.calls[0]?.[0]).toEqual({
        code: 'MI3',
        name: 'Auburn Hills MI3',
        boxIdPrefix: 'MI3'
      });
    });
    queryClient.clear();
  });

  it('validates blank city and invalid state before creating a warehouse', () => {
    useAuthMock.mockReturnValue({ isOwner: true });
    const { queryClient } = renderWarehouseFieldDom();

    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: '__add_warehouse__' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add Warehouse' }));
    expect(screen.getByText('City is required.')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('City'), { target: { value: 'Auburn Hills' } });
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'M' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add Warehouse' }));
    expect(screen.getByText('State must be a valid two-letter abbreviation, such as MI.')).toBeTruthy();
    expect(addWarehouseMock).not.toHaveBeenCalled();
    queryClient.clear();
  });

  it('shows a safe empty warehouse state instead of injecting IL1/MS1', () => {
    useAuthMock.mockReturnValue({ isOwner: false });
    useWarehouseRegistryMock.mockReturnValue({
      entries: [],
      scopeReady: true,
      isSuccess: true
    });

    const html = renderWarehouseField({
      value: ''
    });

    expect(optionLabels(html)).toEqual(['No warehouses configured']);
    expect(html).toContain('No warehouses are configured for this organization yet.');
    expect(html).not.toContain('Wauconda IL1');
    expect(html).not.toContain('Ridgeland MS1');
  });

  it('keeps native select options readable in dark theme', () => {
    const css = readFileSync('src/styles.css', 'utf8');

    expect(css).toMatch(/select option\s*{/);
    expect(css).toMatch(/background-color:\s*var\(--color-surface-solid\)/);
    expect(css).toMatch(/:root\[data-theme="dark"\] select\s*{/);
    expect(css).toMatch(/color-scheme:\s*dark/);
  });
});

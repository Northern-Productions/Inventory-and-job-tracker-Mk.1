import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WarehouseSelectField } from './WarehouseSelectField';

const useAuthMock = vi.fn();
const useWarehouseRegistryMock = vi.fn();

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

function optionLabels(html: string) {
  return Array.from(html.matchAll(/<option[^>]*>(.*?)<\/option>/g)).map((match) => match[1]);
}

describe('WarehouseSelectField', () => {
  beforeEach(() => {
    useWarehouseRegistryMock.mockReturnValue({
      entries: [
        { code: 'IL1', name: 'Wauconda IL1', boxIdPrefix: 'IL1' },
        { code: 'MS1', name: 'Ridgeland MS1', boxIdPrefix: 'MS1' }
      ]
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
      'Wauconda IL1 (IL1)',
      'Ridgeland MS1 (MS1)',
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
      'Wauconda IL1 (IL1)',
      'Ridgeland MS1 (MS1)'
    ]);
    expect(html).not.toContain('Add New Warehouse...');
  });

  it('renders only MI1 when the current org warehouse list contains only MI1', () => {
    useAuthMock.mockReturnValue({ isOwner: false });
    useWarehouseRegistryMock.mockReturnValue({
      entries: [{ code: 'MI1', name: 'Auburn Hills', boxIdPrefix: 'MI1' }]
    });

    const html = renderWarehouseField({
      value: 'MI1'
    });

    expect(optionLabels(html)).toEqual(['Auburn Hills (MI1)']);
    expect(html).not.toContain('Wauconda IL1');
    expect(html).not.toContain('Ridgeland MS1');
  });

  it('keeps filter dropdowns scoped to All plus the current org warehouses', () => {
    useAuthMock.mockReturnValue({ isOwner: false });
    useWarehouseRegistryMock.mockReturnValue({
      entries: [{ code: 'MI1', name: 'Auburn Hills', boxIdPrefix: 'MI1' }]
    });

    const html = renderWarehouseField({
      value: '',
      allowAll: true
    });

    expect(optionLabels(html)).toEqual(['All Warehouses', 'Auburn Hills (MI1)']);
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
      'Wauconda IL1 (IL1)',
      'Ridgeland MS1 (MS1)'
    ]);
    expect(html).not.toContain('MI1');
  });

  it('allows owners to add a first warehouse without showing internal defaults', () => {
    useAuthMock.mockReturnValue({ isOwner: true });
    useWarehouseRegistryMock.mockReturnValue({
      entries: []
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

  it('shows a safe empty warehouse state instead of injecting IL1/MS1', () => {
    useAuthMock.mockReturnValue({ isOwner: false });
    useWarehouseRegistryMock.mockReturnValue({
      entries: []
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
    const css = readFileSync(new URL('../../../styles.css', import.meta.url), 'utf8');

    expect(css).toMatch(/select option\s*{/);
    expect(css).toMatch(/background-color:\s*var\(--color-surface-solid\)/);
    expect(css).toMatch(/:root\[data-theme="dark"\] select\s*{/);
    expect(css).toMatch(/color-scheme:\s*dark/);
  });
});

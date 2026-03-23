import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Input, TextArea } from './Input';
import { Select } from './Select';

describe('Input primitives', () => {
  it('renders labels, hints, errors, and caller classes for text inputs', () => {
    const html = renderToStaticMarkup(
      <Input
        label="Email"
        hint="We will never share this."
        error="Required"
        className="custom-input"
        type="email"
        inputMode="email"
        autoComplete="email"
      />
    );

    expect(html).toContain('class="field field-invalid"');
    expect(html).toContain('>Email<');
    expect(html).toContain('class="field-input custom-input"');
    expect(html).toContain('type="email"');
    expect(html).toContain('inputMode="email"');
    expect(html).toContain('autoComplete="email"');
    expect(html).toContain('aria-describedby=');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('We will never share this.');
    expect(html).toContain('Required');
  });

  it('renders textarea and select variants with the current wrapper structure', () => {
    const html = renderToStaticMarkup(
      <>
        <TextArea label="Notes" rows={3} placeholder="Add notes" />
        <Select
          label="Warehouse"
          value="IL1"
          hint="Choose the warehouse to filter."
          error="Warehouse is required"
          onChange={() => undefined}
          options={[
            { label: 'All', value: '' },
            { label: 'Wauconda IL1', value: 'IL1' }
          ]}
        />
      </>
    );

    expect(html).toContain('<textarea');
    expect(html).toContain('rows="3"');
    expect(html).toContain('placeholder="Add notes"');
    expect(html).toContain('Choose the warehouse to filter.');
    expect(html).toContain('Warehouse is required');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('<option value="">All</option>');
    expect(html).toContain('<option value="IL1" selected="">Wauconda IL1</option>');
  });
});

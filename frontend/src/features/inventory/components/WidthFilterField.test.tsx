import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { WidthFilterField } from './WidthFilterField';

describe('WidthFilterField', () => {
  it('renders toggle chips without an all-width control and exposes pressed state', () => {
    const html = renderToStaticMarkup(
      <WidthFilterField
        widths={['36', '72.5']}
        rememberedCustomWidth="72.5"
        onWidthsChange={() => undefined}
        onRememberedCustomWidthChange={() => undefined}
        dialogTitle="Custom Width"
        dialogTitleId="test-width-dialog-title"
      />
    );

    expect(html).not.toContain('>ALL<');
    expect(html).not.toContain('All Widths');
    expect(html).toContain('>36<');
    expect(html).toContain('>48<');
    expect(html).toContain('>72.5<');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-pressed="false"');
  });
});

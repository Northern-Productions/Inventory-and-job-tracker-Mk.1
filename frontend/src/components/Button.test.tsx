import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Button } from './Button';

describe('Button', () => {
  it('keeps the default primary styling and native button props', () => {
    const html = renderToStaticMarkup(
      <Button type="submit" data-qa="save-button">
        Save
      </Button>
    );

    expect(html).toContain('class="button button-primary button-size-md"');
    expect(html).toContain('type="submit"');
    expect(html).toContain('data-qa="save-button"');
    expect(html).toContain('>Save</button>');
  });

  it('preserves variant, full-width, and caller class names together', () => {
    const html = renderToStaticMarkup(
      <Button variant="secondary" fullWidth className="button-job-new" disabled>
        New Job +
      </Button>
    );

    expect(html).toContain('class="button button-secondary button-size-md button-full button-job-new"');
    expect(html).toContain('disabled');
    expect(html).toContain('>New Job +</button>');
  });

  it('adds loading affordances without changing the caller API surface', () => {
    const html = renderToStaticMarkup(
      <Button variant="ghost" size="lg" loading loadingLabel="Saving box">
        Save
      </Button>
    );

    expect(html).toContain('class="button button-ghost button-size-lg button-loading"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('disabled=""');
    expect(html).toContain('button-spinner');
    expect(html).toContain('Saving box');
  });
});

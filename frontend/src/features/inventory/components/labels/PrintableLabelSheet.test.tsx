import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PrintableLabelSheet, LABEL_TEMPLATE_PRESETS } from './PrintableLabelSheet';
import type { LabelDraft } from '../../utils/labelMaker';

const draft: LabelDraft = {
  date: '05/03/2026',
  jobId: '',
  weightLbs: '8.15',
  by: 'JS',
  balance: '100',
  checked: '',
  filmName: 'Llumar DR 15',
  width: '48"',
  boxId: '0028',
  runNumber: '405G021'
};

describe('PrintableLabelSheet', () => {
  it('keeps measured template presets for single and double labels', () => {
    expect(LABEL_TEMPLATE_PRESETS.single.pageWidthIn).toBe(11);
    expect(LABEL_TEMPLATE_PRESETS.single.pageHeightIn).toBe(8.5);
    expect(LABEL_TEMPLATE_PRESETS.single.orientation).toBe('landscape');
    expect(LABEL_TEMPLATE_PRESETS.single.gridRowHeightsIn).toHaveLength(11);
    expect(LABEL_TEMPLATE_PRESETS.double.gridColumnWidthsIn).toHaveLength(6);
    expect(LABEL_TEMPLATE_PRESETS.double.pageMarginsIn.left).toBe(
      LABEL_TEMPLATE_PRESETS.double.pageMarginsIn.right
    );
    expect(
      LABEL_TEMPLATE_PRESETS.double.pageMarginsIn.left + LABEL_TEMPLATE_PRESETS.double.labelWidthIn
    ).toBeCloseTo(5.5, 4);
  });

  it('renders the same printable sheet structure used by preview and print', () => {
    const html = renderToStaticMarkup(
      <PrintableLabelSheet
        labels={[
          {
            slot: 'A',
            draft,
            qrDataUrl: 'data:image/png;base64,abc',
            qrPayload: 'MO1-0028',
            qrError: ''
          }
        ]}
      />
    );

    expect(html).toContain('label-print-sheet-single');
    expect(html).toContain('data-slot="B"');
    expect(html).toContain('Llumar DR 15');
    expect(html).toContain('0028');
    expect(html).toContain('print-label-qr-box');
    expect(html).toContain('print-label-film-name');
    expect(html).toContain('print-label-width');
    expect(html).toContain('print-label-grid-value-key-metric');
    expect(html).toContain('print-label-box-id-block');
    expect(html).toContain('print-label-box-id-value');
    expect(html).toContain('print-label-run-number-block');
    expect(html).toContain('print-label-run-number-value');
    expect(html).toContain('* Box ID*');
    expect(html).toContain('Please return film back to Midwest Glass Tinters, Inc (847) 487-8777');
  });

  it('preserves the A physical position for a single Label A', () => {
    const html = renderToStaticMarkup(
      <PrintableLabelSheet
        labels={[
          {
            slot: 'A',
            draft,
            qrDataUrl: 'data:image/png;base64,abc',
            qrPayload: 'MO1-0028',
            qrError: ''
          }
        ]}
      />
    );

    expect(html.indexOf('Printable Label A')).toBeLessThan(html.indexOf('data-slot="B"'));
    expect(html).not.toContain('Printable Label B');
  });

  it('preserves the B physical position for a single Label B', () => {
    const html = renderToStaticMarkup(
      <PrintableLabelSheet
        labels={[
          {
            slot: 'B',
            draft,
            qrDataUrl: 'data:image/png;base64,abc',
            qrPayload: 'MO1-0028',
            qrError: ''
          }
        ]}
      />
    );

    expect(html.indexOf('data-slot="A"')).toBeLessThan(html.indexOf('Printable Label B'));
    expect(html).not.toContain('Printable Label A');
  });

  it('renders both physical positions when both slots are selected', () => {
    const html = renderToStaticMarkup(
      <PrintableLabelSheet
        labels={[
          {
            slot: 'A',
            draft,
            qrDataUrl: 'data:image/png;base64,abc',
            qrPayload: 'MO1-0028',
            qrError: ''
          },
          {
            slot: 'B',
            draft: { ...draft, boxId: '0029' },
            qrDataUrl: 'data:image/png;base64,def',
            qrPayload: 'MO1-0029',
            qrError: ''
          }
        ]}
      />
    );

    expect(html).toContain('label-print-sheet-double');
    expect(html).toContain('grid-template-columns:5.3125in 5.3125in');
    expect(html).toContain('Printable Label A');
    expect(html).toContain('Printable Label B');
    expect(html).toContain('0029');
  });

  it('keeps bottom metadata values prominent and contained without changing the boxed cells', () => {
    const styles = readFileSync('src/styles.css', 'utf8');
    const boxIdRule = styles.match(/\.print-label-box-id-value\s*\{[^}]*font-size:\s*([0-9.]+)pt/s);
    const runNumberRule = styles.match(
      /\.print-label-run-number-value\s*\{[^}]*font-size:\s*([0-9.]+)pt/s
    );

    expect(styles).toContain('.print-label-box-id-block {');
    expect(styles).toContain('.print-label-run-number-block {');
    expect(styles).toContain('grid-template-rows: 0.16in minmax(0, 1fr)');
    expect(boxIdRule?.[1]).toBe('34');
    expect(runNumberRule?.[1]).toBe('30');
    expect(Number(runNumberRule?.[1])).toBeLessThan(Number(boxIdRule?.[1]));
    expect(styles).toContain('overflow-wrap: anywhere');
    expect(styles).toContain('word-break: break-word');
  });

  it('makes job id, weight, and balance log values larger than the other grid values', () => {
    const html = renderToStaticMarkup(
      <PrintableLabelSheet
        labels={[
          {
            slot: 'A',
            draft,
            qrDataUrl: 'data:image/png;base64,abc',
            qrPayload: 'MO1-0028',
            qrError: ''
          }
        ]}
      />
    );
    const styles = readFileSync('src/styles.css', 'utf8');
    const keyMetricRule = styles.match(
      /\.print-label-grid-value-key-metric\s*\{[^}]*font-size:\s*([0-9.]+)pt[^}]*font-weight:\s*([0-9]+)/s
    );

    expect(html.match(/print-label-grid-value-key-metric/g)).toHaveLength(3);
    expect(keyMetricRule?.[1]).toBe('18');
    expect(keyMetricRule?.[2]).toBe('900');
  });

  it('includes print CSS that hides app controls and prints only the label root', () => {
    const styles = readFileSync('src/styles.css', 'utf8');
    const labelBodyRule = styles.match(/body\.label-printing\s*\{([^}]*)\}/s)?.[1] || '';
    const appRootRule = styles.match(/body\.label-printing #root\s*\{([^}]*)\}/s)?.[1] || '';
    const printHostRule =
      styles.match(
        /body\.label-printing > \.label-print-only-root\.print-root\s*\{([^}]*)\}/s
      )?.[1] || '';
    const sheetBreakRule =
      styles.match(
        /body\.label-printing > \.label-print-only-root\.print-root > \.label-print-sheet:not\(:last-child\)\s*\{([^}]*)\}/s
      )?.[1] || '';

    expect(styles).toContain('@media print');
    expect(styles).toContain('body.label-printing *');
    expect(styles).toContain('visibility: hidden !important');
    expect(styles).toContain('.print-root');
    expect(styles).toContain('body.label-printing > .label-print-only-root');
    expect(styles).toContain('visibility: visible !important');
    expect(styles).toContain('size: letter landscape');
    expect(styles).toContain('@page label-page');
    expect(styles).toContain('margin: 0');
    expect(labelBodyRule).toContain('page: label-page');
    expect(labelBodyRule).toContain('height: auto !important');
    expect(labelBodyRule).toContain('overflow: visible !important');
    expect(appRootRule).toContain('display: none !important');
    expect(printHostRule).toContain('position: static !important');
    expect(printHostRule).toContain('height: auto !important');
    expect(printHostRule).not.toContain('break-after');
    expect(sheetBreakRule).toContain('break-after: page');
    expect(sheetBreakRule).toContain('page-break-after: always');
    expect(styles).toContain('width: 11in !important');
    expect(styles).toContain('height: 8.5in !important');
    expect(styles).toContain('will-change: auto !important');
    expect(styles).toContain('overflow: hidden !important');
    expect(styles).toContain('overflow: visible !important');
    expect(styles).toContain('.label-print-only-root .label-print-sheet');
    expect(styles).toContain('.print-label-details {');
    expect(styles).toContain('border: 1px solid #000');
    expect(styles).toContain('.print-label-qr-box {');
    expect(styles).toContain('.print-label-film-name {');
    expect(styles).toContain('.print-label-width {');
    expect(styles).toContain('.print-label-box-id-block {');
    expect(styles).toContain('border-right: 1px solid #000');
    expect(styles).toContain('border-bottom: 1px solid #000');
    expect(styles).toContain('white-space: nowrap');
    expect(styles).not.toContain('page-break-before');
    expect(styles).not.toContain('break-before');
  });
});

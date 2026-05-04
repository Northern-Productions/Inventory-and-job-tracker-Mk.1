import type { ComponentType, CSSProperties } from 'react';
import type { LabelDraft, LabelSlot, LabelTemplateId } from '../../utils/labelMaker';

export interface LabelTemplatePreset {
  id: LabelTemplateId;
  pageWidthIn: number;
  pageHeightIn: number;
  orientation: 'landscape';
  pageMarginsIn: {
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
  labelWidthIn: number;
  labelHeightIn: number;
  gridColumnWidthsIn: number[];
  gridRowHeightsIn: number[];
  detailColumnWidthsIn: number[];
  qrAreaWidthIn: number;
  qrAreaHeightIn: number;
  fontSizesPt: {
    header: number;
    data: number;
    film: number;
    meta: number;
  };
}

export interface PrintableLabel {
  slot: LabelSlot;
  draft: LabelDraft;
  qrDataUrl: string;
  qrPayload: string;
  qrError: string;
}

type PrintableLabelsBySlot = Partial<Record<LabelSlot, PrintableLabel>>;

export interface PrintableTemplateProps {
  labelsBySlot: PrintableLabelsBySlot;
  preset: LabelTemplatePreset;
}

export type LabelTemplate = {
  id: LabelTemplateId;
  label: string;
  render: ComponentType<PrintableTemplateProps>;
  preset: LabelTemplatePreset;
};

const SINGLE_GRID_ROW_HEIGHTS = [
  0.3958,
  0.3736,
  0.375,
  0.4569,
  0.4271,
  0.4167,
  0.3542,
  0.3854,
  0.4153,
  0.4153,
  0.3229
];

const DOUBLE_LABEL_HORIZONTAL_MARGIN_IN = 0.1875;
const DOUBLE_LABEL_WIDTH_IN = 5.3125;
const DOUBLE_LABEL_HEIGHT_IN = 8.3;

export const LABEL_TEMPLATE_PRESETS: Record<LabelTemplateId, LabelTemplatePreset> = {
  single: {
    id: 'single',
    pageWidthIn: 11,
    pageHeightIn: 8.5,
    orientation: 'landscape',
    pageMarginsIn: {
      top: 0.125,
      right: 0.125,
      bottom: 0.25,
      left: 0.5
    },
    labelWidthIn: 5.1771,
    labelHeightIn: 7.6574,
    gridColumnWidthsIn: [0.95, 0.86, 0.86, 0.62, 0.91, 0.8381],
    gridRowHeightsIn: SINGLE_GRID_ROW_HEIGHTS,
    detailColumnWidthsIn: [1.3854, 2.7812, 0.875],
    qrAreaWidthIn: 1.3854,
    qrAreaHeightIn: 1.6146,
    fontSizesPt: {
      header: 9,
      data: 9,
      film: 20,
      meta: 12
    }
  },
  double: {
    id: 'double',
    pageWidthIn: 11,
    pageHeightIn: 8.5,
    orientation: 'landscape',
    pageMarginsIn: {
      top: 0.08,
      right: DOUBLE_LABEL_HORIZONTAL_MARGIN_IN,
      bottom: 0.12,
      left: DOUBLE_LABEL_HORIZONTAL_MARGIN_IN
    },
    labelWidthIn: DOUBLE_LABEL_WIDTH_IN,
    labelHeightIn: DOUBLE_LABEL_HEIGHT_IN,
    gridColumnWidthsIn: [0.99, 0.91, 0.91, 0.58, 0.96, 0.8285],
    gridRowHeightsIn: [
      0.4591,
      0.4334,
      0.435,
      0.53,
      0.5784,
      0.5075,
      0.4109,
      0.4471,
      0.4817,
      0.4817,
      0.3746
    ],
    detailColumnWidthsIn: [1.38, 2.91, 0.8885],
    qrAreaWidthIn: 1.38,
    qrAreaHeightIn: 1.72,
    fontSizesPt: {
      header: 9,
      data: 9,
      film: 20,
      meta: 12
    }
  }
};

function sumInches(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function getLogValueClassName(index: number): string {
  return [
    'print-label-grid-cell',
    'print-label-grid-value',
    index === 0 ? 'print-label-grid-value-date' : '',
    index === 2 || index === 4 ? 'print-label-grid-value-key-metric' : ''
  ]
    .filter(Boolean)
    .join(' ');
}

function LabelLogGrid({ draft, preset }: { draft: LabelDraft; preset: LabelTemplatePreset }) {
  return (
    <div
      className="print-label-log-grid"
      style={{
        width: `${sumInches(preset.gridColumnWidthsIn)}in`,
        gridTemplateColumns: preset.gridColumnWidthsIn.map((width) => `${width}in`).join(' '),
        gridTemplateRows: preset.gridRowHeightsIn.map((height) => `${height}in`).join(' ')
      }}
    >
      {Array.from({ length: 9 }).map((_, rowIndex) =>
        preset.gridColumnWidthsIn.map((__, columnIndex) => (
          <div key={`${rowIndex}:${columnIndex}`} className="print-label-grid-cell" />
        ))
      )}
      {[draft.date, draft.jobId, draft.weightLbs, draft.by, draft.balance, draft.checked].map((value, index) => (
        <div
          key={`value-${index}`}
          className={getLogValueClassName(index)}
        >
          {value}
        </div>
      ))}
      {['Date', 'Job ID', 'Weight lbs', 'BY', 'Balance', 'Checked'].map((value, index) => (
        <div key={`heading-${index}`} className="print-label-grid-cell print-label-grid-heading">
          {value}
        </div>
      ))}
    </div>
  );
}

function PrintableLabelCard({
  label,
  preset
}: {
  label: PrintableLabel;
  preset: LabelTemplatePreset;
}) {
  const qrAlt = label.qrPayload ? `QR code for ${label.qrPayload}` : 'QR code unavailable';
  const cardStyle: CSSProperties = {
    width: `${preset.labelWidthIn}in`,
    height: `${preset.labelHeightIn}in`
  };

  return (
    <article className="print-label-card" aria-label={`Printable Label ${label.slot}`} style={cardStyle}>
      <header className="print-label-header">
        Please return film back to Midwest Glass Tinters, Inc (847) 487-8777
      </header>

      <LabelLogGrid draft={label.draft} preset={preset} />

      <section
        className="print-label-details"
        style={{
          width: `${sumInches(preset.detailColumnWidthsIn)}in`,
          gridTemplateColumns: preset.detailColumnWidthsIn.map((width) => `${width}in`).join(' ')
        }}
      >
        <div className="print-label-qr-box">
          {label.qrDataUrl ? (
            <img src={label.qrDataUrl} alt={qrAlt} />
          ) : (
            <div className="print-label-qr-fallback">
              {label.qrError ? 'QR unavailable' : 'Generating QR'}
            </div>
          )}
        </div>
        <div className="print-label-film-name" title={label.draft.filmName}>
          {label.draft.filmName}
        </div>
        <div className="print-label-width" title={label.draft.width}>
          {label.draft.width}
        </div>
        <div className="print-label-box-id-block">
          <span className="print-label-meta-heading">* Box ID*</span>
          <span className="print-label-meta-value print-label-box-id-value">{label.draft.boxId}</span>
        </div>
        <div className="print-label-run-number-block">
          <span className="print-label-meta-heading">*Run Number*</span>
          <span className="print-label-meta-value print-label-run-number-value">
            {label.draft.runNumber}
          </span>
        </div>
      </section>
    </article>
  );
}

function PrintableLabelSlot({
  label,
  preset,
  slot
}: {
  label: PrintableLabel | undefined;
  preset: LabelTemplatePreset;
  slot: LabelSlot;
}) {
  if (!label) {
    return (
      <div
        className="print-label-card print-label-card-empty"
        aria-hidden="true"
        data-slot={slot}
        style={{
          width: `${preset.labelWidthIn}in`,
          height: `${preset.labelHeightIn}in`
        }}
      />
    );
  }

  return <PrintableLabelCard label={label} preset={preset} />;
}

function SlotAwareLabelTemplate({ labelsBySlot, preset }: PrintableTemplateProps) {
  return (
    <div
      className="print-label-columns print-label-columns-double"
      data-label-slots={Object.keys(labelsBySlot).join('')}
      style={{
        gridTemplateColumns: `${preset.labelWidthIn}in ${preset.labelWidthIn}in`
      }}
    >
      <PrintableLabelSlot label={labelsBySlot.A} preset={preset} slot="A" />
      <PrintableLabelSlot label={labelsBySlot.B} preset={preset} slot="B" />
    </div>
  );
}

export const LABEL_TEMPLATES: Record<LabelTemplateId, LabelTemplate> = {
  single: {
    id: 'single',
    label: 'Single Label',
    render: SlotAwareLabelTemplate,
    preset: LABEL_TEMPLATE_PRESETS.single
  },
  double: {
    id: 'double',
    label: 'Double Label',
    render: SlotAwareLabelTemplate,
    preset: LABEL_TEMPLATE_PRESETS.double
  }
};

interface PrintableLabelSheetProps {
  labels: PrintableLabel[];
}

export function PrintableLabelSheet({ labels }: PrintableLabelSheetProps) {
  const templateId: LabelTemplateId = labels.length > 1 ? 'double' : 'single';
  const template = LABEL_TEMPLATES.double;
  const TemplateComponent = template.render;
  const preset = template.preset;
  const labelsBySlot = labels.reduce<PrintableLabelsBySlot>((result, label) => {
    result[label.slot] = label;
    return result;
  }, {});

  return (
    <div
      className={`label-print-sheet label-print-sheet-${templateId}`}
      style={{
        width: `${preset.pageWidthIn}in`,
        height: `${preset.pageHeightIn}in`,
        padding: `${preset.pageMarginsIn.top}in ${preset.pageMarginsIn.right}in ${preset.pageMarginsIn.bottom}in ${preset.pageMarginsIn.left}in`
      }}
      data-template={templateId}
    >
      <TemplateComponent labelsBySlot={labelsBySlot} preset={preset} />
    </div>
  );
}

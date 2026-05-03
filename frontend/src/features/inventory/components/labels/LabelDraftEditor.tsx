import { Input } from '../../../../components/Input';
import type { LabelDraft } from '../../utils/labelMaker';

interface LabelDraftEditorProps {
  draft: LabelDraft;
  disabled?: boolean;
  onChange: (field: keyof LabelDraft, value: string) => void;
}

const EDITABLE_FIELDS: Array<{
  key: keyof LabelDraft;
  label: string;
  type?: string;
}> = [
  { key: 'date', label: 'Date' },
  { key: 'jobId', label: 'Job ID' },
  { key: 'weightLbs', label: 'Weight lbs' },
  { key: 'by', label: 'BY' },
  { key: 'balance', label: 'Balance' },
  { key: 'checked', label: 'Checked' },
  { key: 'filmName', label: 'Film Name' },
  { key: 'width', label: 'Width' },
  { key: 'boxId', label: 'Box ID' },
  { key: 'runNumber', label: 'Run Number' }
];

export function LabelDraftEditor({
  draft,
  disabled = false,
  onChange
}: LabelDraftEditorProps) {
  return (
    <div className="label-draft-editor">
      {EDITABLE_FIELDS.map((field) => (
        <Input
          key={field.key}
          label={field.label}
          type={field.type || 'text'}
          value={draft[field.key]}
          disabled={disabled}
          onChange={(event) => onChange(field.key, event.target.value)}
        />
      ))}
    </div>
  );
}

import { TextArea } from '../../../../components/Input';

interface NotesSectionProps {
  notes: string;
  onChange: (value: string) => void;
}

export function NotesSection({ notes, onChange }: NotesSectionProps) {
  return (
    <div className="form-section">
      <div className="form-section-header">
        <h3>Notes</h3>
        <p className="muted-text">Capture anything installers or coordinators should see later.</p>
      </div>
      <TextArea
        label="Notes"
        value={notes}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

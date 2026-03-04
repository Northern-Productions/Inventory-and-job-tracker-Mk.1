import type { InputHTMLAttributes, TextareaHTMLAttributes } from 'react';

interface BaseProps {
  label: string;
  error?: string;
  hint?: string;
}

type InputProps = BaseProps & InputHTMLAttributes<HTMLInputElement>;
type TextAreaProps = BaseProps & TextareaHTMLAttributes<HTMLTextAreaElement>;

export function Input({ label, error, hint, className = '', ...props }: InputProps) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input className={`field-input ${className}`.trim()} {...props} />
      {hint ? <span className="field-hint">{hint}</span> : null}
      {error ? <span className="field-error">{error}</span> : null}
    </label>
  );
}

export function TextArea({
  label,
  error,
  hint,
  className = '',
  ...props
}: TextAreaProps) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <textarea className={`field-input field-textarea ${className}`.trim()} {...props} />
      {hint ? <span className="field-hint">{hint}</span> : null}
      {error ? <span className="field-error">{error}</span> : null}
    </label>
  );
}

import { useId } from 'react';
import type { InputHTMLAttributes, TextareaHTMLAttributes } from 'react';

interface BaseProps {
  label: string;
  error?: string;
  hint?: string;
}

type InputProps = BaseProps & InputHTMLAttributes<HTMLInputElement>;
type TextAreaProps = BaseProps & TextareaHTMLAttributes<HTMLTextAreaElement>;

function buildDescribedBy(
  ariaDescribedBy: string | undefined,
  hintId: string | undefined,
  errorId: string | undefined
) {
  return [ariaDescribedBy, hintId, errorId].filter(Boolean).join(' ') || undefined;
}

export function Input({
  label,
  error,
  hint,
  className = '',
  id,
  'aria-describedby': ariaDescribedBy,
  'aria-invalid': ariaInvalid,
  ...props
}: InputProps) {
  const generatedId = useId();
  const inputId = id || generatedId;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy = buildDescribedBy(ariaDescribedBy, hintId, errorId);

  return (
    <label className={`field ${error ? 'field-invalid' : ''}`.trim()}>
      <span className="field-label">{label}</span>
      <input
        id={inputId}
        className={`field-input ${className}`.trim()}
        aria-describedby={describedBy}
        aria-invalid={ariaInvalid ?? (Boolean(error) || undefined)}
        {...props}
      />
      {hint ? (
        <span id={hintId} className="field-hint">
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={errorId} className="field-error">
          {error}
        </span>
      ) : null}
    </label>
  );
}

export function TextArea({
  label,
  error,
  hint,
  className = '',
  id,
  'aria-describedby': ariaDescribedBy,
  'aria-invalid': ariaInvalid,
  ...props
}: TextAreaProps) {
  const generatedId = useId();
  const inputId = id || generatedId;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy = buildDescribedBy(ariaDescribedBy, hintId, errorId);

  return (
    <label className={`field ${error ? 'field-invalid' : ''}`.trim()}>
      <span className="field-label">{label}</span>
      <textarea
        id={inputId}
        className={`field-input field-textarea ${className}`.trim()}
        aria-describedby={describedBy}
        aria-invalid={ariaInvalid ?? (Boolean(error) || undefined)}
        {...props}
      />
      {hint ? (
        <span id={hintId} className="field-hint">
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={errorId} className="field-error">
          {error}
        </span>
      ) : null}
    </label>
  );
}

import { useId } from 'react';
import type { SelectHTMLAttributes } from 'react';

interface Option {
  label: string;
  value: string;
}

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: string;
  options: readonly Option[];
  error?: string;
  hint?: string;
}

export function Select({
  label,
  options,
  error,
  hint,
  className = '',
  id,
  'aria-describedby': ariaDescribedBy,
  'aria-invalid': ariaInvalid,
  ...props
}: SelectProps) {
  const generatedId = useId();
  const selectId = id || generatedId;
  const hintId = hint ? `${selectId}-hint` : undefined;
  const errorId = error ? `${selectId}-error` : undefined;
  const describedBy = [ariaDescribedBy, hintId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <label className={`field ${error ? 'field-invalid' : ''}`.trim()}>
      <span className="field-label">{label}</span>
      <select
        id={selectId}
        className={`field-input ${className}`.trim()}
        aria-describedby={describedBy}
        aria-invalid={ariaInvalid ?? (Boolean(error) || undefined)}
        {...props}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
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

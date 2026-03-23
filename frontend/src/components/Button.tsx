import type { ButtonHTMLAttributes, PropsWithChildren } from 'react';

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  fullWidth?: boolean;
  size?: ButtonSize;
  loading?: boolean;
  loadingLabel?: string;
}

export function Button({
  children,
  className = '',
  variant = 'primary',
  fullWidth = false,
  size = 'md',
  loading = false,
  loadingLabel,
  disabled,
  ...props
}: PropsWithChildren<ButtonProps>) {
  const classes = ['button', `button-${variant}`, `button-size-${size}`];
  if (fullWidth) {
    classes.push('button-full');
  }
  if (className) {
    classes.push(className);
  }
  if (loading) {
    classes.push('button-loading');
  }

  const resolvedDisabled = disabled || loading;

  return (
    <button className={classes.join(' ')} disabled={resolvedDisabled} aria-busy={loading || undefined} {...props}>
      {loading ? (
        <>
          <span className="button-spinner" aria-hidden="true" />
          <span>{loadingLabel || children}</span>
        </>
      ) : (
        children
      )}
    </button>
  );
}

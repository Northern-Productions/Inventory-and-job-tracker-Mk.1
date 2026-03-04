import type { ButtonHTMLAttributes, PropsWithChildren } from 'react';

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  fullWidth?: boolean;
}

export function Button({
  children,
  className = '',
  variant = 'primary',
  fullWidth = false,
  ...props
}: PropsWithChildren<ButtonProps>) {
  const classes = ['button', `button-${variant}`];
  if (fullWidth) {
    classes.push('button-full');
  }
  if (className) {
    classes.push(className);
  }

  return (
    <button className={classes.join(' ')} {...props}>
      {children}
    </button>
  );
}

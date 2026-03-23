import { useState, type ButtonHTMLAttributes, type MouseEvent } from 'react';
import { Button } from '../../components/Button';
import { useToast } from '../../components/Toast';
import { useAuth } from './AuthContext';

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

interface UsernameChangeControlProps {
  buttonVariant?: ButtonVariant;
  buttonClassName?: string;
  onOpen?: () => void;
  buttonProps?: ButtonHTMLAttributes<HTMLButtonElement>;
}

export function UsernameChangeControl({
  buttonVariant = 'ghost',
  buttonClassName = '',
  onOpen,
  buttonProps
}: UsernameChangeControlProps) {
  const auth = useAuth();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  function openDialog() {
    setDraft(auth.session?.user?.name || '');
    setError('');
    setOpen(true);
    onOpen?.();
  }

  function handleButtonClick(event: MouseEvent<HTMLButtonElement>) {
    buttonProps?.onClick?.(event);
    if (event.defaultPrevented) {
      return;
    }

    openDialog();
  }

  function closeDialog() {
    if (isSubmitting) {
      return;
    }
    setOpen(false);
    setError('');
  }

  async function handleSubmit() {
    const nextName = draft.trim();
    if (!nextName) {
      setError('Username is required.');
      return;
    }

    setIsSubmitting(true);
    setError('');

    try {
      const result = await auth.requestUsernameChange(nextName);
      if (result.status === 'approved') {
        toast.push({
          title: 'Username updated',
          description: `Your display name is now ${result.username}.`
        });
      } else {
        toast.push({
          title: 'Request submitted',
          description: 'An admin or owner must approve this username change.'
        });
      }
      setOpen(false);
    } catch (submitError) {
      setError(
        submitError instanceof Error && submitError.message
          ? submitError.message
          : 'Username update failed.'
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        variant={buttonVariant}
        className={buttonClassName}
        {...buttonProps}
        onClick={handleButtonClick}
      >
        Change Username
      </Button>
      {open ? (
        <div className="dialog-backdrop" role="presentation" onClick={closeDialog}>
          <div
            className="dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="username-change-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="dialog-header">
              <h2 id="username-change-title">Change Username</h2>
              <button type="button" className="dialog-close" onClick={closeDialog} aria-label="Close">
                X
              </button>
            </div>
            <label className="field">
              <span className="field-label">Username</span>
              <input
                className="field-input"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                autoComplete="nickname"
                maxLength={64}
                autoFocus
              />
            </label>
            <p className="field-hint">
              Admin and owner updates apply immediately. Member updates require admin approval.
            </p>
            {error ? <p className="error-text">{error}</p> : null}
            <div className="dialog-actions">
              <Button type="button" variant="ghost" onClick={closeDialog} disabled={isSubmitting}>
                Cancel
              </Button>
              <Button type="button" onClick={() => void handleSubmit()} disabled={isSubmitting}>
                {isSubmitting ? 'Submitting...' : 'Submit'}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

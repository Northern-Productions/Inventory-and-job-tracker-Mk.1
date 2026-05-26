import { useState, type ButtonHTMLAttributes, type MouseEvent } from 'react';
import { Button } from '../../components/Button';
import { useToast } from '../../components/Toast';
import type { Warehouse } from '../../domain';
import { reloadPage } from '../../lib/pageReload';
import { WarehouseSelectField } from '../inventory/components/WarehouseSelectField';
import { useDefaultWarehouse } from '../inventory/hooks/useDefaultWarehouse';
import { useAuth } from './AuthContext';

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

interface DefaultWarehouseControlProps {
  buttonVariant?: ButtonVariant;
  buttonClassName?: string;
  onOpen?: () => void;
  buttonProps?: ButtonHTMLAttributes<HTMLButtonElement>;
}

export function DefaultWarehouseControl({
  buttonVariant = 'ghost',
  buttonClassName = '',
  onOpen,
  buttonProps
}: DefaultWarehouseControlProps) {
  const auth = useAuth();
  const toast = useToast();
  const defaultWarehouse = useDefaultWarehouse();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Warehouse | ''>(defaultWarehouse);
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  function openDialog() {
    setDraft(defaultWarehouse);
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
    setIsSubmitting(true);
    setError('');

    try {
      await auth.updateDefaultWarehouse(draft);
      reloadPage();
    } catch (submitError) {
      const message =
        submitError instanceof Error && submitError.message
          ? submitError.message
          : 'Warehouse update failed.';
      setError(message);
      toast.push({
        title: 'Unable to update warehouse',
        description: message,
        variant: 'error'
      });
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
        Change warehouse
      </Button>
      {open ? (
        <div className="dialog-backdrop" role="presentation" onClick={closeDialog}>
          <div
            className="dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="default-warehouse-title"
            aria-describedby="default-warehouse-description"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="dialog-header">
              <h2 id="default-warehouse-title">Change warehouse</h2>
              <button type="button" className="dialog-close" onClick={closeDialog} aria-label="Close">
                X
              </button>
            </div>
            <p id="default-warehouse-description" className="field-hint">
              Select the warehouse you usually work from. This will be used as your default filter across the app.
            </p>
            <WarehouseSelectField
              value={draft}
              onChange={setDraft}
              allowAll
              includeAddOption={false}
              disabled={isSubmitting}
            />
            {error ? <p className="error-text">{error}</p> : null}
            <div className="dialog-actions">
              <Button type="button" variant="ghost" onClick={closeDialog} disabled={isSubmitting}>
                Cancel
              </Button>
              <Button type="button" onClick={() => void handleSubmit()} disabled={isSubmitting}>
                {isSubmitting ? 'Saving...' : 'Save'}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

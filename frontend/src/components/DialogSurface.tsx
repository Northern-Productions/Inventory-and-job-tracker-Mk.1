import { useEffect, useLayoutEffect, useRef, type PropsWithChildren } from 'react';
import { createPortal } from 'react-dom';

interface DialogSurfaceProps extends PropsWithChildren {
  open: boolean;
  onClose?: () => void;
  titleId?: string;
  descriptionId?: string;
  className?: string;
  backdropClassName?: string;
  closeOnBackdrop?: boolean;
  closeOnEscape?: boolean;
  role?: 'dialog' | 'alertdialog';
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not(:disabled)',
  'input:not(:disabled)',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  '[tabindex]:not([tabindex="-1"])'
].join(', ');

const OPEN_DIALOG_STACK: string[] = [];
const OPEN_DIALOG_ELEMENTS = new Map<string, HTMLElement>();
let bodyOverflowBeforeLock = '';
let dialogSurfaceIdCounter = 0;
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

function createDialogSurfaceId() {
  dialogSurfaceIdCounter += 1;
  return `dialog-surface-${dialogSurfaceIdCounter}`;
}

function isTopmostDialog(dialogId: string) {
  return OPEN_DIALOG_STACK[OPEN_DIALOG_STACK.length - 1] === dialogId;
}

function getFocusableElements(container: HTMLElement | null) {
  if (!container) {
    return [];
  }

  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((element) => {
    return !element.hasAttribute('disabled') && element.getAttribute('aria-hidden') !== 'true';
  });
}

export function DialogSurface({
  children,
  open,
  onClose,
  titleId,
  descriptionId,
  className = '',
  backdropClassName = '',
  closeOnBackdrop = false,
  closeOnEscape = true,
  role = 'dialog'
}: DialogSurfaceProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const dialogIdRef = useRef('');
  const onCloseRef = useRef(onClose);
  const closeOnEscapeRef = useRef(closeOnEscape);

  if (!dialogIdRef.current) {
    dialogIdRef.current = createDialogSurfaceId();
  }

  useEffect(() => {
    onCloseRef.current = onClose;
    closeOnEscapeRef.current = closeOnEscape;
  }, [closeOnEscape, onClose]);

  useIsomorphicLayoutEffect(() => {
    if (!open || typeof document === 'undefined') {
      return;
    }

    previouslyFocusedRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialogId = dialogIdRef.current;
    if (!OPEN_DIALOG_STACK.length) {
      bodyOverflowBeforeLock = document.body.style.overflow;
    }
    OPEN_DIALOG_STACK.push(dialogId);
    if (dialogRef.current) {
      OPEN_DIALOG_ELEMENTS.set(dialogId, dialogRef.current);
    }
    document.body.style.overflow = 'hidden';

    const focusInitialTarget = () => {
      const dialog = dialogRef.current;
      if (!dialog || !isTopmostDialog(dialogId)) {
        return;
      }

      if (document.activeElement instanceof HTMLElement && dialog.contains(document.activeElement)) {
        return;
      }

      const autoFocusTarget = dialog.querySelector<HTMLElement>('[autofocus]');
      const focusable = getFocusableElements(dialog);
      (autoFocusTarget || focusable[0] || dialog).focus();
    };
    focusInitialTarget();
    const frame = window.requestAnimationFrame(focusInitialTarget);

    const handleKeyDown = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (!dialog) {
        return;
      }

      if (!isTopmostDialog(dialogId) || event.defaultPrevented) {
        return;
      }

      const latestOnClose = onCloseRef.current;
      if (event.key === 'Escape' && closeOnEscapeRef.current && latestOnClose) {
        event.preventDefault();
        latestOnClose();
        return;
      }

      if (event.key !== 'Tab') {
        return;
      }

      const focusable = getFocusableElements(dialog);

      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeElement = document.activeElement;

      if (event.shiftKey && activeElement === first) {
        event.preventDefault();
        last.focus();
        return;
      }

      if (!event.shiftKey && activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      window.cancelAnimationFrame(frame);
      const dialogIndex = OPEN_DIALOG_STACK.lastIndexOf(dialogId);
      if (dialogIndex >= 0) {
        OPEN_DIALOG_STACK.splice(dialogIndex, 1);
      }
      OPEN_DIALOG_ELEMENTS.delete(dialogId);
      if (!OPEN_DIALOG_STACK.length) {
        document.body.style.overflow = bodyOverflowBeforeLock;
      }
      document.removeEventListener('keydown', handleKeyDown);
      const previousFocus = previouslyFocusedRef.current;
      if (
        previousFocus &&
        typeof previousFocus.focus === 'function' &&
        document.contains(previousFocus) &&
        !OPEN_DIALOG_STACK.length
      ) {
        previousFocus.focus();
      } else {
        const topmostDialog = OPEN_DIALOG_ELEMENTS.get(OPEN_DIALOG_STACK[OPEN_DIALOG_STACK.length - 1]);
        if (topmostDialog) {
          const focusable = getFocusableElements(topmostDialog);
          (focusable[0] || topmostDialog).focus();
        }
      }
    };
  }, [open]);

  if (!open) {
    return null;
  }

  const dialogMarkup = (
    <div
      className={`dialog-backdrop ${backdropClassName}`.trim()}
      role="presentation"
      onClick={
        closeOnBackdrop && onClose
          ? () => {
              if (isTopmostDialog(dialogIdRef.current)) {
                onClose();
              }
            }
          : undefined
      }
    >
      <div
        ref={dialogRef}
        className={`dialog ${className}`.trim()}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );

  if (typeof document === 'undefined') {
    return dialogMarkup;
  }

  return createPortal(dialogMarkup, document.body);
}

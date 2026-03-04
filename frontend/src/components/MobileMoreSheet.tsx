import { useEffect, useRef, type RefObject } from 'react';
import { useNavigate } from 'react-router-dom';
import type { MobileNavItem } from './MobileBottomNav';

interface MobileMoreSheetProps {
  open: boolean;
  items: MobileNavItem[];
  activePath: string;
  onClose: () => void;
  anchorRef: RefObject<HTMLButtonElement>;
}

function isActiveItem(pathname: string, to: string) {
  return pathname === to || pathname.startsWith(`${to}/`);
}

export function MobileMoreSheet({
  open,
  items,
  activePath,
  onClose,
  anchorRef
}: MobileMoreSheetProps) {
  const navigate = useNavigate();
  const sheetRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    const sheet = sheetRef.current;
    const focusable = sheet?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [];
    const firstButton = focusable[0];
    const lastButton = focusable[focusable.length - 1];

    firstButton?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key !== 'Tab' || focusable.length === 0) {
        return;
      }

      const activeElement = document.activeElement;

      if (event.shiftKey && activeElement === firstButton) {
        event.preventDefault();
        lastButton?.focus();
        return;
      }

      if (!event.shiftKey && activeElement === lastButton) {
        event.preventDefault();
        firstButton?.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      anchorRef.current?.focus();
    };
  }, [anchorRef, onClose, open]);

  if (!open) {
    return null;
  }

  return (
    <div className="mobile-more-sheet-backdrop" role="presentation" onClick={onClose}>
      <div
        ref={sheetRef}
        className="mobile-more-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mobile-more-sheet-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mobile-more-sheet-header">
          <h2 id="mobile-more-sheet-title">More</h2>
          <button type="button" className="dialog-close" aria-label="Close more menu" onClick={onClose}>
            X
          </button>
        </div>
        <div className="mobile-more-sheet-actions">
          {items.map((item) => (
            <button
              key={item.to}
              type="button"
              className={`mobile-more-link ${isActiveItem(activePath, item.to) ? 'mobile-more-link-active' : ''}`.trim()}
              onClick={() => {
                navigate(item.to);
                onClose();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

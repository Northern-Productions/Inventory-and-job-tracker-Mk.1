import type { RefObject } from 'react';
import { useNavigate } from 'react-router-dom';

export interface MobileNavItem {
  label: string;
  to: string;
  active?: boolean;
}

interface MobileBottomNavProps {
  items: MobileNavItem[];
  moreActive: boolean;
  isMoreOpen: boolean;
  onOpenMore: () => void;
  moreButtonRef: RefObject<HTMLButtonElement>;
}

export function MobileBottomNav({
  items,
  moreActive,
  isMoreOpen,
  onOpenMore,
  moreButtonRef
}: MobileBottomNavProps) {
  const navigate = useNavigate();

  return (
    <nav className="mobile-bottom-nav" aria-label="Primary">
      {items.map((item) => (
        <button
          key={item.to}
          type="button"
          className={`mobile-nav-link ${item.active ? 'mobile-nav-link-active' : ''}`.trim()}
          onClick={() => navigate(item.to)}
          aria-current={item.active ? 'page' : undefined}
        >
          {item.label}
        </button>
      ))}
      <button
        ref={moreButtonRef}
        type="button"
        className={`mobile-nav-link mobile-nav-more ${moreActive ? 'mobile-nav-link-active' : ''}`.trim()}
        onClick={onOpenMore}
        aria-haspopup="dialog"
        aria-expanded={isMoreOpen}
      >
        More
      </button>
    </nav>
  );
}

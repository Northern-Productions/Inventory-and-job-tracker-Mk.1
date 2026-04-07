import type { RefObject } from 'react';
import { useNavigate } from 'react-router-dom';

export interface MobileNavItem {
  label: string;
  to: string;
  active?: boolean;
  showAttentionDot?: boolean;
  attentionAriaLabel?: string;
}

interface MobileBottomNavProps {
  items: MobileNavItem[];
  moreActive: boolean;
  isMoreOpen: boolean;
  onOpenMore: () => void;
  moreButtonRef: RefObject<HTMLButtonElement>;
  moreHasAttentionDot?: boolean;
  moreAttentionAriaLabel?: string;
}

export function MobileBottomNav({
  items,
  moreActive,
  isMoreOpen,
  onOpenMore,
  moreButtonRef,
  moreHasAttentionDot = false,
  moreAttentionAriaLabel
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
          aria-label={item.showAttentionDot ? item.attentionAriaLabel || `${item.label} (needs attention)` : undefined}
        >
          <span className="nav-attention-label">
            {item.label}
            {item.showAttentionDot ? <span className="nav-attention-dot" aria-hidden="true" /> : null}
          </span>
        </button>
      ))}
      <button
        ref={moreButtonRef}
        type="button"
        className={`mobile-nav-link mobile-nav-more ${moreActive ? 'mobile-nav-link-active' : ''}`.trim()}
        onClick={onOpenMore}
        aria-haspopup="dialog"
        aria-expanded={isMoreOpen}
        aria-label={moreHasAttentionDot ? moreAttentionAriaLabel || 'More (needs attention)' : 'More'}
      >
        <span className="nav-attention-label">
          More
          {moreHasAttentionDot ? <span className="nav-attention-dot" aria-hidden="true" /> : null}
        </span>
      </button>
    </nav>
  );
}

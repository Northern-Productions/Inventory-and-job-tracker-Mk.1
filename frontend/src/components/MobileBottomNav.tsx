import type { RefObject } from 'react';
import { NavLink } from 'react-router-dom';
import { isUnmodifiedPrimaryClick } from '../features/navigation/NavigationCoordinator';

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
  onMainDefault: (path: '/' | '/allocations') => void;
}

export function MobileBottomNav({
  items,
  moreActive,
  isMoreOpen,
  onOpenMore,
  moreButtonRef,
  moreHasAttentionDot = false,
  moreAttentionAriaLabel,
  onMainDefault
}: MobileBottomNavProps) {
  return (
    <nav className="mobile-bottom-nav" aria-label="Primary">
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.to === '/'}
          className={`mobile-nav-link ${item.active ? 'mobile-nav-link-active' : ''}`.trim()}
          onClick={(event) => {
            if (
              (item.to === '/' || item.to === '/allocations') &&
              isUnmodifiedPrimaryClick(event)
            ) {
              event.preventDefault();
              onMainDefault(item.to);
            }
          }}
          aria-current={item.active ? 'page' : undefined}
          aria-label={item.showAttentionDot ? item.attentionAriaLabel || `${item.label} (needs attention)` : undefined}
        >
          <span className="nav-attention-label">
            {item.label}
            {item.showAttentionDot ? <span className="nav-attention-dot" aria-hidden="true" /> : null}
          </span>
        </NavLink>
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

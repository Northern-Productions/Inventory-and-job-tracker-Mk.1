import type { RefObject } from 'react';
import { NavLink } from 'react-router-dom';
import { isUnmodifiedPrimaryClick } from '../../features/navigation/NavigationCoordinator';
import type { ComputedNavItem } from './config';

interface DesktopNavigationProps {
  primaryItems: ComputedNavItem[];
  moreItems: ComputedNavItem[];
  moreRef: RefObject<HTMLDivElement>;
  isMoreActive: boolean;
  isMoreOpen: boolean;
  moreHasAttention: boolean;
  moreAttentionAriaLabel?: string;
  onToggleMore: () => void;
  onCloseMore: () => void;
  onMainDefault: (path: '/' | '/allocations') => void;
}

export function DesktopNavigation({
  primaryItems,
  moreItems,
  moreRef,
  isMoreActive,
  isMoreOpen,
  moreHasAttention,
  moreAttentionAriaLabel,
  onToggleMore,
  onCloseMore,
  onMainDefault
}: DesktopNavigationProps) {
  return (
    <div className="app-nav-shell">
      <nav
        className="app-nav"
        aria-label="Primary"
        style={{ gridTemplateColumns: `repeat(${primaryItems.length + 1}, minmax(0, 1fr))` }}
      >
        {primaryItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) => `nav-link ${isActive ? 'nav-link-active' : ''}`.trim()}
            aria-label={item.showAttentionDot ? item.attentionAriaLabel : undefined}
            onClick={(event) => {
              if (
                (item.to === '/' || item.to === '/allocations') &&
                isUnmodifiedPrimaryClick(event)
              ) {
                event.preventDefault();
                onMainDefault(item.to);
              }
            }}
          >
            <span className="nav-attention-label">
              {item.desktopLabel}
              {item.showAttentionDot ? <span className="nav-attention-dot" aria-hidden="true" /> : null}
            </span>
          </NavLink>
        ))}
        <div className="app-nav-more-wrap" ref={moreRef}>
          <button
            type="button"
            className={`nav-link nav-more-button ${isMoreActive || isMoreOpen ? 'nav-link-active' : ''}`.trim()}
            onClick={onToggleMore}
            aria-haspopup="menu"
            aria-expanded={isMoreOpen}
            aria-label={moreHasAttention ? moreAttentionAriaLabel || 'More (needs attention)' : 'More'}
          >
            <span className="nav-attention-label">
              More
              {moreHasAttention ? <span className="nav-attention-dot" aria-hidden="true" /> : null}
            </span>
          </button>
          {isMoreOpen ? (
            <div className="nav-more-menu" role="menu" aria-label="More pages">
              {moreItems.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={`nav-more-item ${item.active ? 'nav-more-item-active' : ''}`.trim()}
                  role="menuitem"
                  onClick={onCloseMore}
                  aria-label={item.showAttentionDot ? item.attentionAriaLabel : undefined}
                >
                  <span className="nav-attention-label">
                    {item.desktopLabel}
                    {item.showAttentionDot ? <span className="nav-attention-dot" aria-hidden="true" /> : null}
                  </span>
                </NavLink>
              ))}
            </div>
          ) : null}
        </div>
      </nav>
    </div>
  );
}

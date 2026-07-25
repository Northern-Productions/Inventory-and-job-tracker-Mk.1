import type { RefObject } from 'react';
import type { MobileNavItem } from '../MobileBottomNav';
import { MobileBottomNav } from '../MobileBottomNav';
import { MobileMoreSheet } from '../MobileMoreSheet';

interface MobileNavigationProps {
  primaryItems: MobileNavItem[];
  moreItems: MobileNavItem[];
  activePath: string;
  isMoreActive: boolean;
  isMoreOpen: boolean;
  moreButtonRef: RefObject<HTMLButtonElement>;
  moreHasAttention: boolean;
  moreAttentionAriaLabel?: string;
  onToggleMore: () => void;
  onCloseMore: () => void;
  onMainDefault: (path: '/' | '/allocations') => void;
}

export function MobileNavigation({
  primaryItems,
  moreItems,
  activePath,
  isMoreActive,
  isMoreOpen,
  moreButtonRef,
  moreHasAttention,
  moreAttentionAriaLabel,
  onToggleMore,
  onCloseMore,
  onMainDefault
}: MobileNavigationProps) {
  return (
    <>
      <MobileBottomNav
        items={primaryItems}
        moreActive={isMoreActive}
        isMoreOpen={isMoreOpen}
        onOpenMore={onToggleMore}
        moreButtonRef={moreButtonRef}
        moreHasAttentionDot={moreHasAttention}
        moreAttentionAriaLabel={moreAttentionAriaLabel}
        onMainDefault={onMainDefault}
      />
      <MobileMoreSheet
        open={isMoreOpen}
        items={moreItems}
        activePath={activePath}
        onClose={onCloseMore}
        anchorRef={moreButtonRef}
      />
    </>
  );
}

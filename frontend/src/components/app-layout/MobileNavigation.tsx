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
  onCloseMore
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

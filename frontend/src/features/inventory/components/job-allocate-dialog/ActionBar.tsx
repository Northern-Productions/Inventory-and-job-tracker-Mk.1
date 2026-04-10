import { Button } from '../../../../components/Button';

interface ActionBarProps {
  isSubmitting: boolean;
  isOrderFilmMode: boolean;
  isMatchingBoxesLoading: boolean;
  isAllocationPreviewLoading: boolean;
  isAllocatePending: boolean;
  isCreateFilmOrderPending: boolean;
  canSubmit: boolean;
  allocateLabel?: string;
  onCancel: () => void;
  onSubmit: () => void;
}

export function ActionBar({
  isSubmitting,
  isOrderFilmMode,
  isMatchingBoxesLoading,
  isAllocationPreviewLoading,
  isAllocatePending,
  isCreateFilmOrderPending,
  canSubmit,
  allocateLabel = 'Allocate',
  onCancel,
  onSubmit
}: ActionBarProps) {
  return (
    <div className="dialog-actions dialog-actions-sticky-footer">
      <Button type="button" variant="ghost" fullWidth onClick={onCancel} disabled={isSubmitting}>
        Cancel
      </Button>
      <Button
        type="button"
        variant="secondary"
        fullWidth
        onClick={onSubmit}
        disabled={isMatchingBoxesLoading || isAllocationPreviewLoading || isSubmitting || !canSubmit}
      >
        {isOrderFilmMode
          ? isCreateFilmOrderPending
            ? 'Ordering...'
            : 'Order Film'
          : isAllocatePending
            ? 'Saving...'
            : allocateLabel}
      </Button>
    </div>
  );
}

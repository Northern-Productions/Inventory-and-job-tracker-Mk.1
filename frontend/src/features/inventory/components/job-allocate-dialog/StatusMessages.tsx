import type { JobRequirementLine } from '../../../../domain';

interface StatusMessagesProps {
  selectedRequirement: JobRequirementLine | null;
  isExtraFilmMode: boolean;
  isMatchingBoxesLoading: boolean;
  isAllocationPreviewLoading: boolean;
  pendingAllocationCount: number;
  prioritizedMatchingBoxesCount: number;
  selectedBoxCount: number;
  hasPreferredLinkedBoxes: boolean;
  hasTransferCandidates: boolean;
  dueDate: string;
  crewLeader: string;
  previewError: Error | null;
  activePreviewLoaded: boolean;
  error: string;
}

export function StatusMessages({
  selectedRequirement,
  isExtraFilmMode,
  isMatchingBoxesLoading,
  isAllocationPreviewLoading,
  pendingAllocationCount,
  prioritizedMatchingBoxesCount,
  selectedBoxCount,
  hasPreferredLinkedBoxes,
  hasTransferCandidates,
  dueDate,
  crewLeader,
  previewError,
  activePreviewLoaded,
  error
}: StatusMessagesProps) {
  return (
    <>
      {isMatchingBoxesLoading ? <p className="muted-text">Loading compatible boxes...</p> : null}
      {!isMatchingBoxesLoading && isAllocationPreviewLoading ? (
        <p className="muted-text">Loading the live allocation plan...</p>
      ) : null}
      {pendingAllocationCount > 0 ? (
        <p className="muted-text">
          {pendingAllocationCount} allocation{pendingAllocationCount === 1 ? '' : 's'} saving in background...
        </p>
      ) : null}
      {!isMatchingBoxesLoading && selectedRequirement && !prioritizedMatchingBoxesCount ? (
        <p className="muted-text">
          {isExtraFilmMode
            ? 'No compatible boxes were found for this extra film type.'
            : 'No compatible boxes were found for this requirement (matching film family, width at or above requested). Create a film-order alert instead.'}
        </p>
      ) : null}
      {!isMatchingBoxesLoading && isExtraFilmMode && selectedRequirement && prioritizedMatchingBoxesCount > 0 ? (
        <p className="muted-text">
          Select the whole boxes installers should carry as extra film for this job.
        </p>
      ) : null}
      {dueDate.trim() && !crewLeader.trim() ? (
        <p className="error-text">CrewLeader is required when JobDate is set.</p>
      ) : null}
      {!isMatchingBoxesLoading &&
      prioritizedMatchingBoxesCount > 0 &&
      selectedBoxCount === 0 &&
      !isAllocationPreviewLoading ? (
        <p className="muted-text">
          {isExtraFilmMode
            ? 'No boxes are selected yet. Check the boxes you want to add as extra film.'
            : 'No boxes are selected yet. Check the boxes you want to use for this requirement.'}
        </p>
      ) : null}
      {!isMatchingBoxesLoading && hasPreferredLinkedBoxes && prioritizedMatchingBoxesCount ? (
        <p className="muted-text">
          Boxes linked to this job&apos;s film orders are prioritized first. Select any boxes you want to use.
        </p>
      ) : null}
      {!isMatchingBoxesLoading && hasTransferCandidates ? (
        <p className="muted-text">
          Transfer boxes already headed to this warehouse can be allocated here, but they must still be received before checkout.
        </p>
      ) : null}
      {!isMatchingBoxesLoading && previewError && !activePreviewLoaded ? (
        <p className="error-text">{previewError.message || 'Unable to load the live allocation plan.'}</p>
      ) : null}
      {error ? <p className="error-text">{error}</p> : null}
    </>
  );
}

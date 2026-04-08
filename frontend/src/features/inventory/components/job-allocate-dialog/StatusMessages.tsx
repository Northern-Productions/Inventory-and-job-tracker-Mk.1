import type { JobRequirementLine } from '../../../../domain';

interface StatusMessagesProps {
  selectedRequirement: JobRequirementLine | null;
  isMatchingBoxesLoading: boolean;
  isAllocationPreviewLoading: boolean;
  prioritizedMatchingBoxesCount: number;
  selectedBoxCount: number;
  hasPreferredLinkedBoxes: boolean;
  dueDate: string;
  crewLeader: string;
  previewError: Error | null;
  activePreviewLoaded: boolean;
  error: string;
}

export function StatusMessages({
  selectedRequirement,
  isMatchingBoxesLoading,
  isAllocationPreviewLoading,
  prioritizedMatchingBoxesCount,
  selectedBoxCount,
  hasPreferredLinkedBoxes,
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
      {!isMatchingBoxesLoading && selectedRequirement && !prioritizedMatchingBoxesCount ? (
        <p className="muted-text">
          No compatible boxes were found for this requirement (matching film family, width at or above
          requested). Create a film-order alert instead.
        </p>
      ) : null}
      {dueDate.trim() && !crewLeader.trim() ? (
        <p className="error-text">CrewLeader is required when JobDate is set.</p>
      ) : null}
      {!isMatchingBoxesLoading &&
      prioritizedMatchingBoxesCount > 0 &&
      selectedBoxCount === 0 &&
      !isAllocationPreviewLoading ? (
        <p className="muted-text">No boxes are selected yet. Check the boxes you want to use for this requirement.</p>
      ) : null}
      {!isMatchingBoxesLoading && hasPreferredLinkedBoxes && prioritizedMatchingBoxesCount ? (
        <p className="muted-text">
          Boxes linked to this job&apos;s film orders are prioritized first. Select any boxes you want to use.
        </p>
      ) : null}
      {!isMatchingBoxesLoading && previewError && !activePreviewLoaded ? (
        <p className="error-text">{previewError.message || 'Unable to load the live allocation plan.'}</p>
      ) : null}
      {error ? <p className="error-text">{error}</p> : null}
    </>
  );
}

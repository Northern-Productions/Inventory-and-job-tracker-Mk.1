export function LoadingState({ label = 'Loading...' }: { label?: string }) {
  return (
    <div className="panel loading-state" role="status" aria-live="polite">
      <span className="loading-spinner" aria-hidden="true" />
      <div className="loading-state-copy">
        <strong>Working</strong>
        <p>{label}</p>
      </div>
    </div>
  );
}

interface Props {
  version: string;
  busy: boolean;
  error: boolean;
  onRestart: () => void;
  onDismiss: () => void;
}

// Unobtrusive bottom-centre toast offering the "restart to update" prompt.
export default function UpdateBanner({ version, busy, error, onRestart, onDismiss }: Props) {
  return (
    <div className="update-toast" role="status">
      <span className="update-toast__text">
        {error ? (
          "Update failed — try again"
        ) : (
          <>
            Update ready <strong>v{version}</strong>
          </>
        )}
      </span>
      <button className="update-toast__btn" onClick={onRestart} disabled={busy}>
        {busy ? "Updating…" : "Restart to update"}
      </button>
      {!busy && (
        <button
          className="update-toast__close"
          aria-label="Dismiss update"
          title="Dismiss"
          onClick={onDismiss}
        >
          ×
        </button>
      )}
    </div>
  );
}

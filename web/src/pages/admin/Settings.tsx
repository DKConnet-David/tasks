import { useEffect, useState } from "react";
import { ApiError, api } from "../../api";

export function Settings() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [okMessage, setOkMessage] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ enabled: boolean }>("/admin/settings/requirements-check")
      .then((r) => setEnabled(r.enabled))
      .catch((e: unknown) => {
        setError(e instanceof ApiError ? `Load failed (${e.status})` : "Network error");
      });
  }, []);

  async function toggle(next: boolean) {
    setBusy(true);
    setError(null);
    setOkMessage(null);
    try {
      await api.patch("/admin/settings/requirements-check", { enabled: next });
      setEnabled(next);
      setOkMessage(
        next
          ? "Requirements check enabled. New submissions will be scored against the per-job-type checklist."
          : "Requirements check disabled. New submissions skip the check.",
      );
    } catch (e) {
      setError(e instanceof ApiError ? `Update failed (${e.status})` : "Network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <div className="panel stack">
        <div>
          <h2 style={{ margin: 0 }}>Pipeline settings</h2>
          <p className="muted" style={{ margin: "4px 0 0", fontSize: "0.9em" }}>
            Toggles that change what the AI does when a tech submits a job.
          </p>
        </div>
      </div>

      <div className="panel stack">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}>
          <div style={{ flex: 1 }}>
            <h3 style={{ margin: 0 }}>Requirements coverage check</h3>
            <p className="muted" style={{ margin: "4px 0 0", fontSize: "0.9em" }}>
              When on, the AI grades each new submission against the DK Connect
              checklist for the matching job type (FTUA install, site survey,
              fibre LOS, etc.) and surfaces any missing items on the Submission
              detail page. Results are <strong>admin-only</strong> — they do
              not appear in WhatsApp, Splynx, or the PDF. Costs a few hundred
              extra tokens per submission while on.
            </p>
          </div>
          <div style={{ flexShrink: 0 }}>
            {enabled === null ? (
              <span className="muted">Loading…</span>
            ) : (
              <button
                onClick={() => toggle(!enabled)}
                disabled={busy}
                className={enabled ? "" : "secondary"}
                style={{ minWidth: 110 }}
              >
                {busy ? "Saving…" : enabled ? "On" : "Off"}
              </button>
            )}
          </div>
        </div>
        {okMessage && <div className="success">{okMessage}</div>}
        {error && <div className="danger">{error}</div>}
      </div>
    </div>
  );
}

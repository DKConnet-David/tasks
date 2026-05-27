import { useEffect, useState } from "react";
import { ApiError, api } from "../../api";

export function Settings() {
  return (
    <div className="stack">
      <div className="panel stack">
        <div>
          <h2 style={{ margin: 0 }}>Pipeline settings</h2>
          <p className="muted" style={{ margin: "4px 0 0", fontSize: "0.9em" }}>
            Toggles that change what the AI does when a tech submits a job, plus
            scheduled background tasks.
          </p>
        </div>
      </div>

      <RequirementsCheckSection />
      <DailySummarySection />
    </div>
  );
}

function RequirementsCheckSection() {
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
  );
}

interface DailySummaryStatus {
  enabled: boolean;
  last_sent_date: string | null;
  group_jid: string | null;
  group_name: string | null;
}

function DailySummarySection() {
  const [status, setStatus] = useState<DailySummaryStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"toggle" | "send" | null>(null);
  const [okMessage, setOkMessage] = useState<string | null>(null);

  async function load() {
    try {
      const r = await api.get<DailySummaryStatus>("/admin/settings/daily-summary");
      setStatus(r);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? `Load failed (${e.status})` : "Network error");
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function toggle(next: boolean) {
    setBusy("toggle");
    setError(null);
    setOkMessage(null);
    try {
      await api.patch("/admin/settings/daily-summary", { enabled: next });
      setOkMessage(
        next
          ? "Daily summary scheduled — next post at 19:00 SAST (today's already-seen data is suppressed)."
          : "Daily summary disabled — no scheduled WhatsApp posts.",
      );
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? `Update failed (${e.status})` : "Network error");
    } finally {
      setBusy(null);
    }
  }

  async function sendNow() {
    setBusy("send");
    setError(null);
    setOkMessage(null);
    try {
      const r = await api.post<{ ok: boolean; sent: boolean; row_count: number; message_id: string | null }>(
        "/admin/settings/daily-summary/send-now",
        {},
      );
      if (r.sent) {
        setOkMessage(
          `Test summary sent (${r.row_count} ${r.row_count === 1 ? "tech" : "techs"}) — check WhatsApp.`,
        );
      }
    } catch (e) {
      if (e instanceof ApiError) {
        const body = e.body as { error?: string } | null;
        if (body?.error === "no_group_configured") {
          setError(
            "No WhatsApp group configured. Set one on the WhatsApp tab first.",
          );
        } else {
          setError(`Send failed (${e.status}): ${body?.error ?? "unknown"}`);
        }
      } else {
        setError("Network error");
      }
    } finally {
      setBusy(null);
    }
  }

  const groupLabel = status?.group_name?.trim()
    ? status.group_name
    : status?.group_jid ?? "(not configured)";

  return (
    <div className="panel stack">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}>
        <div style={{ flex: 1 }}>
          <h3 style={{ margin: 0 }}>Daily team summary (WhatsApp at 19:00 SAST)</h3>
          <p className="muted" style={{ margin: "4px 0 0", fontSize: "0.9em" }}>
            When on, the server posts a short summary of who submitted how many
            jobs that day to the configured WhatsApp group. Mirrors the Daily
            breakdown panel on the Performance page. Sends once per day after
            19:00 in Africa/Johannesburg time.
          </p>
          <p className="muted" style={{ margin: "4px 0 0", fontSize: "0.85em" }}>
            Target group: <strong>{groupLabel}</strong>
            {status?.last_sent_date && <> · Last sent: {status.last_sent_date}</>}
          </p>
        </div>
        <div style={{ flexShrink: 0, display: "flex", flexDirection: "column", gap: 6 }}>
          {status === null ? (
            <span className="muted">Loading…</span>
          ) : (
            <>
              <button
                onClick={() => toggle(!status.enabled)}
                disabled={busy !== null}
                className={status.enabled ? "" : "secondary"}
                style={{ minWidth: 110 }}
              >
                {busy === "toggle" ? "Saving…" : status.enabled ? "On" : "Off"}
              </button>
              <button
                onClick={sendNow}
                disabled={busy !== null || !status.group_jid}
                className="secondary"
                style={{ minWidth: 110, fontSize: "0.85em" }}
                title={
                  status.group_jid
                    ? "Post the daily summary to WhatsApp right now"
                    : "Configure a WhatsApp group first"
                }
              >
                {busy === "send" ? "Sending…" : "Send test now"}
              </button>
            </>
          )}
        </div>
      </div>
      {okMessage && <div className="success">{okMessage}</div>}
      {error && <div className="danger">{error}</div>}
    </div>
  );
}

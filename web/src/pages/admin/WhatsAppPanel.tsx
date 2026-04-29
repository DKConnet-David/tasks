import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "../../api";

type Status = "stopped" | "starting" | "qr" | "connecting" | "open" | "logged-out" | "error";

interface WaStatus {
  status: Status;
  qr_data_url: string | null;
  last_error: string | null;
  groups: { id: string; subject: string }[];
  configured_jid: string | null;
  configured_name: string | null;
  started_at: number | null;
}

export function WhatsAppPanel() {
  const [data, setData] = useState<WaStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [okMessage, setOkMessage] = useState<string | null>(null);
  const pollTimer = useRef<number | null>(null);

  async function load() {
    try {
      const next = await api.get<WaStatus>("/admin/whatsapp/status");
      setData(next);
    } catch (e: unknown) {
      if (e instanceof ApiError) setError(`Failed to load status (${e.status})`);
      else setError("Network error");
    }
  }

  useEffect(() => {
    load();
    // Poll while not in steady state — QR rotates every ~60s, status changes
    // during connect/reconnect.
    pollTimer.current = window.setInterval(() => {
      if (data?.status === "open" && data.qr_data_url === null) {
        // Still poll occasionally so groups stay fresh, but slowly.
      }
      load();
    }, 3000);
    return () => {
      if (pollTimer.current) window.clearInterval(pollTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function startSession() {
    setBusy("start");
    setError(null);
    setOkMessage(null);
    try {
      await api.post("/admin/whatsapp/start");
      await load();
    } catch (e: unknown) {
      setError(e instanceof ApiError ? `Start failed (${e.status})` : "Start failed");
    } finally {
      setBusy(null);
    }
  }

  async function selectGroup(jid: string, subject: string) {
    setBusy(`select-${jid}`);
    setError(null);
    setOkMessage(null);
    try {
      await api.post("/admin/whatsapp/group", { jid, subject });
      await load();
      setOkMessage(`Target group set to "${subject}".`);
    } catch (e: unknown) {
      setError(e instanceof ApiError ? `Failed (${e.status})` : "Network error");
    } finally {
      setBusy(null);
    }
  }

  async function clearGroup() {
    setBusy("clear");
    setError(null);
    setOkMessage(null);
    try {
      await api.delete("/admin/whatsapp/group");
      await load();
      setOkMessage("Target group cleared.");
    } catch (e: unknown) {
      setError(e instanceof ApiError ? `Failed (${e.status})` : "Network error");
    } finally {
      setBusy(null);
    }
  }

  async function testSend() {
    setBusy("test");
    setError(null);
    setOkMessage(null);
    try {
      const res = await api.post<{ ok: boolean; message_id: string | null }>(
        "/admin/whatsapp/test",
      );
      setOkMessage(`Test message sent. WhatsApp message id: ${res.message_id ?? "(unknown)"}`);
    } catch (e: unknown) {
      if (e instanceof ApiError) {
        const detail = (e.body as { detail?: string })?.detail;
        setError(`Test send failed: ${detail ?? e.status}`);
      } else {
        setError("Network error");
      }
    } finally {
      setBusy(null);
    }
  }

  async function logoutSession() {
    if (!confirm("This will log out the WhatsApp session and wipe local creds. You'll need to scan the QR again. Continue?"))
      return;
    setBusy("logout");
    setError(null);
    setOkMessage(null);
    try {
      await api.post("/admin/whatsapp/logout");
      await load();
      setOkMessage("Logged out.");
    } catch (e: unknown) {
      setError(e instanceof ApiError ? `Logout failed (${e.status})` : "Network error");
    } finally {
      setBusy(null);
    }
  }

  if (!data) return <div className="panel muted">Loading WhatsApp status…</div>;

  return (
    <div className="stack">
      <div className="panel stack">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>WhatsApp connection</h2>
          <span className={statusBadge(data.status)}>{statusLabel(data.status)}</span>
        </div>
        {data.last_error && <div className="warn">{data.last_error}</div>}

        {data.status === "stopped" || data.status === "error" ? (
          <button onClick={startSession} disabled={busy === "start"}>
            {busy === "start" ? "Starting…" : "Start WhatsApp connection"}
          </button>
        ) : null}

        {data.status === "qr" && data.qr_data_url && (
          <div className="stack" style={{ alignItems: "center", padding: 16 }}>
            <p className="muted" style={{ textAlign: "center", margin: 0 }}>
              On the phone you want to link, open WhatsApp →<br />
              <strong>Settings → Linked Devices → Link a Device</strong> and scan this QR.
            </p>
            <img
              src={data.qr_data_url}
              alt="WhatsApp pairing QR"
              style={{ width: 280, height: 280, background: "white", borderRadius: 8 }}
            />
            <p className="muted" style={{ fontSize: "0.85em", textAlign: "center", margin: 0 }}>
              The QR rotates every ~60 seconds. This page reloads automatically.
            </p>
          </div>
        )}

        {data.status === "connecting" && (
          <p className="muted">Re-handshaking with WhatsApp…</p>
        )}

        {data.status === "logged-out" && (
          <div className="stack">
            <p className="warn">Session was logged out by WhatsApp. Re-scan the QR to relink.</p>
            <button onClick={startSession} disabled={busy === "start"}>
              {busy === "start" ? "Starting…" : "Start fresh QR"}
            </button>
          </div>
        )}
      </div>

      {data.status === "open" && (
        <>
          <div className="panel stack">
            <h3 style={{ margin: 0 }}>Target group</h3>
            {data.configured_jid ? (
              <div className="stack">
                <div>
                  <strong>{data.configured_name ?? "(unnamed)"}</strong>{" "}
                  <span className="muted">— {data.configured_jid}</span>
                </div>
                <div className="row" style={{ gap: 8 }}>
                  <button onClick={testSend} disabled={busy === "test"}>
                    {busy === "test" ? "Sending…" : "Send test message"}
                  </button>
                  <button className="secondary" onClick={clearGroup} disabled={busy === "clear"}>
                    Clear target
                  </button>
                </div>
              </div>
            ) : (
              <p className="muted">
                No group selected yet. Pick one below — it'll be the destination for every job
                summary the pipeline sends.
              </p>
            )}
          </div>

          <div className="panel stack">
            <h3 style={{ margin: 0 }}>Available groups ({data.groups.length})</h3>
            {data.groups.length === 0 ? (
              <p className="muted">No groups visible. Make sure this WhatsApp number is a member of the target group.</p>
            ) : (
              <div className="stack">
                {data.groups.map((g) => {
                  const isCurrent = g.id === data.configured_jid;
                  return (
                    <div
                      key={g.id}
                      className="row"
                      style={{ justifyContent: "space-between", alignItems: "center" }}
                    >
                      <div>
                        <strong>{g.subject}</strong>
                        <div className="muted" style={{ fontSize: "0.8em" }}>{g.id}</div>
                      </div>
                      <button
                        className={isCurrent ? "secondary" : ""}
                        onClick={() => selectGroup(g.id, g.subject)}
                        disabled={busy === `select-${g.id}` || isCurrent}
                      >
                        {isCurrent ? "Selected" : "Set as target"}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="panel stack">
            <h3 style={{ margin: 0 }}>Session control</h3>
            <button className="danger" onClick={logoutSession} disabled={busy === "logout"}>
              {busy === "logout" ? "Logging out…" : "Log out & wipe creds"}
            </button>
          </div>
        </>
      )}

      {error && <div className="panel danger">{error}</div>}
      {okMessage && <div className="panel success">{okMessage}</div>}
    </div>
  );
}

function statusBadge(s: Status): string {
  if (s === "open") return "badge success";
  if (s === "logged-out" || s === "error") return "badge danger";
  return "badge warn";
}

function statusLabel(s: Status): string {
  switch (s) {
    case "stopped": return "Not started";
    case "starting": return "Starting…";
    case "qr": return "Scan the QR";
    case "connecting": return "Connecting…";
    case "open": return "Connected";
    case "logged-out": return "Logged out";
    case "error": return "Error";
  }
}

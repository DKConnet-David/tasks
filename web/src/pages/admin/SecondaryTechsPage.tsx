import { useEffect, useState } from "react";
import { ApiError, api } from "../../api";

interface SecondaryTech {
  id: number;
  name: string;
  is_active: boolean;
  created_at: number;
  updated_at: number;
}

export function SecondaryTechsPage() {
  const [list, setList] = useState<SecondaryTech[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [okMessage, setOkMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState("");

  const [editing, setEditing] = useState<SecondaryTech | null>(null);
  const [editName, setEditName] = useState("");

  async function load() {
    try {
      const r = await api.get<{ secondary_techs: SecondaryTech[] }>("/admin/secondary-techs");
      setList(r.secondary_techs);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? `Load failed (${e.status})` : "Network error");
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function addOne(e: React.FormEvent) {
    e.preventDefault();
    setBusy("add");
    setError(null);
    setOkMessage(null);
    try {
      await api.post("/admin/secondary-techs", { name: newName.trim() });
      setOkMessage(`Added "${newName.trim()}".`);
      setNewName("");
      setShowAdd(false);
      await load();
    } catch (e) {
      if (e instanceof ApiError) {
        const code = (e.body as { error?: string })?.error;
        if (code === "name_taken") setError("A helper with that name already exists.");
        else setError(`Create failed (${e.status})`);
      } else setError("Network error");
    } finally {
      setBusy(null);
    }
  }

  async function toggleActive(t: SecondaryTech) {
    setBusy(`toggle-${t.id}`);
    try {
      await api.patch(`/admin/secondary-techs/${t.id}`, { is_active: !t.is_active });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? `Update failed (${e.status})` : "Network error");
    } finally {
      setBusy(null);
    }
  }

  function openEdit(t: SecondaryTech) {
    setEditing(t);
    setEditName(t.name);
    setError(null);
    setOkMessage(null);
  }

  async function saveEdit() {
    if (!editing) return;
    const trimmed = editName.trim();
    if (!trimmed || trimmed === editing.name) {
      setEditing(null);
      return;
    }
    setBusy(`edit-${editing.id}`);
    setError(null);
    try {
      await api.patch(`/admin/secondary-techs/${editing.id}`, { name: trimmed });
      setOkMessage(`Renamed to "${trimmed}".`);
      setEditing(null);
      await load();
    } catch (e) {
      if (e instanceof ApiError) {
        const code = (e.body as { error?: string })?.error;
        if (code === "name_taken") setError("A helper with that name already exists.");
        else setError(`Update failed (${e.status})`);
      } else setError("Network error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="stack">
      <div className="panel stack">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div>
            <h2 style={{ margin: 0 }}>Helpers (secondary techs)</h2>
            <p className="muted" style={{ margin: "4px 0 0", fontSize: "0.9em" }}>
              Names of people who occasionally assist a primary tech but don't have their
              own Task Updater login. Techs can tag one or more of these on a job; the
              names flow into the AI summary, the Splynx comment, the WhatsApp caption,
              and the PDF footer. Disable to hide from the picker without losing history.
            </p>
          </div>
          <button onClick={() => setShowAdd((s) => !s)} className={showAdd ? "secondary" : ""}>
            {showAdd ? "Cancel" : "Add helper"}
          </button>
        </div>

        {showAdd && (
          <form
            onSubmit={addOne}
            className="stack"
            style={{ background: "#0e1a14", padding: 12, borderRadius: 8 }}
          >
            <label className="stack" style={{ gap: 4 }}>
              <span className="muted">Name *</span>
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Sipho"
                required
              />
            </label>
            <button disabled={busy === "add" || !newName.trim()}>
              {busy === "add" ? "Creating…" : "Create"}
            </button>
          </form>
        )}

        {error && <div className="danger">{error}</div>}
        {okMessage && <div className="success">{okMessage}</div>}
      </div>

      {!list ? (
        <div className="panel muted">Loading…</div>
      ) : list.length === 0 ? (
        <div className="panel muted">No helpers yet — click "Add helper" above.</div>
      ) : (
        <div className="panel">
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.92em" }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--c-muted)" }}>
                  <th style={th()}>Name</th>
                  <th style={th()}>Status</th>
                  <th style={th()}>Added</th>
                  <th style={th()}></th>
                </tr>
              </thead>
              <tbody>
                {list.map((t) => (
                  <tr key={t.id} style={{ borderTop: "1px solid var(--c-border)" }}>
                    <td style={td()}>
                      <strong>{t.name}</strong>
                    </td>
                    <td style={td()}>
                      <span className={t.is_active ? "badge success" : "badge"}>
                        {t.is_active ? "active" : "disabled"}
                      </span>
                    </td>
                    <td style={td()}>{new Date(t.created_at).toLocaleString()}</td>
                    <td style={td()}>
                      <div className="row" style={{ gap: 4, justifyContent: "flex-end" }}>
                        <button
                          className="secondary"
                          onClick={() => openEdit(t)}
                          disabled={busy === `edit-${t.id}`}
                        >
                          Rename
                        </button>
                        <button
                          className="secondary"
                          onClick={() => toggleActive(t)}
                          disabled={busy === `toggle-${t.id}`}
                        >
                          {t.is_active ? "Disable" : "Enable"}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {editing && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0,0,0,0.7)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 100,
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) setEditing(null);
          }}
        >
          <div className="panel stack" style={{ minWidth: 320, maxWidth: 480 }}>
            <h3 style={{ margin: 0 }}>Rename helper</h3>
            <label className="stack" style={{ gap: 4 }}>
              <span className="muted">Name</span>
              <input value={editName} onChange={(e) => setEditName(e.target.value)} />
            </label>
            <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
              <button className="secondary" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button onClick={saveEdit} disabled={busy === `edit-${editing.id}`}>
                {busy === `edit-${editing.id}` ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function th(): React.CSSProperties {
  return { padding: "8px 8px", fontWeight: 500, fontSize: "0.85em", textTransform: "uppercase" };
}
function td(): React.CSSProperties {
  return { padding: "10px 8px", verticalAlign: "top" };
}

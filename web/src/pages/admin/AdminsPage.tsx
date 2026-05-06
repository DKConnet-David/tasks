import { useEffect, useState } from "react";
import { ApiError, api } from "../../api";

interface Admin {
  id: number;
  login: string;
  splynx_admin_id: number;
  display_name: string;
  is_active: 0 | 1;
  created_at: number;
  updated_at: number;
}

interface AdminCreateForm {
  login: string;
  password: string;
  splynx_admin_id: string;
  display_name: string;
}

export function AdminsPage() {
  const [admins, setAdmins] = useState<Admin[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [okMessage, setOkMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Add form
  const [form, setForm] = useState<AdminCreateForm>({
    login: "",
    password: "",
    splynx_admin_id: "",
    display_name: "",
  });
  const [showAdd, setShowAdd] = useState(false);

  // Edit modal state
  const [editing, setEditing] = useState<Admin | null>(null);
  const [editPassword, setEditPassword] = useState("");
  const [editAdminId, setEditAdminId] = useState("");
  const [editName, setEditName] = useState("");

  async function load() {
    try {
      const r = await api.get<{ admins: Admin[] }>("/admin/admins");
      setAdmins(r.admins);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? `Load failed (${e.status})` : "Network error");
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function addAdmin(e: React.FormEvent) {
    e.preventDefault();
    setBusy("add");
    setError(null);
    setOkMessage(null);
    try {
      await api.post("/admin/admins", {
        login: form.login.trim(),
        password: form.password,
        splynx_admin_id: Number(form.splynx_admin_id),
        display_name: form.display_name.trim(),
      });
      setOkMessage(`Created admin "${form.login}". They can sign in now.`);
      setForm({ login: "", password: "", splynx_admin_id: "", display_name: "" });
      setShowAdd(false);
      await load();
    } catch (e) {
      if (e instanceof ApiError) {
        const code = (e.body as { error?: string })?.error;
        const message = (e.body as { message?: string })?.message;
        if (code === "login_taken") setError("That login is already used.");
        else if (code === "login_conflict_with_tech")
          setError(message ?? "A tech with that login already exists.");
        else setError(`Create failed (${e.status})`);
      } else setError("Network error");
    } finally {
      setBusy(null);
    }
  }

  async function toggleActive(a: Admin) {
    setBusy(`toggle-${a.id}`);
    setError(null);
    setOkMessage(null);
    try {
      await api.patch(`/admin/admins/${a.id}`, {
        is_active: a.is_active === 1 ? false : true,
      });
      await load();
    } catch (e) {
      if (e instanceof ApiError) {
        const code = (e.body as { error?: string })?.error;
        const message = (e.body as { message?: string })?.message;
        if (code === "last_active_admin")
          setError(message ?? "Cannot disable the last active admin.");
        else setError(`Update failed (${e.status})`);
      } else setError("Network error");
    } finally {
      setBusy(null);
    }
  }

  function openEdit(a: Admin) {
    setEditing(a);
    setEditPassword("");
    setEditAdminId(String(a.splynx_admin_id));
    setEditName(a.display_name);
    setError(null);
    setOkMessage(null);
  }

  async function saveEdit() {
    if (!editing) return;
    setBusy(`edit-${editing.id}`);
    setError(null);
    try {
      const patch: Record<string, unknown> = {};
      if (editPassword) patch["password"] = editPassword;
      if (editAdminId && Number(editAdminId) !== editing.splynx_admin_id)
        patch["splynx_admin_id"] = Number(editAdminId);
      if (editName.trim() && editName.trim() !== editing.display_name)
        patch["display_name"] = editName.trim();
      if (Object.keys(patch).length === 0) {
        setEditing(null);
        return;
      }
      await api.patch(`/admin/admins/${editing.id}`, patch);
      setOkMessage(`Updated ${editing.login}.`);
      setEditing(null);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? `Update failed (${e.status})` : "Network error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="stack">
      <div className="panel stack">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div>
            <h2 style={{ margin: 0 }}>Admins</h2>
            <p className="muted" style={{ margin: "4px 0 0", fontSize: "0.9em" }}>
              People with full access to <code>/admin</code>: edit summaries, override AI ratings,
              hide submissions, manage techs and other admins. Each admin's actions are recorded
              in the per-submission audit log. The <code>ADMIN_LOGIN</code> /
              <code> ADMIN_PASSWORD</code> env vars are the permanent recovery credentials —
              they always work even if all rows here are disabled.
            </p>
          </div>
          <button onClick={() => setShowAdd((s) => !s)} className={showAdd ? "secondary" : ""}>
            {showAdd ? "Cancel" : "Add admin"}
          </button>
        </div>

        {showAdd && (
          <form
            onSubmit={addAdmin}
            className="stack"
            style={{ background: "#1a2029", padding: 12, borderRadius: 8 }}
          >
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
                gap: 8,
              }}
            >
              <label className="stack" style={{ gap: 4 }}>
                <span className="muted">Login *</span>
                <input
                  value={form.login}
                  onChange={(e) => setForm({ ...form, login: e.target.value })}
                  placeholder="e.g. alice"
                  pattern="[a-zA-Z0-9._-]+"
                  required
                />
              </label>
              <label className="stack" style={{ gap: 4 }}>
                <span className="muted">Password * (min 8)</span>
                <input
                  type="text"
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                  minLength={8}
                  required
                />
              </label>
              <label className="stack" style={{ gap: 4 }}>
                <span className="muted">Splynx admin id *</span>
                <input
                  inputMode="numeric"
                  value={form.splynx_admin_id}
                  onChange={(e) => setForm({ ...form, splynx_admin_id: e.target.value })}
                  required
                />
              </label>
              <label className="stack" style={{ gap: 4 }}>
                <span className="muted">Display name *</span>
                <input
                  value={form.display_name}
                  onChange={(e) => setForm({ ...form, display_name: e.target.value })}
                  required
                />
              </label>
            </div>
            <button disabled={busy === "add"}>{busy === "add" ? "Creating…" : "Create"}</button>
          </form>
        )}

        {error && <div className="danger">{error}</div>}
        {okMessage && <div className="success">{okMessage}</div>}
      </div>

      {!admins ? (
        <div className="panel muted">Loading admins…</div>
      ) : admins.length === 0 ? (
        <div className="panel muted">No admins yet — click "Add admin" above.</div>
      ) : (
        <div className="panel">
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.92em" }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--c-muted)" }}>
                  <th style={th()}>Login</th>
                  <th style={th()}>Display name</th>
                  <th style={th()}>Splynx admin id</th>
                  <th style={th()}>Status</th>
                  <th style={th()}>Created</th>
                  <th style={th()}></th>
                </tr>
              </thead>
              <tbody>
                {admins.map((a) => (
                  <tr key={a.id} style={{ borderTop: "1px solid var(--c-border)" }}>
                    <td style={td()}>
                      <strong>{a.login}</strong>
                    </td>
                    <td style={td()}>{a.display_name}</td>
                    <td style={td()}>{a.splynx_admin_id}</td>
                    <td style={td()}>
                      <span className={a.is_active ? "badge success" : "badge"}>
                        {a.is_active ? "active" : "disabled"}
                      </span>
                    </td>
                    <td style={td()}>{new Date(a.created_at).toLocaleString()}</td>
                    <td style={td()}>
                      <div className="row" style={{ gap: 4, justifyContent: "flex-end" }}>
                        <button
                          className="secondary"
                          onClick={() => openEdit(a)}
                          disabled={busy === `edit-${a.id}`}
                        >
                          Edit
                        </button>
                        <button
                          className="secondary"
                          onClick={() => toggleActive(a)}
                          disabled={busy === `toggle-${a.id}`}
                        >
                          {a.is_active ? "Disable" : "Enable"}
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
          <div className="panel elevated stack" style={{ minWidth: 360, maxWidth: 520 }}>
            <h3 style={{ margin: 0 }}>Edit {editing.login}</h3>
            <label className="stack" style={{ gap: 4 }}>
              <span className="muted">New password (leave blank to keep current)</span>
              <input
                type="text"
                value={editPassword}
                onChange={(e) => setEditPassword(e.target.value)}
                minLength={editPassword.length === 0 ? undefined : 8}
              />
            </label>
            <label className="stack" style={{ gap: 4 }}>
              <span className="muted">Splynx admin id</span>
              <input
                inputMode="numeric"
                value={editAdminId}
                onChange={(e) => setEditAdminId(e.target.value)}
              />
            </label>
            <label className="stack" style={{ gap: 4 }}>
              <span className="muted">Display name</span>
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

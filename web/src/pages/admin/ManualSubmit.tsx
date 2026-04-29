import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, api } from "../../api";
import { PhotoCapture, type CapturedPhoto } from "../../components/PhotoCapture";

interface SubmitResponse {
  submission_id: number;
  task_id: number;
  status: string;
}

export function ManualSubmit() {
  const nav = useNavigate();
  const [taskId, setTaskId] = useState("");
  const [comment, setComment] = useState("");
  const [onBehalfOfLogin, setOnBehalfOfLogin] = useState("");
  const [onBehalfOfAdminId, setOnBehalfOfAdminId] = useState("");
  const [photos, setPhotos] = useState<CapturedPhoto[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Cleanup blob URLs on unmount.
  useEffect(() => {
    return () => {
      for (const p of photos) URL.revokeObjectURL(p.previewUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const id = Number.parseInt(taskId.trim(), 10);
    if (!Number.isFinite(id) || id <= 0) {
      setError("Invalid task ID.");
      return;
    }
    if (photos.length === 0) {
      setError("Add at least one photo.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("task_id", String(id));
      fd.append("comment", comment);
      if (onBehalfOfLogin.trim()) fd.append("on_behalf_of_login", onBehalfOfLogin.trim());
      if (onBehalfOfAdminId.trim())
        fd.append("on_behalf_of_admin_id", onBehalfOfAdminId.trim());
      for (const p of photos) fd.append("photos", p.file, p.file.name || "photo.jpg");
      const res = await api.upload<SubmitResponse>("/admin/submissions/manual", fd);
      nav(`/admin/submissions/${res.submission_id}`);
    } catch (e: unknown) {
      if (e instanceof ApiError) {
        const detail = (e.body as { detail?: string; error?: string })?.detail;
        const code = (e.body as { error?: string })?.error;
        setError(detail ?? code ?? `Submit failed (${e.status})`);
      } else {
        setError("Network error");
      }
      setBusy(false);
    }
  }

  return (
    <div className="panel stack">
      <div>
        <h2 style={{ margin: 0 }}>Manual submission</h2>
        <p className="muted" style={{ margin: "4px 0 0" }}>
          For jobs that didn't go through the field-tech app — record them here so they get the
          same AI summary, PDF, Splynx writeback and WhatsApp post as a normal submission.
        </p>
      </div>

      <form onSubmit={onSubmit} className="stack">
        <label className="stack" style={{ gap: 4 }}>
          <span className="muted">Task ID *</span>
          <input
            inputMode="numeric"
            value={taskId}
            onChange={(e) => setTaskId(e.target.value)}
            placeholder="e.g. 14967"
            required
          />
        </label>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: 8,
          }}
        >
          <label className="stack" style={{ gap: 4 }}>
            <span className="muted">On behalf of (tech login) — optional</span>
            <input
              value={onBehalfOfLogin}
              onChange={(e) => setOnBehalfOfLogin(e.target.value)}
              placeholder="lorenzo"
            />
          </label>
          <label className="stack" style={{ gap: 4 }}>
            <span className="muted">Splynx admin id for that tech — optional</span>
            <input
              inputMode="numeric"
              value={onBehalfOfAdminId}
              onChange={(e) => setOnBehalfOfAdminId(e.target.value)}
              placeholder="e.g. 7"
            />
          </label>
        </div>
        <p className="muted" style={{ margin: 0, fontSize: "0.85em" }}>
          If left blank, the submission is recorded as you (admin). Set both fields to attribute
          the Splynx comment to a different admin.
        </p>

        <PhotoCapture photos={photos} onChange={setPhotos} disabled={busy} />

        <label className="stack" style={{ gap: 4 }}>
          <span className="muted">Notes (what was done, observations, etc.)</span>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={4}
            placeholder="Replaced router, tested speed, customer happy."
            disabled={busy}
            maxLength={4000}
          />
        </label>

        {error && <div className="danger">{error}</div>}

        <button disabled={busy || photos.length === 0}>
          {busy ? "Submitting…" : "Submit (runs full pipeline)"}
        </button>
      </form>
    </div>
  );
}

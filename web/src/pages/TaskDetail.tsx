import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ApiError, api } from "../api";
import { PhotoCapture, type CapturedPhoto } from "../components/PhotoCapture";

interface SplynxTaskRaw {
  id: number;
  title: string;
  address: string;
  gps: string;
  description: string;
  scheduled_from: string;
  priority: string;
  workflow_status_id: number;
  task_labels: { id: number; label: string; color: string }[];
}

interface SplynxComment {
  id: number;
  comment: string;
  created_at: string;
  admin_name: string;
}

interface TaskResponse {
  task: SplynxTaskRaw;
  comments: SplynxComment[];
}

interface SubmitResponse {
  submission_id: number;
  task_id: number;
  status: "success" | "partial" | "failed";
  photos_saved: number;
  photos_failed: number;
}

export function TaskDetail() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const [data, setData] = useState<TaskResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [photos, setPhotos] = useState<CapturedPhoto[]>([]);
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    setError(null);
    api
      .get<TaskResponse>(`/tasks/${id}`)
      .then(setData)
      .catch((e: unknown) => {
        if (e instanceof ApiError) {
          if (e.status === 404) setError(`Task #${id} not found in Splynx.`);
          else if (e.status === 400) setError("Invalid task ID.");
          else if (e.status === 503)
            setError("Splynx isn't configured on the server. Check the SPLYNX_API_KEY / SPLYNX_API_SECRET env vars.");
          else if (e.status === 502) setError("Splynx is unreachable or returned an error.");
          else setError(`Failed to load task (${e.status}).`);
        } else {
          setError("Failed to load task — network error.");
        }
      })
      .finally(() => setLoading(false));
  }, [id]);

  // Revoke object URLs on unmount to avoid leaking blob memory.
  useEffect(() => {
    return () => {
      for (const p of photos) URL.revokeObjectURL(p.previewUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSubmit() {
    if (!id) return;
    if (photos.length === 0) {
      setSubmitError("Please attach at least one photo.");
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const fd = new FormData();
      fd.append("comment", comment);
      for (const p of photos) fd.append("photos", p.file, p.file.name || "photo.jpg");
      const res = await api.upload<SubmitResponse>(`/tasks/${id}/submit`, fd);
      nav(`/submitting/${res.submission_id}`);
    } catch (e: unknown) {
      if (e instanceof ApiError) {
        if (e.status === 400 && (e.body as { error?: string })?.error === "no_photos") {
          setSubmitError("No valid photos uploaded.");
        } else if (e.status === 413) {
          setSubmitError("Photos are too large — try fewer or smaller files.");
        } else {
          setSubmitError(`Submit failed (${e.status}).`);
        }
      } else {
        setSubmitError("Submit failed — network error.");
      }
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="container muted">
        <Link to="/">← Back</Link>
        <p>Loading task #{id}…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="container stack">
        <Link to="/">← Back</Link>
        <p className="danger">{error}</p>
      </div>
    );
  }

  if (!data) return null;

  const { task, comments } = data;

  return (
    <div className="container stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <Link to="/">← Back</Link>
        <span className="muted">Task #{task.id}</span>
      </div>

      <h1 style={{ marginBottom: 0 }}>{stripHtml(task.title)}</h1>

      {task.task_labels.length > 0 && (
        <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
          {task.task_labels.map((l) => (
            <span
              key={l.id}
              className="badge"
              style={{ borderColor: l.color, color: l.color }}
            >
              {l.label.trim()}
            </span>
          ))}
        </div>
      )}

      <div className="panel stack">
        {task.address && (
          <div>
            <strong>Address:</strong> {task.address}
          </div>
        )}
        {task.gps && (
          <div>
            <strong>GPS:</strong>{" "}
            <a
              href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(task.gps)}`}
              target="_blank"
              rel="noreferrer"
            >
              {task.gps}
            </a>
          </div>
        )}
        {task.scheduled_from && task.scheduled_from !== "0000-00-00 00:00:00" && (
          <div>
            <strong>Scheduled:</strong> {task.scheduled_from}
          </div>
        )}
        {task.priority && (
          <div>
            <strong>Priority:</strong> {prettyPriority(task.priority)}
          </div>
        )}
      </div>

      {task.description && (
        <details>
          <summary>Description</summary>
          <div
            className="panel"
            style={{ marginTop: 8 }}
            dangerouslySetInnerHTML={{ __html: task.description }}
          />
        </details>
      )}

      <h2 style={{ marginBottom: 0 }}>Update task</h2>
      <div className="panel stack">
        <PhotoCapture photos={photos} onChange={setPhotos} disabled={submitting} />

        <label className="stack" style={{ gap: 4 }}>
          <span className="muted">Notes (what was done, what was used, anything notable)</span>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Replaced router, tested speed with customer on site, all OK."
            disabled={submitting}
            maxLength={4000}
          />
        </label>

        {submitError && <div className="danger">{submitError}</div>}

        <button onClick={handleSubmit} disabled={submitting || photos.length === 0}>
          {submitting ? "Submitting…" : "Submit update"}
        </button>
      </div>

      {comments.length > 0 && (
        <>
          <h2 style={{ marginBottom: 0 }}>Existing comments ({comments.length})</h2>
          <div className="stack">
            {comments.map((c) => (
              <div key={c.id} className="panel stack">
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <strong>{c.admin_name}</strong>
                  <span className="muted">{c.created_at}</span>
                </div>
                <div dangerouslySetInnerHTML={{ __html: c.comment }} />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .trim();
}

function prettyPriority(p: string): string {
  return p.replace(/^priority_/, "").replace(/_/g, " ");
}

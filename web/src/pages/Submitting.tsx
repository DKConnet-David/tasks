import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError, api } from "../api";

interface Submission {
  id: number;
  task_id: number;
  app_login: string;
  source: string;
  comment: string | null;
  status: "pending" | "success" | "partial" | "failed";
  error: string | null;
  created_at: number;
  updated_at: number;
}

interface Photo {
  id: number;
  filename: string;
  size_bytes: number;
  width: number;
  height: number;
}

interface SubmissionResponse {
  submission: Submission;
  photos: Photo[];
}

export function Submitting() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<SubmissionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    api
      .get<SubmissionResponse>(`/submissions/${id}`)
      .then(setData)
      .catch((e: unknown) => {
        if (e instanceof ApiError) setError(`Failed to load submission (${e.status})`);
        else setError("Failed to load submission — network error");
      });
  }, [id]);

  if (error) {
    return (
      <div className="container stack">
        <Link to="/">← Back to home</Link>
        <p className="danger">{error}</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="container muted">
        <p>Loading submission #{id}…</p>
      </div>
    );
  }

  const { submission, photos } = data;
  const statusBadgeClass =
    submission.status === "success"
      ? "badge success"
      : submission.status === "failed"
        ? "badge danger"
        : "badge warn";

  return (
    <div className="container stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <Link to="/">← Back to home</Link>
        <Link to={`/tasks/${submission.task_id}`}>Task #{submission.task_id}</Link>
      </div>

      <h1 style={{ marginBottom: 0 }}>Submission #{submission.id}</h1>
      <div className="row" style={{ gap: 8 }}>
        <span className={statusBadgeClass}>{submission.status.toUpperCase()}</span>
        <span className="muted">by {submission.app_login}</span>
        <span className="muted">{new Date(submission.created_at).toLocaleString()}</span>
      </div>

      <div className="panel">
        <strong>AI summary + WhatsApp + Splynx writeback:</strong>{" "}
        <span className="muted">coming in Phase C — for now, this just confirms photos and the note were saved.</span>
      </div>

      {submission.comment && (
        <div className="panel stack">
          <strong>Your note</strong>
          <div style={{ whiteSpace: "pre-wrap" }}>{submission.comment}</div>
        </div>
      )}

      <h2 style={{ marginBottom: 0 }}>Photos ({photos.length})</h2>
      {photos.length === 0 ? (
        <p className="muted">No photos saved.</p>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
            gap: 8,
          }}
        >
          {photos.map((p) => (
            <a
              key={p.id}
              href={`/api/submissions/${submission.id}/photos/${p.filename}`}
              target="_blank"
              rel="noreferrer"
              style={{
                aspectRatio: "1 / 1",
                borderRadius: "var(--r)",
                overflow: "hidden",
                background: "#000",
              }}
            >
              <img
                src={`/api/submissions/${submission.id}/photos/${p.filename}`}
                alt=""
                loading="lazy"
                style={{ width: "100%", height: "100%", objectFit: "cover" }}
              />
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

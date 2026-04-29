import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError, api } from "../api";

interface Submission {
  id: number;
  task_id: number;
  app_login: string;
  source: string;
  comment: string | null;
  summary_json: string | null;
  splynx_comment_id: number | null;
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

interface Summary {
  headline: string;
  what_was_done: string;
  observations: string;
  follow_ups: string;
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
  const summary: Summary | null = submission.summary_json
    ? safeParseSummary(submission.summary_json)
    : null;
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
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <span className={statusBadgeClass}>{submission.status.toUpperCase()}</span>
        <span className="muted">by {submission.app_login}</span>
        <span className="muted">{new Date(submission.created_at).toLocaleString()}</span>
        {submission.splynx_comment_id !== null && (
          <span className="badge success">Splynx ✓</span>
        )}
      </div>

      {submission.error && (
        <div className="panel danger">
          <strong>Some steps reported errors:</strong>
          <pre style={{ whiteSpace: "pre-wrap", margin: "8px 0 0", fontFamily: "inherit" }}>
            {submission.error}
          </pre>
        </div>
      )}

      {summary && (
        <div className="panel stack">
          <h2 style={{ margin: 0 }}>{summary.headline}</h2>
          <div>
            <strong>What was done</strong>
            <p style={{ whiteSpace: "pre-wrap", margin: "4px 0 0" }}>{summary.what_was_done}</p>
          </div>
          {summary.observations.trim() && (
            <div>
              <strong>Observations</strong>
              <p style={{ whiteSpace: "pre-wrap", margin: "4px 0 0" }}>{summary.observations}</p>
            </div>
          )}
          {summary.follow_ups.trim() && (
            <div>
              <strong>Follow-ups</strong>
              <p style={{ whiteSpace: "pre-wrap", margin: "4px 0 0" }}>{summary.follow_ups}</p>
            </div>
          )}
          <div className="row" style={{ gap: "0.5rem" }}>
            <a href={`/api/submissions/${submission.id}/pdf`} target="_blank" rel="noreferrer">
              <button className="secondary">Download PDF</button>
            </a>
          </div>
        </div>
      )}

      {!summary && submission.status !== "success" && (
        <div className="panel">
          <em className="muted">
            AI summary not available — see the error above for details.
          </em>
        </div>
      )}

      {submission.comment && (
        <div className="panel stack">
          <strong>Your note (verbatim)</strong>
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

function safeParseSummary(json: string): Summary | null {
  try {
    const obj = JSON.parse(json);
    if (
      typeof obj?.headline === "string" &&
      typeof obj?.what_was_done === "string" &&
      typeof obj?.observations === "string" &&
      typeof obj?.follow_ups === "string"
    ) {
      return obj as Summary;
    }
  } catch {
    // fallthrough
  }
  return null;
}

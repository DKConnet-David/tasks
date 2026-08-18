import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError, api } from "../api";
import { useAuth } from "../auth";

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
  overview?: {
    service_type?: string;
    client_name?: string;
    location?: string;
    job_date?: string;
    job_start_time?: string;
    job_end_time?: string;
    job_duration?: string;
  };
  work_completed?: string[];
  photo_descriptions?: string[];
  materials?: string[];
  issues_notes?: string[];
}

interface Amendment {
  id: number;
  submission_id: number;
  comment: string;
  actor_login: string;
  splynx_comment_id: number | null;
  wa_message_id: string | null;
  wa_zoom_message_id: string | null;
  status: "pending" | "success" | "partial" | "failed";
  error: string | null;
  created_at: number;
  updated_at: number;
  photos: Photo[];
}

interface SubmissionResponse {
  submission: Submission;
  photos: Photo[];
  amendment: Amendment | null;
}

const AMENDMENT_WINDOW_MS = 24 * 60 * 60 * 1000;

export function Submitting() {
  const { id } = useParams<{ id: string }>();
  const { me } = useAuth();
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

  const { submission, photos, amendment } = data;
  const summary: Summary | null = submission.summary_json
    ? safeParseSummary(submission.summary_json)
    : null;
  // Amendment button visibility: owner (or admin), submission has landed
  // (success/partial), no existing amendment, within the 24h window.
  const ownsSubmission =
    !!me && (me.is_admin || me.app_login === submission.app_login);
  const withinWindow =
    Date.now() - submission.created_at < AMENDMENT_WINDOW_MS;
  const canAmend =
    ownsSubmission &&
    !amendment &&
    withinWindow &&
    (submission.status === "success" || submission.status === "partial");
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
          <div className="row" style={{ gap: "0.5rem" }}>
            <a href={`/api/submissions/${submission.id}/pdf`} target="_blank" rel="noreferrer">
              <button className="secondary">Download full PDF report</button>
            </a>
          </div>

          {summary.overview && hasOverview(summary.overview) && (
            <Section title="1. Job/Task Overview">
              <ul style={listStyle}>
                <Bullet label="Service type" value={summary.overview.service_type} />
                <Bullet label="Client" value={summary.overview.client_name} />
                <Bullet label="Location" value={summary.overview.location} />
                <Bullet label="Date" value={summary.overview.job_date} />
                <Bullet label="Job Start Time" value={summary.overview.job_start_time} />
                <Bullet label="Job End Time" value={summary.overview.job_end_time} />
                <Bullet label="Job Duration" value={summary.overview.job_duration} />
              </ul>
            </Section>
          )}

          {summary.work_completed && summary.work_completed.length > 0 && (
            <Section title="2. Work Completed">
              <ul style={listStyle}>
                {summary.work_completed.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </Section>
          )}

          {summary.photo_descriptions && summary.photo_descriptions.length > 0 && (
            <Section title="3. Photos Analysis">
              <ul style={listStyle}>
                {summary.photo_descriptions.map((d, i) => (
                  <li key={i}>
                    <strong>Photo {i + 1}:</strong> {d}
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {summary.materials && summary.materials.length > 0 && (
            <Section title="4. Materials/Equipment">
              <ul style={listStyle}>
                {summary.materials.map((m, i) => (
                  <li key={i}>{m}</li>
                ))}
              </ul>
            </Section>
          )}

          {summary.issues_notes && summary.issues_notes.length > 0 && (
            <Section title="5. Issues & Notes">
              <ul style={listStyle}>
                {summary.issues_notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </Section>
          )}

          {/* Fallback: show short prose when the structured fields are empty
              (e.g. submissions made before the structured-summary feature). */}
          {(!summary.work_completed || summary.work_completed.length === 0) && (
            <div>
              <strong>What was done</strong>
              <p style={{ whiteSpace: "pre-wrap", margin: "4px 0 0" }}>{summary.what_was_done}</p>
            </div>
          )}
          {summary.observations.trim() &&
            (!summary.work_completed || summary.work_completed.length === 0) && (
              <div>
                <strong>Observations</strong>
                <p style={{ whiteSpace: "pre-wrap", margin: "4px 0 0" }}>{summary.observations}</p>
              </div>
            )}
          {summary.follow_ups.trim() &&
            (!summary.work_completed || summary.work_completed.length === 0) && (
              <div>
                <strong>Follow-ups</strong>
                <p style={{ whiteSpace: "pre-wrap", margin: "4px 0 0" }}>{summary.follow_ups}</p>
              </div>
            )}
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

      {canAmend && (
        <div className="panel stack">
          <strong>Forgot something?</strong>
          <p className="muted" style={{ margin: 0, fontSize: "0.9em" }}>
            You can add one amendment (extra note + optional photos) within 24 hours
            of your original submission. The original stays as-is — the amendment is
            recorded separately and sent to the WhatsApp group + Splynx.
          </p>
          <Link to={`/submitting/${submission.id}/amend`}>
            <button>Add amendment</button>
          </Link>
        </div>
      )}

      {amendment && (
        <div className="panel stack">
          <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <strong style={{ color: "var(--c-danger)" }}>
              AMENDMENT — added {new Date(amendment.created_at).toLocaleString()}
            </strong>
            <span className={amendmentBadgeClass(amendment.status)}>
              {amendment.status.toUpperCase()}
            </span>
          </div>
          <div className="muted" style={{ fontSize: "0.85em" }}>
            by {amendment.actor_login}
            {amendment.splynx_comment_id !== null && " · Splynx ✓"}
            {amendment.wa_message_id !== null && " · WhatsApp ✓"}
            {amendment.wa_zoom_message_id !== null && " · Zoom group ✓"}
          </div>
          {amendment.error && (
            <div className="warn" style={{ fontSize: "0.85em", whiteSpace: "pre-wrap" }}>
              {amendment.error}
            </div>
          )}
          {amendment.comment && (
            <div style={{ whiteSpace: "pre-wrap" }}>{amendment.comment}</div>
          )}
          <div className="row" style={{ gap: 8 }}>
            <a
              href={`/api/submissions/${submission.id}/amendment/pdf`}
              target="_blank"
              rel="noreferrer"
            >
              <button className="secondary">Amendment PDF</button>
            </a>
          </div>
          {amendment.photos.length > 0 && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))",
                gap: 6,
              }}
            >
              {amendment.photos.map((p) => (
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 style={{ margin: "8px 0 4px" }}>{title}</h3>
      {children}
    </div>
  );
}

function Bullet({ label, value }: { label: string; value: string | undefined }) {
  if (!value || !value.trim()) return null;
  return (
    <li>
      <strong>{label}:</strong> {value}
    </li>
  );
}

function amendmentBadgeClass(s: Amendment["status"]): string {
  if (s === "success") return "badge success";
  if (s === "failed") return "badge danger";
  return "badge warn";
}

function hasOverview(o: NonNullable<Summary["overview"]>): boolean {
  return Object.values(o).some((v) => typeof v === "string" && v.trim().length > 0);
}

const listStyle: React.CSSProperties = {
  margin: "4px 0 0",
  paddingLeft: 20,
};

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

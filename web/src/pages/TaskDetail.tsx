import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ApiError, api } from "../api";
import { useAuth } from "../auth";
import { PhotoCapture, type CapturedPhoto } from "../components/PhotoCapture";
import { SubmitProgress, type SubmitPhase } from "../components/SubmitProgress";

type ZoomBillableType = "zoom_fibre_install" | "zoom_ont_drop" | "zoom_reinstall";

// Closed list of Zoom-billable types. Mirrors ZOOM_BILLABLE_TYPES in
// server/src/types.ts — keep in lockstep.
const ZOOM_BILLABLE_TYPES: { value: ZoomBillableType; label: string }[] = [
  { value: "zoom_fibre_install", label: "Fibre Install" },
  { value: "zoom_ont_drop", label: "ONT Drop" },
  { value: "zoom_reinstall", label: "Zoom Reinstall" },
];

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

interface SecondaryTech {
  id: number;
  name: string;
}

interface DuplicateInfo {
  existing_submission_id: number;
  existing_task_id: number;
  existing_created_at: number;
  existing_status: string;
  splynx_comment_posted: boolean;
}

/**
 * crypto.randomUUID() exists in all modern browsers (PWA target is
 * fine), but we fall back to a Math.random-based shape for very old
 * runtimes so the submit never breaks. The token is opaque to the
 * server — it only checks equality against rows already inserted.
 */
function makeIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `fb-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

export function TaskDetail() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const [data, setData] = useState<TaskResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [photos, setPhotos] = useState<CapturedPhoto[]>([]);
  const [comment, setComment] = useState("");
  const [stockNotes, setStockNotes] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [phase, setPhase] = useState<SubmitPhase>("idle");
  const [uploadFraction, setUploadFraction] = useState<number | null>(null);
  const [uploadLoaded, setUploadLoaded] = useState(0);
  const [uploadTotal, setUploadTotal] = useState(0);
  const [secondaryTechRoster, setSecondaryTechRoster] = useState<SecondaryTech[]>([]);
  const [selectedSecondaryIds, setSelectedSecondaryIds] = useState<number[]>([]);
  const { me } = useAuth();
  const [zoomBillableType, setZoomBillableType] = useState<ZoomBillableType | null>(null);
  // Idempotency token persists across retries of the same form instance
  // so a lost response on the first attempt doesn't create a duplicate
  // on the second. Regenerated only when the tech explicitly confirms a
  // re-send via the duplicate warning panel.
  const idempotencyKey = useRef<string>(makeIdempotencyKey());
  const [duplicateInfo, setDuplicateInfo] = useState<DuplicateInfo | null>(null);
  const submitting = phase === "uploading" || phase === "processing";

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

  // Fetch the active secondary-tech roster once on mount. Best-effort — if
  // it 401s or the network drops we render no chip row and the form keeps
  // working exactly as it did before this feature shipped.
  useEffect(() => {
    api
      .get<{ secondary_techs: SecondaryTech[] }>("/secondary-techs")
      .then((r) => setSecondaryTechRoster(r.secondary_techs))
      .catch(() => setSecondaryTechRoster([]));
  }, []);

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
    setSubmitError(null);
    setDuplicateInfo(null);
    setPhase("uploading");
    setUploadFraction(0);
    setUploadLoaded(0);
    setUploadTotal(photos.reduce((s, p) => s + p.file.size, 0));

    try {
      const fd = new FormData();
      fd.append("comment", comment);
      if (stockNotes.trim()) fd.append("stock_notes", stockNotes);
      if (selectedSecondaryIds.length > 0) {
        fd.append("secondary_tech_ids", selectedSecondaryIds.join(","));
      }
      if (zoomBillableType) fd.append("zoom_billable_type", zoomBillableType);
      fd.append("idempotency_key", idempotencyKey.current);
      for (const p of photos) fd.append("photos", p.file, p.file.name || "photo.jpg");

      const res = await api.upload<SubmitResponse>(`/tasks/${id}/submit`, fd, {
        onProgress: (p) => {
          setUploadFraction(p.fraction);
          setUploadLoaded(p.loaded);
          if (p.total) setUploadTotal(p.total);
        },
        onUploadComplete: () => {
          setUploadFraction(1);
          setPhase("processing");
        },
      });
      setPhase("done");
      nav(`/submitting/${res.submission_id}`);
    } catch (e: unknown) {
      if (e instanceof ApiError) {
        if (e.status === 400 && (e.body as { error?: string })?.error === "no_photos") {
          setSubmitError("No valid photos uploaded.");
        } else if (e.status === 409 && (e.body as { error?: string })?.error === "duplicate_submission") {
          // Server already saw this idempotency token. Show the
          // duplicate-warning panel; the tech decides whether to retry
          // with a fresh token or just navigate to the existing one.
          setDuplicateInfo(e.body as DuplicateInfo);
        } else if (e.status === 413) {
          setSubmitError("Photos are too large — try fewer or smaller files.");
        } else {
          setSubmitError(`Submit failed (${e.status}).`);
        }
      } else {
        setSubmitError("Submit failed — network error.");
      }
      setPhase("error");
    }
  }

  function confirmResubmit() {
    // Fresh token bypasses the server's dedup check, so a deliberate
    // re-send goes through cleanly. Clearing the warning panel before
    // re-entering handleSubmit so the new attempt starts from a clean
    // slate.
    idempotencyKey.current = makeIdempotencyKey();
    setDuplicateInfo(null);
    handleSubmit();
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

        {secondaryTechRoster.length > 0 && (
          <SecondaryTechChips
            roster={secondaryTechRoster}
            selected={selectedSecondaryIds}
            onChange={setSelectedSecondaryIds}
            disabled={submitting}
          />
        )}

        {me?.zoom_billable && (
          <ZoomBillableChips
            selected={zoomBillableType}
            onChange={setZoomBillableType}
            disabled={submitting}
          />
        )}

        <label className="stack" style={{ gap: 4 }}>
          <span style={{ color: "var(--c-success)", fontWeight: 500 }}>
            Stock used (codes + items, one per line)
          </span>
          <textarea
            value={stockNotes}
            onChange={(e) => setStockNotes(e.target.value)}
            placeholder="EW3000GX router x1&#10;CAB-FT5-30m fibre patch lead x1"
            disabled={submitting}
            maxLength={2000}
            rows={3}
          />
        </label>

        <label className="stack" style={{ gap: 4 }}>
          <span style={{ color: "var(--c-danger)", fontWeight: 500 }}>
            Notes (what was done, what was used, anything notable)
          </span>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Replaced router, tested speed with customer on site, all OK."
            disabled={submitting}
            maxLength={4000}
          />
        </label>

        {submitError && <div className="danger">{submitError}</div>}

        {duplicateInfo && (
          <DuplicateWarning info={duplicateInfo} onConfirm={confirmResubmit} />
        )}

        <button onClick={handleSubmit} disabled={submitting || photos.length === 0}>
          {phase === "uploading"
            ? "Uploading…"
            : phase === "processing"
              ? "Processing…"
              : "Submit update"}
        </button>

        <SubmitProgress
          phase={phase}
          uploadFraction={uploadFraction}
          uploadLoadedBytes={uploadLoaded}
          uploadTotalBytes={uploadTotal}
          errorMessage={submitError}
        />
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

function DuplicateWarning({
  info,
  onConfirm,
}: {
  info: DuplicateInfo;
  onConfirm: () => void;
}) {
  const when = new Date(info.existing_created_at).toLocaleString();
  return (
    <div
      className="stack"
      style={{
        gap: 8,
        padding: "10px 12px",
        background: "rgba(227, 179, 65, 0.12)",
        border: "1px solid rgba(227, 179, 65, 0.5)",
        borderRadius: "var(--r)",
      }}
    >
      <div>
        <strong>Looks like this just got submitted.</strong>
        <div style={{ fontSize: "0.9em", marginTop: 4 }}>
          Submission #{info.existing_submission_id} for task #{info.existing_task_id}{" "}
          landed at {when} (status: {info.existing_status}
          {info.splynx_comment_posted ? " · already posted to Splynx" : ""}).
        </div>
      </div>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <Link to={`/submitting/${info.existing_submission_id}`}>
          <button className="secondary" type="button">
            View existing submission
          </button>
        </Link>
        <button type="button" onClick={onConfirm}>
          Submit again anyway
        </button>
      </div>
    </div>
  );
}

function ZoomBillableChips({
  selected,
  onChange,
  disabled,
}: {
  selected: ZoomBillableType | null;
  onChange: (next: ZoomBillableType | null) => void;
  disabled: boolean;
}) {
  return (
    <div className="stack" style={{ gap: 6 }}>
      <span style={{ color: "var(--c-accent)", fontWeight: 500, fontSize: "0.9em" }}>
        Zoom billable (overrides AI classification)
      </span>
      <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
        {ZOOM_BILLABLE_TYPES.map((t) => {
          const on = selected === t.value;
          return (
            <button
              key={t.value}
              type="button"
              disabled={disabled}
              onClick={() => onChange(on ? null : t.value)}
              className={on ? "" : "secondary"}
              style={{
                padding: "6px 12px",
                fontSize: "0.9em",
                borderRadius: 999,
              }}
            >
              {on ? "✓ " : ""}{t.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SecondaryTechChips({
  roster,
  selected,
  onChange,
  disabled,
}: {
  roster: SecondaryTech[];
  selected: number[];
  onChange: (ids: number[]) => void;
  disabled: boolean;
}) {
  function toggle(id: number) {
    if (selected.includes(id)) onChange(selected.filter((i) => i !== id));
    else onChange([...selected, id]);
  }
  return (
    <div className="stack" style={{ gap: 6 }}>
      <span className="muted" style={{ fontSize: "0.9em" }}>
        Working with anyone? Tap to tag.
      </span>
      <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
        {roster.map((t) => {
          const on = selected.includes(t.id);
          return (
            <button
              key={t.id}
              type="button"
              disabled={disabled}
              onClick={() => toggle(t.id)}
              className={on ? "" : "secondary"}
              style={{
                padding: "6px 12px",
                fontSize: "0.9em",
                borderRadius: 999,
              }}
            >
              {on ? "✓ " : ""}{t.name}
            </button>
          );
        })}
      </div>
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

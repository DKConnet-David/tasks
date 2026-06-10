import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, api } from "../../api";
import { PhotoCapture, type CapturedPhoto } from "../../components/PhotoCapture";
import { SubmitProgress, type SubmitPhase } from "../../components/SubmitProgress";

interface SubmitResponse {
  submission_id: number;
  task_id: number;
  status: string;
}

interface SecondaryTech {
  id: number;
  name: string;
}

interface TechRosterEntry {
  id: number;
  login: string;
  display_name: string;
  is_active: 0 | 1;
  zoom_billable: 0 | 1;
}

type ZoomBillableType = "zoom_fibre_install" | "zoom_ont_drop" | "zoom_reinstall";

const ZOOM_BILLABLE_TYPES: { value: ZoomBillableType; label: string }[] = [
  { value: "zoom_fibre_install", label: "Fibre Install" },
  { value: "zoom_ont_drop", label: "ONT Drop" },
  { value: "zoom_reinstall", label: "Zoom Reinstall" },
];

function makeIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function ManualSubmit() {
  const nav = useNavigate();
  const [taskId, setTaskId] = useState("");
  const [comment, setComment] = useState("");
  const [stockNotes, setStockNotes] = useState("");
  const [onBehalfOfLogin, setOnBehalfOfLogin] = useState("");
  const [onBehalfOfAdminId, setOnBehalfOfAdminId] = useState("");
  const [photos, setPhotos] = useState<CapturedPhoto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<SubmitPhase>("idle");
  const [uploadFraction, setUploadFraction] = useState<number | null>(null);
  const [uploadLoaded, setUploadLoaded] = useState(0);
  const [uploadTotal, setUploadTotal] = useState(0);

  const [secondaryTechRoster, setSecondaryTechRoster] = useState<SecondaryTech[]>([]);
  const [selectedSecondaryIds, setSelectedSecondaryIds] = useState<number[]>([]);
  const [techRoster, setTechRoster] = useState<TechRosterEntry[]>([]);
  const [zoomBillableType, setZoomBillableType] = useState<ZoomBillableType | null>(null);

  // Time overrides — empty strings mean "use the default" (now / AI value).
  const [submissionDateTime, setSubmissionDateTime] = useState(""); // datetime-local
  const [jobStartTime, setJobStartTime] = useState(""); // HH:MM
  const [jobEndTime, setJobEndTime] = useState(""); // HH:MM

  // Fresh idempotency token on every mount of the manual form so each
  // open is treated as a new in-flight submission.
  const idempotencyKey = useRef<string>(makeIdempotencyKey());

  const busy = phase === "uploading" || phase === "processing";

  // Fetch the secondary-tech roster + the techs list once. Failure
  // is non-fatal — the picker just doesn't render. The tech list
  // drives the Zoom-billable picker visibility based on the typed
  // "On behalf of" login.
  useEffect(() => {
    api
      .get<{ secondary_techs: SecondaryTech[] }>("/secondary-techs")
      .then((r) => setSecondaryTechRoster(r.secondary_techs))
      .catch(() => setSecondaryTechRoster([]));
    api
      .get<{ techs: TechRosterEntry[] }>("/admin/techs")
      .then((r) => setTechRoster(r.techs))
      .catch(() => setTechRoster([]));
  }, []);

  // Cleanup blob URLs on unmount.
  useEffect(() => {
    return () => {
      for (const p of photos) URL.revokeObjectURL(p.previewUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Does the targeted tech see the Zoom-billable picker? Matches the
  // server-side gate (techs.zoom_billable = 1 AND is_active = 1) on
  // the typed on_behalf_of_login.
  const targetTechAllowsZoom = (() => {
    const login = onBehalfOfLogin.trim().toLowerCase();
    if (!login) return false;
    const t = techRoster.find((r) => r.login.toLowerCase() === login);
    return !!t && t.is_active === 1 && t.zoom_billable === 1;
  })();

  // If the targeted tech changes mid-form and no longer allows Zoom,
  // clear any selection so we don't send a stale override.
  useEffect(() => {
    if (!targetTechAllowsZoom && zoomBillableType !== null) {
      setZoomBillableType(null);
    }
  }, [targetTechAllowsZoom, zoomBillableType]);

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
    setError(null);
    setPhase("uploading");
    setUploadFraction(0);
    setUploadLoaded(0);
    setUploadTotal(photos.reduce((s, p) => s + p.file.size, 0));
    try {
      const fd = new FormData();
      fd.append("task_id", String(id));
      fd.append("comment", comment);
      if (stockNotes.trim()) fd.append("stock_notes", stockNotes);
      if (selectedSecondaryIds.length > 0) {
        fd.append("secondary_tech_ids", selectedSecondaryIds.join(","));
      }
      if (zoomBillableType) fd.append("zoom_billable_type", zoomBillableType);
      if (onBehalfOfLogin.trim()) fd.append("on_behalf_of_login", onBehalfOfLogin.trim());
      if (onBehalfOfAdminId.trim()) fd.append("on_behalf_of_admin_id", onBehalfOfAdminId.trim());
      if (submissionDateTime) {
        // datetime-local gives "YYYY-MM-DDTHH:MM" in the user's local
        // timezone — convert to epoch ms the server expects.
        const ms = new Date(submissionDateTime).getTime();
        if (Number.isFinite(ms)) fd.append("submission_created_at", String(ms));
      }
      if (jobStartTime) fd.append("job_start_time", jobStartTime);
      if (jobEndTime) fd.append("job_end_time", jobEndTime);
      fd.append("idempotency_key", idempotencyKey.current);
      for (const p of photos) fd.append("photos", p.file, p.file.name || "photo.jpg");
      const res = await api.upload<SubmitResponse>("/admin/submissions/manual", fd, {
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
      nav(`/admin/submissions/${res.submission_id}`);
    } catch (e: unknown) {
      if (e instanceof ApiError) {
        const detail = (e.body as { detail?: string; error?: string })?.detail;
        const code = (e.body as { error?: string })?.error;
        if (e.status === 0) {
          setError(
            "Connection dropped before the server replied. Tap Submit again — if the job already landed, we'll catch the duplicate.",
          );
        } else if (e.status === 409 && code === "duplicate_submission") {
          setError(
            "This entry was already submitted (idempotency token matched). Refresh the page to start a fresh form.",
          );
        } else {
          setError(detail ?? code ?? `Submit failed (${e.status})`);
        }
      } else {
        setError("Network error");
      }
      setPhase("error");
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

        {secondaryTechRoster.length > 0 && (
          <SecondaryTechChips
            roster={secondaryTechRoster}
            selected={selectedSecondaryIds}
            onChange={setSelectedSecondaryIds}
            disabled={busy}
          />
        )}

        {targetTechAllowsZoom && (
          <ZoomBillableChips
            selected={zoomBillableType}
            onChange={setZoomBillableType}
            disabled={busy}
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
            disabled={busy}
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
            rows={4}
            placeholder="Replaced router, tested speed, customer happy."
            disabled={busy}
            maxLength={4000}
          />
        </label>

        <TimeOverrideBlock
          submissionDateTime={submissionDateTime}
          setSubmissionDateTime={setSubmissionDateTime}
          jobStartTime={jobStartTime}
          setJobStartTime={setJobStartTime}
          jobEndTime={jobEndTime}
          setJobEndTime={setJobEndTime}
          disabled={busy}
        />

        {error && <div className="danger">{error}</div>}

        <button disabled={busy || photos.length === 0}>
          {busy ? "Submitting…" : "Submit (runs full pipeline)"}
        </button>

        <SubmitProgress
          phase={phase}
          uploadFraction={uploadFraction}
          uploadLoadedBytes={uploadLoaded}
          uploadTotalBytes={uploadTotal}
          errorMessage={error}
        />
      </form>
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
              style={{ padding: "6px 12px", fontSize: "0.9em", borderRadius: 999 }}
            >
              {on ? "✓ " : ""}{t.name}
            </button>
          );
        })}
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
              style={{ padding: "6px 12px", fontSize: "0.9em", borderRadius: 999 }}
            >
              {on ? "✓ " : ""}{t.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function TimeOverrideBlock({
  submissionDateTime,
  setSubmissionDateTime,
  jobStartTime,
  setJobStartTime,
  jobEndTime,
  setJobEndTime,
  disabled,
}: {
  submissionDateTime: string;
  setSubmissionDateTime: (v: string) => void;
  jobStartTime: string;
  setJobStartTime: (v: string) => void;
  jobEndTime: string;
  setJobEndTime: (v: string) => void;
  disabled: boolean;
}) {
  return (
    <div
      className="stack"
      style={{
        gap: 8,
        padding: 12,
        border: "1px dashed var(--c-border)",
        borderRadius: "var(--r)",
      }}
    >
      <div>
        <strong>When did this actually happen?</strong>
        <p className="muted" style={{ margin: "4px 0 0", fontSize: "0.85em" }}>
          Leave any field blank to use the defaults (now for the submission, the AI's reading
          of the job-card photo for start/end times).
        </p>
      </div>
      <label className="stack" style={{ gap: 4 }}>
        <span className="muted" style={{ fontSize: "0.9em" }}>
          Submitted at (backdates the entry)
        </span>
        <input
          type="datetime-local"
          value={submissionDateTime}
          onChange={(e) => setSubmissionDateTime(e.target.value)}
          disabled={disabled}
          style={{ maxWidth: 260 }}
        />
      </label>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
          gap: 8,
        }}
      >
        <label className="stack" style={{ gap: 4 }}>
          <span className="muted" style={{ fontSize: "0.9em" }}>
            Job Start Time
          </span>
          <input
            type="time"
            value={jobStartTime}
            onChange={(e) => setJobStartTime(e.target.value)}
            disabled={disabled}
          />
        </label>
        <label className="stack" style={{ gap: 4 }}>
          <span className="muted" style={{ fontSize: "0.9em" }}>
            Job End Time
          </span>
          <input
            type="time"
            value={jobEndTime}
            onChange={(e) => setJobEndTime(e.target.value)}
            disabled={disabled}
          />
        </label>
      </div>
    </div>
  );
}

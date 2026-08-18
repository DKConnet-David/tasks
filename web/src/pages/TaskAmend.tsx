import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ApiError, api } from "../api";
import { useAuth } from "../auth";
import { PhotoCapture, type CapturedPhoto } from "../components/PhotoCapture";
import { SubmitProgress, type SubmitPhase } from "../components/SubmitProgress";

interface SubmissionLite {
  id: number;
  task_id: number;
  app_login: string;
  status: "pending" | "success" | "partial" | "failed";
  created_at: number;
}

interface SubmissionResponse {
  submission: SubmissionLite;
  amendment: { id: number } | null;
}

interface AmendmentResponse {
  amendment_id: number;
  submission_id: number;
  status: "success" | "partial" | "failed";
  photos_saved: number;
  photos_failed: number;
  errors?: string[];
}

const AMENDMENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const AMENDMENT_MAX_PHOTOS = 20;

export function TaskAmend() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const { me } = useAuth();
  const [submission, setSubmission] = useState<SubmissionLite | null>(null);
  const [existingAmendmentId, setExistingAmendmentId] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [photos, setPhotos] = useState<CapturedPhoto[]>([]);
  const [comment, setComment] = useState("");
  const [phase, setPhase] = useState<SubmitPhase>("idle");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [uploadFraction, setUploadFraction] = useState<number | null>(null);
  const [uploadLoaded, setUploadLoaded] = useState(0);
  const [uploadTotal, setUploadTotal] = useState(0);
  const submitting = phase === "uploading" || phase === "processing";

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    api
      .get<SubmissionResponse>(`/submissions/${id}`)
      .then((r) => {
        setSubmission(r.submission);
        setExistingAmendmentId(r.amendment?.id ?? null);
      })
      .catch((e: unknown) => {
        if (e instanceof ApiError) setLoadError(`Failed to load submission (${e.status})`);
        else setLoadError("Failed to load submission — network error");
      })
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    return () => {
      for (const p of photos) URL.revokeObjectURL(p.previewUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSubmit() {
    if (!id) return;
    if (!comment.trim() && photos.length === 0) {
      setSubmitError("Add a note or at least one photo.");
      return;
    }
    setSubmitError(null);
    setPhase("uploading");
    setUploadFraction(0);
    setUploadLoaded(0);
    setUploadTotal(photos.reduce((s, p) => s + p.file.size, 0));

    try {
      const fd = new FormData();
      fd.append("comment", comment);
      for (const p of photos) fd.append("photos", p.file, p.file.name || "photo.jpg");
      const res = await api.upload<AmendmentResponse>(
        `/tasks/submissions/${id}/amendment`,
        fd,
        {
          onProgress: (p) => {
            setUploadFraction(p.fraction);
            setUploadLoaded(p.loaded);
            if (p.total) setUploadTotal(p.total);
          },
          onUploadComplete: () => {
            setUploadFraction(1);
            setPhase("processing");
          },
        },
      );
      setPhase("done");
      nav(`/submitting/${res.submission_id}`);
    } catch (e: unknown) {
      if (e instanceof ApiError) {
        const body = e.body as { error?: string; detail?: string; elapsed_hours?: number };
        if (e.status === 409 && body?.error === "amendment_already_exists") {
          setSubmitError("An amendment has already been added to this submission.");
        } else if (e.status === 409 && body?.error === "amendment_window_expired") {
          setSubmitError(
            `Amendment window has expired (${body.elapsed_hours ?? "?"}h after submission).`,
          );
        } else if (e.status === 409 && body?.error === "invalid_submission_status") {
          setSubmitError(body?.detail ?? "Cannot amend this submission in its current state.");
        } else if (e.status === 403) {
          setSubmitError("You don't have permission to amend this submission.");
        } else if (e.status === 400 && body?.error === "empty_amendment") {
          setSubmitError("Add a note or at least one photo.");
        } else {
          setSubmitError(`Submit failed (${e.status}).`);
        }
      } else {
        setSubmitError("Connection dropped before the server replied. Tap Submit again.");
      }
      setPhase("error");
    }
  }

  if (loading) {
    return (
      <div className="container muted">
        <Link to="/">← Back</Link>
        <p>Loading submission #{id}…</p>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="container stack">
        <Link to="/">← Back</Link>
        <p className="danger">{loadError}</p>
      </div>
    );
  }

  if (!submission) return null;

  const ownsSubmission =
    !!me && (me.is_admin || me.app_login === submission.app_login);
  const withinWindow = Date.now() - submission.created_at < AMENDMENT_WINDOW_MS;
  const eligible =
    ownsSubmission &&
    withinWindow &&
    existingAmendmentId === null &&
    (submission.status === "success" || submission.status === "partial");

  if (!eligible) {
    return (
      <div className="container stack">
        <Link to={`/submitting/${submission.id}`}>← Back to submission #{submission.id}</Link>
        <h1 style={{ marginBottom: 0 }}>Amendment not available</h1>
        {existingAmendmentId !== null && (
          <p className="muted">
            An amendment has already been added to this submission.
          </p>
        )}
        {existingAmendmentId === null && !withinWindow && (
          <p className="muted">
            The 24-hour amendment window has expired. Contact the office if you
            need to add anything now.
          </p>
        )}
        {existingAmendmentId === null && !ownsSubmission && (
          <p className="muted">
            You don't have permission to amend this submission.
          </p>
        )}
        {existingAmendmentId === null &&
          withinWindow &&
          ownsSubmission &&
          submission.status !== "success" &&
          submission.status !== "partial" && (
            <p className="muted">
              This submission is still {submission.status}. Wait for it to land
              before adding an amendment.
            </p>
          )}
      </div>
    );
  }

  const hoursRemaining = Math.max(
    0,
    (AMENDMENT_WINDOW_MS - (Date.now() - submission.created_at)) / (60 * 60 * 1000),
  );

  return (
    <div className="container stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <Link to={`/submitting/${submission.id}`}>← Back to submission #{submission.id}</Link>
        <span className="muted">Task #{submission.task_id}</span>
      </div>

      <h1 style={{ marginBottom: 0 }}>Add amendment</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        You have one amendment to spend on submission #{submission.id}. It'll be
        sent to the WhatsApp group and Splynx as a separate, timestamped note —
        the original submission stays exactly as it was.{" "}
        <strong>~{hoursRemaining.toFixed(1)}h left in the window.</strong>
      </p>

      <div className="panel stack">
        <PhotoCapture
          photos={photos}
          onChange={setPhotos}
          max={AMENDMENT_MAX_PHOTOS}
          disabled={submitting}
        />

        <label className="stack" style={{ gap: 4 }}>
          <span style={{ color: "var(--c-danger)", fontWeight: 500 }}>
            Additional notes
          </span>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Extra detail: serial number, missed step, follow-up needed…"
            disabled={submitting}
            maxLength={4000}
            rows={4}
          />
        </label>

        <button
          onClick={handleSubmit}
          disabled={submitting || (!comment.trim() && photos.length === 0)}
        >
          {phase === "uploading"
            ? "Uploading…"
            : phase === "processing"
              ? "Processing…"
              : "Send amendment"}
        </button>

        <SubmitProgress
          phase={phase}
          uploadFraction={uploadFraction}
          uploadLoadedBytes={uploadLoaded}
          uploadTotalBytes={uploadTotal}
          errorMessage={submitError}
        />
      </div>
    </div>
  );
}

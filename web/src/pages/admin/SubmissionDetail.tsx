import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError, api } from "../../api";

interface Submission {
  id: number;
  task_id: number;
  app_login: string;
  splynx_admin_id: number;
  source: string;
  comment: string | null;
  tech_comment_override: string | null;
  summary_json: string | null;
  corrected_summary_json: string | null;
  splynx_comment_id: number | null;
  splynx_corrected_comment_id: number | null;
  wa_message_id: string | null;
  status: string;
  error: string | null;
  admin_resolved: boolean;
  hidden: boolean;
  created_at: number;
  updated_at: number;
}

const JOB_TYPES = [
  { value: "ftua_installation", label: "FTUA Installation" },
  { value: "site_survey", label: "Site Survey" },
  { value: "fibre_los_inspection", label: "Fibre LOS Inspection" },
  { value: "layer2_fibre_setup", label: "Layer2 Fibre Setup" },
  { value: "extender_installation", label: "Extender Installation" },
  { value: "antenna_move", label: "Antenna Move" },
  { value: "offline_connection", label: "Offline Connection" },
  { value: "internal_issues_callout", label: "Internal Issues Call-Out" },
  { value: "voip_installation", label: "VoIP Installation" },
  { value: "complaint", label: "Complaint" },
  { value: "other", label: "Other" },
] as const;

interface Photo {
  id: number;
  filename: string;
  width: number;
  height: number;
  splynx_file_id: number | null;
}

interface Action {
  id: number;
  action: string;
  // Null for legacy actions recorded before multi-admin support landed.
  actor_login: string | null;
  details_json: string | null;
  created_at: number;
}

interface RequirementsItem {
  requirement: string;
  status: "found" | "missing" | "unclear";
  evidence: string;
}

interface RequirementsCheckResponse {
  job_type: string;
  items: RequirementsItem[];
}

interface DetailResponse {
  submission: Submission;
  photos: Photo[];
  actions: Action[];
  // Pre-built Splynx URL for the underlying task. Empty when Splynx
  // isn't configured.
  splynx_task_url: string;
  // Admin-only requirements-coverage check. Null when the toggle was off
  // at submit time, when there's no checklist for the job type, or on
  // legacy submissions.
  requirements_check: RequirementsCheckResponse | null;
}

interface Summary {
  headline: string;
  what_was_done: string;
  observations: string;
  follow_ups: string;
  job_type?: string;
  // AI-generated, one per photo, in the same order as photos[]. Surfaced
  // as the caption in the photo lightbox so the operator gets the AI's
  // read on each image without leaving the page.
  photo_descriptions?: string[];
  // Job-card check from the summarize AI step. Drives the 🚩 Flags panel.
  // Optional so legacy submissions (without the field in summary_json)
  // still parse — the Flags panel just hides for those.
  job_card?: {
    job_card_found: boolean;
    customer_signature_present: boolean;
    workmanship_satisfaction: "Y" | "N" | "unknown";
    work_satisfaction: "Y" | "N" | "unknown";
  };
}

interface RatingResponse {
  ai: {
    score: number;
    // Legacy paragraph rationale — only populated for older submissions.
    // New ratings store strengths/improvements bullets instead.
    rationale: string;
    strengths: string[];
    improvements: string[];
    dimensions: Record<string, number>;
  };
  admin: {
    score: number;
    rationale: string | null;
    dimensions: Record<string, number> | null;
  } | null;
  reviewed_at: number | null;
}

export function SubmissionDetail() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<DetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [okMessage, setOkMessage] = useState<string | null>(null);

  // Edit state
  const [summaryDraft, setSummaryDraft] = useState<Summary | null>(null);
  const [techCommentDraft, setTechCommentDraft] = useState<string>("");
  const [regenerated, setRegenerated] = useState<Summary | null>(null);

  // Rating
  const [rating, setRating] = useState<RatingResponse | null>(null);
  const [adminScoreDraft, setAdminScoreDraft] = useState<number | null>(null);
  const [adminRationaleDraft, setAdminRationaleDraft] = useState<string>("");
  const [adminDimsDraft, setAdminDimsDraft] = useState<Record<string, number> | null>(null);

  // Photo lightbox: null = closed, number = current photo index in photos[].
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  async function loadAll() {
    if (!id) return;
    try {
      const d = await api.get<DetailResponse>(`/admin/submissions/${id}`);
      setData(d);
      const sum = currentSummary(d.submission);
      setSummaryDraft(sum);
      setTechCommentDraft(d.submission.tech_comment_override ?? d.submission.comment ?? "");
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? `Load failed (${e.status})` : "Network error");
    }
    try {
      const r = await api.get<RatingResponse>(`/admin/submissions/${id}/rating`);
      setRating(r);
      const initial = r.admin ?? r.ai;
      setAdminScoreDraft(initial.score);
      setAdminRationaleDraft(r.admin?.rationale ?? "");
      setAdminDimsDraft(r.admin?.dimensions ?? r.ai.dimensions);
    } catch {
      // Rating may not exist yet (legacy submissions); ignore.
    }
  }

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function saveSummary() {
    if (!summaryDraft || !id) return;
    setBusy("save-summary");
    try {
      const res = await api.patch<{ pushed_to_splynx: boolean; push_error: string | null }>(
        `/admin/submissions/${id}/summary`,
        summaryDraft,
      );
      setOkMessage(
        res.pushed_to_splynx
          ? "Summary saved and pushed to Splynx (in-place edit)."
          : `Summary saved locally${res.push_error ? ` — Splynx push failed: ${res.push_error}` : "."}`,
      );
      await loadAll();
    } catch (e) {
      setError(e instanceof ApiError ? `Save failed (${e.status})` : "Network error");
    } finally {
      setBusy(null);
    }
  }

  async function saveTechComment() {
    if (!id) return;
    setBusy("save-tech-comment");
    try {
      await api.patch(`/admin/submissions/${id}/tech-comment`, {
        tech_comment_override: techCommentDraft,
      });
      setOkMessage("Tech comment override saved (local only — not pushed to Splynx).");
      await loadAll();
    } catch (e) {
      setError(e instanceof ApiError ? `Save failed (${e.status})` : "Network error");
    } finally {
      setBusy(null);
    }
  }

  async function resendWhatsApp() {
    if (!id) return;
    setBusy("wa");
    try {
      const res = await api.post<{ message_id: string | null }>(
        `/admin/submissions/${id}/resend-whatsapp`,
      );
      setOkMessage(`WhatsApp resent. Message id: ${res.message_id ?? "(unknown)"}`);
    } catch (e) {
      const detail = e instanceof ApiError ? (e.body as { detail?: string })?.detail : null;
      setError(detail ? `Resend failed: ${detail}` : "Resend failed");
    } finally {
      setBusy(null);
    }
  }

  async function reattachSplynx() {
    if (!id) return;
    setBusy("reattach");
    try {
      const res = await api.post<{ comment_id: number | null; errors: string[] }>(
        `/admin/submissions/${id}/reattach-splynx`,
      );
      if (res.errors.length === 0) {
        setOkMessage(`Re-attached to Splynx. New comment id: ${res.comment_id ?? "(unknown)"}`);
      } else {
        setError(`Re-attach finished with errors: ${res.errors.join("; ")}`);
      }
    } catch (e) {
      setError(e instanceof ApiError ? `Re-attach failed (${e.status})` : "Network error");
    } finally {
      setBusy(null);
    }
  }

  async function regenerateSummary() {
    if (!id) return;
    setBusy("regen");
    setRegenerated(null);
    try {
      const res = await api.post<{ summary: Summary }>(
        `/admin/submissions/${id}/regenerate-summary`,
      );
      setRegenerated(res.summary);
      setOkMessage("New summary generated. Review below; click 'Use this' to save it.");
    } catch (e) {
      setError(e instanceof ApiError ? `Regenerate failed (${e.status})` : "Network error");
    } finally {
      setBusy(null);
    }
  }

  async function toggleResolved() {
    if (!id) return;
    setBusy("resolve");
    try {
      await api.post(`/admin/submissions/${id}/resolve`);
      await loadAll();
    } catch (e) {
      setError(e instanceof ApiError ? `Failed (${e.status})` : "Network error");
    } finally {
      setBusy(null);
    }
  }

  async function saveJobType(jobType: string) {
    if (!id) return;
    setBusy("job-type");
    setError(null);
    try {
      await api.patch(`/admin/submissions/${id}/job-type`, { job_type: jobType });
      setOkMessage(`Job type set to "${jobType.replace(/_/g, " ")}".`);
      await loadAll();
    } catch (e) {
      setError(e instanceof ApiError ? `Save failed (${e.status})` : "Network error");
    } finally {
      setBusy(null);
    }
  }

  async function toggleHidden() {
    if (!id || !data) return;
    const next = !data.submission.hidden;
    if (next && !confirm(
      "Hide this submission? It will be excluded from the Submissions list and all Performance dashboards. The submission stays in the database — you can unhide it later.",
    )) return;
    setBusy("hidden");
    setError(null);
    try {
      await api.patch(`/admin/submissions/${id}/hidden`, { hidden: next });
      setOkMessage(next ? "Submission hidden." : "Submission visible again.");
      await loadAll();
    } catch (e) {
      setError(e instanceof ApiError ? `Failed (${e.status})` : "Network error");
    } finally {
      setBusy(null);
    }
  }

  async function saveRating() {
    if (!id) return;
    setBusy("rating");
    try {
      await api.patch(`/admin/submissions/${id}/rating`, {
        score: adminScoreDraft,
        rationale: adminRationaleDraft,
        dimensions: adminDimsDraft,
      });
      setOkMessage(
        "Rating saved. The next AI rating will use this as a calibration example.",
      );
      await loadAll();
    } catch (e) {
      setError(e instanceof ApiError ? `Rating save failed (${e.status})` : "Network error");
    } finally {
      setBusy(null);
    }
  }

  if (error && !data) return <div className="panel danger">{error}</div>;
  if (!data) return <div className="panel muted">Loading…</div>;

  const { submission, photos, actions, splynx_task_url, requirements_check } = data;
  const summary = currentSummary(submission);

  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <Link to="/admin">← All submissions</Link>
        <Link to={`/tasks/${submission.task_id}`}>Open task #{submission.task_id} (tech view)</Link>
      </div>

      <div className="panel stack">
        <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <h1 style={{ margin: 0 }}>
            {splynx_task_url ? (
              <a
                href={splynx_task_url}
                target="_blank"
                rel="noreferrer"
                title="Open task in Splynx (new tab)"
                style={{ textDecoration: "none" }}
              >
                Task #{submission.task_id}{" "}
                <span style={{ fontSize: "0.55em", verticalAlign: "middle", opacity: 0.7 }}>
                  ↗
                </span>
              </a>
            ) : (
              <>Task #{submission.task_id}</>
            )}
          </h1>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <span className={statusBadge(submission.status)}>{submission.status}</span>
            <span className="badge">{submission.source}</span>
            {submission.splynx_comment_id !== null && <span className="badge success">Splynx ✓</span>}
            {submission.wa_message_id !== null && <span className="badge success">WhatsApp ✓</span>}
            {submission.admin_resolved && <span className="badge success">resolved</span>}
            {submission.hidden && <span className="badge warn">hidden</span>}
          </div>
        </div>
        <div className="muted" style={{ fontSize: "0.9em" }}>
          Submission #{submission.id} • {submission.app_login} • Splynx admin id{" "}
          {submission.splynx_admin_id} • {new Date(submission.created_at).toLocaleString()}
        </div>
        {submission.error && (
          <pre
            style={{
              whiteSpace: "pre-wrap",
              background: "#1f1620",
              color: "var(--c-danger)",
              padding: 12,
              borderRadius: 6,
              fontFamily: "inherit",
              margin: 0,
            }}
          >
            {submission.error}
          </pre>
        )}
      </div>

      <FlagsPanel jobCard={summary?.job_card} />

      <RequirementsCoveragePanel check={requirements_check} />

      {okMessage && <div className="panel success">{okMessage}</div>}
      {error && <div className="panel danger">{error}</div>}

      {/* Classification (job type) — feeds the Performance dashboard's
          "Job type breakdown" panel and the Type column in the Recent
          Submissions table. Edit here when the AI's auto-classification
          got it wrong. Saves to corrected_summary_json so the original
          AI output stays preserved. */}
      <div className="panel stack">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>Classification</h2>
          <span className="muted" style={{ fontSize: "0.85em" }}>
            Used by the Performance dashboard's job-type breakdown.
          </span>
        </div>
        <div className="row" style={{ gap: 8, alignItems: "center" }}>
          <label className="muted">Job type:</label>
          <select
            value={summary?.job_type ?? "other"}
            onChange={(e) => saveJobType(e.target.value)}
            disabled={busy === "job-type"}
            style={{ width: "auto", minWidth: 200 }}
          >
            {JOB_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
          {busy === "job-type" && <span className="muted">Saving…</span>}
        </div>
      </div>

      {/* AI summary editor */}
      <div className="panel stack">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>AI summary</h2>
          <button onClick={regenerateSummary} disabled={busy === "regen"} className="secondary">
            {busy === "regen" ? "Regenerating…" : "Regenerate"}
          </button>
        </div>
        {summaryDraft ? (
          <>
            <Field
              label="Headline"
              value={summaryDraft.headline}
              onChange={(v) => setSummaryDraft({ ...summaryDraft, headline: v })}
            />
            <Field
              label="What was done"
              value={summaryDraft.what_was_done}
              multi
              onChange={(v) => setSummaryDraft({ ...summaryDraft, what_was_done: v })}
            />
            <Field
              label="Observations"
              value={summaryDraft.observations}
              multi
              onChange={(v) => setSummaryDraft({ ...summaryDraft, observations: v })}
            />
            <Field
              label="Follow-ups"
              value={summaryDraft.follow_ups}
              multi
              onChange={(v) => setSummaryDraft({ ...summaryDraft, follow_ups: v })}
            />
            <div className="row" style={{ gap: 8 }}>
              <button onClick={saveSummary} disabled={busy === "save-summary"}>
                {busy === "save-summary" ? "Saving…" : "Save (pushes to Splynx)"}
              </button>
              <button
                onClick={() => summary && setSummaryDraft(summary)}
                className="secondary"
                disabled={busy !== null}
              >
                Reset to current
              </button>
            </div>
          </>
        ) : (
          <p className="muted">No summary stored.</p>
        )}

        {regenerated && (
          <div
            className="panel"
            style={{ background: "#0e2030", borderColor: "#2f81f7", marginTop: 8 }}
          >
            <div className="row" style={{ justifyContent: "space-between" }}>
              <strong>Regenerated suggestion</strong>
              <button onClick={() => setSummaryDraft(regenerated)} className="secondary">
                Use this
              </button>
            </div>
            <div style={{ marginTop: 8 }}>
              <strong>{regenerated.headline}</strong>
              <p style={{ whiteSpace: "pre-wrap", margin: "4px 0 0" }}>{regenerated.what_was_done}</p>
              {regenerated.observations.trim() && (
                <p style={{ whiteSpace: "pre-wrap", margin: "8px 0 0" }}>
                  <em>Observations:</em> {regenerated.observations}
                </p>
              )}
              {regenerated.follow_ups.trim() && (
                <p style={{ whiteSpace: "pre-wrap", margin: "8px 0 0" }}>
                  <em>Follow-ups:</em> {regenerated.follow_ups}
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Tech comment override */}
      <div className="panel stack">
        <h2 style={{ margin: 0 }}>Tech's notes</h2>
        <p className="muted" style={{ margin: 0, fontSize: "0.9em" }}>
          Edits here are local only (saved for our audit). Splynx is not updated.
        </p>
        <textarea
          value={techCommentDraft}
          onChange={(e) => setTechCommentDraft(e.target.value)}
          rows={6}
        />
        <div className="row" style={{ gap: 8 }}>
          <button onClick={saveTechComment} disabled={busy === "save-tech-comment"}>
            {busy === "save-tech-comment" ? "Saving…" : "Save override"}
          </button>
        </div>
      </div>

      {/* Action buttons */}
      <div className="panel stack">
        <h2 style={{ margin: 0 }}>Actions</h2>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <button onClick={resendWhatsApp} disabled={busy === "wa"}>
            {busy === "wa" ? "Sending…" : "Resend WhatsApp"}
          </button>
          <button onClick={reattachSplynx} disabled={busy === "reattach"}>
            {busy === "reattach" ? "Re-attaching…" : "Re-attach to Splynx"}
          </button>
          <a href={`/api/submissions/${submission.id}/pdf`} target="_blank" rel="noreferrer">
            <button className="secondary">Download PDF</button>
          </a>
          <button onClick={toggleResolved} className="secondary" disabled={busy === "resolve"}>
            {submission.admin_resolved ? "Mark unresolved" : "Mark resolved"}
          </button>
          <button
            onClick={toggleHidden}
            className={submission.hidden ? "secondary" : "danger"}
            disabled={busy === "hidden"}
            title={
              submission.hidden
                ? "This submission is hidden from the Submissions list and Performance dashboards. Unhide to make it visible again."
                : "Hide this submission from the Submissions list and all Performance dashboards. Useful for duplicates and typo task IDs. The submission stays in the database."
            }
          >
            {busy === "hidden"
              ? "Working…"
              : submission.hidden
                ? "Unhide submission"
                : "Hide (duplicate / typo)"}
          </button>
        </div>
      </div>

      {/* Photos */}
      <div className="panel stack">
        <h2 style={{ margin: 0 }}>Photos ({photos.length})</h2>
        {photos.length === 0 ? (
          <p className="muted">No photos.</p>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
              gap: 8,
            }}
          >
            {photos.map((p, i) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setLightboxIndex(i)}
                style={{
                  aspectRatio: "1 / 1",
                  borderRadius: "var(--r)",
                  overflow: "hidden",
                  background: "#000",
                  position: "relative",
                  display: "block",
                  padding: 0,
                  border: "none",
                  cursor: "zoom-in",
                  boxShadow: "var(--shadow-1)",
                }}
                aria-label={`Open photo ${i + 1} of ${photos.length}`}
              >
                <img
                  src={`/api/submissions/${submission.id}/photos/${p.filename}`}
                  alt=""
                  loading="lazy"
                  style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                />
                {p.splynx_file_id && (
                  <span
                    className="badge success"
                    style={{ position: "absolute", bottom: 4, right: 4, fontSize: "0.7em" }}
                  >
                    Splynx ✓
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Quality rating — admin only */}
      {rating && (
        <div
          className="panel stack"
          style={{
            border: "2px dashed var(--c-warn)",
          }}
        >
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h2 style={{ margin: 0 }}>Quality rating</h2>
            <span className="badge warn">admin-only — never sent externally</span>
          </div>
          <p className="muted" style={{ margin: 0, fontSize: "0.9em" }}>
            This block is invisible to the tech, never appears on the PDF, never goes to WhatsApp,
            and never reaches Splynx. Edits here only affect future AI calibration.
          </p>

          <div className="panel elevated stack">
            <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              <strong>AI's rating: {rating.ai.score}/10</strong>
              <span className="muted" style={{ fontSize: "0.85em" }}>
                {Object.entries(rating.ai.dimensions)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join(" • ")}
              </span>
            </div>

            {(rating.ai.strengths.length > 0 || rating.ai.improvements.length > 0) ? (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
                  gap: 16,
                }}
              >
                <BulletColumn
                  title="Done well"
                  marker="✓"
                  markerColor="#56d364"
                  items={rating.ai.strengths}
                  emptyHint="Nothing notable"
                />
                <BulletColumn
                  title="Should have done"
                  marker="→"
                  markerColor="#ff7b72"
                  items={rating.ai.improvements}
                  emptyHint="No issues found"
                />
              </div>
            ) : rating.ai.rationale ? (
              // Legacy paragraph rationale on older submissions, before the
              // strengths/improvements bullets were introduced.
              <div>
                <div className="muted" style={{ fontSize: "0.8em", textTransform: "uppercase", marginBottom: 4 }}>
                  Notes (legacy)
                </div>
                <p style={{ whiteSpace: "pre-wrap", margin: 0 }}>{rating.ai.rationale}</p>
              </div>
            ) : null}
          </div>

          <div className="stack">
            <label className="stack" style={{ gap: 4 }}>
              <span className="muted">Your score (1–10)</span>
              <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={n === adminScoreDraft ? "" : "secondary"}
                    style={{ minWidth: 38, padding: "0.5rem 0.6rem" }}
                    onClick={() => setAdminScoreDraft(n)}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </label>

            <label className="stack" style={{ gap: 4 }}>
              <span className="muted">Your rationale (helps the AI calibrate)</span>
              <textarea
                value={adminRationaleDraft}
                onChange={(e) => setAdminRationaleDraft(e.target.value)}
                rows={3}
                placeholder="e.g. missed cable labelling — that's a standards-failure for us"
              />
            </label>

            {adminDimsDraft && (
              <div className="stack" style={{ gap: 4 }}>
                <span className="muted">Dimensions</span>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
                    gap: 8,
                  }}
                >
                  {(["workmanship", "photo_quality", "completeness", "communication"] as const).map(
                    (dim) => (
                      <label key={dim} className="row" style={{ gap: 8 }}>
                        <span className="muted" style={{ minWidth: 100 }}>
                          {dim.replace("_", " ")}
                        </span>
                        <input
                          type="number"
                          min={1}
                          max={10}
                          value={adminDimsDraft[dim] ?? 6}
                          onChange={(e) =>
                            setAdminDimsDraft({
                              ...adminDimsDraft,
                              [dim]: Math.max(1, Math.min(10, Number(e.target.value) || 6)),
                            })
                          }
                          style={{ width: 70 }}
                        />
                      </label>
                    ),
                  )}
                </div>
              </div>
            )}

            <button onClick={saveRating} disabled={busy === "rating"}>
              {busy === "rating" ? "Saving…" : "Save rating"}
            </button>
          </div>
        </div>
      )}

      {/* Audit log */}
      {actions.length > 0 && (
        <details>
          <summary>Admin actions ({actions.length})</summary>
          <div className="panel" style={{ marginTop: 8 }}>
            <table style={{ width: "100%", fontSize: "0.85em" }}>
              <thead>
                <tr style={{ textAlign: "left" }}>
                  <th style={{ padding: 4 }}>When</th>
                  <th style={{ padding: 4 }}>Who</th>
                  <th style={{ padding: 4 }}>Action</th>
                  <th style={{ padding: 4 }}>Details</th>
                </tr>
              </thead>
              <tbody>
                {actions.map((a) => (
                  <tr key={a.id} style={{ borderTop: "1px solid var(--c-border)" }}>
                    <td style={{ padding: 4 }}>{new Date(a.created_at).toLocaleString()}</td>
                    <td style={{ padding: 4 }}>
                      {a.actor_login ? (
                        <strong>{a.actor_login}</strong>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td style={{ padding: 4 }}>{a.action}</td>
                    <td style={{ padding: 4, fontFamily: "monospace", fontSize: "0.8em" }}>
                      {a.details_json ?? ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {lightboxIndex !== null && photos[lightboxIndex] && (
        <PhotoLightbox
          submissionId={submission.id}
          photos={photos}
          descriptions={summary?.photo_descriptions ?? []}
          index={lightboxIndex}
          onChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  multi,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  multi?: boolean;
}) {
  return (
    <label className="stack" style={{ gap: 4 }}>
      <span className="muted">{label}</span>
      {multi ? (
        <textarea value={value} onChange={(e) => onChange(e.target.value)} rows={3} />
      ) : (
        <input value={value} onChange={(e) => onChange(e.target.value)} />
      )}
    </label>
  );
}

function statusBadge(s: string): string {
  if (s === "success") return "badge success";
  if (s === "failed") return "badge danger";
  return "badge warn";
}

/**
 * Render the same flag bullets the WhatsApp / Splynx / PDF surfaces show.
 * Hidden entirely on legacy submissions (no job_card on the summary) and
 * on submissions where the AI found nothing wrong — both render as zero
 * flags. Mirrors deriveJobCardFlags() in server/src/format/external.ts.
 */
function FlagsPanel({
  jobCard,
}: {
  jobCard: NonNullable<Summary["job_card"]> | undefined;
}) {
  if (!jobCard) return null;
  const flags: string[] = [];
  if (!jobCard.job_card_found) {
    flags.push("No job card photo found");
  } else {
    if (!jobCard.customer_signature_present) flags.push("No customer signature on job card");
    if (jobCard.workmanship_satisfaction === "N") flags.push("Workmanship marked N on job card");
    if (jobCard.work_satisfaction === "N")
      flags.push("Customer not satisfied with work (marked N on job card)");
  }
  if (flags.length === 0) return null;

  return (
    <div
      className="panel stack"
      style={{
        background: "rgba(255, 123, 114, 0.08)",
        border: "1px solid rgba(255, 123, 114, 0.3)",
      }}
    >
      <div className="row" style={{ alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: "1.2em" }} aria-hidden>
          🚩
        </span>
        <h3 style={{ margin: 0, color: "var(--c-danger)" }}>
          Flags ({flags.length})
        </h3>
      </div>
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {flags.map((f, i) => (
          <li
            key={i}
            style={{
              display: "flex",
              gap: 8,
              alignItems: "flex-start",
              padding: "4px 0",
              lineHeight: 1.4,
            }}
          >
            <span style={{ color: "var(--c-danger)", fontWeight: 700 }} aria-hidden>
              •
            </span>
            <span>{f}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * AI-graded coverage of the per-job-type photo / data checklist
 * (server/src/jobtypes/requirements.ts). Admin-only: never appears in
 * WhatsApp / Splynx / PDF. Renders nothing when no check was run
 * (toggle was off or the job_type has no checklist).
 */
function RequirementsCoveragePanel({
  check,
}: {
  check: RequirementsCheckResponse | null;
}) {
  if (!check || check.items.length === 0) return null;
  const found = check.items.filter((i) => i.status === "found").length;
  const missing = check.items.filter((i) => i.status === "missing").length;
  const unclear = check.items.filter((i) => i.status === "unclear").length;
  return (
    <div className="panel stack">
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div>
          <div className="row" style={{ alignItems: "center", gap: 8 }}>
            <h3 style={{ margin: 0 }}>Requirements coverage</h3>
            <span className="badge warn" title="Visible to admins only — never sent to clients">
              admin only
            </span>
          </div>
          <div className="muted" style={{ fontSize: "0.85em", marginTop: 4 }}>
            {found} of {check.items.length} checklist items found
            {missing > 0 && <> · {missing} missing</>}
            {unclear > 0 && <> · {unclear} unclear</>}
          </div>
        </div>
      </div>
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {check.items.map((item, i) => (
          <li
            key={i}
            style={{
              display: "flex",
              gap: 10,
              padding: "8px 0",
              borderTop: i === 0 ? "none" : "1px solid var(--c-border)",
              alignItems: "flex-start",
            }}
          >
            <span
              style={{
                flexShrink: 0,
                fontSize: "1em",
                fontWeight: 700,
                color: statusColor(item.status),
                width: 20,
                textAlign: "center",
              }}
              aria-label={item.status}
            >
              {statusIcon(item.status)}
            </span>
            <div style={{ flex: 1 }}>
              <div style={{ lineHeight: 1.35 }}>{item.requirement}</div>
              {item.evidence && (
                <div
                  className="muted"
                  style={{ fontSize: "0.85em", marginTop: 2, fontStyle: "italic" }}
                >
                  {item.evidence}
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function statusIcon(s: RequirementsItem["status"]): string {
  if (s === "found") return "✓";
  if (s === "missing") return "✗";
  return "?";
}

function statusColor(s: RequirementsItem["status"]): string {
  if (s === "found") return "var(--c-success)";
  if (s === "missing") return "var(--c-danger)";
  return "var(--c-warn)";
}

function BulletColumn({
  title,
  marker,
  markerColor,
  items,
  emptyHint,
}: {
  title: string;
  marker: string;
  markerColor: string;
  items: string[];
  emptyHint: string;
}) {
  return (
    <div>
      <div
        className="muted"
        style={{
          fontSize: "0.78em",
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          marginBottom: 6,
          fontWeight: 600,
        }}
      >
        {title}
      </div>
      {items.length === 0 ? (
        <div className="muted" style={{ fontSize: "0.9em", fontStyle: "italic" }}>
          {emptyHint}
        </div>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {items.map((it, i) => (
            <li
              key={i}
              style={{
                display: "flex",
                gap: 8,
                alignItems: "flex-start",
                padding: "4px 0",
                lineHeight: 1.4,
              }}
            >
              <span
                style={{ color: markerColor, fontWeight: 700, flexShrink: 0, marginTop: 1 }}
                aria-hidden="true"
              >
                {marker}
              </span>
              <span>{it}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function currentSummary(submission: Submission): Summary | null {
  const json = submission.corrected_summary_json ?? submission.summary_json;
  if (!json) return null;
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
    /* ignore */
  }
  return null;
}

// ---------- Photo lightbox ----------

interface LightboxPhoto {
  id: number;
  filename: string;
  splynx_file_id: number | null;
}

function PhotoLightbox({
  submissionId,
  photos,
  descriptions,
  index,
  onChange,
  onClose,
}: {
  submissionId: number;
  photos: LightboxPhoto[];
  descriptions: string[];
  index: number;
  onChange: (i: number) => void;
  onClose: () => void;
}) {
  const photo = photos[index]!;
  const description = descriptions[index] ?? "";
  const total = photos.length;
  const url = `/api/submissions/${submissionId}/photos/${photo.filename}`;

  // Keyboard: Esc closes, ←/→ navigate. Re-bind whenever index/total
  // changes so the bounds checks read the latest values.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "ArrowLeft" && index > 0) {
        onChange(index - 1);
      } else if (e.key === "ArrowRight" && index < total - 1) {
        onChange(index + 1);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [index, total, onChange, onClose]);

  // Lock body scroll while open so the page behind doesn't move when the
  // user wheels through the lightbox.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  function stop(e: React.SyntheticEvent) {
    e.stopPropagation();
  }

  return (
    <div
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Photo viewer"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.92)",
        zIndex: 1000,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "16px",
      }}
    >
      {/* Top toolbar */}
      <div
        onClick={stop}
        style={{
          position: "absolute",
          top: 12,
          left: 12,
          right: 12,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 8,
          color: "#e6edf3",
          fontSize: "0.9em",
        }}
      >
        <div className="row" style={{ gap: 12, alignItems: "center" }}>
          <span className="tabular" style={{ fontWeight: 600 }}>
            {index + 1} / {total}
          </span>
          {photo.splynx_file_id && (
            <span className="badge success">Splynx ✓</span>
          )}
        </div>
        <div className="row" style={{ gap: 8 }}>
          <a
            href={url}
            download={photo.filename}
            className="badge"
            style={{ background: "rgba(255,255,255,0.1)", color: "#e6edf3", padding: "6px 10px" }}
            onClick={stop}
          >
            Download
          </a>
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="badge"
            style={{ background: "rgba(255,255,255,0.1)", color: "#e6edf3", padding: "6px 10px" }}
            onClick={stop}
          >
            Open original
          </a>
          <button
            type="button"
            onClick={(e) => {
              stop(e);
              onClose();
            }}
            className="secondary"
            style={{ padding: "6px 12px", fontSize: "1em", lineHeight: 1 }}
            aria-label="Close"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Prev */}
      {index > 0 && (
        <button
          type="button"
          onClick={(e) => {
            stop(e);
            onChange(index - 1);
          }}
          className="secondary"
          aria-label="Previous photo"
          style={{
            position: "absolute",
            left: 16,
            top: "50%",
            transform: "translateY(-50%)",
            width: 48,
            height: 48,
            borderRadius: "50%",
            fontSize: "1.4em",
            padding: 0,
          }}
        >
          ‹
        </button>
      )}

      {/* Next */}
      {index < total - 1 && (
        <button
          type="button"
          onClick={(e) => {
            stop(e);
            onChange(index + 1);
          }}
          className="secondary"
          aria-label="Next photo"
          style={{
            position: "absolute",
            right: 16,
            top: "50%",
            transform: "translateY(-50%)",
            width: 48,
            height: 48,
            borderRadius: "50%",
            fontSize: "1.4em",
            padding: 0,
          }}
        >
          ›
        </button>
      )}

      {/* Image + caption — clicking inside the inner block must NOT close */}
      <div
        onClick={stop}
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 12,
          maxWidth: "100%",
          maxHeight: "100%",
        }}
      >
        <img
          src={url}
          alt={description || `Photo ${index + 1}`}
          style={{
            maxWidth: "min(100%, 1400px)",
            maxHeight: "calc(100vh - 140px)",
            objectFit: "contain",
            borderRadius: "var(--r)",
            boxShadow: "var(--shadow-3)",
            background: "#000",
          }}
        />
        {description && (
          <p
            style={{
              margin: 0,
              maxWidth: 800,
              textAlign: "center",
              color: "#c9d1d9",
              fontSize: "0.95em",
              lineHeight: 1.4,
              padding: "0 8px",
            }}
          >
            {description}
          </p>
        )}
      </div>
    </div>
  );
}

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
  created_at: number;
  updated_at: number;
}

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
  details_json: string | null;
  created_at: number;
}

interface DetailResponse {
  submission: Submission;
  photos: Photo[];
  actions: Action[];
}

interface Summary {
  headline: string;
  what_was_done: string;
  observations: string;
  follow_ups: string;
}

interface RatingResponse {
  ai: { score: number; rationale: string; dimensions: Record<string, number> };
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

  const { submission, photos, actions } = data;
  const summary = currentSummary(submission);

  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <Link to="/admin">← All submissions</Link>
        <Link to={`/tasks/${submission.task_id}`}>Open task #{submission.task_id} (tech view)</Link>
      </div>

      <div className="panel stack">
        <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <h1 style={{ margin: 0 }}>Submission #{submission.id}</h1>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <span className={statusBadge(submission.status)}>{submission.status}</span>
            <span className="badge">{submission.source}</span>
            {submission.splynx_comment_id !== null && <span className="badge success">Splynx ✓</span>}
            {submission.wa_message_id !== null && <span className="badge success">WhatsApp ✓</span>}
            {submission.admin_resolved && <span className="badge success">resolved</span>}
          </div>
        </div>
        <div className="muted" style={{ fontSize: "0.9em" }}>
          {submission.app_login} • Splynx admin id {submission.splynx_admin_id} •{" "}
          {new Date(submission.created_at).toLocaleString()}
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

      {okMessage && <div className="panel success">{okMessage}</div>}
      {error && <div className="panel danger">{error}</div>}

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
                  position: "relative",
                  display: "block",
                }}
              >
                <img
                  src={`/api/submissions/${submission.id}/photos/${p.filename}`}
                  alt=""
                  loading="lazy"
                  style={{ width: "100%", height: "100%", objectFit: "cover" }}
                />
                {p.splynx_file_id && (
                  <span
                    className="badge success"
                    style={{ position: "absolute", bottom: 4, right: 4, fontSize: "0.7em" }}
                  >
                    Splynx ✓
                  </span>
                )}
              </a>
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

          <div className="panel" style={{ background: "#0e1a14" }}>
            <strong>AI's rating: {rating.ai.score}/5</strong>
            <p style={{ whiteSpace: "pre-wrap", margin: "4px 0 0" }}>{rating.ai.rationale}</p>
            <div className="muted" style={{ fontSize: "0.85em", marginTop: 4 }}>
              {Object.entries(rating.ai.dimensions)
                .map(([k, v]) => `${k}: ${v}`)
                .join(" • ")}
            </div>
          </div>

          <div className="stack">
            <label className="stack" style={{ gap: 4 }}>
              <span className="muted">Your score</span>
              <div className="row" style={{ gap: 4 }}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={n === adminScoreDraft ? "" : "secondary"}
                    style={{ minWidth: 50 }}
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
                          max={5}
                          value={adminDimsDraft[dim] ?? 3}
                          onChange={(e) =>
                            setAdminDimsDraft({
                              ...adminDimsDraft,
                              [dim]: Math.max(1, Math.min(5, Number(e.target.value) || 3)),
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
                  <th style={{ padding: 4 }}>Action</th>
                  <th style={{ padding: 4 }}>Details</th>
                </tr>
              </thead>
              <tbody>
                {actions.map((a) => (
                  <tr key={a.id} style={{ borderTop: "1px solid var(--c-border)" }}>
                    <td style={{ padding: 4 }}>{new Date(a.created_at).toLocaleString()}</td>
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

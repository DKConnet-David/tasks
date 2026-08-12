import fs from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3";
import type { FastifyBaseLogger } from "fastify";
import type { AppConfig } from "../config.js";
import type { SplynxTaskRaw } from "../splynx/types.js";
import { getServiceSplynxClient } from "../splynx/service-client.js";
import { summarize } from "../ai/summarize.js";
import { getSetting, SettingKeys } from "../lib/settings.js";
import { ratePerformance } from "../ai/rate.js";
import { generatePdf } from "../pdf/generate.js";
import { pipelineSendDocument } from "../routes/whatsapp.js";
import { formatSplynxComment, formatWhatsAppCaption } from "../format/external.js";
import type { ExternalSummary, InternalRating } from "../types.js";

interface PhotoForPipeline {
  id: number;
  filename: string;
  filePath: string;
  width: number;
  height: number;
}

export interface PipelineResult {
  status: "success" | "partial" | "failed";
  summary: ExternalSummary | null;
  splynxCommentId: number | null;
  splynxAttachmentIds: number[];
  pdfPath: string | null;
  whatsappMessageId: string | null;
  errors: string[];
}

export interface PipelineArgs {
  config: AppConfig;
  db: Database.Database;
  log: FastifyBaseLogger;
  submissionId: number;
  taskId: number;
  splynxAdminId: number;
  appLogin: string;
  comment: string;
  /**
   * Free-text "stock used" the tech types alongside the regular Notes.
   * Already stored verbatim on the submission row by the submit handler;
   * we forward it here so the AI can roll it into the materials array
   * with codes preserved. Empty string when the tech didn't fill it.
   */
  stockNotes?: string;
  /**
   * Optional Zoom-billable job_type override sent by an allowlisted
   * tech via the Zoom-billable picker on the submit form. When set,
   * replaces summary.job_type after the AI summary lands. Permission
   * is verified by the submit handler before reaching here.
   */
  zoomBillableOverride?: string | null;
  /**
   * Optional override for the "submitted at" timestamp used in the
   * WhatsApp caption and PDF footer. Used by the manual-submission
   * path when an admin backdates an entry; the submissions row's
   * created_at column is set separately. Defaults to `new Date()`.
   */
  submittedAtOverride?: Date;
  /**
   * Optional overrides for the Job Start / End times on the Overview
   * block. Each is "HH:MM" 24h (already normalised by the manual
   * submit endpoint). When non-empty, replaces what the AI extracted
   * from job-card photos AFTER the AI returns but BEFORE the summary
   * is persisted. If both are present, job_duration is recomputed.
   */
  overviewTimeOverride?: { start?: string; end?: string };
  photos: PhotoForPipeline[];
  task: SplynxTaskRaw;
}

/**
 * Run the post-storage submission pipeline.
 *
 *   1. Claude vision → ExternalSummary  (REQUIRED — pipeline aborts if this fails)
 *   2. pdfkit  → PDF buffer
 *   3. Splynx: comment + PDF attached (single multipart call)
 *   4. Splynx: photos as direct task attachments (best-effort)
 *
 * Failures in step 3 or 4 are recorded in the `errors` array and the
 * submission is flagged as `partial`. The PDF is always saved to disk so
 * the admin retry-from-cache flow in Phase D can reuse it.
 *
 * WhatsApp send is intentionally NOT here yet — that ships in Phase C2 with
 * the Baileys QR onboarding UX.
 */
export async function runSubmissionPipeline(args: PipelineArgs): Promise<PipelineResult> {
  const { config, db, log, submissionId, taskId, splynxAdminId, appLogin, comment, photos, task } = args;
  const stockNotes = args.stockNotes ?? "";
  const errors: string[] = [];
  let summary: ExternalSummary | null = null;
  let pdfPath: string | null = null;
  let splynxCommentId: number | null = null;
  let whatsappMessageId: string | null = null;
  const splynxAttachmentIds: number[] = [];

  // Load any secondary-tech names attached to this submission. The
  // submit handler has already validated that each id is active before
  // inserting into the join table, so a non-empty result here is safe to
  // forward into every downstream output (AI prompt, formatters, PDF).
  const secondaryTechNames = db
    .prepare(
      `SELECT st.name
       FROM submission_secondary_techs sst
       JOIN secondary_techs st ON st.id = sst.secondary_tech_id
       WHERE sst.submission_id = ?
       ORDER BY st.name COLLATE NOCASE ASC`,
    )
    .all(submissionId)
    .map((r) => (r as { name: string }).name);

  // Load processed photo bytes from the local archive (Phase B saved them).
  const photoData = await Promise.all(
    photos.map(async (p) => ({
      id: p.id,
      filename: p.filename,
      buffer: await fs.readFile(p.filePath),
      width: p.width,
      height: p.height,
    })),
  );

  // ---- 1. AI summary + rating in parallel ----
  // Rating is admin-only and never leaves the system. Running in parallel
  // means the user-facing latency tracks summary alone, not summary+rating.
  log.info({ submissionId, photoCount: photoData.length }, "calling Claude (summarize + rate)");
  const requirementsCheckEnabled =
    getSetting(db, SettingKeys.requirementsCheckEnabled) === "1";
  const [summaryResult, ratingResult] = await Promise.allSettled([
    summarize({
      config,
      task,
      comment,
      stockNotes,
      photoBuffers: photoData.map((p) => p.buffer),
      techName: appLogin,
      secondaryTechNames,
      requirementsCheckEnabled,
    }),
    ratePerformance({
      config,
      db,
      task,
      comment,
      photoBuffers: photoData.map((p) => p.buffer),
      techName: appLogin,
    }),
  ]);

  if (summaryResult.status === "rejected") {
    const msg = summaryResult.reason instanceof Error ? summaryResult.reason.message : String(summaryResult.reason);
    log.error({ err: summaryResult.reason }, "summarize failed");
    errors.push(`AI summary failed: ${msg}`);
    db.prepare(
      `UPDATE submissions SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`,
    ).run(errors.join("\n"), Date.now(), submissionId);
    return {
      status: "failed",
      summary: null,
      splynxCommentId: null,
      splynxAttachmentIds: [],
      pdfPath: null,
      whatsappMessageId: null,
      errors,
    };
  }
  summary = summaryResult.value.summary;
  const requirementsCheck = summaryResult.value.requirementsCheck;

  // Tech-supplied Zoom-billable override replaces the AI's job_type
  // classification before anything downstream sees it. The submit
  // handler has already gated permission (tech.zoom_billable = 1),
  // so reaching here means the override is legitimate.
  if (args.zoomBillableOverride) {
    log.info(
      { submissionId, aiJobType: summary.job_type, override: args.zoomBillableOverride },
      "applying zoom-billable job_type override",
    );
    summary.job_type = args.zoomBillableOverride as typeof summary.job_type;
  }

  // Admin-supplied Overview time override (Manual entry only). Replaces
  // what the AI extracted from job-card photos with the times the admin
  // typed in, so the Splynx comment / PDF / WhatsApp overview reflect
  // the real on-site times. Both ends → recompute job_duration.
  if (args.overviewTimeOverride?.start || args.overviewTimeOverride?.end) {
    const startOverride = args.overviewTimeOverride.start ?? "";
    const endOverride = args.overviewTimeOverride.end ?? "";
    if (startOverride) summary.overview.job_start_time = startOverride;
    if (endOverride) summary.overview.job_end_time = endOverride;
    if (startOverride && endOverride) {
      summary.overview.job_duration = computeDurationLabel(startOverride, endOverride);
    }
    log.info(
      { submissionId, start: startOverride, end: endOverride },
      "applying overview-time override",
    );
  }

  db.prepare(`UPDATE submissions SET summary_json = ?, updated_at = ? WHERE id = ?`).run(
    JSON.stringify(summary),
    Date.now(),
    submissionId,
  );
  if (requirementsCheck) {
    // Persist admin-only requirements-coverage data. Stored as JSON in
    // its own column so the formatters (which only read summary_json)
    // can never accidentally pull it into external output.
    db.prepare(
      `UPDATE submissions SET requirements_check_json = ?, updated_at = ? WHERE id = ?`,
    ).run(JSON.stringify(requirementsCheck), Date.now(), submissionId);
    log.info(
      { submissionId, items: requirementsCheck.items.length },
      "requirements check saved",
    );
  }
  log.info({ submissionId, headline: summary.headline }, "summary saved");

  // Rating: failure is non-fatal — we still want the submission to land
  // even if the rating model errors. Stored only in submission_ratings.
  if (ratingResult.status === "fulfilled") {
    persistRating(db, submissionId, ratingResult.value);
    log.info({ submissionId, score: ratingResult.value.score }, "rating saved");
  } else {
    const msg = ratingResult.reason instanceof Error ? ratingResult.reason.message : String(ratingResult.reason);
    log.warn({ err: ratingResult.reason }, "rating failed (non-fatal)");
    errors.push(`Rating failed (non-fatal): ${msg}`);
  }

  // ---- 2. PDF ----
  let pdfBuffer: Buffer | null = null;
  try {
    log.info({ submissionId }, "generating PDF");
    pdfBuffer = await generatePdf({
      task,
      summary,
      comment,
      photos: photoData.map(({ buffer, width, height }) => ({ buffer, width, height })),
      techName: appLogin,
      submittedAt: args.submittedAtOverride ?? new Date(),
      secondaryTechNames,
    });
    const pdfDir = path.join(config.DATA_DIR, "photos", String(taskId), String(submissionId));
    await fs.mkdir(pdfDir, { recursive: true });
    pdfPath = path.join(pdfDir, "report.pdf");
    await fs.writeFile(pdfPath, pdfBuffer);
    log.info({ submissionId, pdfBytes: pdfBuffer.length }, "PDF written");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err }, "PDF generation failed");
    errors.push(`PDF generation failed: ${msg}`);
    pdfBuffer = null;
  }

  // ---- 3. Splynx: comment + PDF attached ----
  if (pdfBuffer) {
    try {
      const splynx = getServiceSplynxClient(config);
      const commentBody = formatSplynxComment(
        summary,
        appLogin,
        false,
        secondaryTechNames,
        stockNotes,
      );
      const pdfFilename = `task-${taskId}-submission-${submissionId}.pdf`;
      const result = await splynx.addTaskComment(taskId, splynxAdminId, commentBody, [
        { buffer: pdfBuffer, filename: pdfFilename, mimetype: "application/pdf" },
      ]);
      splynxCommentId = result.id;
      db.prepare(
        `UPDATE submissions SET splynx_comment_id = ?, updated_at = ? WHERE id = ?`,
      ).run(splynxCommentId, Date.now(), submissionId);
      log.info({ submissionId, splynxCommentId }, "Splynx comment posted");
    } catch (err) {
      const e = err as { response?: { status?: number; data?: unknown }; message?: string };
      log.error({ err: e }, "Splynx comment post failed");
      errors.push(
        `Splynx comment failed (${e.response?.status ?? "?"}): ${e.message ?? "unknown error"}`,
      );
    }
  }

  // Photos used to be uploaded to the Splynx Attachments tab here, but the
  // PDF report's Section 6 already includes the full photo grid, so the
  // separate per-photo upload was duplicate work and clutter. Photos are
  // still kept in the local archive (data/photos/) and accessible from the
  // admin UI; only the Splynx-side per-photo attach step was dropped.

  // ---- 4. WhatsApp: send caption + PDF to the configured group ----
  // Fetch the Splynx customer login (e.g. "ANJA001") so the WhatsApp caption
  // can show the account code on the team's group view. Failure is non-fatal:
  // a missing customer record or a Splynx hiccup just suppresses the Account
  // bullet, it doesn't block the WhatsApp send.
  let customerLogin: string | null = null;
  if (task.related_customer_id) {
    try {
      const splynx = getServiceSplynxClient(config);
      const customer = await splynx.getCustomer(task.related_customer_id);
      customerLogin = customer.login || null;
    } catch (err) {
      log.warn({ err, customerId: task.related_customer_id }, "customer lookup failed (non-fatal)");
    }
  }

  if (pdfBuffer && summary) {
    try {
      log.info(
        { submissionId, techName: appLogin, customerLogin },
        "WhatsApp caption inputs",
      );
      const caption = formatWhatsAppCaption(
        summary,
        task,
        appLogin,
        config.SPLYNX_BASE_URL,
        customerLogin,
        // Pipeline runs immediately after the submission row is inserted,
        // so "now" tracks submission.created_at within ~1s — close enough
        // for an HH:MM display. Manual submissions pass an explicit
        // override (the backdated timestamp the admin picked) so the
        // caption reflects when the work actually happened.
        args.submittedAtOverride ?? new Date(),
        secondaryTechNames,
      );
      const fileName = `task-${taskId}-submission-${submissionId}.pdf`;
      const result = await pipelineSendDocument({
        config,
        caption,
        pdfBuffer,
        fileName,
      });
      if (!result) {
        log.info({ submissionId }, "WhatsApp send skipped — no group configured");
        // Not an error — group selection is optional.
      } else {
        whatsappMessageId = result.messageId;
        if (whatsappMessageId) {
          db.prepare(
            `UPDATE submissions SET wa_message_id = ?, updated_at = ? WHERE id = ?`,
          ).run(whatsappMessageId, Date.now(), submissionId);
        }
        log.info({ submissionId, jid: result.jid, whatsappMessageId }, "WhatsApp sent");
      }

      // Second delivery for Zoom-billable submissions (Fibre Install /
      // ONT Drop / Zoom Reinstall). Same caption + PDF, sent to the
      // separately-configured zoom group. Non-fatal on either front:
      // if the zoom group isn't configured we log a warning and move on
      // (per operator's soft-fallback preference); if it is configured
      // but the send fails, we push to errors so the submission lands
      // as "partial" and the operator can retry via resend-WhatsApp.
      const isZoomBillable = summary.job_type.startsWith("zoom_");
      if (isZoomBillable) {
        const zoomJid = getSetting(db, SettingKeys.whatsappZoomGroupJid);
        if (!zoomJid) {
          log.warn(
            { submissionId, jobType: summary.job_type },
            "Zoom-billable submission but no zoom group configured — skipping second send",
          );
        } else {
          try {
            const zoomResult = await pipelineSendDocument({
              config,
              caption,
              pdfBuffer,
              fileName,
              jidOverride: zoomJid,
            });
            log.info(
              {
                submissionId,
                jid: zoomJid,
                zoomMessageId: zoomResult?.messageId ?? null,
              },
              "WhatsApp sent to Zoom group",
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.error({ err, jid: zoomJid }, "Zoom-group WhatsApp send failed");
            errors.push(`Zoom-group WhatsApp send failed: ${msg}`);
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err }, "WhatsApp send failed");
      errors.push(`WhatsApp send failed: ${msg}`);
    }
  }

  const status: PipelineResult["status"] = errors.length === 0 ? "success" : "partial";
  db.prepare(
    `UPDATE submissions SET status = ?, error = ?, updated_at = ? WHERE id = ?`,
  ).run(status, errors.length ? errors.join("\n") : null, Date.now(), submissionId);

  return {
    status,
    summary,
    splynxCommentId,
    splynxAttachmentIds,
    pdfPath,
    whatsappMessageId,
    errors,
  };
}

/**
 * Compute a "Xh Ymin" / "Xh" / "Ymin" duration label from two
 * "HH:MM" times. Both inputs are assumed already normalised by the
 * Manual entry handler. Crossing midnight is treated as the end
 * being on the next day. Returns "" on malformed input — caller
 * will leave job_duration as whatever the AI produced.
 */
function computeDurationLabel(startHHMM: string, endHHMM: string): string {
  const parse = (s: string): number | null => {
    const m = /^(\d{2}):(\d{2})$/.exec(s);
    if (!m) return null;
    const h = Number(m[1]);
    const mm = Number(m[2]);
    if (!Number.isFinite(h) || !Number.isFinite(mm)) return null;
    return h * 60 + mm;
  };
  const s = parse(startHHMM);
  const e = parse(endHHMM);
  if (s === null || e === null) return "";
  let diff = e - s;
  if (diff < 0) diff += 24 * 60; // crossed midnight
  if (diff === 0) return "0min";
  const hours = Math.floor(diff / 60);
  const mins = diff % 60;
  if (hours === 0) return `${mins}min`;
  if (mins === 0) return `${hours}h`;
  return `${hours}h ${mins}min`;
}

function persistRating(
  db: Database.Database,
  submissionId: number,
  rating: InternalRating,
): void {
  const now = Date.now();
  // ai_rationale stays NOT NULL — write empty string for the new bullet-
  // shaped ratings. Legacy paragraph rationales on older submissions are
  // preserved as-is (UI shows them under a "Notes (legacy)" fallback).
  db.prepare(
    `INSERT INTO submission_ratings
       (submission_id, ai_score, ai_rationale, ai_dimensions_json,
        ai_strengths_json, ai_improvements_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(submission_id) DO UPDATE SET
       ai_score = excluded.ai_score,
       ai_rationale = excluded.ai_rationale,
       ai_dimensions_json = excluded.ai_dimensions_json,
       ai_strengths_json = excluded.ai_strengths_json,
       ai_improvements_json = excluded.ai_improvements_json,
       updated_at = excluded.updated_at`,
  ).run(
    submissionId,
    rating.score,
    "",
    JSON.stringify(rating.dimensions),
    JSON.stringify(rating.strengths),
    JSON.stringify(rating.improvements),
    now,
    now,
  );
}


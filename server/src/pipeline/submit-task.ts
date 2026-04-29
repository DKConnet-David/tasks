import fs from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3";
import type { FastifyBaseLogger } from "fastify";
import type { AppConfig } from "../config.js";
import type { SplynxTaskRaw } from "../splynx/types.js";
import { getServiceSplynxClient } from "../splynx/service-client.js";
import { summarize } from "../ai/summarize.js";
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
  const errors: string[] = [];
  let summary: ExternalSummary | null = null;
  let pdfPath: string | null = null;
  let splynxCommentId: number | null = null;
  let whatsappMessageId: string | null = null;
  const splynxAttachmentIds: number[] = [];

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
  const [summaryResult, ratingResult] = await Promise.allSettled([
    summarize({
      config,
      task,
      comment,
      photoBuffers: photoData.map((p) => p.buffer),
      techName: appLogin,
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
  summary = summaryResult.value;
  db.prepare(`UPDATE submissions SET summary_json = ?, updated_at = ? WHERE id = ?`).run(
    JSON.stringify(summary),
    Date.now(),
    submissionId,
  );
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
      submittedAt: new Date(),
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
      const commentBody = formatSplynxComment(summary, appLogin, false);
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

  // ---- 4. Splynx: photos as task attachments ----
  if (photoData.length > 0) {
    try {
      const splynx = getServiceSplynxClient(config);
      const descriptions = summary.photo_descriptions ?? [];
      const result = await splynx.addTaskAttachments(
        taskId,
        splynxAdminId,
        photoData.map((p, i) => ({
          buffer: p.buffer,
          filename: photoFilename(i, descriptions[i]),
          mimetype: "image/jpeg",
        })),
      );
      splynxAttachmentIds.push(...result.files);

      // Map per-photo splynx ids back to submission_photos rows so the admin
      // UI can show "uploaded to Splynx as #N". The order returned by Splynx
      // matches the multipart upload order.
      const updatePhoto = db.prepare(
        `UPDATE submission_photos SET splynx_file_id = ? WHERE id = ?`,
      );
      for (let i = 0; i < photoData.length; i++) {
        const fileId = result.files[i];
        const photo = photoData[i];
        if (fileId === undefined || photo === undefined) continue;
        updatePhoto.run(fileId, photo.id);
      }
      log.info(
        { submissionId, count: result.files.length },
        "Splynx photo attachments uploaded",
      );
    } catch (err) {
      const e = err as { response?: { status?: number }; message?: string };
      log.error({ err: e }, "Splynx photo upload failed");
      errors.push(
        `Splynx photo upload failed (${e.response?.status ?? "?"}): ${e.message ?? "unknown error"}`,
      );
    }
  }

  // ---- 5. WhatsApp: send caption + PDF to the configured group ----
  if (pdfBuffer && summary) {
    try {
      const caption = formatWhatsAppCaption(summary, task, appLogin);
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
 * Build a Splynx attachment filename from the AI's photo description.
 * Picks whole words up to a 60-char budget so we never end mid-word.
 *
 *   "Network speed test showing 64.90 Mbps download" + idx 0
 *     -> "01-network-speed-test-showing-6490-mbps-download.jpg"
 *   undefined / empty + idx 4
 *     -> "05-photo.jpg"
 */
function photoFilename(index: number, description: string | undefined): string {
  const num = String(index + 1).padStart(2, "0");
  const cleanWords = (description ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{Letter}\p{Number}]/gu, ""))
    .filter(Boolean);

  const picked: string[] = [];
  let len = 0;
  for (const word of cleanWords) {
    if (picked.length > 0 && len + word.length + 1 > 60) break;
    picked.push(word);
    len += word.length + (picked.length > 0 ? 1 : 0);
  }
  const slug = picked.join("-");
  return slug ? `${num}-${slug}.jpg` : `${num}-photo.jpg`;
}

function persistRating(
  db: Database.Database,
  submissionId: number,
  rating: InternalRating,
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO submission_ratings
       (submission_id, ai_score, ai_rationale, ai_dimensions_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(submission_id) DO UPDATE SET
       ai_score = excluded.ai_score,
       ai_rationale = excluded.ai_rationale,
       ai_dimensions_json = excluded.ai_dimensions_json,
       updated_at = excluded.updated_at`,
  ).run(
    submissionId,
    rating.score,
    rating.rationale,
    JSON.stringify(rating.dimensions),
    now,
    now,
  );
}


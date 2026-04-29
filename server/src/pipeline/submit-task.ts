import fs from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3";
import type { FastifyBaseLogger } from "fastify";
import type { AppConfig } from "../config.js";
import type { SplynxTaskRaw } from "../splynx/types.js";
import { getServiceSplynxClient } from "../splynx/service-client.js";
import { summarize } from "../ai/summarize.js";
import { generatePdf } from "../pdf/generate.js";
import type { ExternalSummary } from "../types.js";

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

  // ---- 1. AI summary ----
  try {
    log.info({ submissionId, photoCount: photoData.length }, "calling Claude.summarize");
    summary = await summarize({
      config,
      task,
      comment,
      photoBuffers: photoData.map((p) => p.buffer),
      techName: appLogin,
    });
    db.prepare(`UPDATE submissions SET summary_json = ?, updated_at = ? WHERE id = ?`).run(
      JSON.stringify(summary),
      Date.now(),
      submissionId,
    );
    log.info({ submissionId, headline: summary.headline }, "summary saved");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err }, "summarize failed");
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
      errors,
    };
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
      const commentBody = formatSplynxComment(summary, appLogin);
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
      const result = await splynx.addTaskAttachments(
        taskId,
        splynxAdminId,
        photoData.map((p, i) => ({
          buffer: p.buffer,
          filename: `task-${taskId}-${submissionId}-photo-${i + 1}.jpg`,
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

  const status: PipelineResult["status"] = errors.length === 0 ? "success" : "partial";
  db.prepare(
    `UPDATE submissions SET status = ?, error = ?, updated_at = ? WHERE id = ?`,
  ).run(status, errors.length ? errors.join("\n") : null, Date.now(), submissionId);

  return { status, summary, splynxCommentId, splynxAttachmentIds, pdfPath, errors };
}

function formatSplynxComment(summary: ExternalSummary, techName: string): string {
  const parts: string[] = [];
  parts.push(`<strong>${escapeHtml(summary.headline)}</strong>`);
  parts.push(`<br><em>Submitted by ${escapeHtml(techName)} via Task Updater</em>`);
  parts.push("<br><br>");
  parts.push(`<strong>What was done</strong><br>${nl2br(escapeHtml(summary.what_was_done))}`);
  if (summary.observations.trim()) {
    parts.push("<br><br>");
    parts.push(`<strong>Observations</strong><br>${nl2br(escapeHtml(summary.observations))}`);
  }
  if (summary.follow_ups.trim()) {
    parts.push("<br><br>");
    parts.push(`<strong>Follow-ups</strong><br>${nl2br(escapeHtml(summary.follow_ups))}`);
  }
  return parts.join("");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function nl2br(s: string): string {
  return s.replace(/\n/g, "<br>");
}

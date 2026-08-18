import fs from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3";
import type { FastifyBaseLogger } from "fastify";
import type { AppConfig } from "../config.js";
import { getServiceSplynxClient } from "../splynx/service-client.js";
import { getSetting, SettingKeys } from "../lib/settings.js";
import { generateAmendmentPdf } from "../pdf/generate.js";
import { pipelineSendDocument } from "../routes/whatsapp.js";
import {
  formatSplynxAmendmentComment,
  formatWhatsAppAmendmentCaption,
} from "../format/external.js";
import type { ExternalSummary } from "../types.js";

export interface AmendmentPipelineResult {
  status: "success" | "partial" | "failed";
  splynxCommentId: number | null;
  waMessageId: string | null;
  waZoomMessageId: string | null;
  pdfPath: string | null;
  errors: string[];
}

export interface AmendmentPipelineArgs {
  config: AppConfig;
  db: Database.Database;
  log: FastifyBaseLogger;
  submissionId: number;
  amendmentId: number;
}

interface AmendmentPhotoRow {
  id: number;
  filename: string;
  width: number;
  height: number;
}

/**
 * Run the amendment pipeline: generate a small PDF, post a fresh Splynx
 * comment on the original task, and fire the same WhatsApp dual-send the
 * primary pipeline uses (primary group + Zoom group when the original
 * was Zoom-billable).
 *
 * Deliberately does NOT call Claude — amendments are the tech's verbatim
 * followup. No summarize, no rate, no requirements check. Matches the
 * design decision locked with the operator (saves tokens, preserves the
 * tech's exact words).
 */
export async function runAmendmentPipeline(
  args: AmendmentPipelineArgs,
): Promise<AmendmentPipelineResult> {
  const { config, db, log, submissionId, amendmentId } = args;
  const errors: string[] = [];

  const submission = db
    .prepare(
      `SELECT id, task_id, app_login, splynx_admin_id, summary_json,
              splynx_comment_id, created_at
       FROM submissions WHERE id = ?`,
    )
    .get(submissionId) as
    | {
        id: number;
        task_id: number;
        app_login: string;
        splynx_admin_id: number;
        summary_json: string | null;
        splynx_comment_id: number | null;
        created_at: number;
      }
    | undefined;
  if (!submission) throw new Error(`submission ${submissionId} not found`);

  const amendment = db
    .prepare(
      `SELECT id, comment, actor_login, created_at
       FROM submission_amendments WHERE id = ?`,
    )
    .get(amendmentId) as
    | { id: number; comment: string; actor_login: string; created_at: number }
    | undefined;
  if (!amendment) throw new Error(`amendment ${amendmentId} not found`);

  const photoRows = db
    .prepare(
      `SELECT id, filename, width, height
       FROM submission_photos
       WHERE submission_id = ? AND amendment_id = ?
       ORDER BY id ASC`,
    )
    .all(submissionId, amendmentId) as AmendmentPhotoRow[];

  const photoBuffers = await Promise.all(
    photoRows.map(async (p) => ({
      buffer: await fs.readFile(
        path.join(config.DATA_DIR, "photos", String(submission.task_id), String(submissionId), p.filename),
      ),
      width: p.width,
      height: p.height,
    })),
  );

  // Re-fetch task from Splynx so title/address/customer are current.
  // Failure here is non-fatal — we can still send a barebones caption.
  const splynx = getServiceSplynxClient(config);
  let taskTitle = "";
  let taskAddress = "";
  let customerLogin: string | null = null;
  try {
    const task = await splynx.getTaskRaw(submission.task_id);
    taskTitle = task.title ?? "";
    taskAddress = task.address ?? "";
    if (task.related_customer_id) {
      try {
        const customer = await splynx.getCustomer(task.related_customer_id);
        customerLogin = customer.login || null;
      } catch (err) {
        log.warn({ err, customerId: task.related_customer_id }, "customer lookup failed (non-fatal)");
      }
    }
  } catch (err) {
    log.warn({ err, taskId: submission.task_id }, "task refetch failed for amendment (non-fatal)");
  }

  // ---- 1. Build the amendment PDF ----
  let pdfBuffer: Buffer | null = null;
  let pdfPath: string | null = null;
  try {
    pdfBuffer = await generateAmendmentPdf({
      taskId: submission.task_id,
      taskAddress,
      originalSubmissionId: submissionId,
      originalSubmittedAt: new Date(submission.created_at),
      amendmentAddedAt: new Date(amendment.created_at),
      amendmentComment: amendment.comment,
      techName: amendment.actor_login,
      photos: photoBuffers,
    });
    const pdfDir = path.join(
      config.DATA_DIR,
      "photos",
      String(submission.task_id),
      String(submissionId),
    );
    await fs.mkdir(pdfDir, { recursive: true });
    pdfPath = path.join(pdfDir, "report-amendment.pdf");
    await fs.writeFile(pdfPath, pdfBuffer);
    db.prepare(
      `UPDATE submission_amendments SET pdf_path = ?, updated_at = ? WHERE id = ?`,
    ).run(pdfPath, Date.now(), amendmentId);
    log.info({ amendmentId, pdfBytes: pdfBuffer.length }, "amendment PDF written");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err }, "amendment PDF generation failed");
    errors.push(`PDF generation failed: ${msg}`);
  }

  // ---- 2. Splynx: fresh comment on the original task ----
  let splynxCommentId: number | null = null;
  if (pdfBuffer) {
    try {
      const commentBody = formatSplynxAmendmentComment({
        amendmentComment: amendment.comment,
        techName: amendment.actor_login,
        originalCommentId: submission.splynx_comment_id,
        originalSubmittedAt: new Date(submission.created_at),
        amendmentAddedAt: new Date(amendment.created_at),
      });
      const pdfFilename = `task-${submission.task_id}-submission-${submissionId}-amendment.pdf`;
      const result = await splynx.addTaskComment(
        submission.task_id,
        submission.splynx_admin_id,
        commentBody,
        [{ buffer: pdfBuffer, filename: pdfFilename, mimetype: "application/pdf" }],
      );
      splynxCommentId = result.id;
      db.prepare(
        `UPDATE submission_amendments SET splynx_comment_id = ?, updated_at = ? WHERE id = ?`,
      ).run(splynxCommentId, Date.now(), amendmentId);
      log.info({ amendmentId, splynxCommentId }, "Splynx amendment comment posted");
    } catch (err) {
      const e = err as { response?: { status?: number }; message?: string };
      log.error({ err: e }, "Splynx amendment comment failed");
      errors.push(
        `Splynx amendment comment failed (${e.response?.status ?? "?"}): ${e.message ?? "unknown error"}`,
      );
    }
  }

  // ---- 3. WhatsApp: primary + Zoom dual-send ----
  let waMessageId: string | null = null;
  let waZoomMessageId: string | null = null;
  if (pdfBuffer) {
    const caption = formatWhatsAppAmendmentCaption({
      taskId: submission.task_id,
      taskTitle,
      taskAddress,
      techName: amendment.actor_login,
      originalSubmittedAt: new Date(submission.created_at),
      amendmentAddedAt: new Date(amendment.created_at),
      amendmentComment: amendment.comment,
      splynxBaseUrl: config.SPLYNX_BASE_URL,
      customerLogin,
    });
    const fileName = `task-${submission.task_id}-submission-${submissionId}-amendment.pdf`;

    try {
      const result = await pipelineSendDocument({
        config,
        caption,
        pdfBuffer,
        fileName,
      });
      if (!result) {
        log.info({ amendmentId }, "amendment WhatsApp send skipped — no primary group configured");
      } else {
        waMessageId = result.messageId;
        if (waMessageId) {
          db.prepare(
            `UPDATE submission_amendments SET wa_message_id = ?, updated_at = ? WHERE id = ?`,
          ).run(waMessageId, Date.now(), amendmentId);
        }
        log.info({ amendmentId, jid: result.jid, waMessageId }, "amendment WhatsApp sent");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err }, "amendment WhatsApp send failed");
      errors.push(`WhatsApp send failed: ${msg}`);
    }

    // Zoom dual-send: mirror the primary pipeline's rule — if the parent
    // submission's job_type starts with "zoom_", also post to the zoom
    // group. Missing zoom group config is a soft skip (log-only). Send
    // failure with a configured group pushes to errors → partial status.
    const parsedSummary = safeParseSummary(submission.summary_json);
    if (parsedSummary && parsedSummary.job_type.startsWith("zoom_")) {
      const zoomJid = getSetting(db, SettingKeys.whatsappZoomGroupJid);
      if (!zoomJid) {
        log.warn(
          { amendmentId, jobType: parsedSummary.job_type },
          "Zoom-billable amendment but no zoom group configured — skipping second send",
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
          waZoomMessageId = zoomResult?.messageId ?? null;
          if (waZoomMessageId) {
            db.prepare(
              `UPDATE submission_amendments SET wa_zoom_message_id = ?, updated_at = ? WHERE id = ?`,
            ).run(waZoomMessageId, Date.now(), amendmentId);
          }
          log.info(
            { amendmentId, jid: zoomJid, waZoomMessageId },
            "amendment WhatsApp sent to Zoom group",
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error({ err, jid: zoomJid }, "amendment Zoom-group WhatsApp send failed");
          errors.push(`Zoom-group WhatsApp send failed: ${msg}`);
        }
      }
    }
  }

  const status: AmendmentPipelineResult["status"] = pdfBuffer
    ? errors.length === 0
      ? "success"
      : "partial"
    : "failed";
  db.prepare(
    `UPDATE submission_amendments SET status = ?, error = ?, updated_at = ? WHERE id = ?`,
  ).run(status, errors.length ? errors.join("\n") : null, Date.now(), amendmentId);

  return {
    status,
    splynxCommentId,
    waMessageId,
    waZoomMessageId,
    pdfPath,
    errors,
  };
}

function safeParseSummary(json: string | null): ExternalSummary | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as ExternalSummary;
    if (typeof parsed?.job_type === "string") return parsed;
    return null;
  } catch {
    return null;
  }
}

import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { makeAuthGuards } from "../lib/auth-guards.js";
import { getServiceSplynxClient, isSplynxConfigured } from "../splynx/service-client.js";
import { getDb } from "../db.js";
import type { AppConfig } from "../config.js";
import { ExternalSummarySchema, RatingDimensionsSchema } from "../types.js";
import { summarize } from "../ai/summarize.js";
import { generatePdf } from "../pdf/generate.js";
import { pipelineSendDocument } from "./whatsapp.js";
import { photoPath, processAndSavePhoto, type SourcePhoto } from "../photos/store.js";
import { runSubmissionPipeline } from "../pipeline/submit-task.js";
import { formatSplynxComment, formatWhatsAppCaption } from "../format/external.js";

const ListQuery = z.object({
  status: z.enum(["pending", "success", "partial", "failed"]).optional(),
  login: z.string().optional(),
  q: z.string().optional(),
  cursor: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export async function registerAdminRoutes(app: FastifyInstance, config: AppConfig): Promise<void> {
  const { requireAdmin } = makeAuthGuards(config);
  const db = getDb(config.DATA_DIR);

  // ---------- LIST ----------
  app.get("/admin/submissions", { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_query" });
    const { status, login, q, cursor, limit } = parsed.data;

    const wheres: string[] = [];
    const params: unknown[] = [];
    if (status) {
      wheres.push("status = ?");
      params.push(status);
    }
    if (login) {
      wheres.push("app_login = ?");
      params.push(login);
    }
    if (q) {
      wheres.push("(comment LIKE ? OR summary_json LIKE ? OR CAST(task_id AS TEXT) LIKE ?)");
      const needle = `%${q}%`;
      params.push(needle, needle, needle);
    }
    if (cursor) {
      wheres.push("id < ?");
      params.push(cursor);
    }
    const where = wheres.length ? `WHERE ${wheres.join(" AND ")}` : "";

    const rows = db
      .prepare(
        `SELECT s.id, s.task_id, s.app_login, s.source, s.comment, s.summary_json,
                s.splynx_comment_id, s.wa_message_id, s.status, s.admin_resolved,
                s.created_at, s.updated_at,
                r.ai_score, r.admin_score
         FROM submissions s
         LEFT JOIN submission_ratings r ON r.submission_id = s.id
         ${where}
         ORDER BY s.id DESC
         LIMIT ?`,
      )
      .all(...params, limit) as Array<{
      id: number;
      task_id: number;
      app_login: string;
      source: string;
      comment: string | null;
      summary_json: string | null;
      splynx_comment_id: number | null;
      wa_message_id: string | null;
      status: string;
      admin_resolved: number;
      created_at: number;
      updated_at: number;
      ai_score: number | null;
      admin_score: number | null;
    }>;

    const items = rows.map((r) => ({
      id: r.id,
      task_id: r.task_id,
      app_login: r.app_login,
      source: r.source,
      headline: r.summary_json
        ? (safeParse(r.summary_json) as { headline?: string } | null)?.headline ?? null
        : null,
      splynx_comment_id: r.splynx_comment_id,
      wa_message_id: r.wa_message_id,
      status: r.status,
      admin_resolved: r.admin_resolved === 1,
      created_at: r.created_at,
      ai_score: r.ai_score,
      admin_score: r.admin_score,
    }));

    const nextCursor = rows.length === limit ? rows[rows.length - 1]!.id : null;
    return { items, next_cursor: nextCursor };
  });

  // ---------- DETAIL ----------
  app.get("/admin/submissions/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const id = parseId((req.params as { id: string }).id);
    if (id === null) return reply.code(400).send({ error: "invalid_id" });

    const sub = db
      .prepare(
        `SELECT id, task_id, app_login, splynx_admin_id, source, comment, tech_comment_override,
                summary_json, corrected_summary_json, splynx_comment_id, splynx_corrected_comment_id,
                splynx_pdf_file_id, wa_message_id, status, error, admin_resolved,
                created_at, updated_at
         FROM submissions WHERE id = ?`,
      )
      .get(id) as
      | {
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
          splynx_pdf_file_id: number | null;
          wa_message_id: string | null;
          status: string;
          error: string | null;
          admin_resolved: number;
          created_at: number;
          updated_at: number;
        }
      | undefined;
    if (!sub) return reply.code(404).send({ error: "not_found" });

    const photos = db
      .prepare(
        `SELECT id, filename, size_bytes, width, height, splynx_file_id
         FROM submission_photos WHERE submission_id = ? ORDER BY id ASC`,
      )
      .all(id) as Array<{
      id: number;
      filename: string;
      size_bytes: number;
      width: number;
      height: number;
      splynx_file_id: number | null;
    }>;

    const actions = db
      .prepare(
        `SELECT id, action, details_json, created_at
         FROM admin_actions WHERE submission_id = ? ORDER BY id DESC LIMIT 50`,
      )
      .all(id) as Array<{
      id: number;
      action: string;
      details_json: string | null;
      created_at: number;
    }>;

    return { submission: { ...sub, admin_resolved: sub.admin_resolved === 1 }, photos, actions };
  });

  // ---------- EDIT AI SUMMARY (pushes to Splynx via PUT comment) ----------
  app.patch("/admin/submissions/:id/summary", { preHandler: requireAdmin }, async (req, reply) => {
    const id = parseId((req.params as { id: string }).id);
    if (id === null) return reply.code(400).send({ error: "invalid_id" });
    const parsed = ExternalSummarySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_summary" });
    const sub = loadSubmission(db, id);
    if (!sub) return reply.code(404).send({ error: "not_found" });

    db.prepare(
      `UPDATE submissions SET corrected_summary_json = ?, updated_at = ? WHERE id = ?`,
    ).run(JSON.stringify(parsed.data), Date.now(), id);

    let pushedToSplynx = false;
    let pushError: string | null = null;
    if (sub.splynx_comment_id && isSplynxConfigured(config)) {
      try {
        const splynx = getServiceSplynxClient(config);
        const body = formatSplynxComment(parsed.data, sub.app_login, true);
        await splynx.updateTaskComment(sub.splynx_comment_id, body);
        pushedToSplynx = true;
      } catch (err) {
        pushError = err instanceof Error ? err.message : String(err);
      }
    }

    recordAdminAction(db, id, "edit_summary", { pushedToSplynx, pushError });
    return { ok: true, pushed_to_splynx: pushedToSplynx, push_error: pushError };
  });

  // ---------- EDIT TECH COMMENT (local-only) ----------
  app.patch(
    "/admin/submissions/:id/tech-comment",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = parseId((req.params as { id: string }).id);
      if (id === null) return reply.code(400).send({ error: "invalid_id" });
      const body = req.body as { tech_comment_override?: string | null };
      const value =
        typeof body?.tech_comment_override === "string" ? body.tech_comment_override.slice(0, 4000) : null;
      const sub = loadSubmission(db, id);
      if (!sub) return reply.code(404).send({ error: "not_found" });
      db.prepare(
        `UPDATE submissions SET tech_comment_override = ?, updated_at = ? WHERE id = ?`,
      ).run(value, Date.now(), id);
      recordAdminAction(db, id, "edit_tech_comment", { length: value?.length ?? 0 });
      return { ok: true };
    },
  );

  // ---------- RESEND WHATSAPP ----------
  app.post(
    "/admin/submissions/:id/resend-whatsapp",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = parseId((req.params as { id: string }).id);
      if (id === null) return reply.code(400).send({ error: "invalid_id" });
      const sub = loadSubmission(db, id);
      if (!sub) return reply.code(404).send({ error: "not_found" });
      const summary = sub.summary_json ? safeParse(sub.summary_json) : null;
      if (!summary || !isSummary(summary)) {
        return reply.code(400).send({ error: "no_summary_to_resend" });
      }
      const pdfFile = path.join(
        config.DATA_DIR,
        "photos",
        String(sub.task_id),
        String(sub.id),
        "report.pdf",
      );
      let pdfBuffer: Buffer;
      try {
        pdfBuffer = await fs.readFile(pdfFile);
      } catch {
        return reply.code(404).send({ error: "pdf_not_found" });
      }

      const task = await getServiceSplynxClient(config).getTaskRaw(sub.task_id).catch(() => null);
      const taskShape = {
        id: sub.task_id,
        title: task?.title ?? "",
        address: task?.address ?? "",
      };

      try {
        const result = await pipelineSendDocument({
          config,
          caption: formatWhatsAppCaption(summary, taskShape, sub.app_login),
          pdfBuffer,
          fileName: `task-${sub.task_id}-submission-${sub.id}.pdf`,
        });
        if (!result) return reply.code(400).send({ error: "no_group_configured" });
        if (result.messageId) {
          db.prepare(`UPDATE submissions SET wa_message_id = ?, updated_at = ? WHERE id = ?`).run(
            result.messageId,
            Date.now(),
            id,
          );
        }
        recordAdminAction(db, id, "resend_whatsapp", { messageId: result.messageId });
        return { ok: true, message_id: result.messageId };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recordAdminAction(db, id, "resend_whatsapp", { error: msg });
        return reply.code(503).send({ error: "send_failed", detail: msg });
      }
    },
  );

  // ---------- RE-ATTACH SPLYNX (PDF + photos) ----------
  app.post(
    "/admin/submissions/:id/reattach-splynx",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = parseId((req.params as { id: string }).id);
      if (id === null) return reply.code(400).send({ error: "invalid_id" });
      const sub = loadSubmission(db, id);
      if (!sub) return reply.code(404).send({ error: "not_found" });
      if (!isSplynxConfigured(config))
        return reply.code(503).send({ error: "splynx_not_configured" });

      const photos = db
        .prepare(
          `SELECT id, filename, width, height FROM submission_photos
           WHERE submission_id = ? ORDER BY id ASC`,
        )
        .all(id) as Array<{ id: number; filename: string; width: number; height: number }>;

      const splynx = getServiceSplynxClient(config);
      const errors: string[] = [];
      let commentId: number | null = null;
      let attachmentIds: number[] = [];

      // PDF
      try {
        const pdfFile = path.join(
          config.DATA_DIR,
          "photos",
          String(sub.task_id),
          String(sub.id),
          "report.pdf",
        );
        const pdfBuffer = await fs.readFile(pdfFile);
        const summary = sub.corrected_summary_json
          ? safeParse(sub.corrected_summary_json)
          : sub.summary_json
            ? safeParse(sub.summary_json)
            : null;
        if (!summary || !isSummary(summary)) throw new Error("no summary stored");
        const body = formatSplynxComment(summary, sub.app_login, !!sub.corrected_summary_json);
        const result = await splynx.addTaskComment(sub.task_id, sub.splynx_admin_id, body, [
          {
            buffer: pdfBuffer,
            filename: `task-${sub.task_id}-submission-${sub.id}-v2.pdf`,
            mimetype: "application/pdf",
          },
        ]);
        commentId = result.id;
      } catch (err) {
        errors.push(`PDF reattach failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Photos
      if (photos.length > 0) {
        try {
          const buffers = await Promise.all(
            photos.map(async (p) => ({
              buffer: await fs.readFile(
                photoPath(config.DATA_DIR, sub.task_id, sub.id, p.filename),
              ),
              filename: `task-${sub.task_id}-${sub.id}-photo-${p.id}.jpg`,
              mimetype: "image/jpeg",
            })),
          );
          const result = await splynx.addTaskAttachments(sub.task_id, sub.splynx_admin_id, buffers);
          attachmentIds = result.files;
        } catch (err) {
          errors.push(`Photos reattach failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      recordAdminAction(db, id, "reattach_splynx", { commentId, attachmentIds, errors });
      return { ok: errors.length === 0, comment_id: commentId, attachment_ids: attachmentIds, errors };
    },
  );

  // ---------- REGENERATE SUMMARY (preview only — admin saves with PATCH) ----------
  app.post(
    "/admin/submissions/:id/regenerate-summary",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = parseId((req.params as { id: string }).id);
      if (id === null) return reply.code(400).send({ error: "invalid_id" });
      const sub = loadSubmission(db, id);
      if (!sub) return reply.code(404).send({ error: "not_found" });
      if (!isSplynxConfigured(config))
        return reply.code(503).send({ error: "splynx_not_configured" });

      const photos = db
        .prepare(
          `SELECT filename FROM submission_photos WHERE submission_id = ? ORDER BY id ASC`,
        )
        .all(id) as { filename: string }[];

      try {
        const photoBuffers = await Promise.all(
          photos.map((p) =>
            fs.readFile(photoPath(config.DATA_DIR, sub.task_id, sub.id, p.filename)),
          ),
        );
        const splynx = getServiceSplynxClient(config);
        const task = await splynx.getTaskRaw(sub.task_id);
        const summary = await summarize({
          config,
          task,
          comment: sub.tech_comment_override ?? sub.comment ?? "",
          photoBuffers,
          techName: sub.app_login,
        });
        recordAdminAction(db, id, "regenerate_summary", { headline: summary.headline });
        return { ok: true, summary };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recordAdminAction(db, id, "regenerate_summary", { error: msg });
        return reply.code(503).send({ error: "regenerate_failed", detail: msg });
      }
    },
  );

  // ---------- TOGGLE RESOLVED ----------
  app.post(
    "/admin/submissions/:id/resolve",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = parseId((req.params as { id: string }).id);
      if (id === null) return reply.code(400).send({ error: "invalid_id" });
      const sub = loadSubmission(db, id);
      if (!sub) return reply.code(404).send({ error: "not_found" });
      const next = sub.admin_resolved ? 0 : 1;
      db.prepare(`UPDATE submissions SET admin_resolved = ?, updated_at = ? WHERE id = ?`).run(
        next,
        Date.now(),
        id,
      );
      recordAdminAction(db, id, "resolve", { resolved: next === 1 });
      return { ok: true, admin_resolved: next === 1 };
    },
  );

  // ---------- MANUAL SUBMISSION (admin-initiated, full pipeline) ----------
  app.post("/admin/submissions/manual", { preHandler: requireAdmin }, async (req, reply) => {
    if (!req.isMultipart()) return reply.code(400).send({ error: "expected_multipart" });
    if (!isSplynxConfigured(config)) return reply.code(503).send({ error: "splynx_not_configured" });
    const session = req.session!;

    let taskId: number | null = null;
    let comment = "";
    let onBehalfOfLogin: string | null = null;
    let onBehalfOfAdminId: number | null = null;
    const photos: SourcePhoto[] = [];

    try {
      for await (const part of req.parts()) {
        if (part.type === "field") {
          if (part.fieldname === "task_id") taskId = Number.parseInt(String(part.value), 10);
          else if (part.fieldname === "comment") comment = String(part.value).slice(0, 4000);
          else if (part.fieldname === "on_behalf_of_login")
            onBehalfOfLogin = String(part.value).slice(0, 64);
          else if (part.fieldname === "on_behalf_of_admin_id")
            onBehalfOfAdminId = Number.parseInt(String(part.value), 10);
        } else if (part.type === "file" && part.fieldname === "photos") {
          if (!part.mimetype.startsWith("image/")) {
            await part.toBuffer();
            continue;
          }
          if (photos.length >= 12) {
            await part.toBuffer();
            continue;
          }
          const buffer = await part.toBuffer();
          photos.push({ buffer, mimetype: part.mimetype, originalFilename: part.filename });
        }
      }
    } catch (err) {
      return reply.code(400).send({ error: "multipart_parse_failed", detail: String(err) });
    }

    if (!taskId || !Number.isFinite(taskId) || taskId <= 0) {
      return reply.code(400).send({ error: "invalid_task_id" });
    }

    const recordedLogin = onBehalfOfLogin?.trim() || session.app_login;
    const recordedAdminId =
      onBehalfOfAdminId && Number.isFinite(onBehalfOfAdminId)
        ? onBehalfOfAdminId
        : session.splynx_admin_id;

    const now = Date.now();
    const insert = db
      .prepare(
        `INSERT INTO submissions
           (task_id, app_login, splynx_admin_id, source, comment, status, created_at, updated_at)
         VALUES (?, ?, ?, 'manual', ?, 'pending', ?, ?)`,
      )
      .run(taskId, recordedLogin, recordedAdminId, comment, now, now);
    const submissionId = Number(insert.lastInsertRowid);

    const insertPhoto = db.prepare(
      `INSERT INTO submission_photos (submission_id, filename, size_bytes, width, height, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    let savedCount = 0;
    for (const src of photos) {
      try {
        const saved = await processAndSavePhoto(src, config.DATA_DIR, taskId, submissionId);
        insertPhoto.run(
          submissionId,
          saved.filename,
          saved.size_bytes,
          saved.width,
          saved.height,
          Date.now(),
        );
        savedCount += 1;
      } catch (err) {
        req.log.error({ err }, "manual submit photo save failed");
      }
    }

    if (savedCount === 0) {
      db.prepare(`UPDATE submissions SET status = 'failed', updated_at = ? WHERE id = ?`).run(
        Date.now(),
        submissionId,
      );
      return reply.code(400).send({ error: "no_valid_photos", submission_id: submissionId });
    }

    const splynx = getServiceSplynxClient(config);
    const task = await splynx.getTaskRaw(taskId);
    const photoRows = db
      .prepare(
        `SELECT id, filename, width, height FROM submission_photos
         WHERE submission_id = ? ORDER BY id ASC`,
      )
      .all(submissionId) as Array<{ id: number; filename: string; width: number; height: number }>;

    const result = await runSubmissionPipeline({
      config,
      db,
      log: req.log,
      submissionId,
      taskId,
      splynxAdminId: recordedAdminId,
      appLogin: recordedLogin,
      comment,
      photos: photoRows.map((r) => ({
        id: r.id,
        filename: r.filename,
        filePath: photoPath(config.DATA_DIR, taskId, submissionId, r.filename),
        width: r.width,
        height: r.height,
      })),
      task,
    });

    recordAdminAction(db, submissionId, "manual_submit", {
      onBehalfOfLogin: recordedLogin,
      photosSaved: savedCount,
    });

    return reply.code(201).send({
      submission_id: submissionId,
      task_id: taskId,
      status: result.status,
      summary: result.summary,
      splynx_comment_id: result.splynxCommentId,
      errors: result.errors,
    });
  });

  // ---------- RATING (admin-only, internal-only) ----------
  app.get(
    "/admin/submissions/:id/rating",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = parseId((req.params as { id: string }).id);
      if (id === null) return reply.code(400).send({ error: "invalid_id" });
      const row = db
        .prepare(
          `SELECT ai_score, ai_rationale, ai_dimensions_json,
                  admin_score, admin_rationale, admin_dimensions_json,
                  reviewed_at, created_at, updated_at
           FROM submission_ratings WHERE submission_id = ?`,
        )
        .get(id) as
        | {
            ai_score: number;
            ai_rationale: string;
            ai_dimensions_json: string;
            admin_score: number | null;
            admin_rationale: string | null;
            admin_dimensions_json: string | null;
            reviewed_at: number | null;
            created_at: number;
            updated_at: number;
          }
        | undefined;
      if (!row) return reply.code(404).send({ error: "no_rating" });
      return {
        ai: {
          score: row.ai_score,
          rationale: row.ai_rationale,
          dimensions: safeParse(row.ai_dimensions_json),
        },
        admin: row.admin_score
          ? {
              score: row.admin_score,
              rationale: row.admin_rationale,
              dimensions: row.admin_dimensions_json ? safeParse(row.admin_dimensions_json) : null,
            }
          : null,
        reviewed_at: row.reviewed_at,
        created_at: row.created_at,
        updated_at: row.updated_at,
      };
    },
  );

  const RatingPatchSchema = z.object({
    score: z.number().int().min(1).max(5).optional(),
    rationale: z.string().optional(),
    dimensions: RatingDimensionsSchema.optional(),
  });

  app.patch(
    "/admin/submissions/:id/rating",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = parseId((req.params as { id: string }).id);
      if (id === null) return reply.code(400).send({ error: "invalid_id" });
      const parsed = RatingPatchSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

      const existing = db
        .prepare(`SELECT id FROM submission_ratings WHERE submission_id = ?`)
        .get(id);
      if (!existing) return reply.code(404).send({ error: "no_rating" });

      const sets: string[] = [];
      const params: unknown[] = [];
      if (parsed.data.score !== undefined) {
        sets.push("admin_score = ?");
        params.push(parsed.data.score);
      }
      if (parsed.data.rationale !== undefined) {
        sets.push("admin_rationale = ?");
        params.push(parsed.data.rationale.slice(0, 2000));
      }
      if (parsed.data.dimensions !== undefined) {
        sets.push("admin_dimensions_json = ?");
        params.push(JSON.stringify(parsed.data.dimensions));
      }
      sets.push("reviewed_at = ?");
      params.push(Date.now());
      sets.push("updated_at = ?");
      params.push(Date.now());
      params.push(id);
      db.prepare(`UPDATE submission_ratings SET ${sets.join(", ")} WHERE submission_id = ?`).run(
        ...params,
      );
      recordAdminAction(db, id, "edit_rating", { ...parsed.data });
      return { ok: true };
    },
  );
}

// ---------- helpers ----------

interface MinimalSubmission {
  id: number;
  task_id: number;
  app_login: string;
  splynx_admin_id: number;
  comment: string | null;
  tech_comment_override: string | null;
  summary_json: string | null;
  corrected_summary_json: string | null;
  splynx_comment_id: number | null;
  admin_resolved: number;
}

function loadSubmission(db: ReturnType<typeof getDb>, id: number): MinimalSubmission | null {
  const row = db
    .prepare(
      `SELECT id, task_id, app_login, splynx_admin_id, comment, tech_comment_override,
              summary_json, corrected_summary_json, splynx_comment_id, admin_resolved
       FROM submissions WHERE id = ?`,
    )
    .get(id) as MinimalSubmission | undefined;
  return row ?? null;
}

function recordAdminAction(
  db: ReturnType<typeof getDb>,
  submissionId: number,
  action: string,
  details: unknown,
): void {
  db.prepare(
    `INSERT INTO admin_actions (submission_id, action, details_json, created_at) VALUES (?, ?, ?, ?)`,
  ).run(submissionId, action, JSON.stringify(details ?? null), Date.now());
}

function parseId(s: string): number | null {
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function isSummary(v: unknown): v is { headline: string; what_was_done: string; observations: string; follow_ups: string } {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as Record<string, unknown>).headline === "string" &&
    typeof (v as Record<string, unknown>).what_was_done === "string"
  );
}


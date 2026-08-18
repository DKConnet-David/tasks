import fs from "node:fs/promises";
import path from "node:path";
import { createReadStream } from "node:fs";
import type { FastifyInstance } from "fastify";
import { makeAuthGuards } from "../lib/auth-guards.js";
import { getServiceSplynxClient, isSplynxConfigured } from "../splynx/service-client.js";
import type { AppConfig } from "../config.js";
import { getDb } from "../db.js";
import { photoPath, processAndSavePhoto, type SourcePhoto } from "../photos/store.js";
import { runSubmissionPipeline } from "../pipeline/submit-task.js";
import { runAmendmentPipeline } from "../pipeline/submit-amendment.js";
import { ZOOM_BILLABLE_TYPES, type ZoomBillableType } from "../types.js";

const MAX_PHOTOS = 100;
const COMMENT_MAX = 4000;
const STOCK_NOTES_MAX = 2000;
const IDEMPOTENCY_KEY_MAX = 100;
// Restrict to printable ASCII so a bad client can't shove control bytes
// or unicode lookalikes through the dedup index. UUIDs are well within
// this range; anything else is ignored as if no key was sent.
const IDEMPOTENCY_KEY_RE = /^[\x21-\x7E]{1,100}$/;

export async function registerTaskRoutes(app: FastifyInstance, config: AppConfig): Promise<void> {
  const { requireSession } = makeAuthGuards(config);
  const db = getDb(config.DATA_DIR);

  // Active secondary-tech roster — used by the tech-side picker on the
  // Update task page. Excludes disabled entries so they stop appearing in
  // the UI once the admin retires them.
  app.get("/secondary-techs", { preHandler: requireSession }, async () => {
    const rows = db
      .prepare(
        `SELECT id, name FROM secondary_techs
         WHERE is_active = 1
         ORDER BY name COLLATE NOCASE ASC`,
      )
      .all() as { id: number; name: string }[];
    return { secondary_techs: rows };
  });

  // Fetch a Splynx task by id, plus its existing comments.
  app.get("/tasks/:id", { preHandler: requireSession }, async (req, reply) => {
    const { id: idParam } = req.params as { id: string };
    const id = Number.parseInt(idParam, 10);
    if (!Number.isFinite(id) || id <= 0) {
      return reply.code(400).send({ error: "invalid_task_id" });
    }

    if (!isSplynxConfigured(config)) {
      return reply.code(503).send({
        error: "splynx_not_configured",
        message: "Set SPLYNX_API_KEY and SPLYNX_API_SECRET in Coolify env vars.",
      });
    }

    const splynx = getServiceSplynxClient(config);
    try {
      const [task, comments] = await Promise.all([
        splynx.getTaskRaw(id),
        splynx.listTaskComments(id),
      ]);
      return { task, comments };
    } catch (err) {
      const e = err as { response?: { status?: number; data?: unknown } };
      if (e.response?.status === 404) {
        return reply.code(404).send({ error: "task_not_found" });
      }
      req.log.error({ err: e }, "splynx task fetch failed");
      return reply.code(502).send({ error: "splynx_error", status: e.response?.status });
    }
  });

  // Submit photos + comment against a task. Phase B: storage only. Phase C
  // wraps this with the AI-summary + PDF + WhatsApp + Splynx writeback
  // pipeline.
  app.post("/tasks/:id/submit", { preHandler: requireSession }, async (req, reply) => {
    const { id: idParam } = req.params as { id: string };
    const taskId = Number.parseInt(idParam, 10);
    if (!Number.isFinite(taskId) || taskId <= 0) {
      return reply.code(400).send({ error: "invalid_task_id" });
    }
    const session = req.session!;

    if (!req.isMultipart()) {
      return reply.code(400).send({ error: "expected_multipart" });
    }

    let comment = "";
    let stockNotes = "";
    let secondaryTechIdsRaw = "";
    let idempotencyKey = "";
    let zoomBillableOverride: ZoomBillableType | null = null;
    const photos: SourcePhoto[] = [];
    try {
      for await (const part of req.parts()) {
        if (part.type === "field" && part.fieldname === "comment") {
          comment = String(part.value).slice(0, COMMENT_MAX);
        } else if (part.type === "field" && part.fieldname === "stock_notes") {
          stockNotes = String(part.value).slice(0, STOCK_NOTES_MAX);
        } else if (part.type === "field" && part.fieldname === "secondary_tech_ids") {
          secondaryTechIdsRaw = String(part.value);
        } else if (part.type === "field" && part.fieldname === "idempotency_key") {
          const raw = String(part.value).slice(0, IDEMPOTENCY_KEY_MAX);
          // Silently drop anything that doesn't match the printable-ASCII
          // shape — treats malformed tokens as "no token sent" rather
          // than failing the submission outright.
          if (IDEMPOTENCY_KEY_RE.test(raw)) idempotencyKey = raw;
        } else if (part.type === "field" && part.fieldname === "zoom_billable_type") {
          // Only accept one of the closed ZOOM_BILLABLE_TYPES values.
          // Permission to set this is verified server-side below
          // (the sending tech must have zoom_billable = 1).
          const raw = String(part.value);
          const match = ZOOM_BILLABLE_TYPES.find((t) => t.value === raw);
          if (match) zoomBillableOverride = match.value;
        } else if (part.type === "file" && part.fieldname === "photos") {
          if (!part.mimetype.startsWith("image/")) {
            // Drain the stream so the parser doesn't hang on the unread file.
            await part.toBuffer();
            continue;
          }
          if (photos.length >= MAX_PHOTOS) {
            await part.toBuffer();
            continue;
          }
          const buffer = await part.toBuffer();
          photos.push({
            buffer,
            mimetype: part.mimetype,
            originalFilename: part.filename,
          });
        }
      }
    } catch (err) {
      req.log.error({ err }, "multipart parse failed");
      return reply.code(400).send({ error: "multipart_parse_failed" });
    }

    if (photos.length === 0) {
      return reply.code(400).send({ error: "no_photos" });
    }

    // Zoom-billable override permission check. Only techs whose row
    // has zoom_billable = 1 can set this field; anyone else silently
    // gets the override dropped (treated as if they didn't send it).
    // Admins can also use the override for testing via /me?is_admin.
    if (zoomBillableOverride && !session.is_admin) {
      const tech = db
        .prepare(`SELECT zoom_billable FROM techs WHERE login = ?`)
        .get(session.app_login) as { zoom_billable: number } | undefined;
      if (tech?.zoom_billable !== 1) {
        req.log.warn(
          { appLogin: session.app_login, attempted: zoomBillableOverride },
          "zoom_billable_type sent by non-allowlisted tech — ignored",
        );
        zoomBillableOverride = null;
      }
    }

    // Idempotency guard. If the same client token has already been used
    // by this tech, return 409 with the existing submission so the UI
    // can warn the tech and let them confirm a deliberate re-send (by
    // regenerating the token and retrying). Legacy clients that omit
    // the field skip this check entirely — behaviour is purely
    // additive.
    if (idempotencyKey) {
      const existing = db
        .prepare(
          `SELECT id, task_id, status, created_at, splynx_comment_id
           FROM submissions
           WHERE app_login = ? AND idempotency_key = ?
           ORDER BY id DESC
           LIMIT 1`,
        )
        .get(session.app_login, idempotencyKey) as
        | {
            id: number;
            task_id: number;
            status: string;
            created_at: number;
            splynx_comment_id: number | null;
          }
        | undefined;
      if (existing) {
        return reply.code(409).send({
          error: "duplicate_submission",
          existing_submission_id: existing.id,
          existing_task_id: existing.task_id,
          existing_created_at: existing.created_at,
          existing_status: existing.status,
          splynx_comment_posted: existing.splynx_comment_id !== null,
        });
      }
    }

    // Insert submissions row. stock_notes is written via a follow-up
    // UPDATE only when non-empty so we don't churn the column for jobs
    // where the tech didn't tag any stock.
    const now = Date.now();
    const insert = db.prepare(`
      INSERT INTO submissions (
        task_id, app_login, splynx_admin_id, source, comment, status, idempotency_key, created_at, updated_at
      ) VALUES (?, ?, ?, 'tech', ?, 'pending', ?, ?, ?)
    `).run(
      taskId,
      session.app_login,
      session.splynx_admin_id,
      comment,
      idempotencyKey || null,
      now,
      now,
    );
    const submissionId = Number(insert.lastInsertRowid);

    if (stockNotes.trim()) {
      db.prepare(
        `UPDATE submissions SET stock_notes = ?, updated_at = ? WHERE id = ?`,
      ).run(stockNotes, Date.now(), submissionId);
    }

    // Persist secondary-tech tags. CSV is parsed defensively — any token
    // that isn't a positive integer is dropped silently. The INSERT itself
    // ignores ids that don't reference an active row, so a stale id from a
    // cached UI can't poison the join table.
    const secondaryTechIds = secondaryTechIdsRaw
      .split(",")
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (secondaryTechIds.length > 0) {
      const insertTag = db.prepare(
        `INSERT OR IGNORE INTO submission_secondary_techs (submission_id, secondary_tech_id)
         SELECT ?, id FROM secondary_techs WHERE id = ? AND is_active = 1`,
      );
      const tx = db.transaction((ids: number[]) => {
        for (const id of ids) insertTag.run(submissionId, id);
      });
      tx(secondaryTechIds);
    }

    // Process and save each photo.
    let savedCount = 0;
    let failedCount = 0;
    const insertPhoto = db.prepare(`
      INSERT INTO submission_photos (
        submission_id, filename, size_bytes, width, height, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
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
        req.log.error({ err, originalFilename: src.originalFilename }, "photo save failed");
        failedCount += 1;
      }
    }

    if (savedCount === 0) {
      db.prepare(`UPDATE submissions SET status = 'failed', updated_at = ? WHERE id = ?`).run(
        Date.now(),
        submissionId,
      );
      return reply.code(500).send({
        error: "all_photos_failed",
        submission_id: submissionId,
      });
    }

    // ---- Pipeline (AI summarize → PDF → Splynx writeback) ----
    // Re-fetch task fresh from Splynx (don't trust client-cached state). Then
    // run the pipeline; pipeline writes its own status/summary/error fields
    // back to the submissions row.
    if (!isSplynxConfigured(config)) {
      db.prepare(
        `UPDATE submissions SET status = 'partial', error = ?, updated_at = ? WHERE id = ?`,
      ).run("Splynx not configured — photos saved only.", Date.now(), submissionId);
      return reply.code(201).send({
        submission_id: submissionId,
        task_id: taskId,
        status: "partial",
        photos_saved: savedCount,
        photos_failed: failedCount,
      });
    }

    const splynx = getServiceSplynxClient(config);
    let task;
    try {
      task = await splynx.getTaskRaw(taskId);
    } catch (err) {
      const e = err as { response?: { status?: number } };
      req.log.error({ err: e }, "task refetch failed before pipeline");
      db.prepare(
        `UPDATE submissions SET status = 'partial', error = ?, updated_at = ? WHERE id = ?`,
      ).run(`Splynx task fetch failed (${e.response?.status ?? "?"})`, Date.now(), submissionId);
      return reply.code(201).send({
        submission_id: submissionId,
        task_id: taskId,
        status: "partial",
        photos_saved: savedCount,
        photos_failed: failedCount,
      });
    }

    // Read back the photo rows we just inserted, then run the pipeline.
    const photoRows = db
      .prepare(
        `SELECT id, filename, width, height
         FROM submission_photos
         WHERE submission_id = ?
         ORDER BY id ASC`,
      )
      .all(submissionId) as { id: number; filename: string; width: number; height: number }[];

    const result = await runSubmissionPipeline({
      config,
      db,
      log: req.log,
      submissionId,
      taskId,
      splynxAdminId: session.splynx_admin_id,
      appLogin: session.app_login,
      comment,
      stockNotes,
      zoomBillableOverride,
      photos: photoRows.map((r) => ({
        id: r.id,
        filename: r.filename,
        filePath: photoPath(config.DATA_DIR, taskId, submissionId, r.filename),
        width: r.width,
        height: r.height,
      })),
      task,
    });

    return reply.code(201).send({
      submission_id: submissionId,
      task_id: taskId,
      status: result.status,
      photos_saved: savedCount,
      photos_failed: failedCount,
      summary: result.summary,
      splynx_comment_id: result.splynxCommentId,
      splynx_attachment_ids: result.splynxAttachmentIds,
      errors: result.errors,
    });
  });

  // Read a submission (own only — admin scope comes in Phase D).
  app.get("/submissions/:id", { preHandler: requireSession }, async (req, reply) => {
    const { id: idParam } = req.params as { id: string };
    const submissionId = Number.parseInt(idParam, 10);
    if (!Number.isFinite(submissionId) || submissionId <= 0) {
      return reply.code(400).send({ error: "invalid_submission_id" });
    }
    const session = req.session!;

    const row = db
      .prepare(
        `SELECT id, task_id, app_login, splynx_admin_id, source, comment,
                summary_json, splynx_comment_id, status, error, created_at, updated_at
         FROM submissions WHERE id = ?`,
      )
      .get(submissionId) as
      | {
          id: number;
          task_id: number;
          app_login: string;
          splynx_admin_id: number;
          source: string;
          comment: string | null;
          summary_json: string | null;
          splynx_comment_id: number | null;
          status: string;
          error: string | null;
          created_at: number;
          updated_at: number;
        }
      | undefined;
    if (!row) return reply.code(404).send({ error: "submission_not_found" });
    if (!session.is_admin && row.app_login !== session.app_login) {
      return reply.code(403).send({ error: "forbidden" });
    }

    // Original submission photos only (amendment photos live in the same
    // table with amendment_id set; they're returned separately below so
    // the UI can render them under the amendment card).
    const photos = db
      .prepare(
        `SELECT id, filename, size_bytes, width, height
         FROM submission_photos
         WHERE submission_id = ? AND amendment_id IS NULL
         ORDER BY id ASC`,
      )
      .all(submissionId) as {
      id: number;
      filename: string;
      size_bytes: number;
      width: number;
      height: number;
    }[];

    // Tech-authored amendment (at most one per submission, enforced by
    // UNIQUE(submission_id) on the amendments table). Null when the
    // tech hasn't added one yet.
    const amendmentRow = db
      .prepare(
        `SELECT id, submission_id, comment, actor_login, splynx_comment_id,
                wa_message_id, wa_zoom_message_id, status, error, created_at, updated_at
         FROM submission_amendments WHERE submission_id = ?`,
      )
      .get(submissionId) as
      | {
          id: number;
          submission_id: number;
          comment: string;
          actor_login: string;
          splynx_comment_id: number | null;
          wa_message_id: string | null;
          wa_zoom_message_id: string | null;
          status: string;
          error: string | null;
          created_at: number;
          updated_at: number;
        }
      | undefined;
    const amendmentPhotos = amendmentRow
      ? (db
          .prepare(
            `SELECT id, filename, size_bytes, width, height
             FROM submission_photos
             WHERE amendment_id = ?
             ORDER BY id ASC`,
          )
          .all(amendmentRow.id) as {
          id: number;
          filename: string;
          size_bytes: number;
          width: number;
          height: number;
        }[])
      : [];

    return {
      submission: row,
      photos,
      amendment: amendmentRow
        ? { ...amendmentRow, photos: amendmentPhotos }
        : null,
    };
  });

  // Download the generated PDF for a submission.
  app.get(
    "/submissions/:id/pdf",
    { preHandler: requireSession },
    async (req, reply) => {
      const { id: idParam } = req.params as { id: string };
      const submissionId = Number.parseInt(idParam, 10);
      if (!Number.isFinite(submissionId) || submissionId <= 0) {
        return reply.code(400).send({ error: "invalid_submission_id" });
      }
      const session = req.session!;

      const row = db
        .prepare(`SELECT task_id, app_login FROM submissions WHERE id = ?`)
        .get(submissionId) as { task_id: number; app_login: string } | undefined;
      if (!row) return reply.code(404).send({ error: "submission_not_found" });
      if (!session.is_admin && row.app_login !== session.app_login) {
        return reply.code(403).send({ error: "forbidden" });
      }

      const absPath = path.join(
        config.DATA_DIR,
        "photos",
        String(row.task_id),
        String(submissionId),
        "report.pdf",
      );
      try {
        await fs.stat(absPath);
      } catch {
        return reply.code(404).send({ error: "pdf_not_found" });
      }

      reply.header("Content-Type", "application/pdf");
      reply.header(
        "Content-Disposition",
        `inline; filename="task-${row.task_id}-submission-${submissionId}.pdf"`,
      );
      return reply.send(createReadStream(absPath));
    },
  );

  // Serve a saved photo. Session required; submission must belong to the
  // session's app_login (or session is admin). Filename is checked for path
  // traversals inside photoPath().
  app.get(
    "/submissions/:id/photos/:filename",
    { preHandler: requireSession },
    async (req, reply) => {
      const { id: idParam, filename } = req.params as { id: string; filename: string };
      const submissionId = Number.parseInt(idParam, 10);
      if (!Number.isFinite(submissionId) || submissionId <= 0) {
        return reply.code(400).send({ error: "invalid_submission_id" });
      }
      const session = req.session!;

      const row = db
        .prepare(`SELECT task_id, app_login FROM submissions WHERE id = ?`)
        .get(submissionId) as { task_id: number; app_login: string } | undefined;
      if (!row) return reply.code(404).send({ error: "submission_not_found" });
      if (!session.is_admin && row.app_login !== session.app_login) {
        return reply.code(403).send({ error: "forbidden" });
      }

      let absPath: string;
      try {
        absPath = photoPath(config.DATA_DIR, row.task_id, submissionId, filename);
      } catch {
        return reply.code(400).send({ error: "invalid_filename" });
      }
      try {
        await fs.stat(absPath);
      } catch {
        return reply.code(404).send({ error: "photo_not_found" });
      }

      reply.header("Content-Type", "image/jpeg");
      reply.header("Cache-Control", "private, max-age=86400");
      return reply.send(createReadStream(absPath));
    },
  );

  // Tech-authored amendment. Adds exactly one follow-up comment + photos
  // to an already-submitted job within 24h of the original. Original row
  // is never modified. See server/src/pipeline/submit-amendment.ts.
  const AMENDMENT_WINDOW_MS = 24 * 60 * 60 * 1000;
  const AMENDMENT_COMMENT_MAX = 4000;
  const AMENDMENT_MAX_PHOTOS = 20;

  app.post(
    "/tasks/submissions/:id/amendment",
    { preHandler: requireSession },
    async (req, reply) => {
      const { id: idParam } = req.params as { id: string };
      const submissionId = Number.parseInt(idParam, 10);
      if (!Number.isFinite(submissionId) || submissionId <= 0) {
        return reply.code(400).send({ error: "invalid_submission_id" });
      }
      const session = req.session!;

      // Load and gate on: existence, ownership, status, time window, single-use.
      const submission = db
        .prepare(
          `SELECT id, task_id, app_login, status, created_at
           FROM submissions WHERE id = ?`,
        )
        .get(submissionId) as
        | { id: number; task_id: number; app_login: string; status: string; created_at: number }
        | undefined;
      if (!submission) return reply.code(404).send({ error: "submission_not_found" });
      if (!session.is_admin && submission.app_login !== session.app_login) {
        return reply.code(403).send({ error: "forbidden" });
      }
      if (submission.status !== "success" && submission.status !== "partial") {
        return reply.code(409).send({
          error: "invalid_submission_status",
          detail: `Amendments only allowed on success or partial submissions (current: ${submission.status}).`,
        });
      }
      const elapsedMs = Date.now() - submission.created_at;
      if (elapsedMs > AMENDMENT_WINDOW_MS) {
        return reply.code(409).send({
          error: "amendment_window_expired",
          window_hours: 24,
          elapsed_hours: Math.round((elapsedMs / (60 * 60 * 1000)) * 10) / 10,
        });
      }
      const existing = db
        .prepare(`SELECT id FROM submission_amendments WHERE submission_id = ?`)
        .get(submissionId) as { id: number } | undefined;
      if (existing) {
        return reply.code(409).send({
          error: "amendment_already_exists",
          amendment_id: existing.id,
        });
      }

      if (!req.isMultipart()) {
        return reply.code(400).send({ error: "expected_multipart" });
      }

      let comment = "";
      const photos: SourcePhoto[] = [];
      try {
        for await (const part of req.parts()) {
          if (part.type === "field" && part.fieldname === "comment") {
            comment = String(part.value).slice(0, AMENDMENT_COMMENT_MAX);
          } else if (part.type === "file" && part.fieldname === "photos") {
            if (!part.mimetype.startsWith("image/")) {
              await part.toBuffer();
              continue;
            }
            if (photos.length >= AMENDMENT_MAX_PHOTOS) {
              await part.toBuffer();
              continue;
            }
            const buffer = await part.toBuffer();
            photos.push({
              buffer,
              mimetype: part.mimetype,
              originalFilename: part.filename,
            });
          }
        }
      } catch (err) {
        req.log.error({ err }, "amendment multipart parse failed");
        return reply.code(400).send({ error: "multipart_parse_failed" });
      }

      if (!comment.trim() && photos.length === 0) {
        return reply.code(400).send({ error: "empty_amendment" });
      }

      const now = Date.now();
      let amendmentId: number;
      try {
        const insert = db
          .prepare(
            `INSERT INTO submission_amendments
               (submission_id, comment, actor_login, status, created_at, updated_at)
             VALUES (?, ?, ?, 'pending', ?, ?)`,
          )
          .run(submissionId, comment, session.app_login, now, now);
        amendmentId = Number(insert.lastInsertRowid);
      } catch (err) {
        // Rare race: two amendments arrive concurrently and the second
        // trips the UNIQUE(submission_id) constraint. Treat as "already
        // exists" so the client gets the same shape as the pre-check.
        const e = err as { code?: string; message?: string };
        req.log.warn({ err: e }, "amendment insert failed (likely unique conflict)");
        return reply.code(409).send({ error: "amendment_already_exists" });
      }

      // Persist photos under the same task/submission folder as the
      // original. amendment_id column on the row distinguishes them from
      // original photos.
      let savedCount = 0;
      let failedCount = 0;
      const insertPhoto = db.prepare(
        `INSERT INTO submission_photos
           (submission_id, amendment_id, filename, size_bytes, width, height, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const src of photos) {
        try {
          const saved = await processAndSavePhoto(
            src,
            config.DATA_DIR,
            submission.task_id,
            submissionId,
          );
          insertPhoto.run(
            submissionId,
            amendmentId,
            saved.filename,
            saved.size_bytes,
            saved.width,
            saved.height,
            Date.now(),
          );
          savedCount += 1;
        } catch (err) {
          req.log.error(
            { err, originalFilename: src.originalFilename },
            "amendment photo save failed",
          );
          failedCount += 1;
        }
      }

      // Run the pipeline (PDF + Splynx + WhatsApp dual-send). Errors are
      // captured inside — this call itself throws only on programmer error.
      let result;
      try {
        result = await runAmendmentPipeline({
          config,
          db,
          log: req.log,
          submissionId,
          amendmentId,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        req.log.error({ err }, "amendment pipeline threw");
        db.prepare(
          `UPDATE submission_amendments SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`,
        ).run(msg, Date.now(), amendmentId);
        return reply.code(500).send({
          amendment_id: amendmentId,
          status: "failed",
          error: msg,
        });
      }

      // Audit trail. actor_login is the tech's session login; the row
      // lands alongside admin actions in admin_actions so the operator's
      // existing dashboard picks it up without extra plumbing.
      db.prepare(
        `INSERT INTO admin_actions (submission_id, actor_login, action, details_json, created_at)
         VALUES (?, ?, 'tech_amendment', ?, ?)`,
      ).run(
        submissionId,
        session.app_login,
        JSON.stringify({
          amendment_id: amendmentId,
          comment_length: comment.length,
          photo_count: savedCount,
          photos_failed: failedCount,
          splynx_comment_id: result.splynxCommentId,
          wa_message_id: result.waMessageId,
          wa_zoom_message_id: result.waZoomMessageId,
          hours_after_original: Math.round((elapsedMs / (60 * 60 * 1000)) * 10) / 10,
          status: result.status,
        }),
        Date.now(),
      );

      return reply.code(201).send({
        amendment_id: amendmentId,
        submission_id: submissionId,
        status: result.status,
        photos_saved: savedCount,
        photos_failed: failedCount,
        splynx_comment_id: result.splynxCommentId,
        wa_message_id: result.waMessageId,
        wa_zoom_message_id: result.waZoomMessageId,
        errors: result.errors,
      });
    },
  );

  // Serve the amendment PDF.
  app.get(
    "/submissions/:id/amendment/pdf",
    { preHandler: requireSession },
    async (req, reply) => {
      const { id: idParam } = req.params as { id: string };
      const submissionId = Number.parseInt(idParam, 10);
      if (!Number.isFinite(submissionId) || submissionId <= 0) {
        return reply.code(400).send({ error: "invalid_submission_id" });
      }
      const session = req.session!;
      const row = db
        .prepare(`SELECT task_id, app_login FROM submissions WHERE id = ?`)
        .get(submissionId) as { task_id: number; app_login: string } | undefined;
      if (!row) return reply.code(404).send({ error: "submission_not_found" });
      if (!session.is_admin && row.app_login !== session.app_login) {
        return reply.code(403).send({ error: "forbidden" });
      }
      const absPath = path.join(
        config.DATA_DIR,
        "photos",
        String(row.task_id),
        String(submissionId),
        "report-amendment.pdf",
      );
      try {
        await fs.stat(absPath);
      } catch {
        return reply.code(404).send({ error: "amendment_pdf_not_found" });
      }
      reply.header("Content-Type", "application/pdf");
      reply.header(
        "Content-Disposition",
        `inline; filename="task-${row.task_id}-submission-${submissionId}-amendment.pdf"`,
      );
      return reply.send(createReadStream(absPath));
    },
  );
}

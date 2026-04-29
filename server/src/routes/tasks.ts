import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import type { FastifyInstance } from "fastify";
import { makeAuthGuards } from "../lib/auth-guards.js";
import { getServiceSplynxClient, isSplynxConfigured } from "../splynx/service-client.js";
import type { AppConfig } from "../config.js";
import { getDb } from "../db.js";
import { photoPath, processAndSavePhoto, type SourcePhoto } from "../photos/store.js";

const MAX_PHOTOS = 12;
const COMMENT_MAX = 4000;

export async function registerTaskRoutes(app: FastifyInstance, config: AppConfig): Promise<void> {
  const { requireSession } = makeAuthGuards(config);
  const db = getDb(config.DATA_DIR);

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
    const photos: SourcePhoto[] = [];
    try {
      for await (const part of req.parts()) {
        if (part.type === "field" && part.fieldname === "comment") {
          comment = String(part.value).slice(0, COMMENT_MAX);
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

    // Insert submissions row.
    const now = Date.now();
    const insert = db.prepare(`
      INSERT INTO submissions (
        task_id, app_login, splynx_admin_id, source, comment, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'tech', ?, 'pending', ?, ?)
    `).run(taskId, session.app_login, session.splynx_admin_id, comment, now, now);
    const submissionId = Number(insert.lastInsertRowid);

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

    const finalStatus = failedCount === 0 ? "success" : savedCount === 0 ? "failed" : "partial";
    db.prepare(`UPDATE submissions SET status = ?, updated_at = ? WHERE id = ?`).run(
      finalStatus,
      Date.now(),
      submissionId,
    );

    return reply.code(201).send({
      submission_id: submissionId,
      task_id: taskId,
      status: finalStatus,
      photos_saved: savedCount,
      photos_failed: failedCount,
      comment_length: comment.length,
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
                summary_json, status, error, created_at, updated_at
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

    const photos = db
      .prepare(
        `SELECT id, filename, size_bytes, width, height
         FROM submission_photos
         WHERE submission_id = ?
         ORDER BY id ASC`,
      )
      .all(submissionId) as {
      id: number;
      filename: string;
      size_bytes: number;
      width: number;
      height: number;
    }[];

    return {
      submission: row,
      photos,
    };
  });

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
}

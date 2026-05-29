import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { makeAuthGuards } from "../lib/auth-guards.js";
import { getServiceSplynxClient, isSplynxConfigured } from "../splynx/service-client.js";
import { getDb } from "../db.js";
import type { AppConfig } from "../config.js";
import {
  ExternalSummarySchema,
  JobTypeSchema,
  RatingDimensionsSchema,
  RequirementsCheckSchema,
} from "../types.js";
import { summarize } from "../ai/summarize.js";
import { pipelineSendDocument } from "./whatsapp.js";
import { photoPath, processAndSavePhoto, type SourcePhoto } from "../photos/store.js";
import { runSubmissionPipeline } from "../pipeline/submit-task.js";
import { generatePdf } from "../pdf/generate.js";
import { formatSplynxComment, formatWhatsAppCaption, splynxTaskUrl } from "../format/external.js";
import { createTech, listTechs, updateTech } from "../lib/techs.js";
import { getSetting, setSetting, SettingKeys } from "../lib/settings.js";
import { runDailySummary } from "../scheduler/daily-summary.js";
import {
  countActiveAdmins,
  createAdmin,
  listAdmins,
  updateAdmin,
} from "../lib/admins.js";

const ListQuery = z.object({
  status: z.enum(["pending", "success", "partial", "failed"]).optional(),
  login: z.string().optional(),
  q: z.string().optional(),
  cursor: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  // By default the list excludes hidden submissions. Pass include_hidden=1
  // to see everything including the ones an admin has flagged as
  // duplicates / typos.
  include_hidden: z
    .union([z.boolean(), z.string().transform((s) => s === "1" || s === "true")])
    .optional(),
});

export async function registerAdminRoutes(app: FastifyInstance, config: AppConfig): Promise<void> {
  const { requireAdmin } = makeAuthGuards(config);
  const db = getDb(config.DATA_DIR);

  // ---------- LIST ----------
  app.get("/admin/submissions", { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_query" });
    const { status, login, q, cursor, limit, include_hidden } = parsed.data;

    const wheres: string[] = [];
    const params: unknown[] = [];
    if (!include_hidden) {
      wheres.push("hidden = 0");
    }
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
                s.hidden, s.created_at, s.updated_at,
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
      hidden: number;
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
      hidden: r.hidden === 1,
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
                splynx_pdf_file_id, wa_message_id, status, error, admin_resolved, hidden,
                requirements_check_json, stock_notes,
                admin_flag_note, admin_flag_score, admin_flagged_at, admin_flagged_by,
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
          hidden: number;
          requirements_check_json: string | null;
          stock_notes: string | null;
          admin_flag_note: string | null;
          admin_flag_score: number | null;
          admin_flagged_at: number | null;
          admin_flagged_by: string | null;
          created_at: number;
          updated_at: number;
        }
      | undefined;
    if (!sub) return reply.code(404).send({ error: "not_found" });

    // Parse the admin-only requirements-coverage blob. Swallow malformed
    // rows (returning null) so a future schema drift doesn't break the
    // whole submission detail page — the panel just won't render.
    let requirementsCheck: unknown = null;
    if (sub.requirements_check_json) {
      const raw = safeParse(sub.requirements_check_json);
      const parsed = RequirementsCheckSchema.safeParse(raw);
      if (parsed.success) requirementsCheck = parsed.data;
    }

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
        `SELECT id, action, actor_login, details_json, created_at
         FROM admin_actions WHERE submission_id = ? ORDER BY id DESC LIMIT 50`,
      )
      .all(id) as Array<{
      id: number;
      action: string;
      actor_login: string | null;
      details_json: string | null;
      created_at: number;
    }>;

    return {
      submission: {
        ...sub,
        admin_resolved: sub.admin_resolved === 1,
        hidden: sub.hidden === 1,
      },
      photos,
      actions,
      // Pre-built Splynx URL so the frontend doesn't need to know the
      // tenant base URL or the URL pattern. Empty string when Splynx
      // isn't configured (dev / stub mode).
      splynx_task_url: config.SPLYNX_BASE_URL
        ? splynxTaskUrl(config.SPLYNX_BASE_URL, sub.task_id)
        : "",
      // Admin-only requirements-coverage check (null when the toggle was
      // off at submit time, or when there's no checklist for this job_type).
      requirements_check: requirementsCheck,
      // Admin tracking flag — null when not flagged. Does NOT affect
      // the submission's effective_score on dashboards; it's a marker
      // + note surfaced as a badge on the tech's profile.
      admin_flag: sub.admin_flagged_at
        ? {
            note: sub.admin_flag_note ?? "",
            score: sub.admin_flag_score,
            flagged_at: sub.admin_flagged_at,
            flagged_by: sub.admin_flagged_by,
          }
        : null,
    };
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
        const secondaries = loadSecondaryTechNames(db, id);
        const stockNotes = loadStockNotes(db, id);
        const body = formatSplynxComment(
          parsed.data,
          sub.app_login,
          true,
          secondaries,
          stockNotes,
        );
        await splynx.updateTaskComment(sub.splynx_comment_id, body);
        pushedToSplynx = true;
      } catch (err) {
        pushError = err instanceof Error ? err.message : String(err);
      }
    }

    recordAdminAction(db, id, req.session?.app_login ?? null, "edit_summary", { pushedToSplynx, pushError });
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
      recordAdminAction(db, id, req.session?.app_login ?? null, "edit_tech_comment", { length: value?.length ?? 0 });
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
      const parsedSummary = sub.summary_json
        ? ExternalSummarySchema.safeParse(safeParse(sub.summary_json))
        : null;
      if (!parsedSummary?.success) {
        return reply.code(400).send({ error: "no_summary_to_resend" });
      }
      const summary = parsedSummary.data;
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

      const splynxClient = getServiceSplynxClient(config);
      const task = await splynxClient.getTaskRaw(sub.task_id).catch(() => null);
      const taskShape = {
        id: sub.task_id,
        title: task?.title ?? "",
        address: task?.address ?? "",
      };

      // Customer login for the Account bullet on the WhatsApp caption.
      // Best-effort: a missing customer record just suppresses the line.
      let customerLogin: string | null = null;
      if (task?.related_customer_id) {
        try {
          const customer = await splynxClient.getCustomer(task.related_customer_id);
          customerLogin = customer.login || null;
        } catch {
          // ignore — caption falls back without the Account bullet
        }
      }

      try {
        const secondaries = loadSecondaryTechNames(db, id);
        const result = await pipelineSendDocument({
          config,
          caption: formatWhatsAppCaption(
            summary,
            taskShape,
            sub.app_login,
            config.SPLYNX_BASE_URL,
            customerLogin,
            // Resends keep the *original* submission timestamp rather
            // than re-stamping to "now" — otherwise "Submitted at" would
            // misleadingly drift forward each time admin re-fires.
            new Date(sub.created_at),
            secondaries,
          ),
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
        recordAdminAction(db, id, req.session?.app_login ?? null, "resend_whatsapp", { messageId: result.messageId });
        return { ok: true, message_id: result.messageId };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recordAdminAction(db, id, req.session?.app_login ?? null, "resend_whatsapp", { error: msg });
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

      const splynx = getServiceSplynxClient(config);
      const errors: string[] = [];
      let commentId: number | null = null;

      // PDF
      try {
        const summarySource = sub.corrected_summary_json ?? sub.summary_json;
        if (!summarySource) throw new Error("no summary stored");
        const parsed = ExternalSummarySchema.safeParse(safeParse(summarySource));
        if (!parsed.success) throw new Error("stored summary is malformed");
        const summary = parsed.data;
        const secondaries = loadSecondaryTechNames(db, id);
        const stockNotes = loadStockNotes(db, id);

        // PDF buffer: try the cached file first (the happy path), and
        // fall back to rebuilding from the stored summary + saved
        // photos when the file is missing. Missing-file happens when
        // the original pipeline failed before the PDF step (e.g.
        // summarize threw on a malformed AI response). Once the admin
        // has regenerated a working summary, reattach should be able
        // to recover instead of erroring with ENOENT.
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
        } catch (readErr) {
          if ((readErr as NodeJS.ErrnoException).code !== "ENOENT") throw readErr;
          req.log.info(
            { submissionId: id, taskId: sub.task_id },
            "reattach: PDF missing, rebuilding from stored summary",
          );
          const taskRaw = await splynx.getTaskRaw(sub.task_id);
          const photoRows = db
            .prepare(
              `SELECT id, filename, width, height
               FROM submission_photos
               WHERE submission_id = ?
               ORDER BY id ASC`,
            )
            .all(id) as { id: number; filename: string; width: number; height: number }[];
          const photos = await Promise.all(
            photoRows.map(async (p) => ({
              buffer: await fs.readFile(
                photoPath(config.DATA_DIR, sub.task_id, sub.id, p.filename),
              ),
              width: p.width,
              height: p.height,
            })),
          );
          pdfBuffer = await generatePdf({
            task: taskRaw,
            summary,
            comment: sub.tech_comment_override ?? sub.comment ?? "",
            photos,
            techName: sub.app_login,
            submittedAt: new Date(sub.created_at),
            secondaryTechNames: secondaries,
          });
          // Cache the freshly-built PDF back to disk so the next
          // operation (e.g. tech tapping Download PDF) doesn't have to
          // rebuild from scratch.
          await fs.mkdir(path.dirname(pdfFile), { recursive: true });
          await fs.writeFile(pdfFile, pdfBuffer);
        }

        const body = formatSplynxComment(
          summary,
          sub.app_login,
          !!sub.corrected_summary_json,
          secondaries,
          stockNotes,
        );
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

      // Photos used to be re-uploaded to Splynx Attachments tab here too,
      // but the PDF already contains the full photo grid so it was
      // redundant clutter. Re-attach now reposts the comment + PDF only.

      recordAdminAction(db, id, req.session?.app_login ?? null, "reattach_splynx", { commentId, errors });
      return { ok: errors.length === 0, comment_id: commentId, errors };
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
        // Regenerate is a preview-only path — we don't persist the
        // requirements-check result here even if the toggle is on; the
        // admin saves the summary via PATCH afterward. Pulling the
        // setting in still lets the AI surface coverage gaps in the
        // preview UI if the operator wants to see them.
        // Pull stock_notes off the row for the AI prompt — loadSubmission
        // doesn't include it (the column is only needed on this code path
        // and on the admin detail GET).
        const stockRow = db
          .prepare(`SELECT stock_notes FROM submissions WHERE id = ?`)
          .get(id) as { stock_notes: string | null } | undefined;
        const result = await summarize({
          config,
          task,
          comment: sub.tech_comment_override ?? sub.comment ?? "",
          stockNotes: stockRow?.stock_notes ?? "",
          photoBuffers,
          techName: sub.app_login,
          requirementsCheckEnabled:
            getSetting(db, SettingKeys.requirementsCheckEnabled) === "1",
        });
        const summary = result.summary;
        recordAdminAction(db, id, req.session?.app_login ?? null, "regenerate_summary", { headline: summary.headline });
        return { ok: true, summary, requirements_check: result.requirementsCheck };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recordAdminAction(db, id, req.session?.app_login ?? null, "regenerate_summary", { error: msg });
        return reply.code(503).send({ error: "regenerate_failed", detail: msg });
      }
    },
  );

  // ---------- EDIT JOB TYPE (admin override of the AI's classification) ----------
  const JobTypePatchSchema = z.object({ job_type: JobTypeSchema });

  app.patch(
    "/admin/submissions/:id/job-type",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = parseId((req.params as { id: string }).id);
      if (id === null) return reply.code(400).send({ error: "invalid_id" });
      const parsed = JobTypePatchSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

      const sub = loadSubmission(db, id);
      if (!sub) return reply.code(404).send({ error: "not_found" });

      // Apply the override to corrected_summary_json (creating it from
      // summary_json if it doesn't exist yet, so the original AI output is
      // preserved unchanged in summary_json).
      const baseJson = sub.corrected_summary_json ?? sub.summary_json;
      if (!baseJson) {
        return reply.code(400).send({
          error: "no_summary",
          message: "Cannot set job_type before the AI summary has run.",
        });
      }
      const obj = safeParse(baseJson);
      if (!obj || typeof obj !== "object") {
        return reply.code(400).send({ error: "stored_summary_malformed" });
      }
      const updated = { ...(obj as Record<string, unknown>), job_type: parsed.data.job_type };

      db.prepare(
        `UPDATE submissions SET corrected_summary_json = ?, updated_at = ? WHERE id = ?`,
      ).run(JSON.stringify(updated), Date.now(), id);

      recordAdminAction(db, id, req.session?.app_login ?? null, "edit_job_type", { job_type: parsed.data.job_type });
      return { ok: true, job_type: parsed.data.job_type };
    },
  );

  // ---------- HIDE / UNHIDE (admin can mark a submission as hidden so it
  //            disappears from the default Submissions list and from the
  //            Performance dashboard without losing the audit trail) ----------
  const HiddenPatchSchema = z.object({ hidden: z.boolean() });

  app.patch(
    "/admin/submissions/:id/hidden",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = parseId((req.params as { id: string }).id);
      if (id === null) return reply.code(400).send({ error: "invalid_id" });
      const parsed = HiddenPatchSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

      const sub = loadSubmission(db, id);
      if (!sub) return reply.code(404).send({ error: "not_found" });

      db.prepare(`UPDATE submissions SET hidden = ?, updated_at = ? WHERE id = ?`).run(
        parsed.data.hidden ? 1 : 0,
        Date.now(),
        id,
      );
      recordAdminAction(db, id, req.session?.app_login ?? null, parsed.data.hidden ? "hide" : "unhide", {});
      return { ok: true, hidden: parsed.data.hidden };
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
      recordAdminAction(db, id, req.session?.app_login ?? null, "resolve", { resolved: next === 1 });
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
          if (photos.length >= 100) {
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

    recordAdminAction(db, submissionId, req.session?.app_login ?? null, "manual_submit", {
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

  // ---------- TECH PROVISIONING ----------
  app.get("/admin/techs", { preHandler: requireAdmin }, async () => {
    return { techs: listTechs(db) };
  });

  const TechCreateSchema = z.object({
    login: z.string().min(1).max(64).regex(/^[a-zA-Z0-9._-]+$/, "letters, digits, . _ - only"),
    password: z.string().min(8).max(256),
    splynx_admin_id: z.coerce.number().int().positive(),
    display_name: z.string().min(1).max(120),
    zoom_billable: z.boolean().optional(),
  });

  app.post("/admin/techs", { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = TechCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });
    }
    if (parsed.data.login === config.ADMIN_LOGIN) {
      return reply.code(400).send({
        error: "login_conflict",
        message: "That login is reserved for the admin account.",
      });
    }
    try {
      const id = await createTech(db, parsed.data);
      return reply.code(201).send({ id });
    } catch (err) {
      const e = err as { code?: string; message?: string };
      if (e.code === "SQLITE_CONSTRAINT_UNIQUE") {
        return reply.code(409).send({ error: "login_taken" });
      }
      throw err;
    }
  });

  const TechPatchSchema = z.object({
    password: z.string().min(8).max(256).optional(),
    splynx_admin_id: z.coerce.number().int().positive().optional(),
    display_name: z.string().min(1).max(120).optional(),
    is_active: z.boolean().optional(),
    zoom_billable: z.boolean().optional(),
  });

  app.patch("/admin/techs/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const id = parseId((req.params as { id: string }).id);
    if (id === null) return reply.code(400).send({ error: "invalid_id" });
    const parsed = TechPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });
    }
    await updateTech(db, id, parsed.data);
    return { ok: true };
  });

  app.delete("/admin/techs/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const id = parseId((req.params as { id: string }).id);
    if (id === null) return reply.code(400).send({ error: "invalid_id" });
    // Soft delete — submissions reference app_login as a denormalised string,
    // so a hard delete would lose the audit link.
    await updateTech(db, id, { is_active: false });
    return { ok: true };
  });

  // ---------- ADMIN PROVISIONING ----------
  app.get("/admin/admins", { preHandler: requireAdmin }, async () => {
    return { admins: listAdmins(db) };
  });

  const AdminCreateSchema = z.object({
    login: z.string().min(1).max(64).regex(/^[a-zA-Z0-9._-]+$/, "letters, digits, . _ - only"),
    password: z.string().min(8).max(256),
    splynx_admin_id: z.coerce.number().int().positive(),
    display_name: z.string().min(1).max(120),
  });

  app.post("/admin/admins", { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = AdminCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });
    }
    // Avoid silent overlap with a tech of the same login — auth.ts checks
    // admins first, but a duplicate is confusing operationally and the audit
    // log can't tell them apart by login alone.
    const techCol = db.prepare(`SELECT 1 FROM techs WHERE login = ?`).get(parsed.data.login);
    if (techCol) {
      return reply.code(409).send({
        error: "login_conflict_with_tech",
        message: "A tech with that login exists. Use a different login or remove the tech first.",
      });
    }
    try {
      const id = await createAdmin(db, parsed.data);
      return reply.code(201).send({ id });
    } catch (err) {
      const e = err as { code?: string; message?: string };
      if (e.code === "SQLITE_CONSTRAINT_UNIQUE") {
        return reply.code(409).send({ error: "login_taken" });
      }
      throw err;
    }
  });

  const AdminPatchSchema = z.object({
    password: z.string().min(8).max(256).optional(),
    splynx_admin_id: z.coerce.number().int().positive().optional(),
    display_name: z.string().min(1).max(120).optional(),
    is_active: z.boolean().optional(),
  });

  app.patch("/admin/admins/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const id = parseId((req.params as { id: string }).id);
    if (id === null) return reply.code(400).send({ error: "invalid_id" });
    const parsed = AdminPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });
    }
    // Lockout guard: refuse a deactivation that would zero out the active
    // admin set. The env-var recovery credentials still work, but the
    // operator may have rotated them or forgotten — better to fail fast
    // than to lock the UI.
    if (parsed.data.is_active === false) {
      const current = db
        .prepare(`SELECT is_active FROM admins WHERE id = ?`)
        .get(id) as { is_active: number } | undefined;
      if (current?.is_active === 1 && countActiveAdmins(db) <= 1) {
        return reply.code(400).send({
          error: "last_active_admin",
          message: "Cannot disable the last active admin. Create another active admin first.",
        });
      }
    }
    await updateAdmin(db, id, parsed.data);
    return { ok: true };
  });

  app.delete("/admin/admins/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const id = parseId((req.params as { id: string }).id);
    if (id === null) return reply.code(400).send({ error: "invalid_id" });
    // Same lockout guard — soft-delete is just is_active = 0.
    const current = db
      .prepare(`SELECT is_active FROM admins WHERE id = ?`)
      .get(id) as { is_active: number } | undefined;
    if (current?.is_active === 1 && countActiveAdmins(db) <= 1) {
      return reply.code(400).send({
        error: "last_active_admin",
        message: "Cannot disable the last active admin. Create another active admin first.",
      });
    }
    await updateAdmin(db, id, { is_active: false });
    return { ok: true };
  });

  // ---------- PIPELINE SETTINGS (admin-only toggles) ----------
  // The requirements-coverage check is currently the only toggleable
  // pipeline behavior. Default is off; flipping on costs a few hundred
  // extra tokens per submission and surfaces a flagged checklist in
  // the admin SubmissionDetail UI only — never in external output.
  app.get(
    "/admin/settings/requirements-check",
    { preHandler: requireAdmin },
    async () => {
      return {
        enabled: getSetting(db, SettingKeys.requirementsCheckEnabled) === "1",
      };
    },
  );

  const RequirementsCheckSettingSchema = z.object({ enabled: z.boolean() });
  app.patch(
    "/admin/settings/requirements-check",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const parsed = RequirementsCheckSettingSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });
      }
      setSetting(db, SettingKeys.requirementsCheckEnabled, parsed.data.enabled ? "1" : "0");
      req.log.info(
        { actor: req.session?.app_login ?? null, enabled: parsed.data.enabled },
        "requirements_check_enabled toggled",
      );
      return { ok: true, enabled: parsed.data.enabled };
    },
  );

  // ---------- DAILY SUMMARY (scheduled 19:00 WhatsApp post) ----------
  app.get(
    "/admin/settings/daily-summary",
    { preHandler: requireAdmin },
    async () => {
      return {
        enabled: getSetting(db, SettingKeys.dailySummaryEnabled) === "1",
        last_sent_date: getSetting(db, SettingKeys.dailySummaryLastSentDate),
        group_jid: getSetting(db, SettingKeys.whatsappGroupJid),
        group_name: getSetting(db, SettingKeys.whatsappGroupName),
      };
    },
  );

  const DailySummarySettingSchema = z.object({ enabled: z.boolean() });
  app.patch(
    "/admin/settings/daily-summary",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const parsed = DailySummarySettingSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });
      }
      // When the operator enables the schedule, mark today as already
      // sent so it doesn't auto-fire immediately if they happen to flip
      // the switch after 19:00 — they get tomorrow's report instead.
      // They can still trigger an immediate test send via the
      // /send-now endpoint below.
      if (parsed.data.enabled) {
        const today = new Date().toLocaleDateString("en-CA");
        const lastSent = getSetting(db, SettingKeys.dailySummaryLastSentDate);
        if (lastSent !== today) {
          setSetting(db, SettingKeys.dailySummaryLastSentDate, today);
        }
      }
      setSetting(db, SettingKeys.dailySummaryEnabled, parsed.data.enabled ? "1" : "0");
      req.log.info(
        { actor: req.session?.app_login ?? null, enabled: parsed.data.enabled },
        "daily_summary_enabled toggled",
      );
      return { ok: true, enabled: parsed.data.enabled };
    },
  );

  app.post(
    "/admin/settings/daily-summary/send-now",
    { preHandler: requireAdmin },
    async (req, reply) => {
      // Force=true bypasses the once-a-day guard so the operator can
      // trigger as many test sends as they want. Sentinel intentionally
      // not updated by passing dateOverride so the real 19:00 fire is
      // unaffected.
      const today = new Date().toLocaleDateString("en-CA");
      const result = await runDailySummary(
        { db, config, log: req.log },
        { force: true, dateOverride: today },
      );
      if (result.ok && "sent" in result && result.sent) {
        return reply.send({
          ok: true,
          sent: true,
          message_id: result.messageId,
          row_count: result.rowCount,
        });
      }
      if (result.ok && "sent" in result && !result.sent) {
        return reply.code(400).send({ ok: false, error: result.reason });
      }
      return reply.code(503).send({ ok: false, error: (result as { error: string }).error });
    },
  );

  // ---------- SECONDARY-TECH ROSTER (helpers without app logins) ----------
  app.get("/admin/secondary-techs", { preHandler: requireAdmin }, async () => {
    const rows = db
      .prepare(
        `SELECT id, name, is_active, created_at, updated_at
         FROM secondary_techs
         ORDER BY is_active DESC, name COLLATE NOCASE ASC`,
      )
      .all() as Array<{
      id: number;
      name: string;
      is_active: number;
      created_at: number;
      updated_at: number;
    }>;
    return {
      secondary_techs: rows.map((r) => ({
        id: r.id,
        name: r.name,
        is_active: r.is_active === 1,
        created_at: r.created_at,
        updated_at: r.updated_at,
      })),
    };
  });

  const SecondaryTechCreateSchema = z.object({
    name: z.string().trim().min(1).max(120),
  });

  app.post("/admin/secondary-techs", { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = SecondaryTechCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });
    }
    const now = Date.now();
    try {
      const info = db
        .prepare(
          `INSERT INTO secondary_techs (name, is_active, created_at, updated_at)
           VALUES (?, 1, ?, ?)`,
        )
        .run(parsed.data.name, now, now);
      return reply.code(201).send({ id: Number(info.lastInsertRowid) });
    } catch (err) {
      const e = err as { code?: string };
      if (e.code === "SQLITE_CONSTRAINT_UNIQUE") {
        return reply.code(409).send({ error: "name_taken" });
      }
      throw err;
    }
  });

  const SecondaryTechPatchSchema = z.object({
    name: z.string().trim().min(1).max(120).optional(),
    is_active: z.boolean().optional(),
  });

  app.patch("/admin/secondary-techs/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const id = parseId((req.params as { id: string }).id);
    if (id === null) return reply.code(400).send({ error: "invalid_id" });
    const parsed = SecondaryTechPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });
    }
    const fields: string[] = [];
    const values: (string | number)[] = [];
    if (parsed.data.name !== undefined) {
      fields.push("name = ?");
      values.push(parsed.data.name);
    }
    if (parsed.data.is_active !== undefined) {
      fields.push("is_active = ?");
      values.push(parsed.data.is_active ? 1 : 0);
    }
    if (fields.length === 0) return { ok: true };
    fields.push("updated_at = ?");
    values.push(Date.now());
    values.push(id);
    try {
      db.prepare(
        `UPDATE secondary_techs SET ${fields.join(", ")} WHERE id = ?`,
      ).run(...values);
    } catch (err) {
      const e = err as { code?: string };
      if (e.code === "SQLITE_CONSTRAINT_UNIQUE") {
        return reply.code(409).send({ error: "name_taken" });
      }
      throw err;
    }
    return { ok: true };
  });

  app.delete("/admin/secondary-techs/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const id = parseId((req.params as { id: string }).id);
    if (id === null) return reply.code(400).send({ error: "invalid_id" });
    // Soft-delete — historical submission_secondary_techs rows reference
    // this id, and a hard delete would orphan or vanish them.
    db.prepare(
      `UPDATE secondary_techs SET is_active = 0, updated_at = ? WHERE id = ?`,
    ).run(Date.now(), id);
    return { ok: true };
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
                  ai_strengths_json, ai_improvements_json,
                  admin_score, admin_rationale, admin_dimensions_json,
                  reviewed_at, created_at, updated_at
           FROM submission_ratings WHERE submission_id = ?`,
        )
        .get(id) as
        | {
            ai_score: number;
            ai_rationale: string;
            ai_dimensions_json: string;
            ai_strengths_json: string | null;
            ai_improvements_json: string | null;
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
          // Legacy paragraph rationale — populated for older ratings only.
          // New ratings use the strengths / improvements arrays below and
          // store an empty string here.
          rationale: row.ai_rationale,
          strengths: parseStringArray(row.ai_strengths_json),
          improvements: parseStringArray(row.ai_improvements_json),
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
    score: z.number().int().min(1).max(10).optional(),
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
      recordAdminAction(db, id, req.session?.app_login ?? null, "edit_rating", { ...parsed.data });
      return { ok: true };
    },
  );

  // ---------- ADMIN TRACKING FLAG (separate from the rating override) ----------
  // The rating override above replaces the AI's effective score on
  // dashboards. The flag below is purely an annotation — it lives on
  // the submissions row, never feeds into score math, and surfaces
  // as a badge in the per-tech profile so the operator can spot
  // mistake patterns without rewriting the AI's evaluation.
  const FlagPostSchema = z.object({
    note: z.string().trim().min(1).max(2000),
    score: z.number().int().min(1).max(10).optional(),
  });
  app.post(
    "/admin/submissions/:id/flag",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = parseId((req.params as { id: string }).id);
      if (id === null) return reply.code(400).send({ error: "invalid_id" });
      const parsed = FlagPostSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });
      }
      const sub = loadSubmission(db, id);
      if (!sub) return reply.code(404).send({ error: "not_found" });
      const actor = req.session?.app_login ?? null;
      const now = Date.now();
      db.prepare(
        `UPDATE submissions
           SET admin_flag_note = ?,
               admin_flag_score = ?,
               admin_flagged_at = ?,
               admin_flagged_by = ?,
               updated_at = ?
         WHERE id = ?`,
      ).run(
        parsed.data.note,
        parsed.data.score ?? null,
        now,
        actor,
        now,
        id,
      );
      recordAdminAction(db, id, actor, "flag_submission", {
        note: parsed.data.note.slice(0, 200),
        score: parsed.data.score ?? null,
      });
      return { ok: true, flagged_at: now };
    },
  );

  app.delete(
    "/admin/submissions/:id/flag",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = parseId((req.params as { id: string }).id);
      if (id === null) return reply.code(400).send({ error: "invalid_id" });
      const sub = loadSubmission(db, id);
      if (!sub) return reply.code(404).send({ error: "not_found" });
      db.prepare(
        `UPDATE submissions
           SET admin_flag_note = NULL,
               admin_flag_score = NULL,
               admin_flagged_at = NULL,
               admin_flagged_by = NULL,
               updated_at = ?
         WHERE id = ?`,
      ).run(Date.now(), id);
      recordAdminAction(db, id, req.session?.app_login ?? null, "unflag_submission", null);
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
  created_at: number;
}

function loadSubmission(db: ReturnType<typeof getDb>, id: number): MinimalSubmission | null {
  const row = db
    .prepare(
      `SELECT id, task_id, app_login, splynx_admin_id, comment, tech_comment_override,
              summary_json, corrected_summary_json, splynx_comment_id, admin_resolved,
              created_at
       FROM submissions WHERE id = ?`,
    )
    .get(id) as MinimalSubmission | undefined;
  return row ?? null;
}

function loadStockNotes(db: ReturnType<typeof getDb>, submissionId: number): string {
  const row = db
    .prepare(`SELECT stock_notes FROM submissions WHERE id = ?`)
    .get(submissionId) as { stock_notes: string | null } | undefined;
  return row?.stock_notes ?? "";
}

function loadSecondaryTechNames(db: ReturnType<typeof getDb>, submissionId: number): string[] {
  return db
    .prepare(
      `SELECT st.name
       FROM submission_secondary_techs sst
       JOIN secondary_techs st ON st.id = sst.secondary_tech_id
       WHERE sst.submission_id = ?
       ORDER BY st.name COLLATE NOCASE ASC`,
    )
    .all(submissionId)
    .map((r) => (r as { name: string }).name);
}

function recordAdminAction(
  db: ReturnType<typeof getDb>,
  submissionId: number,
  actorLogin: string | null,
  action: string,
  details: unknown,
): void {
  db.prepare(
    `INSERT INTO admin_actions (submission_id, actor_login, action, details_json, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(submissionId, actorLogin, action, JSON.stringify(details ?? null), Date.now());
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

function parseStringArray(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}



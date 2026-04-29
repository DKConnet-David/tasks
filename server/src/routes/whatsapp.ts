import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { makeAuthGuards } from "../lib/auth-guards.js";
import type { AppConfig } from "../config.js";
import { getDb } from "../db.js";
import { getSetting, setSetting, deleteSetting, SettingKeys } from "../lib/settings.js";
import {
  getStatus,
  start as baileysStart,
  listGroups,
  sendDocumentToGroup,
  sendTextToGroup,
  logoutAndWipe,
} from "../whatsapp/baileys.js";

const SetGroupSchema = z.object({
  jid: z.string().min(1),
  subject: z.string().optional(),
});

const TestSendSchema = z.object({
  text: z.string().min(1).max(500).optional(),
});

export async function registerWhatsAppRoutes(app: FastifyInstance, config: AppConfig): Promise<void> {
  const { requireAdmin } = makeAuthGuards(config);
  const db = getDb(config.DATA_DIR);

  app.get("/admin/whatsapp/status", { preHandler: requireAdmin }, async () => {
    const s = getStatus();
    const groupJid = getSetting(db, SettingKeys.whatsappGroupJid);
    const groupName = getSetting(db, SettingKeys.whatsappGroupName);
    return {
      status: s.status,
      qr_data_url: s.qrDataUrl,
      last_error: s.lastError,
      groups: s.groups,
      configured_jid: groupJid,
      configured_name: groupName,
      started_at: s.startedAt,
    };
  });

  app.post("/admin/whatsapp/start", { preHandler: requireAdmin }, async () => {
    await baileysStart(config.DATA_DIR);
    return { ok: true, status: getStatus().status };
  });

  app.post("/admin/whatsapp/refresh-groups", { preHandler: requireAdmin }, async () => {
    const groups = await listGroups();
    return { groups };
  });

  app.post("/admin/whatsapp/group", { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = SetGroupSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    setSetting(db, SettingKeys.whatsappGroupJid, parsed.data.jid);
    if (parsed.data.subject) {
      setSetting(db, SettingKeys.whatsappGroupName, parsed.data.subject);
    }
    return { ok: true, jid: parsed.data.jid };
  });

  app.delete("/admin/whatsapp/group", { preHandler: requireAdmin }, async () => {
    deleteSetting(db, SettingKeys.whatsappGroupJid);
    deleteSetting(db, SettingKeys.whatsappGroupName);
    return { ok: true };
  });

  app.post("/admin/whatsapp/test", { preHandler: requireAdmin }, async (req, reply) => {
    const jid = getSetting(db, SettingKeys.whatsappGroupJid);
    if (!jid) {
      return reply.code(400).send({ error: "no_group_configured" });
    }
    const parsed = TestSendSchema.safeParse(req.body);
    const text =
      parsed.success && parsed.data.text
        ? parsed.data.text
        : `Test message from Task Updater at ${new Date().toLocaleString()}`;
    try {
      const id = await sendTextToGroup(jid, text);
      return { ok: true, message_id: id };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(503).send({ error: "send_failed", detail: msg });
    }
  });

  app.post("/admin/whatsapp/logout", { preHandler: requireAdmin }, async () => {
    await logoutAndWipe();
    return { ok: true };
  });
}

// Surface a thin send wrapper for the pipeline (no auth — pipeline runs in
// the api process). Keeps the pipeline import surface clean.
export async function pipelineSendDocument(args: {
  config: AppConfig;
  caption: string;
  pdfBuffer: Buffer;
  fileName: string;
}): Promise<{ messageId: string | null; jid: string } | null> {
  const db = getDb(args.config.DATA_DIR);
  const jid = getSetting(db, SettingKeys.whatsappGroupJid);
  if (!jid) return null;
  const messageId = await sendDocumentToGroup({
    jid,
    caption: args.caption,
    pdf: args.pdfBuffer,
    fileName: args.fileName,
  });
  return { messageId, jid };
}

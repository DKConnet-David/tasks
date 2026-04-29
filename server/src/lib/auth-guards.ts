import type { FastifyReply, FastifyRequest } from "fastify";
import { loadSession, sessionCookieName } from "./session.js";
import { getDb } from "../db.js";
import type { AppConfig } from "../config.js";
import type { SessionData } from "../types.js";

declare module "fastify" {
  interface FastifyRequest {
    session?: SessionData;
  }
}

export function makeAuthGuards(config: AppConfig) {
  const db = getDb(config.DATA_DIR);

  async function requireSession(req: FastifyRequest, reply: FastifyReply) {
    const sid = req.cookies[sessionCookieName];
    const session = loadSession(db, sid);
    if (!session) {
      reply.code(401).send({ error: "unauthenticated" });
      return reply;
    }
    req.session = session;
  }

  async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
    await requireSession(req, reply);
    if (reply.sent) return reply;
    if (!req.session?.is_admin) {
      reply.code(403).send({ error: "forbidden" });
      return reply;
    }
  }

  return { requireSession, requireAdmin };
}

import type { FastifyInstance } from "fastify";
import { destroySession, loadSession, sessionCookieName } from "../lib/session.js";
import type { AppConfig } from "../config.js";
import { getDb } from "../db.js";

/**
 * Auth routes — placeholder implementation.
 *
 * The probe revealed that the live Splynx tenant uses API-key auth (no
 * per-user identity) so the original "proxy each tech's Splynx login" model
 * isn't viable. The replacement (app-only auth with a local techs table) is
 * pending user confirmation — see docs/open-questions.md.
 *
 * Until that decision lands, /auth/login returns 501 and /auth/me returns 401.
 * The session table and cookie plumbing are already in place to swap in.
 */
export async function registerAuthRoutes(app: FastifyInstance, config: AppConfig): Promise<void> {
  const db = getDb(config.DATA_DIR);

  app.post("/auth/login", async (_req, reply) => {
    return reply.code(501).send({
      error: "not_implemented",
      message:
        "Tech auth model is pending — see docs/open-questions.md. After confirmation, this endpoint will accept app-only credentials.",
    });
  });

  app.post("/auth/logout", async (req, reply) => {
    const sid = req.cookies[sessionCookieName];
    if (sid) destroySession(db, sid);
    reply.clearCookie(sessionCookieName, { path: "/" });
    return { ok: true };
  });

  app.get("/auth/me", async (req, reply) => {
    const sid = req.cookies[sessionCookieName];
    const session = loadSession(db, sid);
    if (!session) return reply.code(401).send({ error: "unauthenticated" });
    return {
      splynx_login: session.splynx_login,
      splynx_user_id: session.splynx_user_id,
      is_admin: session.is_admin,
    };
  });
}

import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createSession, destroySession, loadSession, sessionCookieName } from "../lib/session.js";
import type { AppConfig } from "../config.js";
import { getDb } from "../db.js";

/**
 * App-only auth.
 *
 * Today we support a single admin login (`ADMIN_LOGIN` + `ADMIN_PASSWORD`
 * env vars). Tech provisioning will land in a follow-up phase as a `techs`
 * table with bcrypt-hashed passwords. The session model is already shaped
 * for that: `splynx_admin_id` per session lets writebacks to Splynx be
 * attributed to the right Splynx admin name.
 *
 * The admin's `splynx_admin_id` is hardcoded to 1 (David, observed in the
 * probe) — change here if your David is a different admin row.
 */

const ADMIN_SPLYNX_ADMIN_ID = 1;

const LoginSchema = z.object({
  login: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});

function constantTimeStringEqual(a: string, b: string): boolean {
  // SHA-256 both sides so timingSafeEqual gets equal-length buffers and the
  // length of the secret isn't revealed by short-circuit comparisons.
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export async function registerAuthRoutes(app: FastifyInstance, config: AppConfig): Promise<void> {
  const db = getDb(config.DATA_DIR);

  app.post("/auth/login", async (req, reply) => {
    const parsed = LoginSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    const { login, password } = parsed.data;

    const loginOk = constantTimeStringEqual(login, config.ADMIN_LOGIN);
    const passwordOk = constantTimeStringEqual(password, config.ADMIN_PASSWORD);
    if (!loginOk || !passwordOk) {
      // Tiny artificial delay so timing differences from the lookup don't
      // distinguish wrong-login from wrong-password to a casual observer.
      await new Promise((r) => setTimeout(r, 50));
      return reply.code(401).send({ error: "invalid_credentials" });
    }

    const sessionId = createSession(db, {
      app_login: config.ADMIN_LOGIN,
      splynx_admin_id: ADMIN_SPLYNX_ADMIN_ID,
      is_admin: true,
      ttlSeconds: config.SESSION_TTL_SECONDS,
    });

    reply.setCookie(sessionCookieName, sessionId, {
      httpOnly: true,
      secure: config.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: config.SESSION_TTL_SECONDS,
    });

    return { ok: true };
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
      app_login: session.app_login,
      splynx_admin_id: session.splynx_admin_id,
      is_admin: session.is_admin,
    };
  });
}

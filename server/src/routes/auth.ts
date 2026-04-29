import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createSession, destroySession, loadSession, sessionCookieName } from "../lib/session.js";
import type { AppConfig } from "../config.js";
import { getDb } from "../db.js";
import { findTechByLogin, verifyPassword, dummyVerify } from "../lib/techs.js";

/**
 * App-only auth.
 *
 * Order of precedence:
 *   1. ADMIN_LOGIN + ADMIN_PASSWORD (env-driven, single admin).
 *   2. techs table (admin-provisioned, bcrypt-hashed password).
 *
 * Total response time is dominated by bcrypt.compare(~100ms). To prevent a
 * timing oracle that distinguishes "unknown login" from "wrong password",
 * we always run a bcrypt compare even when the login isn't found.
 */

const LoginSchema = z.object({
  login: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});

function constantTimeStringEqual(a: string, b: string): boolean {
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

    let session: {
      app_login: string;
      splynx_admin_id: number;
      is_admin: boolean;
    } | null = null;

    // Path 1: admin login.
    if (
      constantTimeStringEqual(login, config.ADMIN_LOGIN) &&
      constantTimeStringEqual(password, config.ADMIN_PASSWORD)
    ) {
      session = {
        app_login: config.ADMIN_LOGIN,
        splynx_admin_id: config.ADMIN_SPLYNX_ADMIN_ID,
        is_admin: true,
      };
      // Still run a dummy bcrypt so admin login takes ~the same time as a
      // tech login, removing the time-based admin-vs-tech distinguisher.
      await dummyVerify(password);
    } else {
      // Path 2: tech login.
      const tech = findTechByLogin(db, login);
      if (tech && tech.is_active === 1) {
        const ok = await verifyPassword(password, tech.password_hash);
        if (ok) {
          session = {
            app_login: tech.login,
            splynx_admin_id: tech.splynx_admin_id,
            is_admin: false,
          };
        }
      } else {
        // Login doesn't exist or is inactive — run a dummy compare to keep
        // timing similar to a real bcrypt path.
        await dummyVerify(password);
      }
    }

    if (!session) {
      return reply.code(401).send({ error: "invalid_credentials" });
    }

    const sessionId = createSession(db, {
      app_login: session.app_login,
      splynx_admin_id: session.splynx_admin_id,
      is_admin: session.is_admin,
      ttlSeconds: config.SESSION_TTL_SECONDS,
    });

    reply.setCookie(sessionCookieName, sessionId, {
      httpOnly: true,
      secure: req.protocol === "https",
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

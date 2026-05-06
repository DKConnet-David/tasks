import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createSession, destroySession, loadSession, sessionCookieName } from "../lib/session.js";
import type { AppConfig } from "../config.js";
import { getDb } from "../db.js";
import { findTechByLogin, verifyPassword, dummyVerify } from "../lib/techs.js";
import { findAdminByLogin, verifyAdminPassword } from "../lib/admins.js";

/**
 * App-only auth.
 *
 * Order of precedence:
 *   1. admins table (admin-provisioned via /admin/admins, bcrypt-hashed).
 *   2. techs table (admin-provisioned via /admin/techs, bcrypt-hashed).
 *   3. ADMIN_LOGIN + ADMIN_PASSWORD env vars — permanent recovery
 *      credentials. Always work, regardless of whether a row with that
 *      login exists in admins (or its is_active state). Used to bootstrap
 *      the seed admin and to break-glass-recover if the operator locks
 *      themselves out via the UI. Rotate them in Coolify if compromised.
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
    let bcryptRan = false;

    // Path 1: admins table.
    const admin = findAdminByLogin(db, login);
    if (admin && admin.is_active === 1) {
      bcryptRan = true;
      const ok = await verifyAdminPassword(password, admin.password_hash);
      if (ok) {
        session = {
          app_login: admin.login,
          splynx_admin_id: admin.splynx_admin_id,
          is_admin: true,
        };
      }
    }

    // Path 2: techs table (only if admin path didn't authenticate).
    if (!session) {
      const tech = findTechByLogin(db, login);
      if (tech && tech.is_active === 1) {
        bcryptRan = true;
        const ok = await verifyPassword(password, tech.password_hash);
        if (ok) {
          session = {
            app_login: tech.login,
            splynx_admin_id: tech.splynx_admin_id,
            is_admin: false,
          };
        }
      }
    }

    // Path 3: env-var recovery (always works, regardless of table state).
    if (!session) {
      if (
        constantTimeStringEqual(login, config.ADMIN_LOGIN) &&
        constantTimeStringEqual(password, config.ADMIN_PASSWORD)
      ) {
        session = {
          app_login: config.ADMIN_LOGIN,
          splynx_admin_id: config.ADMIN_SPLYNX_ADMIN_ID,
          is_admin: true,
        };
      }
    }

    // Timing-oracle mitigation: if no real bcrypt ran (e.g. login not found
    // in either table), run a dummy compare so the 401 response time is
    // close to a "wrong password" response time.
    if (!session && !bcryptRan) {
      await dummyVerify(password);
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

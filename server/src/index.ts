import Fastify from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import { loadConfig } from "./config.js";
import { getDb } from "./db.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import { registerWhatsAppRoutes } from "./routes/whatsapp.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerPerformanceRoutes } from "./routes/performance.js";
import { start as startBaileys } from "./whatsapp/baileys.js";
import { startDailySummaryScheduler } from "./scheduler/daily-summary.js";

async function main() {
  const config = loadConfig();
  // Initialize DB (runs migrations).
  const db = getDb(config.DATA_DIR);

  // Bootstrap-seed the env-var admin into the admins table on first boot.
  // After this, additional admins can be created via /admin/admins. The
  // env-var ADMIN_LOGIN / ADMIN_PASSWORD remains a permanent recovery
  // credential — auth.ts checks the admins table first and falls back to
  // the env vars if no match. To rotate the seed admin: edit them via
  // the Admins page, not by changing env vars.
  const { countAdmins, createAdmin } = await import("./lib/admins.js");
  if (countAdmins(db) === 0) {
    await createAdmin(db, {
      login: config.ADMIN_LOGIN,
      password: config.ADMIN_PASSWORD,
      splynx_admin_id: config.ADMIN_SPLYNX_ADMIN_ID,
      display_name: config.ADMIN_LOGIN,
    });
  }

  const app = Fastify({
    logger: {
      level: config.NODE_ENV === "production" ? "info" : "debug",
    },
    // Up to 50 photos × ~10MB each from modern phone cameras = 500MB.
    // Multipart's per-file fileSize limit below is the real per-file cap;
    // bodyLimit covers the aggregate.
    bodyLimit: 600 * 1024 * 1024,
    trustProxy: true,
  });

  await app.register(cookie, { secret: config.SESSION_SECRET });
  await app.register(multipart, {
    limits: {
      // Per-file cap. 30 MB is generous for HEIC + uncompressed phone JPEGs.
      fileSize: 30 * 1024 * 1024,
      // Photo count cap (matches MAX_PHOTOS in routes/tasks.ts and admin.ts).
      files: 100,
    },
  });

  app.get("/health", async () => ({ ok: true }));

  // All API routes live under /api/* to keep them clear of frontend SPA paths
  // like /admin which the React Router also owns. nginx in the web container
  // proxies /api/* and /health to this server; everything else falls through
  // to the SPA index.html.
  await app.register(
    async (api) => {
      await registerAuthRoutes(api, config);
      await registerTaskRoutes(api, config);
      await registerWhatsAppRoutes(api, config);
      await registerAdminRoutes(api, config);
      await registerPerformanceRoutes(api, config);
    },
    { prefix: "/api" },
  );

  // Auto-start Baileys in the background. If creds are already saved on the
  // data volume we'll re-handshake cleanly; otherwise the QR shows up on the
  // /admin/whatsapp page when the admin opens it. Failure here doesn't
  // prevent the api from starting.
  startBaileys(config.DATA_DIR).catch((err) => {
    app.log.error({ err }, "baileys start failed (continuing without WhatsApp)");
  });

  app.listen({ port: config.PORT, host: config.HOST }, (err, address) => {
    if (err) {
      app.log.error(err);
      process.exit(1);
    }
    app.log.info(`task-upater server listening on ${address}`);
  });

  // Daily team-summary WhatsApp post. Self-gated on a settings toggle —
  // if disabled, the tick is a no-op. Once enabled in /admin/settings,
  // it posts at 19:00 Africa/Johannesburg to the configured group.
  startDailySummaryScheduler({ db, config, log: app.log });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

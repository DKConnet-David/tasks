import Fastify from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import { loadConfig } from "./config.js";
import { getDb } from "./db.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerTaskRoutes } from "./routes/tasks.js";

async function main() {
  const config = loadConfig();
  // Initialize DB (runs migrations).
  getDb(config.DATA_DIR);

  const app = Fastify({
    logger: {
      level: config.NODE_ENV === "production" ? "info" : "debug",
    },
    bodyLimit: 50 * 1024 * 1024,
    // We sit behind nginx (in the web container) which forwards the
    // X-Forwarded-Proto header. Trusting it lets req.protocol reflect the
    // real client-side scheme so we set Secure cookies on HTTPS only.
    trustProxy: true,
  });

  await app.register(cookie, { secret: config.SESSION_SECRET });
  await app.register(multipart, {
    limits: {
      fileSize: 25 * 1024 * 1024,
      files: 12,
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
      // Admin and whatsapp routes are registered here as they are
      // implemented. See server/src/routes/{admin,whatsapp}.ts.
    },
    { prefix: "/api" },
  );

  app.listen({ port: config.PORT, host: config.HOST }, (err, address) => {
    if (err) {
      app.log.error(err);
      process.exit(1);
    }
    app.log.info(`task-upater server listening on ${address}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

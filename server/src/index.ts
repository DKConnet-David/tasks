import Fastify from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import { loadConfig } from "./config.js";
import { getDb } from "./db.js";
import { registerAuthRoutes } from "./routes/auth.js";

async function main() {
  const config = loadConfig();
  // Initialize DB (runs migrations).
  getDb(config.DATA_DIR);

  const app = Fastify({
    logger: {
      level: config.NODE_ENV === "production" ? "info" : "debug",
    },
    bodyLimit: 50 * 1024 * 1024,
  });

  await app.register(cookie, { secret: config.SESSION_SECRET });
  await app.register(multipart, {
    limits: {
      fileSize: 25 * 1024 * 1024,
      files: 12,
    },
  });

  app.get("/health", async () => ({ ok: true }));

  await registerAuthRoutes(app, config);

  // Tasks, admin, and whatsapp routes are registered as they are implemented.
  // See server/src/routes/{tasks,admin,whatsapp}.ts.

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

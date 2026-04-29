import type { FastifyInstance } from "fastify";
import { makeAuthGuards } from "../lib/auth-guards.js";
import { getServiceSplynxClient, isSplynxConfigured } from "../splynx/service-client.js";
import type { AppConfig } from "../config.js";

export async function registerTaskRoutes(app: FastifyInstance, config: AppConfig): Promise<void> {
  const { requireSession } = makeAuthGuards(config);

  // Fetch a Splynx task by id, plus its existing comments.
  // Authentication: app session required (any signed-in user, tech or admin).
  // Splynx auth: the shared API key (service account).
  app.get("/tasks/:id", { preHandler: requireSession }, async (req, reply) => {
    const { id: idParam } = req.params as { id: string };
    const id = Number.parseInt(idParam, 10);
    if (!Number.isFinite(id) || id <= 0) {
      return reply.code(400).send({ error: "invalid_task_id" });
    }

    if (!isSplynxConfigured(config)) {
      return reply.code(503).send({
        error: "splynx_not_configured",
        message: "Set SPLYNX_API_KEY and SPLYNX_API_SECRET in Coolify env vars.",
      });
    }

    const splynx = getServiceSplynxClient(config);
    try {
      const [task, comments] = await Promise.all([
        splynx.getTaskRaw(id),
        splynx.listTaskComments(id),
      ]);
      return { task, comments };
    } catch (err) {
      const e = err as { response?: { status?: number; data?: unknown } };
      if (e.response?.status === 404) {
        return reply.code(404).send({ error: "task_not_found" });
      }
      req.log.error({ err: e }, "splynx task fetch failed");
      return reply.code(502).send({ error: "splynx_error", status: e.response?.status });
    }
  });
}

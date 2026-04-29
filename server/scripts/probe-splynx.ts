/**
 * Splynx API probe.
 *
 * Confirms the live tenant's auth + endpoint paths and dumps the response
 * shapes so the TypeScript types in src/splynx/* can be locked.
 *
 * Two auth modes are supported:
 *   - API key + secret (Basic auth)        — set SPLYNX_API_KEY + SPLYNX_API_SECRET
 *   - Per-admin login token                 — set SPLYNX_PROBE_LOGIN + SPLYNX_PROBE_PASSWORD
 *
 * Required either way:
 *   SPLYNX_BASE_URL=https://your-tenant.example.com
 *   SPLYNX_PROBE_TASK_ID=14967
 *
 * Optional: set SPLYNX_PROBE_WRITE=1 to exercise the comment + file upload
 * paths against the chosen task. Defaults to read-only.
 */

import fs from "node:fs";
import path from "node:path";
import { SplynxClient } from "../src/splynx/client.js";

function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`missing env: ${name}`);
    process.exit(2);
  }
  return v;
}

function tryGet(c: SplynxClient, label: string, urls: string[]): Promise<unknown> {
  return (async () => {
    const errors: { url: string; status?: number; data?: unknown; message?: string }[] = [];
    for (const url of urls) {
      try {
        const data = await c.request({ method: "GET", url });
        console.log(`  ✓ ${label} via ${url}`);
        return { ok: true, url, data };
      } catch (err) {
        const e = err as { response?: { status?: number; data?: unknown }; message?: string };
        errors.push({ url, status: e.response?.status, data: e.response?.data, message: e.message });
      }
    }
    console.log(`  ✗ ${label} — none of ${urls.length} candidate paths worked`);
    return { ok: false, attempts: errors };
  })();
}

async function main() {
  const baseUrl = need("SPLYNX_BASE_URL");
  const taskIdRaw = need("SPLYNX_PROBE_TASK_ID");
  const taskId = Number.parseInt(taskIdRaw, 10);
  const allowWrite = process.env.SPLYNX_PROBE_WRITE === "1";

  const apiKey = process.env["SPLYNX_API_KEY"];
  const apiSecret = process.env["SPLYNX_API_SECRET"];
  const adminLogin = process.env["SPLYNX_PROBE_LOGIN"];
  const adminPassword = process.env["SPLYNX_PROBE_PASSWORD"];

  let client: SplynxClient;
  const out: Record<string, unknown> = { baseUrl, taskId };

  if (apiKey && apiSecret) {
    console.log(`→ auth: API key (Basic ${apiKey.slice(0, 6)}…)`);
    client = new SplynxClient({ baseUrl, apiKey, apiSecret });
    out["auth"] = { mode: "api_key" };
  } else if (adminLogin && adminPassword) {
    console.log(`→ auth: admin login (${adminLogin})`);
    client = new SplynxClient({ baseUrl });
    const auth = await client.login(adminLogin, adminPassword);
    client.setAccessToken(auth.access_token);
    out["auth"] = { mode: "admin_login", expires_in_s: auth.access_token_expiration };
  } else {
    console.error(
      "missing auth: set either (SPLYNX_API_KEY+SPLYNX_API_SECRET) or (SPLYNX_PROBE_LOGIN+SPLYNX_PROBE_PASSWORD)",
    );
    process.exit(2);
  }

  // Try whoami across known shapes — Splynx version variability.
  out["whoami"] = await tryGet(client, "whoami", [
    "/api/2.0/admin/administration/admins/me",
    "/api/2.0/admin/administrators/me",
    "/api/2.0/admin/info",
    "/api/admin/administration/admins?main_attributes[is_me]=1",
  ]);

  // Fetch the test task. Try the v2.0 path first, then v1 fallbacks.
  out["task"] = await tryGet(client, `task ${taskId}`, [
    `/api/2.0/admin/scheduling/tasks/${taskId}`,
    `/api/2.0/admin/networking/scheduling/tasks/${taskId}`,
    `/api/admin/scheduling/tasks/${taskId}`,
    `/api/2.0/admin/tickets/ticket/${taskId}`,
  ]);

  // List a couple of comments / files for the task to understand shapes.
  out["taskComments"] = await tryGet(client, "task comments", [
    `/api/2.0/admin/scheduling/tasks-comments?main_attributes[task_id]=${taskId}`,
    `/api/2.0/admin/scheduling/tasks/${taskId}/comments`,
  ]);
  out["taskFiles"] = await tryGet(client, "task files", [
    `/api/2.0/admin/scheduling/tasks-files?main_attributes[task_id]=${taskId}`,
    `/api/2.0/admin/scheduling/tasks/${taskId}/files`,
  ]);

  if (allowWrite) {
    console.log("→ write probes ENABLED");
    const userId = Number(process.env["SPLYNX_PROBE_USER_ID"] ?? 1);
    try {
      const c = await client.addTaskComment(
        taskId,
        userId,
        `[task-upater probe ${new Date().toISOString()}] connectivity test — please ignore`,
      );
      out["addTaskComment"] = { ok: true, data: c };
    } catch (err) {
      const e = err as { response?: { status?: number; data?: unknown } };
      out["addTaskComment"] = { ok: false, status: e.response?.status, data: e.response?.data };
    }

    // File upload deliberately removed — see docs/splynx-probe-findings.md.
    // The fallback strategy (PDF/photos hosted by our backend, link in the
    // Splynx comment) does not require a Splynx file upload endpoint.
  } else {
    console.log("→ skipping write probes (set SPLYNX_PROBE_WRITE=1 to exercise them)");
  }

  const outPath = path.join(process.cwd(), "splynx-probe.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\nresults written to ${outPath}`);
}

main().catch((err) => {
  console.error("probe failed at top level:");
  if (err && typeof err === "object" && "response" in err) {
    const r = (err as { response?: { status?: number; data?: unknown } }).response;
    console.error(`  status: ${r?.status}`);
    console.error(`  data:   ${JSON.stringify(r?.data)}`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

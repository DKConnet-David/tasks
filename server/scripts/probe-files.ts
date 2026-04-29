/**
 * Follow-up probe: figure out how files attach to a Splynx task or task-comment.
 * Tries a few variants and reports which one (if any) accepts a small PDF.
 *
 * IMPORTANT: this DOES write to the live tenant — it posts a clearly-marked
 * test comment and attempts to attach a tiny PDF. Run only against a test
 * task ID; comments can be deleted afterward.
 *
 * Usage:
 *   SPLYNX_BASE_URL=... SPLYNX_API_KEY=... SPLYNX_API_SECRET=... \
 *   SPLYNX_PROBE_TASK_ID=14967 \
 *   tsx scripts/probe-files.ts
 */

import fs from "node:fs";
import path from "node:path";
import axios from "axios";
import FormData from "form-data";

const baseUrl = process.env["SPLYNX_BASE_URL"];
const apiKey = process.env["SPLYNX_API_KEY"];
const apiSecret = process.env["SPLYNX_API_SECRET"];
const taskIdRaw = process.env["SPLYNX_PROBE_TASK_ID"];
if (!baseUrl || !apiKey || !apiSecret || !taskIdRaw) {
  console.error("missing env: SPLYNX_BASE_URL / SPLYNX_API_KEY / SPLYNX_API_SECRET / SPLYNX_PROBE_TASK_ID");
  process.exit(2);
}
const taskId = Number.parseInt(taskIdRaw, 10);
const authHeader = `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}`;

const http = axios.create({
  baseURL: baseUrl.replace(/\/+$/, ""),
  timeout: 30_000,
  headers: { Authorization: authHeader },
  validateStatus: () => true,
});

const tinyPdf = Buffer.from(
  "%PDF-1.1\n1 0 obj<</Pages 2 0 R>>endobj 2 0 obj<</Kids[]/Count 0>>endobj trailer<</Root 1 0 R>>",
);

interface Attempt {
  label: string;
  method: string;
  url: string;
  status: number;
  data: unknown;
}

const attempts: Attempt[] = [];

async function tryJsonPost(label: string, url: string, body: unknown) {
  const r = await http.post(url, body);
  attempts.push({ label, method: "POST(json)", url, status: r.status, data: r.data });
  return r;
}

async function tryMultipartPost(label: string, url: string, fields: Record<string, string>, file?: { name: string; type: string; buf: Buffer }) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  if (file) fd.append("file", file.buf, { filename: file.name, contentType: file.type });
  const r = await http.post(url, fd, { headers: fd.getHeaders() });
  attempts.push({ label, method: "POST(multipart)", url, status: r.status, data: r.data });
  return r;
}

async function main() {
  const userId = Number(process.env["SPLYNX_PROBE_USER_ID"] ?? 1);

  // Step 1: post a comment-only via JSON. user_id is required when using API-key auth
  // (with admin login auth, Splynx infers it from the token).
  const c = await tryJsonPost(
    "create comment (json)",
    `/api/2.0/admin/scheduling/tasks-comments`,
    {
      task_id: taskId,
      user_id: userId,
      comment: `[task-upater file-probe ${new Date().toISOString()}] please ignore — testing file attachment endpoints`,
    },
  );
  const commentId =
    c.data && typeof c.data === "object" && "id" in c.data ? Number((c.data as { id: number }).id) : null;
  console.log(`comment created: id=${commentId} status=${c.status}`);

  // Step 2: try the various file-upload paths people use across Splynx versions.
  await tryMultipartPost(
    "tasks-files (?task_id field)",
    `/api/2.0/admin/scheduling/tasks-files`,
    { task_id: String(taskId) },
    { name: "probe.pdf", type: "application/pdf", buf: tinyPdf },
  );

  await tryMultipartPost(
    "tasks/{id}/files",
    `/api/2.0/admin/scheduling/tasks/${taskId}/files`,
    {},
    { name: "probe.pdf", type: "application/pdf", buf: tinyPdf },
  );

  if (commentId) {
    await tryMultipartPost(
      "tasks-comments-files (?comment_id)",
      `/api/2.0/admin/scheduling/tasks-comments-files`,
      { comment_id: String(commentId) },
      { name: "probe.pdf", type: "application/pdf", buf: tinyPdf },
    );

    await tryMultipartPost(
      "tasks-comments/{id}/files",
      `/api/2.0/admin/scheduling/tasks-comments/${commentId}/files`,
      {},
      { name: "probe.pdf", type: "application/pdf", buf: tinyPdf },
    );

    await tryMultipartPost(
      "tasks-comments (multipart with comment+file)",
      `/api/2.0/admin/scheduling/tasks-comments`,
      {
        task_id: String(taskId),
        user_id: String(userId),
        comment: "[probe] multipart variant",
      },
      { name: "probe.pdf", type: "application/pdf", buf: tinyPdf },
    );
  }

  // Step 3: the generic "uploads" path some Splynx versions expose.
  await tryMultipartPost(
    "general /admin/files/files",
    `/api/2.0/admin/files/files`,
    { entity_type: "task", entity_id: String(taskId) },
    { name: "probe.pdf", type: "application/pdf", buf: tinyPdf },
  );

  await tryMultipartPost(
    "uploads (one-shot path)",
    `/api/2.0/admin/uploads`,
    { entity_type: "task", entity_id: String(taskId) },
    { name: "probe.pdf", type: "application/pdf", buf: tinyPdf },
  );

  // Step 4: refetch the comment to see whether ANY of the attempts above
  // succeeded in attaching a file to it.
  let refetched: unknown = null;
  if (commentId) {
    const r = await http.get(`/api/2.0/admin/scheduling/tasks-comments/${commentId}`);
    refetched = { status: r.status, data: r.data };
  }

  const out = { taskId, commentId, attempts, refetched };
  const outPath = path.join(process.cwd(), "splynx-files-probe.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

  console.log("\nattempts summary:");
  for (const a of attempts) {
    const ok = a.status >= 200 && a.status < 300;
    console.log(`  ${ok ? "✓" : "✗"} ${a.status}  ${a.method.padEnd(16)} ${a.url}  (${a.label})`);
  }
  console.log(`\nfull results: ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * Verify the attachment endpoints documented in the v2.0 spec actually
 * accept files on this self-hosted Splynx. Two POSTs:
 *   1. tasks-attachments (direct task attachment)
 *   2. tasks-comments with multipart files[] (comment + attachment in one call)
 *
 * Writes test rows on the live tenant — clean up afterwards.
 */

import axios from "axios";
import FormData from "form-data";

const baseUrl = process.env["SPLYNX_BASE_URL"]!;
const auth =
  "Basic " +
  Buffer.from(`${process.env["SPLYNX_API_KEY"]}:${process.env["SPLYNX_API_SECRET"]}`).toString("base64");
const taskId = Number(process.env["SPLYNX_PROBE_TASK_ID"] ?? 14967);
const userId = Number(process.env["SPLYNX_PROBE_USER_ID"] ?? 1);

const http = axios.create({
  baseURL: baseUrl.replace(/\/+$/, ""),
  timeout: 30_000,
  headers: { Authorization: auth },
  validateStatus: () => true,
});

const tinyPdf = Buffer.from(
  "%PDF-1.1\n1 0 obj<</Pages 2 0 R>>endobj 2 0 obj<</Kids[]/Count 0>>endobj trailer<</Root 1 0 R>>",
);

async function probeTaskAttachment() {
  const fd = new FormData();
  fd.append("task_id", String(taskId));
  fd.append("user_id", String(userId));
  // Spec calls it `files` and notes it's an array. Try the two common
  // multipart-array conventions.
  fd.append("files[]", tinyPdf, { filename: "probe-tasks-attachments.pdf", contentType: "application/pdf" });
  const r = await http.post(`/api/2.0/admin/scheduling/tasks-attachments`, fd, {
    headers: fd.getHeaders(),
    maxBodyLength: Infinity,
  });
  console.log(`POST tasks-attachments → ${r.status}`);
  console.log("  body:", JSON.stringify(r.data).slice(0, 500));
  return r.data;
}

async function probeCommentWithFile() {
  const fd = new FormData();
  fd.append("task_id", String(taskId));
  fd.append("user_id", String(userId));
  fd.append("comment", "[probe] comment + file via files[]");
  fd.append("files[]", tinyPdf, { filename: "probe-comment.pdf", contentType: "application/pdf" });
  const r = await http.post(`/api/2.0/admin/scheduling/tasks-comments`, fd, {
    headers: fd.getHeaders(),
    maxBodyLength: Infinity,
  });
  console.log(`POST tasks-comments (multipart files[]) → ${r.status}`);
  console.log("  body:", JSON.stringify(r.data).slice(0, 500));
  return r.data;
}

async function refetchComment(id: number) {
  const r = await http.get(`/api/2.0/admin/scheduling/tasks-comments/${id}`);
  console.log(`GET tasks-comments/${id} → ${r.status}`);
  console.log("  body:", JSON.stringify(r.data).slice(0, 500));
}

async function main() {
  await probeTaskAttachment();
  console.log("");
  const c = (await probeCommentWithFile()) as { id?: number };
  if (c?.id) {
    console.log("");
    await refetchComment(c.id);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

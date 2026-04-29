import type { ExternalSummary } from "../types.js";

/**
 * Formatters for outbound payloads (Splynx comment HTML, WhatsApp caption).
 *
 * These functions accept ExternalSummary only — never InternalRating. The
 * type-firewall guarantee: rating data physically cannot reach this module
 * via the function signatures, and the leak-test asserts at runtime that
 * rating-rationale strings never appear in the produced output.
 */

interface TaskSubset {
  id: number;
  title: string;
  address: string;
}

/**
 * Build the URL of a task in the Splynx admin UI. Splynx (modern versions)
 * runs as a hash-routed SPA so the path is `/admin#scheduling/tasks/{id}`.
 * If your tenant uses a different pattern, adjust this single function.
 */
export function splynxTaskUrl(splynxBaseUrl: string, taskId: number): string {
  return `${splynxBaseUrl.replace(/\/+$/, "")}/admin#scheduling/tasks/${taskId}`;
}

export function formatSplynxComment(
  summary: ExternalSummary,
  techName: string,
  isUpdate: boolean,
): string {
  const parts: string[] = [];
  if (isUpdate) {
    parts.push(`<em>[Updated by admin ${new Date().toLocaleString("en-ZA")}]</em><br><br>`);
  }
  parts.push(`<strong>${escapeHtml(summary.headline)}</strong>`);
  parts.push(`<br><em>Submitted by ${escapeHtml(techName)} via Task Updater</em>`);
  parts.push("<br><br>");
  parts.push(`<strong>What was done</strong><br>${nl2br(escapeHtml(summary.what_was_done))}`);
  if (summary.observations.trim()) {
    parts.push("<br><br>");
    parts.push(`<strong>Observations</strong><br>${nl2br(escapeHtml(summary.observations))}`);
  }
  if (summary.follow_ups.trim()) {
    parts.push("<br><br>");
    parts.push(`<strong>Follow-ups</strong><br>${nl2br(escapeHtml(summary.follow_ups))}`);
  }
  return parts.join("");
}

/**
 * Short WhatsApp caption: headline, location, tech, and a link to the task
 * in Splynx. The attached PDF carries the full report — keep this brief so
 * the message is glanceable in the group feed.
 */
export function formatWhatsAppCaption(
  summary: ExternalSummary,
  task: TaskSubset,
  techName: string,
  splynxBaseUrl: string,
): string {
  const lines: string[] = [];
  lines.push(`*${summary.headline}*`);
  if (task.address) lines.push(`📍 ${task.address}`);
  lines.push(`Task #${task.id}  •  ${techName}`);
  lines.push("");
  lines.push(`🔗 ${splynxTaskUrl(splynxBaseUrl, task.id)}`);
  return lines.join("\n");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function nl2br(s: string): string {
  return s.replace(/\n/g, "<br>");
}

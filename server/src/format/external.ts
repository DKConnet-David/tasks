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
 * Build the URL of a task in the Splynx admin UI.
 * Verified against clientzone.dkconnect.co.za 2026-04-29:
 *   /admin/scheduling/tasks/view?id=<id>
 */
export function splynxTaskUrl(splynxBaseUrl: string, taskId: number): string {
  return `${splynxBaseUrl.replace(/\/+$/, "")}/admin/scheduling/tasks/view?id=${taskId}`;
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

  const overviewItems = overviewLines(summary.overview);
  if (overviewItems.length > 0) {
    parts.push("<br><br><strong>Job/Task Overview</strong>");
    for (const [label, value] of overviewItems) {
      parts.push(`<br>• <strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}`);
    }
  }

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
 * WhatsApp caption: headline, the same Job/Task Overview that opens the
 * PDF, and a link straight to the task in Splynx. The attached PDF still
 * carries the full report (work completed / photos analysis / materials /
 * issues+notes), but this gives the group enough overview at a glance.
 *
 * `customerLogin` is the Splynx customer.login (e.g. "ANJA001"). Pass null
 * if the customer record is unavailable — the Account bullet is then
 * skipped rather than rendered as "Account: —".
 *
 * `submittedAt` is the actual moment the tech hit submit. Pass null to
 * skip the bullet entirely (legacy / synthetic captions). The pipeline
 * call site passes `new Date()`; the admin resend path passes the
 * submission's original `created_at` so resends keep the original
 * timestamp rather than re-stamping to "now".
 */
export function formatWhatsAppCaption(
  summary: ExternalSummary,
  task: TaskSubset,
  techName: string,
  splynxBaseUrl: string,
  customerLogin: string | null,
  submittedAt: Date | null,
): string {
  const lines: string[] = [];
  lines.push(`*${summary.headline}*`);

  // Technician sits at the top of the bullets (the "who" submitted the
  // job, naturally heads the overview). Account sits at the bottom — it's
  // the back-office identifier for the customer, useful but not the lead
  // detail. Both are WhatsApp-only: inside Splynx the customer record is
  // already on screen, so adding them to the Splynx comment is redundant.
  const techNameTrim = techName.trim();
  const accountTrim = (customerLogin ?? "").trim();
  const overviewItems = overviewLines(summary.overview);
  const submittedLabel = submittedAt ? formatSubmittedAt(submittedAt) : "";

  if (overviewItems.length > 0 || techNameTrim || accountTrim || submittedLabel) {
    lines.push("");
    lines.push("*Job/Task Overview*");
    // Tech name is wrapped in WhatsApp's *bold* markers so the operator's
    // eye lands on the name itself when scanning a group of bullets.
    if (techNameTrim) lines.push(`• Technician: *${techNameTrim}*`);
    for (const [label, value] of overviewItems) {
      lines.push(`• ${label}: ${value}`);
    }
    if (submittedLabel) lines.push(`• Submitted at: ${submittedLabel}`);
    if (accountTrim) lines.push(`• Account: ${accountTrim}`);
  } else if (task.address) {
    // Fallback for legacy summaries with no overview at all.
    lines.push(`📍 ${task.address}`);
    lines.push(`Task #${task.id}  •  ${techName}`);
  }

  lines.push("");
  lines.push(`🔗 ${splynxTaskUrl(splynxBaseUrl, task.id)}`);
  return lines.join("\n");
}

/**
 * Render a Date as `YYYY-MM-DD HH:MM` in the container's local timezone.
 * The container's `TZ` env var (Africa/Johannesburg in production) drives
 * the field accessors here, so the output matches what the operator
 * sees on the wall clock. Same shape as the AI-generated `Date:` bullet
 * so WhatsApp's auto-styling treats it consistently.
 */
function formatSubmittedAt(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Build the Job/Task Overview bullet list shared between the Splynx comment
 * and the WhatsApp caption. Empty fields are skipped, so legacy submissions
 * (where the AI didn't fill the overview) just get an empty list back.
 */
function overviewLines(
  overview: ExternalSummary["overview"],
): [label: string, value: string][] {
  const out: [string, string][] = [];
  const push = (label: string, value: string | undefined) => {
    if (value && value.trim()) out.push([label, value.trim()]);
  };
  push("Service type", overview.service_type);
  push("Client", overview.client_name);
  push("Location", overview.location);
  push("Date", overview.job_date);
  push("Job Start Time", overview.job_start_time);
  push("Job End Time", overview.job_end_time);
  push("Job Duration", overview.job_duration);
  return out;
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

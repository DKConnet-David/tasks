import type { ExternalSummary, JobCardCheck } from "../types.js";

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
  secondaryTechNames?: string[],
  stockNotes?: string,
): string {
  const parts: string[] = [];
  if (isUpdate) {
    parts.push(`<em>[Updated by admin ${new Date().toLocaleString("en-ZA")}]</em><br><br>`);
  }
  parts.push(`<strong>${escapeHtml(summary.headline)}</strong>`);
  const helpers = (secondaryTechNames ?? []).map((s) => s.trim()).filter(Boolean);
  const withClause = helpers.length > 0 ? ` with ${escapeHtml(helpers.join(", "))}` : "";
  parts.push(`<br><em>Submitted by ${escapeHtml(techName)}${withClause} via Task Updater</em>`);

  // Verbatim "Stock used" block, rendered in red so the office can pick
  // it out at a glance for invoice reconciliation. Sits below the
  // attribution line and above the Job/Task Overview. Skipped silently
  // when the tech left the field blank — the AI-extracted materials in
  // the body still cover the no-stock case.
  const stockTrim = (stockNotes ?? "").trim();
  if (stockTrim) {
    parts.push(
      `<br><br><strong style="color:#c5221f">Stock used</strong>` +
        `<br><span style="color:#c5221f">${nl2br(escapeHtml(stockTrim))}</span>`,
    );
  }

  const overviewItems = overviewLines(summary.overview);
  if (overviewItems.length > 0) {
    parts.push("<br><br><strong>Job/Task Overview</strong>");
    for (const [label, value] of overviewItems) {
      parts.push(`<br>• <strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}`);
    }
  }

  const flags = deriveJobCardFlags(summary.job_card);
  if (flags.length > 0) {
    parts.push("<br><br><strong>🚩 Flags</strong>");
    for (const f of flags) {
      parts.push(`<br>• ${escapeHtml(f)}`);
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
  secondaryTechNames?: string[],
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
  // Helpers ride alongside the primary tech bullet, rendered in italics so
  // the primary name still leads visually. Empty / disabled / unknown names
  // are filtered upstream — we trust the array we receive.
  const helpers = (secondaryTechNames ?? []).map((s) => s.trim()).filter(Boolean);
  const techLineSuffix = helpers.length > 0 ? ` _(with ${helpers.join(", ")})_` : "";

  if (overviewItems.length > 0 || techNameTrim || accountTrim || submittedLabel) {
    lines.push("");
    lines.push("*Job/Task Overview*");
    // Tech name is wrapped in WhatsApp's *bold* markers so the operator's
    // eye lands on the name itself when scanning a group of bullets.
    if (techNameTrim) lines.push(`• Technician: *${techNameTrim}*${techLineSuffix}`);
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

  const flags = deriveJobCardFlags(summary.job_card);
  if (flags.length > 0) {
    lines.push("");
    lines.push("*🚩 Flags*");
    for (const f of flags) {
      lines.push(`• ${f}`);
    }
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
/**
 * Derive the "🚩 Flags" bullet list from the AI's job-card check.
 *
 * Returns an empty list when the check is missing (legacy submissions
 * predating the field) so the Flags block is silently omitted in those
 * cases. New submissions always populate `job_card`, so an empty list
 * here means "card is fine, signature visible, both Y answers" — which
 * is the desired no-flag state.
 *
 * Exported so the PDF generator and the admin UI render exactly the
 * same flag text as the WhatsApp / Splynx outputs.
 */
export function deriveJobCardFlags(check: JobCardCheck | undefined): string[] {
  if (!check) return [];
  if (!check.job_card_found) {
    // No card photographed at all — the rest of the fields are unreliable
    // by definition, so we don't pile on. One clear flag is enough.
    return ["No job card photo found"];
  }
  const flags: string[] = [];
  if (!check.customer_signature_present) {
    flags.push("No customer signature on job card");
  }
  if (check.workmanship_satisfaction === "N") {
    flags.push("Workmanship marked N on job card");
  }
  if (check.work_satisfaction === "N") {
    flags.push("Customer not satisfied with work (marked N on job card)");
  }
  return flags;
}

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

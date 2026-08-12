import type Database from "better-sqlite3";

/** Tiny key/value settings store backed by the SQLite `settings` table. */
export function getSetting(db: Database.Database, key: string): string | null {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setSetting(db: Database.Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, Date.now());
}

export function deleteSetting(db: Database.Database, key: string): void {
  db.prepare(`DELETE FROM settings WHERE key = ?`).run(key);
}

export const SettingKeys = {
  whatsappGroupJid: "whatsapp_group_jid",
  whatsappGroupName: "whatsapp_group_name",
  // Secondary group for Zoom-billable submissions (Fibre Install /
  // ONT Drop / Zoom Reinstall). When set, those submissions get a
  // second WhatsApp send to this group in addition to the default
  // group above. Missing / empty → no second send (soft fallback,
  // just a log warning). Non-Zoom-billable submissions ignore this
  // setting entirely.
  whatsappZoomGroupJid: "whatsapp_zoom_group_jid",
  whatsappZoomGroupName: "whatsapp_zoom_group_name",
  // "1" → AI evaluates the per-job-type requirements checklist on
  // every submission; result lives in submissions.requirements_check_json
  // and surfaces in the admin SubmissionDetail UI only. Anything else
  // (including absent) is treated as off. Default off so the extra
  // tokens-per-submission cost only kicks in when the operator opts in.
  requirementsCheckEnabled: "requirements_check_enabled",
  // "1" → an internal scheduler posts a "daily team summary" WhatsApp
  // message at 19:00 Africa/Johannesburg to the configured group.
  // Absent / "0" → no scheduled send. See server/src/scheduler/daily-summary.ts.
  dailySummaryEnabled: "daily_summary_enabled",
  // Sentinel: YYYY-MM-DD of the last day the scheduler successfully
  // sent the daily summary. Prevents double-sends across container
  // restarts and the once-a-minute interval check.
  dailySummaryLastSentDate: "daily_summary_last_sent_date",
  // Override the model used by the per-submission Quality rating call.
  // "" / absent → use config.CLAUDE_MODEL (currently Opus). "sonnet" →
  // claude-sonnet-4-6. Any other non-empty value is treated as a
  // literal model id (future-proofing for Haiku tests). Summarize and
  // every other AI call ignore this setting — only ratePerformance
  // reads it. Lets the operator A/B rating quality vs cost without
  // a redeploy.
  ratingModelOverride: "rating_model_override",
} as const;

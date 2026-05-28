import { z } from "zod";

/**
 * Type firewall — read this before changing.
 *
 * ExternalSummary is everything that can leave the system: PDF body, WhatsApp
 * caption, Splynx comment payload, response to the tech-side client.
 *
 * InternalRating is admin-only quality data. It must NEVER appear in any
 * function that produces external output. The PDF generator, WhatsApp sender,
 * and Splynx writeback all accept ExternalSummary only — there is no overload
 * or union that lets InternalRating reach them. The integration leak-test
 * (server/src/__tests__/leak.test.ts) re-checks this property at the
 * payload-string level so future refactors can't smuggle rating text out.
 */

/**
 * Per-submission analysis of the paper "job card" the customer signs on
 * site. Populated by the summarize AI step when it inspects the photos.
 *
 * This is OBSERVATIONAL data (signature visible, Y/N tick marks) — not
 * rating data — so it lives on ExternalSummary and is allowed to flow to
 * WhatsApp / Splynx / PDF. The flags derived from it are surfaced under
 * a "🚩 Flags" block on every external surface so the operator notices
 * unsigned cards or N answers without scrolling through all the photos.
 */
export const JobCardCheckSchema = z.object({
  // True only when a recognisable paper job card is visible in any photo.
  job_card_found: z.boolean(),
  // True only with a clearly visible signature on the signature line.
  // Default-to-false bias: ambiguous → flagged. Operator would rather get
  // a false positive than miss a missing signature.
  customer_signature_present: z.boolean(),
  // The two specific Y/N rows the operator wants enforced. "Y" only on a
  // clear yes mark; "N" only on a clear no mark; "unknown" for blank /
  // illegible / not visible.
  workmanship_satisfaction: z.enum(["Y", "N", "unknown"]),
  work_satisfaction: z.enum(["Y", "N", "unknown"]),
});
export type JobCardCheck = z.infer<typeof JobCardCheckSchema>;

export const JobOverviewSchema = z.object({
  service_type: z.string().default(""),
  client_name: z.string().default(""),
  location: z.string().default(""),
  job_date: z.string().default(""),
  job_start_time: z.string().default(""),
  job_end_time: z.string().default(""),
  job_duration: z.string().default(""),
});
export type JobOverview = z.infer<typeof JobOverviewSchema>;

// Closed enum the AI classifies each job into. Drives the "Duration vs
// benchmark by job type" panel on the tech performance dashboard. New
// categories must be added in lockstep with the dashboard's category
// dropdown — keep the list small.
export const JobTypeSchema = z
  .enum([
    "ftua_installation",
    "site_survey",
    "fibre_los_inspection",
    "layer2_fibre_setup",
    "extender_installation",
    "antenna_move",
    "offline_connection",
    "internal_issues_callout",
    "voip_installation",
    "complaint",
    "other",
    // Zoom-billable overrides. The AI never picks these — they are
    // only ever set by an allowlisted tech via the Zoom-billable
    // picker on the submit form. See ZOOM_BILLABLE_TYPES below.
    "zoom_fibre_install",
    "zoom_ont_drop",
    "zoom_reinstall",
  ])
  .default("other");

/**
 * Closed set of job types an allowlisted tech (techs.zoom_billable = 1)
 * can pick to override the AI's classification. Display labels mirror
 * the operator-facing dropdown on the tech submit form and the admin
 * dashboards. Kept here so the server-side validator + UI labels
 * stay in lockstep.
 */
export const ZOOM_BILLABLE_TYPES = [
  { value: "zoom_fibre_install", label: "Fibre Install" },
  { value: "zoom_ont_drop", label: "ONT Drop" },
  { value: "zoom_reinstall", label: "Zoom Reinstall" },
] as const;
export type ZoomBillableType = (typeof ZOOM_BILLABLE_TYPES)[number]["value"];
export type JobType = z.infer<typeof JobTypeSchema>;

/**
 * Per-requirement verdict from the AI requirements-coverage check.
 *
 * Admin-only data: the result blob lives in submissions.requirements_check_json
 * and surfaces in the admin SubmissionDetail UI only. It is intentionally
 * NOT a field on ExternalSummary so the type firewall keeps formatters
 * (which only accept ExternalSummary) from rendering it. The leak-test
 * doesn't need new fixtures because the data never reaches a formatter.
 *
 * `status` is a 3-state to encourage `unclear` over a confident wrong
 * `missing` during the calibration phase — see the prompt block in
 * summarize.ts.
 */
export const RequirementsItemSchema = z.object({
  requirement: z.string().min(1),
  status: z.enum(["found", "missing", "unclear"]),
  evidence: z.string().default(""),
});
export type RequirementsItem = z.infer<typeof RequirementsItemSchema>;

export const RequirementsCheckSchema = z.object({
  job_type: JobTypeSchema,
  items: z.array(RequirementsItemSchema),
});
export type RequirementsCheck = z.infer<typeof RequirementsCheckSchema>;

export const ExternalSummarySchema = z.object({
  // Short-form fields — used in the WhatsApp caption and Splynx comment
  // body, where prose flows better than bullet lists.
  headline: z.string().min(1).max(120),
  what_was_done: z.string().min(1),
  observations: z.string().default(""),
  follow_ups: z.string().default(""),

  // Structured-report fields — drive the PDF. Default to empty for legacy
  // submissions whose summary_json predates this field; the PDF renderer
  // skips empty sections.
  overview: JobOverviewSchema.default({
    service_type: "",
    client_name: "",
    location: "",
    job_date: "",
    job_start_time: "",
    job_end_time: "",
    job_duration: "",
  }),
  work_completed: z.array(z.string()).default([]),
  photo_descriptions: z.array(z.string()).default([]),
  materials: z.array(z.string()).default([]),
  issues_notes: z.array(z.string()).default([]),

  // AI-classified job type. Drives the per-tech performance dashboard's
  // "Duration vs Benchmark by job type" panel. Default "other" keeps
  // legacy submissions parseable.
  job_type: JobTypeSchema,

  // Short slug per photo, for Splynx attachment filenames.
  photo_captions: z.array(z.string()).default([]),

  // Job-card check (signature + Y/N answers). Optional so legacy
  // summary_json rows in the DB still parse cleanly — those just won't
  // have the Flags block rendered. New AI calls always populate this
  // (the tool schema in summarize.ts marks it required).
  job_card: JobCardCheckSchema.optional(),
});
export type ExternalSummary = z.infer<typeof ExternalSummarySchema>;

export const RatingDimensionsSchema = z.object({
  workmanship: z.number().int().min(1).max(10),
  photo_quality: z.number().int().min(1).max(10),
  completeness: z.number().int().min(1).max(10),
  communication: z.number().int().min(1).max(10),
});
export type RatingDimensions = z.infer<typeof RatingDimensionsSchema>;

export const InternalRatingSchema = z.object({
  score: z.number().int().min(1).max(10),
  // What the tech got right and what they should have done. Both arrays
  // are concise, action-oriented bullets — replaces the previous
  // free-form `rationale` paragraph. AI is constrained to ≤ 5 entries
  // each but typically returns 2–3.
  strengths: z.array(z.string().min(1)).max(5).default([]),
  improvements: z.array(z.string().min(1)).max(5).default([]),
  dimensions: RatingDimensionsSchema,
});
export type InternalRating = z.infer<typeof InternalRatingSchema>;

export interface SplynxTask {
  id: number;
  title: string;
  description?: string;
  status: string;
  customer_id?: number;
  customer_name?: string;
  address?: string;
  scheduled_at?: string;
  assigned_admin_id?: number;
  assigned_admin_login?: string;
}

export interface SessionData {
  id: string;
  app_login: string;
  splynx_admin_id: number;
  is_admin: boolean;
  created_at: number;
  expires_at: number;
}

export type SubmissionStatus = "success" | "partial" | "failed";

export interface SubmissionRow {
  id: number;
  task_id: number;
  splynx_user_id: number;
  splynx_login: string;
  source: "tech" | "manual";
  comment: string | null;
  tech_comment_override: string | null;
  summary_json: string | null;
  corrected_summary_json: string | null;
  splynx_comment_id: number | null;
  splynx_corrected_comment_id: number | null;
  splynx_pdf_file_id: number | null;
  wa_message_id: string | null;
  status: SubmissionStatus;
  error: string | null;
  admin_resolved: 0 | 1;
  created_at: number;
  updated_at: number;
}

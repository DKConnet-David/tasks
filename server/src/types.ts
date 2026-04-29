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

  // Short slug per photo, for Splynx attachment filenames.
  photo_captions: z.array(z.string()).default([]),
});
export type ExternalSummary = z.infer<typeof ExternalSummarySchema>;

export const RatingDimensionsSchema = z.object({
  workmanship: z.number().int().min(1).max(5),
  photo_quality: z.number().int().min(1).max(5),
  completeness: z.number().int().min(1).max(5),
  communication: z.number().int().min(1).max(5),
});
export type RatingDimensions = z.infer<typeof RatingDimensionsSchema>;

export const InternalRatingSchema = z.object({
  score: z.number().int().min(1).max(5),
  rationale: z.string().min(1),
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

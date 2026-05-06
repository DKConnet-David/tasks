/**
 * Splynx response shapes — locked to what the probe observed against
 * https://clientzone.dkconnect.co.za on 2026-04-29. See
 * docs/splynx-probe-findings.md for raw samples.
 */

export interface SplynxTaskRaw {
  id: number;
  title: string;
  address: string;
  gps: string;
  description: string;
  reporter_id: number;
  project_id: number;
  location_id: number;
  parent_task_id: number | null;
  related_customer_id: number | null;
  related_service_id: number | null;
  related_service_type: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string;
  /** "assigned_to_administrator" | "assigned_to_role" | ... */
  assigned_to: string;
  /** Admin id (when assigned_to == "assigned_to_administrator"). */
  assignee: number;
  assinged_at: string; // (sic — Splynx typo)
  priority: string;
  is_scheduled: "0" | "1";
  scheduled_from: string;
  travel_time_to: number;
  travel_time_from: number;
  checklist_template_id: number;
  workflow_status_id: number;
  is_archived: "0" | "1";
  closed: "0" | "1";
  partner_id: number;
  notification_send_interval: number;
  notification_enabled: "0" | "1";
  createdFromTicket: number | null;
  remaining: number | null;
  logged: number;
  last_status_changed: string;
  formatted_duration: string;
  additional_attributes: Record<string, unknown>;
  related_lead_id: number | null;
  related_tasks: unknown[];
  task_labels: { id: number; label: string; color: string }[];
}

export interface SplynxCommentRaw {
  id: number;
  task_id: number;
  user_id: number;
  comment: string;
  created_at: string;
  files: SplynxFileRef[];
  pinned_datetime: string;
  is_edited: "0" | "1";
  is_pinned: "0" | "1";
  admin_name: string;
}

export interface SplynxFileRef {
  id: number;
  filename?: string;
  url?: string;
  // Schema is best-guess until we observe a non-empty `files[]` from the live tenant.
}

/**
 * Customer record subset — only the fields we currently need. The full
 * record has dozens of billing/contact fields; we read just `login` (the
 * customer-facing account code) and `name` for fallback display.
 */
export interface SplynxCustomerRaw {
  id: number;
  login: string;
  name: string;
}

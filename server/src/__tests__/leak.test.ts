import { describe, expect, it } from "vitest";
import { generatePdf } from "../pdf/generate.js";
import { formatSplynxComment, formatWhatsAppCaption } from "../format/external.js";
import type { ExternalSummary, InternalRating } from "../types.js";
import type { SplynxTaskRaw } from "../splynx/types.js";

/**
 * Integration leak-test for the rating containment guarantee.
 *
 * The contract: InternalRating data (admin-only, internal-only) must never
 * appear in any external payload — PDF, WhatsApp caption, or Splynx comment.
 *
 * The TypeScript type firewall already prevents the rating from being passed
 * into any of these formatters. This test is the runtime backstop: it picks
 * highly-distinctive rationale phrases, runs the same shapes through the
 * external formatters, and asserts those phrases do not appear in any output.
 *
 * If this test ever fails, do NOT just delete it — find what changed in the
 * formatters or PDF that made rating data leak through.
 */

const summary: ExternalSummary = {
  headline: "Router replaced and tested at Alex Alarms",
  what_was_done: "Replaced the existing TOTOLINK with the EW3000GX. Tested speeds with the customer on site.",
  observations: "Smoking-area room added a second EW3000GX for coverage.",
  follow_ups: "Confirm billing for two routers; David flagged it as billable.",
  overview: {
    service_type: "Router replacement",
    client_name: "Alex Alarms",
    location: "138 Main Rd, St Helena Bay",
    job_date: "2026-04-29",
    job_start_time: "12:45",
    job_end_time: "13:40",
    job_duration: "55m",
  },
  work_completed: [
    "EW3000GX router installed and configured",
    "Speeds tested with customer on site",
  ],
  photo_descriptions: [
    "Customer router before replacement showing serial number",
    "EW3000GX powered up at customer site",
  ],
  materials: ["Reyee EW3000GX router"],
  issues_notes: ["No issues encountered"],
  job_type: "call_out",
  photo_captions: [
    "router-before-replacement",
    "ew3000gx-powered-up",
  ],
};

// These strings are deliberately distinctive so their presence in any
// formatter output (or the PDF buffer) is unambiguous.
const RATING_RATIONALE_NEEDLE = "_LEAK_TEST_RATIONALE_canary_phrase_42";
const ADMIN_NEEDLE = "_LEAK_TEST_ADMIN_canary_42";
const PATTERN_NEEDLE = "_LEAK_TEST_PATTERN_canary_99";

// Synthetic pattern result mirroring what server/src/ai/patterns.ts
// produces. Pattern data is admin-only (stored in tech_patterns, served
// only behind requireAdmin) — this fixture exists purely to assert at
// runtime that the formatters cannot accidentally include it.
const pattern = {
  strengths: [
    { title: "Strong cable management", evidence: `Cable runs were tidy across all jobs.` },
  ],
  issues: [
    {
      title: "Missing labelling",
      evidence: `Admin flagged this with note ${PATTERN_NEEDLE}.`,
      frequency: "4 of 8 jobs",
    },
  ],
  coaching: [`Ask the tech to ${PATTERN_NEEDLE} on outdoor APs.`],
  summary: `Overall ${PATTERN_NEEDLE} performance is good.`,
};

const rating: InternalRating = {
  score: 6,
  rationale: `Photos look fine but ${RATING_RATIONALE_NEEDLE}; missed labelling on the patch panel.`,
  dimensions: { workmanship: 6, photo_quality: 8, completeness: 4, communication: 8 },
};

const task: SplynxTaskRaw = {
  id: 14967,
  title: "Router replacement",
  address: "138 Main Rd Laingville St Helena Bay 7380",
  gps: "-32.78886,18.06364",
  description: "<p>Test description</p>",
  reporter_id: 7,
  project_id: 6,
  location_id: 2,
  parent_task_id: null,
  related_customer_id: 8,
  related_service_id: null,
  related_service_type: null,
  created_at: "2026-04-29 10:00:00",
  updated_at: "2026-04-29 10:00:00",
  resolved_at: "0000-00-00 00:00:00",
  assigned_to: "assigned_to_administrator",
  assignee: 7,
  assinged_at: "2026-04-29 10:00:00",
  priority: "priority_medium",
  is_scheduled: "1",
  scheduled_from: "2026-04-29 10:00:00",
  travel_time_to: 0,
  travel_time_from: 0,
  checklist_template_id: 0,
  workflow_status_id: 25,
  is_archived: "0",
  closed: "0",
  partner_id: 1,
  notification_send_interval: 0,
  notification_enabled: "1",
  createdFromTicket: null,
  remaining: null,
  logged: 0,
  last_status_changed: "2026-04-29 10:00:00",
  formatted_duration: "1h",
  additional_attributes: {},
  related_lead_id: null,
  related_tasks: [],
  task_labels: [],
};

describe("rating containment (leak test)", () => {
  // We deliberately don't test for words like "score" or "rating" or for the
  // raw score digit — they can appear legitimately in summary text (e.g.
  // "EW3000GX") and would create false positives. The distinctive needle
  // phrases are sufficient; if they show up, the formatter has been changed
  // to include rating data.

  it("Splynx comment HTML never includes rating rationale phrases", () => {
    const html = formatSplynxComment(summary, "lorenzo", false);
    expect(html).not.toContain(RATING_RATIONALE_NEEDLE);
    expect(html).not.toContain(ADMIN_NEEDLE);
    expect(html).not.toContain(rating.rationale);
  });

  it("Splynx comment HTML (admin update variant) never includes rating data", () => {
    const html = formatSplynxComment(summary, "lorenzo", true);
    expect(html).not.toContain(RATING_RATIONALE_NEEDLE);
    expect(html).not.toContain(ADMIN_NEEDLE);
    expect(html).not.toContain(rating.rationale);
  });

  it("WhatsApp caption never includes rating rationale phrases", () => {
    const caption = formatWhatsAppCaption(
      summary,
      task,
      "lorenzo",
      "https://clientzone.dkconnect.co.za",
      "ANJA001",
    );
    expect(caption).not.toContain(RATING_RATIONALE_NEEDLE);
    expect(caption).not.toContain(ADMIN_NEEDLE);
    expect(caption).not.toContain(rating.rationale);
  });

  it("formatters never include pattern-detection output", () => {
    // Patterns are admin-only data produced by ai/patterns.ts. The type
    // firewall already prevents them reaching the formatters at compile
    // time (formatters only accept ExternalSummary). This is the runtime
    // backstop: every distinctive string from the synthetic pattern
    // fixture must be absent from every external formatter's output.
    const html = formatSplynxComment(summary, "lorenzo", false);
    const htmlUpdate = formatSplynxComment(summary, "lorenzo", true);
    const caption = formatWhatsAppCaption(
      summary,
      task,
      "lorenzo",
      "https://clientzone.dkconnect.co.za",
      "ANJA001",
    );
    const allOutputs = [html, htmlUpdate, caption].join("\n");

    expect(allOutputs).not.toContain(PATTERN_NEEDLE);
    for (const s of pattern.strengths) expect(allOutputs).not.toContain(s.evidence);
    for (const i of pattern.issues) {
      expect(allOutputs).not.toContain(i.evidence);
      expect(allOutputs).not.toContain(i.frequency);
    }
    for (const c of pattern.coaching) expect(allOutputs).not.toContain(c);
    expect(allOutputs).not.toContain(pattern.summary);
  });

  it("PDF buffer never contains rating rationale phrases", async () => {
    const pdf = await generatePdf({
      task,
      summary,
      comment: "Replaced router, tested speed, customer happy.",
      photos: [],
      techName: "lorenzo",
      submittedAt: new Date(),
    });
    const text = pdf.toString("binary");
    expect(text).not.toContain(RATING_RATIONALE_NEEDLE);
    expect(text).not.toContain(ADMIN_NEEDLE);
    expect(text).not.toContain(PATTERN_NEEDLE);
    expect(text).not.toContain(pattern.summary);
    for (const i of pattern.issues) expect(text).not.toContain(i.evidence);
    for (const c of pattern.coaching) expect(text).not.toContain(c);
  });

  it("type firewall: ExternalSummary cannot be cast to InternalRating", () => {
    // This is a documented invariant — the test asserts at the type level
    // that the two are not assignable. If you ever see this test fail at
    // tsc-time you've removed the structural distinction between the types.
    type ShouldBeNever = ExternalSummary extends InternalRating ? "leak" : "ok";
    const guard: ShouldBeNever = "ok";
    expect(guard).toBe("ok");
  });
});

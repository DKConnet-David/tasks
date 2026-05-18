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
  job_type: "ftua_installation",
  photo_captions: [
    "router-before-replacement",
    "ew3000gx-powered-up",
  ],
  job_card: {
    job_card_found: true,
    customer_signature_present: true,
    workmanship_satisfaction: "Y",
    work_satisfaction: "Y",
  },
};

// These strings are deliberately distinctive so their presence in any
// formatter output (or the PDF buffer) is unambiguous.
const RATING_RATIONALE_NEEDLE = "_LEAK_TEST_RATIONALE_canary_phrase_42";
const ADMIN_NEEDLE = "_LEAK_TEST_ADMIN_canary_42";
const PATTERN_NEEDLE = "_LEAK_TEST_PATTERN_canary_99";
const STRENGTH_NEEDLE = "_LEAK_TEST_STRENGTH_canary_77";
const IMPROVEMENT_NEEDLE = "_LEAK_TEST_IMPROVEMENT_canary_88";

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
  strengths: [
    `Photos cover the install end-to-end ${STRENGTH_NEEDLE}.`,
    `Asset tag visible on the device.`,
  ],
  improvements: [
    `Patch panel was unlabelled ${IMPROVEMENT_NEEDLE}; document on next visit.`,
    `${RATING_RATIONALE_NEEDLE} no after-shot of the rack door closed.`,
  ],
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

  function expectNoRatingLeak(output: string): void {
    expect(output).not.toContain(RATING_RATIONALE_NEEDLE);
    expect(output).not.toContain(ADMIN_NEEDLE);
    expect(output).not.toContain(STRENGTH_NEEDLE);
    expect(output).not.toContain(IMPROVEMENT_NEEDLE);
    for (const s of rating.strengths) expect(output).not.toContain(s);
    for (const i of rating.improvements) expect(output).not.toContain(i);
  }

  it("Splynx comment HTML never includes rating data", () => {
    expectNoRatingLeak(formatSplynxComment(summary, "lorenzo", false));
  });

  it("Splynx comment HTML (admin update variant) never includes rating data", () => {
    expectNoRatingLeak(formatSplynxComment(summary, "lorenzo", true));
  });

  it("WhatsApp caption never includes rating data", () => {
    const caption = formatWhatsAppCaption(
      summary,
      task,
      "lorenzo",
      "https://clientzone.dkconnect.co.za",
      "ANJA001",
      new Date("2026-04-29T12:45:00+02:00"),
    );
    expectNoRatingLeak(caption);
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
      new Date("2026-04-29T12:45:00+02:00"),
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

  it("PDF buffer never contains rating or pattern data", async () => {
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
    expect(text).not.toContain(STRENGTH_NEEDLE);
    expect(text).not.toContain(IMPROVEMENT_NEEDLE);
    for (const s of rating.strengths) expect(text).not.toContain(s);
    for (const i of rating.improvements) expect(text).not.toContain(i);
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

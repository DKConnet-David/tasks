import Anthropic from "@anthropic-ai/sdk";
import type { AppConfig } from "../config.js";
import { ExternalSummarySchema, type ExternalSummary } from "../types.js";
import type { SplynxTaskRaw } from "../splynx/types.js";

interface SummarizeArgs {
  config: AppConfig;
  task: SplynxTaskRaw;
  comment: string;
  photoBuffers: Buffer[];
  techName: string;
}

const SYSTEM_PROMPT = `You are a senior field-tech ops analyst at a small ISP / WISP. Your output drives:
1. A WhatsApp group post — uses the SHORT fields (headline, what_was_done, observations, follow_ups).
2. The Splynx ticket comment — uses the same short fields.
3. The PDF Job Completion Summary report — uses the STRUCTURED fields (overview, work_completed, photo_descriptions, materials, issues_notes).

Tone everywhere: plain South African English. Factual, direct. No emoji. No markdown formatting inside field values. Do not invent details that aren't visible in the photos or stated in the tech's notes / task context.

You MUST call the save_summary tool. Fields:

SHORT (for WhatsApp caption + Splynx comment text):
- headline: ≤80 chars, single sentence summarising the outcome (e.g. "Wireless install completed at Theodore Arendse, Hopefield").
- what_was_done: 2–4 sentences of prose covering the actual work performed.
- observations: site conditions, customer requests, etc. Empty string if none.
- follow_ups: action items / billing notes / things needing attention. Empty string if none.

STRUCTURED (drive the PDF report):
- overview: an object with service_type, client_name, location, job_date, job_start_time, job_end_time, job_duration.
  - service_type, client_name, location: pull from the task title / description / customer info.
  - job_date: fine to pull from any source — Splynx's scheduled date is acceptable here, this is just calendar context.
  - job_start_time, job_end_time, job_duration: STRICT RULE — fill these ONLY when the actual on-site times are explicitly readable from a photo (typically a job card / sign-off sheet showing something like "Start 09:20 / End 17:30 / Duration 8h 10min"). The Splynx **scheduled** time and Splynx-recorded **estimated duration** are NOT actual times — they describe what was planned, not what happened — and must NEVER be used to populate these three fields. If no photo shows the actual times, return empty strings ("") for all three. If a photographed job card and any other source disagree, the job card wins.
- work_completed: an ARRAY of bullet-list items naming each major piece of work performed. 6–12 short items typically. Examples: "LiteBeam 5AC antenna installed and configured", "Speed testing performed and verified", "All equipment functioning properly".
- photo_descriptions: an ARRAY with EXACTLY one item per photo, in upload order. Each item is a single sentence describing what the photo shows in detail — include specific numbers, equipment models, readings, or names visible in the image. Examples: "Network speed test showing 64.90 Mbps download, 27.10 Mbps upload", "EW300-PRO router packaging with serial number visible", "Outdoor antenna installation on pole mount". This array is also used to derive Splynx attachment filenames, so the first 5–8 words of each description should be informative.
- materials: an ARRAY of equipment / materials used (one per item). Include model numbers and pricing where shown. Examples: "LiteBeam 5AC outdoor antenna (LBAC 23-FTUA)", "Reyee EW300-PRO router (R 500.00)", "Pole mounting hardware".
- issues_notes: an ARRAY of any issues encountered, deviations, or notable observations. Examples: "Client not on site during completion", "Client told people on the yard where technician mounted router". Empty array if there's nothing remarkable.

- job_card: an object with the four fields below, ALWAYS populated. Inspect every photo carefully looking for a paper "job card" form. The DK Connect job card has a header row of checkboxes (New Install / Takeover Install / Relocation / Repair / Additional / SS), customer details, a parts/items table, a "Notes" section, and at the bottom a "To be completed by client" section with three Y/N rows and a signature line.
  - job_card_found (boolean): true ONLY when you can clearly see this form (or an equivalent paper job card) in any photo. False if no card is visible.
  - customer_signature_present (boolean): true ONLY when there is a clearly visible handwritten signature, scribble, printed name, or X mark on the customer signature line at the bottom of the card. If the line is blank, the area is cropped out, or the signature is illegible/uncertain, return false. Bias to false on any doubt — the operator wants false positives over missed unsigned cards.
  - workmanship_satisfaction ("Y" | "N" | "unknown"): read the row labelled "Is the quality of workmanship to your satisfaction?" Return "Y" only on a clear yes mark (Y / ✓ / yes / tick); "N" only on a clear no mark (N / ✗ / no / cross); "unknown" when blank, illegible, or not visible.
  - work_satisfaction ("Y" | "N" | "unknown"): same rules, for the row labelled "Are you satisfied with the work that has been done and requested?"
  When job_card_found is false, set the other three fields to false / "unknown" — do not guess.

- job_type: classify the job into ONE of these categories. Pick the best fit:
  - "install"            new wireless / fibre install at a new client site
  - "call_out"           reactive support visit to fix something for an existing client (slow, no link, equipment fault)
  - "upgrade"            existing client moves to better hardware / faster package
  - "cable_replacement"  repairing or replacing damaged / aged cable runs
  - "maintenance"        scheduled preventative work (firmware, cleanup, audits)
  - "diagnostic"         purely investigative visit, no work performed
  - "other"              genuinely doesn't fit any of the above
  Decide from the task title, description, and photos. If genuinely ambiguous between two, prefer the more specific one over "other".

CRITICAL: photo_descriptions MUST contain exactly the same number of entries as the number of photos provided. Never short the array — if a photo is unclear, write what you can see ("Equipment closeup, content unclear") rather than skipping it.

Reason from the photos and the tech's notes; the Splynx task description is supplementary context (it describes what was scheduled, not necessarily what happened).`;

export async function summarize(args: SummarizeArgs): Promise<ExternalSummary> {
  const client = new Anthropic({ apiKey: args.config.ANTHROPIC_API_KEY });

  const photoBlocks = args.photoBuffers.map(
    (buf) =>
      ({
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: "image/jpeg" as const,
          data: buf.toString("base64"),
        },
      }),
  );

  const cleanDescription = args.task.description
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2000);

  const contextText = [
    `Task: ${args.task.title}`,
    `Site / address: ${args.task.address || "(not set)"}`,
    `Scheduled (NOT the actual start time — do not copy into job_start_time): ${args.task.scheduled_from && args.task.scheduled_from !== "0000-00-00 00:00:00" ? args.task.scheduled_from : "(no date)"}`,
    `Estimated duration in Splynx (NOT the actual duration — do not copy into job_duration): ${args.task.formatted_duration || "(not recorded)"}`,
    `Technician on site: ${args.techName}`,
    "",
    `Tech's notes (verbatim): ${args.comment.trim() || "(no notes provided)"}`,
    "",
    `Splynx task description (for context):`,
    cleanDescription || "(empty)",
    "",
    `Now produce the structured job completion summary using save_summary.`,
  ].join("\n");

  // 30 photos × ~80 tokens of description each + the rest of the structured
  // fields can run past 3k easily. 8192 is plenty without being wasteful.
  const response = await client.messages.create({
    model: args.config.CLAUDE_MODEL,
    max_tokens: 8192,
    system: SYSTEM_PROMPT,
    tools: [
      {
        name: "save_summary",
        description: "Save the structured job summary.",
        input_schema: {
          type: "object",
          properties: {
            headline: { type: "string" },
            what_was_done: { type: "string" },
            observations: { type: "string" },
            follow_ups: { type: "string" },
            overview: {
              type: "object",
              properties: {
                service_type: { type: "string" },
                client_name: { type: "string" },
                location: { type: "string" },
                job_date: { type: "string" },
                job_start_time: { type: "string" },
                job_end_time: { type: "string" },
                job_duration: { type: "string" },
              },
              required: [
                "service_type",
                "client_name",
                "location",
                "job_date",
                "job_start_time",
                "job_end_time",
                "job_duration",
              ],
            },
            work_completed: { type: "array", items: { type: "string" } },
            photo_descriptions: { type: "array", items: { type: "string" } },
            materials: { type: "array", items: { type: "string" } },
            issues_notes: { type: "array", items: { type: "string" } },
            job_type: {
              type: "string",
              enum: [
                "install",
                "call_out",
                "upgrade",
                "cable_replacement",
                "maintenance",
                "diagnostic",
                "other",
              ],
            },
            job_card: {
              type: "object",
              properties: {
                job_card_found: { type: "boolean" },
                customer_signature_present: { type: "boolean" },
                workmanship_satisfaction: {
                  type: "string",
                  enum: ["Y", "N", "unknown"],
                },
                work_satisfaction: {
                  type: "string",
                  enum: ["Y", "N", "unknown"],
                },
              },
              required: [
                "job_card_found",
                "customer_signature_present",
                "workmanship_satisfaction",
                "work_satisfaction",
              ],
            },
          },
          required: [
            "headline",
            "what_was_done",
            "observations",
            "follow_ups",
            "overview",
            "work_completed",
            "photo_descriptions",
            "materials",
            "issues_notes",
            "job_type",
            "job_card",
          ],
        },
      },
    ],
    tool_choice: { type: "tool", name: "save_summary" },
    messages: [
      {
        role: "user",
        content: [...photoBlocks, { type: "text", text: contextText }],
      },
    ],
  });

  const toolUse = response.content.find((c) => c.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("Claude did not return a tool_use block");
  }
  const parsed = ExternalSummarySchema.parse(toolUse.input);

  // Defensive: ensure photo_descriptions length exactly matches the photo
  // count. Pad with a clearly-marked fallback so the operator can spot any
  // truncation in the produced report rather than seeing silent gaps.
  const expected = args.photoBuffers.length;
  if (parsed.photo_descriptions.length !== expected) {
    const fixed: string[] = [];
    for (let i = 0; i < expected; i++) {
      fixed.push(parsed.photo_descriptions[i] ?? `(no description generated for photo ${i + 1})`);
    }
    parsed.photo_descriptions = fixed;
  }

  // photo_captions is no longer asked from Claude — we derive it from
  // photo_descriptions for backwards compatibility with code paths that
  // still read .photo_captions.
  parsed.photo_captions = parsed.photo_descriptions.map((desc) =>
    desc.replace(/^[^A-Za-z0-9]+/, "").slice(0, 60),
  );

  // Defensive guard against the AI lifting Splynx scheduled values into
  // the actual-time fields. Prompt should prevent this — the guard catches
  // any drift or future regressions. See docs/plan for context.
  scrubFabricatedTimes(parsed.overview, args.task);

  return parsed;
}

function scrubFabricatedTimes(
  overview: ExternalSummary["overview"],
  task: SummarizeArgs["task"],
): void {
  const scheduledHHMM = extractHHMM(task.scheduled_from);
  if (
    overview.job_start_time &&
    scheduledHHMM &&
    overview.job_start_time.replace(/\s/g, "") === scheduledHHMM
  ) {
    console.warn(
      `[summarize] guard fired: job_start_time matched Splynx scheduled time (${scheduledHHMM}); blanking. Task ${task.id}.`,
    );
    overview.job_start_time = "";
    // If start was just a copy of the scheduled time, end and duration are
    // almost certainly invented from the same scheduled+formatted_duration
    // pair. Blank both rather than leave a misleading orphan.
    overview.job_end_time = "";
    overview.job_duration = "";
    return;
  }
  if (
    overview.job_duration &&
    task.formatted_duration &&
    normaliseDuration(overview.job_duration) === normaliseDuration(task.formatted_duration)
  ) {
    console.warn(
      `[summarize] guard fired: job_duration matched Splynx formatted_duration (${task.formatted_duration}); blanking. Task ${task.id}.`,
    );
    overview.job_duration = "";
  }
}

function extractHHMM(splynxDateTime: string): string | null {
  // Splynx stores datetimes as "YYYY-MM-DD HH:MM:SS"; "0000-00-00 00:00:00"
  // means unset.
  if (!splynxDateTime || splynxDateTime.startsWith("0000")) return null;
  const match = splynxDateTime.match(/(\d{2}):(\d{2})/);
  return match ? `${match[1]}:${match[2]}` : null;
}

function normaliseDuration(s: string): string {
  // "1h" / "1 hour" / "1hour" all collapse to "1h" for comparison.
  return s
    .toLowerCase()
    .replace(/\bhours?\b/g, "h")
    .replace(/\bminutes?\b|\bmins?\b/g, "m")
    .replace(/\s+/g, "")
    .trim();
}

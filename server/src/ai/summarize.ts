import Anthropic from "@anthropic-ai/sdk";
import type { AppConfig } from "../config.js";
import {
  ExternalSummarySchema,
  RequirementsCheckSchema,
  type ExternalSummary,
  type RequirementsCheck,
} from "../types.js";
import type { SplynxTaskRaw } from "../splynx/types.js";
import { JOB_TYPE_REQUIREMENTS } from "../jobtypes/requirements.js";

interface SummarizeArgs {
  config: AppConfig;
  task: SplynxTaskRaw;
  comment: string;
  /**
   * Free-text "stock used" the tech typed in a separate field. The AI
   * is instructed to roll these items into the materials array with
   * codes preserved verbatim. Empty when blank.
   */
  stockNotes?: string;
  photoBuffers: Buffer[];
  techName: string;
  secondaryTechNames?: string[];
  /**
   * When true, the AI also produces a requirements-coverage check
   * against the per-job-type checklist. Result is returned alongside
   * the summary; never reaches WhatsApp / Splynx / PDF. Default false
   * so the extra tokens are only spent when the operator opts in.
   */
  requirementsCheckEnabled?: boolean;
}

export interface SummarizeResult {
  summary: ExternalSummary;
  requirementsCheck: RequirementsCheck | null;
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
- materials: an ARRAY of equipment / materials used (one per item). Include model numbers and pricing where shown. Examples: "LiteBeam 5AC outdoor antenna (LBAC 23-FTUA)", "Reyee EW300-PRO router (R 500.00)", "Pole mounting hardware". When the tech provides a separate "Stock used" block (look for it after the verbatim notes section below), use that as the AUTHORITATIVE source for this array — copy each line into materials preserving any stock codes verbatim, then add anything else visible in the photos that the tech omitted. Never paraphrase or shorten codes.
- issues_notes: an ARRAY of any issues encountered, deviations, or notable observations. Examples: "Client not on site during completion", "Client told people on the yard where technician mounted router". Empty array if there's nothing remarkable.

- job_card: an object with the four fields below, ALWAYS populated. Inspect every photo carefully looking for a paper "job card" form. The DK Connect job card has a header row of checkboxes (New Install / Takeover Install / Relocation / Repair / Additional / SS), customer details, a parts/items table, a "Notes" section, and at the bottom a "To be completed by client" section with three Y/N rows and a signature line.
  - job_card_found (boolean): true ONLY when you can clearly see this form (or an equivalent paper job card) in any photo. False if no card is visible.
  - customer_signature_present (boolean): true ONLY when there is a clearly visible handwritten signature, scribble, printed name, or X mark on the customer signature line at the bottom of the card. If the line is blank, the area is cropped out, or the signature is illegible/uncertain, return false. Bias to false on any doubt — the operator wants false positives over missed unsigned cards.
  - workmanship_satisfaction ("Y" | "N" | "unknown"): read the row labelled "Is the quality of workmanship to your satisfaction?" Return "Y" only on a clear yes mark (Y / ✓ / yes / tick); "N" only on a clear no mark (N / ✗ / no / cross); "unknown" when blank, illegible, or not visible.
  - work_satisfaction ("Y" | "N" | "unknown"): same rules, for the row labelled "Are you satisfied with the work that has been done and requested?"
  When job_card_found is false, set the other three fields to false / "unknown" — do not guess.

- job_type: classify the job into ONE of these categories. Pick the best fit:
  - "ftua_installation"        new FTUA (fixed terminal user antenna) wireless install at a client site — outdoor antenna mounted, dish aligned, indoor router configured
  - "site_survey"              any survey visit before an install — signal checks, line-of-sight assessment, equipment recommendation, photographing the proposed mount points
  - "fibre_los_inspection"     fibre line-of-sight inspection at a property — checking the fibre route, splice points, and termination feasibility
  - "layer2_fibre_setup"       configuring the L2 fibre handoff — splicing, ONT install, switch / router setup on a delivered fibre service
  - "extender_installation"    adding a wifi extender, mesh node, or additional AP at an existing client site for coverage
  - "antenna_move"             relocating or re-aiming an existing client antenna / radio (the "connection move" scenario — same client, different aim or mounting point)
  - "offline_connection"       reactive visit specifically because the client is fully offline — link is down, dead radio, no link light
  - "internal_issues_callout"  reactive visit for issues *while online* — poor wifi coverage inside the premises, intermittent drops, slow speeds, single-room dead spots
  - "voip_installation"        installing a VoIP phone (cabled or wifi) — capturing phone make/model/IP/MAC, placement, and call-test proof
  - "complaint"                visit driven by a client complaint that doesn't cleanly fit the technical buckets above — billing dispute on site, equipment damage claim, attitude/quality complaint follow-up
  - "other"                    genuinely doesn't fit any of the above

  Decide from the task title, description, and photos. If genuinely ambiguous between two, prefer the more specific one over "other".

CRITICAL: photo_descriptions MUST contain exactly the same number of entries as the number of photos provided. Never short the array — if a photo is unclear, write what you can see ("Equipment closeup, content unclear") rather than skipping it.

Reason from the photos and the tech's notes; the Splynx task description is supplementary context (it describes what was scheduled, not necessarily what happened).`;

/**
 * Additional system-prompt block appended only when the operator has
 * enabled the requirements-coverage check. Lists every per-job-type
 * checklist so the model has the full lookup table after classifying
 * job_type.
 */
function buildRequirementsPromptBlock(): string {
  const blocks: string[] = [];
  blocks.push(
    "REQUIREMENTS COVERAGE CHECK (admin-only — these verdicts are NOT shown to the customer).",
    "After classifying job_type, look up the matching checklist below and evaluate each requirement against the photos + tech notes.",
    "For each item, populate requirements_check.items with:",
    '  - status: "found" only when the photo or note clearly satisfies the requirement;',
    '            "missing" only when there is a confident gap;',
    '            "unclear" when you cannot tell with confidence.',
    "  - evidence: a single short sentence referencing the photo number or the phrase from the tech's notes you based your verdict on.",
    "Bias toward `unclear` over a confident `missing` while we calibrate.",
    "Always set requirements_check.job_type to the same value you produced for the top-level job_type field.",
    "If the classified job_type has an EMPTY checklist below (i.e. complaint, other, or any future type with no fixed deliverables), return an empty items array — do not invent requirements.",
    "",
    "Checklists by job_type:",
  );
  for (const [jobType, items] of Object.entries(JOB_TYPE_REQUIREMENTS)) {
    if (items.length === 0) {
      blocks.push(`- ${jobType}: (no fixed checklist — return empty items array)`);
    } else {
      blocks.push(`- ${jobType}:`);
      for (const item of items) blocks.push(`    • ${item}`);
    }
  }
  return blocks.join("\n");
}

// Tool-schema fragment for the requirements_check field. Always present
// in the schema (Anthropic tools don't support conditional schemas) but
// only added to the `required` list when the toggle is on. When the
// toggle is off the model is instructed to omit it; if it sends it
// anyway we just don't parse it.
const REQUIREMENTS_CHECK_TOOL_SCHEMA = {
  type: "object" as const,
  properties: {
    job_type: { type: "string" as const },
    items: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          requirement: { type: "string" as const },
          status: { type: "string" as const, enum: ["found", "missing", "unclear"] },
          evidence: { type: "string" as const },
        },
        required: ["requirement", "status", "evidence"],
      },
    },
  },
  required: ["job_type", "items"],
};


export async function summarize(args: SummarizeArgs): Promise<SummarizeResult> {
  const client = new Anthropic({ apiKey: args.config.ANTHROPIC_API_KEY });
  const reqCheckOn = args.requirementsCheckEnabled === true;

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
    ...((args.secondaryTechNames ?? []).filter((n) => n.trim()).length > 0
      ? [`Assisted by: ${(args.secondaryTechNames ?? []).map((n) => n.trim()).filter(Boolean).join(", ")}`]
      : []),
    "",
    `Tech's notes (verbatim): ${args.comment.trim() || "(no notes provided)"}`,
    "",
    `Stock used (verbatim — copy each line into materials, preserving codes): ${
      (args.stockNotes ?? "").trim() || "(none provided)"
    }`,
    "",
    `Splynx task description (for context):`,
    cleanDescription || "(empty)",
    "",
    `Now produce the structured job completion summary using save_summary.`,
  ].join("\n");

  // 30 photos × ~80 tokens of description each + the rest of the structured
  // fields can run past 3k easily. 8192 is plenty without being wasteful.
  // When the requirements check is on we tack the checklist block onto the
  // system prompt and add `requirements_check` to the tool input_schema so
  // the model fills it in the same tool_use response.
  const systemPrompt = reqCheckOn
    ? `${SYSTEM_PROMPT}\n\n${buildRequirementsPromptBlock()}`
    : SYSTEM_PROMPT;
  const baseProperties = {
    headline: { type: "string" as const },
    what_was_done: { type: "string" as const },
    observations: { type: "string" as const },
    follow_ups: { type: "string" as const },
    overview: {
      type: "object" as const,
      properties: {
        service_type: { type: "string" as const },
        client_name: { type: "string" as const },
        location: { type: "string" as const },
        job_date: { type: "string" as const },
        job_start_time: { type: "string" as const },
        job_end_time: { type: "string" as const },
        job_duration: { type: "string" as const },
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
    work_completed: { type: "array" as const, items: { type: "string" as const } },
    photo_descriptions: { type: "array" as const, items: { type: "string" as const } },
    materials: { type: "array" as const, items: { type: "string" as const } },
    issues_notes: { type: "array" as const, items: { type: "string" as const } },
    job_type: {
      type: "string" as const,
      enum: [
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
      ],
    },
    job_card: {
      type: "object" as const,
      properties: {
        job_card_found: { type: "boolean" as const },
        customer_signature_present: { type: "boolean" as const },
        workmanship_satisfaction: {
          type: "string" as const,
          enum: ["Y", "N", "unknown"],
        },
        work_satisfaction: {
          type: "string" as const,
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
  };
  const baseRequired = [
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
  ];
  const toolInputSchema = reqCheckOn
    ? {
        type: "object" as const,
        properties: { ...baseProperties, requirements_check: REQUIREMENTS_CHECK_TOOL_SCHEMA },
        required: [...baseRequired, "requirements_check"],
      }
    : {
        type: "object" as const,
        properties: baseProperties,
        required: baseRequired,
      };

  const response = await client.messages.create({
    model: args.config.CLAUDE_MODEL,
    max_tokens: 8192,
    system: systemPrompt,
    tools: [
      {
        name: "save_summary",
        description: "Save the structured job summary.",
        input_schema: toolInputSchema,
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

  // When the toggle is on, parse the requirements_check sibling. If the
  // model omitted it or it fails schema we just store null and log — we
  // never want a malformed requirements check to fail the whole summary.
  let requirementsCheck: RequirementsCheck | null = null;
  if (reqCheckOn) {
    const rawInput = toolUse.input as Record<string, unknown>;
    const reqParse = RequirementsCheckSchema.safeParse(rawInput.requirements_check);
    if (reqParse.success) {
      requirementsCheck = reqParse.data;
    } else {
      console.warn(
        `[summarize] requirements_check parse failed for task ${args.task.id}:`,
        reqParse.error.issues,
      );
    }
  }

  return { summary: parsed, requirementsCheck };
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

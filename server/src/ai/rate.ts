import Anthropic from "@anthropic-ai/sdk";
import type Database from "better-sqlite3";
import type { AppConfig } from "../config.js";
import { InternalRatingSchema, type InternalRating } from "../types.js";
import type { SplynxTaskRaw } from "../splynx/types.js";
import { getSetting, SettingKeys } from "../lib/settings.js";

/**
 * Rate the quality of a completed field-tech job.
 *
 * THIS DATA IS ADMIN-ONLY. It MUST NEVER be:
 *   - rendered in the PDF (see types.ts type firewall)
 *   - sent over WhatsApp
 *   - written to Splynx
 *   - returned in any tech-side response
 *
 * The integration leak-test in __tests__/leak.test.ts guards this property.
 *
 * "AI learns from that": Claude doesn't have fine-tuning, so we approximate
 * it via in-context calibration. Last N admin-corrected ratings are pulled
 * from submission_ratings and embedded as few-shot examples in the prompt.
 * Over time the model converges to the admin's standards on this account.
 */

interface RateArgs {
  config: AppConfig;
  db: Database.Database;
  task: SplynxTaskRaw;
  comment: string;
  photoBuffers: Buffer[];
  techName: string;
}

const FEW_SHOT_LIMIT = 10;

const SYSTEM_PROMPT = `You are an internal quality reviewer for a small ISP / WISP. After every field-tech job submission you score the work 1–10 across four dimensions and an overall headline score, plus two short bullet lists: what was done well, and what the tech should have done.

Your output is ONLY visible to the company owner — never to the technician, never to customers, never to external systems. So be honest and specific.

Scoring guide (overall + each dimension on 1–10):
- 9–10 = standards-exceeding: above-and-beyond evidence in the photos and notes
- 7–8 = solid, no concerns
- 5–6 = job done but with at least one notable gap (missed a label, sparse photos, brief notes, etc.)
- 3–4 = significant concern — would fail an internal audit
- 1–2 = unacceptable — re-do or escalate

Use the full range. Default to even-numbered values within a bucket; reach for an odd value when the submission is borderline up or down within that bucket.

Dimensions:
- workmanship: visible quality of the install / fix in the photos
- photo_quality: are photos in-focus, well-lit, capturing what matters?
- completeness: did the tech document the necessary checkpoints (before/after, labels, equipment used, customer-facing components)?
- communication: do the tech's notes give a clear picture of what happened and any follow-ups?

Bullet lists — call the save_rating tool with:
- strengths: 0–5 short bullets, each 8–18 words, naming a specific thing the tech got right with evidence ("MikroTik LHG XL labelled with asset tag LXLHP5-0179 and photographed"). No filler. If genuinely nothing is notable, return [].
- improvements: 0–5 short bullets, each 8–18 words, naming a specific thing the tech should have done ("Take a final-position photo of the indoor router; the lying-on-desk shot doesn't show its mounted location"). Be direct. Do not soften.

Both lists must reference what's actually visible in the photos / notes — do not hallucinate problems. A flawless job returns a non-empty strengths list and an empty improvements list.

If past calibration examples appear in the message below, treat them as the company's standard and apply the same bar.`;

export async function ratePerformance(args: RateArgs): Promise<InternalRating> {
  const client = new Anthropic({ apiKey: args.config.ANTHROPIC_API_KEY });

  const fewShot = buildFewShotBlock(args.db);
  const cleanDescription = args.task.description
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1500);

  const photoBlocks = args.photoBuffers.map((buf) => ({
    type: "image" as const,
    source: {
      type: "base64" as const,
      media_type: "image/jpeg" as const,
      data: buf.toString("base64"),
    },
  }));

  // System is a block array so the static SYSTEM_PROMPT and the
  // semi-static few-shot calibration block each get their own Anthropic
  // prompt-cache breakpoint. The few-shot block changes only when an
  // admin saves a rating override — rare in the 5-minute cache window —
  // so the second breakpoint preserves the first's cache even when the
  // few-shot does change. Per-submission task details stay in the user
  // turn (uncached).
  type CachedTextBlock = Anthropic.TextBlockParam & {
    cache_control?: { type: "ephemeral" };
  };
  const systemBlocks: CachedTextBlock[] = [
    {
      type: "text",
      text: SYSTEM_PROMPT,
      cache_control: { type: "ephemeral" },
    },
  ];
  if (fewShot) {
    systemBlocks.push({
      type: "text",
      text: fewShot,
      cache_control: { type: "ephemeral" },
    });
  }

  const userText = [
    `Task: ${args.task.title}`,
    `Site: ${args.task.address || "(not set)"}`,
    `Technician: ${args.techName}`,
    "",
    `Tech's notes (verbatim): ${args.comment.trim() || "(none)"}`,
    "",
    `Splynx task description (context):`,
    cleanDescription || "(empty)",
    "",
    `Now rate the work using save_rating.`,
  ].join("\n");

  // Pick the model: setting override > server default. Lets the
  // operator A/B Opus vs Sonnet on rating quality without a redeploy.
  // Any non-"sonnet"/"opus" value is forwarded verbatim so future
  // tests (e.g. Haiku) work without a code change.
  const override = getSetting(args.db, SettingKeys.ratingModelOverride);
  const ratingModel =
    override === "sonnet"
      ? "claude-sonnet-4-6"
      : override && override !== "opus"
        ? override
        : args.config.CLAUDE_MODEL;

  const toolWithCache = {
    name: "save_rating",
    description: "Persist the internal quality rating.",
    input_schema: {
      type: "object",
      properties: {
        score: { type: "integer", minimum: 1, maximum: 10 },
        strengths: {
          type: "array",
          maxItems: 5,
          items: { type: "string" },
        },
        improvements: {
          type: "array",
          maxItems: 5,
          items: { type: "string" },
        },
        dimensions: {
          type: "object",
          properties: {
            workmanship: { type: "integer", minimum: 1, maximum: 10 },
            photo_quality: { type: "integer", minimum: 1, maximum: 10 },
            completeness: { type: "integer", minimum: 1, maximum: 10 },
            communication: { type: "integer", minimum: 1, maximum: 10 },
          },
          required: ["workmanship", "photo_quality", "completeness", "communication"],
        },
      },
      required: ["score", "strengths", "improvements", "dimensions"],
    },
    cache_control: { type: "ephemeral" as const },
  };

  const response = await client.messages.create({
    model: ratingModel,
    max_tokens: 800,
    // SDK ^0.30.0's typed surface predates prompt-caching fields; casts
    // bridge the gap. The wire API accepts these fields on Opus 4.6/4.7
    // and Sonnet 4.6 (the rating model targets).
    system: systemBlocks as unknown as string,
    tools: [toolWithCache as unknown as Anthropic.Tool],
    tool_choice: { type: "tool", name: "save_rating" },
    messages: [
      {
        role: "user",
        content: [...photoBlocks, { type: "text", text: userText }],
      },
    ],
  });
  // Surface cache hit/miss + which model handled the call (so a
  // sudden cost shift after a setting flip is easy to attribute).
  const usage = response.usage as unknown as {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  console.info(
    `[rate] ai_usage task=${args.task.id} model=${ratingModel} ` +
      `cacheRead=${usage.cache_read_input_tokens ?? 0} ` +
      `cacheCreate=${usage.cache_creation_input_tokens ?? 0} ` +
      `input=${usage.input_tokens} output=${usage.output_tokens}`,
  );

  const toolUse = response.content.find((c) => c.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("Claude did not return a tool_use block for rating");
  }
  // Truncate strengths / improvements to the schema cap before parsing.
  // The prompt + tool schema both ask for ≤5 items each, but Claude
  // occasionally overshoots — without this guard the whole rating fails
  // Zod validation and the submission lands as "partial". Truncating
  // silently drops the bonus items so the rating still saves; we log
  // when we had to truncate so calibration drift is visible.
  const raw = toolUse.input as Record<string, unknown>;
  const MAX_ITEMS = 5;
  if (Array.isArray(raw.strengths) && raw.strengths.length > MAX_ITEMS) {
    console.warn(
      `[rate] truncating strengths from ${raw.strengths.length} to ${MAX_ITEMS} items`,
    );
    raw.strengths = raw.strengths.slice(0, MAX_ITEMS);
  }
  if (Array.isArray(raw.improvements) && raw.improvements.length > MAX_ITEMS) {
    console.warn(
      `[rate] truncating improvements from ${raw.improvements.length} to ${MAX_ITEMS} items`,
    );
    raw.improvements = raw.improvements.slice(0, MAX_ITEMS);
  }
  return InternalRatingSchema.parse(raw);
}

function buildFewShotBlock(db: Database.Database): string {
  const rows = db
    .prepare(
      `SELECT s.task_id, s.comment, r.ai_score, r.ai_rationale,
              r.admin_score, r.admin_rationale
       FROM submission_ratings r
       JOIN submissions s ON s.id = r.submission_id
       WHERE r.admin_score IS NOT NULL
       ORDER BY r.reviewed_at DESC
       LIMIT ?`,
    )
    .all(FEW_SHOT_LIMIT) as {
    task_id: number;
    comment: string | null;
    ai_score: number;
    ai_rationale: string;
    admin_score: number;
    admin_rationale: string | null;
  }[];

  if (rows.length === 0) return "";

  const examples = rows.map((r, i) => {
    const adminNote = r.admin_rationale?.trim()
      ? ` Note: "${r.admin_rationale.trim()}"`
      : "";
    const techNote = r.comment?.trim()
      ? `\n  Tech note (excerpt): "${r.comment.slice(0, 160).replace(/\s+/g, " ").trim()}"`
      : "";
    return `Example ${i + 1} — task #${r.task_id}${techNote}\n  AI initially scored: ${r.ai_score}\n  Admin corrected to: ${r.admin_score}.${adminNote}`;
  });

  return [
    "Past calibration examples — apply the same standards the admin has shown here:",
    "",
    ...examples,
  ].join("\n");
}

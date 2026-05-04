import Anthropic from "@anthropic-ai/sdk";
import type Database from "better-sqlite3";
import type { AppConfig } from "../config.js";
import { InternalRatingSchema, type InternalRating } from "../types.js";
import type { SplynxTaskRaw } from "../splynx/types.js";

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

const SYSTEM_PROMPT = `You are an internal quality reviewer for a small ISP / WISP. After every field-tech job submission you score the work 1–10 across four dimensions and an overall headline score, with a one-paragraph rationale.

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

Always call the save_rating tool. Keep the rationale to 2-3 sentences, plain language, and reference what's actually visible in the photos / notes — do not hallucinate problems.

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

  const userText = [
    fewShot ? `${fewShot}\n\n--- New job to rate ---\n` : "",
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
  ]
    .filter(Boolean)
    .join("\n");

  const response = await client.messages.create({
    model: args.config.CLAUDE_MODEL,
    max_tokens: 800,
    system: SYSTEM_PROMPT,
    tools: [
      {
        name: "save_rating",
        description: "Persist the internal quality rating.",
        input_schema: {
          type: "object",
          properties: {
            score: { type: "integer", minimum: 1, maximum: 10 },
            rationale: { type: "string" },
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
          required: ["score", "rationale", "dimensions"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "save_rating" },
    messages: [
      {
        role: "user",
        content: [...photoBlocks, { type: "text", text: userText }],
      },
    ],
  });

  const toolUse = response.content.find((c) => c.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("Claude did not return a tool_use block for rating");
  }
  return InternalRatingSchema.parse(toolUse.input);
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

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { AppConfig } from "../config.js";

/**
 * Pattern-detection Claude call — analyses a single tech's calendar month of
 * submissions and produces structured strengths / issues / coaching points
 * for the operator's monthly review.
 *
 * THIS RESULT IS ADMIN-ONLY. The inputs include InternalRating data
 * (admin/AI rationales), and so the output is treated the same way as a
 * rating: stored in its own table (`tech_patterns`), served only by
 * admin-gated routes, and never passed to any external-payload formatter
 * (PDF / Splynx comment / WhatsApp). The leak-test asserts that runtime.
 */

export const PatternStrengthSchema = z.object({
  title: z.string().min(1),
  evidence: z.string().min(1),
});
export const PatternIssueSchema = z.object({
  title: z.string().min(1),
  evidence: z.string().min(1),
  frequency: z.string().min(1),
});

export const PatternResultSchema = z.object({
  strengths: z.array(PatternStrengthSchema).max(5).default([]),
  issues: z.array(PatternIssueSchema).max(5).default([]),
  coaching: z.array(z.string().min(1)).max(5).default([]),
  summary: z.string().min(1),
});
export type PatternResult = z.infer<typeof PatternResultSchema>;

export interface SubmissionInput {
  submission_id: number;
  task_id: number;
  task_title: string | null;
  task_description: string | null;
  created_at: number;
  job_type: string;
  // The summary that was sent externally (already in PDF/WA/Splynx).
  summary_what_was_done: string | null;
  summary_observations: string | null;
  summary_follow_ups: string | null;
  // Internal-only rating signals. Admin rationale is the strongest signal
  // of David's standards and is weighted heaviest in the prompt.
  ai_score: number | null;
  ai_rationale: string | null;
  admin_score: number | null;
  admin_rationale: string | null;
}

export interface AnalyzeArgs {
  config: AppConfig;
  appLogin: string;
  periodStart: number;
  periodEnd: number;
  submissions: SubmissionInput[];
}

const SYSTEM_PROMPT = `You are an internal coaching analyst at a small ISP / WISP. The operator (the company owner) is preparing for a monthly performance review with one of their field technicians and needs a structured analysis of cumulative themes from the tech's submissions over the past calendar month.

THIS OUTPUT IS ADMIN-ONLY. It will never be shown to the technician, customer, or external systems — be honest, specific, and useful for coaching.

Inputs:
- One block per submission with: task title, scheduled work (Splynx description), what was done, observations, follow-ups, AI rating + rationale, admin rating + rationale (if the operator overrode the AI).
- The admin's rationale, when present, is the strongest signal of the operator's standards. Weight it more heavily than the AI's own rationale.

Always call the analyse_patterns tool with:
- strengths: 0–5 entries. Each entry is a specific recurring positive (e.g. "Consistently labels patch panels"). Cite evidence — submission IDs or counts. If genuinely nothing notable, return [].
- issues: 0–5 entries. Each entry is a specific recurring weak area with frequency ("4 of 8 jobs", "twice this month"). Be concrete: tie to evidence in submissions and rationales. If admin and AI rationales disagree, side with admin. Empty array is valid.
- coaching: 0–5 actionable bullets. Phrased as direct talking points the operator can use ("Ask Lorenzo to take a final photo of weatherproof labels on outdoor APs"). Concrete, grounded in the data.
- summary: one paragraph, plain South African English, 2–4 sentences, capturing the headline takeaway.

Tone everywhere: factual, direct, plain English, no emoji, no markdown formatting in field values. Don't invent issues to fill space. A flawless month should return zero issues with a positive summary.`;

export async function analyzePatterns(args: AnalyzeArgs): Promise<PatternResult> {
  const client = new Anthropic({ apiKey: args.config.ANTHROPIC_API_KEY });

  const periodStartLabel = new Date(args.periodStart).toISOString().slice(0, 10);
  const periodEndLabel = new Date(args.periodEnd).toISOString().slice(0, 10);

  const submissionBlocks = args.submissions.map((s, i) => {
    const lines: string[] = [];
    lines.push(`--- Submission ${i + 1} of ${args.submissions.length} ---`);
    lines.push(`submission_id: ${s.submission_id}`);
    lines.push(`task_id: ${s.task_id}`);
    lines.push(`date: ${new Date(s.created_at).toISOString().slice(0, 10)}`);
    lines.push(`job_type: ${s.job_type}`);
    if (s.task_title) lines.push(`task_title: ${s.task_title}`);
    if (s.task_description) {
      lines.push(`scheduled_work: ${truncate(stripHtml(s.task_description), 800)}`);
    }
    if (s.summary_what_was_done) {
      lines.push(`what_was_done: ${truncate(s.summary_what_was_done, 800)}`);
    }
    if (s.summary_observations) {
      lines.push(`observations: ${truncate(s.summary_observations, 500)}`);
    }
    if (s.summary_follow_ups) {
      lines.push(`follow_ups: ${truncate(s.summary_follow_ups, 500)}`);
    }
    if (s.ai_score !== null) {
      lines.push(
        `ai_rating: ${s.ai_score}/5 — ${truncate(s.ai_rationale ?? "(no rationale)", 400)}`,
      );
    }
    if (s.admin_score !== null) {
      lines.push(
        `admin_rating (overrides AI): ${s.admin_score}/5 — ${truncate(s.admin_rationale ?? "(no rationale)", 600)}`,
      );
    }
    return lines.join("\n");
  });

  const userText = [
    `Tech: ${args.appLogin}`,
    `Period: ${periodStartLabel} to ${periodEndLabel}`,
    `Submission count: ${args.submissions.length}`,
    "",
    ...submissionBlocks,
    "",
    "Now produce the cumulative analysis using the analyse_patterns tool.",
  ].join("\n");

  const response = await client.messages.create({
    model: args.config.CLAUDE_MODEL,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    tools: [
      {
        name: "analyse_patterns",
        description: "Persist the structured monthly pattern analysis.",
        input_schema: {
          type: "object",
          properties: {
            strengths: {
              type: "array",
              maxItems: 5,
              items: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  evidence: { type: "string" },
                },
                required: ["title", "evidence"],
              },
            },
            issues: {
              type: "array",
              maxItems: 5,
              items: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  evidence: { type: "string" },
                  frequency: { type: "string" },
                },
                required: ["title", "evidence", "frequency"],
              },
            },
            coaching: {
              type: "array",
              maxItems: 5,
              items: { type: "string" },
            },
            summary: { type: "string" },
          },
          required: ["strengths", "issues", "coaching", "summary"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "analyse_patterns" },
    messages: [{ role: "user", content: [{ type: "text", text: userText }] }],
  });

  const toolUse = response.content.find((c) => c.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("Claude did not return a tool_use block for patterns");
  }
  return PatternResultSchema.parse(toolUse.input);
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

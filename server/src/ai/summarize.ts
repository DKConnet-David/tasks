import Anthropic from "@anthropic-ai/sdk";
import type { AppConfig } from "../config.js";
import { ExternalSummarySchema, type ExternalSummary } from "../types.js";
import type { SplynxTaskRaw } from "../splynx/types.js";

/**
 * Summarize a completed field-tech job. This produces ONLY the externally-
 * visible fields (PDF, WhatsApp, Splynx comment, tech response). The
 * admin-only quality rating is a separate Claude call in ai/rate.ts —
 * the type firewall in src/types.ts ensures the two outputs can never
 * cross-contaminate.
 */

interface SummarizeArgs {
  config: AppConfig;
  task: SplynxTaskRaw;
  comment: string;
  photoBuffers: Buffer[];
  techName: string;
}

const SYSTEM_PROMPT = `You are summarizing a completed field-tech job for a small ISP / WISP. Your output is read by:
1. The ops team in a WhatsApp group (with a PDF report attached)
2. Internal admins via the Splynx ticket comment thread

Tone: plain South African English, factual, direct. No emoji. No markdown formatting inside field values. Do not invent details that aren't in the photos or the tech's notes.

Always call the save_summary tool with these fields:
- headline: a single sentence, max 80 chars, that captures the outcome (e.g. "Router replaced and tested at Alex Alarms"). Avoid filler words.
- what_was_done: 2 to 4 sentences describing the actual work performed. Reference specific equipment / changes visible in the photos and confirmed by the tech's notes.
- observations: noteworthy site conditions, customer requests, or stock-related notes. Empty string if none.
- follow_ups: any follow-up actions, billing notes, or items needing attention. Empty string if none.
- photo_captions: an array with EXACTLY one short caption per photo, in the same order the photos were attached. Each caption is 3 to 8 words describing what the photo shows — these become the filenames in Splynx and labels under each photo in the PDF, so they need to be informative on their own. Examples: "Customer router before replacement", "EW3000GX powered up and connected", "Patch panel labelled and tidy". Avoid full sentences, generic words like "photo" or "image", and any rating language.

Reason from the photos plus the tech's notes; the Splynx task description is supplementary context (it describes what was scheduled, not necessarily what happened).`;

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
    `Scheduled: ${args.task.scheduled_from && args.task.scheduled_from !== "0000-00-00 00:00:00" ? args.task.scheduled_from : "(no date)"}`,
    `Technician on site: ${args.techName}`,
    "",
    `Tech's notes (verbatim): ${args.comment.trim() || "(no notes provided)"}`,
    "",
    `Splynx task description (for context):`,
    cleanDescription || "(empty)",
    "",
    `Now summarize the completed work based on the photos and the tech's notes.`,
  ].join("\n");

  const response = await client.messages.create({
    model: args.config.CLAUDE_MODEL,
    max_tokens: 1024,
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
            photo_captions: {
              type: "array",
              items: { type: "string" },
              description:
                "One short caption per photo in upload order. Used as filenames and labels.",
            },
          },
          required: [
            "headline",
            "what_was_done",
            "observations",
            "follow_ups",
            "photo_captions",
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

  // Defensive: if Claude returns the wrong number of captions, pad/truncate
  // so the array length always matches the photo count. Padding uses a
  // neutral string so the filename doesn't stay empty.
  const expected = args.photoBuffers.length;
  if (parsed.photo_captions.length !== expected) {
    const fixed: string[] = [];
    for (let i = 0; i < expected; i++) {
      fixed.push(parsed.photo_captions[i] ?? `photo ${i + 1}`);
    }
    parsed.photo_captions = fixed;
  }

  return parsed;
}

export interface SummarizeDebugInfo {
  inputTokens: number;
  outputTokens: number;
  model: string;
}

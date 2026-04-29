import { z } from "zod";

const ConfigSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  SPLYNX_BASE_URL: z.string().url(),
  ADMIN_LOGIN: z.string().min(1),

  ANTHROPIC_API_KEY: z.string().min(1),
  CLAUDE_MODEL: z.string().default("claude-sonnet-4-6"),

  WHATSAPP_GROUP_JID: z.string().optional(),

  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be >= 32 chars"),
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 12),

  DATA_DIR: z.string().default("/data"),
  PUBLIC_BASE_URL: z.string().url().optional(),

  AI_DEBUG_LOG: z.coerce.boolean().default(false),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

let cached: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (cached) return cached;
  const parsed = ConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

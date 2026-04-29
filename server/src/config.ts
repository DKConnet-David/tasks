import { z } from "zod";

const ConfigSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  SPLYNX_BASE_URL: z.string().url(),
  SPLYNX_API_KEY: z.string().min(1).optional(),
  SPLYNX_API_SECRET: z.string().min(1).optional(),

  ADMIN_LOGIN: z.string().min(1),
  ADMIN_PASSWORD: z.string().min(8, "ADMIN_PASSWORD must be at least 8 chars"),
  ADMIN_SPLYNX_ADMIN_ID: z.coerce.number().int().positive().default(1),

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
  // Treat empty-string env vars as unset. Compose substitutes ${VAR:-} with
  // "" when the variable is missing, which would otherwise fail zod's url()
  // and min(1) checks for fields that are meant to be optional.
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) {
    env[k] = v === "" ? undefined : v;
  }
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

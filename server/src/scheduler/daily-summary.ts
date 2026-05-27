import type Database from "better-sqlite3";
import type { FastifyBaseLogger } from "fastify";
import type { AppConfig } from "../config.js";
import { getSetting, setSetting, SettingKeys } from "../lib/settings.js";
import { sendTextToGroup } from "../whatsapp/baileys.js";

/**
 * 19:00 in the container's local timezone (Africa/Johannesburg in
 * production). Submissions on the current calendar day are summarised
 * and posted to the configured WhatsApp group. Each minute the
 * scheduler checks if it's past this time and the day hasn't already
 * been sent.
 */
const SEND_HOUR = 19;
const SEND_MIN = 0;
const TICK_INTERVAL_MS = 60_000;

interface DailyRow {
  app_login: string;
  job_count: number;
  last_submission_at: number | null;
}

interface DailySummaryDeps {
  db: Database.Database;
  config: AppConfig;
  log: FastifyBaseLogger;
}

/**
 * Idempotent runner — safe to call manually from a "send test now"
 * endpoint or from the once-a-minute scheduler. Returns a result
 * envelope so the caller can decide how to surface errors; the
 * scheduler logs and swallows, the test-send endpoint reflects to
 * the admin UI.
 */
export async function runDailySummary(
  deps: DailySummaryDeps,
  opts?: { force?: boolean; dateOverride?: string },
): Promise<
  | { ok: true; sent: true; messageId: string | null; jid: string; rowCount: number; date: string }
  | { ok: true; sent: false; reason: string }
  | { ok: false; error: string }
> {
  const { db, config, log } = deps;

  const jid = getSetting(db, SettingKeys.whatsappGroupJid);
  if (!jid) {
    return { ok: true, sent: false, reason: "no_group_configured" };
  }

  const date = opts?.dateOverride ?? todayKeyLocal();
  if (!opts?.force) {
    const lastSent = getSetting(db, SettingKeys.dailySummaryLastSentDate);
    if (lastSent === date) {
      return { ok: true, sent: false, reason: "already_sent_today" };
    }
  }

  const bounds = dayBounds(date);
  if (!bounds) {
    return { ok: false, error: `invalid_date: ${date}` };
  }

  const rows = db
    .prepare(
      `SELECT app_login,
              COUNT(*) AS job_count,
              MAX(created_at) AS last_submission_at
       FROM submissions
       WHERE created_at >= ? AND created_at < ?
         AND hidden = 0
       GROUP BY app_login
       ORDER BY job_count DESC, app_login COLLATE NOCASE ASC`,
    )
    .all(bounds.since, bounds.endExclusive) as DailyRow[];

  const text = formatDailySummary(rows, date);

  try {
    const messageId = await sendTextToGroup(jid, text);
    // Persist the sentinel ONLY on success. A failed send leaves the
    // last-sent date alone, so the next minute's tick will retry.
    if (!opts?.dateOverride) {
      setSetting(db, SettingKeys.dailySummaryLastSentDate, date);
    }
    log.info(
      { date, jid, messageId, rowCount: rows.length },
      "daily summary sent",
    );
    return { ok: true, sent: true, messageId, jid, rowCount: rows.length, date };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err, date, jid }, "daily summary send failed");
    void config; // config reserved for future use (e.g. config-driven group override)
    return { ok: false, error: msg };
  }
}

/**
 * Format a WhatsApp-flavoured daily summary message. Uses *bold* for
 * the headline + tech names so the office can scan at a glance, and
 * keeps it text-only so the same path works whether WhatsApp Web
 * renders our emojis or not.
 */
export function formatDailySummary(rows: DailyRow[], date: string): string {
  const dateLabel = prettyDateLabel(date);
  const lines: string[] = [];
  lines.push(`*Daily team summary*`);
  lines.push(`_${dateLabel}_`);
  lines.push("");

  if (rows.length === 0) {
    lines.push("No submissions today.");
    return lines.join("\n");
  }

  for (const r of rows) {
    const last = r.last_submission_at
      ? ` (last ${formatHHMM(r.last_submission_at)})`
      : "";
    const jobs = r.job_count === 1 ? "1 job" : `${r.job_count} jobs`;
    lines.push(`• *${r.app_login}*: ${jobs}${last}`);
  }

  const total = rows.reduce((s, r) => s + r.job_count, 0);
  lines.push("");
  lines.push(
    total === 1
      ? `_1 submission across 1 tech._`
      : `_${total} submissions across ${rows.length} tech${rows.length === 1 ? "" : "s"}._`,
  );
  return lines.join("\n");
}

/**
 * Start the once-a-minute scheduler tick. Fires runDailySummary when
 * the local time is at or past 19:00 and today hasn't been sent yet.
 * The interval is unref'd so it doesn't keep the process alive on
 * shutdown.
 */
export function startDailySummaryScheduler(deps: DailySummaryDeps): void {
  const tick = async () => {
    try {
      const enabled = getSetting(deps.db, SettingKeys.dailySummaryEnabled) === "1";
      if (!enabled) return;
      const now = new Date();
      const hh = now.getHours();
      const mm = now.getMinutes();
      // Only after the configured send time — never earlier in the day.
      if (hh < SEND_HOUR || (hh === SEND_HOUR && mm < SEND_MIN)) return;
      await runDailySummary(deps);
    } catch (err) {
      deps.log.error({ err }, "daily summary scheduler tick crashed");
    }
  };
  const handle = setInterval(tick, TICK_INTERVAL_MS);
  handle.unref();
  // Fire one tick on startup so a server restart after 19:00 doesn't
  // delay the report by up to a minute.
  void tick();
  deps.log.info(
    { sendHour: SEND_HOUR, sendMin: SEND_MIN },
    "daily summary scheduler started",
  );
}

// ---------- helpers ----------

function todayKeyLocal(): string {
  // en-CA's locale-formatted date happens to be ISO YYYY-MM-DD, which
  // makes it the cleanest way to get a calendar-day key in local TZ
  // without manual padStart.
  return new Date().toLocaleDateString("en-CA");
}

function dayBounds(
  ymd: string,
): { since: number; endExclusive: number } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  const [y, m, d] = ymd.split("-").map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  const since = new Date(y!, m! - 1, d!).getTime();
  const endExclusive = new Date(y!, m! - 1, d! + 1).getTime();
  if (!Number.isFinite(since) || !Number.isFinite(endExclusive)) return null;
  return { since, endExclusive };
}

function prettyDateLabel(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) return ymd;
  return new Date(y, m - 1, d).toLocaleDateString("en-ZA", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function formatHHMM(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { makeAuthGuards } from "../lib/auth-guards.js";
import { getDb } from "../db.js";
import type { AppConfig } from "../config.js";
import { analyzePatterns, type SubmissionInput } from "../ai/patterns.js";
import { getServiceSplynxClient, isSplynxConfigured } from "../splynx/service-client.js";

/**
 * Tech performance dashboard endpoints — admin-only.
 *
 * Backed by aggregations over `submissions` joined with `submission_ratings`.
 * Per-dimension scores prefer admin overrides over AI-generated scores
 * (treated identically to how SubmissionsList renders them).
 *
 * IMPORTANT: rating data IS the focus here, but it stays admin-only and
 * never reaches the tech-side response or any external system. Routes are
 * gated by requireAdmin; no public exposure.
 */

/**
 * Period selector for the performance dashboard.
 *
 * Accepts either `"all"` (lifetime) or a calendar month string in `YYYY-MM`
 * form (e.g. `"2026-05"`). The legacy values `"this_month"`, `"last_30"`,
 * and `"this_quarter"` were retired when the dropdown moved to a month
 * picker — the route now defaults to the current calendar month when
 * the query string is absent or unparseable.
 */
const MonthKeyRegex = /^\d{4}-(0[1-9]|1[0-2])$/;

type ParsedPeriod =
  | { kind: "all" }
  | { kind: "month"; year: number; month: number /* 1-12 */ };

function parsePeriod(raw: string | undefined): ParsedPeriod {
  if (raw === "all") return { kind: "all" };
  if (raw && MonthKeyRegex.test(raw)) {
    const [yStr, mStr] = raw.split("-");
    return { kind: "month", year: Number(yStr), month: Number(mStr) };
  }
  // Default — current calendar month in server local TZ.
  const now = new Date();
  return { kind: "month", year: now.getFullYear(), month: now.getMonth() + 1 };
}

function periodBounds(p: ParsedPeriod): { since: number; endExclusive: number } {
  if (p.kind === "all") {
    return { since: 0, endExclusive: Number.MAX_SAFE_INTEGER };
  }
  const since = new Date(p.year, p.month - 1, 1).getTime();
  const endExclusive = new Date(p.year, p.month, 1).getTime();
  return { since, endExclusive };
}

function periodLabel(p: ParsedPeriod): string {
  if (p.kind === "all") return "all time";
  const d = new Date(p.year, p.month - 1, 1);
  return d.toLocaleString("en-ZA", { month: "long", year: "numeric" });
}

function monthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

function periodKeyOut(p: ParsedPeriod): string {
  return p.kind === "all" ? "all" : monthKey(p.year, p.month);
}

/**
 * Distinct calendar months containing at least one (non-hidden) submission,
 * newest first. Pass `null` to scope across all techs (used by the team-
 * overview endpoint) or an `app_login` to scope to a single tech (used by
 * the per-tech profile endpoint).
 *
 * Returned as `YYYY-MM` strings so the frontend can render them as the
 * dropdown options (and convert to a friendlier label client-side).
 */
function listAvailableMonths(
  db: ReturnType<typeof getDb>,
  appLogin: string | null,
): string[] {
  const rows = appLogin
    ? (db
        .prepare(`SELECT created_at FROM submissions WHERE hidden = 0 AND app_login = ?`)
        .all(appLogin) as { created_at: number }[])
    : (db
        .prepare(`SELECT created_at FROM submissions WHERE hidden = 0`)
        .all() as { created_at: number }[]);
  const seen = new Set<string>();
  for (const r of rows) {
    const d = new Date(r.created_at);
    seen.add(monthKey(d.getFullYear(), d.getMonth() + 1));
  }
  // Always include the current month, so the dropdown isn't empty on the
  // 1st of a month before anyone has submitted.
  const now = new Date();
  seen.add(monthKey(now.getFullYear(), now.getMonth() + 1));
  return Array.from(seen).sort((a, b) => b.localeCompare(a));
}

interface DimensionScores {
  workmanship: number;
  photo_quality: number;
  completeness: number;
  communication: number;
}

interface TechRow {
  app_login: string;
  job_count: number;
  overall_score: number | null;
  dimensions: DimensionScores | null;
  last_submission_at: number | null;
}

interface SubmissionRow {
  id: number;
  task_id: number;
  app_login: string;
  source: string;
  status: string;
  created_at: number;
  job_type: string | null;
  ai_score: number | null;
  admin_score: number | null;
  ai_dimensions_json: string | null;
  admin_dimensions_json: string | null;
  summary_json: string | null;
}

interface SubmissionForListing {
  id: number;
  task_id: number;
  source: string;
  status: string;
  created_at: number;
  job_type: string | null;
  effective_score: number | null;
  is_admin_override: boolean;
  headline: string | null;
}

export async function registerPerformanceRoutes(
  app: FastifyInstance,
  config: AppConfig,
): Promise<void> {
  const { requireAdmin } = makeAuthGuards(config);
  const db = getDb(config.DATA_DIR);

  // ---------------------------------------------------------------
  // GET /admin/performance/techs?period=this_month
  // Team overview: one row per tech, with rolled-up score for the period.
  // ---------------------------------------------------------------
  app.get("/admin/performance/techs", { preHandler: requireAdmin }, async (req, reply) => {
    const period = parsePeriod((req.query as { period?: string }).period);
    const { since, endExclusive } = periodBounds(period);
    const availableMonths = listAvailableMonths(db, null);

    // Pull the raw rows in the period; group + average in JS rather than
    // SQL because we need to (a) prefer admin over AI, and (b) decode the
    // dimensions JSON.
    const rows = db
      .prepare(
        `SELECT s.app_login, s.created_at,
                r.ai_score, r.admin_score,
                r.ai_dimensions_json, r.admin_dimensions_json
         FROM submissions s
         LEFT JOIN submission_ratings r ON r.submission_id = s.id
         WHERE s.created_at >= ? AND s.created_at < ? AND s.hidden = 0`,
      )
      .all(since, endExclusive) as Array<{
      app_login: string;
      created_at: number;
      ai_score: number | null;
      admin_score: number | null;
      ai_dimensions_json: string | null;
      admin_dimensions_json: string | null;
    }>;

    // Also fetch the all-time list of techs that have ever submitted (any
    // non-hidden), so a tech with zero submissions in the period still
    // shows up in the team table.
    const allTechs = db
      .prepare(`SELECT DISTINCT app_login FROM submissions WHERE hidden = 0 ORDER BY app_login`)
      .all() as { app_login: string }[];

    const byTech = new Map<string, TechRow>();
    for (const t of allTechs) {
      byTech.set(t.app_login, {
        app_login: t.app_login,
        job_count: 0,
        overall_score: null,
        dimensions: null,
        last_submission_at: null,
      });
    }

    // Accumulate per-tech sums so we can average at the end.
    const accum = new Map<
      string,
      {
        scoreSum: number;
        scoreCount: number;
        dimSum: DimensionScores;
        dimCount: number;
        latestAt: number;
        jobCount: number;
      }
    >();

    for (const row of rows) {
      let a = accum.get(row.app_login);
      if (!a) {
        a = {
          scoreSum: 0,
          scoreCount: 0,
          dimSum: { workmanship: 0, photo_quality: 0, completeness: 0, communication: 0 },
          dimCount: 0,
          latestAt: 0,
          jobCount: 0,
        };
        accum.set(row.app_login, a);
      }
      a.jobCount += 1;
      if (row.created_at > a.latestAt) a.latestAt = row.created_at;

      const score = row.admin_score ?? row.ai_score;
      if (score !== null) {
        a.scoreSum += score;
        a.scoreCount += 1;
      }

      const dims = parseDims(row.admin_dimensions_json) ?? parseDims(row.ai_dimensions_json);
      if (dims) {
        a.dimSum.workmanship += dims.workmanship;
        a.dimSum.photo_quality += dims.photo_quality;
        a.dimSum.completeness += dims.completeness;
        a.dimSum.communication += dims.communication;
        a.dimCount += 1;
      }
    }

    for (const [login, a] of accum) {
      const tech = byTech.get(login) ?? {
        app_login: login,
        job_count: 0,
        overall_score: null,
        dimensions: null,
        last_submission_at: null,
      };
      tech.job_count = a.jobCount;
      tech.overall_score = a.scoreCount > 0 ? a.scoreSum / a.scoreCount : null;
      tech.dimensions =
        a.dimCount > 0
          ? {
              workmanship: a.dimSum.workmanship / a.dimCount,
              photo_quality: a.dimSum.photo_quality / a.dimCount,
              completeness: a.dimSum.completeness / a.dimCount,
              communication: a.dimSum.communication / a.dimCount,
            }
          : null;
      tech.last_submission_at = a.latestAt || null;
      byTech.set(login, tech);
    }

    return reply.send({
      period: periodKeyOut(period),
      period_label: periodLabel(period),
      since,
      available_months: availableMonths,
      techs: Array.from(byTech.values()).sort((a, b) =>
        a.app_login.localeCompare(b.app_login),
      ),
    });
  });

  // ---------------------------------------------------------------
  // GET /admin/performance/techs/:login?period=this_month
  // Per-tech detail: header, dimension scores, score time series,
  // distribution buckets, activity heatmap data, recent submissions.
  // ---------------------------------------------------------------
  app.get(
    "/admin/performance/techs/:login",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { login } = req.params as { login: string };
      const period = parsePeriod((req.query as { period?: string }).period);
      const { since, endExclusive } = periodBounds(period);
      const periodLabelStr = periodLabel(period);
      const availableMonths = listAvailableMonths(db, login);

      const rows = db
        .prepare(
          `SELECT s.id, s.task_id, s.app_login, s.source, s.status, s.created_at,
                  s.summary_json, s.corrected_summary_json,
                  r.ai_score, r.admin_score,
                  r.ai_dimensions_json, r.admin_dimensions_json
           FROM submissions s
           LEFT JOIN submission_ratings r ON r.submission_id = s.id
           WHERE s.app_login = ? AND s.created_at >= ? AND s.created_at < ?
             AND s.hidden = 0
           ORDER BY s.created_at ASC`,
        )
        .all(login, since, endExclusive) as Array<
        Omit<SubmissionRow, "job_type"> & {
          summary_json: string | null;
          corrected_summary_json: string | null;
        }
      >;

      if (rows.length === 0) {
        return reply.send({
          login,
          period: periodKeyOut(period),
          period_label: periodLabelStr,
          available_months: availableMonths,
          job_count: 0,
          overall_score: null,
          dimensions: null,
          consistency: null,
          score_trends: [],
          score_distribution: { excellent: 0, good: 0, needs_improvement: 0 },
          activity_heatmap: [],
          jobs_per_active_day: 0,
          recent_submissions: [],
          job_type_breakdown: {},
        });
      }

      // Score series (one entry per submission with a score).
      type Trend = {
        submission_id: number;
        created_at: number;
        overall: number;
        dimensions: DimensionScores | null;
        is_admin: boolean;
      };
      const trends: Trend[] = [];
      let scoreSum = 0;
      let scoreCount = 0;
      const dimSum: DimensionScores = {
        workmanship: 0,
        photo_quality: 0,
        completeness: 0,
        communication: 0,
      };
      const dimSamples = {
        workmanship: [] as number[],
        photo_quality: [] as number[],
        completeness: [] as number[],
        communication: [] as number[],
      };
      let dimCount = 0;
      let excellent = 0;
      let good = 0;
      let needs = 0;

      // Activity heatmap accumulator: key "YYYY-MM-DD" -> count.
      const dayCounts = new Map<string, number>();

      // Job type breakdown.
      const jobTypeCounts: Record<string, number> = {};
      const jobTypeSamples: Record<string, number[]> = {};

      // Recent submissions list (last 20).
      const recent: SubmissionForListing[] = [];

      for (const row of rows) {
        const score = row.admin_score ?? row.ai_score;
        const dims = parseDims(row.admin_dimensions_json) ?? parseDims(row.ai_dimensions_json);

        if (score !== null) {
          trends.push({
            submission_id: row.id,
            created_at: row.created_at,
            overall: score,
            dimensions: dims,
            is_admin: row.admin_score !== null,
          });
          scoreSum += score;
          scoreCount += 1;

          if (score >= 8) excellent += 1;
          else if (score >= 5) good += 1;
          else needs += 1;
        }

        if (dims) {
          dimSum.workmanship += dims.workmanship;
          dimSum.photo_quality += dims.photo_quality;
          dimSum.completeness += dims.completeness;
          dimSum.communication += dims.communication;
          dimSamples.workmanship.push(dims.workmanship);
          dimSamples.photo_quality.push(dims.photo_quality);
          dimSamples.completeness.push(dims.completeness);
          dimSamples.communication.push(dims.communication);
          dimCount += 1;
        }

        const dayKey = ymd(row.created_at);
        dayCounts.set(dayKey, (dayCounts.get(dayKey) ?? 0) + 1);

        // Prefer the admin-corrected summary (which carries job_type
        // overrides from /admin/submissions/:id/job-type) over the raw AI
        // output. Fall back to summary_json if there's no correction.
        const summarySource = row.corrected_summary_json ?? row.summary_json;
        const summary = summarySource ? safeParse(summarySource) : null;
        const jobType = (summary as { job_type?: string } | null)?.job_type ?? "other";
        const headline = (summary as { headline?: string } | null)?.headline ?? null;

        jobTypeCounts[jobType] = (jobTypeCounts[jobType] ?? 0) + 1;
        if (score !== null) {
          (jobTypeSamples[jobType] ??= []).push(score);
        }

        recent.push({
          id: row.id,
          task_id: row.task_id,
          source: row.source,
          status: row.status,
          created_at: row.created_at,
          job_type: jobType,
          effective_score: score,
          is_admin_override: row.admin_score !== null,
          headline,
        });
      }

      const overall = scoreCount > 0 ? scoreSum / scoreCount : null;
      const dimensions =
        dimCount > 0
          ? {
              workmanship: dimSum.workmanship / dimCount,
              photo_quality: dimSum.photo_quality / dimCount,
              completeness: dimSum.completeness / dimCount,
              communication: dimSum.communication / dimCount,
            }
          : null;

      const consistency = dimCount
        ? {
            workmanship: rangeOf(dimSamples.workmanship),
            photo_quality: rangeOf(dimSamples.photo_quality),
            completeness: rangeOf(dimSamples.completeness),
            communication: rangeOf(dimSamples.communication),
          }
        : null;

      // Activity heatmap as array of { date: "YYYY-MM-DD", weekday: 0..6, count }.
      const activityHeatmap = Array.from(dayCounts.entries())
        .map(([date, count]) => {
          const d = new Date(date + "T00:00:00");
          return { date, weekday: d.getDay(), count };
        })
        .sort((a, b) => a.date.localeCompare(b.date));

      // jobs per active day (days with at least one submission)
      const activeDays = dayCounts.size;
      const jobsPerActiveDay = activeDays > 0 ? rows.length / activeDays : 0;

      // Job-type breakdown with per-type avg score.
      const jobTypeBreakdown: Record<string, { count: number; avg_score: number | null }> = {};
      for (const [type, count] of Object.entries(jobTypeCounts)) {
        const samples = jobTypeSamples[type];
        jobTypeBreakdown[type] = {
          count,
          avg_score:
            samples && samples.length > 0
              ? samples.reduce((a, b) => a + b, 0) / samples.length
              : null,
        };
      }

      return reply.send({
        login,
        period: periodKeyOut(period),
        period_label: periodLabelStr,
        available_months: availableMonths,
        job_count: rows.length,
        overall_score: overall,
        dimensions,
        consistency,
        score_trends: trends,
        score_distribution: { excellent, good, needs_improvement: needs },
        activity_heatmap: activityHeatmap,
        jobs_per_active_day: jobsPerActiveDay,
        active_days: activeDays,
        job_type_breakdown: jobTypeBreakdown,
        // Raw submission timestamps in the period (sorted ascending). The
        // frontend's "Day" heatmap view buckets these by hour so we don't
        // need a separate hourly-aggregation endpoint. Just numbers, so
        // even hundreds of entries weigh next to nothing.
        submission_timestamps_ms: rows.map((r) => r.created_at),
        // Most recent first, capped to 20 — full list available via the
        // existing /admin/submissions endpoint with login filter.
        recent_submissions: recent.slice(-20).reverse(),
      });
    },
  );

  // ---------------------------------------------------------------
  // GET /admin/performance/techs/:login/patterns?period_start=<unix-ms>
  // Returns the cached pattern analysis for a calendar month, or null.
  // ---------------------------------------------------------------
  app.get(
    "/admin/performance/techs/:login/patterns",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { login } = req.params as { login: string };
      const periodStartMs = Number((req.query as { period_start?: string }).period_start);
      if (!Number.isFinite(periodStartMs) || periodStartMs <= 0) {
        return reply.code(400).send({ error: "invalid_period_start" });
      }
      const row = db
        .prepare(
          `SELECT id, app_login, period_start, period_end, generated_at,
                  submission_count, strengths_json, issues_json, coaching_json,
                  summary_text, ai_model
           FROM tech_patterns
           WHERE app_login = ? AND period_start = ?`,
        )
        .get(login, periodStartMs) as
        | {
            id: number;
            app_login: string;
            period_start: number;
            period_end: number;
            generated_at: number;
            submission_count: number;
            strengths_json: string;
            issues_json: string;
            coaching_json: string;
            summary_text: string;
            ai_model: string | null;
          }
        | undefined;
      if (!row) return reply.send({ pattern: null });
      return reply.send({
        pattern: {
          login: row.app_login,
          period_start: row.period_start,
          period_end: row.period_end,
          generated_at: row.generated_at,
          submission_count: row.submission_count,
          strengths: safeParse(row.strengths_json) ?? [],
          issues: safeParse(row.issues_json) ?? [],
          coaching: safeParse(row.coaching_json) ?? [],
          summary: row.summary_text,
          ai_model: row.ai_model,
        },
      });
    },
  );

  // ---------------------------------------------------------------
  // POST /admin/performance/techs/:login/patterns/generate
  // body: { period_start: <unix-ms> }
  // Runs analyzePatterns(), upserts to tech_patterns, returns the result.
  // 503 if Splynx isn't configured (we need task descriptions).
  // 422 if there are too few submissions to analyse meaningfully.
  // ---------------------------------------------------------------
  const GenerateBodySchema = z.object({
    period_start: z.number().int().positive(),
  });
  const MIN_SUBMISSIONS = 3;

  app.post(
    "/admin/performance/techs/:login/patterns/generate",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { login } = req.params as { login: string };
      const parsed = GenerateBodySchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
      const periodStartMs = parsed.data.period_start;
      const periodEndMs = endOfMonth(periodStartMs);

      if (!isSplynxConfigured(config)) {
        return reply.code(503).send({ error: "splynx_not_configured" });
      }

      // Pull the period's submissions for this tech with their ratings.
      const rows = db
        .prepare(
          `SELECT s.id AS submission_id, s.task_id, s.created_at,
                  s.summary_json, s.corrected_summary_json,
                  r.ai_score, r.ai_rationale,
                  r.ai_strengths_json, r.ai_improvements_json,
                  r.admin_score, r.admin_rationale
           FROM submissions s
           LEFT JOIN submission_ratings r ON r.submission_id = s.id
           WHERE s.app_login = ?
             AND s.created_at >= ?
             AND s.created_at < ?
             AND s.hidden = 0
           ORDER BY s.created_at ASC`,
        )
        .all(login, periodStartMs, periodEndMs) as Array<{
        submission_id: number;
        task_id: number;
        created_at: number;
        summary_json: string | null;
        corrected_summary_json: string | null;
        ai_score: number | null;
        ai_rationale: string | null;
        ai_strengths_json: string | null;
        ai_improvements_json: string | null;
        admin_score: number | null;
        admin_rationale: string | null;
      }>;

      if (rows.length < MIN_SUBMISSIONS) {
        return reply.code(422).send({
          error: "too_few_submissions",
          message: `Need at least ${MIN_SUBMISSIONS} submissions in this month to analyse meaningfully (found ${rows.length}).`,
          submission_count: rows.length,
        });
      }

      // Fetch the Splynx task title + description for each unique task id.
      // Cached to a Map so a tech who worked the same task multiple times
      // doesn't trigger duplicate fetches.
      const splynx = getServiceSplynxClient(config);
      const taskCache = new Map<number, { title: string | null; description: string | null }>();
      for (const r of rows) {
        if (taskCache.has(r.task_id)) continue;
        try {
          const t = await splynx.getTaskRaw(r.task_id);
          taskCache.set(r.task_id, {
            title: t.title ?? null,
            description: t.description ?? null,
          });
        } catch {
          taskCache.set(r.task_id, { title: null, description: null });
        }
      }

      // Build the input for the AI call. Prefer corrected summary fields
      // over raw AI summary since they reflect the operator's edits.
      const submissions: SubmissionInput[] = rows.map((r) => {
        const summarySource = r.corrected_summary_json ?? r.summary_json;
        const summary = (summarySource ? safeParse(summarySource) : null) as
          | {
              what_was_done?: string;
              observations?: string;
              follow_ups?: string;
              job_type?: string;
            }
          | null;
        const taskInfo = taskCache.get(r.task_id) ?? { title: null, description: null };
        return {
          submission_id: r.submission_id,
          task_id: r.task_id,
          task_title: taskInfo.title,
          task_description: taskInfo.description,
          created_at: r.created_at,
          job_type: summary?.job_type ?? "other",
          summary_what_was_done: summary?.what_was_done ?? null,
          summary_observations: summary?.observations ?? null,
          summary_follow_ups: summary?.follow_ups ?? null,
          ai_score: r.ai_score,
          ai_rationale: r.ai_rationale,
          ai_strengths: parseStringArrayLocal(r.ai_strengths_json),
          ai_improvements: parseStringArrayLocal(r.ai_improvements_json),
          admin_score: r.admin_score,
          admin_rationale: r.admin_rationale,
        };
      });

      let result;
      try {
        result = await analyzePatterns({
          config,
          appLogin: login,
          periodStart: periodStartMs,
          periodEnd: periodEndMs,
          submissions,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        req.log.error({ err }, "patterns analyze failed");
        return reply.code(503).send({ error: "analyze_failed", detail: msg });
      }

      const now = Date.now();
      db.prepare(
        `INSERT INTO tech_patterns (
           app_login, period_start, period_end, generated_at, submission_count,
           strengths_json, issues_json, coaching_json, summary_text,
           raw_response_json, ai_model
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(app_login, period_start) DO UPDATE SET
           period_end = excluded.period_end,
           generated_at = excluded.generated_at,
           submission_count = excluded.submission_count,
           strengths_json = excluded.strengths_json,
           issues_json = excluded.issues_json,
           coaching_json = excluded.coaching_json,
           summary_text = excluded.summary_text,
           raw_response_json = excluded.raw_response_json,
           ai_model = excluded.ai_model`,
      ).run(
        login,
        periodStartMs,
        periodEndMs,
        now,
        rows.length,
        JSON.stringify(result.strengths),
        JSON.stringify(result.issues),
        JSON.stringify(result.coaching),
        result.summary,
        JSON.stringify(result),
        config.CLAUDE_MODEL,
      );

      return reply.send({
        pattern: {
          login,
          period_start: periodStartMs,
          period_end: periodEndMs,
          generated_at: now,
          submission_count: rows.length,
          strengths: result.strengths,
          issues: result.issues,
          coaching: result.coaching,
          summary: result.summary,
          ai_model: config.CLAUDE_MODEL,
        },
      });
    },
  );
}

// Calendar end-of-month given a 1st-of-month timestamp (returns first ms of
// the *next* month, exclusive — paired with `>=` and `<` SQL bounds).
function endOfMonth(periodStartMs: number): number {
  const d = new Date(periodStartMs);
  return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
}

// ---------- helpers ----------

function parseDims(json: string | null): DimensionScores | null {
  if (!json) return null;
  try {
    const obj = JSON.parse(json) as Record<string, unknown>;
    const w = num(obj.workmanship);
    const p = num(obj.photo_quality);
    const c = num(obj.completeness);
    const m = num(obj.communication);
    if (w === null || p === null || c === null || m === null) return null;
    return { workmanship: w, photo_quality: p, completeness: c, communication: m };
  } catch {
    return null;
  }
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function parseStringArrayLocal(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

function rangeOf(samples: number[]): { min: number; max: number; stddev: number; consistent: boolean } {
  if (samples.length === 0) return { min: 0, max: 0, stddev: 0, consistent: true };
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length;
  const stddev = Math.sqrt(variance);
  return { min, max, stddev, consistent: stddev < 1.0 };
}

function ymd(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

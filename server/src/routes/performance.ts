import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { makeAuthGuards } from "../lib/auth-guards.js";
import { getDb } from "../db.js";
import type { AppConfig } from "../config.js";

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

const PeriodSchema = z
  .enum(["this_month", "last_30", "this_quarter", "all"])
  .default("this_month");

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
    const period = PeriodSchema.parse(
      (req.query as { period?: string }).period ?? "this_month",
    );
    const since = periodStart(period);

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
         WHERE s.created_at >= ?`,
      )
      .all(since) as Array<{
      app_login: string;
      created_at: number;
      ai_score: number | null;
      admin_score: number | null;
      ai_dimensions_json: string | null;
      admin_dimensions_json: string | null;
    }>;

    // Also fetch the all-time list of techs that have ever submitted, so a
    // tech with zero submissions in the period still shows up.
    const allTechs = db
      .prepare(`SELECT DISTINCT app_login FROM submissions ORDER BY app_login`)
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
      period,
      since,
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
      const period = PeriodSchema.parse(
        (req.query as { period?: string }).period ?? "this_month",
      );
      const since = periodStart(period);
      const periodLabel = periodLabelFor(period, since);

      const rows = db
        .prepare(
          `SELECT s.id, s.task_id, s.app_login, s.source, s.status, s.created_at,
                  s.summary_json,
                  r.ai_score, r.admin_score,
                  r.ai_dimensions_json, r.admin_dimensions_json
           FROM submissions s
           LEFT JOIN submission_ratings r ON r.submission_id = s.id
           WHERE s.app_login = ? AND s.created_at >= ?
           ORDER BY s.created_at ASC`,
        )
        .all(login, since) as Array<
        Omit<SubmissionRow, "job_type"> & { summary_json: string | null }
      >;

      if (rows.length === 0) {
        return reply.send({
          login,
          period,
          period_label: periodLabel,
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

        const summary = row.summary_json ? safeParse(row.summary_json) : null;
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
        period,
        period_label: periodLabel,
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
        // Most recent first, capped to 20 — full list available via the
        // existing /admin/submissions endpoint with login filter.
        recent_submissions: recent.slice(-20).reverse(),
      });
    },
  );
}

// ---------- helpers ----------

function periodStart(period: z.infer<typeof PeriodSchema>): number {
  const now = new Date();
  if (period === "this_month") {
    const d = new Date(now.getFullYear(), now.getMonth(), 1);
    return d.getTime();
  }
  if (period === "last_30") {
    return now.getTime() - 30 * 24 * 60 * 60 * 1000;
  }
  if (period === "this_quarter") {
    const q = Math.floor(now.getMonth() / 3);
    const d = new Date(now.getFullYear(), q * 3, 1);
    return d.getTime();
  }
  return 0;
}

function periodLabelFor(period: z.infer<typeof PeriodSchema>, since: number): string {
  if (period === "all") return "all time";
  const d = new Date(since);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `since ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

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

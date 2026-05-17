import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ApiError, api } from "../../api";

// "all" or a YYYY-MM month string. The server returns the canonical list
// of months in which this tech has submissions in `available_months`.
type Period = string;

function currentMonthKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function formatMonthLabel(ym: string): string {
  // "2026-05" → "May 2026"
  const [y, m] = ym.split("-").map(Number);
  if (!y || !m) return ym;
  const d = new Date(y, m - 1, 1);
  return d.toLocaleString("en-ZA", { month: "long", year: "numeric" });
}

interface Dimensions {
  workmanship: number;
  photo_quality: number;
  completeness: number;
  communication: number;
}

interface ConsistencyEntry {
  min: number;
  max: number;
  stddev: number;
  consistent: boolean;
}

interface Trend {
  submission_id: number;
  created_at: number;
  overall: number;
  dimensions: Dimensions | null;
  is_admin: boolean;
}

interface RecentSubmission {
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

interface ProfileResponse {
  login: string;
  period: Period;
  period_label: string;
  available_months: string[];
  job_count: number;
  late_submissions: number;
  overall_score: number | null;
  dimensions: Dimensions | null;
  consistency: {
    workmanship: ConsistencyEntry;
    photo_quality: ConsistencyEntry;
    completeness: ConsistencyEntry;
    communication: ConsistencyEntry;
  } | null;
  score_trends: Trend[];
  score_distribution: { excellent: number; good: number; needs_improvement: number };
  activity_heatmap: { date: string; weekday: number; count: number }[];
  jobs_per_active_day: number;
  active_days?: number;
  job_type_breakdown: Record<string, { count: number; avg_score: number | null }>;
  submission_timestamps_ms?: number[];
  recent_submissions: RecentSubmission[];
}

const DIM_LABELS = {
  workmanship: "Workmanship",
  photo_quality: "Photo Quality",
  completeness: "Completeness",
  communication: "Communication",
} as const;

const DIM_KEYS = ["workmanship", "photo_quality", "completeness", "communication"] as const;

export function TechProfile() {
  const { login } = useParams<{ login: string }>();
  // Default to the current calendar month — selecting a different month
  // re-bounds every panel below to that month only.
  const [period, setPeriod] = useState<Period>(currentMonthKey());
  const [data, setData] = useState<ProfileResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const filter = searchParams.get("filter");

  useEffect(() => {
    if (!login) return;
    setData(null);
    setError(null);
    api
      .get<ProfileResponse>(
        `/admin/performance/techs/${encodeURIComponent(login)}?period=${period}`,
      )
      .then(setData)
      .catch((e: unknown) => {
        if (e instanceof ApiError) setError(`Failed to load (${e.status})`);
        else setError("Network error");
      });
  }, [login, period]);

  if (error) return <div className="panel danger">{error}</div>;
  if (!data) return <div className="panel muted">Loading…</div>;

  return (
    <div className="stack">
      <div>
        <Link to="/admin/performance">← All techs</Link>
      </div>

      <Header data={data} period={period} setPeriod={setPeriod} />

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "1rem",
        }}
      >
        <DimensionsPanel data={data} />
        <ConsistencyPanel data={data} />
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1.4fr 1fr",
          gap: "1rem",
        }}
      >
        <ScoreTrendsPanel data={data} />
        <ScoreDistributionPanel data={data} />
      </div>

      <ActivityHeatmapPanel data={data} period={period} />

      <JobTypeBreakdownPanel data={data} />

      <RecentSubmissionsPanel
        data={data}
        filter={filter}
        clearFilter={() => setSearchParams({})}
      />

      <PatternsPanel login={login ?? ""} period={period} />
    </div>
  );
}

// ---------- panels ----------

function Header({
  data,
  period,
  setPeriod,
}: {
  data: ProfileResponse;
  period: Period;
  setPeriod: (p: Period) => void;
}) {
  return (
    <div
      className="panel"
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 12,
      }}
    >
      <div>
        <h1 style={{ margin: 0 }}>{data.login}</h1>
        <div className="muted" style={{ fontSize: "0.9em" }}>
          {data.job_count} job{data.job_count === 1 ? "" : "s"} · {data.period_label}
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <select
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
          style={{ width: "auto", minWidth: 160 }}
          aria-label="Reporting period"
        >
          {(data.available_months ?? [period]).map((m) => (
            <option key={m} value={m}>
              {formatMonthLabel(m)}
            </option>
          ))}
          <option value="all">All time</option>
        </select>
        <div style={{ textAlign: "right" }}>
          {data.overall_score !== null ? (
            <div
              style={{
                fontSize: "2.6em",
                fontWeight: 600,
                color: scoreColor(data.overall_score),
                lineHeight: 1,
              }}
            >
              {data.overall_score.toFixed(1)}
              <span style={{ fontSize: "0.5em", color: "var(--c-muted)", fontWeight: 400 }}>
                {" "}
                /10
              </span>
            </div>
          ) : (
            <span className="muted">No rated submissions</span>
          )}
        </div>
      </div>
    </div>
  );
}

function DimensionsPanel({ data }: { data: ProfileResponse }) {
  if (!data.dimensions) {
    return (
      <div className="panel muted">
        <h3 style={{ margin: 0 }}>Dimensions</h3>
        <p>No rated submissions yet.</p>
      </div>
    );
  }
  const d = data.dimensions;
  return (
    <div className="panel stack">
      <h3 style={{ margin: 0 }}>Dimensions (avg, scale 1–10)</h3>
      {DIM_KEYS.map((k) => (
        <DimensionBar key={k} label={DIM_LABELS[k]} value={d[k]} />
      ))}
    </div>
  );
}

function DimensionBar({ label, value }: { label: string; value: number }) {
  const pct = Math.max(0, Math.min(100, (value / 10) * 100));
  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", fontSize: "0.9em" }}>
        <strong>{label}</strong>
        <span style={{ color: scoreColor(value) }}>{value.toFixed(1)} /10</span>
      </div>
      <div
        style={{
          height: 8,
          background: "#1a2029",
          borderRadius: 4,
          overflow: "hidden",
          marginTop: 4,
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${pct}%`,
            background: scoreColor(value),
            transition: "width 240ms",
          }}
        />
      </div>
    </div>
  );
}

function ConsistencyPanel({ data }: { data: ProfileResponse }) {
  if (!data.consistency) {
    return (
      <div className="panel muted">
        <h3 style={{ margin: 0 }}>Consistency</h3>
        <p>Need more rated submissions to compute.</p>
      </div>
    );
  }
  const c = data.consistency;
  return (
    <div className="panel stack">
      <h3 style={{ margin: 0 }}>Consistency</h3>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
          gap: 8,
        }}
      >
        {DIM_KEYS.map((k) => (
          <ConsistencyChip key={k} label={DIM_LABELS[k]} entry={c[k]} />
        ))}
      </div>
    </div>
  );
}

function ConsistencyChip({ label, entry }: { label: string; entry: ConsistencyEntry }) {
  return (
    <div
      style={{
        background: "#1a2029",
        border: "none",
        borderRadius: "var(--r)",
        padding: 8,
        boxShadow: "0 1px 2px rgba(0,0,0,0.4)",
      }}
    >
      <div className="muted" style={{ fontSize: "0.7em", textTransform: "uppercase" }}>
        {label}
      </div>
      <div>
        <strong>
          {entry.min === entry.max
            ? entry.min.toFixed(1)
            : `${entry.min.toFixed(1)}–${entry.max.toFixed(1)}`}
        </strong>
      </div>
      <div className="muted" style={{ fontSize: "0.8em" }}>
        {entry.consistent ? "consistent" : "variable"} ({entry.stddev.toFixed(2)})
      </div>
    </div>
  );
}

function ScoreTrendsPanel({ data }: { data: ProfileResponse }) {
  // Build the chart data: one row per submission, with overall + each dimension.
  const chartData = useMemo(() => {
    return data.score_trends.map((t) => ({
      date: new Date(t.created_at).toISOString().slice(0, 10),
      overall: t.overall,
      workmanship: t.dimensions?.workmanship,
      photo_quality: t.dimensions?.photo_quality,
      completeness: t.dimensions?.completeness,
      communication: t.dimensions?.communication,
    }));
  }, [data.score_trends]);

  if (chartData.length === 0) {
    return (
      <div className="panel muted">
        <h3 style={{ margin: 0 }}>Score trends</h3>
        <p>No data in this period.</p>
      </div>
    );
  }

  return (
    <div className="panel stack">
      <h3 style={{ margin: 0 }}>Score trends</h3>
      <div style={{ width: "100%", height: 260 }}>
        <ResponsiveContainer>
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#232a33" />
            <XAxis dataKey="date" stroke="#8b949e" tick={{ fontSize: 11 }} />
            <YAxis domain={[0, 10]} stroke="#8b949e" tick={{ fontSize: 11 }} />
            <Tooltip
              contentStyle={{
                background: "#1a2029",
                border: "1px solid #232a33",
                borderRadius: 8,
                boxShadow: "0 8px 24px rgba(0,0,0,0.55)",
              }}
              labelStyle={{ color: "#e6edf3" }}
            />
            <Legend wrapperStyle={{ fontSize: "0.85em" }} />
            <Line type="monotone" dataKey="overall" stroke="#a371f7" strokeWidth={2} dot />
            <Line type="monotone" dataKey="workmanship" stroke="#56d364" dot={false} />
            <Line type="monotone" dataKey="photo_quality" stroke="#79c0ff" dot={false} />
            <Line type="monotone" dataKey="completeness" stroke="#e3b341" dot={false} />
            <Line type="monotone" dataKey="communication" stroke="#ff7b72" dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function ScoreDistributionPanel({ data }: { data: ProfileResponse }) {
  const d = data.score_distribution;
  const total = d.excellent + d.good + d.needs_improvement;
  if (total === 0) {
    return (
      <div className="panel muted">
        <h3 style={{ margin: 0 }}>Score distribution</h3>
        <p>No rated submissions in this period.</p>
      </div>
    );
  }

  const chart = [
    { name: "Excellent (8–10)", value: d.excellent, fill: "#56d364" },
    { name: "Good (5–7)", value: d.good, fill: "#e3b341" },
    { name: "Needs Improvement (<5)", value: d.needs_improvement, fill: "#ff7b72" },
  ];

  return (
    <div className="panel stack">
      <h3 style={{ margin: 0 }}>Score distribution</h3>
      <div style={{ width: "100%", height: 260 }}>
        <ResponsiveContainer>
          <PieChart>
            <Pie
              data={chart}
              dataKey="value"
              nameKey="name"
              innerRadius="50%"
              outerRadius="80%"
              paddingAngle={2}
              isAnimationActive={false}
            />
            {/* Per-slice fill is read off the `fill` property on each data
                item — Cell was deprecated in recharts 3.x. */}
            <Tooltip
              contentStyle={{
                background: "#1a2029",
                border: "1px solid #232a33",
                borderRadius: 8,
                boxShadow: "0 8px 24px rgba(0,0,0,0.55)",
              }}
            />
            <Legend wrapperStyle={{ fontSize: "0.85em" }} />
          </PieChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function ActivityHeatmapPanel({ data }: { data: ProfileResponse; period: Period }) {
  const [view, setView] = useState<"day" | "week" | "month">("month");
  const cells = data.activity_heatmap;

  // Map sparse API data → dense lookup keyed by "YYYY-MM-DD".
  const countByDate = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of cells) m.set(c.date, c.count);
    return m;
  }, [cells]);

  if (cells.length === 0) {
    return (
      <div className="panel muted">
        <h3 style={{ margin: 0 }}>Activity</h3>
        <p>No activity in this period.</p>
      </div>
    );
  }

  const maxCount = Math.max(...cells.map((c) => c.count), 1);
  const stats = `${data.job_count} submissions · ${data.active_days ?? cells.length} active days · ${data.jobs_per_active_day.toFixed(1)} avg/active day · ${data.late_submissions} after 5:30 PM`;

  return (
    <div className="panel stack">
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div className="row" style={{ gap: 8, alignItems: "center" }}>
          <h3 style={{ margin: 0 }}>Activity heatmap</h3>
          <div className="row" style={{ gap: 4 }}>
            <button
              onClick={() => setView("day")}
              className={view === "day" ? "" : "secondary"}
              style={{ padding: "4px 10px", fontSize: "0.85em" }}
            >
              Day
            </button>
            <button
              onClick={() => setView("week")}
              className={view === "week" ? "" : "secondary"}
              style={{ padding: "4px 10px", fontSize: "0.85em" }}
            >
              Week
            </button>
            <button
              onClick={() => setView("month")}
              className={view === "month" ? "" : "secondary"}
              style={{ padding: "4px 10px", fontSize: "0.85em" }}
            >
              Month
            </button>
          </div>
        </div>
        <span className="muted" style={{ fontSize: "0.85em" }}>
          {stats}
        </span>
      </div>

      {view === "day" ? (
        <DayHeatmap timestamps={data.submission_timestamps_ms ?? []} countByDate={countByDate} />
      ) : view === "month" ? (
        <MonthHeatmap countByDate={countByDate} maxCount={maxCount} />
      ) : (
        <WeekHeatmap countByDate={countByDate} maxCount={maxCount} />
      )}
    </div>
  );
}

const WEEKDAY_HEADERS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * Week × Hour heatmap: 7 rows (Mon-Sun) × 16 columns (7am-10pm). Lets the
 * operator spot day-of-week + time-of-day patterns at a single glance —
 * "never works Wednesdays", "loads up mornings only", "always quits by 4pm",
 * etc. Defaults to the current week; prev/next/today buttons step through
 * weeks. Hours outside 7am-10pm are tallied in the caption so out-of-window
 * submissions stay visible.
 *
 * Hours are rendered in the api container's local time (Africa/Johannesburg
 * per the TZ env var on the api service).
 */
const DAY_VIEW_START_HOUR = 7;
const DAY_VIEW_END_HOUR = 22;
const DAY_VIEW_HOURS = Array.from(
  { length: DAY_VIEW_END_HOUR - DAY_VIEW_START_HOUR + 1 },
  (_, i) => DAY_VIEW_START_HOUR + i,
);

function startOfWeek(d: Date): Date {
  const dowMon0 = (d.getDay() + 6) % 7;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - dowMon0);
}

function DayHeatmap({
  timestamps,
}: {
  timestamps: number[];
  // countByDate is unused here but kept in the prop type for symmetry with
  // the other heatmap views.
  countByDate: Map<string, number>;
}) {
  const today = useMemo(() => new Date(), []);
  const todayKey = ymd(today.getFullYear(), today.getMonth(), today.getDate());
  const thisWeekMonday = useMemo(() => startOfWeek(today), [today]);

  const [weekMonday, setWeekMonday] = useState<Date>(thisWeekMonday);

  // Build the 7 day Date objects for the visible week.
  const days = useMemo(() => {
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(weekMonday);
      d.setDate(weekMonday.getDate() + i);
      return d;
    });
  }, [weekMonday]);

  // Bucket timestamps → per-day, per-hour counts.
  const hourCounts = useMemo(() => {
    const m = new Map<string, Map<number, number>>();
    for (const ts of timestamps) {
      const d = new Date(ts);
      const dateStr = ymd(d.getFullYear(), d.getMonth(), d.getDate());
      const h = d.getHours();
      let dayMap = m.get(dateStr);
      if (!dayMap) {
        dayMap = new Map();
        m.set(dateStr, dayMap);
      }
      dayMap.set(h, (dayMap.get(h) ?? 0) + 1);
    }
    return m;
  }, [timestamps]);

  // Totals for the visible week (in-window vs out-of-window) and the max
  // single-cell count for colour-scale normalisation.
  const { weekTotal, outOfWindow, maxCellCount } = useMemo(() => {
    let total = 0;
    let outside = 0;
    let max = 1;
    for (const day of days) {
      const dateStr = ymd(day.getFullYear(), day.getMonth(), day.getDate());
      const dayMap = hourCounts.get(dateStr);
      if (!dayMap) continue;
      for (const [h, c] of dayMap) {
        total += c;
        if (h < DAY_VIEW_START_HOUR || h > DAY_VIEW_END_HOUR) outside += c;
        if (h >= DAY_VIEW_START_HOUR && h <= DAY_VIEW_END_HOUR && c > max) max = c;
      }
    }
    return { weekTotal: total, outOfWindow: outside, maxCellCount: max };
  }, [days, hourCounts]);

  function stepWeek(delta: number) {
    const next = new Date(weekMonday);
    next.setDate(weekMonday.getDate() + delta * 7);
    setWeekMonday(next);
  }

  const sunday = new Date(weekMonday);
  sunday.setDate(weekMonday.getDate() + 6);
  const weekLabel =
    weekMonday.getMonth() === sunday.getMonth()
      ? `${weekMonday.toLocaleDateString("en-ZA", { day: "numeric" })} – ${sunday.toLocaleDateString(
          "en-ZA",
          { day: "numeric", month: "short", year: "numeric" },
        )}`
      : `${weekMonday.toLocaleDateString("en-ZA", { day: "numeric", month: "short" })} – ${sunday.toLocaleDateString(
          "en-ZA",
          { day: "numeric", month: "short", year: "numeric" },
        )}`;

  const isThisWeek = weekMonday.getTime() === thisWeekMonday.getTime();

  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <button
          className="secondary"
          onClick={() => stepWeek(-1)}
          style={{ padding: "4px 10px" }}
          title="Previous week"
        >
          ←
        </button>
        <strong style={{ minWidth: 180, textAlign: "center" }}>{weekLabel}</strong>
        <button
          className="secondary"
          onClick={() => stepWeek(1)}
          style={{ padding: "4px 10px" }}
          title="Next week"
        >
          →
        </button>
        {!isThisWeek && (
          <button
            className="secondary"
            onClick={() => setWeekMonday(thisWeekMonday)}
            style={{ padding: "4px 10px", fontSize: "0.85em" }}
          >
            This week
          </button>
        )}
        <span className="muted" style={{ fontSize: "0.85em" }}>
          {weekTotal} submission{weekTotal === 1 ? "" : "s"} this week
          {outOfWindow > 0 && <> · {outOfWindow} outside 7am–10pm window</>}
        </span>
      </div>

      <div style={{ overflowX: "auto" }}>
        <div
          style={{
            display: "grid",
            // First column for the day label, then 16 hour columns.
            gridTemplateColumns: `min-content repeat(${DAY_VIEW_HOURS.length}, minmax(28px, 1fr))`,
            gap: 4,
            minWidth: 720,
          }}
        >
          {/* Header row: blank corner + hour labels */}
          <div></div>
          {DAY_VIEW_HOURS.map((h) => (
            <div
              key={`hh-${h}`}
              className="muted"
              style={{ fontSize: "0.7em", textAlign: "center", textTransform: "uppercase" }}
            >
              {formatHourLabel(h)}
            </div>
          ))}

          {/* One row per day (Mon-Sun) */}
          {days.map((day) => {
            const dateStr = ymd(day.getFullYear(), day.getMonth(), day.getDate());
            const isToday = dateStr === todayKey;
            const isFuture = day > today && !isToday;
            const dayMap = hourCounts.get(dateStr);
            const dayTotal = dayMap
              ? Array.from(dayMap.values()).reduce((a, b) => a + b, 0)
              : 0;
            return (
              <DayRow
                key={dateStr}
                day={day}
                dateStr={dateStr}
                isToday={isToday}
                isFuture={isFuture}
                hourMap={dayMap}
                maxCellCount={maxCellCount}
                dayTotal={dayTotal}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

function DayRow({
  day,
  dateStr,
  isToday,
  isFuture,
  hourMap,
  maxCellCount,
  dayTotal,
}: {
  day: Date;
  dateStr: string;
  isToday: boolean;
  isFuture: boolean;
  hourMap: Map<number, number> | undefined;
  maxCellCount: number;
  dayTotal: number;
}) {
  const label = day.toLocaleDateString("en-ZA", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
  return (
    <>
      <div
        className="muted"
        style={{
          fontSize: "0.75em",
          paddingRight: 8,
          whiteSpace: "nowrap",
          alignSelf: "center",
          fontWeight: isToday ? 600 : 400,
          color: isToday ? "var(--c-accent)" : undefined,
          opacity: isFuture ? 0.5 : 1,
        }}
        title={`${label} — ${dayTotal} submission${dayTotal === 1 ? "" : "s"}`}
      >
        {label}
      </div>
      {DAY_VIEW_HOURS.map((h) => {
        const count = hourMap?.get(h) ?? 0;
        return (
          <div
            key={`${dateStr}-${h}`}
            title={`${dateStr} ${formatHourLabel(h)}: ${count} submission${count === 1 ? "" : "s"}`}
            style={{
              height: 28,
              borderRadius: 4,
              background: count > 0 ? heatColor(count, maxCellCount) : "#13181f",
              border: isToday ? "1px solid #2f81f7" : "1px solid #232a33",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "0.75em",
              fontWeight: 600,
              color: count > maxCellCount * 0.5 ? "#0a0d12" : "#e6edf3",
              opacity: isFuture ? 0.4 : 1,
            }}
          >
            {count > 0 ? count : ""}
          </div>
        );
      })}
    </>
  );
}

function formatHourLabel(h: number): string {
  if (h === 0) return "12am";
  if (h < 12) return `${h}am`;
  if (h === 12) return "12pm";
  return `${h - 12}pm`;
}

/**
 * Standard calendar month grid: 7 columns Mon-Sun, weeks as rows.
 * Pads with blank cells before the 1st and after the last day so the grid
 * is rectangular. Picks the most recent month with activity (or current
 * month if there's none).
 */
function MonthHeatmap({
  countByDate,
  maxCount,
}: {
  countByDate: Map<string, number>;
  maxCount: number;
}) {
  const dates = Array.from(countByDate.keys()).sort();
  const ref = dates.length > 0 ? new Date(dates[dates.length - 1]! + "T00:00:00") : new Date();
  const year = ref.getFullYear();
  const month = ref.getMonth();
  const firstOfMonth = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  // Convert JS getDay (Sun=0..Sat=6) → Mon=0..Sun=6.
  const leadingBlanks = (firstOfMonth.getDay() + 6) % 7;

  const cells: ({ date: string; count: number } | null)[] = [];
  for (let i = 0; i < leadingBlanks; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    const date = ymd(year, month, d);
    cells.push({ date, count: countByDate.get(date) ?? 0 });
  }
  while (cells.length % 7 !== 0) cells.push(null);

  const monthLabel = ref.toLocaleString("en-ZA", { month: "long", year: "numeric" });

  return (
    <div>
      <div style={{ marginBottom: 8, fontWeight: 500 }}>{monthLabel}</div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
          gap: 4,
        }}
      >
        {WEEKDAY_HEADERS.map((d) => (
          <div
            key={d}
            className="muted"
            style={{ fontSize: "0.7em", textAlign: "center", textTransform: "uppercase" }}
          >
            {d}
          </div>
        ))}
        {cells.map((c, i) => (
          <HeatCell key={i} cell={c} maxCount={maxCount} />
        ))}
      </div>
    </div>
  );
}

/**
 * Multi-week view: most recent 4 weeks (Mon-Sun) stacked vertically. The
 * leftmost label on each row shows the Monday's date so it's easy to
 * locate a specific week.
 */
function WeekHeatmap({
  countByDate,
  maxCount,
}: {
  countByDate: Map<string, number>;
  maxCount: number;
}) {
  const today = new Date();
  const dowMon0 = (today.getDay() + 6) % 7;
  const thisMonday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - dowMon0);

  const WEEKS_TO_SHOW = 4;
  const weeks: { mondayLabel: string; days: { date: string; count: number }[] }[] = [];
  for (let w = WEEKS_TO_SHOW - 1; w >= 0; w--) {
    const monday = new Date(thisMonday);
    monday.setDate(thisMonday.getDate() - w * 7);
    const days: { date: string; count: number }[] = [];
    for (let d = 0; d < 7; d++) {
      const day = new Date(monday);
      day.setDate(monday.getDate() + d);
      const date = ymd(day.getFullYear(), day.getMonth(), day.getDate());
      days.push({ date, count: countByDate.get(date) ?? 0 });
    }
    weeks.push({
      mondayLabel: monday.toLocaleDateString("en-ZA", { day: "numeric", month: "short" }),
      days,
    });
  }

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "min-content repeat(7, minmax(0, 1fr))",
        gap: 4,
        alignItems: "center",
      }}
    >
      <div></div>
      {WEEKDAY_HEADERS.map((d) => (
        <div
          key={d}
          className="muted"
          style={{ fontSize: "0.7em", textAlign: "center", textTransform: "uppercase" }}
        >
          {d}
        </div>
      ))}
      {weeks.map((week) => (
        <WeekRow key={week.days[0]!.date} mondayLabel={week.mondayLabel} days={week.days} maxCount={maxCount} />
      ))}
    </div>
  );
}

function WeekRow({
  mondayLabel,
  days,
  maxCount,
}: {
  mondayLabel: string;
  days: { date: string; count: number }[];
  maxCount: number;
}) {
  return (
    <>
      <div
        className="muted"
        style={{ fontSize: "0.7em", paddingRight: 8, whiteSpace: "nowrap" }}
      >
        {mondayLabel}
      </div>
      {days.map((d) => (
        <HeatCell key={d.date} cell={d} maxCount={maxCount} />
      ))}
    </>
  );
}

function HeatCell({
  cell,
  maxCount,
}: {
  cell: { date: string; count: number } | null;
  maxCount: number;
}) {
  if (!cell) {
    return <div style={{ height: 40, background: "transparent" }} />;
  }
  const dayNum = Number(cell.date.slice(8, 10));
  const today = new Date();
  const isToday =
    cell.date === ymd(today.getFullYear(), today.getMonth(), today.getDate());
  const isFuture = new Date(cell.date + "T00:00:00") > today;
  return (
    <div
      title={`${cell.date}: ${cell.count} submission${cell.count === 1 ? "" : "s"}`}
      style={{
        height: 40,
        borderRadius: 4,
        background: cell.count > 0 ? heatColor(cell.count, maxCount) : "#13181f",
        border: isToday ? "1px solid #2f81f7" : "1px solid #232a33",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        fontSize: "0.7em",
        color: cell.count > maxCount * 0.5 ? "#0a0d12" : "#e6edf3",
        opacity: isFuture ? 0.35 : 1,
        position: "relative",
      }}
    >
      <span style={{ fontSize: "0.75em", opacity: 0.6, lineHeight: 1 }}>{dayNum}</span>
      {cell.count > 0 && (
        <span style={{ fontWeight: 600, lineHeight: 1.2 }}>{cell.count}</span>
      )}
    </div>
  );
}

function ymd(year: number, monthZeroBased: number, day: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${year}-${pad(monthZeroBased + 1)}-${pad(day)}`;
}

function JobTypeBreakdownPanel({ data }: { data: ProfileResponse }) {
  const types = Object.entries(data.job_type_breakdown).sort((a, b) => b[1].count - a[1].count);
  if (types.length === 0) {
    return null;
  }
  return (
    <div className="panel stack">
      <h3 style={{ margin: 0 }}>Job type breakdown</h3>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.92em" }}>
        <thead>
          <tr style={{ textAlign: "left", color: "var(--c-muted)" }}>
            <th style={{ padding: "8px 8px", fontWeight: 500, fontSize: "0.85em", textTransform: "uppercase" }}>Type</th>
            <th style={{ padding: "8px 8px", fontWeight: 500, fontSize: "0.85em", textTransform: "uppercase", textAlign: "right" }}>Jobs</th>
            <th style={{ padding: "8px 8px", fontWeight: 500, fontSize: "0.85em", textTransform: "uppercase", textAlign: "right" }}>Avg score</th>
          </tr>
        </thead>
        <tbody>
          {types.map(([type, info]) => (
            <tr key={type} style={{ borderTop: "1px solid var(--c-border)" }}>
              <td style={{ padding: "10px 8px" }}>{prettyType(type)}</td>
              <td style={{ padding: "10px 8px", textAlign: "right" }}>{info.count}</td>
              <td style={{ padding: "10px 8px", textAlign: "right" }}>
                {info.avg_score !== null ? (
                  <span style={{ color: scoreColor(info.avg_score) }}>
                    {info.avg_score.toFixed(1)}
                  </span>
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------- Patterns panel (admin-only AI coaching analysis) ----------

interface PatternStrength {
  title: string;
  evidence: string;
}
interface PatternIssue {
  title: string;
  evidence: string;
  frequency: string;
}
interface Pattern {
  login: string;
  period_start: number;
  period_end: number;
  generated_at: number;
  submission_count: number;
  strengths: PatternStrength[];
  issues: PatternIssue[];
  coaching: string[];
  summary: string;
  ai_model: string | null;
}

function PatternsPanel({ login, period }: { login: string; period: Period }) {
  const [pattern, setPattern] = useState<Pattern | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Patterns are scoped to a calendar month. With month-based period
  // selection any YYYY-MM is a valid month boundary; the "all" lifetime
  // view has no single month to analyse, so the panel hides for it.
  const monthBoundary = useMemo(() => {
    if (period === "all") return null;
    const match = period.match(/^(\d{4})-(\d{2})$/);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    return new Date(year, month - 1, 1).getTime();
  }, [period]);

  useEffect(() => {
    if (!login || monthBoundary === null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    api
      .get<{ pattern: Pattern | null }>(
        `/admin/performance/techs/${encodeURIComponent(login)}/patterns?period_start=${monthBoundary}`,
      )
      .then((r) => setPattern(r.pattern))
      .catch((e: unknown) => {
        setError(e instanceof ApiError ? `Load failed (${e.status})` : "Network error");
      })
      .finally(() => setLoading(false));
  }, [login, monthBoundary]);

  async function clear() {
    if (!login || monthBoundary === null || !pattern) return;
    if (!confirm("Delete the analysis for this month? You can re-run it later.")) return;
    setBusy(true);
    setError(null);
    try {
      await api.delete(
        `/admin/performance/techs/${encodeURIComponent(login)}/patterns?period_start=${monthBoundary}`,
      );
      setPattern(null);
    } catch (e: unknown) {
      setError(e instanceof ApiError ? `Clear failed (${e.status})` : "Network error");
    } finally {
      setBusy(false);
    }
  }

  async function generate() {
    if (!login || monthBoundary === null) return;
    if (
      pattern &&
      !confirm(
        "Re-running the analysis will overwrite the existing one for this month. Continue?",
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ pattern: Pattern }>(
        `/admin/performance/techs/${encodeURIComponent(login)}/patterns/generate`,
        { period_start: monthBoundary },
      );
      setPattern(res.pattern);
    } catch (e: unknown) {
      if (e instanceof ApiError) {
        if (e.status === 422) {
          const body = e.body as { message?: string; submission_count?: number };
          setError(body.message ?? "Too few submissions for this month.");
        } else if (e.status === 503) {
          const body = e.body as { detail?: string };
          setError(body.detail ?? "Analysis service unavailable.");
        } else {
          setError(`Failed (${e.status})`);
        }
      } else {
        setError("Network error");
      }
    } finally {
      setBusy(false);
    }
  }

  if (monthBoundary === null) {
    return (
      <div
        className="panel stack"
        style={{ border: "2px dashed var(--c-warn)" }}
      >
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h3 style={{ margin: 0 }}>Patterns</h3>
          <span className="badge warn">admin-only</span>
        </div>
        <p className="muted">
          Switch to a specific month in the dropdown above to run the AI pattern analysis —
          it operates on calendar-month boundaries.
        </p>
      </div>
    );
  }

  return (
    <div className="panel stack" style={{ border: "2px dashed var(--c-warn)" }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h3 style={{ margin: 0 }}>Patterns</h3>
        <span className="badge warn">admin-only — never sent externally</span>
      </div>
      <p className="muted" style={{ margin: 0, fontSize: "0.9em" }}>
        AI-summarised strengths, recurring issues, and coaching points across this calendar
        month's submissions. Uses tech notes, AI ratings, your rating overrides, and Splynx
        task descriptions as input. Result stays admin-only.
      </p>

      {loading ? (
        <p className="muted">Loading…</p>
      ) : pattern ? (
        <PatternResultDisplay pattern={pattern} />
      ) : (
        <p className="muted">
          No analysis yet for this month. Click <strong>Generate analysis</strong> to run
          one. Roughly £0.05 per generation.
        </p>
      )}

      {error && <div className="danger">{error}</div>}

      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <button onClick={generate} disabled={busy}>
          {busy ? "Working…" : pattern ? "Re-analyse" : "Generate analysis"}
        </button>
        {pattern && (
          <button onClick={clear} disabled={busy} className="secondary">
            Clear analysis
          </button>
        )}
        {pattern && (
          <span className="muted" style={{ fontSize: "0.85em", alignSelf: "center" }}>
            Generated {new Date(pattern.generated_at).toLocaleString()} from{" "}
            {pattern.submission_count} submission{pattern.submission_count === 1 ? "" : "s"}
            {pattern.ai_model ? ` · ${pattern.ai_model}` : ""}
          </span>
        )}
      </div>
    </div>
  );
}

function PatternResultDisplay({ pattern }: { pattern: Pattern }) {
  return (
    <div className="stack">
      <div className="panel elevated">
        <strong>Summary</strong>
        <p style={{ whiteSpace: "pre-wrap", margin: "4px 0 0" }}>{pattern.summary}</p>
      </div>

      {pattern.strengths.length > 0 && (
        <div>
          <h4 style={{ margin: "8px 0 4px" }}>
            <span style={{ color: "#56d364" }}>✓</span> Strengths ({pattern.strengths.length})
          </h4>
          <ul style={{ paddingLeft: 20, margin: 0 }}>
            {pattern.strengths.map((s, i) => (
              <li key={i} style={{ marginBottom: 6 }}>
                <strong>{s.title}</strong> <span className="muted">— {s.evidence}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {pattern.issues.length > 0 && (
        <div>
          <h4 style={{ margin: "8px 0 4px" }}>
            <span style={{ color: "#e3b341" }}>⚠</span> Issues ({pattern.issues.length})
          </h4>
          <ul style={{ paddingLeft: 20, margin: 0 }}>
            {pattern.issues.map((s, i) => (
              <li key={i} style={{ marginBottom: 6 }}>
                <strong>{s.title}</strong> <span className="muted">({s.frequency})</span>
                <div className="muted" style={{ fontSize: "0.9em" }}>{s.evidence}</div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {pattern.coaching.length > 0 && (
        <div>
          <h4 style={{ margin: "8px 0 4px" }}>
            <span style={{ color: "#79c0ff" }}>→</span> Coaching points ({pattern.coaching.length})
          </h4>
          <ul style={{ paddingLeft: 20, margin: 0 }}>
            {pattern.coaching.map((c, i) => (
              <li key={i} style={{ marginBottom: 6 }}>{c}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function RecentSubmissionsPanel({
  data,
  filter,
  clearFilter,
}: {
  data: ProfileResponse;
  filter: string | null;
  clearFilter: () => void;
}) {
  if (data.recent_submissions.length === 0) return null;
  // Late = created_at hour/minute ≥ 17:30 in the viewer's local time. The
  // server uses the same rule against its TZ (Africa/Johannesburg); since
  // submissions render in local time too, this stays visually consistent.
  const rows =
    filter === "late"
      ? data.recent_submissions.filter((s) => {
          const d = new Date(s.created_at);
          const h = d.getHours();
          const m = d.getMinutes();
          return h > 17 || (h === 17 && m >= 30);
        })
      : data.recent_submissions;
  const count = rows.length;
  return (
    <div className="panel stack">
      <h3 style={{ margin: 0 }}>
        Submissions{" "}
        <span className="muted" style={{ fontWeight: 400, fontSize: "0.75em" }}>
          ({count})
        </span>
      </h3>
      {filter === "late" && (
        <div
          className="row"
          style={{
            justifyContent: "space-between",
            alignItems: "center",
            padding: "8px 12px",
            background: "rgba(227, 179, 65, 0.12)",
            border: "1px solid rgba(227, 179, 65, 0.4)",
            borderRadius: "var(--r)",
            fontSize: "0.9em",
          }}
        >
          <span>
            Showing {count} submission{count === 1 ? "" : "s"} after 5:30 PM.
          </span>
          <button
            className="secondary"
            onClick={clearFilter}
            style={{ padding: "4px 10px", fontSize: "0.85em" }}
          >
            Clear filter
          </button>
        </div>
      )}
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.9em" }}>
        <thead>
          <tr style={{ textAlign: "left", color: "var(--c-muted)" }}>
            <th style={{ padding: "8px 8px" }}>When</th>
            <th style={{ padding: "8px 8px" }}>Task</th>
            <th style={{ padding: "8px 8px" }}>Type</th>
            <th style={{ padding: "8px 8px" }}>Headline</th>
            <th style={{ padding: "8px 8px", textAlign: "right" }}>Score</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.id} style={{ borderTop: "1px solid var(--c-border)" }}>
              <td style={{ padding: "8px 8px" }}>
                <Link to={`/admin/submissions/${s.id}`}>
                  {new Date(s.created_at).toLocaleString()}
                </Link>
              </td>
              <td style={{ padding: "8px 8px" }}>#{s.task_id}</td>
              <td style={{ padding: "8px 8px" }}>{s.job_type ? prettyType(s.job_type) : "—"}</td>
              <td style={{ padding: "8px 8px" }}>{s.headline ?? <span className="muted">—</span>}</td>
              <td style={{ padding: "8px 8px", textAlign: "right" }}>
                {s.effective_score !== null ? (
                  <span style={{ color: scoreColor(s.effective_score) }}>
                    {s.effective_score}
                    {s.is_admin_override && (
                      <span className="muted" style={{ fontSize: "0.8em" }}> (admin)</span>
                    )}
                  </span>
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------- helpers ----------

function scoreColor(s: number): string {
  if (s >= 8) return "#56d364";
  if (s >= 5) return "#e3b341";
  return "#ff7b72";
}

function heatColor(count: number, max: number): string {
  if (count === 0) return "#13181f";
  // Cool-to-warm ramp: low counts read as muted teal, high counts as warm
  // amber, with the same lightness curve as before so the visual weight
  // still scales with submission count.
  const t = count / max;
  const hue = 175 - 115 * t; // 175 (teal) → 60 (amber)
  const sat = 45 + 25 * t;
  const light = 28 + 22 * t;
  return `hsl(${hue}deg ${sat}% ${light}%)`;
}

function prettyType(t: string): string {
  return t
    .split("_")
    .map((s) => s[0]?.toUpperCase() + s.slice(1))
    .join(" ");
}

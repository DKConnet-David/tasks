import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
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

type Period = "this_month" | "last_30" | "this_quarter" | "all";

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
  job_count: number;
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

const PERIOD_LABELS: Record<Period, string> = {
  this_month: "This month",
  last_30: "Last 30 days",
  this_quarter: "This quarter",
  all: "All time",
};

const DIM_LABELS = {
  workmanship: "Workmanship",
  photo_quality: "Photo Quality",
  completeness: "Completeness",
  communication: "Communication",
} as const;

const DIM_KEYS = ["workmanship", "photo_quality", "completeness", "communication"] as const;

export function TechProfile() {
  const { login } = useParams<{ login: string }>();
  const [period, setPeriod] = useState<Period>("this_month");
  const [data, setData] = useState<ProfileResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

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

      <Header data={data} />

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

      <PatternsPanel login={login ?? ""} period={period} />

      <RecentSubmissionsPanel data={data} />

      <div className="panel">
        <select
          value={period}
          onChange={(e) => setPeriod(e.target.value as Period)}
          style={{ width: "auto", minWidth: 160 }}
        >
          {(Object.keys(PERIOD_LABELS) as Period[]).map((p) => (
            <option key={p} value={p}>
              {PERIOD_LABELS[p]}
            </option>
          ))}
        </select>
        <span className="muted" style={{ marginLeft: 8, fontSize: "0.9em" }}>
          {data.period_label}
        </span>
      </div>
    </div>
  );
}

// ---------- panels ----------

function Header({ data }: { data: ProfileResponse }) {
  return (
    <div className="panel" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
      <div>
        <h1 style={{ margin: 0 }}>{data.login}</h1>
        <div className="muted" style={{ fontSize: "0.9em" }}>
          {data.job_count} job{data.job_count === 1 ? "" : "s"} · {data.period_label}
        </div>
      </div>
      <div style={{ textAlign: "right" }}>
        {data.overall_score !== null ? (
          <>
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
          </>
        ) : (
          <span className="muted">No rated submissions</span>
        )}
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
      <h3 style={{ margin: 0 }}>Dimensions (avg, scale 1–5)</h3>
      {DIM_KEYS.map((k) => (
        <DimensionBar key={k} label={DIM_LABELS[k]} value={d[k]} />
      ))}
    </div>
  );
}

function DimensionBar({ label, value }: { label: string; value: number }) {
  const pct = Math.max(0, Math.min(100, (value / 5) * 100));
  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", fontSize: "0.9em" }}>
        <strong>{label}</strong>
        <span style={{ color: scoreColor5(value) }}>{value.toFixed(1)} /5</span>
      </div>
      <div
        style={{
          height: 8,
          background: "#1f242b",
          borderRadius: 4,
          overflow: "hidden",
          marginTop: 4,
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${pct}%`,
            background: scoreColor5(value),
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
        background: "#0e1a14",
        border: "1px solid var(--c-border)",
        borderRadius: "var(--r)",
        padding: 8,
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
            <CartesianGrid strokeDasharray="3 3" stroke="#2a2f36" />
            <XAxis dataKey="date" stroke="#8b949e" tick={{ fontSize: 11 }} />
            <YAxis domain={[0, 10]} stroke="#8b949e" tick={{ fontSize: 11 }} />
            <Tooltip
              contentStyle={{ background: "#161b22", border: "1px solid #30363d" }}
              labelStyle={{ color: "#e6edf3" }}
            />
            <Legend wrapperStyle={{ fontSize: "0.85em" }} />
            <Line type="monotone" dataKey="overall" stroke="#a371f7" strokeWidth={2} dot />
            <Line type="monotone" dataKey="workmanship" stroke="#3fb950" dot={false} />
            <Line type="monotone" dataKey="photo_quality" stroke="#2f81f7" dot={false} />
            <Line type="monotone" dataKey="completeness" stroke="#d29922" dot={false} />
            <Line type="monotone" dataKey="communication" stroke="#db61a2" dot={false} />
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
    { name: "Excellent (8–10)", value: d.excellent, fill: "#3fb950" },
    { name: "Good (5–7)", value: d.good, fill: "#d29922" },
    { name: "Needs Improvement (<5)", value: d.needs_improvement, fill: "#f85149" },
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
            <Tooltip contentStyle={{ background: "#161b22", border: "1px solid #30363d" }} />
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
  const stats = `${data.job_count} submissions · ${data.active_days ?? cells.length} active days · ${data.jobs_per_active_day.toFixed(1)} avg/active day`;

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
 * Single-day breakdown: hours 7am-10pm in a horizontal strip. Date picker
 * to select the day; defaults to the most recent day with submissions.
 * Hours are local time (Africa/Johannesburg per the api container's TZ
 * env var; if a tech submits late evening that's where it lands).
 */
const DAY_VIEW_START_HOUR = 7;
const DAY_VIEW_END_HOUR = 22;
const DAY_VIEW_HOURS = Array.from(
  { length: DAY_VIEW_END_HOUR - DAY_VIEW_START_HOUR + 1 },
  (_, i) => DAY_VIEW_START_HOUR + i,
);

function DayHeatmap({
  timestamps,
  countByDate,
}: {
  timestamps: number[];
  countByDate: Map<string, number>;
}) {
  // Default to the most recent active day (latest date with at least one
  // submission), or today if there are none.
  const activeDates = useMemo(() => Array.from(countByDate.keys()).sort(), [countByDate]);
  const defaultDate =
    activeDates.length > 0
      ? activeDates[activeDates.length - 1]!
      : ymd(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());

  const [selectedDate, setSelectedDate] = useState<string>(defaultDate);

  // Bucket the timestamps into per-hour counts for the chosen day.
  const { hourCounts, dayTotal, outOfHoursTotal } = useMemo(() => {
    const counts = new Map<number, number>();
    let inWindow = 0;
    let outside = 0;
    for (const ts of timestamps) {
      const d = new Date(ts);
      const dateStr = ymd(d.getFullYear(), d.getMonth(), d.getDate());
      if (dateStr !== selectedDate) continue;
      const h = d.getHours();
      counts.set(h, (counts.get(h) ?? 0) + 1);
      if (h >= DAY_VIEW_START_HOUR && h <= DAY_VIEW_END_HOUR) inWindow += 1;
      else outside += 1;
    }
    return {
      hourCounts: counts,
      dayTotal: inWindow + outside,
      outOfHoursTotal: outside,
    };
  }, [timestamps, selectedDate]);

  const maxHourCount = Math.max(
    1,
    ...DAY_VIEW_HOURS.map((h) => hourCounts.get(h) ?? 0),
  );

  // Step buttons cycle through dates that have any submissions; falls back
  // to ±1 day when the picker is on an empty day.
  function step(delta: number) {
    if (activeDates.length === 0) {
      const d = new Date(selectedDate + "T00:00:00");
      d.setDate(d.getDate() + delta);
      setSelectedDate(ymd(d.getFullYear(), d.getMonth(), d.getDate()));
      return;
    }
    const idx = activeDates.indexOf(selectedDate);
    if (idx === -1) {
      // Not on an active day — snap to nearest in the requested direction.
      const sorted = [...activeDates];
      const next = delta > 0
        ? sorted.find((d) => d > selectedDate)
        : [...sorted].reverse().find((d) => d < selectedDate);
      if (next) setSelectedDate(next);
      return;
    }
    const target = activeDates[Math.max(0, Math.min(activeDates.length - 1, idx + delta))];
    if (target) setSelectedDate(target);
  }

  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <button
          className="secondary"
          onClick={() => step(-1)}
          style={{ padding: "4px 10px" }}
          title="Previous active day"
        >
          ←
        </button>
        <input
          type="date"
          value={selectedDate}
          onChange={(e) => setSelectedDate(e.target.value)}
          style={{ width: "auto", padding: "4px 8px" }}
        />
        <button
          className="secondary"
          onClick={() => step(1)}
          style={{ padding: "4px 10px" }}
          title="Next active day"
        >
          →
        </button>
        <span className="muted" style={{ fontSize: "0.85em" }}>
          {dayTotal} submission{dayTotal === 1 ? "" : "s"} this day
          {outOfHoursTotal > 0 && (
            <> · {outOfHoursTotal} outside 7am–10pm window</>
          )}
        </span>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${DAY_VIEW_HOURS.length}, minmax(0, 1fr))`,
          gap: 4,
        }}
      >
        {DAY_VIEW_HOURS.map((h) => (
          <div
            key={`label-${h}`}
            className="muted"
            style={{ fontSize: "0.7em", textAlign: "center" }}
          >
            {formatHourLabel(h)}
          </div>
        ))}
        {DAY_VIEW_HOURS.map((h) => {
          const count = hourCounts.get(h) ?? 0;
          return (
            <div
              key={`cell-${h}`}
              title={`${selectedDate} ${formatHourLabel(h)}: ${count} submission${count === 1 ? "" : "s"}`}
              style={{
                height: 56,
                borderRadius: 4,
                background: count > 0 ? heatColor(count, maxHourCount) : "#161b22",
                border: "1px solid #1f242b",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "0.95em",
                fontWeight: 600,
                color: count > maxHourCount * 0.5 ? "#0e1116" : "#e6edf3",
              }}
            >
              {count > 0 ? count : ""}
            </div>
          );
        })}
      </div>
    </div>
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
        background: cell.count > 0 ? heatColor(cell.count, maxCount) : "#161b22",
        border: isToday ? "1px solid #2f81f7" : "1px solid #1f242b",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        fontSize: "0.7em",
        color: cell.count > maxCount * 0.5 ? "#0e1116" : "#e6edf3",
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

  // Patterns are scoped to a calendar month. The other periods don't have
  // sensible month boundaries, so we hide the panel for them.
  const monthBoundary = useMemo(() => {
    if (period !== "this_month") return null;
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
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

  if (period !== "this_month") {
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
          Switch the period selector at the bottom to <strong>This month</strong> to use the
          AI pattern analysis (it operates on calendar-month boundaries).
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

      <div className="row" style={{ gap: 8 }}>
        <button onClick={generate} disabled={busy}>
          {busy ? "Analysing…" : pattern ? "Re-analyse" : "Generate analysis"}
        </button>
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
      <div className="panel" style={{ background: "#0e1a14" }}>
        <strong>Summary</strong>
        <p style={{ whiteSpace: "pre-wrap", margin: "4px 0 0" }}>{pattern.summary}</p>
      </div>

      {pattern.strengths.length > 0 && (
        <div>
          <h4 style={{ margin: "8px 0 4px" }}>
            <span style={{ color: "#3fb950" }}>✓</span> Strengths ({pattern.strengths.length})
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
            <span style={{ color: "#d29922" }}>⚠</span> Issues ({pattern.issues.length})
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
            <span style={{ color: "#2f81f7" }}>→</span> Coaching points ({pattern.coaching.length})
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

function RecentSubmissionsPanel({ data }: { data: ProfileResponse }) {
  if (data.recent_submissions.length === 0) return null;
  return (
    <div className="panel stack">
      <h3 style={{ margin: 0 }}>Recent submissions</h3>
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
          {data.recent_submissions.map((s) => (
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
  if (s >= 8) return "#3fb950";
  if (s >= 5) return "#d29922";
  return "#f85149";
}

function scoreColor5(s: number): string {
  if (s >= 4) return "#3fb950";
  if (s >= 2.5) return "#d29922";
  return "#f85149";
}

function heatColor(count: number, max: number): string {
  if (count === 0) return "#161b22";
  const t = count / max;
  // Interpolate dark green → bright green
  const lo = 18;
  const hi = 63;
  const pct = lo + (hi - lo) * t;
  return `hsl(135deg ${50 + 20 * t}% ${pct}%)`;
}

function prettyType(t: string): string {
  return t
    .split("_")
    .map((s) => s[0]?.toUpperCase() + s.slice(1))
    .join(" ");
}

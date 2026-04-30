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

function ActivityHeatmapPanel({ data, period }: { data: ProfileResponse; period: Period }) {
  // Render a calendar-style grid of days. Different period → different shape.
  // For simplicity render as a flat date list with cells coloured by count.
  const cells = data.activity_heatmap;

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
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h3 style={{ margin: 0 }}>Activity heatmap</h3>
        <span className="muted" style={{ fontSize: "0.85em" }}>{stats}</span>
      </div>
      <div
        style={{
          display: "flex",
          gap: 4,
          flexWrap: "wrap",
        }}
      >
        {cells.map((c) => (
          <div
            key={c.date}
            title={`${c.date}: ${c.count} submission${c.count === 1 ? "" : "s"} (${weekdayName(c.weekday)})`}
            style={{
              width: 28,
              height: 28,
              borderRadius: 4,
              background: heatColor(c.count, maxCount),
              border: "1px solid #1f242b",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "0.7em",
              color: c.count > maxCount * 0.5 ? "#0e1116" : "#e6edf3",
              fontWeight: 500,
            }}
          >
            {c.count}
          </div>
        ))}
      </div>
      {period !== "all" && (
        <div className="muted" style={{ fontSize: "0.8em" }}>
          Each cell is one day with at least one submission. Hover for the date.
        </div>
      )}
    </div>
  );
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

function weekdayName(d: number): string {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d] ?? "";
}

function prettyType(t: string): string {
  return t
    .split("_")
    .map((s) => s[0]?.toUpperCase() + s.slice(1))
    .join(" ");
}

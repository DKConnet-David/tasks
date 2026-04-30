import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, api } from "../../api";

type Period = "this_month" | "last_30" | "this_quarter" | "all";

interface Dimensions {
  workmanship: number;
  photo_quality: number;
  completeness: number;
  communication: number;
}

interface Tech {
  app_login: string;
  job_count: number;
  overall_score: number | null;
  dimensions: Dimensions | null;
  last_submission_at: number | null;
}

interface OverviewResponse {
  period: Period;
  since: number;
  techs: Tech[];
}

const PERIOD_LABELS: Record<Period, string> = {
  this_month: "This month",
  last_30: "Last 30 days",
  this_quarter: "This quarter",
  all: "All time",
};

type SortKey = "login" | "jobs" | "score" | "last";

export function Performance() {
  const [period, setPeriod] = useState<Period>("this_month");
  const [data, setData] = useState<OverviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "score", desc: true });

  useEffect(() => {
    setData(null);
    setError(null);
    api
      .get<OverviewResponse>(`/admin/performance/techs?period=${period}`)
      .then(setData)
      .catch((e: unknown) => {
        if (e instanceof ApiError) setError(`Failed to load (${e.status})`);
        else setError("Network error");
      });
  }, [period]);

  const sorted = data ? sortTechs(data.techs, sort) : [];

  return (
    <div className="stack">
      <div className="panel stack">
        <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <div>
            <h2 style={{ margin: 0 }}>Team performance</h2>
            <p className="muted" style={{ margin: "4px 0 0", fontSize: "0.9em" }}>
              Per-tech rollup of submissions and AI/admin ratings. Click a row for the full
              profile.
            </p>
          </div>
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
        </div>
      </div>

      {error && <div className="panel danger">{error}</div>}

      {!data ? (
        <div className="panel muted">Loading…</div>
      ) : sorted.length === 0 ? (
        <div className="panel muted">No techs have submitted in this period.</div>
      ) : (
        <div className="panel">
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.92em" }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--c-muted)" }}>
                  <Th label="Tech" sortKey="login" sort={sort} setSort={setSort} />
                  <Th label="Jobs" sortKey="jobs" sort={sort} setSort={setSort} align="right" />
                  <Th label="Overall" sortKey="score" sort={sort} setSort={setSort} align="right" />
                  <th style={th()}>Workmanship</th>
                  <th style={th()}>Photo qty</th>
                  <th style={th()}>Completeness</th>
                  <th style={th()}>Communication</th>
                  <Th label="Last activity" sortKey="last" sort={sort} setSort={setSort} />
                </tr>
              </thead>
              <tbody>
                {sorted.map((t) => (
                  <tr key={t.app_login} style={{ borderTop: "1px solid var(--c-border)" }}>
                    <td style={td()}>
                      <Link to={`/admin/performance/${encodeURIComponent(t.app_login)}`}>
                        <strong>{t.app_login}</strong>
                      </Link>
                    </td>
                    <td style={{ ...td(), textAlign: "right" }}>{t.job_count}</td>
                    <td style={{ ...td(), textAlign: "right" }}>
                      {t.overall_score !== null ? (
                        <strong style={{ color: scoreColor(t.overall_score) }}>
                          {t.overall_score.toFixed(1)}
                        </strong>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <DimCell value={t.dimensions?.workmanship} />
                    <DimCell value={t.dimensions?.photo_quality} />
                    <DimCell value={t.dimensions?.completeness} />
                    <DimCell value={t.dimensions?.communication} />
                    <td style={td()}>
                      {t.last_submission_at
                        ? new Date(t.last_submission_at).toLocaleString()
                        : <span className="muted">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function Th({
  label,
  sortKey,
  sort,
  setSort,
  align,
}: {
  label: string;
  sortKey: SortKey;
  sort: { key: SortKey; desc: boolean };
  setSort: (s: { key: SortKey; desc: boolean }) => void;
  align?: "right";
}) {
  const active = sort.key === sortKey;
  const arrow = active ? (sort.desc ? " ↓" : " ↑") : "";
  return (
    <th
      style={{
        ...th(),
        textAlign: align ?? "left",
        cursor: "pointer",
        userSelect: "none",
      }}
      onClick={() =>
        setSort({ key: sortKey, desc: active ? !sort.desc : true })
      }
    >
      {label}
      {arrow}
    </th>
  );
}

function DimCell({ value }: { value: number | undefined }) {
  if (value === undefined || value === null) {
    return (
      <td style={td()}>
        <span className="muted">—</span>
      </td>
    );
  }
  return (
    <td style={td()}>
      <span style={{ color: scoreColor5(value) }}>{value.toFixed(1)}</span>
      <span className="muted" style={{ fontSize: "0.85em" }}> /5</span>
    </td>
  );
}

function sortTechs(techs: Tech[], sort: { key: SortKey; desc: boolean }): Tech[] {
  const copy = [...techs];
  copy.sort((a, b) => {
    let cmp = 0;
    if (sort.key === "login") cmp = a.app_login.localeCompare(b.app_login);
    else if (sort.key === "jobs") cmp = a.job_count - b.job_count;
    else if (sort.key === "score") cmp = (a.overall_score ?? -1) - (b.overall_score ?? -1);
    else if (sort.key === "last")
      cmp = (a.last_submission_at ?? 0) - (b.last_submission_at ?? 0);
    return sort.desc ? -cmp : cmp;
  });
  return copy;
}

function scoreColor(s: number): string {
  if (s >= 8) return "var(--c-success)";
  if (s >= 5) return "var(--c-warn)";
  return "var(--c-danger)";
}

function scoreColor5(s: number): string {
  if (s >= 4) return "var(--c-success)";
  if (s >= 2.5) return "var(--c-warn)";
  return "var(--c-danger)";
}

function th(): React.CSSProperties {
  return { padding: "8px 8px", fontWeight: 500, fontSize: "0.85em", textTransform: "uppercase" };
}
function td(): React.CSSProperties {
  return { padding: "10px 8px", verticalAlign: "top" };
}

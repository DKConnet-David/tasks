import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, api } from "../../api";

interface Item {
  id: number;
  task_id: number;
  app_login: string;
  source: string;
  headline: string | null;
  splynx_comment_id: number | null;
  wa_message_id: string | null;
  status: "pending" | "success" | "partial" | "failed";
  admin_resolved: boolean;
  hidden: boolean;
  created_at: number;
  ai_score: number | null;
  admin_score: number | null;
}

interface Page {
  items: Item[];
  next_cursor: number | null;
}

export function SubmissionsList() {
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<{
    status: string;
    login: string;
    q: string;
    includeHidden: boolean;
  }>({
    status: "",
    login: "",
    q: "",
    includeHidden: false,
  });

  function buildUrl(cursor?: number | null): string {
    const params = new URLSearchParams();
    if (filters.status) params.set("status", filters.status);
    if (filters.login.trim()) params.set("login", filters.login.trim());
    if (filters.q.trim()) params.set("q", filters.q.trim());
    if (filters.includeHidden) params.set("include_hidden", "1");
    if (cursor) params.set("cursor", String(cursor));
    params.set("limit", "30");
    return `/admin/submissions?${params.toString()}`;
  }

  async function load() {
    try {
      const res = await api.get<Page>(buildUrl());
      setPage(res);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? `Load failed (${e.status})` : "Network error");
    }
  }

  async function loadMore() {
    if (!page?.next_cursor) return;
    try {
      const res = await api.get<Page>(buildUrl(page.next_cursor));
      setPage({
        items: [...page.items, ...res.items],
        next_cursor: res.next_cursor,
      });
    } catch (e) {
      setError(e instanceof ApiError ? `Load failed (${e.status})` : "Network error");
    }
  }

  useEffect(() => {
    load();
    // includeHidden auto-reloads (UI expectation: tick the box, see hidden
    // rows immediately). The other filters wait for the Search button so
    // typing doesn't fire a request per keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.includeHidden]);

  return (
    <div className="stack">
      <div className="panel stack" style={{ gap: "0.5rem" }}>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <select
            value={filters.status}
            onChange={(e) => setFilters({ ...filters, status: e.target.value })}
            style={{ width: "auto", minWidth: 140 }}
          >
            <option value="">All statuses</option>
            <option value="success">success</option>
            <option value="partial">partial</option>
            <option value="failed">failed</option>
            <option value="pending">pending</option>
          </select>
          <input
            placeholder="Tech login"
            value={filters.login}
            onChange={(e) => setFilters({ ...filters, login: e.target.value })}
            style={{ width: "auto", minWidth: 140 }}
          />
          <input
            placeholder="Search note / summary / task #"
            value={filters.q}
            onChange={(e) => setFilters({ ...filters, q: e.target.value })}
            style={{ flex: 1, minWidth: 200 }}
            onKeyDown={(e) => {
              if (e.key === "Enter") load();
            }}
          />
          <button onClick={load}>Search</button>
        </div>
        <label className="row" style={{ gap: 6, fontSize: "0.9em", alignItems: "center" }}>
          <input
            type="checkbox"
            checked={filters.includeHidden}
            onChange={(e) =>
              setFilters({ ...filters, includeHidden: e.target.checked })
            }
            style={{ width: "auto" }}
          />
          <span className="muted">
            Show hidden submissions (admins flag duplicates / typo task IDs as hidden so they
            don't pollute the Performance dashboards).
          </span>
        </label>
      </div>

      {error && <div className="panel danger">{error}</div>}

      {!page ? (
        <div className="panel muted">Loading…</div>
      ) : page.items.length === 0 ? (
        <div className="panel muted">No submissions match these filters.</div>
      ) : (
        <div className="panel">
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.92em" }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--c-muted)" }}>
                  <th style={th()}>When</th>
                  <th style={th()}>Task</th>
                  <th style={th()}>Tech</th>
                  <th style={th()}>Headline</th>
                  <th style={th()}>Status</th>
                  <th style={th()}>Splynx</th>
                  <th style={th()}>WA</th>
                  <th style={th()}>Rating</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((it) => (
                  <tr
                    key={it.id}
                    style={{
                      borderTop: "1px solid var(--c-border)",
                      opacity: it.hidden ? 0.5 : 1,
                    }}
                  >
                    <td style={td()}>
                      <Link to={`/admin/submissions/${it.id}`}>
                        {new Date(it.created_at).toLocaleString()}
                      </Link>
                    </td>
                    <td style={td()}>#{it.task_id}</td>
                    <td style={td()}>
                      {it.app_login}
                      {it.source === "manual" && (
                        <span className="badge" style={{ marginLeft: 4, fontSize: "0.7em" }}>
                          manual
                        </span>
                      )}
                    </td>
                    <td style={td()}>
                      {it.hidden && (
                        <span
                          className="badge warn"
                          style={{ marginRight: 6, fontSize: "0.7em" }}
                        >
                          hidden
                        </span>
                      )}
                      {it.headline ?? <span className="muted">—</span>}
                    </td>
                    <td style={td()}>
                      <span className={statusBadge(it.status)}>{it.status}</span>
                    </td>
                    <td style={td()}>{it.splynx_comment_id ? "✓" : "—"}</td>
                    <td style={td()}>{it.wa_message_id ? "✓" : "—"}</td>
                    <td style={td()}>{ratingDisplay(it.ai_score, it.admin_score)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {page.next_cursor !== null && (
            <div style={{ paddingTop: 12, textAlign: "center" }}>
              <button className="secondary" onClick={loadMore}>
                Load more
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function th(): React.CSSProperties {
  return { padding: "8px 8px", fontWeight: 500, fontSize: "0.85em", textTransform: "uppercase" };
}
function td(): React.CSSProperties {
  return { padding: "10px 8px", verticalAlign: "top" };
}

function statusBadge(s: Item["status"]): string {
  if (s === "success") return "badge success";
  if (s === "failed") return "badge danger";
  return "badge warn";
}

function ratingDisplay(ai: number | null, admin: number | null): React.ReactNode {
  if (admin !== null) {
    return (
      <strong>
        {admin}/10 <span className="muted" style={{ fontWeight: 400, fontSize: "0.8em" }}>(admin)</span>
      </strong>
    );
  }
  if (ai !== null) {
    return (
      <span className="muted">
        {ai}/10 <span className="badge" style={{ fontSize: "0.7em" }}>AI</span>
      </span>
    );
  }
  return <span className="muted">—</span>;
}

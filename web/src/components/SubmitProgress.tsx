import { useEffect, useState } from "react";

export type SubmitPhase =
  | "idle"
  | "uploading"
  | "processing"
  | "done"
  | "error";

interface Props {
  phase: SubmitPhase;
  /** 0..1 during uploading, ignored otherwise. */
  uploadFraction: number | null;
  uploadLoadedBytes: number;
  uploadTotalBytes: number;
  errorMessage?: string | null;
}

/**
 * Two-stage progress UI:
 *   1. Upload — real bytes-on-the-wire progress from the XHR.
 *   2. Processing — server-side pipeline stages (AI summary + rating, PDF,
 *      Splynx writeback, WhatsApp). We don't have real-time hooks into the
 *      server yet, so the stages auto-advance on a timer that roughly
 *      matches the typical pipeline duration. The final state arrives when
 *      the API response lands and the parent flips phase to "done".
 */
export function SubmitProgress({
  phase,
  uploadFraction,
  uploadLoadedBytes,
  uploadTotalBytes,
  errorMessage,
}: Props) {
  // Auto-advancing pipeline stage while we wait for the server response.
  const [stageIndex, setStageIndex] = useState(0);
  useEffect(() => {
    if (phase !== "processing") {
      setStageIndex(0);
      return;
    }
    const t = setInterval(() => {
      setStageIndex((i) => Math.min(i + 1, PIPELINE_STAGES.length - 1));
    }, 5000); // ~5s per stage estimate
    return () => clearInterval(t);
  }, [phase]);

  if (phase === "idle") return null;

  if (phase === "error") {
    return (
      <div className="panel danger" style={{ marginTop: 8 }}>
        {errorMessage || "Submission failed."}
      </div>
    );
  }

  return (
    <div className="panel stack" style={{ marginTop: 8 }}>
      <div>
        <strong>{phase === "uploading" ? "Uploading photos…" : "Photos uploaded ✓"}</strong>
        <div style={progressBarOuter}>
          <div
            style={{
              ...progressBarInner,
              width: `${Math.round((uploadFraction ?? (phase === "uploading" ? 0 : 1)) * 100)}%`,
            }}
          />
        </div>
        <div style={subline}>
          {formatBytes(uploadLoadedBytes)} / {formatBytes(uploadTotalBytes)}
          {uploadFraction !== null && ` — ${Math.round(uploadFraction * 100)}%`}
        </div>
      </div>

      {(phase === "processing" || phase === "done") && (
        <div>
          <strong>Server pipeline</strong>
          <ul style={{ listStyle: "none", padding: 0, margin: "4px 0 0" }}>
            {PIPELINE_STAGES.map((stage, i) => {
              const status =
                phase === "done"
                  ? "done"
                  : i < stageIndex
                    ? "done"
                    : i === stageIndex
                      ? "active"
                      : "pending";
              return (
                <li key={stage} style={stageRow}>
                  <span style={{ width: 16 }}>{statusIcon(status)}</span>
                  <span style={status === "pending" ? mutedText : undefined}>{stage}</span>
                </li>
              );
            })}
          </ul>
          {phase === "processing" && (
            <div style={subline}>
              Stages auto-advance on a timer; the actual completion lands when the server returns.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const PIPELINE_STAGES = [
  "AI summary + quality rating (parallel Claude calls)",
  "Generating PDF report",
  "Posting to Splynx (comment + PDF + photo attachments)",
  "Sending to WhatsApp group",
];

function statusIcon(status: "done" | "active" | "pending"): string {
  if (status === "done") return "✓";
  if (status === "active") return "•";
  return "·";
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const progressBarOuter: React.CSSProperties = {
  height: 8,
  background: "#1f242b",
  borderRadius: 4,
  overflow: "hidden",
  marginTop: 6,
};

const progressBarInner: React.CSSProperties = {
  height: "100%",
  background: "var(--c-accent)",
  transition: "width 120ms linear",
};

const subline: React.CSSProperties = {
  marginTop: 4,
  color: "var(--c-muted)",
  fontSize: "0.85em",
};

const stageRow: React.CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "baseline",
  padding: "2px 0",
};

const mutedText: React.CSSProperties = {
  color: "var(--c-muted)",
};

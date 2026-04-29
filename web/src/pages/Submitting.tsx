// Submitting/confirmation screen: shown while the backend pipeline runs
// (summarize -> PDF -> Splynx writeback -> WhatsApp send). Final state shows
// the AI summary headline only — never any rating data.

export function Submitting() {
  return (
    <div className="container">
      <em className="muted">Submitting — implementation pending (Phase 7).</em>
    </div>
  );
}

export default function InsightsBlock({ insights, suggestions, onAsk }) {
  const has = (insights && insights.length) || (suggestions && suggestions.length);
  if (!has) return null;
  return (
    <div className="insights-block">
      {insights?.length > 0 && (
        <div className="insights-list">
          <div className="insights-title">Insights</div>
          {insights.map((i, k) => (
            <div key={k} className={`insight insight-${i.severity}`}>
              <span className="insight-dot" />{i.text}
            </div>
          ))}
        </div>
      )}
      {suggestions?.length > 0 && (
        <div className="suggestions">
          <div className="insights-title">Suggested next questions</div>
          <div className="suggestion-chips">
            {suggestions.map((s) => (
              <button key={s} className="suggestion-chip" onClick={() => onAsk?.(s)}>→ {s}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

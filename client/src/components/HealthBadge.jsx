import { useEffect, useState } from 'react';
import { api } from '../services/api';

export default function HealthBadge() {
  const [health, setHealth] = useState(null);

  useEffect(() => {
    let mounted = true;
    async function check() {
      try {
        const data = await api.health();
        if (mounted) setHealth(data);
      } catch (_) {
        if (mounted) setHealth({ llm: { healthy: false }, error: true });
      }
    }
    check();
    const interval = setInterval(check, 15000);
    return () => { mounted = false; clearInterval(interval); };
  }, []);

  if (!health) return null;

  const healthy = health.llm?.healthy;
  return (
    <div className={`health-badge ${healthy ? 'health-ok' : 'health-down'}`} title={healthy ? `Model: ${health.llmProvider}` : 'Ollama unreachable — run "ollama serve"'}>
      <span className="health-dot" />
      {healthy ? `Ollama connected` : `Ollama unreachable`}
    </div>
  );
}

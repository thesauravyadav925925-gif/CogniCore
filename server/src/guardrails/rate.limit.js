/**
 * Sliding-window per-user rate limiter (Feature 35). In-memory by design: it protects
 * the LLM/DB from abuse on a single node; use a shared store if you scale out.
 */
const buckets = new Map();

function rateLimit({ windowMs = 60_000, max = parseInt(process.env.CHAT_RATE_LIMIT_PER_MIN || '30', 10), keyFn = (req) => req.user?.user_id || req.ip } = {}) {
  return (req, res, next) => {
    const key = keyFn(req);
    const now = Date.now();
    const hits = (buckets.get(key) || []).filter((t) => now - t < windowMs);
    if (hits.length >= max) {
      const retry = Math.ceil((windowMs - (now - hits[0])) / 1000);
      res.setHeader('Retry-After', String(retry));
      return res.status(429).json({ error: true, message: `Too many requests. Please wait ${retry}s before asking again.` });
    }
    hits.push(now);
    buckets.set(key, hits);
    if (buckets.size > 5000) for (const [k, v] of buckets) if (!v.length || now - v[v.length - 1] > windowMs) buckets.delete(k);
    next();
  };
}

function _reset() { buckets.clear(); }

module.exports = { rateLimit, _reset };

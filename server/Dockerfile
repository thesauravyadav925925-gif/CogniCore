# node:20-slim (Debian/glibc) rather than alpine: better-sqlite3's prebuilt
# binaries reliably target glibc; alpine (musl) often forces a slow from-source
# compile requiring extra build tools. Slim keeps the image small without that.
FROM node:20-slim

WORKDIR /app

# Python 3 (standard library only) powers the optional data-science tool; if it is absent the
# same operations fall back to the built-in JavaScript implementations.
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*

# Install dependencies first (better layer caching - only re-runs npm install
# when package*.json actually changes, not on every source edit).
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

# Runtime state directories - overridden by volumes in docker-compose.yml
# so data survives container restarts/rebuilds.
RUN mkdir -p /app/data /app/uploads

ENV NODE_ENV=production
ENV PORT=4000
ENV DATA_DIR=/app/data
ENV UPLOADS_DIR=/app/uploads

EXPOSE 4000

# Basic container healthcheck - lets `docker compose ps` and orchestrators
# know when the API is actually ready, not just "process started".
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]

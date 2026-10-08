# Deploying CogniCore

## Quick start with Docker Compose

```bash
# From the project root
docker compose up --build
```

This builds and starts two services:
- **server** — the API, published at `http://localhost:4000`
- **client** — the frontend (built, served by nginx), published at `http://localhost:5173`

By default, the server expects **Ollama running natively on your host machine**
(`http://host.docker.internal:11434`), not inside Docker. This is deliberate —
Ollama is much faster with GPU access, which is simplest when it's running
directly on your machine rather than in a container. Make sure `ollama serve`
is running before you start the compose stack.

### If you'd rather run Ollama in Docker too
```bash
docker compose --profile with-ollama up --build
```
Then set `OLLAMA_BASE_URL=http://ollama:11434` (e.g. in a `.env` file at the
project root, which Compose reads automatically) so the server talks to the
bundled Ollama container instead of the host. Note this runs CPU-only unless
you add GPU device reservations for your platform in `docker-compose.yml`.

## Required environment variables

Set these in a `.env` file at the project root (Docker Compose reads it
automatically) or export them before running `docker compose up`:

| Variable | Required | Notes |
|---|---|---|
| `JWT_SECRET` | **Yes, before any real use** | Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. The server refuses to let you forget — it prints a startup warning if left at the default. |
| `OLLAMA_BASE_URL` | No | Defaults to `http://host.docker.internal:11434` |
| `OLLAMA_MODEL` | No | Defaults to `qwen2.5:7b` |
| `OLLAMA_EMBEDDING_MODEL` | No | Defaults to `nomic-embed-text`, only needed for PDF/DOCX/TXT |
| `VITE_API_BASE_URL` | No | Where the frontend looks for the API. Defaults to `http://localhost:4000` (works for a single-host deployment). |

## Data persistence

All state (the user/dataset/permission/audit database, uploaded files, and
per-dataset materialized SQLite files) lives under two named Docker volumes:
`cognicore_data` and `cognicore_uploads`. As long as those volumes aren't
deleted, your data survives `docker compose down` and rebuilds.

**Backing up the whole application state is just backing up these two
volumes** — there's no separate database server to worry about.

```bash
docker run --rm -v cognicore_data:/data -v $(pwd):/backup alpine tar czf /backup/cognicore_data_backup.tar.gz -C /data .
```

## Running without Docker

See the main `README.md` — `npm install` + `npm run dev` in both `server/`
and `client/` works identically, and is what this whole project was actually
developed and tested against in this environment.

## Honest scope notes for this phase

**The Docker setup has NOT been build-tested** — this development environment
has no Docker daemon available. The Dockerfiles and `docker-compose.yml`
follow standard, well-established patterns (multi-stage builds, layer-cached
`npm install`, glibc-based base images chosen specifically because
`better-sqlite3` needs them for its prebuilt binaries), and I checked the
compose file's YAML syntax carefully, but **please run `docker compose up
--build` yourself and tell me the exact error if something doesn't work** -
this is the one place in the whole project where "I tested this" isn't true,
and I want to be upfront about that rather than imply otherwise.

**What a real production deployment would add on top of this**, which Phase 7
deliberately did NOT build (out of scope for a project at this stage):
- HTTPS termination (put this behind Caddy, nginx, or a cloud load balancer
  with a real certificate — CogniCore itself only speaks plain HTTP)
- Structured JSON logging shipped to a log aggregator, rather than the
  timestamped console output `config/logger.js` currently produces
- An APM/metrics stack (Prometheus + Grafana, or a hosted equivalent) for
  latency/error-rate dashboards and alerting
- Rate limiting on `/api/auth/login` (currently unlimited attempts — fine
  for a demo, not fine for anything internet-facing)
- Horizontal scaling: the current design uses a single SQLite file as the
  registry database, which is genuinely fine for single-instance deployments
  but doesn't support running multiple server replicas behind a load
  balancer without switching that registry to a real client-server database
- Password reset / email verification flows


## v0.2 additions to configure before going live
* Set a strong `JWT_SECRET`; keep `API_CONNECTOR_ALLOW_PRIVATE=false`.
* Optional real email for approved actions: `npm i nodemailer` in `server/` and fill `SMTP_*` in `.env` (otherwise emails are written to the outbox table).
* Optional: `ACTION_EMAIL_ALLOWED_DOMAINS`, `ACTION_WEBHOOK_ALLOWLIST`, `PII_MASK_ROLES`, `CHAT_RATE_LIMIT_PER_MIN` (see `.env.example`).
* The Docker image installs `python3` for the data-science tool; without it the same operations run in JavaScript.
* First admin: the first registered user becomes admin; promote others from the Admin tab.

## v0.3 additions
* Production start now **fails** if `JWT_SECRET` is missing, a default, or under 32 characters.
* Optional OCR: install `tesseract-ocr` and `poppler-utils` (the Docker image can add them with `apt-get install -y tesseract-ocr poppler-utils`).
* Sign-out is now server-side (sessions table); users can revoke devices in Settings.

# Task Upater

Field-tech PWA for ISP/telecom operators using Splynx. A tech opens the app on
their phone, enters a Splynx Task ID, captures photos and a short note, and
submits — the backend then runs an AI summary, generates a PDF, posts to a
WhatsApp group, and writes the summary + PDF + photos back to the Splynx task.
Admins get a separate web UI to list, search, edit, retry, and quality-rate
every submission.

The full design lives in `~/.claude/plans/i-d-like-to-build-modular-abelson.md`.

## Stack

- **Server** — Node 20 + TypeScript, Fastify, better-sqlite3, axios, pdfkit,
  sharp, `@whiskeysockets/baileys`, `@anthropic-ai/sdk`.
- **Web** — Vite + React + TypeScript, react-router, vite-plugin-pwa.
- **Database** — SQLite (single file, lives in the data volume).
- **Deploy** — Docker compose on a Coolify host.

## Layout

```
server/   Node backend (auth proxy, Splynx client, Claude calls, PDF, Baileys, pipeline)
web/      Vite + React PWA (tech flow + admin UI)
docker-compose.yml    Coolify entrypoint
.env.example          Required environment variables
```

## Getting started

### 1. Configure environment

```bash
cp .env.example .env
# fill in: SPLYNX_BASE_URL, ADMIN_LOGIN, ANTHROPIC_API_KEY, SESSION_SECRET
# (WHATSAPP_GROUP_JID can be left blank until after QR onboarding)
```

### 2. Probe Splynx (one-time)

This confirms the live API endpoint paths and response shapes before relying
on them in production code. The script is read-only by default.

```bash
cd server
npm install
SPLYNX_BASE_URL=$SPLYNX_BASE_URL \
SPLYNX_PROBE_LOGIN=david \
SPLYNX_PROBE_PASSWORD=... \
SPLYNX_PROBE_TASK_ID=123 \
npm run probe:splynx
# results land in server/splynx-probe.json
```

### 3. Local dev

```bash
# Two terminals:
cd server && npm install && npm run dev
cd web    && npm install && npm run dev
# PWA at http://localhost:5173, API at http://localhost:3000
```

### 4. Production deploy via Coolify

Point Coolify at this repo and select "Docker compose" as the build pack. Set
the env vars from `.env.example` in Coolify's project settings. Coolify
provisions SSL and routes `taskupdater.<your-domain>` → `web` and the API
endpoints (`/auth`, `/tasks`, `/admin`) → `api`.

## WhatsApp onboarding

After the API container is running:

1. Sign in as the `ADMIN_LOGIN` user.
2. Open `/admin/whatsapp` — a QR code is rendered.
3. On the phone with the dedicated WhatsApp number, open WhatsApp → Settings →
   Linked devices → "Link a device" and scan.
4. The `/admin/whatsapp` panel switches to "connected" and lists available
   groups. Copy the target group's JID into `WHATSAPP_GROUP_JID` in `.env` and
   redeploy.

The session is persisted in the data volume (`/data/baileys-auth`) so it
survives restarts; you only need to re-scan if WhatsApp invalidates the link.

## Quality rating containment

The AI rating feature is **admin-only** and **never** appears in any external
artifact (PDF, WhatsApp message, Splynx comment, or the tech-side response).
This is enforced at four layers — see the dedicated section in
`server/src/types.ts` and the integration leak-test in
`server/src/__tests__/leak.test.ts`.

## License

Private — internal tool.

# Coolify deployment guide

This walks through getting the current scaffold deployed on your existing
Coolify host. The PWA + API both come up but at this stage `/auth/login`
returns 501 — that's expected until we land Phase 5 (tech auth model). The
deploy is for verifying networking, SSL, env wiring, and the data volume
before we keep building.

## 1. Create a new resource in Coolify

1. Coolify → your project → **+ New** → **Public Repository**.
2. Repository: `https://github.com/DKConnet-David/tasks`
3. Branch: `main`
4. Build pack: **Docker Compose**
5. Compose path: `docker-compose.yml` (default)

Coolify will detect both services (`api` and `web`).

## 2. Set environment variables

In the resource's **Environment Variables** tab, add (do not commit these to
the repo):

| Key | Value |
|---|---|
| `SPLYNX_BASE_URL` | `https://clientzone.dkconnect.co.za` |
| `SPLYNX_API_KEY` | _your Splynx API key_ |
| `SPLYNX_API_SECRET` | _your Splynx API secret_ |
| `ADMIN_LOGIN` | `david` |
| `ANTHROPIC_API_KEY` | _your Anthropic key_ |
| `CLAUDE_MODEL` | `claude-sonnet-4-6` |
| `WHATSAPP_GROUP_JID` | _leave blank for now — set after QR onboarding_ |
| `SESSION_SECRET` | _32+ bytes hex; generate locally with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`_ |
| `DATA_DIR` | `/data` |
| `PUBLIC_BASE_URL` | _will be set automatically once domain is bound_ |
| `AI_DEBUG_LOG` | `false` |

> ⚠ **Rotate** the Splynx key+secret and the Anthropic key you shared in chat
> earlier — those are now in plaintext in our conversation history. Use the
> rotated values here.

## 3. Bind the domain

The architecture is **single-port**: only the `web` container is exposed (on
port `9090`). nginx inside `web` reverse-proxies `/auth`, `/tasks`, `/admin`,
and `/health` to the `api` container over the internal Docker network. The
`api` service is not reachable from outside.

1. **Domains** tab → add `taskupdater.dkconnect.co.za` → assign to the
   **`web`** service, mapped to container port `80` (Coolify's Traefik
   handles the public-side TLS and routes to the container's internal port,
   which is what the host port `9090` maps to).
2. Coolify provisions Let's Encrypt SSL automatically.

If you prefer Coolify's "expose port directly" path instead of binding a
domain, the host port is `9090` — open `http://<your-server-ip>:9090` and
make sure the firewall allows it.

## 4. Persistent storage

The compose file declares a named volume `data` mounted at `/data` in the
`api` container. Coolify backs this with a Docker volume that survives
redeploys. Stored there: `app.sqlite`, `photos/`, `baileys-auth/`. Don't
delete this volume — it holds the WhatsApp session and submission archive.

## 5. Deploy

Hit **Deploy**. First build takes ~3–5 min (TypeScript compile + native
addon builds for `sharp` / `better-sqlite3` / `baileys`).

## 6. Smoke test

After "Healthy":

```bash
# Replace with the URL Coolify gave you (or http://<server-ip>:9090 if no domain).
curl https://taskupdater.dkconnect.co.za/health   # → {"ok":true}  (proxied to api container)
curl https://taskupdater.dkconnect.co.za/         # → returns the SPA HTML
```

Then open `https://taskupdater.dkconnect.co.za` in a browser. You'll see the
sign-in screen; submitting it currently returns "501 not implemented" —
that's the placeholder until we land the auth model. The login page rendering
proves the build pipeline + SSL + reverse proxy are working.

## 7. Continuous deployment

In **Settings** → **Sources** → enable **Auto Deploy on Push**. Future
`git push origin main` triggers a redeploy automatically.

## 8. Watching logs

`Logs` tab → select `api` → live tail. Useful when we wire up Baileys (you'll
see the QR code printed at first start before you scan it from the admin UI).

---

## When something breaks

- **Build fails on `sharp` / `better-sqlite3`** — Coolify uses the Linux
  Dockerfile in this repo so the Windows build issues don't apply. If a
  build step fails, capture the log and we'll diagnose.
- **API container restarts** — check the `api` logs for missing env vars
  (the server boots with strict zod validation and refuses to start if
  anything required is unset).
- **502 from the web service** — confirm the API container is healthy and
  the nginx proxy/Traefik route to the API is correct.

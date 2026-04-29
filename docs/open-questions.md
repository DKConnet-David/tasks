# Open questions

## 1. Tech authentication model

The original plan was: each tech logs in with their own Splynx admin
credentials, the backend proxies the login. The probe revealed two issues:

- The deployed credentials are an **API key + secret**, not per-admin
  username/password. With API-key auth, Splynx does not expose a "current user"
  endpoint and every write requires `user_id` to be set explicitly.
- We have not been given individual Splynx admin credentials for each tech.

**Proposed change:** switch to **app-only** auth for techs:

- The app maintains its own `techs` table (login + bcrypt password) and a
  `splynx_admin_id` column linking each tech to a Splynx admin row (so the
  comment they create on Splynx is recorded under that admin's name).
- The backend uses the single API key for all Splynx API calls.
- The `ADMIN_LOGIN` value moves from a Splynx login to an app login.
- Provisioning is a tiny admin page or a CLI command: `npm run add-tech --
  --login=lorenzo --splynx-admin-id=7` then the tech sets their password on
  first sign-in.

Action: please confirm this is acceptable, OR provide individual Splynx admin
credentials for each tech (we'd revert to the proxy-login model).

## 2. Splynx file attachment

We could not find a working file-upload endpoint on this self-hosted Splynx
version (see [splynx-probe-findings.md](splynx-probe-findings.md)).

**Fallback (recommended, working today):** photos and the PDF live on our own
backend (in the data volume). The Splynx comment we post contains the AI
summary plus a link to a public viewer page hosted by us — e.g.
`https://taskupdater.<domain>/r/<token>` — that renders the photos + lets the
PDF be downloaded. The link uses a long random token so it is not guessable.

Action: please confirm this fallback is OK, or share Splynx admin docs / API
references for your version that show the file-upload endpoint we missed.

## 3. Manual cleanup needed in Splynx

Probe runs left two test comments on task #14967. DELETE via API is forbidden
for our key. Please delete from the Splynx admin UI:

- comment **51571** — `[task-upater file-probe …]`
- comment **51572** — `[probe] multipart variant`

## 4. WhatsApp number for Baileys

Baileys logs in by scanning a QR code with a phone running WhatsApp. After the
API container is deployed:

- Decide which phone/number to link (recommend a dedicated number, **not**
  your personal one — Baileys is unofficial and there's a small ban risk).
- Sign into the deployed app as the admin user, open the WhatsApp panel, scan
  the QR.
- Pick the target group from the listed groups, copy its JID into
  `WHATSAPP_GROUP_JID` in Coolify env vars, redeploy.

# Splynx API probe findings

_Tenant: `https://clientzone.dkconnect.co.za` — self-hosted, not Splynx Cloud._
_Probe date: 2026-04-29._

## Auth

- **Working:** API key + secret via HTTP Basic auth (`Authorization: Basic base64(key:secret)`).
- **Not present in this tenant:** any "whoami" / "current admin" endpoint. With API-key auth, requests don't have an inherent user identity — every write must explicitly carry `user_id`.

**Implication for our app:** the original plan ("each tech proxies their own Splynx admin login") needs revisiting — see `docs/open-questions.md`. We will probably switch to app-only auth for techs and use the API key as a service account, recording the tech's identity in our own DB and tagging the Splynx comment text with it.

## Task fetch

- ✅ `GET /api/2.0/admin/scheduling/tasks/{id}`
- Sample task #14967 returned the full record with the fields locked into [server/src/splynx/types.ts](../server/src/splynx/types.ts).
- Notable fields: `assignee` (admin id when `assigned_to == "assigned_to_administrator"`), `related_customer_id`, `address`, `gps`, `description` (HTML), `workflow_status_id`, `priority`, `task_labels[]`, `additional_attributes`.
- Dates use Splynx's local format (`"2026-02-19 10:41:46"`) and `"0000-00-00 00:00:00"` for unset values.

## Comments

- ✅ `GET /api/2.0/admin/scheduling/tasks-comments?main_attributes[task_id]={id}` → array of comments
- ✅ `GET /api/2.0/admin/scheduling/tasks-comments/{id}` → single comment
- ✅ `POST /api/2.0/admin/scheduling/tasks-comments` (JSON) → 201 with `{ id }`. Required body: `task_id`, `user_id`, `comment` (HTML allowed).
- ❌ `DELETE` is permission-locked (403 Forbidden) for our API key.
- ❌ `PATCH` not probed yet — assume comments are append-only for now.

**Comment shape:** `{id, task_id, user_id, comment, created_at, files[], pinned_datetime, is_edited, is_pinned, admin_name}`.

The `files[]` array on a comment can hold attachments, but **we have not yet found the endpoint that puts files into it on this Splynx version.** None of the following worked:

| Path | Result |
|---|---|
| `POST /api/2.0/admin/scheduling/tasks-files` | 404 |
| `POST /api/2.0/admin/scheduling/tasks/{id}/files` | 404 |
| `POST /api/2.0/admin/scheduling/tasks-comments-files` | 404 |
| `POST /api/2.0/admin/scheduling/tasks-comments/{id}/files` | 404 |
| `POST /api/2.0/admin/scheduling/tasks-comments` (multipart with `file`) | 201 but `files[]` stays empty |
| `POST /api/2.0/admin/files/files` | 404 |
| `POST /api/2.0/admin/uploads` | 500 |

**Decision:** the app does not depend on Splynx file attachments. Photos + the
generated PDF are stored in our own backend (data volume) and the Splynx
comment links to a public viewer URL (`https://taskupdater.<domain>/r/<token>`).
This was a planned fallback in the design and is now the chosen path. If we
later discover the correct file-upload endpoint, swap the link for a real
attachment.

## Test comments left on the live tenant

The probe created two test comments on task #14967. The API's DELETE is
forbidden for our key, so they need to be removed manually from the Splynx
admin UI:

- comment id **51571** — `[task-upater file-probe …] please ignore`
- comment id **51572** — `[probe] multipart variant`

## Open questions for the user

See [open-questions.md](open-questions.md).

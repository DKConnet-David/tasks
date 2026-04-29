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

## File attachments (resolved 2026-04-29)

Resolved via the v2.0 OpenAPI spec at
[api-doc.splynx.com/release-5.2.json](https://api-doc.splynx.com/release-5.2.json).

| Endpoint | What it does |
|---|---|
| `POST /api/2.0/admin/scheduling/tasks-attachments` | Multipart with `task_id`, `user_id`, `files[]`. Lands in the task's **Attachments** tab. |
| `POST /api/2.0/admin/scheduling/tasks-comments` | Multipart with `task_id`, `user_id`, `comment`, `files[]` — comment + attachments in one call. |
| `POST /api/2.0/admin/scheduling/tasks-comments/{id}--upload` | Multipart `files[]` to add files to an existing comment. |
| `PUT /api/2.0/admin/scheduling/tasks-comments/{id}` | JSON `{comment}` — edits a comment in place (no need for "[Updated by admin]" append workaround). |
| `DELETE /api/2.0/admin/scheduling/tasks-comments/{id}` | Permission-locked for our API key (403). Cleanup must be manual. |

**Why our earlier probe failed:** we used `file` (singular) as the multipart
field name. The spec wants `files[]` — plural array convention. Once that
was fixed, both `tasks-attachments` and `tasks-comments` (with files in the
same call) returned 201 with proper file records.

The submit pipeline now posts the AI summary as a comment **with the
generated PDF attached in the same call**, and the photos as direct task
attachments. No "viewer link" fallback needed.

## Test comments left on the live tenant

The probe created two test comments on task #14967. The API's DELETE is
forbidden for our key, so they need to be removed manually from the Splynx
admin UI:

- comment id **51571** — `[task-upater file-probe …] please ignore`
- comment id **51572** — `[probe] multipart variant`

## Open questions for the user

See [open-questions.md](open-questions.md).

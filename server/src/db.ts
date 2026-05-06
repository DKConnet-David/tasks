import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

let db: Database.Database | null = null;

export function getDb(dataDir: string): Database.Database {
  if (db) return db;
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, "app.sqlite");
  db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(d: Database.Database): void {
  d.exec(`
    -- App-only auth: each session is created on a successful local login
    -- (admin password check today, tech-table password check later). The
    -- splynx_admin_id is the Splynx admin row whose name we attribute
    -- comments to when this session writes back to Splynx.
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      app_login TEXT NOT NULL,
      splynx_admin_id INTEGER NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      app_login TEXT NOT NULL,
      splynx_admin_id INTEGER NOT NULL,
      source TEXT NOT NULL DEFAULT 'tech',
      comment TEXT,
      tech_comment_override TEXT,
      summary_json TEXT,
      corrected_summary_json TEXT,
      splynx_comment_id INTEGER,
      splynx_corrected_comment_id INTEGER,
      splynx_pdf_file_id INTEGER,
      wa_message_id TEXT,
      status TEXT NOT NULL,
      error TEXT,
      admin_resolved INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_submissions_task ON submissions(task_id);
    CREATE INDEX IF NOT EXISTS idx_submissions_login ON submissions(app_login);
    CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status);
    CREATE INDEX IF NOT EXISTS idx_submissions_created ON submissions(created_at DESC);

    CREATE TABLE IF NOT EXISTS submission_photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      submission_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      width INTEGER,
      height INTEGER,
      splynx_file_id INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (submission_id) REFERENCES submissions(id)
    );

    CREATE INDEX IF NOT EXISTS idx_photos_submission ON submission_photos(submission_id);

    CREATE TABLE IF NOT EXISTS admin_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      submission_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      details_json TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (submission_id) REFERENCES submissions(id)
    );

    -- Ratings live in their own table to enforce data compartmentalisation;
    -- see server/src/types.ts for the type-firewall rationale.
    CREATE TABLE IF NOT EXISTS submission_ratings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      submission_id INTEGER NOT NULL UNIQUE,
      ai_score INTEGER NOT NULL,
      ai_rationale TEXT NOT NULL,
      ai_dimensions_json TEXT NOT NULL,
      admin_score INTEGER,
      admin_rationale TEXT,
      admin_dimensions_json TEXT,
      reviewed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (submission_id) REFERENCES submissions(id)
    );

    CREATE INDEX IF NOT EXISTS idx_ratings_reviewed
      ON submission_ratings(reviewed_at DESC)
      WHERE admin_score IS NOT NULL;

    -- Mutable settings — currently used for the WhatsApp target group JID
    -- (set from the admin UI after onboarding) so we don't need an env-var
    -- redeploy when techs change destinations.
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- App-managed tech accounts. Admin provisions these via /admin/techs.
    -- splynx_admin_id maps the app user to a Splynx admin row so the comment
    -- the pipeline posts is attributed to the right name in Splynx.
    CREATE TABLE IF NOT EXISTS techs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      login TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      splynx_admin_id INTEGER NOT NULL,
      display_name TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_techs_login ON techs(login);

    -- App-managed admin accounts. Admins log into /admin and can edit
    -- summaries, override ratings, manage techs, and now provision other
    -- admins. The env-var ADMIN_LOGIN/ADMIN_PASSWORD seeds the first admin
    -- row on first boot (when this table is empty) and remains a permanent
    -- recovery credential — see auth.ts for the order-of-checks.
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      login TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      splynx_admin_id INTEGER NOT NULL,
      display_name TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_admins_login ON admins(login);

    -- Cached output of the per-tech monthly pattern-detection Claude call
    -- (server/src/ai/patterns.ts). Admin-only data — never reaches PDF /
    -- WhatsApp / Splynx — see the leak-test for the runtime guarantee.
    -- UNIQUE(app_login, period_start) means re-running the analysis for
    -- the same calendar month upserts cleanly.
    CREATE TABLE IF NOT EXISTS tech_patterns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      app_login TEXT NOT NULL,
      period_start INTEGER NOT NULL,
      period_end INTEGER NOT NULL,
      generated_at INTEGER NOT NULL,
      submission_count INTEGER NOT NULL,
      strengths_json TEXT NOT NULL,
      issues_json TEXT NOT NULL,
      coaching_json TEXT NOT NULL,
      summary_text TEXT NOT NULL,
      raw_response_json TEXT,
      ai_model TEXT,
      UNIQUE (app_login, period_start)
    );
    CREATE INDEX IF NOT EXISTS idx_tech_patterns_login
      ON tech_patterns(app_login, period_start DESC);
  `);

  // Idempotent column renames for databases created with the older schema
  // (when the auth model was Splynx-credential proxy). Safe to run on every
  // boot: PRAGMA table_info checks current shape and ALTER is skipped if
  // the rename has already been applied.
  const cols = (table: string) =>
    new Set(
      (d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name),
    );
  const subCols = cols("submissions");
  if (subCols.has("splynx_user_id") && !subCols.has("splynx_admin_id")) {
    d.exec(`ALTER TABLE submissions RENAME COLUMN splynx_user_id TO splynx_admin_id`);
  }
  if (subCols.has("splynx_login") && !subCols.has("app_login")) {
    d.exec(`ALTER TABLE submissions RENAME COLUMN splynx_login TO app_login`);
  }
  // 2026-04-30: admin can hide a submission (e.g. duplicate, typo task ID)
  // without deleting it. Hidden rows are filtered out of the default
  // Submissions list view and from all Performance dashboard rollups.
  if (!subCols.has("hidden")) {
    d.exec(`ALTER TABLE submissions ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0`);
    d.exec(`CREATE INDEX IF NOT EXISTS idx_submissions_visible ON submissions(hidden, created_at DESC)`);
  }
  const sesCols = cols("sessions");
  if (sesCols.has("splynx_user_id") && !sesCols.has("splynx_admin_id")) {
    d.exec(`ALTER TABLE sessions RENAME COLUMN splynx_user_id TO splynx_admin_id`);
  }
  if (sesCols.has("splynx_login") && !sesCols.has("app_login")) {
    d.exec(`ALTER TABLE sessions RENAME COLUMN splynx_login TO app_login`);
  }

  // 2026-05-06: AI rating now produces structured strengths/improvements
  // bullets instead of a free-form rationale paragraph. Two new nullable
  // JSON columns hold those arrays. ai_rationale stays as the legacy
  // fallback for old rows; new rows write empty string into it. Admin
  // rationale stays as a single textarea (per the operator's design call).
  const ratingCols = cols("submission_ratings");
  if (!ratingCols.has("ai_strengths_json")) {
    d.exec(`ALTER TABLE submission_ratings ADD COLUMN ai_strengths_json TEXT`);
  }
  if (!ratingCols.has("ai_improvements_json")) {
    d.exec(`ALTER TABLE submission_ratings ADD COLUMN ai_improvements_json TEXT`);
  }

  // 2026-05-06: multi-admin support. Audit log now attributes each action
  // to the admin who performed it. Nullable so legacy rows (single env-var
  // admin era) keep showing up as "—" in the actor column.
  const actionCols = cols("admin_actions");
  if (!actionCols.has("actor_login")) {
    d.exec(`ALTER TABLE admin_actions ADD COLUMN actor_login TEXT`);
  }

  // 2026-05-04: rating scale migrated from 1–5 to 1–10. Existing scores are
  // doubled so the meaning of historical ratings (and the few-shot calibration
  // they provide to the AI) is preserved one-for-one. Idempotent via the
  // migrations_meta marker — never re-applies on container restart.
  d.exec(`
    CREATE TABLE IF NOT EXISTS migrations_meta (
      key TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
  const SCORE_MIGRATION_KEY = "scores_1to5_to_1to10";
  const alreadyApplied = d
    .prepare(`SELECT 1 FROM migrations_meta WHERE key = ?`)
    .get(SCORE_MIGRATION_KEY);
  if (!alreadyApplied) {
    const tx = d.transaction(() => {
      d.prepare(`UPDATE submission_ratings SET ai_score = ai_score * 2 WHERE ai_score IS NOT NULL`).run();
      d.prepare(`UPDATE submission_ratings SET admin_score = admin_score * 2 WHERE admin_score IS NOT NULL`).run();

      const rows = d
        .prepare(
          `SELECT id, ai_dimensions_json, admin_dimensions_json FROM submission_ratings`,
        )
        .all() as {
        id: number;
        ai_dimensions_json: string;
        admin_dimensions_json: string | null;
      }[];
      const updateAi = d.prepare(
        `UPDATE submission_ratings SET ai_dimensions_json = ? WHERE id = ?`,
      );
      const updateAdmin = d.prepare(
        `UPDATE submission_ratings SET admin_dimensions_json = ? WHERE id = ?`,
      );
      for (const r of rows) {
        const aiDoubled = doubleDimensionsJson(r.ai_dimensions_json);
        if (aiDoubled !== null) updateAi.run(aiDoubled, r.id);
        if (r.admin_dimensions_json) {
          const adminDoubled = doubleDimensionsJson(r.admin_dimensions_json);
          if (adminDoubled !== null) updateAdmin.run(adminDoubled, r.id);
        }
      }

      d.prepare(
        `INSERT INTO migrations_meta(key, applied_at) VALUES (?, ?)`,
      ).run(SCORE_MIGRATION_KEY, Date.now());
    });
    tx();
  }
}

function doubleDimensionsJson(json: string): string | null {
  try {
    const obj = JSON.parse(json) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (typeof v !== "number" || !Number.isFinite(v)) return null;
      out[k] = Math.round(v * 2);
    }
    return JSON.stringify(out);
  } catch {
    return null;
  }
}

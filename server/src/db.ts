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
  const sesCols = cols("sessions");
  if (sesCols.has("splynx_user_id") && !sesCols.has("splynx_admin_id")) {
    d.exec(`ALTER TABLE sessions RENAME COLUMN splynx_user_id TO splynx_admin_id`);
  }
  if (sesCols.has("splynx_login") && !sesCols.has("app_login")) {
    d.exec(`ALTER TABLE sessions RENAME COLUMN splynx_login TO app_login`);
  }
}

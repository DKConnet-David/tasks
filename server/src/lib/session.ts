import crypto from "node:crypto";
import type Database from "better-sqlite3";
import type { SessionData } from "../types.js";

const COOKIE_NAME = "tu_session";

export function createSession(
  db: Database.Database,
  data: { app_login: string; splynx_admin_id: number; is_admin: boolean; ttlSeconds: number },
): string {
  const id = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions (id, app_login, splynx_admin_id, is_admin, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    data.app_login,
    data.splynx_admin_id,
    data.is_admin ? 1 : 0,
    now,
    now + data.ttlSeconds * 1000,
  );
  return id;
}

export function loadSession(db: Database.Database, id: string | undefined): SessionData | null {
  if (!id) return null;
  const row = db
    .prepare(
      `SELECT id, app_login, splynx_admin_id, is_admin, created_at, expires_at
       FROM sessions WHERE id = ?`,
    )
    .get(id) as
    | {
        id: string;
        app_login: string;
        splynx_admin_id: number;
        is_admin: number;
        created_at: number;
        expires_at: number;
      }
    | undefined;
  if (!row) return null;
  if (row.expires_at <= Date.now()) {
    destroySession(db, id);
    return null;
  }
  return {
    id: row.id,
    app_login: row.app_login,
    splynx_admin_id: row.splynx_admin_id,
    is_admin: row.is_admin === 1,
    created_at: row.created_at,
    expires_at: row.expires_at,
  };
}

export function destroySession(db: Database.Database, id: string): void {
  db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
}

export const sessionCookieName = COOKIE_NAME;

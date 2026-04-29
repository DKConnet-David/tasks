import crypto from "node:crypto";
import type Database from "better-sqlite3";
import type { SessionData } from "../types.js";

const COOKIE_NAME = "tu_session";

export function createSession(
  db: Database.Database,
  data: Omit<SessionData, "id">,
): string {
  const id = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions (id, splynx_user_id, splynx_login, access_token, refresh_token, expires_at, is_admin, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    data.splynx_user_id,
    data.splynx_login,
    data.access_token,
    data.refresh_token,
    data.expires_at,
    data.is_admin ? 1 : 0,
    now,
  );
  return id;
}

export function loadSession(db: Database.Database, id: string | undefined): SessionData | null {
  if (!id) return null;
  const row = db
    .prepare(
      `SELECT id, splynx_user_id, splynx_login, access_token, refresh_token, expires_at, is_admin
       FROM sessions WHERE id = ?`,
    )
    .get(id) as
    | {
        id: string;
        splynx_user_id: number;
        splynx_login: string;
        access_token: string;
        refresh_token: string;
        expires_at: number;
        is_admin: number;
      }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    splynx_user_id: row.splynx_user_id,
    splynx_login: row.splynx_login,
    access_token: row.access_token,
    refresh_token: row.refresh_token,
    expires_at: row.expires_at,
    is_admin: row.is_admin === 1,
  };
}

export function destroySession(db: Database.Database, id: string): void {
  db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
}

export function updateSessionTokens(
  db: Database.Database,
  id: string,
  access_token: string,
  refresh_token: string,
  expires_at: number,
): void {
  db.prepare(
    `UPDATE sessions SET access_token = ?, refresh_token = ?, expires_at = ? WHERE id = ?`,
  ).run(access_token, refresh_token, expires_at, id);
}

export const sessionCookieName = COOKIE_NAME;

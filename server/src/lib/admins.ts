import bcrypt from "bcryptjs";
import type Database from "better-sqlite3";
import { hashPassword } from "./techs.js";

/**
 * Admin accounts mirror the techs table in shape. Kept separate so the
 * tech population (field staff) and the admin population (operator + any
 * delegates) can grow independently. The env-var ADMIN_LOGIN /
 * ADMIN_PASSWORD seeds the first row in this table on first boot and
 * remains a permanent recovery credential — auth.ts checks the table
 * first and falls back to the env vars if no match.
 */

export interface AdminRow {
  id: number;
  login: string;
  password_hash: string;
  splynx_admin_id: number;
  display_name: string;
  is_active: 0 | 1;
  created_at: number;
  updated_at: number;
}

export function findAdminByLogin(db: Database.Database, login: string): AdminRow | null {
  const row = db
    .prepare(
      `SELECT id, login, password_hash, splynx_admin_id, display_name, is_active, created_at, updated_at
       FROM admins WHERE login = ?`,
    )
    .get(login) as AdminRow | undefined;
  return row ?? null;
}

export function listAdmins(db: Database.Database): Omit<AdminRow, "password_hash">[] {
  return db
    .prepare(
      `SELECT id, login, splynx_admin_id, display_name, is_active, created_at, updated_at
       FROM admins ORDER BY display_name COLLATE NOCASE ASC`,
    )
    .all() as Omit<AdminRow, "password_hash">[];
}

export function countAdmins(db: Database.Database): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM admins`).get() as { n: number };
  return row.n;
}

export function countActiveAdmins(db: Database.Database): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM admins WHERE is_active = 1`)
    .get() as { n: number };
  return row.n;
}

export async function createAdmin(
  db: Database.Database,
  args: {
    login: string;
    password: string;
    splynx_admin_id: number;
    display_name: string;
  },
): Promise<number> {
  const hash = await hashPassword(args.password);
  const now = Date.now();
  const result = db
    .prepare(
      `INSERT INTO admins (login, password_hash, splynx_admin_id, display_name, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
    )
    .run(args.login, hash, args.splynx_admin_id, args.display_name, now, now);
  return Number(result.lastInsertRowid);
}

export async function updateAdmin(
  db: Database.Database,
  id: number,
  patch: {
    password?: string;
    splynx_admin_id?: number;
    display_name?: string;
    is_active?: boolean;
  },
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.password !== undefined) {
    sets.push("password_hash = ?");
    params.push(await hashPassword(patch.password));
  }
  if (patch.splynx_admin_id !== undefined) {
    sets.push("splynx_admin_id = ?");
    params.push(patch.splynx_admin_id);
  }
  if (patch.display_name !== undefined) {
    sets.push("display_name = ?");
    params.push(patch.display_name);
  }
  if (patch.is_active !== undefined) {
    sets.push("is_active = ?");
    params.push(patch.is_active ? 1 : 0);
  }
  if (sets.length === 0) return;
  sets.push("updated_at = ?");
  params.push(Date.now());
  params.push(id);
  db.prepare(`UPDATE admins SET ${sets.join(", ")} WHERE id = ?`).run(...params);
}

export async function verifyAdminPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

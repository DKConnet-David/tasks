import bcrypt from "bcryptjs";
import type Database from "better-sqlite3";

export interface TechRow {
  id: number;
  login: string;
  password_hash: string;
  splynx_admin_id: number;
  display_name: string;
  is_active: 0 | 1;
  created_at: number;
  updated_at: number;
}

const BCRYPT_ROUNDS = 10;

// Pre-computed hash of an unguessable string. Used as a dummy in the auth
// route to keep the timing of "login not found" similar to "wrong password",
// since bcrypt.compare dominates the response time.
const DUMMY_HASH = "$2a$10$RmPIiFV6pBTOHX2vcQS5te70GdNl7PtoBlz0u7L3kQZDkU2HGo6BS";

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export async function dummyVerify(plain: string): Promise<void> {
  await bcrypt.compare(plain, DUMMY_HASH);
}

export function findTechByLogin(db: Database.Database, login: string): TechRow | null {
  const row = db
    .prepare(
      `SELECT id, login, password_hash, splynx_admin_id, display_name, is_active, created_at, updated_at
       FROM techs WHERE login = ?`,
    )
    .get(login) as TechRow | undefined;
  return row ?? null;
}

export function listTechs(db: Database.Database): Omit<TechRow, "password_hash">[] {
  return db
    .prepare(
      `SELECT id, login, splynx_admin_id, display_name, is_active, created_at, updated_at
       FROM techs ORDER BY display_name COLLATE NOCASE ASC`,
    )
    .all() as Omit<TechRow, "password_hash">[];
}

export async function createTech(
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
      `INSERT INTO techs (login, password_hash, splynx_admin_id, display_name, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
    )
    .run(args.login, hash, args.splynx_admin_id, args.display_name, now, now);
  return Number(result.lastInsertRowid);
}

export async function updateTech(
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
  db.prepare(`UPDATE techs SET ${sets.join(", ")} WHERE id = ?`).run(...params);
}

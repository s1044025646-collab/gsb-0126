import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = DatabaseSync;

let dbCounter = 0;

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec('PRAGMA foreign_keys=ON;');
  db.exec('PRAGMA busy_timeout=5000;');
  migrate(db);
  return db;
}

// Idempotent migrations. user_version moves strictly forward; every statement
// here is safe to run once per database file.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE IF NOT EXISTS materials (
    id INTEGER PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS bars (
    id INTEGER PRIMARY KEY,
    uid TEXT NOT NULL UNIQUE,
    material_id INTEGER NOT NULL REFERENCES materials(id),
    length_um INTEGER NOT NULL CHECK (length_um > 0),
    source TEXT NOT NULL CHECK (source IN ('new','remnant')),
    status TEXT NOT NULL CHECK (status IN ('available','reserved','consumed')),
    parent_bar_id INTEGER REFERENCES bars(id),
    origin_plan_bar_id INTEGER,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY,
    uid TEXT NOT NULL UNIQUE,
    material_id INTEGER NOT NULL REFERENCES materials(id),
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    code TEXT NOT NULL,
    length_um INTEGER NOT NULL CHECK (length_um > 0),
    qty INTEGER NOT NULL CHECK (qty > 0)
  );
  CREATE TABLE IF NOT EXISTS plans (
    id INTEGER PRIMARY KEY,
    uid TEXT NOT NULL UNIQUE,
    order_id INTEGER NOT NULL REFERENCES orders(id),
    material_id INTEGER NOT NULL REFERENCES materials(id),
    saw_kerf_um INTEGER NOT NULL CHECK (saw_kerf_um >= 0),
    end_trim_um INTEGER NOT NULL CHECK (end_trim_um >= 0),
    reuse_threshold_um INTEGER NOT NULL CHECK (reuse_threshold_um >= 0),
    status TEXT NOT NULL CHECK (status IN ('reserved','confirmed','cancelled')),
    feasible INTEGER NOT NULL CHECK (feasible IN (0,1)),
    optimality TEXT NOT NULL CHECK (optimality IN ('proven','unproven','infeasible')),
    lower_bound_bars INTEGER,
    idem_key TEXT UNIQUE,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS plan_bars (
    id INTEGER PRIMARY KEY,
    plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    bar_id INTEGER REFERENCES bars(id),
    material_id INTEGER NOT NULL REFERENCES materials(id),
    spec_length_um INTEGER NOT NULL CHECK (spec_length_um > 0),
    source TEXT NOT NULL CHECK (source IN ('remnant','stock','new')),
    end_trim_um INTEGER NOT NULL,
    saw_kerf_total_um INTEGER NOT NULL,
    leftover_um INTEGER NOT NULL,
    final_separated INTEGER NOT NULL CHECK (final_separated IN (0,1)),
    status TEXT NOT NULL CHECK (status IN ('pending','cut','cancelled'))
  );
  CREATE TABLE IF NOT EXISTS plan_pieces (
    id INTEGER PRIMARY KEY,
    plan_bar_id INTEGER NOT NULL REFERENCES plan_bars(id) ON DELETE CASCADE,
    order_item_id INTEGER NOT NULL REFERENCES order_items(id),
    seq INTEGER NOT NULL,
    length_um INTEGER NOT NULL,
    qty INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cuts (
    id INTEGER PRIMARY KEY,
    uid TEXT NOT NULL UNIQUE,
    plan_id INTEGER NOT NULL REFERENCES plans(id),
    plan_bar_id INTEGER NOT NULL UNIQUE REFERENCES plan_bars(id),
    idem_key TEXT NOT NULL UNIQUE,
    remnant_bar_id INTEGER REFERENCES bars(id),
    consumed_bar_uid TEXT NOT NULL,
    saw_count INTEGER NOT NULL,
    confirmed_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS piece_instances (
    id INTEGER PRIMARY KEY,
    cut_id INTEGER NOT NULL REFERENCES cuts(id),
    order_item_id INTEGER NOT NULL REFERENCES order_items(id),
    length_um INTEGER NOT NULL,
    seq INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS idempotency (
    idem_key TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    response_ref TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  `,
];

export function migrate(db: DB): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  let version = row.user_version;
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version = ${i + 1};`);
      db.exec('COMMIT');
      version = i + 1;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

export function newUid(prefix: string, random: () => number = Math.random): string {
  dbCounter = (dbCounter + 1) % 0xffff;
  const suffix = random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}${dbCounter.toString(16)}${suffix}`;
}

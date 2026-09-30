import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000;
  `);
  migrate(db);
  return db;
}

export function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY);

    CREATE TABLE IF NOT EXISTS materials(
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stock_bars(
      code TEXT PRIMARY KEY,
      material_code TEXT NOT NULL REFERENCES materials(code),
      length INTEGER NOT NULL CHECK(length > 0),
      status TEXT NOT NULL CHECK(status IN ('available','reserved','consumed','released')),
      origin_bar_code TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS orders(
      code TEXT PRIMARY KEY,
      material_code TEXT NOT NULL REFERENCES materials(code),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS order_items(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_code TEXT NOT NULL REFERENCES orders(code),
      part_code TEXT NOT NULL,
      cut_length INTEGER NOT NULL CHECK(cut_length > 0),
      quantity INTEGER NOT NULL CHECK(quantity > 0),
      fulfilled_quantity INTEGER NOT NULL DEFAULT 0 CHECK(fulfilled_quantity >= 0),
      UNIQUE(order_code, part_code)
    );

    CREATE TABLE IF NOT EXISTS settings(
      id INTEGER PRIMARY KEY CHECK(id=1),
      kerf INTEGER NOT NULL DEFAULT 3000 CHECK(kerf >= 0),
      end_trim INTEGER NOT NULL DEFAULT 10000 CHECK(end_trim >= 0),
      reusable_threshold INTEGER NOT NULL DEFAULT 300000 CHECK(reusable_threshold >= 0),
      final_separation_rule TEXT NOT NULL DEFAULT 'reusable_only'
        CHECK(final_separation_rule IN ('reusable_only','always'))
    );

    CREATE TABLE IF NOT EXISTS plans(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_code TEXT NOT NULL REFERENCES orders(code),
      status TEXT NOT NULL CHECK(status IN ('proposed','reserved','partial','confirmed','cancelled')),
      kerf INTEGER NOT NULL,
      end_trim INTEGER NOT NULL,
      reusable_threshold INTEGER NOT NULL,
      final_separation_rule TEXT NOT NULL,
      final_cut_required INTEGER NOT NULL DEFAULT 0,
      exact INTEGER NOT NULL,
      optimality_note TEXT NOT NULL,
      lower_bound_new_bars INTEGER NOT NULL,
      new_bars_used INTEGER NOT NULL,
      non_reusable_loss INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS plan_bars(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
      bar_code TEXT NOT NULL REFERENCES stock_bars(code),
      position INTEGER NOT NULL,
      end_trim INTEGER NOT NULL,
      cuts INTEGER NOT NULL,
      remnant_length INTEGER NOT NULL,
      non_reusable_loss INTEGER NOT NULL,
      final_cut_required INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','confirmed')),
      idempotency_key TEXT,
      UNIQUE(plan_id, position)
    );

    CREATE TABLE IF NOT EXISTS plan_pieces(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_bar_id INTEGER NOT NULL REFERENCES plan_bars(id) ON DELETE CASCADE,
      order_item_id INTEGER NOT NULL REFERENCES order_items(id),
      sequence INTEGER NOT NULL,
      length INTEGER NOT NULL,
      UNIQUE(plan_bar_id, sequence)
    );

    CREATE TABLE IF NOT EXISTS cuts(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id INTEGER NOT NULL REFERENCES plans(id),
      bar_code TEXT NOT NULL,
      part_code TEXT NOT NULL,
      length INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS confirmations(
      idempotency_key TEXT NOT NULL,
      plan_id INTEGER NOT NULL REFERENCES plans(id),
      confirmed_at TEXT NOT NULL,
      PRIMARY KEY(plan_id, idempotency_key)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS ux_plan_bar_idempotency
      ON plan_bars(plan_id,idempotency_key) WHERE idempotency_key IS NOT NULL;

    CREATE INDEX IF NOT EXISTS ix_plan_bars_bar ON plan_bars(bar_code);
  `);
}

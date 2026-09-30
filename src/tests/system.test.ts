import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../db.js";
import { StockService } from "../service.js";
import { solveCutting } from "../solver.js";

function setup() {
  const dir = mkdtempSync(join("data", "test-"));
  const dbPath = join(dir, "test.db");
  const db = openDatabase(dbPath);
  const service = new StockService(db, { now: () => new Date("2026-01-01T00:00:00Z") });
  service.updateSettings({ kerf: 3, endTrim: 10, reusableThreshold: 300, finalSeparationRule: "reusable_only" });
  service.createMaterial({ code: "AL", name: "aluminium" });
  return { dir, dbPath, db, service };
}

test("lengths and saw kerf conserve every planned bar", () => {
  const result = solveCutting(
    [
      { orderItemId: 1, partCode: "A", length: 500000, remaining: 2 },
      { orderItemId: 2, partCode: "B", length: 300000, remaining: 1 },
    ],
    [{ code: "R1", length: 1200000, isRemnant: false }, { code: "R2", length: 1200000, isRemnant: false }],
    { kerf: 3000, endTrim: 10000, reusableThreshold: 300000, finalSeparationRule: "reusable_only" },
  );
  assert.equal(result.exact, true);
  for (const bar of result.bars) {
    const pieces = bar.pieces.reduce((sum, piece) => sum + piece.length, 0);
    assert.equal(pieces + bar.endTrim + bar.cuts * 3000 + bar.remnantLength, bar.barLength);
  }
  assert.deepEqual(result.bars.map((bar) => bar.pieces.length).sort(), [1, 2]);
});

test("small instance is solved with one new bar and exact proof", () => {
  const result = solveCutting(
    [{ orderItemId: 1, partCode: "A", length: 500000, remaining: 2 }],
    [{ code: "N", length: 1200000, isRemnant: false }],
    { kerf: 3000, endTrim: 10000, reusableThreshold: 300000, finalSeparationRule: "reusable_only" },
  );
  assert.equal(result.bars.length, 1);
  assert.equal(result.newBarsUsed, 1);
  assert.match(result.optimalityNote, /proven optimal/);
});

test("oversized and unmatched parts return explicit infeasibility", () => {
  const { service } = setup();
  service.registerBar({ code: "S1", materialCode: "AL", length: 100 });
  service.createOrder({ code: "O", materialCode: "AL", items: [{ partCode: "LONG", cutLength: 200, quantity: 1 }] });
  assert.throws(() => service.solve("O"), /longer than every/);
  assert.equal(service.explain("O")[0].reason, "BAR_TOO_SHORT");
});

test("confirmation is atomic, reuses remnant, and repeats idempotently", () => {
  const ctx = setup();
  ctx.service.registerBar({ code: "B1", materialCode: "AL", length: 1200 });
  ctx.service.createOrder({ code: "O1", materialCode: "AL", items: [{ partCode: "P300", cutLength: 300, quantity: 1 }] });
  const plan = ctx.service.solve("O1") as Record<string, unknown>;
  ctx.service.reservePlan(Number(plan.id));
  const first = ctx.service.confirmPlanBar(Number(plan.id), 0, "once") as Record<string, unknown>;
  assert.equal(first.remnantCode, "B1-R0");
  const cutsAfter = ctx.service.list("cuts", 1, 100).total;
  const repeat = ctx.service.confirmPlanBar(Number(plan.id), 0, "once") as Record<string, unknown>;
  assert.equal(repeat.idempotent, true);
  assert.equal(ctx.service.list("cuts", 1, 100).total, cutsAfter);

  ctx.service.createOrder({ code: "O2", materialCode: "AL", items: [{ partCode: "P100", cutLength: 100, quantity: 1 }] });
  const remnantPlan = ctx.service.solve("O2") as unknown as { bars: Array<Record<string, unknown>>; new_bars_used: number };
  assert.equal(remnantPlan.bars[0].bar_code, "B1-R0");
  assert.equal(remnantPlan.new_bars_used, 0);
  assert.equal((ctx.service.get("stock_bars", "B1") as Record<string, unknown>).status, "consumed");
});

test("concurrent reservations cannot consume the same bar", () => {
  const ctx = setup();
  ctx.service.registerBar({ code: "SHARED", materialCode: "AL", length: 600 });
  ctx.service.createOrder({ code: "O1", materialCode: "AL", items: [{ partCode: "A", cutLength: 100, quantity: 1 }] });
  ctx.service.createOrder({ code: "O2", materialCode: "AL", items: [{ partCode: "B", cutLength: 100, quantity: 1 }] });
  const p1 = Number((ctx.service.solve("O1") as Record<string, unknown>).id);
  const p2 = Number((ctx.service.solve("O2") as Record<string, unknown>).id);
  ctx.service.reservePlan(p1);
  assert.throws(() => ctx.service.reservePlan(p2), /taken by another/);
  assert.equal((ctx.service.getPlan(p2) as Record<string, unknown>).status, "proposed");
});

test("failed confirmation rolls back and state survives reopening SQLite", () => {
  const ctx = setup();
  ctx.service.registerBar({ code: "B", materialCode: "AL", length: 600 });
  ctx.service.createOrder({ code: "O", materialCode: "AL", items: [{ partCode: "P", cutLength: 100, quantity: 1 }] });
  const planId = Number((ctx.service.solve("O") as Record<string, unknown>).id);
  ctx.service.reservePlan(planId);
  ctx.db.exec("DROP TABLE cuts");
  assert.throws(() => ctx.service.confirmPlanBar(planId, 0, "failed"));
  assert.equal((ctx.service.get("stock_bars", "B") as Record<string, unknown>).status, "reserved");
  ctx.db.close();

  const reopened = new DatabaseSync(ctx.dbPath);
  const status = String((reopened.prepare("SELECT status FROM stock_bars WHERE code='B'").get() as Record<string, unknown>).status);
  assert.equal(status, "reserved");
  reopened.close();
  rmSync(ctx.dir, { recursive: true, force: true });
});

test("migration is repeatable", () => {
  const ctx = setup();
  ctx.db.close();
  const reopened = openDatabase(ctx.dbPath);
  reopened.close();
  rmSync(ctx.dir, { recursive: true, force: true });
});

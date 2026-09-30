import type { DatabaseSync } from "node:sqlite";
import { AppError, conflict, invalid, notFound } from "./errors.js";
import { id, parseLength, positiveInt } from "./length.js";
import { CandidateBar, CutParams, DemandItem, solveCutting } from "./solver.js";

export interface Clock { now(): Date; }

export class StockService {
  constructor(private readonly db: DatabaseSync, private readonly clock: Clock = { now: () => new Date() }) {}

  private ts() { return this.clock.now().toISOString(); }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  createMaterial(input: unknown) {
    const body = objectBody(input);
    const code = id(body.code, "code");
    const name = stringField(body.name, "name", 120);
    try {
      this.db.prepare("INSERT INTO materials(code,name,created_at) VALUES(?,?,?)").run(code, name, this.ts());
    } catch (e) { throw this.unique(e, "material"); }
    return this.get("materials", code);
  }

  registerBar(input: unknown) {
    const body = objectBody(input);
    const code = id(body.code, "code");
    const materialCode = id(body.materialCode ?? body.material_code, "materialCode");
    const length = parseLength(body.length, "length");
    if (length <= 0) throw invalid("length must be greater than zero");
    this.require("materials", materialCode, "material");
    try {
      this.db.prepare(`
        INSERT INTO stock_bars(code,material_code,length,status,origin_bar_code,created_at)
        VALUES(?,?,?, 'available', NULL, ?)
      `).run(code, materialCode, length, this.ts());
    } catch (e) { throw this.unique(e, "bar"); }
    return this.get("stock_bars", code);
  }

  createOrder(input: unknown) {
    const body = objectBody(input);
    const code = id(body.code, "code");
    const materialCode = id(body.materialCode ?? body.material_code, "materialCode");
    this.require("materials", materialCode, "material");
    const rawItems = Array.isArray(body.items) ? body.items : [];
    if (!rawItems.length) throw invalid("items must contain at least one part");
    const items = rawItems.map((raw, index) => {
      const row = objectBody(raw);
      return {
        partCode: id(row.partCode ?? row.part_code, `items[${index}].partCode`),
        cutLength: parseLength(row.cutLength ?? row.cut_length, `items[${index}].cutLength`),
        quantity: positiveInt(row.quantity, `items[${index}].quantity`),
      };
    });

    this.transaction(() => {
      try {
        this.db.prepare("INSERT INTO orders(code,material_code,created_at) VALUES(?,?,?)")
          .run(code, materialCode, this.ts());
      } catch (e) { throw this.unique(e, "order"); }
      const stmt = this.db.prepare(`
        INSERT INTO order_items(order_code,part_code,cut_length,quantity)
        VALUES(?,?,?,?)
      `);
      for (const item of items) {
        if (item.cutLength <= 0) throw invalid("cutLength must be greater than zero");
        stmt.run(code, item.partCode, item.cutLength, item.quantity);
      }
    });
    return this.getOrder(code);
  }

  updateSettings(input: unknown) {
    const body = objectBody(input);
    const values = {
      kerf: parseLength(body.kerf ?? 0, "kerf"),
      endTrim: parseLength(body.endTrim ?? 0, "endTrim"),
      reusableThreshold: parseLength(body.reusableThreshold ?? 0, "reusableThreshold"),
      finalSeparationRule: body.finalSeparationRule ?? body.final_separation_rule ?? "reusable_only",
    };
    const finalSeparationRule = String(values.finalSeparationRule) as CutParams["finalSeparationRule"];
    if (!["reusable_only", "always"].includes(finalSeparationRule)) {
      throw invalid("finalSeparationRule must be reusable_only or always");
    }
    this.db.prepare(`
      INSERT INTO settings(id,kerf,end_trim,reusable_threshold,final_separation_rule)
      VALUES(1,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        kerf=excluded.kerf, end_trim=excluded.end_trim,
        reusable_threshold=excluded.reusable_threshold,
        final_separation_rule=excluded.final_separation_rule
    `).run(values.kerf, values.endTrim, values.reusableThreshold, finalSeparationRule);
    return this.settings();
  }

  settings(): CutParams {
    const row = this.db.prepare("SELECT * FROM settings WHERE id=1").get() as Record<string, unknown> | undefined;
    return {
      kerf: Number(row?.kerf ?? 3000),
      endTrim: Number(row?.end_trim ?? 10000),
      reusableThreshold: Number(row?.reusable_threshold ?? 300000),
      finalSeparationRule: String(row?.final_separation_rule ?? "reusable_only") as CutParams["finalSeparationRule"],
    };
  }

  solve(orderCode: string) {
    const order = this.require("orders", orderCode, "order") as Record<string, unknown>;
    const materialCode = String(order.material_code);
    const demand = this.db.prepare(`
      SELECT id, part_code, cut_length, quantity, fulfilled_quantity
      FROM order_items WHERE order_code=?
      ORDER BY id
    `).all(orderCode).map((row) => {
      const r = row as Record<string, unknown>;
      const remaining = Number(r.quantity) - Number(r.fulfilled_quantity);
      return {
        orderItemId: Number(r.id), partCode: String(r.part_code),
        length: Number(r.cut_length), remaining,
      } satisfies DemandItem;
    }).filter((item) => item.remaining > 0);
    if (!demand.length) throw conflict("ORDER_COMPLETE", "order already fully fulfilled");

    const candidates = this.db.prepare(`
      SELECT code,length, CASE WHEN origin_bar_code IS NULL THEN 0 ELSE 1 END AS is_remnant
      FROM stock_bars WHERE material_code=? AND status='available'
    `).all(materialCode).map((row) => {
      const r = row as Record<string, unknown>;
      return { code: String(r.code), length: Number(r.length), isRemnant: Number(r.is_remnant) === 1 } satisfies CandidateBar;
    });

    const params = this.settings();
    let result;
    try {
      result = solveCutting(demand, candidates, params);
    } catch (e) {
      if ((e as AppError).code === "NO_FEASIBLE_PATTERN") {
        throw conflict("NO_FEASIBLE_PATTERN", (e as Error).message, (e as AppError).details ?? this.explain(orderCode));
      }
      throw e;
    }

    return this.transaction(() => {
      const info = this.db.prepare(`
        INSERT INTO plans(order_code,status,kerf,end_trim,reusable_threshold,final_separation_rule,
          exact,optimality_note,lower_bound_new_bars,new_bars_used,non_reusable_loss,created_at)
        VALUES(?, 'proposed',?,?,?,?,?,?,?,?,?,?)
      `).run(
        orderCode, params.kerf, params.endTrim, params.reusableThreshold, params.finalSeparationRule,
        result.exact ? 1 : 0, result.optimalityNote, result.lowerBoundNewBars,
        result.newBarsUsed, result.nonReusableLoss, this.ts(),
      );
      const planId = Number(info.lastInsertRowid);
      for (const [position, bar] of result.bars.entries()) {
        const pb = this.db.prepare(`
          INSERT INTO plan_bars(plan_id,bar_code,position,end_trim,cuts,remnant_length,
            non_reusable_loss,final_cut_required)
          VALUES(?,?,?,?,?,?,?,?)
        `).run(planId, bar.barCode, position, bar.endTrim, bar.cuts, bar.remnantLength,
          bar.nonReusableLoss, bar.finalCutRequired ? 1 : 0);
        const planBarId = Number(pb.lastInsertRowid);
        bar.pieces.forEach((piece, sequence) => {
          this.db.prepare(`
            INSERT INTO plan_pieces(plan_bar_id,order_item_id,sequence,length) VALUES(?,?,?,?)
          `).run(planBarId, piece.orderItemId, sequence, piece.length);
        });
      }
      return this.getPlan(planId);
    });
  }

  reservePlan(planId: number) {
    this.require("plans", String(planId), "plan");
    try {
      return this.transaction(() => {
        const plan = this.db.prepare("SELECT status FROM plans WHERE id=?").get(planId) as Record<string, unknown>;
        if (String(plan.status) !== "proposed") throw conflict("PLAN_NOT_RESERVABLE", `plan is ${plan.status}`);
        const bars = this.db.prepare("SELECT bar_code FROM plan_bars WHERE plan_id=? ORDER BY position").all(planId)
          .map((row) => String((row as Record<string, unknown>).bar_code));
        for (const barCode of bars) {
          const result = this.db.prepare("UPDATE stock_bars SET status='reserved' WHERE code=? AND status='available'")
            .run(barCode);
          if (Number(result.changes) !== 1) throw conflict("BAR_UNAVAILABLE", `bar ${barCode} is not available`);
        }
        this.db.prepare("UPDATE plans SET status='reserved' WHERE id=?").run(planId);
        return this.getPlan(planId);
      });
    } catch (e) {
      if ((e as AppError).code === "BAR_UNAVAILABLE") throw conflict("BAR_UNAVAILABLE", "one or more bars were taken by another reservation");
      throw e;
    }
  }

  confirmPlanBar(planId: number, position: number, idempotencyKey: string) {
    id(idempotencyKey, "idempotencyKey");
    this.require("plans", String(planId), "plan");
    const existingPlanBar = this.db.prepare(
      "SELECT * FROM plan_bars WHERE plan_id=? AND position=? AND status='confirmed'"
    ).get(planId, position) as Record<string, unknown> | undefined;
    if (existingPlanBar) {
      const cuts = this.db.prepare("SELECT * FROM cuts WHERE plan_id=? AND bar_code=? ORDER BY id")
        .all(planId, String(existingPlanBar.bar_code));
      return { idempotent: true, cuts, barCode: String(existingPlanBar.bar_code), plan: this.getPlan(planId) };
    }

    return this.transaction(() => {
      const plan = this.db.prepare("SELECT * FROM plans WHERE id=?").get(planId) as Record<string, unknown>;
      if (!["reserved", "partial"].includes(String(plan.status))) {
        throw conflict("PLAN_NOT_CONFIRMABLE", `plan is ${plan.status}`);
      }
      const planBar = this.db.prepare("SELECT * FROM plan_bars WHERE plan_id=? AND position=?")
        .get(planId, position) as Record<string, unknown> | undefined;
      if (!planBar) throw notFound("planned bar not found");
      if (String(planBar.status) === "confirmed") throw conflict("ALREADY_CONFIRMED", "this bar was already cut");
      const barCode = String(planBar.bar_code);
      const consumed = this.db.prepare("UPDATE stock_bars SET status='consumed' WHERE code=? AND status='reserved'")
        .run(barCode);
      if (Number(consumed.changes) !== 1) throw conflict("BAR_UNAVAILABLE", `bar ${barCode} is not reserved`);

      const pieces = this.db.prepare(`
        SELECT pp.*, oi.part_code, oi.order_code
        FROM plan_pieces pp JOIN order_items oi ON oi.id=pp.order_item_id
        WHERE pp.plan_bar_id=? ORDER BY pp.sequence
      `).all(Number(planBar.id)) as Array<Record<string, unknown>>;
      const cutIds: number[] = [];
      for (const piece of pieces) {
        const info = this.db.prepare(`
          INSERT INTO cuts(plan_id,bar_code,part_code,length,created_at)
          VALUES(?,?,?,?,?)
        `).run(planId, barCode, String(piece.part_code), Number(piece.length), this.ts());
        cutIds.push(Number(info.lastInsertRowid));
        this.db.prepare(`
          UPDATE order_items SET fulfilled_quantity=fulfilled_quantity+1 WHERE id=? AND fulfilled_quantity<quantity
        `).run(Number(piece.order_item_id));
      }

      const remnantLength = Number(planBar.remnant_length);
      let remnantCode: string | null = null;
      if (remnantLength >= Number(plan.reusable_threshold)) {
        remnantCode = `${barCode}-R${position}`;
        const material = this.db.prepare("SELECT material_code FROM orders WHERE code=?")
          .get(String(plan.order_code)) as Record<string, unknown>;
        this.db.prepare(`
          INSERT INTO stock_bars(code,material_code,length,status,origin_bar_code,created_at)
          VALUES(?,?,?, 'available', ?, ?)
        `).run(remnantCode, String(material.material_code), remnantLength, barCode, this.ts());
      }

      this.db.prepare("UPDATE plan_bars SET status='confirmed', idempotency_key=? WHERE id=?")
        .run(idempotencyKey, Number(planBar.id));
      this.db.prepare("INSERT INTO confirmations(idempotency_key,plan_id,confirmed_at) VALUES(?,?,?)")
        .run(idempotencyKey, planId, this.ts());
      const remaining = Number((this.db.prepare(
        "SELECT COUNT(*) AS n FROM plan_bars WHERE plan_id=? AND status='planned'"
      ).get(planId) as Record<string, unknown>).n);
      this.db.prepare("UPDATE plans SET status=? WHERE id=?")
        .run(remaining === 0 ? "confirmed" : "partial", planId);
      return { idempotent: false, barCode, cutIds, remnantCode, plan: this.getPlan(planId) };
    });
  }

  releasePlan(planId: number) {
    this.require("plans", String(planId), "plan");
    return this.transaction(() => {
      const plan = this.db.prepare("SELECT status FROM plans WHERE id=?").get(planId) as Record<string, unknown>;
      if (!["proposed", "reserved", "partial"].includes(String(plan.status))) {
        throw conflict("PLAN_NOT_RELEASABLE", `plan is ${plan.status}`);
      }
      this.db.prepare(`
        UPDATE stock_bars SET status='available'
        WHERE code IN (SELECT bar_code FROM plan_bars WHERE plan_id=? AND status='planned')
          AND status='reserved'
      `).run(planId);
      this.db.prepare("UPDATE plans SET status='cancelled' WHERE id=?").run(planId);
      return this.getPlan(planId);
    });
  }

  explain(orderCode: string) {
    this.require("orders", orderCode, "order");
    return this.db.prepare(`
      SELECT i.part_code AS partCode, i.cut_length AS requiredLength,
             i.quantity - i.fulfilled_quantity AS remaining,
             COALESCE(MAX(b.length),0) AS longestAvailableBar,
             CASE WHEN MAX(b.length) IS NULL THEN 'NO_MATCHING_STOCK'
                  WHEN MAX(b.length) < i.cut_length THEN 'BAR_TOO_SHORT'
                  ELSE 'INSUFFICIENT_TOTAL_CAPACITY' END AS reason
      FROM order_items i
      JOIN orders o ON o.code=i.order_code
      LEFT JOIN stock_bars b ON b.material_code=o.material_code AND b.status='available'
      WHERE i.order_code=? AND i.quantity > i.fulfilled_quantity
      GROUP BY i.id
    `).all(orderCode);
  }

  list(table: string, pageValue: unknown, pageSizeValue: unknown, where = "", params: Array<string | number> = []) {
    const page = Math.max(1, Number(pageValue) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(pageSizeValue) || 20));
    const allowed = new Set(["materials", "stock_bars", "orders", "plans", "cuts", "order_items"]);
    if (!allowed.has(table)) throw invalid("unsupported collection");
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get(...params) as Record<string, unknown>).n);
    const items = this.db.prepare(`SELECT * FROM ${table} ${where} LIMIT ? OFFSET ?`)
      .all(...params, pageSize, (page - 1) * pageSize);
    return { items, page, pageSize, total };
  }

  get(table: string, code: string) {
    const allowed = new Set(["materials", "stock_bars", "orders"]);
    if (!allowed.has(table)) throw invalid("unsupported collection");
    const key = table === "plans" ? "id" : "code";
    const row = this.db.prepare(`SELECT * FROM ${table} WHERE ${key}=?`).get(code);
    if (!row) throw notFound(`${table.slice(0, -1)} not found`);
    return row;
  }

  getOrder(code: string) {
    const order = this.get("orders", code);
    const items = this.db.prepare("SELECT * FROM order_items WHERE order_code=? ORDER BY id").all(code);
    return { ...order, items };
  }

  getPlan(id: number) {
    const plan = this.db.prepare("SELECT * FROM plans WHERE id=?").get(id) as Record<string, unknown>;
    const bars = (this.db.prepare(`
      SELECT pb.*, json_group_array(json_object(
        'sequence', pp.sequence, 'length', pp.length,
        'orderItemId', pp.order_item_id
      )) AS pieces
      FROM plan_bars pb LEFT JOIN plan_pieces pp ON pp.plan_bar_id=pb.id
      WHERE pb.plan_id=? GROUP BY pb.id ORDER BY pb.position
    `).all(id) as Array<Record<string, unknown>>).map((bar) => ({
      ...bar,
      pieces: JSON.parse(String(bar.pieces)).filter((piece: { sequence: number | null }) => piece.sequence !== null),
    }));
    return { ...plan, bars };
  }

  private require(table: string, value: string, label: string) {
    const key = table === "plans" ? "id" : "code";
    const row = this.db.prepare(`SELECT * FROM ${table} WHERE ${key}=?`).get(value);
    if (!row) throw notFound(`${label} not found`);
    return row;
  }

  private unique(e: unknown, label: string) {
    return String((e as Error).message).includes("UNIQUE")
      ? conflict("ALREADY_EXISTS", `${label} already exists`)
      : e as Error;
  }
}

function objectBody(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid("request body must be an object");
  return input as Record<string, unknown>;
}

function stringField(value: unknown, field: string, max: number) {
  if (typeof value !== "string" || value.trim().length < 1 || value.length > max) {
    throw invalid(`${field} must be a non-empty string up to ${max} characters`);
  }
  return value.trim();
}


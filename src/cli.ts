import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { openDatabase } from "./db.js";
import { formatLength } from "./length.js";
import { StockService } from "./service.js";

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const demo = command === "demo";
  const dbPath = resolve(demo ? "data/demo.db" : "data/app.db");
  if (demo) {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(dbPath + suffix, { force: true });
  }
  const db = openDatabase(dbPath);
  const service = new StockService(db);
  const json = (value: unknown) => console.log(JSON.stringify(value, null, 2));

  switch (command) {
    case "material":
      json(service.createMaterial({ code: args[0], name: args[1] ?? args[0] }));
      break;
    case "bar":
      console.log("before", service.list("stock_bars", 1, 1));
      json(service.registerBar({ code: args[0], materialCode: args[1], length: args[2] }));
      console.log("after", service.list("stock_bars", 1, 1));
      break;
    case "order": {
      const [code, material, ...parts] = args;
      const items = [];
      for (let i = 0; i < parts.length; i += 3) {
        items.push({ partCode: parts[i], cutLength: parts[i + 1], quantity: Number(parts[i + 2]) });
      }
      console.log("before", service.list("orders", 1, 1));
      json(service.createOrder({ code, materialCode: material, items }));
      console.log("after", service.list("orders", 1, 1));
      break;
    }
    case "solve":
      console.log("before stock", service.list("stock_bars", 1, 100));
      json(service.solve(args[0]));
      break;
    case "unmet":
      json({ items: service.explain(args[0]) });
      break;
    case "reserve":
      console.log("before", service.getPlan(Number(args[0])));
      json(service.reservePlan(Number(args[0])));
      break;
    case "confirm":
      console.log("before", service.getPlan(Number(args[0])));
      json(service.confirmPlanBar(Number(args[0]), Number(args[1]), args[2] ?? `bar-${args[0]}-${args[1]}`));
      break;
    case "release":
      console.log("before", service.getPlan(Number(args[0])));
      json(service.releasePlan(Number(args[0])));
      break;
    case "list":
      json(service.list(args[0] ?? "stock_bars", Number(args[1] ?? 1), Number(args[2] ?? 20)));
      break;
    case "settings":
      if (args.length >= 3) {
        json(service.updateSettings({
          kerf: args[0], endTrim: args[1], reusableThreshold: args[2],
          finalSeparationRule: args[3] ?? "reusable_only",
        }));
      } else json(service.settings());
      break;
    case "demo":
      runDemo(service, json);
      break;
    default:
      console.log(`commands: material bar order solve unmet reserve confirm release list settings demo
example order: order O1 AL P1 500 2 P2 300 1`);
  }
  db.close();
}

function runDemo(service: StockService, json: (v: unknown) => void) {
  service.updateSettings({ kerf: 3, endTrim: 10, reusableThreshold: 300, finalSeparationRule: "reusable_only" });
  service.createMaterial({ code: "AL", name: "aluminium fixture profile" });
  service.registerBar({ code: "R1", materialCode: "AL", length: 1200 });
  service.registerBar({ code: "R2", materialCode: "AL", length: 1200 });
  service.createOrder({
    code: "O1",
    materialCode: "AL",
    items: [
      { partCode: "P500", cutLength: 500, quantity: 2 },
      { partCode: "P300", cutLength: 300, quantity: 1 },
    ],
  });
  const firstPlan = service.solve("O1");
  service.reservePlan(Number((firstPlan as { id?: number }).id ?? 1));
  console.log("plan before confirmation");
  json(firstPlan);
  const firstCut = service.confirmPlanBar(1, 0, "demo-cut-0");
  console.log("after first bar: cuts, reusable remnant and remaining plan");
  json(firstCut);
  json(service.confirmPlanBar(1, 1, "demo-cut-1"));
  const repeat = service.confirmPlanBar(1, 0, "demo-cut-0");
  console.log("repeated confirmation must be idempotent");
  json(repeat);
  const newOrder = service.createOrder({
    code: "O2", materialCode: "AL",
    items: [{ partCode: "P180", cutLength: 180, quantity: 1 }],
  });
  console.log("second order before remnant-aware solve");
  json(newOrder);
  const remnantPlan = service.solve("O2");
  console.log("remnant-first plan, all lengths in fixed thousandths");
  json(remnantPlan);
  console.log(`lengths render as: 1200 => ${formatLength(1200000)}, 187.5 => ${formatLength(187500)}`);
}

main().catch((e) => {
  console.error(JSON.stringify({ error: { code: e.code ?? "CLI_ERROR", message: e.message, details: e.details } }));
  process.exitCode = 1;
});

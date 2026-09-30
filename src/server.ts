import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { openDatabase } from "./db.js";
import { AppError } from "./errors.js";
import { StockService } from "./service.js";

export function createApp(dbPath = resolve("data/app.db")) {
  const db = openDatabase(dbPath);
  const service = new StockService(db);

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const segments = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";
      const body = method === "POST" || method === "PUT" ? await readJson(req) : undefined;
      const page = url.searchParams.get("page") ?? 1;
      const pageSize = url.searchParams.get("pageSize") ?? 20;

      if (method === "GET" && segments.length === 1 && segments[0] === "health") return sendJson(res, 200, { ok: true });
      if (method === "POST" && segments.length === 1 && segments[0] === "materials") return sendJson(res, 201, service.createMaterial(body));
      if (method === "GET" && segments.length === 1 && segments[0] === "materials") return sendJson(res, 200, service.list("materials", page, pageSize));
      if (method === "POST" && segments.length === 1 && segments[0] === "bars") return sendJson(res, 201, service.registerBar(body));
      if (method === "GET" && segments.length === 1 && segments[0] === "bars") return sendJson(res, 200, service.list("stock_bars", page, pageSize));
      if (method === "POST" && segments.length === 1 && segments[0] === "orders") return sendJson(res, 201, service.createOrder(body));
      if (method === "GET" && segments.length === 1 && segments[0] === "orders") return sendJson(res, 200, service.list("orders", page, pageSize));
      if (method === "GET" && segments.length === 1 && segments[0] === "plans") return sendJson(res, 200, service.list("plans", page, pageSize));
      if (method === "GET" && segments.length === 1 && segments[0] === "cuts") return sendJson(res, 200, service.list("cuts", page, pageSize));
      if (method === "GET" && segments.length === 1 && segments[0] === "settings") return sendJson(res, 200, service.settings());
      if (method === "PUT" && segments.length === 1 && segments[0] === "settings") return sendJson(res, 200, service.updateSettings(body));

      if (method === "GET" && segments.length === 2 && segments[0] === "orders") return sendJson(res, 200, service.getOrder(segments[1]));
      if (method === "GET" && segments.length === 3 && segments[0] === "orders" && segments[2] === "unmet")
        return sendJson(res, 200, { items: service.explain(segments[1]) });
      if (method === "POST" && segments.length === 3 && segments[0] === "orders" && segments[2] === "solve")
        return sendJson(res, 201, service.solve(segments[1]));
      if (method === "GET" && segments.length === 2 && segments[0] === "plans") return sendJson(res, 200, service.getPlan(Number(segments[1])));
      if (method === "POST" && segments.length === 3 && segments[0] === "plans" && segments[2] === "reserve")
        return sendJson(res, 200, service.reservePlan(Number(segments[1])));
      if (method === "POST" && segments.length === 3 && segments[0] === "plans" && segments[2] === "release")
        return sendJson(res, 200, service.releasePlan(Number(segments[1])));
      const confirm = /^plans\/(\d+)\/bars\/(\d+)\/confirm$/.exec(segments.join("/"));
      if (method === "POST" && confirm) {
        const requestBody = (body ?? {}) as { idempotencyKey?: unknown };
        const key = typeof requestBody.idempotencyKey === "string" ? requestBody.idempotencyKey : `bar-${confirm[1]}-${confirm[2]}`;
        return sendJson(res, 200, service.confirmPlanBar(Number(confirm[1]), Number(confirm[2]), key));
      }

      sendJson(res, 404, { error: { code: "NOT_FOUND", message: "route not found" } });
    } catch (e) {
      if (e instanceof RangeError) {
        return sendJson(res, 400, { error: { code: "INVALID_PARAMETER", message: e.message } });
      }
      const error = e as AppError & { status?: number; code?: string };
      const status = error.status ?? (error.code ? 400 : 500);
      sendJson(res, status, { error: { code: error.code ?? "INTERNAL", message: error.message, details: error.details } });
    }
  });

  return { server, db, service };
}

export function startServer(dbPath = resolve("data/app.db"), portFile = resolve("data/server.json")): Promise<{ server: Server; port: number }> {
  const { server } = createApp(dbPath);
  return new Promise((ready) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("failed to bind local port");
      mkdirSync(dirname(portFile), { recursive: true });
      writeFileSync(portFile, JSON.stringify({ port: address.port, pid: process.pid, url: `http://127.0.0.1:${address.port}` }, null, 2));
      console.log(`listening on http://127.0.0.1:${address.port}`);
      ready({ server, port: address.port });
    });
  });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try { return JSON.parse(raw); } catch {
    const e = new AppError("INVALID_JSON", "request body must be valid JSON", 400);
    throw e;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("/dist/server.js")) {
  startServer().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

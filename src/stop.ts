import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const portFile = resolve("data/server.json");
if (existsSync(portFile)) {
  const info = JSON.parse(readFileSync(portFile, "utf8")) as { pid?: number };
  if (info.pid && process.pid !== info.pid) {
    try { process.kill(info.pid); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
    }
  }
  rmSync(portFile, { force: true });
  console.log("local API process stopped");
} else {
  console.log("no local API process is registered");
}

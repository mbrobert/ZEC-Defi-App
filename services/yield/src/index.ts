/**
 * Boot the yield API. `npm run dev` (tsx) or `npm start` (built).
 * Reads .env-style config from the process environment — pair with
 * `node --env-file=.env` or a shell `set -a; . ./.env; set +a`.
 */

import { redactUrl } from "@zyo/shared";
import { loadConfig } from "./config.js";
import { YieldServer } from "./server.js";

const cfg = loadConfig();
const server = new YieldServer(cfg);

const httpServer = await server.start();
console.log(
  `oilskin yield api listening on :${cfg.port} — /healthz /v1/pools /v1/rates /v1/band`
);
// dataDir is logged RESOLVED so an env-relative YIELD_DATA_DIR mismatch is
// visible at startup; RPC URLs are logged as HOST ONLY (keys live in paths).
console.log(`data dir: ${cfg.dataDir}`);
console.log(
  `sources: gecko(live) rhea(${cfg.rheaLendingContract} @ ${redactUrl(cfg.nearRpcUrl)}) ` +
    `gauges(${cfg.baseRpcUrl ? redactUrl(cfg.baseRpcUrl) : cfg.blockscoutKey ? "blockscout-gateway" : "disabled — set BASE_RPC_URL"}) ` +
    `bands(${cfg.dataDir}/bands.json)`
);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.stop();
    httpServer.close(() => process.exit(0));
  });
}

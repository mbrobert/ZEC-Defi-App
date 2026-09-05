/**
 * Boot the yield API. `npm run dev` (tsx) or `npm start` (built).
 * Reads .env-style config from the process environment — pair with
 * `node --env-file=.env` or a shell `set -a; . ./.env; set +a`.
 */

import { AAVE_V3 } from "@zyo/shared";
import { loadConfig } from "./config.js";
import { YieldServer } from "./server.js";

const cfg = loadConfig();
const server = new YieldServer(cfg);

const httpServer = await server.start();
console.log(
  `oilskin yield api listening on :${cfg.port} — /healthz /v1/pools /v1/rates /v1/gate /v1/band`
);
console.log(
  `sources: gecko(live) aave(${AAVE_V3.poolDataProvider}) gauges(${cfg.baseRpcUrl ? "rpc" : cfg.blockscoutKey ? "blockscout" : "OFF — set BASE_RPC_URL"}) bands(${cfg.dataDir}/bands.json)`
);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.stop();
    httpServer.close(() => process.exit(0));
  });
}

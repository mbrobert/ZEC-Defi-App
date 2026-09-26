import { runPerpsKeeper } from "./keeper.js";

/** Perps keeper daemon entrypoint (`npm run dev:perps -w @zyo/agent`). Everything lives in keeper.ts. */
runPerpsKeeper(process.env).catch((err) => {
  process.stderr.write(`[keeper-perps] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

import { runKeeper } from "./keeper.js";

/**
 * Keeper daemon entrypoint. Everything lives in keeper.ts so the real-process
 * liveness test can spawn exactly this file.
 */
runKeeper(process.env).catch((err) => {
  // Config/store errors are the only things that reach here; both are
  // already redacted by construction (ConfigError never echoes secrets).
  process.stderr.write(`[keeper] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

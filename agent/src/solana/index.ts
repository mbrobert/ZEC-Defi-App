import { runSolanaKeeper } from "./keeper.js";

/** Solana keeper daemon entrypoint (`npm run dev:solana -w @zyo/agent`). Everything lives in keeper.ts. */
runSolanaKeeper(process.env).catch((err) => {
  process.stderr.write(`[keeper-solana] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

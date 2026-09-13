#!/usr/bin/env node
/**
 * sepolia-feed-policy — the per-feed staleness bounds the keeper WILL derive on Base Sepolia,
 * computed by the keeper's own code (`agent/src/engine/feeds.ts` `buildFeedPolicies`, the
 * function the daemon runs at startup) against the live aggregators. Read-only: one
 * `latestRoundData` and `rounds − 1` `getRoundData` calls per feed, nothing else.
 *
 * Why a script: the keeper cannot start on Sepolia until a factory and a router exist there
 * (`docs/DEPLOYMENTS.md`), but the bounds it will enforce depend only on the feeds, which are live
 * today — so the rehearsal checklist can carry the numbers before the deploy, and the founder can
 * compare them with the keeper's own startup log line afterwards.
 *
 *   node scripts/sepolia-feed-policy.mjs                      # chain 84532, https://sepolia.base.org
 *   RPC_URL=<url> CHAIN_ID=8453 node scripts/sepolia-feed-policy.mjs   # any supported chain
 *
 * Needs `npm run build -w @zyo/shared -w @zyo/agent` (it imports both dists). The rule, as the
 * keeper applies it: bound = max(ceil(max observed gap × FEED_HEARTBEAT_SLACK), FEED_MIN_MAX_AGE_S),
 * over as many rounds as it takes to span FEED_HEARTBEAT_WINDOW_S, capped at FEED_HEARTBEAT_ROUNDS;
 * a walk that never spans the window is reported `probe-short` and takes the fallback instead
 * (finding FEED-MED-1). PRICE_MAX_AGE_S is the fallback for a feed that cannot be walked;
 * PRICE_MAX_AGE_S_<SYMBOL> overrides. Defaults are the keeper's `CONFIG_DEFAULTS`.
 */
import { createPublicClient, http } from "viem";
import { chainTable, resolveTokens } from "@zyo/shared";

const agent = (p) => new URL(`../agent/dist/src/${p}`, import.meta.url).href;
const { buildFeedPolicies } = await import(agent("engine/feeds.js"));
const { AaveReader, aaveAddressesFor, reserveSpecsFor } = await import(agent("services/chain.js"));
const { CONFIG_DEFAULTS } = await import(agent("config.js"));

const chainId = Number(process.env.CHAIN_ID ?? "84532");
const chain = chainTable(chainId);
const rpcUrl = process.env.RPC_URL ?? chain.rpcDefault;
// The feeds do not depend on the cbZEC / AERO doubles; on a chain that needs them, use the
// deployed ones when given and a zero placeholder otherwise (said so in the output).
const ZERO = "0x0000000000000000000000000000000000000000";
const overrides = chain.tokens.cbZEC ? {} : { cbZEC: process.env.CBZEC_ADDRESS || ZERO, AERO: process.env.AERO_ADDRESS || ZERO };
const tokens = resolveTokens(chain, overrides, (s) => `${s.toUpperCase()}_ADDRESS`);
const specs = reserveSpecsFor(chain, tokens);

const num = (name, fallback) => (process.env[name] ? Number(process.env[name]) : fallback);
const opts = {
  fallbackMaxAgeS: num("PRICE_MAX_AGE_S", CONFIG_DEFAULTS.priceMaxAgeS),
  minMaxAgeS: num("FEED_MIN_MAX_AGE_S", CONFIG_DEFAULTS.feedMinMaxAgeS),
  slack: num("FEED_HEARTBEAT_SLACK", CONFIG_DEFAULTS.feedHeartbeatSlack),
  rounds: num("FEED_HEARTBEAT_ROUNDS", CONFIG_DEFAULTS.feedHeartbeatRounds),
  minWindowS: num("FEED_HEARTBEAT_WINDOW_S", CONFIG_DEFAULTS.feedHeartbeatWindowS),
  overrides: Object.fromEntries(
    Object.keys(process.env)
      .filter((k) => /^PRICE_MAX_AGE_S_[A-Z0-9]+$/.test(k))
      .map((k) => [k.slice("PRICE_MAX_AGE_S_".length), Number(process.env[k])])
  ),
};

const client = createPublicClient({ transport: http(rpcUrl, { timeout: 15_000, retryCount: 1 }) });
const reader = new AaveReader(client, aaveAddressesFor(chain), specs, { deadlineMs: 15_000 });
const liveChain = await reader.chainId();
if (liveChain !== chainId) {
  console.error(`RPC reports chain ${liveChain}, expected ${chainId}`);
  process.exit(1);
}
const head = await reader.head();
const rows = await buildFeedPolicies(reader, specs, head.timestamp, opts);

console.log(
  `feed policies the keeper derives on ${chain.name} (${chainId}) at block ${head.number} ` +
    `(${new Date(Number(head.timestamp) * 1000).toISOString()}) — window ${opts.minWindowS} s, round cap ${opts.rounds}, slack ×${opts.slack}, ` +
    `floor ${opts.minMaxAgeS} s, fallback ${opts.fallbackMaxAgeS} s`
);
if (!chain.tokens.cbZEC && (!process.env.CBZEC_ADDRESS || !process.env.AERO_ADDRESS)) {
  console.log("(cbZEC / AERO doubles not given — placeholders used; they play no part in the feed bounds)");
}
console.log("| symbol | feed | max gap (s) | window covered (s) | rounds read | bound enforced (s) | source | round age at read (s) | stale now |");
console.log("|---|---|---|---|---|---|---|---|---|");
for (const r of rows) {
  console.log(
    `| ${r.symbol} | ${r.feed ?? "—"} | ${r.observedHeartbeatS ?? "—"} | ${r.windowCoveredS ?? "—"} | ${r.windowRounds} | ${r.maxAgeS} | ${r.source} | ${r.ageS ?? "—"} | ${r.staleNow ? "YES" : "no"} |`
  );
}
const short = rows.filter((r) => r.source === "probe-short");
if (short.length) {
  console.log(
    `\nNOTE: ${short.map((r) => r.symbol).join(", ")} could not be walked far enough to span the window, so the ` +
      "heartbeat was never observed and the fallback applies. Set PRICE_MAX_AGE_S_<SYMBOL> deliberately, or raise the cap."
  );
}
const stale = rows.filter((r) => r.staleNow);
if (stale.length) {
  console.log(`\nNOTE: ${stale.map((r) => r.symbol).join(", ")} already older than the bound at this read — the keeper's self-check would report it.`);
}

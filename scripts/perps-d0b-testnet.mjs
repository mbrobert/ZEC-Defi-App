#!/usr/bin/env node
/**
 * perps-d0b-testnet — the D0b gate of `docs/PERPS-DESIGN-2026-09-25.md` §2, as a script the FOUNDER runs
 * against Hyperliquid's TESTNET (HyperEVM chain 998) with a throwaway key. It proves, one real action at a
 * time, the facts the perps code still takes from a document, and records every raw byte it sends and reads
 * in `docs/research/perps-d0b-testnet-<date>.json` for the facts file's next addendum.
 *
 *   PERPS_D0B_PRIVATE_KEY=0x… node scripts/perps-d0b-testnet.mjs [--steps read,fund,order,class,send] [--size 0.10] [--to 0x…]
 *
 * What it proves (design §2 items):
 *   read   — the testnet ZEC index and its perpAssetInfo; the key's Core existence, spot and perp balances (no signature)
 *   fund   — item 3/4: Circle testnet USDC → the adapter's `deposit(amount, uint32.max)` → the key's Core SPOT balance,
 *            and `deposit(amount, 0)` → the perp balance (which dex `uint32.max` really is)
 *   order  — item 1: one IOC sell of `--size` ZEC through CoreWriter action 1 with the DOCUMENTED bytes, the fill read back
 *            through precompile 0x800 (sign of szi, the fresh account's leverage — item 4), then a reduce-only IOC buy that closes it
 *   class  — item 4: action 7 `usdClassTransfer(ntl, toPerp)` and what unit `ntl` is (10^6 or 10^8), read from 0x801 / 0x80f
 *   send   — action 13 from the key's Core spot to the system address, and whether Circle USDC comes back on the EVM side
 *   --to   — item 3: `sendAsset` 1 USDC to a CONTRACT address (a deployed account, say) and whether HyperCore credits it
 *
 * What it cannot prove: item 6 (what a liquidation leaves) — that needs a position to be liquidated and read back by hand.
 *
 * Rules it keeps (CLAUDE.md): it refuses any chain but 998; it reads its key from the environment and never prints it; it
 * never touches mainnet. Every number it prints is a read, dated, with the block. CLAUDE.md rule 1 means the author of this
 * script has NOT run it — the first run is the founder's, and its JSON is the primary source the code then depends on.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, parseAbi, encodeFunctionData, decodeEventLog, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  CORE_PERP_DEX,
  CORE_SPOT_DEX,
  CORE_TIF,
  HYPERCORE_PRECOMPILES,
  HYPERLIQUID,
  decodeAccountMarginSummary,
  decodeCoreUserExists,
  decodePerpAssetInfo,
  decodePosition,
  decodePx,
  decodeSpotBalance,
  decodeTokenInfo,
  encodeLimitOrder,
  encodePrecompileInput,
  encodeSendAsset,
  encodeUsdClassTransfer,
  formatUnits,
  parseDecimalToUnits,
} from "@zyo/shared";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

// ---------------------------------------------------------------- arguments

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const STEPS = flag("steps", "read,fund,order,class,send").split(",");
const SIZE = flag("size", "0.10"); // ZEC, human
const TO = flag("to", null);
const RPC = process.env.HYPERLIQUID_TESTNET_RPC ?? HYPERLIQUID.testnet.rpc;
// Hyperliquid's HyperEVM page (read 2026-09-25) names the testnet RPC but NOT the testnet info API; this default is the
// mainnet URL's testnet twin and is VERIFIED below by fetching `meta` and finding ZEC in it, or the script stops.
const API = process.env.HYPERLIQUID_TESTNET_API ?? "https://api.hyperliquid-testnet.xyz/info";
const KEY = process.env.PERPS_D0B_PRIVATE_KEY;
if (!KEY) {
  console.error("Set PERPS_D0B_PRIVATE_KEY to a THROWAWAY testnet key (never a mainnet key). Nothing was sent.");
  process.exit(2);
}

const account = privateKeyToAccount(KEY);
const chain = { id: HYPERLIQUID.testnet.chainId, name: "HyperEVM testnet", nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = createWalletClient({ account, chain, transport: http(RPC) });

const outPath = join(repoRoot, "docs", "research", `perps-d0b-testnet-${new Date().toISOString().slice(0, 10)}.json`);
const records = existsSync(outPath) ? JSON.parse(readFileSync(outPath, "utf8")) : { how: "scripts/perps-d0b-testnet.mjs against HyperEVM testnet (chain 998); every value is a read or a receipt, dated", key: account.address, steps: [] };
const record = (step, data) => {
  const row = { step, atIso: new Date().toISOString(), ...data };
  records.steps.push(row);
  writeFileSync(outPath, JSON.stringify(records, (_, v) => (typeof v === "bigint" ? v.toString() : v), 1) + "\n");
  console.log(`\n[${step}] ${JSON.stringify(row, (_, v) => (typeof v === "bigint" ? v.toString() : v), 1)}`);
};

const info = async (body) => {
  const r = await fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${API} ${r.status} for ${JSON.stringify(body)}`);
  return r.json();
};
const call = async (to, data) => pub.call({ to, data }).then((r) => r.data);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function decimals() view returns (uint8)", "function symbol() view returns (string)"]);
const adapterAbi = parseAbi(["function deposit(uint256 amount, uint32 destinationDex)", "function token() view returns (address)", "function paused() view returns (bool)"]);
const coreWriterAbi = parseAbi(["function sendRawAction(bytes data)", "event RawAction(address indexed user, bytes data)"]);

/** Send one transaction, wait for the receipt, return it with the RawAction data CoreWriter logged (if any). */
async function send(label, to, data, value = 0n) {
  const hash = await wallet.sendTransaction({ to, data, value });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  const rawActions = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== HYPERLIQUID.coreWriter.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: coreWriterAbi, data: log.data, topics: log.topics });
      rawActions.push({ user: ev.args.user, data: ev.args.data });
    } catch {
      rawActions.push({ raw: log.data });
    }
  }
  return { label, hash, block: Number(receipt.blockNumber), status: receipt.status, gasUsed: receipt.gasUsed, rawActions };
}

async function coreState(user, perpIndex) {
  const block = await pub.getBlockNumber();
  const [exists, spot, summary, pos] = await Promise.all([
    call(HYPERCORE_PRECOMPILES.coreUserExists, encodePrecompileInput.coreUserExists(user)),
    call(HYPERCORE_PRECOMPILES.spotBalance, encodePrecompileInput.spotBalance(user, HYPERLIQUID.usdc.tokenIndex)),
    call(HYPERCORE_PRECOMPILES.accountMarginSummary, encodePrecompileInput.accountMarginSummary(CORE_PERP_DEX, user)),
    call(HYPERCORE_PRECOMPILES.position, encodePrecompileInput.position(user, perpIndex)),
  ]);
  return {
    block: Number(block),
    coreUserExists: exists ? decodeCoreUserExists(exists) : null,
    spotRaw: spot,
    spot: spot ? decodeSpotBalance(spot) : null,
    summaryRaw: summary,
    summary: summary ? decodeAccountMarginSummary(summary) : null,
    positionRaw: pos,
    position: pos ? decodePosition(pos) : null,
  };
}

// ---------------------------------------------------------------- 0 · the chain and the market

const chainId = await pub.getChainId();
if (chainId !== HYPERLIQUID.testnet.chainId) {
  console.error(`RPC ${RPC} is chain ${chainId}, not ${HYPERLIQUID.testnet.chainId}. This script runs on TESTNET only. Nothing was sent.`);
  process.exit(2);
}
const meta = await info({ type: "meta" });
const zecIndex = meta.universe.findIndex((u) => u.name === "ZEC");
if (zecIndex < 0) {
  console.error(`${API} answered meta without a ZEC perp — is this the testnet info API? Nothing was sent.`);
  process.exit(2);
}
const zecMeta = meta.universe[zecIndex];
const ctxs = await info({ type: "metaAndAssetCtxs" });
const zecCtx = ctxs[1][zecIndex];
const spotMeta = await info({ type: "spotMeta" });
const usdcToken = spotMeta.tokens.find((t) => t.index === 0);
const assetInfoRaw = await call(HYPERCORE_PRECOMPILES.perpAssetInfo, encodePrecompileInput.perpAssetInfo(zecIndex));
const tokenInfoRaw = await call(HYPERCORE_PRECOMPILES.tokenInfo, encodePrecompileInput.tokenInfo(0));
const markRaw = await call(HYPERCORE_PRECOMPILES.markPx, encodePrecompileInput.px(zecIndex));
const hype = await pub.getBalance({ address: account.address });
record("market", {
  rpc: RPC,
  api: API,
  chainId,
  block: Number(await pub.getBlockNumber()),
  zecIndexOnTestnet: zecIndex,
  zecMeta,
  zecCtx,
  perpAssetInfoRaw: assetInfoRaw,
  perpAssetInfo: assetInfoRaw ? decodePerpAssetInfo(assetInfoRaw) : null,
  usdcTokenOnTestnet: usdcToken,
  tokenInfoRaw,
  tokenInfo: tokenInfoRaw ? decodeTokenInfo(tokenInfoRaw) : null,
  markRaw,
  mark: markRaw ? formatUnits(decodePx(markRaw), 6 - zecMeta.szDecimals) : null,
  keyHypeBalanceWei: hype,
  note: "zecIndex on testnet may differ from mainnet's 214; every later step uses the testnet index. HYPE is the gas token: a zero balance stops here.",
});
if (hype === 0n) {
  console.error("The key holds no testnet HYPE for gas. Fund it from Hyperliquid's testnet faucet, then re-run. Nothing was sent.");
  process.exit(2);
}
const adapterAddress = usdcToken?.evmContract?.address ? getAddress(usdcToken.evmContract.address) : null;
const circleUsdc = HYPERLIQUID.usdc.circleUsdcTestnet;
const pxDecimals = 6 - zecMeta.szDecimals;
const before = await coreState(account.address, zecIndex);
record("read", { ...before, note: "the key's HyperCore state before anything is sent (design §2 read-only)" });

// ---------------------------------------------------------------- fund · item 3/4

if (STEPS.includes("fund")) {
  if (!adapterAddress) {
    record("fund", { skipped: true, reason: "testnet spotMeta names no evmContract for token 0 — no adapter to deposit through; fund the Core balance from the testnet faucet instead" });
  } else {
    const [sym, dec, bal] = await Promise.all([
      pub.readContract({ address: circleUsdc, abi: erc20, functionName: "symbol" }),
      pub.readContract({ address: circleUsdc, abi: erc20, functionName: "decimals" }),
      pub.readContract({ address: circleUsdc, abi: erc20, functionName: "balanceOf", args: [account.address] }),
    ]);
    const adapterToken = await pub.readContract({ address: adapterAddress, abi: adapterAbi, functionName: "token" }).catch(() => null);
    record("fund.before", { circleUsdc, symbol: sym, decimals: dec, keyBalance: bal, adapter: adapterAddress, adapterToken, note: "adapterToken should equal circleUsdc; if not, the adapter is linked to another token and `fund` must not run" });
    if (adapterToken && adapterToken.toLowerCase() !== circleUsdc.toLowerCase()) {
      record("fund", { skipped: true, reason: `adapter.token() is ${adapterToken}, not Circle's testnet USDC` });
    } else if (bal < 2n * 10n ** BigInt(dec)) {
      record("fund", { skipped: true, reason: `the key holds ${formatUnits(bal, dec)} USDC; at least 2 are needed (Circle's testnet faucet: faucet.circle.com)` });
    } else {
      const one = 10n ** BigInt(dec);
      const approve = await send("approve", circleUsdc, encodeFunctionData({ abi: erc20, functionName: "approve", args: [adapterAddress, 2n * one] }));
      const toSpot = await send("deposit(1, uint32.max)", adapterAddress, encodeFunctionData({ abi: adapterAbi, functionName: "deposit", args: [one, CORE_SPOT_DEX] }));
      await sleep(12_000);
      const afterSpot = await coreState(account.address, zecIndex);
      const toPerp = await send("deposit(1, 0)", adapterAddress, encodeFunctionData({ abi: adapterAbi, functionName: "deposit", args: [one, CORE_PERP_DEX] }));
      await sleep(12_000);
      const afterPerp = await coreState(account.address, zecIndex);
      record("fund", {
        approve,
        toSpot,
        afterSpot,
        toPerp,
        afterPerp,
        verdict: {
          spotGrewByOneUsdcInWei: afterSpot.spot && before.spot ? (afterSpot.spot.total - before.spot.total).toString() : null,
          perpGrewByOneUsdcE6: afterPerp.summary && afterSpot.summary ? (afterPerp.summary.accountValue - afterSpot.summary.accountValue).toString() : null,
          coreUserExistsAfter: afterPerp.coreUserExists,
        },
        note: "spot should grow by 100,000,000 wei (10^8) and the perp account value by 1,000,000 (10^6) if the two dex conventions are what the code assumes",
      });
    }
  }
}

// ---------------------------------------------------------------- order · item 1 (and item 4's default leverage)

if (STEPS.includes("order")) {
  const state = await coreState(account.address, zecIndex);
  const mark = decodePx(await call(HYPERCORE_PRECOMPILES.markPx, encodePrecompileInput.px(zecIndex)));
  const szE8 = parseDecimalToUnits(SIZE, 8);
  const szRaw = parseDecimalToUnits(SIZE, zecMeta.szDecimals);
  const markE8 = mark * 10n ** BigInt(8 - pxDecimals);
  const sellPx = (markE8 * 9_950n) / 10_000n; // half a percent under the mark: an IOC sell that should fill
  const notionalE6 = szRaw * mark * 10n ** BigInt(6 - zecMeta.szDecimals - pxDecimals);
  if (!state.summary || state.summary.accountValue < notionalE6 / 5n) {
    record("order", { skipped: true, reason: `perp account value ${state.summary?.accountValue} is under a fifth of the notional ${notionalE6} — fund the perp balance first (step fund)` });
  } else if (state.position && state.position.szi !== 0n) {
    record("order", { skipped: true, reason: `the key already holds a ZEC position (szi ${state.position.szi}); close it by hand first` });
  } else {
    const openBytes = encodeLimitOrder({ asset: zecIndex, isBuy: false, limitPxE8: sellPx, szE8, reduceOnly: false, tif: CORE_TIF.ioc });
    const open = await send("limit order (sell IOC)", HYPERLIQUID.coreWriter, encodeFunctionData({ abi: coreWriterAbi, functionName: "sendRawAction", args: [openBytes] }));
    await sleep(12_000);
    const afterOpen = await coreState(account.address, zecIndex);
    const fills = await info({ type: "userFills", user: account.address }).catch(() => null);
    const filled = afterOpen.position && afterOpen.position.szi !== 0n;
    let close = null;
    let afterClose = null;
    if (filled) {
      const mark2 = decodePx(await call(HYPERCORE_PRECOMPILES.markPx, encodePrecompileInput.px(zecIndex)));
      const buyPx = (mark2 * 10n ** BigInt(8 - pxDecimals) * 10_050n) / 10_000n;
      const size = -afterOpen.position.szi;
      const closeBytes = encodeLimitOrder({ asset: zecIndex, isBuy: true, limitPxE8: buyPx, szE8: size * 10n ** BigInt(8 - zecMeta.szDecimals), reduceOnly: true, tif: CORE_TIF.ioc });
      close = await send("limit order (buy IOC reduce-only)", HYPERLIQUID.coreWriter, encodeFunctionData({ abi: coreWriterAbi, functionName: "sendRawAction", args: [closeBytes] }));
      close.bytes = closeBytes;
      await sleep(12_000);
      afterClose = await coreState(account.address, zecIndex);
    }
    record("order", {
      markRaw: mark,
      sellPxE8: sellPx,
      szE8,
      szRaw,
      openBytes,
      open,
      afterOpen,
      recentFills: Array.isArray(fills) ? fills.slice(0, 3) : fills,
      close,
      afterClose,
      verdict: {
        actionAccepted: filled,
        sziSignForShort: afterOpen.position ? (afterOpen.position.szi < 0n ? "negative" : afterOpen.position.szi === 0n ? "no position (IOC did not fill, or the bytes were refused)" : "POSITIVE — a buy, the isBuy flag is inverted") : null,
        sizeMatches: afterOpen.position ? (-afterOpen.position.szi === szRaw) : null,
        freshAccountLeverage: afterOpen.position?.leverage ?? null,
        isIsolated: afterOpen.position?.isIsolated ?? null,
        closed: afterClose ? afterClose.position?.szi === 0n : null,
      },
      note: "item 1: the documented action-1 bytes are proven if the position appears with a negative szi of the sent size; item 4: `freshAccountLeverage` is what a new account carries at its first order (10 = the max, else the initial-margin check binds earlier than design §4 assumes)",
    });
  }
}

// ---------------------------------------------------------------- class · item 4 (action 7's `ntl` unit)

if (STEPS.includes("class")) {
  const state = await coreState(account.address, zecIndex);
  if (!state.summary || state.summary.accountValue < 1_000_000n) {
    record("class", { skipped: true, reason: "the perp balance is under 1 USDC; fund it first" });
  } else {
    // send `ntl = 1_000_000` perp → spot: if ntl is 10^6 the spot grows by 10^8 wei (1 USDC); if ntl is 10^8 it grows by 10^6 wei (0.01 USDC)
    const bytes = encodeUsdClassTransfer(1_000_000n, false);
    const tx = await send("usdClassTransfer(1_000_000, toPerp=false)", HYPERLIQUID.coreWriter, encodeFunctionData({ abi: coreWriterAbi, functionName: "sendRawAction", args: [bytes] }));
    await sleep(12_000);
    const after = await coreState(account.address, zecIndex);
    const spotDelta = after.spot && state.spot ? after.spot.total - state.spot.total : null;
    const back = await send("usdClassTransfer(1_000_000, toPerp=true)", HYPERLIQUID.coreWriter, encodeFunctionData({ abi: coreWriterAbi, functionName: "sendRawAction", args: [encodeUsdClassTransfer(1_000_000n, true)] }));
    await sleep(12_000);
    const afterBack = await coreState(account.address, zecIndex);
    record("class", {
      bytes,
      tx,
      after,
      back,
      afterBack,
      verdict: {
        spotDeltaWei: spotDelta,
        ntlUnit: spotDelta === 100_000_000n ? "10^6 (the code's assumption holds)" : spotDelta === 1_000_000n ? "10^8 — the venue and the keeper must scale ntl by 100" : spotDelta === 0n || spotDelta === null ? "no movement: the action was refused or its bytes are wrong" : `unexpected delta ${spotDelta}`,
        perpRestored: afterBack.summary && state.summary ? (afterBack.summary.accountValue - state.summary.accountValue).toString() : null,
      },
    });
  }
}

// ---------------------------------------------------------------- send · action 13 spot → EVM

if (STEPS.includes("send")) {
  const state = await coreState(account.address, zecIndex);
  const evmBefore = await pub.readContract({ address: circleUsdc, abi: erc20, functionName: "balanceOf", args: [account.address] }).catch(() => null);
  if (!state.spot || state.spot.total < 100_000_000n) {
    record("send", { skipped: true, reason: "the Core spot balance is under 1 USDC" });
  } else {
    const bytes = encodeSendAsset({ destination: HYPERLIQUID.usdc.systemAddress, sourceDex: CORE_SPOT_DEX, destinationDex: CORE_SPOT_DEX, token: HYPERLIQUID.usdc.tokenIndex, wei: 100_000_000n });
    const tx = await send("sendAsset(system, SPOT, SPOT, 0, 1 USDC)", HYPERLIQUID.coreWriter, encodeFunctionData({ abi: coreWriterAbi, functionName: "sendRawAction", args: [bytes] }));
    await sleep(15_000);
    const after = await coreState(account.address, zecIndex);
    const evmAfter = await pub.readContract({ address: circleUsdc, abi: erc20, functionName: "balanceOf", args: [account.address] }).catch(() => null);
    record("send", {
      bytes,
      tx,
      after,
      evmBefore,
      evmAfter,
      verdict: {
        spotDeltaWei: after.spot && state.spot ? (after.spot.total - state.spot.total).toString() : null,
        evmDeltaE6: evmAfter !== null && evmBefore !== null ? (evmAfter - evmBefore).toString() : null,
        note: "the Core spot should fall by 10^8 wei and the EVM balance rise by 10^6 (1 USDC) if action 13 to the system address is the HyperCore → HyperEVM path for USDC",
      },
    });
  }
}

// ---------------------------------------------------------------- --to · item 3 (a CONTRACT address as a Core user)

if (TO) {
  const to = getAddress(TO);
  const code = await pub.getBytecode({ address: to });
  const tBefore = await coreState(to, zecIndex);
  const state = await coreState(account.address, zecIndex);
  if (!state.spot || state.spot.total < 100_000_000n) {
    record("to", { skipped: true, reason: "the key's Core spot balance is under 1 USDC" });
  } else {
    const bytes = encodeSendAsset({ destination: to, sourceDex: CORE_SPOT_DEX, destinationDex: CORE_SPOT_DEX, token: HYPERLIQUID.usdc.tokenIndex, wei: 100_000_000n });
    const tx = await send(`sendAsset(${to}, SPOT, SPOT, 0, 1 USDC)`, HYPERLIQUID.coreWriter, encodeFunctionData({ abi: coreWriterAbi, functionName: "sendRawAction", args: [bytes] }));
    await sleep(15_000);
    const tAfter = await coreState(to, zecIndex);
    record("to", {
      to,
      isContract: !!code && code !== "0x",
      before: tBefore,
      bytes,
      tx,
      after: tAfter,
      verdict: {
        existedBefore: tBefore.coreUserExists,
        existsAfter: tAfter.coreUserExists,
        spotDeltaWei: tAfter.spot && tBefore.spot ? (tAfter.spot.total - tBefore.spot.total).toString() : null,
        note: "item 3: a contract that did not exist on HyperCore is credited (and now exists) — or is not, in which case the account needs a first funding step the design does not yet have",
      },
    });
  }
}

console.log(`\nRecorded to ${outPath}. Paste the file's path into the facts file's next addendum; every value above is a read or a receipt.`);

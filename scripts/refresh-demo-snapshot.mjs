#!/usr/bin/env node
/**
 * refresh-demo-snapshot — the demo's ONE chain read, refreshed as one command (slice M, 2026-09-13).
 *
 *   node scripts/refresh-demo-snapshot.mjs --rpc <url> --block <n|latest> [--sample-rpc <url>]
 *                                          [--force] [--redo-model] [--skip-levers]
 *
 * Read-only: `eth_call` / `eth_getBlockByNumber` through the yield service's client and `cast call
 * --block` through scripts/ledger-read.sh; no key, nothing signed. Everything the demo quotes is
 * derived from ONE pinned block, in this order, each step skipped when its output for that block
 * already exists (so a second run at the same block is a no-op; `--force` redoes every step):
 *
 *   1. the yield sample, pinned   `npm run backfill -w @zyo/yield -- sample --block N`
 *                                 → services/yield/samples/gauge-emissions-<date>.json
 *   2. the model                  `npm run model-inputs` + scripts/run-model.mjs on that sample
 *                                 → lp-model-<date>.json, MODEL-NUMBERS.md, mc-calibration.json;
 *                                 package.json's `model` script re-pointed at the sample
 *   3. the ledger read            scripts/ledger-read.sh <rpc> N, parsed
 *                                 → docs/research/ledger-read-<N>.json (every raw word)
 *   4. the USDC reserve read      → samples/aave-usdc-reserve-<date>.json from the SAME sample and
 *                                 ledger words (curve + totals), the forecast's liquidity picture
 *   5. the demo payloads          gen-demo-gate.mjs / gen-demo-forecast.mjs on those files
 *                                 → samples/demo-{gate,forecast}.json, mirrored to web/lib/
 *   6. docs/VERIFIED-BASE-FACTS.md's top ledger — the tables the snapshot tests parse — with the
 *                                 read it replaces kept as the drift column
 *   7. web/lib/demo.ts (DEMO_SNAPSHOT_AT / _BLOCK, DEMO_CBZEC_PRICE_USDC from slot0's tick,
 *                                 DEMO_MARKET at the service's 4-dp truncation, the USDC liquidity)
 *                                 and the demo banner in web/lib/copy.ts
 *   8. both prototypes' OIL_CHAIN_READ (byte-equal) and, through prototype/scripts/gen-oil-model.mjs,
 *                                 their OIL_MODEL block
 *   9. the tester's-kit "disagreement band" levers, MEASURED by scanning each page's own gate()
 *                                 in Chromium (never guessed); the page button and its test move
 *                                 together when the old value fell out of the band
 *  10. docs/MODEL-NUMBERS-<date>.md (a copy of the generated report) and the superseded banner on
 *                                 the previous one; the dated sample names in the yield tests
 *  11. a printed drift table, old read → new read
 *
 * `--redo-model` keeps the block's sample (it must exist) and redoes everything from the model on —
 * for a change to scripts/lp-sim.py's report, or to the generators, without another GeckoTerminal
 * round. GeckoTerminal: the free tier blocks for ~15 min from the LAST attempt once tripped, and the
 * source's own four retries count, so the pace between pool requests defaults to 6 s
 * (GECKO_MIN_INTERVAL_MS overrides) and a refused run is retried only after that silence.
 *
 * Not done here, on purpose: the prose that judges the numbers (docs/RISKS.md §14, the CHANGELOG,
 * TESTING) and any test that typed a model figure instead of deriving it — those are read and
 * re-written by a person after the run, never softened by a script.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------------------------- args
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(`--${name}`);
const RPC = arg("rpc", "https://mainnet.base.org");
const SAMPLE_RPC = arg("sample-rpc", RPC);
const BLOCK_ARG = arg("block");
const FORCE = flag("force");
const REDO_MODEL = flag("redo-model");
const SKIP_LEVERS = flag("skip-levers");
if (!BLOCK_ARG) {
  console.error("usage: refresh-demo-snapshot.mjs --rpc <url> --block <n|latest> [--sample-rpc <url>] [--force] [--redo-model] [--skip-levers]");
  process.exit(2);
}

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const YIELD = join(REPO, "services/yield");
const SAMPLES = join(YIELD, "samples");
const RESEARCH = join(REPO, "docs/research");
const FACTS = join(REPO, "docs/VERIFIED-BASE-FACTS.md");
const DEMO_TS = join(REPO, "web/lib/demo.ts");
const COPY_TS = join(REPO, "web/lib/copy.ts");
const PAGES = ["prototype/simple.html", "prototype/index.html"].map((p) => join(REPO, p));
const PROTO_TESTS = { simple: join(REPO, "prototype/test/verify-simple.mjs"), advanced: join(REPO, "prototype/test/verify-advanced.mjs") };

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const writeJson = (p, o) => writeFileSync(p, JSON.stringify(o, null, 2) + "\n");
const log = (s) => console.log(`refresh: ${s}`);
const die = (s) => {
  console.error(`refresh: ${s}`);
  process.exit(1);
};
function run(cmd, args, opts = {}) {
  log(`$ ${cmd} ${args.join(" ")}${opts.cwd ? `  (in ${opts.cwd.replace(REPO, ".")})` : ""}`);
  const r = spawnSync(cmd, args, { stdio: opts.capture ? ["ignore", "pipe", "inherit"] : "inherit", cwd: opts.cwd ?? REPO, env: { ...process.env, ...(opts.env ?? {}) }, encoding: "utf8" });
  if (!(opts.okStatus ?? [0]).includes(r.status)) die(`${cmd} ${args[0]} exited ${r.status}`);
  if (r.status !== 0) log(`${cmd} ${args[0]} exited ${r.status} — accepted (${opts.okStatusMeans ?? "reported, not an error"})`);
  return r.stdout ?? "";
}

// --------------------------------------------------------------------------------------- formatting
const fmt = (n, dp) => Number(n).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
const fmtInt = (n) => fmt(n, 0);
const r2 = (x) => Math.round(x * 100) / 100;
const pct2 = (bps) => (bps / 100).toFixed(2) + "%";
const bonusPct = (word) => ((word - 10_000) / 100).toFixed(1) + "%";
/** ray → percent truncated at 1e-4, exactly `rayToPct` in services/yield/src/sources/aave.ts. */
const rayToPct = (ray) => Number((BigInt(ray) * 1_000_000n) / 10n ** 27n) / 10_000;
const iso = (unix) => new Date(unix * 1000).toISOString().replace(".000Z", "Z");
const human = (units, decimals) => Number(BigInt(units) / 10n ** BigInt(Math.max(0, decimals - 6))) / 10 ** Math.min(6, decimals);

// ------------------------------------------------------------------------------------------- rpc
async function rpcCall(url, method, params) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  if (!res.ok) throw new Error(`${method}: http ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

// ------------------------------------------------------------------------------- the ledger parser
/** scripts/ledger-read.sh's stdout → one JSON record of raw words (nothing derived that is not derivable back). */
function parseLedger(text) {
  const lines = text.split("\n");
  const first = lines[0].match(/^block (\d+) timestamp (\d+) \((\S+)\) chain (\d+)/);
  if (!first) throw new Error(`ledger: unexpected first line: ${lines[0]}`);
  const out = { block: Number(first[1]), timestamp: Number(first[2]), readAt: first[3], chainId: Number(first[4]), supplies: {}, aave: { reserves: {} }, chainlink: {}, pyth: null, pool: {}, gauge: {}, comet: {}, code: {} };
  const num = (s) => s.replace(/,/g, "");
  for (const l of lines) {
    let m;
    if ((m = l.match(/^(USDC|WETH|cbBTC|cbZEC|AERO) totalSupply (\d+)$/))) out.supplies[m[1]] = m[2];
    else if ((m = l.match(/^cbZEC multiplier (\d+)$/))) out.cbzecMultiplier = m[1];
    else if ((m = l.match(/^pool (0x\w+) dataProvider (0x\w+) oracle (0x\w+)$/))) out.aave.provider = { pool: m[1], dataProvider: m[2], oracle: m[3] };
    else if ((m = l.match(/^(cbBTC|WETH|USDC|cbZEC) config: (.*)$/))) {
      const w = m[2].trim().split(/\s+/);
      const r = (out.aave.reserves[m[1]] ??= {});
      if (w.length === 10 && !(m[1] === "cbZEC" && w[0] === "0")) Object.assign(r, { decimals: +w[0], ltvBps: +w[1], liquidationThresholdBps: +w[2], liquidationBonusWord: +w[3], reserveFactorBps: +w[4], usageAsCollateralEnabled: w[5] === "true", borrowingEnabled: w[6] === "true", stableBorrowEnabled: w[7] === "true", isActive: w[8] === "true", isFrozen: w[9] === "true" });
      else r.listed = false;
    } else if ((m = l.match(/^(cbBTC|WETH|USDC|cbZEC) data: (.*)$/))) {
      const w = m[2].trim().split(/\s+/).filter(Boolean);
      const r = (out.aave.reserves[m[1]] ??= {});
      if (w.length === 12) Object.assign(r, { listed: true, unbacked: w[0], accruedToTreasuryScaled: w[1], totalAToken: w[2], totalStableDebt: w[3], totalVariableDebt: w[4], liquidityRateRay: w[5], variableBorrowRateRay: w[6], liquidityIndexRay: w[9], variableBorrowIndexRay: w[10], lastUpdateTimestamp: +w[11] });
      else r.listed = false;
    } else if ((m = l.match(/^(cbBTC|WETH|USDC|cbZEC) paused: (true|false)?$/))) (out.aave.reserves[m[1]] ??= {}).isPaused = m[2] === "true";
    else if ((m = l.match(/^(BTC_USD|ETH_USD|USDC_USD|cbBTC_USD) (\d+) (-?\d+) (\d+) (\d+) (\d+)\s+desc="([^"]*)"$/))) out.chainlink[m[1]] = { roundId: m[2], answer: m[3], startedAt: +m[4], updatedAt: +m[5], answeredInRound: m[6], description: m[7] };
    else if ((m = l.match(/^\((-?\d+)(?: \[[^\]]*\])?, (\d+)(?: \[[^\]]*\])?, (-?\d+), (\d+)(?: \[[^\]]*\])?\)$/))) out.pyth = { price: m[1], conf: m[2], expo: +m[3], publishTime: +m[4] };
    else if ((m = l.match(/^slot0 (\d+) (-?\d+) (\d+) (\d+) (\d+) (true|false)/))) Object.assign(out.pool, { sqrtPriceX96: m[1], tick: +m[2], observationIndex: +m[3], observationCardinality: +m[4], observationCardinalityNext: +m[5], unlocked: m[6] === "true" });
    else if ((m = l.match(/^liquidity (\d+)$/))) out.pool.liquidity = m[1];
    else if ((m = l.match(/^fee (\d+)$/))) out.pool.fee = +m[1];
    else if ((m = l.match(/^gauge rewardRate (\d+) periodFinish (\d+)$/))) out.gauge = { rewardRate: m[1], periodFinish: +m[2] };
    else if ((m = l.match(/^(\d{15,})$/))) out.comet.utilization = m[1];
    else if ((m = l.match(/^(Morpho|Permit2|CoWSettlement|Pyth) (\d+)$/))) out.code[m[1]] = +m[2];
  }
  for (const k of ["USDC", "WETH", "cbBTC", "cbZEC", "AERO"]) if (!out.supplies[k]) throw new Error(`ledger: no totalSupply for ${k}`);
  for (const k of ["cbBTC", "WETH", "USDC"]) if (!out.aave.reserves[k]?.listed) throw new Error(`ledger: ${k} reserve not decoded`);
  for (const k of ["BTC_USD", "ETH_USD", "USDC_USD", "cbBTC_USD"]) if (!out.chainlink[k]) throw new Error(`ledger: no ${k} feed line`);
  if (!out.pyth || !out.pool.sqrtPriceX96 || !out.pool.liquidity || !out.gauge.rewardRate || !out.comet.utilization) throw new Error("ledger: pyth / pool / gauge / comet line missing");
  void num;
  return out;
}

/** The figures the docs and the snapshot carry, derived from one ledger record (nothing typed). */
function figures(L) {
  const res = (k) => {
    const r = L.aave.reserves[k];
    return { ltvBps: r.ltvBps, ltBps: r.liquidationThresholdBps, bonusWord: r.liquidationBonusWord, bonusBps: r.liquidationBonusWord - 10_000, borrowPct: rayToPct(r.variableBorrowRateRay), supplyPct: rayToPct(r.liquidityRateRay), paused: r.isPaused, decimals: r.decimals, totalAToken: r.totalAToken, totalVariableDebt: r.totalVariableDebt };
  };
  const feed = (k) => ({ price: r2(Number(L.chainlink[k].answer) / 1e8), raw: Number(L.chainlink[k].answer) / 1e8, ageS: L.timestamp - L.chainlink[k].updatedAt, updatedAt: L.chainlink[k].updatedAt });
  const pyth = { price: Number(L.pyth.price) / 1e8, conf: Number(L.pyth.conf) / 1e8, ageS: L.timestamp - L.pyth.publishTime, publishTime: L.pyth.publishTime };
  const poolPrice = r2(100 * Math.pow(1.0001, -L.pool.tick));
  return {
    block: L.block, timestamp: L.timestamp, readAt: L.readAt, date: L.readAt.slice(0, 10),
    supplies: { USDC: human(L.supplies.USDC, 6), WETH: human(L.supplies.WETH, 18), cbBTC: human(L.supplies.cbBTC, 8), cbZEC: human(L.supplies.cbZEC, 8), AERO: human(L.supplies.AERO, 18) },
    multiplier: L.cbzecMultiplier,
    reserves: { cbBTC: res("cbBTC"), WETH: res("WETH"), USDC: res("USDC") },
    cbzecListed: !!L.aave.reserves.cbZEC?.listed,
    feeds: { BTC: feed("BTC_USD"), ETH: feed("ETH_USD"), USDC: feed("USDC_USD"), cbBTC: feed("cbBTC_USD") },
    pyth,
    pool: { tick: L.pool.tick, priceUsdc: poolPrice, liquidity: L.pool.liquidity, fee: L.pool.fee, vsPythPct: r2((poolPrice / pyth.price - 1) * 100) },
    gauge: { rewardRate: L.gauge.rewardRate, aeroPerDay: Number(BigInt(L.gauge.rewardRate) * 86_400n / 10n ** 14n) / 10_000, periodFinish: L.gauge.periodFinish },
    cometUtilPct: Number(BigInt(L.comet.utilization) / 10n ** 12n) / 10_000,
    code: L.code,
  };
}

/**
 * The previous read's figures for the drift column: the record of the block the doc currently
 * names when it exists (every run writes one), else parsed from the doc's own tables and sentences
 * (the 2026-09-12 hand-written ledger, whose drift column was the 2026-09-05 read).
 */
function previousFigures(doc, targetBlock) {
  const title = doc.match(/top ledger re-read (\d{4}-\d{2}-\d{2}) at block ([\d,]+)/);
  if (!title) throw new Error("facts: the title does not name the current read");
  const docBlock = Number(title[2].replace(/,/g, ""));
  const docDate = title[1];
  if (docBlock !== targetBlock) {
    const rec = join(RESEARCH, `ledger-read-${docBlock}.json`);
    if (existsSync(rec)) return { ...figures(readJson(rec)), fromRecord: true };
    return { ...parseDocCurrent(doc), block: docBlock, date: docDate, fromRecord: false };
  }
  // Same block as the doc: keep the doc's drift column as it is.
  return { ...parseDocPrevious(doc), fromRecord: false };
}
const n = (s) => Number(String(s).replace(/,/g, "").replace(/%/g, "").replace(/−/g, "-"));
/** A prose regex whose spaces accept the docs' ~85-column line wraps. */
const ws = (src) => new RegExp(src.replace(/ /g, "\\s+"));
function parseDocCurrent(doc) {
  const supplies = {};
  for (const k of ["USDC", "WETH", "cbBTC", "cbZEC", "AERO"]) supplies[k] = n(doc.match(new RegExp(`^\\| \\**${k}\\** \\| \`0x[0-9a-fA-F]+\` \\| \\d+ \\| \\**([\\d,.]+)\\** \\|`, "m"))[1]);
  const reserves = {};
  for (const k of ["cbBTC", "WETH", "USDC"]) {
    const m = doc.replace(/\*\*/g, "").match(new RegExp(`^\\| ${k} \\| ([\\d.]+)% \\| ([\\d.]+)% \\| ([\\d.]+)% \\| yes \\| yes \\| ([\\d.]+)% \\| ([\\d.]+)% \\|`, "m"));
    reserves[k] = { ltvBps: Math.round(n(m[1]) * 100), ltBps: Math.round(n(m[2]) * 100), bonusBps: Math.round(n(m[3]) * 100), borrowPct: n(m[4]), supplyPct: n(m[5]) };
  }
  const feeds = {};
  for (const [k, label] of [["BTC", "BTC / USD"], ["ETH", "ETH / USD"], ["USDC", "USDC / USD"], ["cbBTC", "cbBTC / USD"]]) {
    const m = doc.match(new RegExp(`^\\| ${label} \\| \`0x[0-9a-fA-F]+\` \\| ([\\d,.]+) \\| ([\\d,]+) s`, "m"));
    feeds[k] = { price: n(m[1]), ageS: n(m[2]) };
  }
  const py = doc.match(ws("\\*\\*\\$([\\d,.]+) ± ([\\d.]+)\\*\\*[\\s\\S]*?`publishTime` ([\\d,]+) = (\\S+) — \\*\\*([\\d,]+) s"));
  const pool = doc.match(ws("slot0 tick (−?-?[\\d,]+) → \\*\\*≈ ([\\d,]+) USDC per cbZEC\\*\\* \\(100 × 1\\.0001\\^[\\d,]+ = ([\\d,.]+)[^)]*\\), active liquidity L = ([\\d,]+)"));
  const gauge = doc.match(ws("`rewardRate\\(\\)` ([\\d,]+) wei/s \\(≈ ([\\d,.]+) AERO/day\\), `periodFinish\\(\\)` ([\\d,]+)"));
  const comet = doc.match(ws("utilization \\*\\*([\\d.]+) %\\*\\*"));
  return {
    supplies, reserves, feeds,
    pyth: py ? { price: n(py[1]), conf: n(py[2]), publishTime: n(py[3]), ageS: n(py[5]) } : null,
    pool: pool ? { tick: n(pool[1]), priceUsdc: n(pool[3]), liquidity: pool[4].replace(/,/g, "") } : null,
    gauge: gauge ? { rewardRate: gauge[1].replace(/,/g, ""), aeroPerDay: n(gauge[2]), periodFinish: n(gauge[3]) } : null,
    cometUtilPct: comet ? n(comet[1]) : null,
  };
}
function parseDocPrevious(doc) {
  const title = doc.match(/top ledger re-read (\d{4}-\d{2}-\d{2}) at block ([\d,]+)/);
  const prevDate = (doc.match(/The (\d{4}-\d{2}-\d{2}) figures[^\n]*stay in the last column/) ?? [])[1] ?? "2026-09-05";
  const prevBlockM = doc.match(/The \d{4}-\d{2}-\d{2} figures \(block ([\d,]+)\)/);
  const supplies = {};
  for (const k of ["USDC", "WETH", "cbBTC", "cbZEC", "AERO"]) supplies[k] = n(doc.match(new RegExp(`^\\| \\**${k}\\** \\| \`0x[0-9a-fA-F]+\` \\| \\d+ \\| \\**[\\d,.]+\\** \\| ([\\d,.]+) \\|`, "m"))[1]);
  const reserves = {};
  for (const k of ["cbBTC", "WETH", "USDC"]) {
    const m = doc.replace(/\*\*/g, "").match(new RegExp(`^\\| ${k} \\| ([\\d.]+)% \\| ([\\d.]+)% \\| ([\\d.]+)% \\| yes \\| yes \\| [\\d.]+% \\| [\\d.]+% \\| ([\\d.]+)% / ([\\d.]+)% \\|`, "m"));
    reserves[k] = { ltvBps: Math.round(n(m[1]) * 100), ltBps: Math.round(n(m[2]) * 100), bonusBps: Math.round(n(m[3]) * 100), borrowPct: n(m[4]), supplyPct: n(m[5]) };
  }
  const feeds = {};
  for (const [k, label] of [["BTC", "BTC / USD"], ["ETH", "ETH / USD"], ["USDC", "USDC / USD"], ["cbBTC", "cbBTC / USD"]]) {
    const m = doc.match(new RegExp(`^\\| ${label} \\| \`0x[0-9a-fA-F]+\` \\| [\\d,.]+ \\| [^|]+\\| ([\\d,.]+) \\(([\\d,]+) s\\)`, "m"));
    feeds[k] = { price: n(m[1]), ageS: n(m[2]) };
  }
  const py = doc.match(ws("then ([\\d,]+) s"));
  const pyPrice = doc.match(ws("\\*\\*\\$([\\d,.]+) ± ([\\d.]+)\\*\\*"));
  const pyPub = doc.match(ws("`publishTime` ([\\d,]+)"));
  const pool = doc.match(ws("On \\d{4}-\\d{2}-\\d{2}: tick (−?-?[\\d,]+) → ≈ ([\\d,]+) USDC per cbZEC, L = ([\\d,]+)"));
  const gaugePrev = doc.match(ws("On \\d{4}-\\d{2}-\\d{2}: `rewardRate\\(\\)` ([\\d,]+) wei/s \\(≈ ([\\d,.]+) AERO/day\\), `periodFinish\\(\\)` ([\\d,]+)"));
  const gaugeZero = ws("At the \\d{4}-\\d{2}-\\d{2} read both were 0").test(doc);
  const comet = doc.match(ws("\\(([\\d.]+) % on \\d{4}-\\d{2}-\\d{2}"));
  return {
    block: prevBlockM ? n(prevBlockM[1]) : null, date: prevDate, supplies, reserves, feeds,
    pyth: py && pyPrice && pyPub ? { price: n(pyPrice[1]), conf: n(pyPrice[2]), publishTime: n(pyPub[1]), ageS: n(py[1]) } : null,
    pool: pool ? { tick: n(pool[1]), priceUsdc: n(pool[2]), liquidity: pool[3].replace(/,/g, "") } : null,
    gauge: gaugePrev ? { rewardRate: gaugePrev[1].replace(/,/g, ""), aeroPerDay: n(gaugePrev[2]), periodFinish: n(gaugePrev[3]) } : gaugeZero ? { rewardRate: "0", aeroPerDay: 0, periodFinish: 0 } : null,
    cometUtilPct: comet ? n(comet[1]) : null,
    _title: title,
  };
}

// ------------------------------------------------------------------------------ the facts template
function renderFactsTop(F, P, sampleFile, rpcUsed) {
  const prevDate = P.date, prevBlock = P.block ? ` (block ${fmtInt(P.block)})` : "";
  const t = new Date(F.timestamp * 1000).toISOString().slice(11, 19);
  const res = (k, label) => {
    const r = F.reserves[k], p = P.reserves?.[k];
    return `| ${label} | ${pct2(r.ltvBps)} | **${pct2(r.ltBps)}** | ${bonusPct(r.bonusWord)} | yes | yes | ${k === "USDC" ? `**${r.borrowPct}%**` : `${r.borrowPct}%`} | ${r.supplyPct}% | ${p ? `${p.borrowPct}% / ${p.supplyPct}%` : "—"} |`;
  };
  const feedRow = (label, addr, k, note) => {
    const f = F.feeds[k], p = P.feeds?.[k];
    const cur = k === "USDC" ? "1.00" : fmt(f.price, 2);
    const age = k === "USDC" ? `${fmtInt(f.ageS)} s (heartbeat-driven; raw answer ${f.raw.toFixed(8)})` : `${fmtInt(f.ageS)} s`;
    return `| ${label} | \`${addr}\` | ${cur} | ${age} | ${p ? `${k === "USDC" ? "1.00" : fmt(p.price, 2)} (${fmtInt(p.ageS)} s)` : "—"} |${note ?? ""}`;
  };
  const pyAgeDays = (F.pyth.ageS / 86_400).toFixed(1);
  const sameUpdate = P.pyth && P.pyth.publishTime === F.pyth.publishTime;
  const pythPrev = !P.pyth ? "" : sameUpdate ? `the same posted update the ${prevDate} read saw (then ${fmtInt(P.pyth.ageS)} s / ${(P.pyth.ageS / 3600).toFixed(1)} h old)` : `the ${prevDate} read saw the update of ${iso(P.pyth.publishTime)} (\$${fmt(P.pyth.price, 2)}, then ${fmtInt(P.pyth.ageS)} s old)`;
  const pythWhy = sameUpdate ? `: nobody has posted a ZEC/USD update on Base since, and the pool below has moved ${Math.abs(F.pool.vsPythPct).toFixed(1)} % away from it` : `; the pool below is ${Math.abs(F.pool.vsPythPct).toFixed(1)} % ${F.pool.vsPythPct >= 0 ? "above" : "below"} it`;
  const mult = F.multiplier === "1000000000000000000" ? "`multiplier()` = 1e18 (rebase multiplier present, still 1.0)" : `**\`multiplier()\` = ${F.multiplier} — NOT 1e18: the token has rebased; every cbZEC amount in this file is pre-multiplier**`;
  const gaugePrev = P.gauge ? (P.gauge.rewardRate === "0" ? `At the ${prevDate} read both were 0: created, never voted, no AERO.` : `On ${prevDate}: \`rewardRate()\` ${fmtInt(P.gauge.rewardRate)} wei/s (≈ ${fmt(P.gauge.aeroPerDay, 1)} AERO/day), \`periodFinish()\` ${fmtInt(P.gauge.periodFinish)}.`) : "";
  const poolPrev = P.pool ? ` On ${prevDate}: tick ${fmtInt(P.pool.tick).replace("-", "−")} → ≈ ${fmtInt(P.pool.priceUsdc)} USDC per cbZEC, L = ${fmtInt(P.pool.liquidity)}.` : "";
  const cometPrev = P.cometUtilPct !== null && P.cometUtilPct !== undefined ? ` (${P.cometUtilPct} % on ${prevDate}; ` : " (";
  return `# Verified Base mainnet facts for the Base module (first read 2026-09-05 ~01:00 UTC; top ledger re-read ${F.date} at block ${fmtInt(F.block)}, ${t} UTC; chain id 8453)

Method: \`eth_getCode\` / \`eth_call\` against public Base RPCs from a networked sandbox, selectors computed with
\`cast sig\`. **Every address below has been confirmed to hold code and to answer the calls stated.** Anything not
listed here is unverified and must be probed before code depends on it — this is the rule that would have caught
the C-2 mainnet-bricking bug (see \`AUDIT-FINDINGS-2026-09-03.md\`).

**Re-read ${F.date} (\`scripts/refresh-demo-snapshot.mjs\`).** Every number in this top section was read again, read-only, at one
pinned block — **${fmtInt(F.block)}** (timestamp ${fmtInt(F.timestamp)} = ${F.readAt}), the block the ${F.date} yield sample was
taken at (\`${sampleFile}\`) — with \`cast call --block ${F.block}\` (\`scripts/ledger-read.sh\`) against
\`${rpcUsed}\`, so the demo's market snapshot (\`web/lib/demo.ts\` \`DEMO_MARKET\`, the prototypes' \`OIL_CHAIN_READ\`), its
yield model and its forecast are one read. The ${prevDate} figures${prevBlock} stay in the last column of each table as the drift.
Raw words: \`docs/research/ledger-read-${F.block}.json\`; the 2026-09-12 read's are in Addendum 14.

## Tokens (all verified: \`symbol()\`, \`decimals()\`, \`totalSupply()\`)

| Token | Address | Decimals | Total supply (${F.date}, block ${fmtInt(F.block)}) | Total supply (${prevDate}) | Notes |
|---|---|---|---|---|---|
| USDC | \`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913\` | 6 | ${fmt(F.supplies.USDC, 2)} | ${fmt(P.supplies.USDC, 2)} | native Circle USDC |
| WETH | \`0x4200000000000000000000000000000000000006\` | 18 | ${fmt(F.supplies.WETH, 2)} | ${fmt(P.supplies.WETH, 2)} | OP-stack predeploy |
| cbBTC | \`0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf\` | 8 | ${fmt(F.supplies.cbBTC, 2)} | ${fmt(P.supplies.cbBTC, 2)} | plain ERC-20 (code len 3,102) |
| **cbZEC** | \`0xB2000000000000000000008501b13360000cb2EC\` | 8 | **${fmt(F.supplies.cbZEC, 2)}** | ${fmt(P.supplies.cbZEC, 2)} | **B20 precompile: \`eth_getCode\` returns \`0xef\`.** \`name()\` = "Coinbase Wrapped ZEC". ${mult}. \`owner()\` and \`paused()\` revert (not exposed). |
| AERO | \`0x940181a94A35A4569E4529A3CDfB74e38FD98631\` | 18 | ${fmt(F.supplies.AERO, 2)} | ${fmt(P.supplies.AERO, 2)} | |

## Aave v3 on Base (verified via PoolAddressesProvider → \`getPool()\` / \`getPoolDataProvider()\` / \`getPriceOracle()\`)

- PoolAddressesProvider \`0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D\`
- **Pool \`0xA238Dd80C259a72e81d7e4664a9801593F98d1c5\`**
- PoolDataProvider \`0x0F43731EB8d45A581f4a36DD74F5f358bc90C73A\` (EIP-55 casing corrected 2026-09-05; the first print of this file had a non-checksum casing of the same hex, which viem's \`getAddress\` rejects — \`packages/shared/src/base.ts\` pins this form)
- AaveOracle \`0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156\`

Reserve configuration (\`getReserveConfigurationData\`, bps) and rates (\`getReserveData\`, ray → %) at block ${fmtInt(F.block)}
(${F.readAt}); the last column is the ${prevDate} read:

| Reserve | LTV | Liq. threshold | Liq. bonus | Collateral | Borrowable | Variable borrow APR | Supply APR | ${prevDate} (borrow / supply) |
|---|---|---|---|---|---|---|---|---|
${res("cbBTC", "cbBTC")}
${res("WETH", "WETH")}
${res("USDC", "USDC")}
| cbZEC | — | — | — | **NOT LISTED** (${F.cbzecListed ? "LISTED at this read — the config call answered; re-check the product's disabled flag" : "the config call reverted at this read; it returned zeros on 2026-09-05"}) | | | | |

The rates are the ray words truncated at 1e-4 % exactly as the yield service's \`rayToPct\` does (integer division,
\`services/yield/src/sources/aave.ts\`), so the model, the demo and this table carry the same digits; the ray words
themselves, the reserves' \`lastUpdateTimestamp\` and the \`getPaused\` reads (${["cbBTC", "WETH", "USDC"].every((k) => !F.reserves[k].paused) ? "false on all three" : "**a reserve reads PAUSED — see the record**"}) are in
\`docs/research/ledger-read-${F.block}.json\`.

Product implication: borrowing USDC against cbBTC at Aave costs **${F.reserves.USDC.borrowPct.toFixed(2)}%** today (${F.reserves.USDC.borrowPct} %; ${P.reserves?.USDC ? `${P.reserves.USDC.borrowPct.toFixed(2)} % on ${prevDate}` : "—"}); the
liquidation threshold that drives our health-factor ladder is **${(F.reserves.cbBTC.ltBps / 10_000).toFixed(2)} for cbBTC and ${(F.reserves.WETH.ltBps / 10_000).toFixed(2)} for WETH** (per-asset, read from
chain, never a constant).

## Chainlink price feeds on Base (verified \`description()\` + \`latestRoundData()\`)

| Feed | Address | Answer at block ${fmtInt(F.block)} (${F.date}) | Age at that block | ${prevDate} answer (age) |
|---|---|---|---|---|
${feedRow("BTC / USD", "0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F", "BTC")}
${feedRow("ETH / USD", "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70", "ETH")}
${feedRow("USDC / USD", "0x7e860098F58bBFC8648a4311b374B1D669a2bc6B", "USDC")}
${feedRow("cbBTC / USD", "0x07DA0E54543a844a80ABE69c8A12F22B3aA59f9D", "cbBTC")}

Aave's own sources: cbBTC → \`0x3a932b286715abc4a86a4acaf68a6cdd89e0d446\`, WETH → \`0x9da00d23465282005db222a441a663ee7b9dfcc8\`,
USDC → \`0xf52d010c7d4ecbfda92c2509900593ce34535d86\` (these are Aave's adapters, not the raw feeds).
**There is no Chainlink ZEC/USD feed on Base.**

## Pyth on Base (verified)

- Pyth contract \`0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a\`
- \`Crypto.ZEC/USD\` price id \`0xbe9b59d178f0d6a97ab4c343bff2aa69caa1eaae3e9048a65788c529b125bb24\`
- \`getPriceUnsafe\` at block ${fmtInt(F.block)} (${F.date}): **$${fmt(F.pyth.price, 2)} ± ${F.pyth.conf.toFixed(2)}** (${fmtInt(F.pyth.price * 1e8)} × 1e−8, conf ${fmtInt(F.pyth.conf * 1e8)}),
  expo −8, \`publishTime\` ${fmtInt(F.pyth.publishTime)} = ${iso(F.pyth.publishTime)} — **${fmtInt(F.pyth.ageS)} s (${pyAgeDays} days) old at that block**, ${pythPrev}${pythWhy}. Pyth is
  pull-based: the on-chain price is only as fresh as the last update anyone posted. **Any oracle adapter must pull
  a fresh update (Hermes) inside the same transaction and enforce a max age, or it is pricing stale data.**

## Aerodrome (verified)

- Voter \`0x16613524e02ad97eDfeF371bC883F2F5d6C480A5\`
- **cbZEC/USDC Slipstream pool \`0x0Fc47C17AF86078d809358db1b4db2DeBC988566\`** (EIP-1167 clone, code len 92):
  token0 = USDC, token1 = cbZEC, fee ${F.pool.fee} (${(F.pool.fee / 10_000).toFixed(1)}%), tickSpacing 200. At block ${fmtInt(F.block)} (${F.date}) slot0 tick ${fmtInt(F.pool.tick).replace("-", "−")} →
  **≈ ${fmtInt(F.pool.priceUsdc)} USDC per cbZEC** (100 × 1.0001^${fmtInt(Math.abs(F.pool.tick))} = ${fmt(F.pool.priceUsdc, 2)}; the pool is ${Math.abs(F.pool.vsPythPct).toFixed(1)} % ${F.pool.vsPythPct >= 0 ? "above" : "below"} Pyth's ${pyAgeDays}-day-old $${fmt(F.pyth.price, 2)}), active
  liquidity L = ${fmtInt(F.pool.liquidity)}.${poolPrev} The depth here is a few ticks wide: the position holding most of it goes
  out of range when the price crosses a spacing boundary (seen an hour after the 2026-09-12 read, Addendum 14).
- **Gauge for that pool: \`0x8779e34e5d38358b0cb957c553b40cc1208c81fb\` — \`rewardRate()\` ${fmtInt(F.gauge.rewardRate)} wei/s
  (≈ ${fmt(F.gauge.aeroPerDay, 1)} AERO/day), \`periodFinish()\` ${fmtInt(F.gauge.periodFinish)} (${iso(F.gauge.periodFinish)}) at block ${fmtInt(F.block)}.** ${gaugePrev}
  The first emissions vote landed in the epoch that began 2026-09-10 (Addendum 8, 0.083 % of the Voter's weight).
- The MaxFi/Snuggle engine facts (index-getter \`userPositions(address,uint256)\`, replace-on-rekey, total-span
  widths, \`slot0()\` on CL pools) are in \`AUDIT-FINDINGS-2026-09-03.md\` Part 1 and still hold.

## Other infrastructure (code presence verified)

- Morpho Blue \`0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb\` — present (${fmtInt(F.code.Morpho)} bytes of code at block ${fmtInt(F.block)}; the first print counted the
  31,248 hex characters of \`eth_getCode\`). Market listing via the
  public GraphQL API failed on schema field names three times on 2026-09-05; the working query (\`marketId\`, not
  \`uniqueKey\`/\`id\`; \`OracleFeed\` has \`address\` only) and both chain-verified ids are in the Morpho addendum
  below. No cbZEC market exists (consistent with the research).
- Compound v3 USDC Comet \`0xb125E6687d4313864e53df431d5425969c15Eb2F\` — present; \`baseToken()\` = USDC;
  utilization **${F.cometUtilPct.toFixed(2)} %** at block ${fmtInt(F.block)}${cometPrev}${F.cometUtilPct >= 90 ? "above the kink → borrow rate elevated; " : ""}read the
  live rate before quoting it).
- Permit2 \`0x000000000022D473030F116dDEE9F6B43aC78BA3\` — present (${fmtInt(F.code.Permit2)} bytes).
- CoW Protocol GPv2Settlement \`0x9008D19f58AAbD9eD0D60971565AA8510560ab41\` — present (${fmtInt(F.code.CoWSettlement)} bytes).

`;
}

// ------------------------------------------------------------------------------- web/lib/demo.ts
function renderDemoTs(src, F, reserve, sampleFile) {
  let s = src;
  const sub = (re, to, what) => {
    if (!re.test(s)) die(`demo.ts: ${what} not found`);
    s = s.replace(re, to);
  };
  sub(/\(Base mainnet block [\d,_]+,\n \* [^\n]*\n \* [^\n]*\)/, `(Base mainnet block ${fmtInt(F.block)},\n * ${F.date} ${F.readAt.slice(11, 19)} UTC — the block the demo's yield sample was read at,\n * so the snapshot, the model and the forecast are one read; scripts/refresh-demo-snapshot.mjs)`, "header comment");
  sub(/export const DEMO_SNAPSHOT_AT = "[^"]+";/, `export const DEMO_SNAPSHOT_AT = "${F.readAt}";`, "DEMO_SNAPSHOT_AT");
  sub(/\/\*\* The pinned block every DEMO_MARKET number was read at \([^)]*\)\. \*\//, `/** The pinned block every DEMO_MARKET number was read at (docs/research/ledger-read-${F.block}.json, VERIFIED-BASE-FACTS.md's top ledger). */`, "block comment");
  sub(/export const DEMO_SNAPSHOT_BLOCK = [\d_]+;/, `export const DEMO_SNAPSHOT_BLOCK = ${F.block.toLocaleString("en-US").replace(/,/g, "_")};`, "DEMO_SNAPSHOT_BLOCK");
  sub(/\/\*\* cbZEC\/USDC Slipstream pool at that block: slot0 tick [^\n]*\*\//, `/** cbZEC/USDC Slipstream pool at that block: slot0 tick ${fmtInt(F.pool.tick).replace("-", "−")} → 100 × 1.0001^${fmtInt(Math.abs(F.pool.tick))} USDC per cbZEC. Demo spot quotes only. */`, "cbZEC price comment");
  sub(/export const DEMO_CBZEC_PRICE_USDC = [\d.]+;/, `export const DEMO_CBZEC_PRICE_USDC = ${F.pool.priceUsdc};`, "DEMO_CBZEC_PRICE_USDC");
  if (reserve.block === F.block) sub(/\/\*\*\n \* The USDC reserve's lendable balance(?:, read | at the SAME block )[\s\S]*?\*\/\nexport const DEMO_USDC_AVAILABLE_READ_AT = "[^"]+";/,
    `/**\n * The USDC reserve's lendable balance at the SAME block (${sampleFile.replace(/^.*\//, "services/yield/samples/")}'s Aave\n * words, recorded in samples/aave-usdc-reserve-${F.date}.json): totalAToken ${fmt(Number(reserve.getReserveData.totalAToken) / 1e6, 2)} − variable debt\n * ${fmt(Number(reserve.getReserveData.totalVariableDebt) / 1e6, 2)}.\n */\nexport const DEMO_USDC_AVAILABLE_READ_AT = "${reserve.readAt}";`, "USDC available block");
  sub(/usdcBorrowAprPct: [\d.]+,/, `usdcBorrowAprPct: ${F.reserves.USDC.borrowPct},`, "usdcBorrowAprPct");
  const reserveBlock = (k, fields) => {
    const start = s.indexOf(`    ${k}: {\n      symbol: "${k}",`);
    if (start < 0) die(`demo.ts: reserve block ${k}`);
    const end = s.indexOf("\n    },", start);
    let b = s.slice(start, end);
    for (const [f, v] of Object.entries(fields)) {
      const re = new RegExp(`(${f}: )[^,\\n]+(,)`);
      if (!re.test(b)) die(`demo.ts: ${k}.${f}`);
      b = b.replace(re, `$1${v}$2`);
    }
    s = s.slice(0, start) + b + s.slice(end);
  };
  const common = (k) => ({ liquidationThresholdBps: F.reserves[k].ltBps, ltvBps: F.reserves[k].ltvBps, liquidationBonusBps: F.reserves[k].bonusBps, variableBorrowAprPct: F.reserves[k].borrowPct, supplyAprPct: F.reserves[k].supplyPct });
  reserveBlock("cbBTC", { ...common("cbBTC"), priceUsd: F.feeds.cbBTC.price });
  reserveBlock("WETH", { ...common("WETH"), priceUsd: F.feeds.ETH.price });
  reserveBlock("USDC", { ...common("USDC"), ...(reserve.block === F.block ? { availableUnits: String(reserve.derived.availableFromTotalsUsdc).replace(/^(\d+)(\d{3})(\d{3})/, (m0, a, b, c) => `${a}_${b}_${c}`) } : {}) });
  return s;
}

// --------------------------------------------------------------------- prototypes' OIL_CHAIN_READ
function renderChainRead(F) {
  const r = (k) => {
    const x = F.reserves[k];
    return `{ ltvBps: ${x.ltvBps}, liquidationThresholdBps: ${x.ltBps}, liquidationBonusBps: ${x.bonusBps}, supplyAprPct: ${x.supplyPct}, borrowAprPct: ${x.borrowPct}, isPaused: ${x.paused} }`;
  };
  const pad = (k) => k + ":" + " ".repeat(6 - k.length);
  return `/* ── OIL_CHAIN_READ — the live reads the product parameterises on (never
   constants in production: PoolDataProvider / feeds / gauges at call time).
   Values are the ${F.date} re-read at block ${fmtInt(F.block)} (${F.readAt.slice(11, 19)} UTC) in
   docs/VERIFIED-BASE-FACTS.md — the block the yield sample behind OIL_MODEL
   was taken at, so the page's chain read and its model are one read
   (scripts/refresh-demo-snapshot.mjs; raw words docs/research/ledger-read-${F.block}.json). ── */
const OIL_CHAIN_READ = Object.freeze({
  readAt: "${F.readAt}",
  readBlock: ${F.block},
  aaveReserves: {
    /* \`isPaused\` is Aave's GUARDIAN PAUSE — a separate getPaused(asset) read
       (selector 0xb55d9904), not a field of the config tuple. A paused reserve
       still quotes a rate and still reads active, but every supply and borrow
       reverts on chain; ${["cbBTC", "WETH", "USDC"].every((k) => !F.reserves[k].paused) ? "false on all three" : "READ THE FLAGS: one is paused"} at the ${F.date} read. Rates are
       the ray words truncated at 1e-4 % (the yield service's rayToPct), so the
       page, the model and the ledger carry the same digits. */
    ${pad("cbBTC")}${r("cbBTC")},
    ${pad("WETH")}${r("WETH")},
    ${pad("USDC")}${r("USDC")},
    cbZEC: null,
  },
  feeds: { cbBTC: ${F.feeds.cbBTC.price}, WETH: ${F.feeds.ETH.price}, USDC: 1.00, BTC: ${F.feeds.BTC.price} },
  /* Pyth ZEC/USD as posted (publishTime ${F.pyth.publishTime}): ${fmtInt(F.pyth.ageS)} s old at block ${fmtInt(F.block)}. */
  pythZecUsd: { price: ${F.pyth.price.toFixed(2)}, ageS: ${F.pyth.ageS}, stale: ${F.pyth.ageS > 3600} },
  /* slot0 tick ${fmtInt(F.pool.tick).replace("-", "−")} → 100 × 1.0001^${fmtInt(Math.abs(F.pool.tick))} USDC per cbZEC; the gauge's rewardRate (wei/s) and periodFinish (unix s). */
  cbzecUsdcPool: { priceUsdc: ${F.pool.priceUsdc}, gaugeRewardRate: ${F.gauge.rewardRate}, gaugePeriodFinish: ${F.gauge.periodFinish} },
  /* The Snuggle engine's own performance fee on LP earnings (verified on the deployed vault in the pre-pivot tree). A venue fee, not an Oilskin fee. */
  snuggleEngineFeeBps: 1500,
});
`;
}
function replaceChainRead(page, F) {
  const START = "/* ── OIL_CHAIN_READ";
  const s = page.indexOf(START);
  if (s < 0) die("prototype: OIL_CHAIN_READ start not found");
  const e = page.indexOf("\n});\n", s);
  if (e < 0) die("prototype: OIL_CHAIN_READ end not found");
  let out = page.slice(0, s) + renderChainRead(F) + page.slice(e + "\n});\n".length);
  const hdr = /top ledger re-read \d{4}-\d{2}-\d{2} at block [\d,]+/;
  if (!hdr.test(out)) die("prototype: OIL_SHARED header line");
  out = out.replace(hdr, `top ledger re-read ${F.date} at block ${fmtInt(F.block)}`);
  return out;
}
function oilRegion(page) {
  const a = page.indexOf("/* ── OIL_SHARED");
  const b = page.indexOf("/* ── Demo wallet / account ── */");
  if (a < 0 || b < 0) die("prototype: OIL region markers");
  return page.slice(a, b);
}

// ------------------------------------------------------------------------------------ the levers
/** Scan a page's own gate() over emissions multiples; return the band where the two forms disagree. */
async function measureLevers() {
  const H = await import(join(REPO, "prototype/test/_harness.mjs"));
  const srv = await H.serve();
  const b = await H.browser();
  const out = {};
  try {
    const scan = async (file, expr) => {
      const page = await H.openPage(b, srv.url(file));
      const r = await page.evaluate(`(() => { const oil = window.__oil; const res = []; for (let m = 100; m <= 6000; m += 1) { const mult = m / 100; const g = (${expr})(oil, mult); res.push([mult, g.reason, g.ok === true]); } return res; })()`);
      const band = r.filter(([, reason]) => reason === "within_model_uncertainty").map(([m]) => m);
      const opens = r.filter(([, , ok]) => ok).map(([m]) => m);
      await page.close();
      return { band: band.length ? [band[0], band[band.length - 1]] : null, firstOpen: opens[0] ?? null };
    };
    out.simple = await scan("simple.html", `(oil, mult) => { const pl = oil.poolById("aero-usdc-weth-5"); return oil.gate(pl, oil.S.borrowPct, oil.widthFor(pl), mult, oil.gopt({ collateral: "cbBTC" })); }`);
    out.simpleCbbtc = await scan("simple.html", `(oil, mult) => { const pl = oil.poolById("aero-cbbtc-usdc"); return oil.gate(pl, oil.S.borrowPct, oil.widthFor(pl), mult, oil.gopt({ collateral: "cbBTC" })); }`);
    out.advanced = await scan("index.html", `(oil, mult) => oil.gate(oil.poolById("aero-weth-cbbtc"), oil.S.borrowPct, 150, mult)`);
  } finally {
    await b.close();
    srv.close();
  }
  return out;
}
/** The lever value to use: the current one when it is inside the band, else the smallest one-decimal value inside it (two decimals when none fits). */
function pickLever(current, band) {
  if (!band) return null;
  const [lo, hi] = band;
  if (current >= lo - 1e-9 && current <= hi + 1e-9) return current;
  const oneDp = Math.ceil(lo * 10 - 1e-9) / 10;
  if (oneDp <= hi + 1e-9) return oneDp;
  return Math.ceil(lo * 100 - 1e-9) / 100;
}
/**
 * The kit's "opens the menu" lever: the smallest WHOLE multiple above cbBTC/USDC's own break-even (the
 * rule prototype/test/verify-simple.mjs states); the check beside it asserts that the multiple below does
 * not open the pool. Page button, both suites' dispatches and their texts move together.
 */
function moveWholeLever(current, next) {
  if (current === next) return false;
  const cur = String(current), nxt = String(next), curBelow = String(current - 1), nxtBelow = String(next - 1);
  for (const p of [...PAGES, PROTO_TESTS.simple, PROTO_TESTS.advanced]) {
    let s = readFileSync(p, "utf8");
    const before = s;
    s = s.split(`data-tk="mult:${cur}">WHAT-IF emissions ×${cur} (opens the menu)`).join(`data-tk="mult:${nxt}">WHAT-IF emissions ×${nxt} (opens the menu)`)
      .split(`{ type: "setMult", mult: ${cur} }`).join(`{ type: "setMult", mult: ${nxt} }`)
      .split(`what-if ×${cur}`).join(`what-if ×${nxt}`).split(`WHAT-IF ×${cur}`).join(`WHAT-IF ×${nxt}`)
      .split(`, 4500, ${cur})).ok`).join(`, 4500, ${nxt})).ok`).split(`, 4500, ${curBelow})).ok`).join(`, 4500, ${nxtBelow})).ok`);
    if (s !== before) writeFileSync(p, s);
  }
  return true;
}
function moveLever(pagePath, testPath, current, next) {
  if (current === next) return false;
  const cur = String(current), nxt = String(next);
  for (const p of [pagePath, testPath]) {
    let s = readFileSync(p, "utf8");
    const before = s;
    s = s.split(`mult:${cur}"`).join(`mult:${nxt}"`).split(`×${cur} `).join(`×${nxt} `).split(`mult: ${cur} `).join(`mult: ${nxt} `).split(`, ${cur}, oil.gopt`).join(`, ${nxt}, oil.gopt`).split(`, 150, ${cur})`).join(`, 150, ${nxt})`);
    if (s === before) die(`lever ×${cur} not found in ${p.replace(REPO, ".")}`);
    writeFileSync(p, s);
  }
  return true;
}

// ================================================================================================ main
async function main() {
  const wall = new Date().toISOString();
  // ---- the block
  // `latest` is the tip LESS a margin of 20 blocks (≈ 40 s on Base): a public endpoint other than the one
  // that answered eth_blockNumber can lag the tip by a few blocks and answer a pinned read at it with
  // `null` / HTTP 500 (base.drpc.org did, 2026-09-13). The block is then pinned for every step.
  const TIP_MARGIN = 20;
  let block = BLOCK_ARG === "latest" ? Number(await rpcCall(RPC, "eth_blockNumber", [])) - TIP_MARGIN : Number(BLOCK_ARG);
  if (!Number.isInteger(block) || block <= 0) die(`--block: ${BLOCK_ARG}`);
  const hdr = await rpcCall(RPC, "eth_getBlockByNumber", [`0x${block.toString(16)}`, false]);
  if (!hdr) die(`block ${block} not served by ${RPC}`);
  const ts = Number(hdr.timestamp);
  const readAt = iso(ts);
  const date = readAt.slice(0, 10);
  log(`block ${block} = ${readAt} (${BLOCK_ARG === "latest" ? `resolved from latest − ${TIP_MARGIN}` : "pinned"}), wall clock ${wall}`);

  // ---- 1. the sample, pinned
  const sampleFile = join(SAMPLES, `gauge-emissions-${date}.json`);
  let sampleFresh = false;
  // A sample is the block's when it names the block: a pinned one, or a pre-slice-M sample taken at
  // `latest` in the same instant (2026-09-12's, whose ledger was read at its block by hand).
  const sampleOk = () => existsSync(sampleFile) && readJson(sampleFile).block === block;
  if (REDO_MODEL && !sampleOk()) die(`--redo-model needs the block's sample at ${sampleFile.replace(REPO, ".")}`);
  if ((!FORCE || REDO_MODEL) && sampleOk()) log(`1 sample: ${sampleFile.replace(REPO, ".")} is already the read of block ${block} — kept`);
  else {
    const paced = /mainnet\.base\.org/.test(SAMPLE_RPC);
    run("npm", ["run", "backfill", "-w", "@zyo/yield", "--", "sample", "--block", String(block)], {
      env: { BASE_RPC_URL: SAMPLE_RPC, GECKO_MIN_INTERVAL_MS: process.env.GECKO_MIN_INTERVAL_MS ?? "6000", ...(paced ? { RPC_BATCH_SIZE: "1", RPC_PACE_MS: "400" } : {}) },
    });
    if (!sampleOk()) die(`the sample was not written pinned to block ${block}`);
    sampleFresh = true;
  }
  const sample = readJson(sampleFile);
  if (sample.pinned) {
    // The source stamps the instant with milliseconds ("…41.000Z"); the same instant, compared as one.
    if (Date.parse(sample.sampledAt) !== Date.parse(readAt)) die(`sample.sampledAt ${sample.sampledAt} ≠ block timestamp ${readAt}`);
  } else if (Math.abs(Date.parse(sample.sampledAt) - Date.parse(readAt)) > 60_000) die(`sample.sampledAt ${sample.sampledAt} is not the instant of block ${block} (${readAt})`);
  else log(`1 sample: taken at \`latest\` (${sample.sampledAt}), block ${block} = ${readAt} — the same read, not pinned`);

  // ---- 2. the model
  const modelFile = join(SAMPLES, `lp-model-${date}.json`);
  const modelOk = () => existsSync(modelFile) && readJson(modelFile).inputs?.gaugeSample?.block === block && String(readJson(modelFile).inputs?.gaugeSample?.file ?? "").endsWith(`gauge-emissions-${date}.json`);
  if (!FORCE && !REDO_MODEL && !sampleFresh && modelOk()) log(`2 model: ${modelFile.replace(REPO, ".")} already generated from that sample — kept`);
  else {
    run("npm", ["run", "model-inputs", "-w", "@zyo/yield"]);
    // lp-sim.py writes every file and then exits 1 when a priced cell breaches the closed form's declared
    // tolerance (its validation table) — a model finding to RECORD (services/yield/test/model-pin.test.ts
    // pins the breached cells by name; RISKS §21), not a failed run. 2 / 3 are input errors.
    run("node", ["scripts/run-model.mjs", "--sample", `samples/gauge-emissions-${date}.json`], { cwd: YIELD, okStatus: [0, 1], okStatusMeans: "a validation breach is reported in the table — record it" });
    if (!modelOk()) die("the model was not generated from the pinned sample");
  }
  const model = readJson(modelFile);
  {
    const pj = join(YIELD, "package.json");
    const s = readFileSync(pj, "utf8");
    const t = s.replace(/--sample samples\/gauge-emissions-\d{4}-\d{2}-\d{2}\.json/, `--sample samples/gauge-emissions-${date}.json`);
    if (t !== s) { writeFileSync(pj, t); log(`2 package.json: \`model\` now names gauge-emissions-${date}.json`); }
  }

  // ---- 3. the ledger read
  mkdirSync(RESEARCH, { recursive: true });
  const ledgerFile = join(RESEARCH, `ledger-read-${block}.json`);
  let L;
  if (!FORCE && existsSync(ledgerFile)) { L = readJson(ledgerFile); log(`3 ledger: ${ledgerFile.replace(REPO, ".")} exists — kept`); }
  else {
    const text = run("bash", [join(REPO, "scripts/ledger-read.sh"), RPC, String(block)], { capture: true });
    L = parseLedger(text);
    if (L.block !== block) die(`ledger read block ${L.block} ≠ ${block}`);
    L.script = "scripts/ledger-read.sh"; L.rpc = RPC; L.readAtWallClock = new Date().toISOString(); L.log = text.split("\n").filter(Boolean);
    writeJson(ledgerFile, L);
    log(`3 ledger: ${ledgerFile.replace(REPO, ".")} written (${L.log.length} lines)`);
  }
  const F = figures(L);
  // The sample and the ledger must be ONE read: same block, same Aave words.
  for (const k of ["USDC", "cbBTC", "WETH"]) {
    const s = k === "USDC" ? sample.aave.borrow : sample.aave.collateral[k];
    if (s.variableBorrowAprPct !== F.reserves[k].borrowPct || s.supplyAprPct !== F.reserves[k].supplyPct) die(`${k}: the sample's rates (${s.variableBorrowAprPct} / ${s.supplyAprPct}) ≠ the ledger's (${F.reserves[k].borrowPct} / ${F.reserves[k].supplyPct}) — not one read`);
    if (s.totalATokenUnits !== undefined && s.totalATokenUnits !== F.reserves[k].totalAToken) die(`${k}: totalAToken differs between the sample and the ledger`);
  }
  if (String(sample.pools?.["aero-cbzec-usdc"]?.rewardRateWeiPerSec ?? "") !== String(F.gauge.rewardRate)) die("the cbZEC/USDC gauge's rewardRate differs between the sample and the ledger");

  // ---- 4. the USDC reserve read (curve + totals), from the same words
  const reserveFile = join(SAMPLES, `aave-usdc-reserve-${date}.json`);
  {
    const b = sample.aave.borrow, c = sample.aave.borrowCurve, U = L.aave.reserves.USDC;
    if (!c && existsSync(reserveFile)) {
      // A pre-A3 sample (2026-09-12's) read no strategy; its reserve file is the separately dated
      // cast read of Addendum 13 and stays as it is. Every pinned sample since carries the curve.
      log(`4 reserve: the sample has no borrowCurve — ${reserveFile.replace(REPO, ".")} (block ${readJson(reserveFile).block}) kept as its own dated read`);
    } else if (!c) die("the sample carries no borrowCurve — the yield source must read the strategy with the rates");
    else {
    const supplied = Number(BigInt(U.totalAToken)) / 1e6, debt = Number(BigInt(U.totalVariableDebt)) / 1e6;
    const u = debt / supplied;
    const curve = u <= c.optimalUsageBps / 10_000 ? (c.baseVariableBorrowRateBps + (c.variableRateSlope1Bps * u) / (c.optimalUsageBps / 10_000)) / 100 : (c.baseVariableBorrowRateBps + c.variableRateSlope1Bps + (c.variableRateSlope2Bps * (u - c.optimalUsageBps / 10_000)) / (1 - c.optimalUsageBps / 10_000)) / 100;
    const reserve = {
      _about: `Aave v3 Base USDC reserve — the borrow side's curve and totals at block ${block}, the SAME pinned read as the gauge sample and the ledger (scripts/refresh-demo-snapshot.mjs; the curve from the sample's borrowCurve, the totals and ray words from docs/research/ledger-read-${block}.json). Feeds the demo forecast's post-borrow rate and liquidity refusal; the live service reads the same words every sample.`,
      readAt, block,
      poolDataProvider: "0x0F43731EB8d45A581f4a36DD74F5f358bc90C73A",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      decimals: b.decimals ?? 6,
      strategy: c.strategy,
      getInterestRateDataBps: { optimalUsageBps: c.optimalUsageBps, baseVariableBorrowRateBps: c.baseVariableBorrowRateBps, variableRateSlope1Bps: c.variableRateSlope1Bps, variableRateSlope2Bps: c.variableRateSlope2Bps },
      getReserveData: { unbacked: U.unbacked, accruedToTreasuryScaled: U.accruedToTreasuryScaled, totalAToken: U.totalAToken, totalStableDebt: U.totalStableDebt, totalVariableDebt: U.totalVariableDebt, liquidityRateRay: U.liquidityRateRay, variableBorrowRateRay: U.variableBorrowRateRay, lastUpdateTimestamp: U.lastUpdateTimestamp },
      reserveFactorBps: U.reserveFactorBps,
      derived: {
        utilizationPct: r2(u * 100),
        variableBorrowAprPct: F.reserves.USDC.borrowPct,
        curveAtUtilizationPct: Math.round(curve * 10_000) / 10_000,
        availableFromTotalsUsdc: Number(BigInt(U.totalAToken) - BigInt(U.totalVariableDebt)) / 1e6,
        note: "available = totalAToken − totalVariableDebt; the strategy's own denominator is the virtual balance + debt (the treasury accrual apart, < 0.001 %). The aToken's USDC balance is not part of this read.",
      },
    };
    const cur = existsSync(reserveFile) ? readFileSync(reserveFile, "utf8") : "";
    const next = JSON.stringify(reserve, null, 2) + "\n";
    if (cur !== next) { writeFileSync(reserveFile, next); log(`4 reserve: ${reserveFile.replace(REPO, ".")} written (available ${fmt(reserve.derived.availableFromTotalsUsdc, 2)} USDC)`); }
    else log("4 reserve: unchanged");
    }
  }
  const reserve = readJson(reserveFile);

  // ---- 5. the demo payloads (the evaluators' own output)
  run("npm", ["run", "build", "-w", "@zyo/yield"]);
  run("node", ["scripts/gen-demo-gate.mjs", "--sample", `samples/gauge-emissions-${date}.json`, "--model", `samples/lp-model-${date}.json`], { cwd: YIELD });
  run("node", ["scripts/gen-demo-forecast.mjs", "--sample", `samples/gauge-emissions-${date}.json`, "--model", `samples/lp-model-${date}.json`, "--reserve", `samples/aave-usdc-reserve-${date}.json`], { cwd: YIELD });
  for (const g of ["gen-demo-gate.mjs", "gen-demo-forecast.mjs"]) {
    const p = join(YIELD, "scripts", g);
    const s = readFileSync(p, "utf8");
    const t = s.replace(/gauge-emissions-\d{4}-\d{2}-\d{2}\.json/g, `gauge-emissions-${date}.json`).replace(/lp-model-\d{4}-\d{2}-\d{2}\.json/g, `lp-model-${date}.json`).replace(/aave-usdc-reserve-\d{4}-\d{2}-\d{2}\.json/g, `aave-usdc-reserve-${date}.json`);
    if (t !== s) { writeFileSync(p, t); log(`5 ${g}: defaults now name the ${date} files`); }
  }

  // ---- 6. the facts doc's top ledger
  const doc = readFileSync(FACTS, "utf8");
  const anchor = "## What this settles for the build";
  const ai = doc.indexOf(anchor);
  if (ai < 0) die("facts: anchor section not found");
  const P = previousFigures(doc, block);
  const top = renderFactsTop(F, P, sampleFile.replace(REPO + "/", ""), RPC);
  const nextDoc = top + doc.slice(ai);
  if (nextDoc !== doc) { writeFileSync(FACTS, nextDoc); log(`6 facts: top ledger now block ${fmtInt(block)}; drift column = ${P.date}${P.fromRecord ? " (from its record)" : " (parsed from the doc)"}`); }
  else log("6 facts: unchanged");

  // ---- 7. web/lib/demo.ts and the demo banner
  {
    const s = readFileSync(DEMO_TS, "utf8");
    const t = renderDemoTs(s, F, reserve, sampleFile);
    if (t !== s) { writeFileSync(DEMO_TS, t); log("7 web/lib/demo.ts: snapshot constants and DEMO_MARKET moved"); } else log("7 web/lib/demo.ts: unchanged");
    const c = readFileSync(COPY_TS, "utf8");
    const re = /chain reads from \d{4}-\d{2}-\d{2} \(Base block [\d,]+\)/;
    if (!re.test(c)) die("copy.ts: demo banner sentence not found");
    const t2 = c.replace(re, `chain reads from ${date} (Base block ${fmtInt(block)})`);
    if (t2 !== c) { writeFileSync(COPY_TS, t2); log("7 web/lib/copy.ts: demo banner dated"); }
  }

  // ---- 8. both prototypes: OIL_CHAIN_READ (byte-equal), then OIL_MODEL through the generator
  for (const p of PAGES) {
    const s = readFileSync(p, "utf8");
    const t = replaceChainRead(s, F);
    if (t !== s) { writeFileSync(p, t); log(`8 ${p.replace(REPO, ".")}: OIL_CHAIN_READ re-pinned`); }
  }
  run("node", ["prototype/scripts/gen-oil-model.mjs", `services/yield/samples/lp-model-${date}.json`]);
  {
    const [a, b] = PAGES.map((p) => oilRegion(readFileSync(p, "utf8")));
    if (a !== b) die("the OIL_* region differs between simple.html and index.html");
    log("8 prototypes: OIL_* region byte-equal between the two pages");
  }

  // ---- 9. the levers, measured on the pages' own gate()
  const levers = {};
  if (SKIP_LEVERS) log("9 levers: skipped (--skip-levers)");
  else {
    const m = await measureLevers();
    const simplePage = readFileSync(PAGES[0], "utf8"), advPage = readFileSync(PAGES[1], "utf8");
    const curS = Number((simplePage.match(/data-tk="mult:([\d.]+)">WHAT-IF ×[\d.]+ — inside the band/) ?? [])[1]);
    const curA = Number((advPage.match(/data-tk="mult:([\d.]+)">WHAT-IF ×[\d.]+ — the band/) ?? [])[1]);
    if (!curS || !curA) die("levers: the pages' band buttons were not found");
    const nextS = pickLever(curS, m.simple.band), nextA = pickLever(curA, m.advanced.band);
    if (nextS === null || nextA === null) die(`levers: no disagreement band on ${nextS === null ? "simple WETH/USDC" : "advanced WETH/cbBTC"} at this borrow — the page needs a different lever pool (hand edit)`);
    levers.simple = { band: m.simple.band, was: curS, now: nextS, moved: moveLever(PAGES[0], PROTO_TESTS.simple, curS, nextS) };
    levers.advanced = { band: m.advanced.band, was: curA, now: nextA, moved: moveLever(PAGES[1], PROTO_TESTS.advanced, curA, nextA) };
    levers.x5opens = m.simpleCbbtc.firstOpen;
    const curW = Number((simplePage.match(/data-tk="mult:(\d+)">WHAT-IF emissions ×\d+ \(opens the menu\)/) ?? [])[1]);
    if (!curW) die("levers: the pages' whole-multiple button was not found");
    if (m.simpleCbbtc.firstOpen === null) die("levers: cbBTC/USDC never opens at any multiple up to ×60 — the kit's lever needs a hand edit");
    const nextW = Math.max(2, Math.ceil(m.simpleCbbtc.firstOpen + 1e-9));
    levers.whole = { firstOpen: m.simpleCbbtc.firstOpen, was: curW, now: nextW, moved: moveWholeLever(curW, nextW) };
    log(`9 levers: simple WETH/USDC band ×${m.simple.band[0]}–×${m.simple.band[1]} → ×${nextS}${levers.simple.moved ? ` (was ×${curS}; page + test moved)` : " (unchanged)"}; advanced WETH/cbBTC@150 band ×${m.advanced.band[0]}–×${m.advanced.band[1]} → ×${nextA}${levers.advanced.moved ? ` (was ×${curA}; page + test moved)` : " (unchanged)"}; cbBTC/USDC first opens at ×${m.simpleCbbtc.firstOpen} → the kit's whole multiple ×${nextW}${levers.whole.moved ? ` (was ×${curW}; both pages + both suites moved)` : " (unchanged)"}`);
  }

  // ---- 10. docs/MODEL-NUMBERS-<date>.md and the superseded banner; the dated names in the yield tests
  {
    const src = join(SAMPLES, "MODEL-NUMBERS.md");
    const dst = join(REPO, `docs/MODEL-NUMBERS-${date}.md`);
    if (!existsSync(dst) || readFileSync(dst, "utf8") !== readFileSync(src, "utf8")) { copyFileSync(src, dst); log(`10 docs/MODEL-NUMBERS-${date}.md written`); }
    const older = readdirSync(join(REPO, "docs")).filter((f) => /^MODEL-NUMBERS-\d{4}-\d{2}-\d{2}\.md$/.test(f) && f < `MODEL-NUMBERS-${date}.md`).sort().pop();
    if (older) {
      const p = join(REPO, "docs", older);
      const s = readFileSync(p, "utf8");
      if (!/^> \*\*Superseded on /m.test(s)) {
        const prevModel = readdirSync(SAMPLES).filter((f) => f.startsWith("lp-model-") && f < `lp-model-${date}.json`).sort().pop();
        const prevVol = prevModel ? readJson(join(SAMPLES, prevModel)).inputs?.volatility?.asOf : null;
        const sigma = prevVol && prevVol === model.inputs?.volatility?.asOf ? "σ unchanged" : "σ re-read";
        const banner = `\n> **Superseded on ${date}** by \`MODEL-NUMBERS-${date}.md\` (\`scripts/refresh-demo-snapshot.mjs\`: gauge words and Aave\n> rates re-read live at block ${fmtInt(block)}; ${sigma}). Kept as the dated record of the ${older.slice(14, 24)} inputs; nothing pins to it.\n`;
        const nl = s.indexOf("\n");
        writeFileSync(p, s.slice(0, nl + 1) + banner + s.slice(nl + 1));
        log(`10 ${older}: superseded banner added`);
      }
    }
    const tests = readdirSync(join(YIELD, "test")).filter((f) => f.endsWith(".test.ts"));
    for (const f of tests) {
      const p = join(YIELD, "test", f);
      const s = readFileSync(p, "utf8");
      const t = s.replace(/gauge-emissions-\d{4}-\d{2}-\d{2}\.json/g, (m0) => (/2026-08-31/.test(m0) ? m0 : `gauge-emissions-${date}.json`)).replace(/lp-model-\d{4}-\d{2}-\d{2}\.json/g, `lp-model-${date}.json`).replace(/aave-usdc-reserve-\d{4}-\d{2}-\d{2}\.json/g, `aave-usdc-reserve-${date}.json`);
      if (t !== s) { writeFileSync(p, t); log(`10 services/yield/test/${f}: dated sample names moved to ${date}`); }
    }
  }

  // ---- 11. the drift table
  const gate = readJson(join(SAMPLES, "demo-gate.json"));
  const fc = readJson(join(SAMPLES, "demo-forecast.json"));
  const best = model.results?.["aero-cbbtc-usdc"]?.sheltered;
  const rows = [
    ["block", P.block ? fmtInt(P.block) : "—", fmtInt(F.block)],
    ["read at", P.date, F.readAt],
    ["USDC borrow / supply %", P.reserves?.USDC ? `${P.reserves.USDC.borrowPct} / ${P.reserves.USDC.supplyPct}` : "—", `${F.reserves.USDC.borrowPct} / ${F.reserves.USDC.supplyPct}`],
    ["cbBTC borrow / supply %", P.reserves?.cbBTC ? `${P.reserves.cbBTC.borrowPct} / ${P.reserves.cbBTC.supplyPct}` : "—", `${F.reserves.cbBTC.borrowPct} / ${F.reserves.cbBTC.supplyPct}`],
    ["WETH borrow / supply %", P.reserves?.WETH ? `${P.reserves.WETH.borrowPct} / ${P.reserves.WETH.supplyPct}` : "—", `${F.reserves.WETH.borrowPct} / ${F.reserves.WETH.supplyPct}`],
    ["cbBTC / USD", P.feeds?.cbBTC ? fmt(P.feeds.cbBTC.price, 2) : "—", fmt(F.feeds.cbBTC.price, 2)],
    ["ETH / USD", P.feeds?.ETH ? fmt(P.feeds.ETH.price, 2) : "—", fmt(F.feeds.ETH.price, 2)],
    ["BTC / USD", P.feeds?.BTC ? fmt(P.feeds.BTC.price, 2) : "—", fmt(F.feeds.BTC.price, 2)],
    ["Pyth ZEC/USD (age s)", P.pyth ? `${fmt(P.pyth.price, 2)} (${fmtInt(P.pyth.ageS)})` : "—", `${fmt(F.pyth.price, 2)} (${fmtInt(F.pyth.ageS)})`],
    ["cbZEC/USDC pool price (tick)", P.pool ? `${fmt(P.pool.priceUsdc, 2)} (${P.pool.tick})` : "—", `${fmt(F.pool.priceUsdc, 2)} (${F.pool.tick})`],
    ["pool liquidity L", P.pool ? fmtInt(P.pool.liquidity) : "—", fmtInt(F.pool.liquidity)],
    ["gauge AERO/day (periodFinish)", P.gauge ? `${fmt(P.gauge.aeroPerDay, 1)} (${P.gauge.periodFinish})` : "—", `${fmt(F.gauge.aeroPerDay, 1)} (${F.gauge.periodFinish})`],
    ["Comet utilisation %", P.cometUtilPct === null || P.cometUtilPct === undefined ? "—" : Number(P.cometUtilPct).toFixed(2), F.cometUtilPct.toFixed(2)],
    ["USDC available to lend", "—", fmt(reserve.derived.availableFromTotalsUsdc, 2)],
    ["AERO $ (sample)", "—", sample.aeroUsd.toFixed(4)],
    ["model best cell lpNet % (cbBTC/USDC sheltered)", "—", best ? `${r2(best.lpNetPct)} (mc ${r2(best.mcLpNetPct)}, ${best.reason}; break-even ×${r2(best.breakEvenEmissionsMultiple)})` : "—"],
    ["gate: cells clearing / forecast: cells clearing both forms", "—", `${gate.qualifying.length} / ${fc.cells.filter((c) => c.clearsBorrow?.both).length} of ${fc.cells.length}`],
    ["levers", "—", SKIP_LEVERS ? "skipped" : `simple ×${levers.simple.now}, advanced ×${levers.advanced.now}, whole ×${levers.whole.now} (cbBTC/USDC first opens at ×${levers.x5opens})`],
  ];
  const w0 = Math.max(...rows.map((r) => r[0].length)), w1 = Math.max(...rows.map((r) => String(r[1]).length));
  console.log(`\nDrift, ${P.date} → ${F.date} (block ${fmtInt(F.block)}):`);
  for (const [k, a, b] of rows) console.log(`  ${k.padEnd(w0)}  ${String(a).padStart(w1)}  →  ${b}`);
  console.log(`\nNext, by hand: docs/RISKS.md §14 (the model's verdict, from docs/MODEL-NUMBERS-${date}.md — never softened), docs/TESTING.md, docs/YIELD-SERVICE.md, docs/CHANGELOG.md; then the suites: yield, web (typecheck, unit, e2e), prototypes — fix only a test that TYPED a figure instead of deriving it.`);
}

main().catch((e) => {
  console.error(`refresh: ${e.stack ?? e}`);
  process.exit(1);
});

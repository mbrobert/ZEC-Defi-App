#!/usr/bin/env node
/**
 * status — regenerates docs/STATUS.md by RUNNING the suites, never by hand.
 *
 *   npm run status                  the suites that need nothing but this checkout
 *   npm run status -- --all         plus the ones that need infrastructure, each still
 *                                   recorded as "not run" when its precondition is absent
 *   npm run status -- --check       run, then exit 1 if docs/STATUS.md is out of date
 *
 * Why this exists: on 2026-09-14 README.md carried three different contract-suite counts
 * (374, 380, and the 388 the tree actually had that morning — by then itself superseded by
 * 433), plus stale numbers for the keeper, the yield service, the web app and the ABI seam.
 * Every one of them had been typed by hand and then left behind by the next commit.
 * `docs/ROADMAP.md` §4 rule 7 is the rule this file enforces: a document that carries a
 * number must not be written by a person. Prose lives in README.md; dated state lives here,
 * and only this script writes it.
 *
 * Adding a suite: append to SUITES below with a parser that reads the runner's own summary
 * line. Never write a count into the table by hand — a suite whose output cannot be parsed
 * is reported as unparsed, which is a bug in the row, not a number to guess.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const outPath = join(repoRoot, "docs", "STATUS.md");

const argv = process.argv.slice(2);
const wantAll = argv.includes("--all");
const checkOnly = argv.includes("--check");

/* The founder's Mac keeps Foundry, cargo and the Solana CLI off the default PATH of a
   non-login shell; add them when they exist so `npm run status` works from anywhere. */
const extraPath = [
  join(homedir(), ".foundry", "bin"),
  join(homedir(), ".cargo", "bin"),
  join(homedir(), ".local", "share", "solana", "install", "active_release", "bin"),
].filter((p) => existsSync(p));
const PATH = [...extraPath, process.env.PATH ?? ""].join(":");

const have = (bin) => spawnSync("sh", ["-lc", `command -v ${bin}`], { env: { ...process.env, PATH } }).status === 0;

/**
 * A suite that HANGS is worse than one that fails: it produces no row, no reason, and no bound on how
 * long this command takes. On 2026-09-16 the prototype suite hung for 1,069 s inside one invocation
 * against a standalone run of ~31 s, and the only evidence afterwards was an elapsed time nobody was
 * watching. Every suite now carries a ceiling, and passing it is reported as a timeout by name rather
 * than as an unparseable failure.
 *
 * The ceilings are generous on purpose — several times the measured time on the founder's Mac — so
 * that a slow machine is never called a hang. `docs/BACKLOG.md` T-1 is the underlying flake; this is
 * the guard that stops it costing a quarter of an hour in silence, not the fix for it.
 */
const DEFAULT_TIMEOUT_MS = 20 * 60_000;

function run(cmd, cwd = repoRoot, env = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const r = spawnSync("bash", ["-c", cmd], {
    cwd,
    env: { ...process.env, ...env, PATH, FORCE_COLOR: "0", NO_COLOR: "1" },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  // spawnSync reports a timeout by setting `error.code` to ETIMEDOUT and leaving `status` null.
  if (r.error && r.error.code === "ETIMEDOUT") {
    return { status: 124, timedOut: true, out: `${out}\n[status] TIMED OUT after ${Math.round(timeoutMs / 1000)}s and was killed.` };
  }
  return { status: r.status ?? 1, timedOut: false, out };
}

/* ── parsers: each reads the runner's own summary line ─────────────────────────────── */

/** node --test's TAP epilogue. Sums every block, so a script running the runner twice counts both. */
function nodeTest(out) {
  const n = (k) => [...out.matchAll(new RegExp(`^# ${k} (\\d+)$`, "gm"))].reduce((a, m) => a + Number(m[1]), 0);
  const pass = n("pass"), fail = n("fail"), skipped = n("skipped");
  if (!/^# pass \d+$/m.test(out)) return null;
  return { pass, fail, skipped, text: skipped ? `**${pass}** (${skipped} skipped)` : `**${pass}**` };
}

/** forge test's epilogue. */
function forge(out) {
  const m = out.match(/Ran (\d+) test suites?[^\n]*?:\s*(\d+) tests? passed, (\d+) failed, (\d+) skipped \((\d+) total tests?\)/);
  if (!m) return null;
  const [, suites, pass, fail, skipped, total] = m;
  return {
    pass: Number(pass), fail: Number(fail), skipped: Number(skipped),
    text: `**${pass} passed / ${fail} failed / ${skipped} skipped** (${total} total), ${suites} suites`,
  };
}

/** The root ABI seam. */
function abiSeam(out) {
  const m = out.match(/verify-abi: (\d+) selectors\/topics\/errors across (\d+) contracts/);
  return m ? { pass: Number(m[1]), fail: 0, skipped: 0, text: `**${m[1]}** selectors / topics / errors across ${m[2]} contracts` } : null;
}

/** The keeper: its own ABI seam, the IDL seam, then node --test. All three in one row. */
function keeper(out) {
  const t = nodeTest(out);
  if (!t) return null;
  const abi = out.match(/verify-abi: (\d+)\/(\d+) checks passed/);
  const idl = out.match(/verify-solana-idl: (\d+)\/(\d+) checks passed/);
  const seams = [
    abi ? `ABI seam **${abi[1]} / ${abi[2]}**` : null,
    idl ? `IDL seam **${idl[1]} / ${idl[2]}**` : null,
  ].filter(Boolean);
  return { ...t, text: `${t.text}${seams.length ? `, plus its ${seams.join(" and the ")}` : ""}` };
}

/** Playwright's epilogue. */
function playwright(out) {
  const pass = Number(out.match(/(\d+) passed/)?.[1] ?? NaN);
  if (Number.isNaN(pass)) return null;
  const fail = Number(out.match(/(\d+) failed/)?.[1] ?? 0);
  const skipped = Number(out.match(/(\d+) skipped/)?.[1] ?? 0);
  return { pass, fail, skipped, text: `**${pass} passed / ${fail} failed / ${skipped} skipped**` };
}

/** cargo test's `test result:` lines, summed over the crate's targets. */
function cargo(out) {
  const ms = [...out.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored/g)];
  if (!ms.length) return null;
  const pass = ms.reduce((a, m) => a + Number(m[1]), 0);
  const fail = ms.reduce((a, m) => a + Number(m[2]), 0);
  return { pass, fail, skipped: 0, text: `**${pass}**` };
}

/** mocha, through `anchor test`. */
function mocha(out) {
  const pass = Number(out.match(/(\d+) passing/)?.[1] ?? NaN);
  if (Number.isNaN(pass)) return null;
  const fail = Number(out.match(/(\d+) failing/)?.[1] ?? 0);
  return { pass, fail, skipped: 0, text: `**${pass} passing / ${fail} failing**` };
}

/**
 * The four prototype suites, each printing `<suite>: N passed, M failed (K checks, T s)` — or, since
 * 2026-09-18, `<suite>: STALLED … last completed: "<check>"` from the harness's watchdog, or
 * `<suite>: TIMED OUT …` from run-all's ceiling. A broken suite is reported by name with the last check
 * that completed, which is the one fact the 1,069 s hang of 2026-09-16 never left behind (backlog T-1).
 */
function prototypes(out) {
  const NAMES = "verify-simple|verify-advanced|verify-toggle|fuzz";
  const done = [...out.matchAll(new RegExp(`^(${NAMES}): (\\d+) passed, (\\d+) failed`, "gm"))];
  const broke = [...out.matchAll(new RegExp(`^(${NAMES}): (STALLED|TIMED OUT)([^\\n]*)`, "gm"))];
  if (done.length + broke.length !== 4) return null;
  const pass = done.reduce((a, m) => a + Number(m[2]), 0);
  const fail = done.reduce((a, m) => a + Number(m[3]), 0) + broke.length;
  const cell = (m) => {
    const last = m[3].match(/last completed: "([^"]*)"/)?.[1];
    return `${m[1]} **${m[2]}**${last ? ` after "${last.replace(/\|/g, "\\|")}"` : ""}`;
  };
  return { pass, fail, skipped: 0, text: [...done.map((m) => `${m[1]} **${m[2]}**`), ...broke.map(cell)].join(" · ") };
}

/* ── the suites ────────────────────────────────────────────────────────────────────── */

const forkGate = () =>
  !process.env.FORK_URL ? "needs `FORK_URL` (a Base archive RPC)" : !have("forge") ? "needs Foundry on PATH" : null;

const SUITES = [
  {
    area: "Contracts (Foundry)",
    display: "cd contracts && forge test",
    cmd: "forge test",
    cwd: join(repoRoot, "contracts"),
    parse: forge,
    gate: () =>
      !have("forge") ? "needs Foundry on PATH (`SETUP.md`)"
      : !existsSync(join(repoRoot, "contracts", "lib", "forge-std")) ? "needs the libraries cloned into `contracts/lib` (`SETUP.md`)"
      : null,
  },
  {
    area: "Contracts, fork",
    display: "FORK_URL=<Base archive RPC> forge test --match-path test/fork/BaseFork.t.sol",
    cmd: "forge test --match-path test/fork/BaseFork.t.sol",
    cwd: join(repoRoot, "contracts"),
    parse: forge,
    optIn: true,
    gate: forkGate,
  },
  {
    area: "Root ABI seam",
    display: "node scripts/verify-abi.mjs",
    cmd: "node scripts/verify-abi.mjs",
    parse: abiSeam,
    gate: () => (existsSync(join(repoRoot, "contracts", "out")) ? null : "needs `contracts/out` (run the contracts suite first)"),
  },
  { area: "Shared", display: "npm test -w @zyo/shared", cmd: "npm test -w @zyo/shared", parse: nodeTest },
  { area: "Solana, seams", display: "npm test -w @zyo/solana", cmd: "npm test -w @zyo/solana", parse: nodeTest },
  {
    area: "Solana, program unit",
    display: "cd solana && cargo test --manifest-path programs/oilskin/Cargo.toml",
    cmd: "cargo test --manifest-path programs/oilskin/Cargo.toml",
    cwd: join(repoRoot, "solana"),
    parse: cargo,
    optIn: true,
    gate: () => (have("cargo") ? null : "needs the Rust toolchain (`solana/SETUP.md`)"),
  },
  {
    area: "Solana, localnet",
    display: "bash solana/scripts/localnet.sh (terminal 1) · cd solana && anchor test --skip-build --skip-local-validator (terminal 2)",
    cmd: "anchor test --skip-build --skip-local-validator",
    cwd: join(repoRoot, "solana"),
    parse: mocha,
    optIn: true,
    gate: () =>
      !have("anchor") ? "needs Anchor and the Solana CLI (`solana/SETUP.md`)"
      : run("solana cluster-version -u http://127.0.0.1:8899").status !== 0 ? "needs a local validator (`bash solana/scripts/localnet.sh`)"
      : null,
  },
  { area: "Keeper", display: "npm test -w @zyo/agent", cmd: "npm test -w @zyo/agent", parse: keeper },
  { area: "Yield", display: "npm test -w @zyo/yield", cmd: "npm test -w @zyo/yield", parse: nodeTest },
  { area: "Web, unit", display: "npm test -w @zyo/web", cmd: "npm test -w @zyo/web", parse: nodeTest },
  {
    area: "Web, e2e",
    display: "cd web && npx playwright test",
    cmd: "npx playwright test",
    cwd: join(repoRoot, "web"),
    parse: playwright,
    optIn: true,
    gate: () => (existsSync(join(repoRoot, "web", "node_modules", "playwright")) || existsSync(join(repoRoot, "node_modules", "playwright")) ? null : "needs Playwright installed"),
  },
  {
    area: "Web, e2e against Base Sepolia",
    display: "cd web && npx playwright test -c playwright.sepolia.config.ts",
    cmd: "npx playwright test -c playwright.sepolia.config.ts",
    cwd: join(repoRoot, "web"),
    parse: playwright,
    optIn: true,
    gate: () => (deployments().sepolia.length ? null : "skips by name until `docs/DEPLOYMENTS.md` carries Sepolia addresses"),
  },
  {
    // Measured at ~29 s on the founder's Mac; five minutes is ten times that and still catches the
    // 1,069 s hang of 2026-09-16 inside the first minute of it going wrong (backlog T-1). Since
    // 2026-09-18 this is the OUTER guard: each suite's harness watchdog fires first (90 s without a
    // completed check, naming the last one) and run-all's per-suite ceiling second (300 s, by name).
    timeoutMs: 5 * 60_000,
    area: "Prototypes",
    display: "node prototype/test/run-all.mjs",
    cmd: "node prototype/test/run-all.mjs",
    parse: prototypes,
    before: stageModelNumbers,
  },
];

/**
 * Two suites read the generated model table from the LITERAL path /tmp/build/MODEL-NUMBERS.md — the six
 * parity checks of prototype/test/verify-toggle.mjs and the web's demo-gate pin (web/test/snapshot.test.ts),
 * which SKIPS rather than fails without it — and CI stages it there (ci.yml). Until 2026-09-20 this script
 * staged it into os.tmpdir()/build, which on macOS is /var/folders/…/T/build, so on the founder's Mac the
 * staging did nothing and the counts depended on whether someone had run the copy by hand since the last
 * reboot: the first run after one reported the web suite with a skip and the toggle suite crashed writing
 * its report into the missing directory. Stage the file where it is read, once, before any suite runs.
 */
const MODEL_STAGE_DIR = "/tmp/build";
function stageModelNumbers() {
  mkdirSync(MODEL_STAGE_DIR, { recursive: true });
  const src = join(repoRoot, "services", "yield", "samples", "MODEL-NUMBERS.md");
  if (existsSync(src)) copyFileSync(src, join(MODEL_STAGE_DIR, "MODEL-NUMBERS.md"));
}

/* ── the state that is not a suite ─────────────────────────────────────────────────── */

/** Every filled address row in docs/DEPLOYMENTS.md, by chain section. */
function deployments() {
  const path = join(repoRoot, "docs", "DEPLOYMENTS.md");
  const found = { sepolia: [], mainnet: [], other: [] };
  if (!existsSync(path)) return found;
  let bucket = "other";
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const h = line.match(/^##\s+(.*)$/);
    if (h) bucket = /sepolia/i.test(h[1]) ? "sepolia" : /mainnet|8453/i.test(h[1]) ? "mainnet" : "other";
    const row = line.match(/^\|\s*([^|]+?)\s*\|\s*(0x[0-9a-fA-F]{40})\b/);
    if (row) found[bucket].push({ key: row[1], address: row[2] });
  }
  return found;
}

/** The forecast verdict, read out of the generated demo snapshot — never restated by hand. */
function forecast() {
  const path = join(repoRoot, "services", "yield", "samples", "demo-forecast.json");
  if (!existsSync(path)) return null;
  const j = JSON.parse(readFileSync(path, "utf8"));
  const priced = j.cells.filter((c) => c.lpPriced);
  const clears = priced.filter((c) => c.clearsBorrow?.both);
  const best = priced.slice().sort((a, b) => (b.lpNetPct ?? -Infinity) - (a.lpNetPct ?? -Infinity))[0];
  return {
    asOf: j.asOf,
    block: j.usdcReserveBlock,
    borrowAprPct: j.borrowAprPct,
    entryHf: j.entryHf,
    entryHfFloor: j.entryHfFloor,
    cells: j.cells.length,
    priced: priced.length,
    clears: clears.length,
    stale: j.stale,
    best,
  };
}

/** Every internal audit record in docs/, with the severities the document itself states. */
function audits() {
  const dir = join(repoRoot, "docs");
  const files = readdirSync(dir).filter((f) => /^AUDIT-(FINDINGS-)?\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort();
  return files.map((f) => {
    const text = readFileSync(join(dir, f), "utf8");
    const title = text.match(/^#\s+(.*)$/m)?.[1] ?? f;
    return { file: f, title, severities: severitiesOf(text) };
  });
}

/** Prefer the document's own `## The count` table; otherwise tally its Severity columns. */
function severitiesOf(text) {
  const section = text.split(/^##\s+The count\s*$/m)[1];
  if (section) {
    const rows = section.split(/^##\s/m)[0].split("\n").filter((l) => /^\|/.test(l) && /\d/.test(l));
    const totals = rows.filter((l) => /\*\*\d+\*\*/.test(l));
    const pick = totals.length ? [totals[totals.length - 1]] : rows;
    const sums = [0, 0, 0, 0, 0];
    for (const row of pick) {
      const cells = row.split("|").slice(1, -1).map((c) => c.trim().replace(/\*\*/g, ""));
      const nums = cells.filter((c) => /^\d+$/.test(c)).map(Number).slice(-5);
      if (nums.length === 5) nums.forEach((n, i) => (sums[i] += n));
    }
    if (sums.some((n) => n)) return label(sums);
  }
  const tally = { Critical: 0, High: 0, Medium: 0, Low: 0, Info: 0 };
  for (const m of text.matchAll(/^\|\s*[\w.-]+\s*\|\s*\*{0,2}(Critical|High|Medium|Low|Info)\b/gm)) tally[m[1]]++;
  const sums = [tally.Critical, tally.High, tally.Medium, tally.Low, tally.Info];
  return sums.some((n) => n) ? label(sums) : "stated per finding in the document";
}

/** A percentage with the typographic minus every other document in docs/ uses. */
const pct = (n) => (n === null || n === undefined ? "n/a" : `${String(n).replace(/^-/, "\u2212")} %/yr`);

const label = (s) =>
  ["Critical", "High", "Medium", "Low", "Info"].map((k, i) => `${s[i]} ${k}`).filter((_, i) => s[i] > 0).join(" · ") || "none";

/* ── run ───────────────────────────────────────────────────────────────────────────── */

const results = [];
stageModelNumbers();
for (const s of SUITES) {
  const skipReason = s.optIn && !wantAll ? "not run — add `--all`" : s.gate?.();
  if (skipReason) {
    results.push({ ...s, skipped: skipReason });
    process.stderr.write(`status: ${s.area} — skipped (${skipReason.replace(/`/g, "")})\n`);
    continue;
  }
  process.stderr.write(`status: ${s.area} — running…\n`);
  s.before?.();
  const t0 = Date.now();
  const { status, out, timedOut } = run(s.cmd, s.cwd ?? repoRoot, {}, s.timeoutMs);
  // A timeout has no summary line to parse, and calling it "output not parsed" would send the next
  // reader to fix a parser that is working. Say what happened.
  const parsed = timedOut ? { text: `**TIMED OUT** and was killed \u2014 re-run \`${s.display ?? s.cmd}\` alone` } : s.parse(out);
  const secs = Math.round((Date.now() - t0) / 1000);
  // A suite that did not come back green keeps its whole output on disk. Until 2026-09-18 it was
  // captured here and dropped, so the three red prototype rows of 2026-09-16 left nothing but a
  // count — not one failing check's name (backlog T-1). One file per area, overwritten each run.
  const green = status === 0 && parsed && !(parsed.fail > 0);
  const logPath = green ? null : keepOutput(s.area, out);
  results.push({ ...s, status, parsed, out, logPath });
  process.stderr.write(
    `status: ${s.area} — ${parsed ? parsed.text.replace(/\*\*/g, "") : "OUTPUT NOT PARSED"}` +
      `${status === 0 ? "" : ` (exit ${status})`} [${secs}s]${logPath ? ` — output kept in ${logPath}` : ""}\n`,
  );
}

function keepOutput(area, out) {
  const dir = join(tmpdir(), "oilskin-status");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${area.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}.log`);
  writeFileSync(file, out);
  return file;
}

const git = (cmd) => run(`git ${cmd}`).out.trim();
const sha = git("rev-parse --short HEAD");
const branch = git("rev-parse --abbrev-ref HEAD");
const dirty = git("status --porcelain").split("\n").filter(Boolean).length;
const dep = deployments();
const fc = forecast();
/* every document except this one, which is the index */
const docFiles = readdirSync(join(repoRoot, "docs")).filter((f) => f.endsWith(".md") && f !== "STATUS.md").sort();

const red = results.filter((r) => !r.skipped && (r.status !== 0 || !r.parsed || r.parsed.fail > 0));

const L = [];
L.push("# Status — generated, never hand-written");
L.push("");
L.push("<!-- Written by scripts/status.mjs (`npm run status`). Do not edit by hand: every number");
L.push("     below came from running the command in its own row, on the tree named here. README.md");
L.push("     carries the prose and no numbers; this file carries the numbers and no prose. -->");
L.push("");
L.push(`_Generated ${new Date().toISOString().replace(/\.\d+Z$/, "Z")} by \`npm run status\`${wantAll ? " --all" : ""} on ${process.platform}-${process.arch}, Node ${process.versions.node}._`);
L.push("");
L.push(`**Tree:** the working tree at \`${sha}\` on \`${branch}\`` +
  `${dirty ? `, with **${dirty} file(s) modified on top of it** — including this one, when it is regenerated just before a commit` : " — clean"}.` +
  " Each suite ran against that tree, not against a published commit.");
L.push("");
L.push("Abbreviations: ABI = application binary interface; e2e = end-to-end; HF = health factor;");
L.push("LP = liquidity provision; RPC = remote procedure call; CCTP = Circle's Cross-Chain Transfer Protocol.");
L.push("");
L.push("## Suites");
L.push("");
L.push("| Area | Command | Result |");
L.push("|---|---|---|");
for (const r of results) {
  const cmd = `\`${r.display}\``;
  if (r.skipped) { L.push(`| ${r.area} | ${cmd} | ${r.skipped} |`); continue; }
  const cell = r.parsed ? r.parsed.text : "**output not parsed** — fix the parser in `scripts/status.mjs`";
  const flag = r.status !== 0 ? " — **the run exited non-zero**" : "";
  L.push(`| ${r.area} | ${cmd} | ${cell}${flag} |`);
}
L.push("");
L.push(red.length
  ? `**${red.length} suite(s) did not come back green on this run: ${red.map((r) => r.area).join(", ")}.** ` +
    `Each one's full output was kept: ${red.map((r) => `\`${r.logPath}\``).join(", ")} — read it before re-running anything.`
  : "Every suite that ran came back green.");
L.push("");
L.push("What each suite *proves* is `docs/TESTING.md`; what changed and when is `docs/CHANGELOG.md`.");
L.push("A row that says \"not run\" is a precondition this invocation did not have, not a failure.");
L.push("");
L.push("## What is deployed");
L.push("");
const chains = [["Base mainnet (8453)", dep.mainnet], ["Base Sepolia (84532)", dep.sepolia]];
const anyDeployed = chains.some(([, rows]) => rows.length);
if (!anyDeployed) {
  L.push("**Nothing, on any chain.** `docs/DEPLOYMENTS.md` holds no address on any row, which is the");
  L.push("one place a deployed address may come from. No transaction has been signed or broadcast from");
  L.push("this repository; the keeper and the web app read the same file and run in demo / observe-only");
  L.push("mode while it is empty.");
} else {
  for (const [name, rows] of chains) {
    L.push(`**${name}:** ${rows.length ? rows.map((r) => `${r.key} \`${r.address}\``).join(" · ") : "nothing"}`);
    L.push("");
  }
}
L.push("");
L.push("## The forecast today");
L.push("");
if (!fc) {
  L.push("`services/yield/samples/demo-forecast.json` is missing — run `npm run demo-forecast -w @zyo/yield`.");
} else {
  const b = fc.best;
  L.push(`Read out of \`services/yield/samples/demo-forecast.json\` (the forecast evaluator's own output on`);
  L.push(`the recorded inputs, \`npm run demo-forecast -w @zyo/yield\`), sampled **${fc.asOf}** at block`);
  L.push(`**${fc.block.toLocaleString("en-US")}**${fc.stale ? ", **marked stale**" : ""}.`);
  L.push("");
  L.push(`- USDC variable borrow rate: **${fc.borrowAprPct} %**; entry HF **${fc.entryHf}** at the registry floor **${fc.entryHfFloor}**.`);
  L.push(`- **${fc.clears} of the ${fc.priced} priced cells** beat the borrow on **both** models — ${fc.cells} pool × setting cells in all, ${fc.cells - fc.priced} of them unpriced (no calibrated volatility or no emissions to price).`);
  if (b) {
    L.push(`- Best priced cell: **${b.poolId} at the "${b.setting}" width** — LP net **${pct(b.lpNetPct)}** (closed form), **${pct(b.mcLpNetPct)}** (Monte-Carlo calibrated), the user's net **${pct(b.userNetPct)}** at that entry HF; it needs **${b.breakEvenEmissionsMultiple}×** today's net emissions to break even.`);
  }
  L.push("");
  L.push("The forecast is a **forecast, not a gate** (`docs/BUILD-PLAN-2026-09-12.md` D4/D5): every curated");
  L.push("pool is depositable in both modes once the user has seen these numbers and acknowledged them.");
  L.push("Refusals are safety only. Re-read the chain before believing any of it — `docs/TESTING.md`.");
}
L.push("");
L.push("## Audit history");
L.push("");
L.push("No external audit has been done. These are internal adversarial passes, each on the tree it names,");
L.push("with the severities the document itself records; the inquiries to external firms went out 2026-09-13");
L.push("(`docs/AUDIT-INQUIRY-2026-09-13.md`, shortlist in `docs/AUDIT-SHORTLIST-2026-09.md`).");
L.push("");
L.push("| Record | What it covered | Findings |");
L.push("|---|---|---|");
for (const a of audits()) L.push(`| [\`${a.file}\`](${a.file}) | ${a.title.replace(/\|/g, "\\|")} | ${a.severities} |`);
L.push("");
L.push("Fix commits, the failing scenario and the regression test path are inside each record;");
L.push("the regression tests themselves are `contracts/test/audit-regressions/`.");
L.push("");
L.push("## Every document in docs/");
L.push("");
const docDirs = readdirSync(join(repoRoot, "docs"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
L.push(`All ${docFiles.length} documents beside this one, from an \`ls\` of \`docs/\` at generation time, each with its own first heading` +
  `${docDirs.length ? `, plus the ${docDirs.length === 1 ? "subdirectory" : "subdirectories"} ${docDirs.map((d) => `\`docs/${d}/\``).join(", ")}` : ""}.`);
L.push("");
for (const f of docFiles) {
  const first = readFileSync(join(repoRoot, "docs", f), "utf8").match(/^#\s+(.*)$/m)?.[1] ?? "";
  L.push(`- [\`${f}\`](${f}) — ${first.replace(/\|/g, "\\|")}`);
}
L.push("");
L.push("## Regenerating this file");
L.push("");
L.push("```bash");
L.push("npm run status            # the suites that need nothing but this checkout");
L.push("npm run status -- --all   # plus fork, Solana localnet, cargo and the Playwright suites");
L.push("npm run status -- --check # regenerate and exit 1 if this file was out of date");
L.push("```");
L.push("");

const body = L.join("\n");
const volatile = (s) => s.split("\n").filter((l) => !l.startsWith("_Generated ") && !l.startsWith("**Tree:**")).join("\n");

if (checkOnly) {
  const old = existsSync(outPath) ? readFileSync(outPath, "utf8") : "";
  if (volatile(old) === volatile(body)) { console.log("status: docs/STATUS.md is up to date"); process.exit(red.length ? 1 : 0); }
  console.error("status: docs/STATUS.md is out of date — run `npm run status`");
  process.exit(1);
}

writeFileSync(outPath, body);
console.log(`status: wrote docs/STATUS.md — ${results.filter((r) => !r.skipped).length} suite(s) run, ${results.filter((r) => r.skipped).length} not run${red.length ? `, ${red.length} NOT GREEN` : ""}`);
process.exit(red.length ? 1 : 0);

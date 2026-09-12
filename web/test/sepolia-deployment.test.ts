import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { DEPLOYMENTS_PATH, readSepoliaDeployment } from "../e2e/sepolia-deployment";

/**
 * The parser that gates the Sepolia rehearsal suite (slice J, 2026-09-12): docs/DEPLOYMENTS.md is
 * the ONE place a deployed address may come from, so the rule that turns its table into
 * "run" / "skip by name" is pinned here — against the committed file (no addresses today) and
 * against a filled fixture.
 */

const FACTORY = "0x1111111111111111111111111111111111111111";
const ROUTER = "0x2222222222222222222222222222222222222222";
const CBZEC = "0x3333333333333333333333333333333333333333";
const AERO = "0x4444444444444444444444444444444444444444";

function filled(overrides: Partial<Record<string, string>> = {}): string {
  const rows: Record<string, string> = {
    deployedAtBlock: "46800000",
    OilskinAccountFactory: `\`${FACTORY}\``,
    StrategyRouter: `\`${ROUTER}\``,
    "cbZEC double (MockB20)": `\`${CBZEC}\``,
    "AERO double (MockERC20)": `\`${AERO}\``,
    ...overrides,
  };
  const table = Object.entries(rows)
    .map(([k, v]) => `| ${k} | ${v} | where |`)
    .join("\n");
  return `# Deployments\n\n## Base Sepolia (chain id 84532)\n\n| Key | Value | Where |\n|---|---|---|\n${table}\n\n## Base mainnet (chain id 8453)\n\n| OilskinAccountFactory | \`0x9999999999999999999999999999999999999999\` | never read for Sepolia |\n`;
}

function tmpDoc(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "oilskin-deployments-"));
  const p = join(dir, "DEPLOYMENTS.md");
  writeFileSync(p, content);
  return p;
}

test("the committed docs/DEPLOYMENTS.md holds no Base Sepolia addresses yet, so the rehearsal suite skips by name", () => {
  const doc = readFileSync(DEPLOYMENTS_PATH, "utf8");
  assert.match(doc, /## Base Sepolia \(chain id 84532\)/);
  assert.equal(readSepoliaDeployment(), null, "an address appeared in the template — was a deployment recorded? then this test's expectation must flip");
});

test("a filled Base Sepolia table yields the four addresses and the block; the mainnet section is never read for it", () => {
  const dep = readSepoliaDeployment(tmpDoc(filled()));
  assert.deepEqual(dep, { factory: FACTORY, router: ROUTER, cbzec: CBZEC, aero: AERO, block: "46800000" });
});

test("one missing double (or the router) is null — the suite must not start a build without every address", () => {
  assert.equal(readSepoliaDeployment(tmpDoc(filled({ "AERO double (MockERC20)": "" }))), null);
  assert.equal(readSepoliaDeployment(tmpDoc(filled({ StrategyRouter: "`pending`" }))), null);
  assert.equal(readSepoliaDeployment(tmpDoc(filled({ deployedAtBlock: "" })))?.block, null, "a missing block is tolerated, reported as null");
});

test("a missing file or a file without the Sepolia section is null, never a throw", () => {
  assert.equal(readSepoliaDeployment("/nonexistent/DEPLOYMENTS.md"), null);
  assert.equal(readSepoliaDeployment(tmpDoc("# Deployments\n\n## Base mainnet (chain id 8453)\n\n| StrategyRouter | `0x9999999999999999999999999999999999999999` |\n")), null);
});

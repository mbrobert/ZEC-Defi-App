// The Solana surfaces' words: Kamino's quotation is exactly what the facts file recorded (a quotation, dated,
// attributed); Oilskin's own sentences cover every disclosure id the yield route can emit and every §8 addition.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BANNED_WORDS } from "../lib/copy";
import { KAMINO_WORDING, SOLANA_DISCLOSURES, SOLANA_KEEPER_NO_SELL, SOLANA_RISKS, solanaErrorPlain } from "../lib/solana/copy";
import { OILSKIN_SOLANA_IDL } from "../lib/solana/idl.generated";

test("Kamino's words are the facts file's blockquote, verbatim, with source and date", () => {
  const facts = readFileSync(join(__dirname, "../../docs/VERIFIED-SOLANA-FACTS.md"), "utf8");
  const start = facts.indexOf("## Kamino's own disclosure wording");
  const block = facts.slice(start).split("\n").filter((l) => l.startsWith("> ")).map((l) => l.slice(2).trim()).join(" ");
  assert.equal(KAMINO_WORDING.quote, block);
  assert.match(KAMINO_WORDING.source, /kamino\.com/);
  assert.match(KAMINO_WORDING.readAt, /^2026-09-12/);
  assert.match(KAMINO_WORDING.learnMore, /^https:\/\/z\.cash\//);
});

test("the quotation is rendered as a quotation, attributed, and only there", () => {
  const step = readFileSync(join(__dirname, "../components/solana/wizard/BridgedZecStep.tsx"), "utf8");
  assert.match(step, /<blockquote/);
  assert.match(step, /KAMINO_WORDING\.quote/);
  assert.match(step, /KAMINO_WORDING\.source/);
  // Oilskin's own sentences never borrow Kamino's words for what the token is NOT
  const ours = [...Object.values(SOLANA_DISCLOSURES).map((d) => d.body), ...SOLANA_RISKS.map((r) => r.body), SOLANA_KEEPER_NO_SELL.body].join(" ");
  for (const w of BANNED_WORDS) assert.doesNotMatch(ours, new RegExp(`\\b${w.replace(/[-\s]/g, "[-\\s]")}\\b`, "i"), w);
  assert.doesNotMatch(ours, /guarantee|risk-free|\bsafe\b|audited\b/i);
});

test("every disclosure id the yield route can name has words; the §8 additions are all said", () => {
  for (const id of ["forecast_not_advice", "bridged_zec", "kamino_parameters_mutable", "usdc_freezable", "program_exit_only", "borrow_rate_moves", "liquidation_at_chosen_hf"] as const) {
    assert.ok(SOLANA_DISCLOSURES[id].title.length > 3 && SOLANA_DISCLOSURES[id].body.length > 60, id);
  }
  const all = Object.values(SOLANA_DISCLOSURES).map((d) => d.body).join(" ");
  assert.match(all, /bridge program/i, "the mint is a bridge program's");
  assert.match(all, /upgraded by its operators/i);
  assert.match(all, /Circle/);
  assert.match(all, /market's owner can change/i);
  assert.match(all, /upgrade authority/i);
  assert.match(all, /Squads/);
  assert.match(all, /rate after your borrow/i);
  assert.ok(SOLANA_RISKS.some((r) => r.id === "keeper-sells" && /sell/i.test(r.body)), "decision 1: the keeper may sell");
  // the card that replaces it when the owner sets the sell budget to zero says the consequence, and is not in the default list
  assert.match(SOLANA_KEEPER_NO_SELL.body, /may not sell|sell budget is zero/i);
  assert.match(SOLANA_KEEPER_NO_SELL.body, /liquidates at a health factor of 1/i);
  assert.match(SOLANA_KEEPER_NO_SELL.body, /only you can/i);
  assert.equal(SOLANA_RISKS.some((r) => r.id === SOLANA_KEEPER_NO_SELL.id), false);
  assert.ok(SOLANA_RISKS.some((r) => r.id === "demo" && /446,506,191/.test(r.body)));
});

test("every program error has plain words or is shown by name", () => {
  for (const e of OILSKIN_SOLANA_IDL.errors) {
    const words = solanaErrorPlain(e.name);
    assert.ok(words.length > 10, e.name);
  }
  assert.match(solanaErrorPlain("InsufficientUsdcToClose"), /Top it up/);
  assert.match(solanaErrorPlain(null), /Nothing moved/);
});

test("the cross-chain loop's two disclosures are said: what Circle's part is, and that protection across two chains is not one transaction", () => {
  const circle = SOLANA_DISCLOSURES.cross_chain_circle;
  const chains = SOLANA_DISCLOSURES.cross_chain_two_chains;
  for (const d of [circle, chains]) assert.ok(d.title.length > 3 && d.body.length > 200, d.title);
  // Circle: the dependency, the wait, and who can finish it
  assert.match(circle.body, /Cross-Chain Transfer Protocol/);
  assert.match(circle.body, /attesters must sign/i);
  assert.match(circle.body, /standard path waits for Base to finalise/i);
  assert.match(circle.body, /can also refuse a particular account/i);
  assert.match(circle.body, /Anyone can deliver the message once it is signed/i, "the honest mitigation, not a promise");
  // Two chains: the five steps, the timing, and the reserve's reason
  assert.match(chains.body, /five steps on two chains/i);
  assert.match(chains.body, /not yet improving/i, "the worst case is stated, not hidden");
  assert.match(chains.body, /holds back USDC on Solana/i);
  // the bridge disclosure now carries the privacy point, without claiming any privacy of our own
  assert.match(SOLANA_DISCLOSURES.bridged_zec.body, /visible to anyone reading Solana/i);
  assert.match(SOLANA_DISCLOSURES.bridged_zec.body, /bridge operator sees the crossing/i);
  // both appear in the risk list a review screen renders
  const ids = SOLANA_RISKS.map((r) => r.id);
  assert.ok(ids.includes("cross-chain-circle") && ids.includes("cross-chain-two-chains"));
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { describeB20Probe } from "../dist/index.js";

const WAD = 10n ** 18n;

test("clear: multiplier 1.0 and a successful zero-amount self-transfer, with the limit stated", () => {
  const v = describeB20Probe({ multiplier: WAD, transfer: "ok", fromKnown: true });
  assert.equal(v.status, "clear");
  assert.equal(v.multiplierRatio, 1);
  assert.match(v.sentence, /multiplier reads 1\.0 \(no rebase applied\)/);
  assert.match(v.sentence, /not blocked and the token is not paused at this moment/);
  assert.match(v.sentence, /cannot see the issuer's policy beyond that/);
});

test("blocked: a refused self-transfer names the reason and tells the user not to send", () => {
  const v = describeB20Probe({ multiplier: WAD, transfer: "reverted", detail: "AccountBlocked", fromKnown: true });
  assert.equal(v.status, "blocked");
  assert.match(v.sentence, /refused \(AccountBlocked\)/);
  assert.match(v.sentence, /do not send cbZEC here until you know why/);
});

test("unknown: no wallet, or a simulation that did not come back, is never reported as clear", () => {
  const noWallet = describeB20Probe({ multiplier: WAD, transfer: "unavailable", fromKnown: false });
  assert.equal(noWallet.status, "unknown");
  assert.match(noWallet.sentence, /No wallet address to simulate a transfer from/);
  const down = describeB20Probe({ multiplier: null, transfer: "unavailable", detail: "rpc timeout", fromKnown: true });
  assert.equal(down.status, "unknown");
  assert.equal(down.multiplierRatio, null);
  assert.match(down.sentence, /multiplier could not be read/);
  assert.match(down.sentence, /\(rpc timeout\)/);
  // a multiplier that read but a transfer that succeeded without a multiplier is still not "clear"
  assert.equal(describeB20Probe({ multiplier: null, transfer: "ok", fromKnown: true }).status, "unknown");
});

test("a rebased multiplier is shown as a ratio, never hidden", () => {
  const v = describeB20Probe({ multiplier: (WAD * 105n) / 100n, transfer: "ok", fromKnown: true });
  assert.equal(v.multiplierRatio, 1.05);
  assert.match(v.sentence, /reads 1\.050000 \(balances are scaled by it\)/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { BASE_TOKENS } from "@zyo/shared";
import { probeB20Policy, type B20ProbeClient } from "../lib/b20";

const WAD = 10n ** 18n;
const ME = "0x1111111111111111111111111111111111111111" as const;
const CBZEC = BASE_TOKENS.cbZEC.address;

function client(opts: { multiplier?: bigint | Error; call?: "ok" | Error }): B20ProbeClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async readContract(c) {
      calls.push(c.functionName);
      if (opts.multiplier instanceof Error) throw opts.multiplier;
      return opts.multiplier ?? WAD;
    },
    async call(c) {
      calls.push(`call:${c.account}→${c.to}:${c.data.slice(0, 10)}`);
      if (opts.call instanceof Error) throw opts.call;
      return { data: "0x0000000000000000000000000000000000000000000000000000000000000001" };
    },
  };
}

test("probe: reads multiplier() and simulates transfer(from, 0) FROM the user's address; both fine → clear", async () => {
  const c = client({});
  const v = await probeB20Policy(c, CBZEC, ME);
  assert.equal(v.status, "clear");
  assert.equal(v.multiplierRatio, 1);
  assert.equal(c.calls[0], "multiplier");
  assert.match(c.calls[1], new RegExp(`^call:${ME}→${CBZEC}:0xa9059cbb$`), "an ERC-20 transfer selector, from the user, to the token");
  assert.match(v.sentence, /not blocked and the token is not paused at this moment/);
  assert.match(v.sentence, /cannot see the issuer's policy beyond that/);
});

test("probe: a reverting simulation is 'blocked' with the reason; an RPC failure is 'unknown'; no wallet is 'unknown' and skips the call", async () => {
  const blocked = await probeB20Policy(client({ call: new Error("execution reverted: AccountBlocked") }), CBZEC, ME);
  assert.equal(blocked.status, "blocked");
  assert.match(blocked.sentence, /refused \(execution reverted: AccountBlocked\)/);

  const down = await probeB20Policy(client({ call: new Error("fetch failed") }), CBZEC, ME);
  assert.equal(down.status, "unknown");
  assert.match(down.sentence, /did not come back \(fetch failed\)/);

  const c = client({});
  const noWallet = await probeB20Policy(c, CBZEC, null);
  assert.equal(noWallet.status, "unknown");
  assert.deepEqual(c.calls, ["multiplier"], "nothing to simulate from");

  const noMult = await probeB20Policy(client({ multiplier: new Error("boom") }), CBZEC, ME);
  assert.equal(noMult.status, "unknown", "a transfer that succeeds without a multiplier read is not clear");
  assert.match(noMult.sentence, /multiplier could not be read/);
});

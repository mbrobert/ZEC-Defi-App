import { test } from "node:test";
import assert from "node:assert/strict";
import { RegistryDecodeError, RegistrySource, SEL_ENTRY_HF_FLOOR_WAD } from "../src/sources/registry.js";
import type { RpcClient } from "../src/sources/rpc.js";

const REGISTRY = "0x5555555555555555555555555555555555555555" as const;
const word = (wad: bigint) => "0x" + wad.toString(16).padStart(64, "0");

function rpcWith(answer: string | Error, calls: { to: string; data: string }[] = []): RpcClient {
  return {
    ethCall: async (to: string, data: string) => {
      calls.push({ to, data });
      if (answer instanceof Error) throw answer;
      return answer;
    },
  } as unknown as RpcClient;
}

test("A4.4: the registry floor is one eth_call to entryHfFloorWad(), truncated to four decimals like every other wad the product reads", async () => {
  const calls: { to: string; data: string }[] = [];
  const src = new RegistrySource(rpcWith(word(1_250_000_000_000_000_000n), calls), REGISTRY, () => 1_700_000_000_000);
  const s = await src.entryHfFloor();
  assert.deepEqual(s, { floor: 1.25, wad: "1250000000000000000", sampledAt: "2023-11-14T22:13:20.000Z" });
  assert.deepEqual(calls, [{ to: REGISTRY, data: SEL_ENTRY_HF_FLOOR_WAD }]);
  assert.equal(SEL_ENTRY_HF_FLOOR_WAD, "0xe2baeb4e", "the selector the ABI bundle pins for entryHfFloorWad()");
  const truncated = await new RegistrySource(rpcWith(word(1_550_079_900_000_000_000n)), REGISTRY).entryHfFloor();
  assert.equal(truncated.floor, 1.55, "1.5500799 → 1.55, the same truncation as hfFromWad");
});

test("A4.4: a zero, short or failed read throws by name — the server keeps the last good floor or serves the shared constant, never a guess", async () => {
  await assert.rejects(() => new RegistrySource(rpcWith(word(0n)), REGISTRY).entryHfFloor(), (e: Error) => e instanceof RegistryDecodeError && /zero/.test(e.message));
  await assert.rejects(() => new RegistrySource(rpcWith("0x12"), REGISTRY).entryHfFloor(), (e: Error) => e instanceof RegistryDecodeError && /32-byte word/.test(e.message));
  await assert.rejects(() => new RegistrySource(rpcWith(word(500_000_000_000_000_000n)), REGISTRY).entryHfFloor(), /under 1\.0/);
  await assert.rejects(() => new RegistrySource(rpcWith(new Error("rpc down")), REGISTRY).entryHfFloor(), /rpc down/);
});

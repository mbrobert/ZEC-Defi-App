/** Local EVM primitives (kept dependency-free; align with viem's types). */

export type Hex = `0x${string}`;
export type Address = `0x${string}`;

export function isAddress(v: string): v is Address {
  return /^0x[0-9a-fA-F]{40}$/.test(v);
}

export function isHex(v: string): v is Hex {
  return /^0x[0-9a-fA-F]*$/.test(v);
}

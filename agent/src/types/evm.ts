/** Local EVM primitives (align with viem's `Address` / `Hex`). */

export type Hex = `0x${string}`;
export type Address = `0x${string}`;

export function isAddress(v: string): v is Address {
  return /^0x[0-9a-fA-F]{40}$/.test(v);
}

export function isHex(v: string): v is Hex {
  return /^0x[0-9a-fA-F]*$/.test(v);
}

export function lowerAddress(a: Address): Address {
  return a.toLowerCase() as Address;
}

export const MAX_UINT256 = (1n << 256n) - 1n;

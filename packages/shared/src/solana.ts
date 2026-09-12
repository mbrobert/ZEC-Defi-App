/**
 * Solana mainnet — every external program, account and mint the Solana module touches, typed.
 * SOURCE OF TRUTH: docs/VERIFIED-SOLANA-FACTS.md (read live 2026-09-12, slots 446,294,693 → 446,298,641).
 * Nothing may be added here that is not in that document; anything else must be probed on-chain first —
 * the same rule base.ts follows for Base.
 *
 * Deliberately carries NO LTV, NO liquidation threshold, NO rate: those are read from the Kamino reserve at
 * call time and passed into the pure functions in health.ts / collateral.ts. The only typed numbers are
 * decimals, Scope indices (they are configuration the reserve itself points at, re-read on every load and
 * asserted against these), and the dated snapshot in `KAMINO_ZCASH_SNAPSHOT_2026_09_12`, which exists so a
 * test can tell a re-read has drifted, never so code can skip the read.
 *
 * Addresses are base58 Solana public keys (32 bytes), not EVM hex; `isBase58Pubkey` in test/solana.test.ts
 * checks the alphabet and decoded length.
 */

/** A base58-encoded 32-byte Solana public key. */
export type SolanaAddress = string;

export const SOLANA_CLUSTER = {
  name: "Solana mainnet-beta",
  /** Public read endpoint, no key; the operator overrides it per deploy (SOLANA_RPC_URL). */
  rpcDefault: "https://api.mainnet-beta.solana.com",
  /** Public explorer for links in the UI — never used for data. */
  explorerUrl: "https://solscan.io",
} as const;

// ---------------------------------------------------------------------------
// Programs (all BPF-upgradeable; each has a live upgrade authority — see the facts file)
// ---------------------------------------------------------------------------

export const SOLANA_PROGRAMS = {
  /** Kamino Lend. */
  klend: "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD",
  /** Scope — Kamino's oracle aggregator; the reserves' `scopePrices` account is owned by it. */
  scope: "HFn8GnPADiny6XqUoWE8uRPPxb29ikn4yTuPa9MF2fWJ",
  /** Kamino Farms (the ZCASH reserves have no farms; the program is still an account in the CPI list). */
  farms: "FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr",
  /** The bridge token program that mints Solana ZEC through PDA(["authority"]). */
  bridgeTokenProgram: "dahPEoZGXfyV58JqqH85okdHmpN8U2q8owgPUXSCPxe",
  /** Wormhole core bridge — invoked alongside the bridge program in its transactions. */
  wormholeCore: "worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth",
  /** Metaplex token metadata (read only, for the ZEC name/symbol). */
  metaplexTokenMetadata: "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
  splToken: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  associatedToken: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  system: "11111111111111111111111111111111",
} as const satisfies Record<string, SolanaAddress>;

// ---------------------------------------------------------------------------
// Mints
// ---------------------------------------------------------------------------

export type SolanaTokenSymbol = "ZEC" | "USDC";

export interface SolanaTokenInfo {
  symbol: SolanaTokenSymbol;
  name: string;
  mint: SolanaAddress;
  decimals: number;
  /**
   * "bridged" — minted by an upgradeable bridge program through a PDA authority; no freeze authority.
   * "issuer"  — Circle-issued; a freeze authority exists and can freeze any token account.
   */
  kind: "bridged" | "issuer";
  /** Who can mint (a PDA for ZEC, Circle's key for USDC). */
  mintAuthority: SolanaAddress;
  /** null = nobody can freeze a holder's balance. */
  freezeAuthority: SolanaAddress | null;
}

export const SOLANA_TOKENS: Readonly<Record<SolanaTokenSymbol, SolanaTokenInfo>> = {
  ZEC: {
    symbol: "ZEC",
    name: "Zcash (bridged representation on Solana, minted by the OmniBridge token program)",
    mint: "A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS",
    decimals: 8,
    kind: "bridged",
    mintAuthority: "FvULawNPGBbuwYus74ECaQoV1oH9Tk6XPN7VPN51NYds",
    freezeAuthority: null,
  },
  USDC: {
    symbol: "USDC",
    name: "USD Coin",
    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    decimals: 6,
    kind: "issuer",
    mintAuthority: "BJE5MMbqXjVwjAF7oxwPYXnTXDyspzZyt4vwenNw5ruG",
    freezeAuthority: "7dGbd2QZcCKcTndnHcTL8q7SMVXAkp688NTQYwrRCrar",
  },
};

/** The seeds that derive the ZEC mint authority under the bridge program (proven 2026-09-12, bump 255). */
export const ZEC_MINT_AUTHORITY_SEEDS = ["authority"] as const;

// ---------------------------------------------------------------------------
// Kamino ZCASH market
// ---------------------------------------------------------------------------

export interface KaminoReserveRef {
  symbol: SolanaTokenSymbol;
  address: SolanaAddress;
  mint: SolanaAddress;
  liquiditySupplyVault: SolanaAddress;
  liquidityFeeVault: SolanaAddress;
  collateralMint: SolanaAddress;
  collateralSupplyVault: SolanaAddress;
  /** Scope price-chain indices the reserve points at (re-read and asserted, never trusted from here). */
  scopePriceChain: readonly number[];
  scopeTwapChain: readonly number[];
}

export const KAMINO_ZCASH_MARKET = {
  /** `LendingMarket` account; name "ZCASH Market"; curated by Allez Labs per kamino.com. */
  lendingMarket: "GBJ3bzUiMfwC9ugaF3MM68EXMDyTUb5UryRRAcVjEowd",
  /** The market's parameter authority — a real owner; every reserve parameter is theirs to change. */
  lendingMarketOwner: "A11EznxnJM3JrjUvAq16wqoVyPRNz522mdQm6mSmzMeR",
  /** Scope feed the reserves read (klend-sdk `SCOPE_MAINNET_KLEND_FEED`, NOT the Hubble feed). */
  scopeOraclePrices: "3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH",
  scopeOracleMappings: "4zh6bmb77qX2CL7t5AJYCqa6YqFafbz3QJNeFvZjLowg",
  reserves: {
    ZEC: {
      symbol: "ZEC",
      address: "6e8XcrdencrXBjXtTqYkRS63nS36petvzkV3gBf2ezbH",
      mint: "A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS",
      liquiditySupplyVault: "7muPXroaziH8RTD62Ea4gQ3NuAPZswf8Gj7iuPZ6Ae6Y",
      liquidityFeeVault: "3oxg1uptz3hSYvPiZEPW1UK2T2G5UUniyc2yjrszQC7R",
      collateralMint: "FQc32zaNbQnUZmQxd3Fqhg3enqfozyX6K74xcCCHw4NU",
      collateralSupplyVault: "8yr67socgzkzXYPMPC8KNCh8eLDPjGvqucLGXmCGdwq4",
      scopePriceChain: [430],
      scopeTwapChain: [429],
    },
    USDC: {
      symbol: "USDC",
      address: "EW9vT7g2VH2aTFfcbaXRUCbF7jEfaLwMiJpckwDZwUZd",
      mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      liquiditySupplyVault: "C7ipQ9XPEncrVhCLXfHE4aCXPSk1HpPQUr127RwgVG9h",
      liquidityFeeVault: "HwgFUiBaEHv2QnrpgVxPmWuUC5nqt7iGSna99ZQL8oTB",
      collateralMint: "HfwrP5s6bL8pGuqAQUGr6S79AEfyWm2F8W6WJkuXmT53",
      collateralSupplyVault: "GV12UJQSNK3cQPAGea9bHXcu7STuAadaCLeSwEKirWtQ",
      scopePriceChain: [13],
      scopeTwapChain: [456],
    },
  } satisfies Record<SolanaTokenSymbol, KaminoReserveRef>,
} as const;

/** klend PDA seed strings the module derives with (klend-sdk `utils/seeds.js`, 12.0.0). */
export const KLEND_SEEDS = {
  lendingMarketAuthority: "lma",
  userMetadata: "user_meta",
  reserveLiquiditySupply: "reserve_liq_supply",
  reserveCollateralMint: "reserve_coll_mint",
  reserveCollateralSupply: "reserve_coll_supply",
} as const;

/**
 * Dated snapshot of the parameters the facts file recorded. FOR DRIFT DETECTION ONLY: a reader that fetches
 * the reserve compares against these and reports a change; no surface derives an LTV, a threshold or a rate
 * from this object.
 */
export const KAMINO_ZCASH_SNAPSHOT_2026_09_12 = {
  readSlot: 446_298_641,
  readIso: "2026-09-12T00:57:19Z",
  zec: {
    loanToValuePct: 40,
    liquidationThresholdPct: 65,
    depositLimit: 13_000,
    borrowLimit: 0,
    minLiquidationBonusBps: 200,
    maxLiquidationBonusBps: 700,
    maxAgePriceSeconds: 180,
    maxAgeTwapSeconds: 240,
    heuristicUsd: { lower: 400, upper: 2_000 },
  },
  usdc: {
    borrowLimit: 2_000_000,
    depositLimit: 2_000_000,
    protocolTakeRatePct: 10,
    /** (utilisation bps, borrow APR bps), linear between points. */
    borrowRateCurve: [
      [0, 119],
      [5000, 279],
      [9000, 725],
      [9200, 897],
      [10000, 3860],
    ],
  },
  scope: {
    zecEntry: 430,
    zecEntryType: "MostRecentOf",
    zecSources: [407, 428],
    maxDivergenceBps: 1500,
    sourcesMaxAgeS: 7200,
  },
} as const;

/**
 * Kamino's piecewise-linear borrow curve: APR in bps at a utilisation in bps. Exported so the yield service's
 * pool-size gate and the tests price a projected borrow the same way (`VERIFIED-SOLANA-FACTS.md`, the
 * projection table). Points must be sorted by utilisation; repeated terminal points (Kamino pads the
 * 11-point array) are tolerated.
 */
export function kaminoCurveAprBps(points: readonly (readonly [number, number])[], utilizationBps: number): number {
  if (!Number.isInteger(utilizationBps) || utilizationBps < 0 || utilizationBps > 10_000) {
    throw new RangeError(`utilizationBps must be an integer in [0, 10000], got ${String(utilizationBps)}`);
  }
  const pts = points.filter((p, i) => i === 0 || p[0] !== points[i - 1][0] || p[1] !== points[i - 1][1]);
  if (pts.length === 0) throw new RangeError("empty curve");
  if (utilizationBps <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const [ua, ra] = pts[i - 1];
    const [ub, rb] = pts[i];
    if (ub < ua) throw new RangeError("curve points must be sorted by utilisation");
    if (utilizationBps <= ub) return ub === ua ? rb : ra + ((rb - ra) * (utilizationBps - ua)) / (ub - ua);
  }
  return pts[pts.length - 1][1];
}

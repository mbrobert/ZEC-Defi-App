/**
 * Disclosures and risk copy — BASE-PIVOT-2026-09.md §4 item 19, rewritten for
 * the Base-first reality. One list, rendered on Review, the dashboard and the
 * footer. Every sentence here is a fact about the code or the venues; nothing
 * claims a protection the contracts do not enforce.
 *
 * Words that may NOT appear anywhere in the product copy (test/copy.test.ts
 * enforces it across app/, components/ and lib/): the four in BANNED_WORDS.
 */

// The last two entries came from audit wave 2 (G-MED-1): the keeper grant permits a collateral
// withdraw into the account and a keeper-chosen swap quote, so neither absolute claim about what
// the keeper "cannot" do was true of the permission as signed.
export const BANNED_WORDS: readonly string[] = ["private", "shielded", "non-custodial", "locked payout address", "no operator custody", "no owner powers", "can never withdraw", "move a token on its own"];

export interface RiskItem {
  id: string;
  title: string;
  body: string;
  /** Which surfaces must show it. */
  scope: ("review" | "dashboard" | "onboard" | "spot" | "footer")[];
}

export const RISKS: readonly RiskItem[] = [
  {
    id: "custodial-entry",
    title: "Custodial entry for ZEC holders",
    body: "cbZEC only exists because Coinbase holds the ZEC behind it. Getting in and out goes through a Coinbase account. Coinbase knows the person, the amount and the destination address, and reserves sit in transparent addresses with no third-party attestation published.",
    scope: ["onboard", "review", "footer"],
  },
  {
    id: "kyc",
    title: "Identity verification",
    body: "Coinbase requires full KYC to wrap or unwrap. Exits are to transparent Zcash addresses only.",
    scope: ["onboard", "review"],
  },
  {
    id: "jurisdiction",
    title: "Jurisdiction",
    body: "cbZEC wrap/unwrap is excluded in 100+ jurisdictions — the EEA, Australia, Brazil, Singapore, Canada, Japan and New York among them. Only the US outside New York is confirmed. Buying cbZEC on Base and using cbBTC/WETH is unaffected.",
    scope: ["onboard", "review"],
  },
  {
    id: "b20",
    title: "cbZEC issuer powers (B20)",
    body: "cbZEC is a Base B20 precompile, not a plain ERC-20. The issuer can block transfers, burn blocked balances (seize, not merely freeze), pause, and rebase every balance through a live multiplier. Before you touch cbZEC here, Oilskin reads the live multiplier and simulates a zero-amount transfer from your address to itself, which tells you whether your address is blocked or the token is paused at that moment and nothing more: the issuer's policy itself is not readable, and it can change after the read. Contracts never cache a cbZEC balance.",
    scope: ["onboard", "review", "spot"],
  },
  {
    id: "peg",
    title: "cbZEC peg",
    body: "cbZEC's 1:1 value to ZEC is a Coinbase promise, not a mechanism. DEX depth is about $0.7M. In a Coinbase incident cbZEC can trade below ZEC, and a ZEC/USD oracle would overvalue it.",
    scope: ["onboard", "review", "spot"],
  },
  {
    id: "own-market",
    title: "Oilskin's own cbZEC market (v1.1, not live)",
    body: "No cbZEC lending market exists today, so cbZEC cannot be collateral. If Oilskin ships its own Morpho market, Oilskin sets the risk parameters and the market's lenders — possibly including Oilskin — bear bad debt if cbZEC's exit liquidity fails.",
    scope: ["review"],
  },
  {
    id: "liquidation",
    title: "Liquidation",
    body: "Borrowing USDC against cbBTC or WETH on the lending venue Oilskin's registry names for it (Aave v3 today) can be liquidated if the collateral price falls enough. The liquidation threshold is read from that venue at the moment you sign; the health factor, the price at which liquidation starts and each keeper rung are computed from it and shown before you sign. A liquidation sells collateral at a penalty set by the venue.",
    scope: ["review", "dashboard"],
  },
  {
    id: "il",
    title: "Impermanent loss",
    body: "A concentrated-liquidity position changes token mix as price moves and can be worth less than holding. The yield model applies an IL drag per width; a pool is only offered when emissions net of the performance fee still exceed the live borrow rate after that drag. The model is emissions-only — trading fees are not counted.",
    scope: ["review", "dashboard"],
  },
  {
    id: "keeper",
    title: "Keeper dependence",
    body: "Repayment from rewards, de-risking and emergency unwinds are performed by the Oilskin keeper through one permission you grant on your own account: it may call StrategyRouter.unwind and nothing else, within per-day token budgets, until the permission expires (30 days), and you can revoke it at any time. A warning at the first rung is a message, not an on-chain action — no permission produces it. If the keeper is down, or the permission has lapsed, nobody acts for you; you can always act yourself from your account.",
    scope: ["review", "dashboard"],
  },
  {
    id: "operator-powers",
    title: "What Oilskin's operator can still do",
    body: "Oilskin holds nothing between transactions and never takes your position: it is owned by your wallet through your own OilskinAccount. But the Oilskin registry has an owner, and that owner can disable an asset immediately (no new positions in it; exits are unaffected), change the entry health-factor floor immediately within its on-chain bounds, and replace the lending contract an asset points at after a fixed on-chain delay that is announced on chain before it can take effect. That delay is a warning, not a prohibition — it protects you only if somebody is watching and you act inside the window. Until that owner is a multisig with a published delay, treat these as real powers.",
    scope: ["review", "dashboard", "footer"],
  },
  {
    id: "engine",
    title: "LP engine",
    body: "LP positions run through the Snuggle/MaxFi engine, which takes its own 15% of realised LP earnings and rebalances positions on its own schedule. Oilskin's performance fee is taken on top of what the engine pays out, at claim or close, never on principal.",
    scope: ["review", "dashboard"],
  },
  {
    id: "contracts",
    title: "Smart-contract risk",
    body: "Your OilskinAccount, the router and the venue adapters are new code. Aave, Aerodrome, Snuggle, Permit2 and CoW are third-party contracts with their own risks. An external audit of the Oilskin contracts has not been completed.",
    scope: ["review", "dashboard", "spot", "footer"],
  },
  {
    id: "spot",
    title: "Spot orders via CoW",
    body: "A CoW order is a signed intent. It settles only if a solver fills it at or better than your limit before expiry; otherwise it expires with nothing spent. Oilskin never holds the tokens.",
    scope: ["spot"],
  },
  {
    id: "demo",
    title: "Demo mode",
    body: "With no wallet connected the app shows illustrative positions. Nothing is signed, nothing moves. Numbers in demo mode are a snapshot of chain reads from 2026-09-05 and are labelled as such.",
    scope: ["review", "dashboard", "spot", "footer"],
  },
];

export function risksFor(scope: RiskItem["scope"][number]): RiskItem[] {
  return RISKS.filter((r) => r.scope.includes(scope));
}

/** Short lines under the footer. */
export const FOOTER_LINES = [
  "Positions are owned by your wallet through your own OilskinAccount, and Oilskin holds nothing between transactions. Oilskin does choose which lending contract each asset uses; changing that choice takes a fixed on-chain delay and is announced before it can take effect.",
  "Performance fee only, on realised yield, capped on-chain. No deposit, withdrawal or management fee.",
] as const;

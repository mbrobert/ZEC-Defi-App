/**
 * "ZEC on Coinbase → cbZEC on Base" onboarding facts, from
 * docs/BASE-PIVOT-2026-09.md §1 (read 2026-09-05). Anything not stated there
 * is marked unpublished/unverified rather than guessed.
 */

export type Eligibility =
  | { status: "eligible"; reason: string }
  | { status: "excluded"; reason: string }
  | { status: "unverified"; reason: string }
  | { status: "unknown"; reason: string };

/** Jurisdictions Coinbase has excluded from cbZEC wrap/unwrap (BASE-PIVOT §1). */
export const EXCLUDED_REGIONS: readonly { code: string; label: string }[] = [
  { code: "EEA", label: "European Economic Area (all member states)" },
  { code: "AU", label: "Australia" },
  { code: "BR", label: "Brazil" },
  { code: "SG", label: "Singapore" },
  { code: "CA", label: "Canada" },
  { code: "JP", label: "Japan" },
  { code: "US-NY", label: "United States — New York" },
];

export const US_STATES: readonly { code: string; name: string }[] = [
  ["AL", "Alabama"], ["AK", "Alaska"], ["AZ", "Arizona"], ["AR", "Arkansas"], ["CA", "California"],
  ["CO", "Colorado"], ["CT", "Connecticut"], ["DE", "Delaware"], ["DC", "District of Columbia"],
  ["FL", "Florida"], ["GA", "Georgia"], ["HI", "Hawaii"], ["ID", "Idaho"], ["IL", "Illinois"],
  ["IN", "Indiana"], ["IA", "Iowa"], ["KS", "Kansas"], ["KY", "Kentucky"], ["LA", "Louisiana"],
  ["ME", "Maine"], ["MD", "Maryland"], ["MA", "Massachusetts"], ["MI", "Michigan"], ["MN", "Minnesota"],
  ["MS", "Mississippi"], ["MO", "Missouri"], ["MT", "Montana"], ["NE", "Nebraska"], ["NV", "Nevada"],
  ["NH", "New Hampshire"], ["NJ", "New Jersey"], ["NM", "New Mexico"], ["NY", "New York"],
  ["NC", "North Carolina"], ["ND", "North Dakota"], ["OH", "Ohio"], ["OK", "Oklahoma"], ["OR", "Oregon"],
  ["PA", "Pennsylvania"], ["RI", "Rhode Island"], ["SC", "South Carolina"], ["SD", "South Dakota"],
  ["TN", "Tennessee"], ["TX", "Texas"], ["UT", "Utah"], ["VT", "Vermont"], ["VA", "Virginia"],
  ["WA", "Washington"], ["WV", "West Virginia"], ["WI", "Wisconsin"], ["WY", "Wyoming"],
].map(([code, name]) => ({ code, name }));

export const COUNTRY_OPTIONS: readonly { code: string; name: string }[] = [
  { code: "US", name: "United States" },
  { code: "GB", name: "United Kingdom" },
  { code: "EEA", name: "EU / EEA member state" },
  { code: "CA", name: "Canada" },
  { code: "AU", name: "Australia" },
  { code: "BR", name: "Brazil" },
  { code: "SG", name: "Singapore" },
  { code: "JP", name: "Japan" },
  { code: "OTHER", name: "Somewhere else" },
];

/**
 * The jurisdiction check shown BEFORE the three steps. Only the US outside
 * New York is known-eligible; the UK is unverified; the listed regions are
 * excluded; everywhere else is unknown (Coinbase excludes 100+ jurisdictions
 * and has not published the full list).
 */
export function cbZecEligibility(country: string, usState?: string): Eligibility {
  switch (country) {
    case "US":
      if (!usState) return { status: "unknown", reason: "Choose your state — New York is excluded." };
      if (usState === "NY")
        return {
          status: "excluded",
          reason: "Coinbase does not offer cbZEC wrap or unwrap to New York residents.",
        };
      return {
        status: "eligible",
        reason: "US outside New York is the one region Coinbase has confirmed for cbZEC wrap/unwrap.",
      };
    case "GB":
      return {
        status: "unverified",
        reason: "The UK is not on the published exclusion list, but Coinbase has not confirmed it either. Check the Coinbase app before sending anything.",
      };
    case "EEA":
    case "CA":
    case "AU":
    case "BR":
    case "SG":
    case "JP":
      return {
        status: "excluded",
        reason: `${COUNTRY_OPTIONS.find((c) => c.code === country)?.name ?? country} is on Coinbase's exclusion list for cbZEC wrap/unwrap.`,
      };
    default:
      return {
        status: "unknown",
        reason: "Coinbase excludes cbZEC wrap/unwrap in 100+ jurisdictions and has not published the full list. Check the Coinbase app before sending anything.",
      };
  }
}

export interface OnboardStep {
  n: number;
  title: string;
  body: string;
  facts: string[];
}

export const ONBOARD_STEPS: readonly OnboardStep[] = [
  {
    n: 1,
    title: "Move ZEC into your Coinbase account",
    body: "Deposit ZEC to your Coinbase ZEC balance. The deposit address is a transparent t-address; a z-address balance can send to it directly — the transfer lands as an ordinary transparent deposit.",
    facts: [
      "Coinbase requires full identity verification (KYC) before you can deposit or withdraw.",
      "Coinbase will know who you are, how much you sent, and where the cbZEC goes next.",
    ],
  },
  {
    n: 2,
    title: 'In the Coinbase app choose "Send ZEC on Base"',
    body: "Enter the Base address of the wallet you will connect here. Coinbase sends cbZEC — Coinbase Wrapped ZEC, 1:1 backed by ZEC in Coinbase custody — to that address on Base.",
    facts: [
      "This is the only door: there is no on-chain mint and no contract anyone else can call.",
      "Fees, minimums and confirmation counts are unpublished by Coinbase.",
    ],
  },
  {
    n: 3,
    title: "Connect that wallet here and check the token",
    body: "Connect the same wallet. Before you do anything with it, confirm the token address your wallet shows matches the pinned cbZEC address below.",
    facts: [
      "Going back to ZEC is the reverse: send cbZEC to Coinbase, it unwraps to a ZEC balance, withdraw ZEC — to transparent addresses only.",
      "cbZEC is a Base-native B20 token: the issuer can block transfers, burn blocked balances, pause, and rebase balances via a live multiplier.",
    ],
  },
];

/** What a cbZEC holder can and cannot do in v1 (never claim more than the code enforces). */
export const CBZEC_V1_CAPABILITIES = {
  spot: { available: true, note: "Swap cbZEC ↔ USDC via CoW on Base." },
  lp: {
    available: false,
    note: "The Aerodrome cbZEC/USDC gauge received its first emissions vote in the epoch that began 2026-09-10 (0.08% of the Voter; re-voted weekly). The LP engine lists no cbZEC pool and the swap router Oilskin verified cannot reach that pool, so cbZEC LP is not offered; the options are in docs/CBZEC-PATH-2026-09.md.",
  },
  collateral: {
    available: false,
    note: "No lending market on Base accepts cbZEC yet. Planned for v1.1 behind a liquidity gate.",
  },
} as const;

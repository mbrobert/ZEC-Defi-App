/**
 * What the keeper may actually do for you, right now — read from your own
 * account, not asserted by the product.
 *
 * The UI used to promise a four-rung protection ladder beside every position
 * while the grant it asked you to sign could not honour it. Two things made
 * that possible and both are fixed here:
 *
 *   • the grant is now the ONE root call the keeper plans (StrategyRouter
 *     `unwind`) with `allowCallback: true`. Without that flag every keeper
 *     dispatch reverts `NotActivePeripheral` INSIDE the router — the keeper
 *     broadcasts nothing while the position rides to liquidation, and nothing
 *     on the old screen would have told you;
 *   • the grant EXPIRES. A 30-day permission that lapsed on day 31 looked
 *     exactly like a live one. Expiry, the remaining days, the per-token
 *     budgets and what is already spent in this window are all read back and
 *     shown.
 *
 * `describeGrant` is pure so the wording is testable.
 */
import type { Address, Hex } from "viem";
import { BASE_TOKENS, HF_LADDER, type HfRung } from "@zyo/shared";

export interface KeeperTokenBudget {
  token: Address;
  symbol: string;
  amountPerPeriod: bigint;
  /** Period-rolled: what the chain would actually refuse against, not a lifetime total. */
  spent: bigint;
}

export interface KeeperGrantRead {
  keeper: Address;
  target: Address;
  selector: Hex;
  active: boolean;
  maxValuePerPeriod: bigint;
  valueSpent: bigint;
  /** Unix seconds. */
  period: number;
  expiry: number;
  periodStart: number;
  allowCallback: boolean;
  tokens: KeeperTokenBudget[];
  readAt: string;
}

/**
 * The keeper warns and notifies inside this window (`GRANT_EXPIRY_WARN_S`,
 * 7 days, in agent/src/config.ts). The UI turns amber at the same point so the
 * two never disagree about when protection is "about to lapse".
 */
export const GRANT_EXPIRY_WARN_DAYS = 7;

export type KeeperStatusKind =
  | "not-configured"
  | "venue-unsupported"
  | "not-granted"
  | "expired"
  | "cannot-act"
  | "no-budget"
  | "active";

export interface KeeperStatus {
  kind: KeeperStatusKind;
  /** Short label for a chip. */
  label: string;
  /** ONE plain sentence a first-time user can act on. */
  plain: string;
  tone: "good" | "warn" | "crit" | "mute";
  /** Whole days left before the grant expires; null when there is no live grant. */
  daysLeft: number | null;
  /** The rungs this grant can actually be acted on, and the ones it cannot. */
  rungsCovered: HfRung[];
  rungsUncovered: HfRung[];
}

/**
 * The rungs a `StrategyRouter.unwind` grant can serve. `unwind` repays and/or
 * closes, so it covers every rung whose action is repay / de-risk / emergency;
 * `notify` is not an on-chain action at all — nobody signs anything for a
 * warning, and the product must not imply the grant is what produces it.
 */
export const RUNGS_SERVED_BY_UNWIND: readonly HfRung[] = HF_LADDER.filter((r) => r.action !== "notify");
export const RUNGS_NOT_ON_CHAIN: readonly HfRung[] = HF_LADDER.filter((r) => r.action === "notify");

export function describeGrant(
  grant: KeeperGrantRead | null,
  opts: {
    keeperConfigured: boolean;
    nowSeconds: number;
    /**
     * False when the registry points this position's collateral at a venue that does not answer
     * the venue interface the keeper reads (audit wave 2, M-HIGH-2). Outranks a live grant: the
     * permission is real, the protection is not.
     */
    venueSupported?: boolean;
    /**
     * Every token the account's live LP positions can pay out on close. A live pool token with
     * no budget line means the keeper's swap approve is refused and no rung can run — the grant
     * must not be called "active" then (audit wave 2, G-HIGH-1).
     */
    livePoolTokens?: readonly { address: Address; symbol: string }[];
  },
): KeeperStatus {
  const base = { rungsCovered: [] as HfRung[], rungsUncovered: [...RUNGS_SERVED_BY_UNWIND] };
  if (!opts.keeperConfigured) {
    return {
      ...base,
      kind: "not-configured",
      label: "no keeper",
      tone: "mute",
      daysLeft: null,
      plain: "No Oilskin keeper is configured for this site, so nothing watches this position for you. You can always repay or close it yourself from your account.",
    };
  }
  if (opts.venueSupported === false) {
    return {
      ...base,
      kind: "venue-unsupported",
      label: "venue not watched",
      tone: "crit",
      daysLeft: null,
      plain:
        "The lending contract behind this collateral does not answer the venue interface the Oilskin keeper reads, so the keeper cannot see this position and nothing watches it — even if a permission is granted. " +
        "You can always repay or close it yourself from your account.",
    };
  }
  if (!grant || !grant.active) {
    return {
      ...base,
      kind: "not-granted",
      label: "not granted",
      tone: "warn",
      daysLeft: null,
      plain: "You have not given the Oilskin keeper permission to act on this position, so nobody will reduce it for you if your health factor falls. You can grant it at any time, and revoke it at any time.",
    };
  }
  const secondsLeft = grant.expiry - opts.nowSeconds;
  if (secondsLeft <= 0) {
    return {
      ...base,
      kind: "expired",
      label: "expired",
      tone: "crit",
      daysLeft: 0,
      plain: "The permission you gave the Oilskin keeper has expired, so it can no longer act on this position — nobody will reduce it for you if your health factor falls. Grant it again to restore protection.",
    };
  }
  const daysLeft = Math.floor(secondsLeft / 86_400);
  if (!grant.allowCallback) {
    return {
      ...base,
      kind: "cannot-act",
      label: "cannot act",
      tone: "crit",
      daysLeft,
      plain: "The permission on your account is missing the flag the router needs to act back on it, so every keeper attempt would fail on chain and nothing would happen. Grant the permission again from here to fix it.",
    };
  }
  if (grant.tokens.length === 0 || grant.tokens.every((t) => t.amountPerPeriod === 0n)) {
    return {
      ...base,
      kind: "no-budget",
      label: "no budget",
      tone: "crit",
      daysLeft,
      plain: "The keeper has permission but no daily token budget, so any attempt to repay or close would be refused by your own account. Grant the permission again from here to fix it.",
    };
  }
  const budgeted = (addr: string) => grant.tokens.some((g) => g.token.toLowerCase() === addr.toLowerCase() && g.amountPerPeriod > 0n);
  const missing = (opts.livePoolTokens ?? []).filter((t) => t.address.toLowerCase() !== BASE_TOKENS.USDC.address.toLowerCase() && !budgeted(t.address));
  if (missing.length > 0) {
    const names = missing.map((m) => m.symbol).join(" and ");
    return {
      ...base,
      kind: "no-budget",
      label: `no ${names} budget`,
      tone: "crit",
      daysLeft,
      plain: `The keeper's permission has no daily budget for ${names}, which your liquidity position pays out when it closes, so every attempt to reduce or close it would be refused by your own account. Grant the permission again from here to fix it.`,
    };
  }
  return {
    kind: "active",
    label: `active · ${daysLeft} day${daysLeft === 1 ? "" : "s"} left`,
    tone: daysLeft <= GRANT_EXPIRY_WARN_DAYS ? "warn" : "good",
    daysLeft,
    plain:
      `The Oilskin keeper may make one kind of call on your account — reduce or close this position — until ${new Date(grant.expiry * 1000).toISOString().slice(0, 10)}` +
      `${daysLeft <= GRANT_EXPIRY_WARN_DAYS ? ", which is very soon; re-grant it to keep the protection" : ""}. It cannot open, borrow, sweep or pay anyone but your own account; it can withdraw collateral only into your account and only while the health-factor floor holds; and you can revoke it at any time.`,
    rungsCovered: [...RUNGS_SERVED_BY_UNWIND],
    rungsUncovered: [...RUNGS_NOT_ON_CHAIN],
  };
}

/** True when the grant on chain is the one this build asks users to sign. */
export function grantMatchesPlan(grant: KeeperGrantRead | null, expected: { router: Address; selector: Hex; keeper: Address }): boolean {
  if (!grant) return false;
  return (
    grant.active &&
    grant.allowCallback &&
    grant.target.toLowerCase() === expected.router.toLowerCase() &&
    grant.selector.toLowerCase() === expected.selector.toLowerCase() &&
    grant.keeper.toLowerCase() === expected.keeper.toLowerCase()
  );
}

/** What the keeper does at each rung, phrased for someone who has never used DeFi. */
export function rungPlain(rung: HfRung, collateral: string): string {
  switch (rung.action) {
    case "notify":
      return `you are told your position is getting close to trouble — nothing is signed or moved`;
    case "repay":
      return `part of your loan is repaid from what the position has earned`;
    case "derisk":
      return `part of the position is closed and the proceeds repay your loan`;
    case "emergency-unwind":
      return `the position is closed, the loan repaid and your ${collateral} returned to you`;
  }
}

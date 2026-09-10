/**
 * The exact calls a user signs — built from the wizard selection so Review
 * prints them verbatim and Sign sends them in order. Calling convention from
 * CONTRACT-ABI-DELTA.md (encoded ONLY from the generated ABI):
 *
 *   first-time user:   factory.createAccountAndExec([{router, 0, open…, callback: true}])
 *   existing account:  account.execWithCallback(router, 0, open…)
 *   hold (no LP):      StrategyRouter.openBorrowOnly — NOT a hand-built
 *                      execBatch([permit2, supply, borrow]). That batch used to
 *                      skip the entry health-factor floor and opened first-time
 *                      users at HF 1.07 against an advertised 1.55; the venue
 *                      now enforces the floor itself, so the batch reverts.
 *   unwind:            account.execWithCallback(router, 0, unwind(u))
 *   claim:             account.execBatch([lpVenue.claim(ids, band, deadline), router.sweep(tokens)])
 *                      — both with callback: true
 *   keeper protection: account.grant(keeper, Permission{router, unwind, …, allowCallback: true})
 *
 * `callback` is the peripheral opt-in and defaults FALSE: a plain `exec` gives
 * the target NO rights over the account. The router, the venues and the swap
 * adapter act back on the account, so they need it; a token, a pool or Permit2
 * never does and never gets it.
 *
 * The Permit2 SPENDER is the account address (predicted by factory.accountOf
 * before it exists). Every wallet prompt carries one plain sentence (`plain`)
 * for a user who has never used DeFi, and every hex value in `args` is
 * labelled. Nothing is signable until the addresses come from a deployment.
 */
import { encodeAbiParameters, encodeFunctionData, maxUint256, type Address, type Hex } from "viem";
import { RANGE_WIDTH_BOUNDS, lpParamsToChain, type CollateralSymbol, type LpParams } from "@zyo/shared";
import { BASE_TOKENS, COLLATERAL_ASSETS, PERMIT2, CHAIN_ID } from "./chain";
import { ERC20_ABI } from "./abi/aave";
import { ABI_STATUS, ACCOUNT_ABI, FACTORY_ABI, LP_VENUE_ABI, ROUTER_ABI, SELECTORS } from "./abi/oilskin";
import { toAtomic } from "./math";
import type { PriceBand } from "./tickmath";

export const DEADLINE_MINUTES = 20;
/** Product policy: price may move this much between quote and execution before the venue refuses (Simple mode). */
export const DEFAULT_BAND_TOLERANCE_BPS = 100;
/** Advanced mode may widen the band up to this; beyond it the UI refuses (a sandwich would eat the difference). */
export const MAX_BAND_TOLERANCE_BPS = 300;
/** AerodromeSwapAdapter.MAX_SLIPPAGE_BPS — the hard on-chain cap on a swap's tolerance. */
export const CHAIN_MAX_SLIPPAGE_BPS = 500;
/** Product cap on the swap tolerance we will build. Tighter than the chain's, on purpose. */
export const MAX_SWAP_SLIPPAGE_BPS = MAX_BAND_TOLERANCE_BPS;
/** Keeper protection grant window (seconds) and expiry (days). */
export const KEEPER_GRANT_PERIOD_S = 86_400;
export const KEEPER_GRANT_EXPIRY_DAYS = 30;

/** The exact selector the keeper grant authorises, read from the generated ABI — never typed. */
export const UNWIND_SIGNATURE = "unwind((address,uint256[],(uint160,uint160),(uint256,uint256,uint16,bytes),uint256,uint256,uint256))" as const;
export const UNWIND_SELECTOR: Hex = SELECTORS.StrategyRouter[UNWIND_SIGNATURE];

/** What the deployment looks like from the web's side. Read from chain via readDeployment(); DEMO_DEPLOYMENT in demo mode. */
export interface Deployment {
  factory: Address;
  router: Address;
  registry: Address;
  lpVenue: Address;
  aaveVenue: Address;
  /** AerodromeSwapAdapter — the contract that enforces the swap floor (router.SWAP()). */
  swapAdapter: Address;
  engine: Address;
  keeper: Address | null;
  /**
   * Collateral assets the registry points at a venue this app (and the keeper) cannot read through
   * `ICollateralVenue`. Account reads go through that interface to every venue the registry names,
   * so this is non-empty only for a venue that does not answer it; a position there is invisible
   * here and to the keeper, which refuses to start on it (audit wave 2, M-HIGH-2). Empty = every
   * enabled asset resolves to a venue that answers — the Aave venue, the Morpho venue, or another.
   */
  unsupportedVenues: CollateralSymbol[];
  /** True for the synthetic demo deployment (never signable). */
  demo: boolean;
}

export interface WriteSpec {
  address: Address;
  abi: readonly unknown[];
  functionName: string;
  args: readonly unknown[];
  data: Hex;
}

export interface PlannedCall {
  step: number;
  kind: "approve" | "permit-signature" | "open" | "unwind" | "claim" | "grant" | "revoke";
  /** What the wallet will show: a transaction (costs gas) or a signature (free, no transaction). */
  wallet: "transaction" | "signature";
  title: string;
  /** ONE plain sentence for a first-time user, shown before the wallet prompt. */
  plain: string;
  to: Address | null;
  /** Human label for `to` — a hex address is never shown alone. */
  toLabel: string;
  functionName: string;
  /** Every argument labelled; hex values carry their meaning in `value`. */
  args: { name: string; value: string }[];
  /** Technical detail for Advanced mode. */
  note: string;
  required: boolean;
  encodable: boolean;
  /** Calldata of the wallet transaction when it is fully known before signing. */
  data?: Hex;
}

const ZERO32 = `0x${"0".repeat(64)}` as Hex;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const utc = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";

/**
 * One entry of an `execBatch` / `createAccountAndExec` list.
 * `callback` FALSE = a plain call: the target gets no rights over the account.
 * Only set it true for code that must act back on the account (router, venues,
 * swap adapter). CONTRACT-ABI-DELTA §1.
 */
export interface AccountCall {
  target: Address;
  value: bigint;
  data: Hex;
  callback: boolean;
}

export function plainCall(target: Address, data: Hex): AccountCall {
  return { target, value: 0n, data, callback: false };
}
export function peripheralCall(target: Address, data: Hex): AccountCall {
  return { target, value: 0n, data, callback: true };
}

// ---------------------------------------------------------------------------
// Swap quote (unwind)
// ---------------------------------------------------------------------------

/**
 * The quote the router hands the swap adapter. There is no longer any way to
 * say "accept one base unit": the adapter enforces
 * `amountIn × quotedOut / quotedIn × (10000 − maxSlippageBps) / 10000` on the
 * amount actually swapped, and reverts `ZeroQuote()` on a zero.
 */
export interface SwapQuote {
  /** Input the quote was taken for, base units of the non-USDC pool token. */
  quotedIn: bigint;
  /** USDC that quote promised for `quotedIn`, base units. */
  quotedOut: bigint;
  /** Tolerance below the quoted rate, bps. Capped at 500 on chain, at MAX_SWAP_SLIPPAGE_BPS here. */
  maxSlippageBps: number;
  /** abi.encode(int24 tickSpacing) for Slipstream. */
  routeData: Hex;
}

/** Everything the UI needs to SHOW a quote honestly, beside the four fields the chain sees. */
export interface QuotedSwap extends SwapQuote {
  tokenSymbol: string;
  tokenAddress: Address;
  tokenDecimals: number;
  tickSpacing: number;
  /** Where the price came from. */
  source: "aave-oracle" | "pool-spot";
  /** |pool − oracle| / oracle when both were readable; null when only one was. */
  crossCheckDelta: number | null;
  /** AerodromeSwapAdapter.minOutFor(quotedIn, quotedIn, quotedOut, maxSlippageBps) — READ from the adapter, not recomputed. */
  minOutForQuotedIn: bigint;
}

export function validateSwapQuote(q: SwapQuote): string[] {
  const errs: string[] = [];
  if (q.quotedIn <= 0n) errs.push("The swap quote has no input amount.");
  if (q.quotedOut <= 0n) errs.push("The swap quote has no output amount.");
  if (!Number.isInteger(q.maxSlippageBps) || q.maxSlippageBps < 1) errs.push("The swap tolerance must be at least 0.01%.");
  if (q.maxSlippageBps > MAX_SWAP_SLIPPAGE_BPS) errs.push(`The swap tolerance must be at most ${MAX_SWAP_SLIPPAGE_BPS / 100}% (the chain refuses above ${CHAIN_MAX_SLIPPAGE_BPS / 100}%).`);
  if (q.routeData === "0x") errs.push("The pool's tick spacing has not been read yet.");
  return errs;
}

export function encodeRouteData(tickSpacing: number): Hex {
  return encodeAbiParameters([{ type: "int24" }], [tickSpacing]);
}

/** Human amount from base units, for labelling a quote. */
function human(atomic: bigint, decimals: number, dp = 6): string {
  const neg = atomic < 0n;
  const a = neg ? -atomic : atomic;
  const base = 10n ** BigInt(decimals);
  const whole = a / base;
  const frac = (a % base).toString().padStart(decimals, "0").slice(0, dp).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole.toString()}${frac ? `.${frac}` : ""}`;
}

// ---------------------------------------------------------------------------
// Open (LP or hold)
// ---------------------------------------------------------------------------

export interface OpenPlanInput {
  owner: Address;
  strategy: "lp" | "hold";
  accountDeployed: boolean;
  predictedAccount: Address | null;
  collateral: CollateralSymbol;
  collateralAmount: string;
  borrowUsdc: number;
  /** Engine pool (bytes32) — required for "lp". */
  enginePoolId?: `0x${string}`;
  poolLabel?: string;
  lpParams: LpParams;
  /** Current allowance of the collateral token to Permit2, if known. */
  permit2Allowance?: bigint;
  deployment: Deployment | null;
  /** Unix seconds. */
  deadline: number;
  /** Price band tolerance for the LP deposit, bps of price. */
  bandToleranceBps: number;
  /** Ask for the keeper protection grant after opening. */
  keeperProtection: boolean;
  /** Entry health factor the venue will check against the registry floor, for the plain sentence. */
  entryHf?: number;
}

export function buildOpenPlan(i: OpenPlanInput): PlannedCall[] {
  const asset = COLLATERAL_ASSETS[i.collateral];
  const collateralAtomic = toAtomic(i.collateralAmount, asset.decimals);
  const borrowAtomic = toAtomic(i.borrowUsdc.toFixed(BASE_TOKENS.USDC.decimals), BASE_TOKENS.USDC.decimals);
  const chainLp = lpParamsToChain(i.lpParams);
  if (i.strategy === "lp" && !i.enginePoolId) throw new RangeError("lp strategy needs an engine pool id");
  const d = i.deployment;
  const abiOk = ABI_STATUS === "verified" && !!d && !d.demo;
  const account = i.predictedAccount;
  const hold = i.strategy === "hold";
  const calls: PlannedCall[] = [];
  let step = 1;
  const deadlineIso = utc(i.deadline);
  const usdcText = `${i.borrowUsdc.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })} USDC`;

  const needsApprove = i.permit2Allowance === undefined || i.permit2Allowance < collateralAtomic;
  calls.push({
    step: step++,
    kind: "approve",
    wallet: "transaction",
    title: `Allow Permit2 to move your ${asset.symbol} (one time)`,
    plain: `You are letting the standard Permit2 contract move ${asset.symbol} out of your wallet — but only when you later sign for an exact amount, so nothing moves in this step.`,
    to: asset.address,
    toLabel: `${asset.symbol} token contract`,
    functionName: "approve",
    args: [
      { name: "spender", value: `Permit2 (${short(PERMIT2)}, the canonical Uniswap Permit2)` },
      { name: "amount", value: "unlimited (standard for Permit2; every actual pull still needs your signature)" },
    ],
    note: "Standard ERC-20 approve(Permit2, max). Skipped automatically when the allowance already covers the amount.",
    required: needsApprove,
    encodable: true,
    data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [PERMIT2, maxUint256] }),
  });

  calls.push({
    step: step++,
    kind: "permit-signature",
    wallet: "signature",
    title: `Sign for exactly ${i.collateralAmount} ${asset.symbol} to enter your Oilskin account`,
    plain: `This is a signature, not a transaction — it costs nothing and lets your own Oilskin account pull exactly ${i.collateralAmount} ${asset.symbol} from your wallet, once, before ${deadlineIso}.`,
    to: PERMIT2,
    toLabel: "Permit2 (signature only, no transaction)",
    functionName: "PermitTransferFrom (EIP-712)",
    args: [
      { name: "token", value: `${asset.symbol} (${short(asset.address)})` },
      { name: "amount", value: `${i.collateralAmount} ${asset.symbol} (${collateralAtomic} base units)` },
      { name: "spender", value: account ? `your Oilskin account (${short(account)})` : "your Oilskin account (address known once the factory is configured)" },
      { name: "deadline", value: deadlineIso },
    ],
    note: "Single-use unordered nonce; amount-bounded; expires at the deadline. Spender = the account address predicted by factory.accountOf(wallet).",
    required: true,
    encodable: !!account,
  });

  const sharedArgs = [
    { name: "collateralAsset", value: `${asset.symbol} (${short(asset.address)})` },
    { name: "collateralAmount", value: `${i.collateralAmount} ${asset.symbol} (${collateralAtomic} base units)` },
    { name: "permit", value: "the signature from the previous step (nonce, deadline, signature)" },
    { name: "borrowAmount", value: `${usdcText} (${borrowAtomic} base units)` },
  ];
  const openArgs = hold
    ? [
        ...sharedArgs,
        { name: "deadline", value: deadlineIso },
        { name: "entry health-factor floor", value: `the Aave venue refuses the borrow if it would leave you below the registry's floor${i.entryHf ? ` — this position opens at ${i.entryHf.toFixed(2)}` : ""}` },
      ]
    : [
        ...sharedArgs,
        { name: "poolId", value: `${i.poolLabel ?? "pool"} — engine pool id ${short(i.enginePoolId ?? ZERO32)}` },
        { name: "rangeWidthBps", value: `${chainLp.rangeWidthBps} (total tick span; on-chain bounds ${RANGE_WIDTH_BOUNDS.min}–${RANGE_WIDTH_BOUNDS.max})` },
        { name: "rebalanceDelay", value: `${chainLp.rebalanceDelay} seconds (${i.lpParams.rebalanceDelayHours} h)` },
        { name: "autoCompound", value: chainLp.autoCompound ? "on" : "off" },
        { name: "band", value: `pool price ±${(i.bandToleranceBps / 100).toFixed(2)}% around the live price read just before you sign; the deposit refuses if the price has moved further` },
        { name: "deadline", value: deadlineIso },
      ];

  const viaFactory = !i.accountDeployed;
  const routerFn = hold ? "StrategyRouter.openBorrowOnly" : "StrategyRouter.openLeveragedLp";
  calls.push({
    step: step++,
    kind: "open",
    wallet: "transaction",
    title: viaFactory
      ? hold
        ? "Create your account, move the collateral in, supply it and borrow — one transaction"
        : "Create your account and open the position — one transaction"
      : hold
        ? "Move the collateral in, supply it and borrow — one transaction"
        : "Open the position — one transaction",
    plain: viaFactory
      ? `One transaction that creates your Oilskin account, moves ${i.collateralAmount} ${asset.symbol} into it, supplies it to Aave, borrows ${usdcText}${hold ? " and keeps the USDC in your account" : ` and puts that USDC to work in ${i.poolLabel ?? "the pool"}`}; if anything along the way fails, the whole thing is undone and nothing is spent but the network fee.`
      : `One transaction that moves ${i.collateralAmount} ${asset.symbol} into your Oilskin account, supplies it to Aave, borrows ${usdcText}${hold ? " and keeps the USDC in your account" : ` and puts that USDC to work in ${i.poolLabel ?? "the pool"}`}; if anything along the way fails, the whole thing is undone and nothing is spent but the network fee.`,
    to: viaFactory ? (d?.factory ?? null) : account,
    toLabel: viaFactory ? "Oilskin account factory" : `your Oilskin account (${account ? short(account) : "…"})`,
    functionName: viaFactory ? "createAccountAndExec" : "execWithCallback",
    args: [
      ...(viaFactory ? [{ name: "creates", value: `your Oilskin account at ${account ? short(account) : "(predicted address)"} — owner: your wallet, forever` }] : []),
      { name: "then calls", value: `${routerFn} on ${d ? short(d.router) : "the router"} (the only step that gets rights over your account, for the length of this one call)` },
      ...openArgs,
    ],
    note: hold
      ? `${routerFn}: Permit2 pull → venue.supply (onBehalfOf = account) → venue.borrow(USDC), nothing deployed. The venue itself refuses a borrow under the registry's entry health-factor floor, so this cannot open under it. The router's balance of every token it touches is unchanged at exit and it asserts that.`
      : `${routerFn}: Permit2 pull → venue.supply (onBehalfOf = account) → venue.borrow(USDC) → lpVenue.open (USDC single-sided, price band) → reverts EntryHfTooLow below the floor. The router's balance of every token it touches is unchanged at exit and it asserts that.`,
    required: true,
    encodable: abiOk && !!account && (hold || !!i.enginePoolId),
  });

  if (i.keeperProtection) {
    calls.push(grantCall(step++, d, account, asset, i.deadline, i.enginePoolId));
  }
  return calls;
}

function grantCall(
  step: number,
  d: Deployment | null,
  account: Address | null,
  asset: (typeof COLLATERAL_ASSETS)[CollateralSymbol],
  nowSeconds: number,
  enginePoolId?: `0x${string}`,
): PlannedCall {
  const keeper = d?.keeper ?? null;
  const expiry = nowSeconds + KEEPER_GRANT_EXPIRY_DAYS * 86_400;
  return {
    step,
    kind: "grant",
    wallet: "transaction",
    title: "Let the Oilskin keeper protect this position (revocable)",
    plain: `You are allowing the Oilskin keeper to make ONE kind of call on your account — StrategyRouter.unwind, which reduces or closes this position — for ${KEEPER_GRANT_EXPIRY_DAYS} days (until ${utc(expiry)}), and you can revoke it at any time.`,
    to: account,
    toLabel: `your Oilskin account (${account ? short(account) : "…"})`,
    functionName: "grant",
    args: [
      { name: "keeper", value: keeper ? `Oilskin keeper (${short(keeper)})` : "Oilskin keeper (address not configured — step disabled)" },
      { name: "target · selector", value: `StrategyRouter.unwind only (${d ? short(d.router) : "router"} · ${UNWIND_SELECTOR}) — the keeper cannot open, borrow, sweep, claim or call a token directly` },
      { name: "token limits per day", value: `USDC (repay), ${asset.symbol} / pool tokens (swap), AERO — these cap DIRECT transfers and approvals the keeper's call tree makes in each token, per day` },
      { name: "what the limits do NOT cap", value: "value moved by Aave or the Snuggle engine inside that call (an Aave withdraw, an engine withdrawal) — those are protocol internals the budget cannot see" },
      { name: "allowCallback", value: "true — required: the router must act back on your account to close, repay and withdraw. Only you, the owner, can set this." },
      { name: "what it could still do", value: "an unwind can also withdraw collateral. The Oilskin keeper's own plans set that amount to zero, but this permission does not force it to — the limit is the router's exit health-factor floor, not the grant." },
      { name: "period · expiry", value: `${KEEPER_GRANT_PERIOD_S / 3600} h budget windows · expires ${utc(expiry)} (${KEEPER_GRANT_EXPIRY_DAYS} days)` },
      { name: "ETH per period", value: "0" },
    ],
    note:
      `account.grant(keeper, Permission{target: router, selector: unwind ${UNWIND_SELECTOR}, maxValuePerPeriod: 0, tokenLimits[], period: ${KEEPER_GRANT_PERIOD_S}, expiry: ${expiry}, allowCallback: true}). ` +
      "Every DIRECT token transfer or approval in the call tree is charged to the budget; the movers the budget cannot parse (Permit2 batch transferFrom, permitTransferFrom, ERC-777 send, ERC-677 transferAndCall) are refused outright on the keeper path with UnbudgetableSelector. " +
      "Re-granting inside a live period does NOT refill the budget — spend carries forward per token. " +
      `The grant expires on its own; nothing renews it silently. Pool id ${enginePoolId ? short(enginePoolId) : "—"}.`,
    required: !!keeper,
    encodable: !!keeper && !!account && !!d && !d.demo,
  };
}

/** Permit2 typed data the wallet signs (spender = the account). */
export function permitTypedData(token: Address, amount: bigint, spender: Address, nonce: bigint, deadline: bigint) {
  return {
    domain: { name: "Permit2", chainId: CHAIN_ID, verifyingContract: PERMIT2 } as const,
    types: {
      PermitTransferFrom: [
        { name: "permitted", type: "TokenPermissions" },
        { name: "spender", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
      TokenPermissions: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint256" },
      ],
    } as const,
    primaryType: "PermitTransferFrom" as const,
    message: { permitted: { token, amount }, spender, nonce, deadline },
  };
}

export interface PermitSig {
  nonce: bigint;
  deadline: bigint;
  signature: Hex;
}

/**
 * Wrap one router/venue call for the account: `createAccountAndExec` for a
 * first-time user, `execWithCallback` for an existing account. `exec` is a
 * PLAIN call now and would revert NotActivePeripheral inside the router.
 */
function wrapPeripheral(d: Deployment, account: Address, accountDeployed: boolean, target: Address, data: Hex): WriteSpec {
  if (!accountDeployed) {
    const args = [[peripheralCall(target, data)]] as const;
    return { address: d.factory, abi: FACTORY_ABI, functionName: "createAccountAndExec", args, data: encodeFunctionData({ abi: FACTORY_ABI, functionName: "createAccountAndExec", args }) };
  }
  const args = [target, 0n, data] as const;
  return { address: account, abi: ACCOUNT_ABI, functionName: "execWithCallback", args, data: encodeFunctionData({ abi: ACCOUNT_ABI, functionName: "execWithCallback", args }) };
}

/** The wallet transaction for the open step, once the permit is signed and the band quoted. */
export function encodeOpenWrite(i: OpenPlanInput, permit: PermitSig, band: PriceBand): WriteSpec {
  const d = i.deployment;
  if (!d || d.demo) throw new Error("no deployment");
  if (!i.predictedAccount) throw new Error("account address unknown");
  const asset = COLLATERAL_ASSETS[i.collateral];
  const collateralAtomic = toAtomic(i.collateralAmount, asset.decimals);
  const borrowAtomic = toAtomic(i.borrowUsdc.toFixed(BASE_TOKENS.USDC.decimals), BASE_TOKENS.USDC.decimals);
  const chainLp = lpParamsToChain(i.lpParams);
  const account = i.predictedAccount;
  const permitTuple = { nonce: permit.nonce, deadline: permit.deadline, signature: permit.signature };

  const data =
    i.strategy === "hold"
      ? encodeFunctionData({
          abi: ROUTER_ABI,
          functionName: "openBorrowOnly",
          args: [
            {
              collateralAsset: asset.address,
              collateralAmount: collateralAtomic,
              permit: permitTuple,
              borrowAmount: borrowAtomic,
              deadline: BigInt(i.deadline),
            },
          ],
        })
      : (() => {
          if (!i.enginePoolId) throw new Error("pool required");
          return encodeFunctionData({
            abi: ROUTER_ABI,
            functionName: "openLeveragedLp",
            args: [
              {
                collateralAsset: asset.address,
                collateralAmount: collateralAtomic,
                permit: permitTuple,
                borrowAmount: borrowAtomic,
                poolId: i.enginePoolId,
                rangeWidthBps: chainLp.rangeWidthBps,
                rebalanceDelay: chainLp.rebalanceDelay,
                autoCompound: chainLp.autoCompound,
                band: { minSqrtPriceX96: band.minSqrtPriceX96, maxSqrtPriceX96: band.maxSqrtPriceX96 },
                deadline: BigInt(i.deadline),
              },
            ],
          });
        })();

  return wrapPeripheral(d, account, i.accountDeployed, d.router, data);
}

// ---------------------------------------------------------------------------
// Unwind
// ---------------------------------------------------------------------------

export interface UnwindPlanInput {
  account: Address | null;
  positionIds: bigint[];
  collateral: CollateralSymbol;
  deployment: Deployment | null;
  deadline: number;
  bandToleranceBps: number;
  /** The swap quote for the non-USDC leg. null = not quoted yet; the plan is NOT signable until it is. */
  quote: QuotedSwap | null;
  poolLabel?: string;
  /**
   * Set when a venue's health factor disagrees with the prices this app reads (RISKS §8 residual
   * (b), policy 2026-09-10; `VenueHealthRead.priceDisagreement`). A Close withdraws collateral, and
   * collateral does not leave a venue whose price is disputed: the plan is not signable and says
   * why. The owner's raw exec to the venue stays open, as it does for every other refusal.
   */
  withdrawRefusedReason?: string | null;
}

export function buildUnwindPlan(i: UnwindPlanInput): PlannedCall[] {
  const asset = COLLATERAL_ASSETS[i.collateral];
  const d = i.deployment;
  const refused = i.withdrawRefusedReason ?? null;
  const abiOk = ABI_STATUS === "verified" && !!d && !d.demo && !refused;
  const q = i.quote;
  const quoteOk = !!q && validateSwapQuote(q).length === 0;
  const quoteText = q
    ? `1 ${q.tokenSymbol} → ${human(q.quotedOut, BASE_TOKENS.USDC.decimals, 2)} USDC (${q.source === "aave-oracle" ? "Aave oracle price" : "the pool's own live price"}), accepted down to ${human(q.minOutForQuotedIn, BASE_TOKENS.USDC.decimals, 2)} USDC per ${q.tokenSymbol} — a ${(q.maxSlippageBps / 100).toFixed(2)}% tolerance`
    : "quoted from the live price just before you sign";
  return [
    {
      step: 1,
      kind: "unwind",
      wallet: "transaction",
      title: "Close the position, repay the loan, get your collateral back — one transaction",
      plain: `One transaction that closes ${i.poolLabel ?? "the position"}, turns everything back into USDC at a price floor you can see below, repays your Aave loan in full and returns your ${asset.symbol} to your wallet; the performance fee is taken only on the rewards it collects.`,
      to: i.account,
      toLabel: `your Oilskin account (${i.account ? short(i.account) : "…"})`,
      functionName: "execWithCallback → StrategyRouter.unwind",
      args: [
        { name: "positions", value: i.positionIds.map((p) => `engine position #${p}`).join(", ") || "none" },
        { name: "collateralAsset", value: `${asset.symbol} (${short(asset.address)})` },
        { name: "band", value: `pool price ±${(i.bandToleranceBps / 100).toFixed(2)}% around the live price read before you sign` },
        { name: "swap quote", value: quoteText },
        { name: "swap route", value: q ? `Aerodrome Slipstream, tick spacing ${q.tickSpacing}` : "pool tick spacing read at sign time" },
        { name: "repayAmount", value: "max (all of your debt, or all the USDC that comes back if less)" },
        {
          name: "withdrawAmount",
          value: refused
            ? `refused — ${refused}`
            : "max (all collateral; refused if debt would remain with the health factor below the floor)",
        },
        { name: "deadline", value: utc(i.deadline) },
      ],
      note:
        "closeMany (ids that refuse are reported in failedCount, at index 0 like anywhere else — never a revert) → swap the non-USDC leg through AerodromeSwapAdapter, which enforces amountIn × quotedOut / quotedIn × (10000 − maxSlippageBps) / 10000 on the amount actually swapped → repay on every lending venue you still owe, the one with the lowest health factor first (a fixed repay against zero debt is a no-op, not a revert) → withdraw from the venue holding the position, gated on that venue's GLOBAL health factor. " +
        "Works on a disabled ASSET; refuses through a disabled VENUE (VenueDisabled) — then the owner's raw exec to Aave is the escape. Fee only in SnuggleLpVenue.close, on rewards.",
      required: true,
      encodable: abiOk && !!i.account && i.positionIds.length > 0 && quoteOk,
    },
  ];
}

export function encodeUnwindWrite(i: UnwindPlanInput, band: PriceBand): WriteSpec {
  const d = i.deployment;
  if (!d || d.demo || !i.account) throw new Error("no deployment / account");
  if (i.withdrawRefusedReason) throw new Error(`withdraw refused — ${i.withdrawRefusedReason}`);
  if (!i.quote) throw new Error("the swap must be quoted before an unwind can be encoded");
  const errs = validateSwapQuote(i.quote);
  if (errs.length) throw new Error(errs.join(" "));
  const asset = COLLATERAL_ASSETS[i.collateral];
  const unwind = encodeFunctionData({
    abi: ROUTER_ABI,
    functionName: "unwind",
    args: [
      {
        collateralAsset: asset.address,
        positionIds: i.positionIds,
        band: { minSqrtPriceX96: band.minSqrtPriceX96, maxSqrtPriceX96: band.maxSqrtPriceX96 },
        swap: {
          quotedIn: i.quote.quotedIn,
          quotedOut: i.quote.quotedOut,
          maxSlippageBps: i.quote.maxSlippageBps,
          routeData: i.quote.routeData,
        },
        repayAmount: maxUint256,
        withdrawAmount: maxUint256,
        deadline: BigInt(i.deadline),
      },
    ],
  });
  return wrapPeripheral(d, i.account, true, d.router, unwind);
}

// ---------------------------------------------------------------------------
// Claim (rewards → account → wallet)
// ---------------------------------------------------------------------------

export interface ClaimPlanInput {
  account: Address | null;
  positionIds: bigint[];
  /** Tokens to sweep to the wallet after the claim (AERO + the pool's tokens). */
  sweepTokens: { symbol: string; address: Address }[];
  deployment: Deployment | null;
  deadline: number;
  bandToleranceBps: number;
  poolLabel?: string;
}

export function buildClaimPlan(i: ClaimPlanInput): PlannedCall[] {
  const d = i.deployment;
  const abiOk = ABI_STATUS === "verified" && !!d && !d.demo;
  return [
    {
      step: 1,
      kind: "claim",
      wallet: "transaction",
      title: "Collect your rewards and send them to your wallet — one transaction",
      plain: `One transaction that collects the AERO rewards ${i.poolLabel ? `from ${i.poolLabel} ` : ""}into your Oilskin account (the performance fee comes off here) and then moves them to your wallet.`,
      to: i.account,
      toLabel: `your Oilskin account (${i.account ? short(i.account) : "…"})`,
      functionName: "execBatch → SnuggleLpVenue.claim, StrategyRouter.sweep",
      args: [
        { name: "positions", value: i.positionIds.map((p) => `engine position #${p}`).join(", ") || "none" },
        { name: "band", value: `pool price ±${(i.bandToleranceBps / 100).toFixed(2)}% — your positions auto-compound, so a harvest can swap inside the engine; this bounds the price it may do that at` },
        { name: "deadline", value: utc(i.deadline) },
        { name: "sweep to wallet", value: i.sweepTokens.map((t) => `${t.symbol} (${short(t.address)})`).join(", ") || "—" },
      ],
      note:
        "claim(ids, band, deadline) pays the account net of the performance fee (one pool per call) and REPORTS ids it could not claim in `failed` instead of reverting; sweep(tokens) moves whole balances to account.owner(). Both calls carry callback: true — the venue and the router act back on your account; nothing else in the batch does.",
      required: true,
      encodable: abiOk && !!i.account && i.positionIds.length > 0,
    },
  ];
}

export function encodeClaimWrite(i: ClaimPlanInput, band: PriceBand): WriteSpec {
  const d = i.deployment;
  if (!d || d.demo || !i.account) throw new Error("no deployment / account");
  const claim = encodeFunctionData({
    abi: LP_VENUE_ABI,
    functionName: "claim",
    args: [i.positionIds, { minSqrtPriceX96: band.minSqrtPriceX96, maxSqrtPriceX96: band.maxSqrtPriceX96 }, BigInt(i.deadline)],
  });
  const sweep = encodeFunctionData({ abi: ROUTER_ABI, functionName: "sweep", args: [i.sweepTokens.map((t) => t.address)] });
  const inner: AccountCall[] = [peripheralCall(d.lpVenue, claim), peripheralCall(d.router, sweep)];
  const args = [inner] as const;
  return { address: i.account, abi: ACCOUNT_ABI, functionName: "execBatch", args, data: encodeFunctionData({ abi: ACCOUNT_ABI, functionName: "execBatch", args }) };
}

// ---------------------------------------------------------------------------
// Keeper protection grant
// ---------------------------------------------------------------------------

export interface GrantPlanInput {
  account: Address;
  deployment: Deployment;
  /** Per-day token budgets, base units. Every line must be > 0 — the chain refuses a 0 line. */
  tokenLimits: { token: Address; amountPerPeriod: bigint }[];
  nowSeconds: number;
}

/** The grant on its own, for renewing or first-granting from the dashboard. */
export function buildGrantPlan(i: { deployment: Deployment | null; account: Address | null; collateral: CollateralSymbol; nowSeconds: number; enginePoolId?: `0x${string}` }): PlannedCall[] {
  return [grantCall(1, i.deployment, i.account, COLLATERAL_ASSETS[i.collateral], i.nowSeconds, i.enginePoolId)];
}

/** The kill switch, as a planned call so it gets the same one-sentence treatment. */
export function buildRevokeAllPlan(i: { account: Address | null; deployment: Deployment | null }): PlannedCall[] {
  const d = i.deployment;
  return [
    {
      step: 1,
      kind: "revoke",
      wallet: "transaction",
      title: "Take back every permission you have given (including the keeper's)",
      plain: "One transaction that cancels every permission on your Oilskin account at once — after it confirms, nobody but your own wallet can make your account do anything.",
      to: i.account,
      toLabel: `your Oilskin account (${i.account ? short(i.account) : "…"})`,
      functionName: "revokeAll",
      args: [
        { name: "affects", value: `every keeper permission on this account${d?.keeper ? `, including the Oilskin keeper (${short(d.keeper)})` : ""}` },
        { name: "what stops", value: "the keeper can no longer repay, de-risk or close for you — if your health factor falls, nobody acts but you" },
      ],
      note: "account.revokeAll() bumps the grant epoch, so every existing grant becomes unusable in one transaction. Granting again later is a fresh permission with a fresh budget and a fresh expiry.",
      required: true,
      encodable: !!i.account && !!d && !d.demo,
    },
  ];
}

export function grantExpiry(nowSeconds: number): number {
  return nowSeconds + KEEPER_GRANT_EXPIRY_DAYS * 86_400;
}

export function encodeGrantWrite(i: GrantPlanInput): WriteSpec {
  if (!i.deployment.keeper) throw new Error("keeper not configured");
  // The chain refuses a TokenLimit with amountPerPeriod == 0 (it read as "listed"
  // and behaved as "not budgeted") and refuses duplicates. Fail here, loudly.
  const seen = new Set<string>();
  for (const l of i.tokenLimits) {
    if (l.amountPerPeriod <= 0n) throw new Error(`token budget for ${l.token} is zero — the chain refuses that line (InvalidPermission)`);
    const k = l.token.toLowerCase();
    if (seen.has(k)) throw new Error(`duplicate token budget for ${l.token} — the chain refuses duplicates (InvalidPermission)`);
    seen.add(k);
  }
  const args = [
    i.deployment.keeper,
    {
      target: i.deployment.router,
      selector: UNWIND_SELECTOR,
      maxValuePerPeriod: 0n,
      tokenLimits: i.tokenLimits,
      period: KEEPER_GRANT_PERIOD_S,
      expiry: grantExpiry(i.nowSeconds),
      // Required: the router calls back into the account to close, repay and
      // withdraw. Without it every keeper dispatch reverts NotActivePeripheral
      // inside the router — the keeper would broadcast nothing while the
      // position rode to liquidation. Only the OWNER can set this.
      allowCallback: true,
    },
  ] as const;
  return { address: i.account, abi: ACCOUNT_ABI, functionName: "grant", args, data: encodeFunctionData({ abi: ACCOUNT_ABI, functionName: "grant", args }) };
}

/** account.revokeAll() — the one-button kill switch shown beside the grant. */
export function encodeRevokeAllWrite(account: Address): WriteSpec {
  const args = [] as const;
  return { address: account, abi: ACCOUNT_ABI, functionName: "revokeAll", args, data: encodeFunctionData({ abi: ACCOUNT_ABI, functionName: "revokeAll", args }) };
}

export function planIsSignable(calls: PlannedCall[]): boolean {
  return calls.filter((c) => c.required).every((c) => c.encodable);
}

export function deadlineFromNow(nowMs = Date.now(), minutes = DEADLINE_MINUTES): number {
  return Math.floor(nowMs / 1000) + minutes * 60;
}

/** Synthetic addresses for demo mode — obviously fake, never signable. */
export const DEMO_DEPLOYMENT: Deployment = {
  factory: "0x3333333333333333333333333333333333333333",
  router: "0x4444444444444444444444444444444444444444",
  registry: "0x5555555555555555555555555555555555555555",
  lpVenue: "0x6666666666666666666666666666666666666666",
  aaveVenue: "0x7777777777777777777777777777777777777777",
  swapAdapter: "0x0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a",
  engine: "0x8888888888888888888888888888888888888888",
  keeper: "0x9999999999999999999999999999999999999999",
  unsupportedVenues: [],
  demo: true,
};

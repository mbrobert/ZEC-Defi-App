/**
 * The exact calls a user signs — built from the wizard selection so Review
 * prints them verbatim and Sign sends them in order. Calling convention from
 * CONTRACT-ABI.md §0 (encoded ONLY from the generated ABI):
 *
 *   first-time user:   factory.createAccountAndExec([{router, 0, openLeveragedLp(p)}])
 *   existing account:  account.exec(router, 0, openLeveragedLp(p))
 *   hold (no LP):      account.execBatch([permit2.permitTransferFrom → account, venue.supply, venue.borrow])
 *                      (or the same list through createAccountAndExec)
 *   unwind:            account.exec(router, 0, unwind(u))
 *   claim:             account.execBatch([lpVenue.claim([ids]), router.sweep([tokens])])
 *   keeper protection: account.grant(keeper, Permission{router, unwind, …})
 *
 * The Permit2 SPENDER is the account address (predicted by factory.accountOf
 * before it exists). Every wallet prompt carries one plain sentence (`plain`)
 * for a user who has never used DeFi, and every hex value in `args` is
 * labelled. Nothing is signable until the addresses come from a deployment.
 */
import { encodeAbiParameters, encodeFunctionData, maxUint256, toFunctionSelector, type Address, type Hex } from "viem";
import { BASE_TOKENS, COLLATERAL_ASSETS, PERMIT2, RANGE_WIDTH_BOUNDS, lpParamsToChain, type CollateralSymbol, type LpParams } from "@zyo/shared";
import { ERC20_ABI } from "./abi/aave";
import { ABI_STATUS, ACCOUNT_ABI, AAVE_VENUE_ABI, FACTORY_ABI, LP_VENUE_ABI, PERMIT2_ABI, ROUTER_ABI } from "./abi/oilskin";
import { toAtomic } from "./math";
import type { PriceBand } from "./tickmath";

export const DEADLINE_MINUTES = 20;
/** Product policy: price may move this much between quote and execution before the venue refuses (Simple mode). */
export const DEFAULT_BAND_TOLERANCE_BPS = 100;
/** Advanced mode may widen the band up to this; beyond it the UI refuses (a sandwich would eat the difference). */
export const MAX_BAND_TOLERANCE_BPS = 300;
/** Keeper protection grant window (seconds) and expiry (days) — CONTRACT-ABI.md "recommended v1 protection grant". */
export const KEEPER_GRANT_PERIOD_S = 86_400;
export const KEEPER_GRANT_EXPIRY_DAYS = 30;

/** What the deployment looks like from the web's side. Read from chain via readDeployment(); DEMO_DEPLOYMENT in demo mode. */
export interface Deployment {
  factory: Address;
  router: Address;
  registry: Address;
  lpVenue: Address;
  aaveVenue: Address;
  engine: Address;
  keeper: Address | null;
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
  kind: "approve" | "permit-signature" | "open" | "unwind" | "claim" | "grant";
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

function callTuple(target: Address, data: Hex) {
  return { target, value: 0n, data };
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
  const deadlineIso = new Date(i.deadline * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
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

  const openArgs = hold
    ? [
        { name: "step 1 · Permit2 pull", value: `move ${i.collateralAmount} ${asset.symbol} from your wallet into your account` },
        { name: "step 2 · supply", value: `supply ${i.collateralAmount} ${asset.symbol} to Aave v3 on behalf of your account` },
        { name: "step 3 · borrow", value: `borrow ${usdcText} (${borrowAtomic} base units) into your account` },
      ]
    : [
        { name: "collateralAsset", value: `${asset.symbol} (${short(asset.address)})` },
        { name: "collateralAmount", value: `${i.collateralAmount} ${asset.symbol} (${collateralAtomic} base units)` },
        { name: "permit", value: "the signature from the previous step (nonce, deadline, signature)" },
        { name: "borrowAmount", value: `${usdcText} (${borrowAtomic} base units)` },
        { name: "poolId", value: `${i.poolLabel ?? "pool"} — engine pool id ${short(i.enginePoolId ?? ZERO32)}` },
        { name: "rangeWidthBps", value: `${chainLp.rangeWidthBps} (total tick span; on-chain bounds ${RANGE_WIDTH_BOUNDS.min}–${RANGE_WIDTH_BOUNDS.max})` },
        { name: "rebalanceDelay", value: `${chainLp.rebalanceDelay} seconds (${i.lpParams.rebalanceDelayHours} h)` },
        { name: "autoCompound", value: chainLp.autoCompound ? "on" : "off" },
        { name: "band", value: `pool price ±${(i.bandToleranceBps / 100).toFixed(2)}% around the live price read just before you sign; the deposit refuses if the price has moved further` },
        { name: "deadline", value: deadlineIso },
      ];

  const viaFactory = !i.accountDeployed;
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
    functionName: viaFactory ? "createAccountAndExec" : hold ? "execBatch" : "exec",
    args: [
      ...(viaFactory ? [{ name: "creates", value: `your Oilskin account at ${account ? short(account) : "(predicted address)"} — owner: your wallet, forever` }] : []),
      { name: "then calls", value: hold ? "Permit2 → Aave venue supply → Aave venue borrow (three calls, atomic)" : `StrategyRouter.openLeveragedLp on ${d ? short(d.router) : "the router"}` },
      ...openArgs,
    ],
    note: hold
      ? "account.execBatch([permit2.permitTransferFrom(permit, {to: account, amount}, wallet, sig), aaveVenue.supply(asset, amount), aaveVenue.borrow(USDC, amount)]). No router, no LP."
      : "Router: Permit2 pull → venue.supply (onBehalfOf = account) → venue.borrow(USDC) → lpVenue.open (USDC single-sided) → reverts EntryHfTooLow below the floor. The router holds nothing afterwards and asserts it.",
    required: true,
    encodable: abiOk && !!account && (hold || !!i.enginePoolId),
  });

  if (i.keeperProtection) {
    calls.push(grantCall(step++, d, account, asset, i.enginePoolId));
  }
  return calls;
}

function grantCall(step: number, d: Deployment | null, account: Address | null, asset: (typeof COLLATERAL_ASSETS)[CollateralSymbol], enginePoolId?: `0x${string}`): PlannedCall {
  const keeper = d?.keeper ?? null;
  return {
    step,
    kind: "grant",
    wallet: "transaction",
    title: "Let the Oilskin keeper protect this position (revocable)",
    plain: "You are allowing the Oilskin keeper to do one thing on your account — reduce or close this position through the router if its health drops to the ladder rungs — with per-day token limits, for 30 days, and you can revoke it any time.",
    to: account,
    toLabel: `your Oilskin account (${account ? short(account) : "…"})`,
    functionName: "grant",
    args: [
      { name: "keeper", value: keeper ? `Oilskin keeper (${short(keeper)})` : "Oilskin keeper (address not configured — step disabled)" },
      { name: "target · selector", value: `StrategyRouter.unwind only (${d ? short(d.router) : "router"} · ${toFunctionSelector("unwind((address,uint256[],(uint160,uint160),uint256,bytes,uint256,uint256,uint256))")})` },
      { name: "token limits per day", value: `USDC (repay), ${asset.symbol} / pool tokens (swap + fee), AERO (fee) — sized from your position at sign time` },
      { name: "period · expiry", value: `${KEEPER_GRANT_PERIOD_S / 3600} h windows · expires in ${KEEPER_GRANT_EXPIRY_DAYS} days` },
      { name: "ETH per period", value: "0" },
    ],
    note: `account.grant(keeper, Permission{target: router, selector: unwind, maxValuePerPeriod: 0, tokenLimits[], period: ${KEEPER_GRANT_PERIOD_S}, expiry}). The keeper cannot open positions, borrow, sweep or touch raw token selectors; every token op in the call tree is charged to the budget. Pool id ${enginePoolId ? short(enginePoolId) : "—"}.`,
    required: !!keeper,
    encodable: !!keeper && !!account && !!d && !d.demo,
  };
}

/** Permit2 typed data the wallet signs (spender = the account). */
export function permitTypedData(token: Address, amount: bigint, spender: Address, nonce: bigint, deadline: bigint) {
  return {
    domain: { name: "Permit2", chainId: 8453, verifyingContract: PERMIT2 } as const,
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

  let inner: { target: Address; value: bigint; data: Hex }[];
  if (i.strategy === "hold") {
    const pull = encodeFunctionData({
      abi: PERMIT2_ABI,
      functionName: "permitTransferFrom",
      args: [
        { permitted: { token: asset.address, amount: collateralAtomic }, nonce: permit.nonce, deadline: permit.deadline },
        { to: account, requestedAmount: collateralAtomic },
        i.owner,
        permit.signature,
      ],
    });
    const supply = encodeFunctionData({ abi: AAVE_VENUE_ABI, functionName: "supply", args: [asset.address, collateralAtomic] });
    const borrow = encodeFunctionData({ abi: AAVE_VENUE_ABI, functionName: "borrow", args: [BASE_TOKENS.USDC.address, borrowAtomic] });
    inner = [callTuple(PERMIT2, pull), callTuple(d.aaveVenue, supply), callTuple(d.aaveVenue, borrow)];
  } else {
    if (!i.enginePoolId) throw new Error("pool required");
    const open = encodeFunctionData({
      abi: ROUTER_ABI,
      functionName: "openLeveragedLp",
      args: [
        {
          collateralAsset: asset.address,
          collateralAmount: collateralAtomic,
          permit: { nonce: permit.nonce, deadline: permit.deadline, signature: permit.signature },
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
    inner = [callTuple(d.router, open)];
  }

  if (!i.accountDeployed) {
    const args = [inner] as const;
    return { address: d.factory, abi: FACTORY_ABI, functionName: "createAccountAndExec", args, data: encodeFunctionData({ abi: FACTORY_ABI, functionName: "createAccountAndExec", args }) };
  }
  if (inner.length === 1) {
    const args = [inner[0].target, 0n, inner[0].data] as const;
    return { address: account, abi: ACCOUNT_ABI, functionName: "exec", args, data: encodeFunctionData({ abi: ACCOUNT_ABI, functionName: "exec", args }) };
  }
  const args = [inner] as const;
  return { address: account, abi: ACCOUNT_ABI, functionName: "execBatch", args, data: encodeFunctionData({ abi: ACCOUNT_ABI, functionName: "execBatch", args }) };
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
  /** Minimum USDC out of swapping the non-USDC leg, base units (quoted from the band); 0n = not yet quoted. */
  swapMinOut: bigint;
  /** Slipstream tick spacing of the pool (routeData); null = not yet read. */
  tickSpacing: number | null;
  poolLabel?: string;
}

export function buildUnwindPlan(i: UnwindPlanInput): PlannedCall[] {
  const asset = COLLATERAL_ASSETS[i.collateral];
  const d = i.deployment;
  const abiOk = ABI_STATUS === "verified" && !!d && !d.demo;
  return [
    {
      step: 1,
      kind: "unwind",
      wallet: "transaction",
      title: "Close the position, repay the loan, get your collateral back — one transaction",
      plain: `One transaction that closes ${i.poolLabel ?? "the position"}, turns everything back into USDC, repays your Aave loan in full and returns your ${asset.symbol} to your wallet; the performance fee is taken only on the rewards it collects.`,
      to: i.account,
      toLabel: `your Oilskin account (${i.account ? short(i.account) : "…"})`,
      functionName: "exec → StrategyRouter.unwind",
      args: [
        { name: "positions", value: i.positionIds.map((p) => `engine position #${p}`).join(", ") || "none" },
        { name: "collateralAsset", value: `${asset.symbol} (${short(asset.address)})` },
        { name: "band", value: `pool price ±${(i.bandToleranceBps / 100).toFixed(2)}% around the live price read before you sign` },
        { name: "swapMinOut", value: i.swapMinOut > 0n ? `${i.swapMinOut} USDC base units (quoted from the band for the non-USDC leg)` : "quoted at sign time" },
        { name: "swapRouteData", value: i.tickSpacing !== null ? `Slipstream tick spacing ${i.tickSpacing}` : "pool tick spacing read at sign time" },
        { name: "repayAmount", value: "max (all of your debt, or all the USDC that comes back if less)" },
        { name: "withdrawAmount", value: "max (all collateral; refused if debt would remain with the health factor below the floor)" },
        { name: "deadline", value: new Date(i.deadline * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC" },
      ],
      note: "closeMany (ids that refuse are skipped and reported) → swap the non-USDC leg (Aerodrome, minOut + deadline) → repay → withdraw. Works on disabled assets. Fee only in SnuggleLpVenue.close on rewards.",
      required: true,
      encodable: abiOk && !!i.account && i.positionIds.length > 0 && i.swapMinOut > 0n && i.tickSpacing !== null,
    },
  ];
}

export function encodeUnwindWrite(i: UnwindPlanInput, band: PriceBand): WriteSpec {
  const d = i.deployment;
  if (!d || d.demo || !i.account) throw new Error("no deployment / account");
  if (i.tickSpacing === null) throw new Error("tick spacing unknown");
  if (i.swapMinOut <= 0n) throw new Error("swapMinOut must be quoted");
  const asset = COLLATERAL_ASSETS[i.collateral];
  const unwind = encodeFunctionData({
    abi: ROUTER_ABI,
    functionName: "unwind",
    args: [
      {
        collateralAsset: asset.address,
        positionIds: i.positionIds,
        band: { minSqrtPriceX96: band.minSqrtPriceX96, maxSqrtPriceX96: band.maxSqrtPriceX96 },
        swapMinOut: i.swapMinOut,
        swapRouteData: encodeAbiParameters([{ type: "int24" }], [i.tickSpacing]),
        repayAmount: maxUint256,
        withdrawAmount: maxUint256,
        deadline: BigInt(i.deadline),
      },
    ],
  });
  const args = [d.router, 0n, unwind] as const;
  return { address: i.account, abi: ACCOUNT_ABI, functionName: "exec", args, data: encodeFunctionData({ abi: ACCOUNT_ABI, functionName: "exec", args }) };
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
        { name: "sweep to wallet", value: i.sweepTokens.map((t) => `${t.symbol} (${short(t.address)})`).join(", ") || "—" },
      ],
      note: "claim(ids) pays the account net of the performance fee (one pool per call); sweep(tokens) moves whole balances to account.owner().",
      required: true,
      encodable: abiOk && !!i.account && i.positionIds.length > 0,
    },
  ];
}

export function encodeClaimWrite(i: ClaimPlanInput): WriteSpec {
  const d = i.deployment;
  if (!d || d.demo || !i.account) throw new Error("no deployment / account");
  const claim = encodeFunctionData({ abi: LP_VENUE_ABI, functionName: "claim", args: [i.positionIds] });
  const sweep = encodeFunctionData({ abi: ROUTER_ABI, functionName: "sweep", args: [i.sweepTokens.map((t) => t.address)] });
  const inner = [callTuple(d.lpVenue, claim), callTuple(d.router, sweep)];
  const args = [inner] as const;
  return { address: i.account, abi: ACCOUNT_ABI, functionName: "execBatch", args, data: encodeFunctionData({ abi: ACCOUNT_ABI, functionName: "execBatch", args }) };
}

// ---------------------------------------------------------------------------
// Keeper protection grant
// ---------------------------------------------------------------------------

export interface GrantPlanInput {
  account: Address;
  deployment: Deployment;
  /** Per-day token budgets, base units. */
  tokenLimits: { token: Address; amountPerPeriod: bigint }[];
  nowSeconds: number;
}

export function encodeGrantWrite(i: GrantPlanInput): WriteSpec {
  if (!i.deployment.keeper) throw new Error("keeper not configured");
  const selector = toFunctionSelector("unwind((address,uint256[],(uint160,uint160),uint256,bytes,uint256,uint256,uint256))");
  const args = [
    i.deployment.keeper,
    {
      target: i.deployment.router,
      selector,
      maxValuePerPeriod: 0n,
      tokenLimits: i.tokenLimits,
      period: KEEPER_GRANT_PERIOD_S,
      expiry: i.nowSeconds + KEEPER_GRANT_EXPIRY_DAYS * 86_400,
    },
  ] as const;
  return { address: i.account, abi: ACCOUNT_ABI, functionName: "grant", args, data: encodeFunctionData({ abi: ACCOUNT_ABI, functionName: "grant", args }) };
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
  engine: "0x8888888888888888888888888888888888888888",
  keeper: "0x9999999999999999999999999999999999999999",
  demo: true,
};

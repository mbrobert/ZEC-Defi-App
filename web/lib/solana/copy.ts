/**
 * What the Solana surfaces must say (SOLANA-ARCHITECTURE.md §8, §9; RISKS.md §22): Kamino's own words first, as a
 * dated quotation (lib/solana/kamino-wording.json), then Oilskin's additions in plain words. Every sentence here is
 * a fact about the code or the venues; nothing claims a protection the program does not enforce; none of the words
 * in lib/copy.ts BANNED_WORDS describes any of it (test/copy.test.ts scans this file too).
 */
import wording from "./kamino-wording.json";
import type { SolanaDisclosureId } from "./yield";

export const KAMINO_WORDING = wording as { source: string; readAt: string; learnMore: string; quote: string };

/** The disclosures the yield route names by id; the words are ours. */
export const SOLANA_DISCLOSURES: Record<SolanaDisclosureId, { title: string; body: string }> = {
  forecast_not_advice: {
    title: "Numbers, not advice",
    body: "Every figure on this screen is read from Solana at a stated slot or computed from those reads. It describes the position as it would be today; it is not a forecast of what ZEC will do, and it is not advice.",
  },
  bridged_zec: {
    title: "Your ZEC on Solana is a bridged token",
    body: "The ZEC used here is minted on Solana by a bridge program when ZEC is locked elsewhere. That bridge program can be upgraded by its operators, and it is the only thing that mints or redeems this token. It is not a coin on the Zcash chain.",
  },
  kamino_parameters_mutable: {
    title: "Kamino's market owner can change the rules",
    body: "The loan-to-value cap, the liquidation threshold, the deposit and borrow limits, the daily caps and the interest curve are parameters of Kamino's ZCASH market, and the market's owner can change any of them at any time. Oilskin reads them live and never assumes yesterday's numbers.",
  },
  usdc_freezable: {
    title: "Circle can freeze USDC",
    body: "USDC is issued by Circle, which can freeze any USDC token account, including yours and your Oilskin account's, and can pause the token.",
  },
  program_exit_only: {
    title: "The way out is through the Oilskin program",
    body: "Kamino does not let a position owned by a program account be handed to a wallet, so your collateral and debt live in a Kamino position that only the Oilskin program can operate. Repaying, withdrawing and closing all go through the program's instructions, which only your wallet can call. Whoever holds the program's upgrade authority can change the program — a single deployer key until it is handed to a Squads multisig, and that multisig afterwards.",
  },
  borrow_rate_moves: {
    title: "The borrow rate moves, including with your own borrow",
    body: "The USDC borrow rate is set by how much of Kamino's USDC pool is lent out. Your borrow raises it for you and for everyone else; the screen shows the rate after your borrow, not just the rate now.",
  },
  liquidation_at_chosen_hf: {
    title: "Liquidation at the health factor you chose",
    body: "If ZEC falls far enough, Kamino liquidates part of your collateral at a penalty Kamino sets (2–7 % today). The price at which that begins follows from the health factor you chose and is shown before you sign. The keeper you may authorise acts before that point, within the limits you set — only while its permission is live and only if it is running.",
  },
};

/** Oilskin's own risk list for the Solana review and positions pages. */
export const SOLANA_RISKS: readonly { id: string; title: string; body: string }[] = [
  { id: "bridged", ...SOLANA_DISCLOSURES.bridged_zec },
  { id: "kamino-owner", ...SOLANA_DISCLOSURES.kamino_parameters_mutable },
  { id: "usdc", ...SOLANA_DISCLOSURES.usdc_freezable },
  { id: "program-exit", ...SOLANA_DISCLOSURES.program_exit_only },
  {
    id: "keeper-sells",
    title: "The keeper may sell your ZEC",
    body: "If you grant the keeper protection, it can repay from your account's idle USDC and, when liquidation threatens, sell your ZEC to it: it pays USDC in and takes ZEC out at no worse than a fixed allowance under Kamino's oracle price — up to the daily budgets you sign, for the days you sign, and never more than the program checks on chain. Revoke it at any time. If the keeper is down or the permission has lapsed, nobody acts for you; you can always act yourself.",
  },
  {
    id: "oracle",
    title: "Kamino prices ZEC from Scope",
    body: "Kamino values your collateral from the Scope oracle's ZEC price, which must be fresh within 180 seconds for any action to go through. A stale or out-of-range price stops deposits, borrows and repayments alike until it recovers.",
  },
  {
    id: "contracts",
    title: "New code",
    body: "The Oilskin program on Solana is new code, proven on a local copy of Kamino's market and not yet deployed; Kamino, Scope and the bridge are third-party programs with their own risks. An external audit has not been completed.",
  },
  {
    id: "demo",
    title: "Demo mode",
    body: "With no Solana wallet connected the numbers are a snapshot of Kamino's market read on 2026-09-12 at slot 446,506,191, labelled as such. Nothing is signed, nothing moves.",
  },
];

/** The program's refusals in plain words (idl errors; anything unknown is shown by name). */
export function solanaErrorPlain(name: string | null): string {
  switch (name) {
    case "EntryHfTooLow":
      return "The program refused: the position would start under the entry health-factor floor.";
    case "LtvAboveOffer":
      return "The program refused: this borrow is above the loan-to-value Oilskin offers for ZEC.";
    case "ExitHfTooLow":
      return "The program refused: after this withdrawal the health factor would be under the exit floor while debt remains.";
    case "InsufficientUsdcToClose":
      return "The program refused: your account does not hold enough USDC to repay the whole debt. Top it up first.";
    case "ObligationStale":
    case "PriceNotChecked":
      return "Kamino's price check did not pass in this slot. Try again in a moment.";
    case "ZeroAmount":
      return "The amount must be more than zero.";
    case "NotOwner":
      return "Only the wallet that owns this account can do that.";
    case "GrantNotLive":
      return "The keeper's permission is not live (expired or revoked).";
    case "NotRevocable":
      return "There is no permission to revoke for this keeper.";
    case null:
      return "The transaction failed. Nothing moved.";
    default:
      return `The program refused: ${name}.`;
  }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Peripheral} from "../account/Peripheral.sol";
import {Call, IOilskinAccount} from "../interfaces/IOilskinAccount.sol";
import {ITokenMessengerV2} from "../interfaces/ICctpV2.sol";
import {
    HyperCoreAccountMarginSummary,
    HyperCorePerpAssetInfo,
    HyperCorePosition,
    HyperCoreSpotBalance,
    ICoreWriter,
    IHyperCoreUsdcAdapter
} from "../interfaces/IHyperCore.sol";
import {HyperCoreLib} from "../libraries/HyperCoreLib.sol";
import {PerpHealthLib} from "../libraries/PerpHealthLib.sol";

/// @title HyperliquidPerpVenue — the one peripheral of a user's account on HyperEVM: a SHORT ZEC perp on
///        Hyperliquid, owned by the account's own address on HyperCore, protected by a keeper inside a
///        `PerpGrant` (BUILD-PLAN Stream D step D2; `docs/PERPS-DESIGN-2026-09-25.md` §3–§6).
///
/// @notice The account is `OilskinAccount`, unchanged: the owner acts through `execWithCallback`, the keeper
///         through `execAsKeeper` under a `Permission` on (this, `protect`). What this contract adds is
///         (1) the venue plumbing — CoreWriter out, precompiles in, USDC through Circle's adapter and CCTP;
///         (2) the ENTRY RECORD every owner action re-writes and no keeper action touches (D9); (3) the
///         `PerpGrant`, which bounds what `protect` may do: which rungs, how much reserve it may move into
///         the position per period, how much of the short it may close per period, at what slippage.
///
///         Health is the venue's own cross-margin rule turned into an equivalent health factor
///         (`PerpHealthLib`): the shared ladder runs on it, and `protect` refuses a rung the live number has
///         not crossed. Every refusal is by name. Nothing here is a rate, a promise, or advice.
///
/// @dev THE THING THAT IS NEW ON THIS CHAIN: a CoreWriter action lands on HyperCore seconds after this
///      transaction and cannot revert it. An order the book does not fill, a transfer that finds no balance,
///      simply does not happen. So every gate here reads the live state BEFORE sending, the entry record
///      carries the INTENDED state, and the effect is judged by the keeper's next read (design §5). The
///      precompiles cannot run on a forked HyperEVM; the Foundry suite scripts them and testnet is the
///      localnet (design §9).
///
///      Facts every immutable rests on: `docs/VERIFIED-PERPS-FACTS-2026-09-14.md` and
///      `docs/research/hyperevm-reads-2026-09-25.json`. Two byte layouts are still taken from Hyperliquid's
///      documentation ([doc]: action 1 and action 7); the adapter's spot destination (`type(uint32).max`) is
///      inferred from action 13's own convention. `scripts/perps-d0b-testnet.mjs` proves each before a
///      deployment relies on it.
contract HyperliquidPerpVenue is Peripheral {
    // ---------------------------------------------------------------- immutables

    ICoreWriter public immutable CORE_WRITER;
    /// @notice Circle's USDC on HyperEVM (6 decimals) — what CCTP mints into the account.
    IERC20 public immutable USDC;
    /// @notice HyperCore token 0's linked contract: `deposit(amount, dex)` moves the account's USDC onto HyperCore.
    IHyperCoreUsdcAdapter public immutable USDC_ADAPTER;
    /// @notice Circle's TokenMessengerV2 on HyperEVM (domain 19); zero = the burn home is disabled by name.
    ITokenMessengerV2 public immutable CCTP_MESSENGER;
    /// @notice The perp asset index (ZEC: 214 of the `meta` universe).
    uint32 public immutable PERP_ASSET;
    /// @notice ZEC: 2. Pinned at deploy; every action re-reads `perpAssetInfo` and refuses if the venue changed it.
    uint8 public immutable SZ_DECIMALS;
    /// @notice ZEC: 10. The tier-0 maintenance margin rate is 1 / (2 × this).
    uint8 public immutable MAX_LEVERAGE;
    /// @notice HyperCore's USDC token index (0) and its `weiDecimals` (8) against the ERC-20's 6.
    uint64 public immutable USDC_TOKEN_INDEX;
    uint8 public immutable USDC_WEI_DECIMALS;
    uint8 public immutable USDC_EVM_DECIMALS;
    /// @notice Base's CCTP domain (6): the only destination a burn from here may name.
    uint32 public immutable BASE_DOMAIN;
    /// @notice The entry floor as margin per unit of notional in bps (design §10 item 1: 5_000 proposed, the founder's).
    uint256 public immutable MIN_ENTRY_MARGIN_BPS;
    /// @notice The beta notional cap per account, 10^6 USDC (D8: $25,000 keeps every position in margin tier 0).
    uint256 public immutable MAX_NOTIONAL_E6;
    /// @notice Mark versus oracle: beyond this, the valuation is not trusted and nothing acts (fail closed).
    uint256 public immutable MAX_MARK_ORACLE_DEVIATION_BPS;
    /// @notice The reserve multiple Simple mode takes (10_000 = 1×; design §10 item 4).
    uint256 public immutable DEFAULT_RESERVE_MULTIPLE_BPS;

    /// @notice A price band no owner action or grant may exceed.
    uint256 public constant MAX_SLIPPAGE_BPS = 500;
    /// @notice `maxFee` on a burn home may not exceed this share of the amount (the router's own cap, 1 %).
    uint256 public constant MAX_CCTP_FEE_BPS = 100;
    /// @notice No Fast Transfer OUT of HyperEVM (Circle's supported-blockchains page; `/fees/19/6` prices both
    ///         thresholds at 0): the burn home is Standard, minutes. Inbound, from Base, may be Fast at 1.3 bp.
    uint32 public constant CCTP_STANDARD_FINALITY = 2000;
    uint256 internal constant BPS = 10_000;

    // ------------------------------------------------------------------ storage

    /// @notice What the owner's last action intended, and what the keeper is judged against (D9).
    struct Entry {
        /// The up-move to liquidation at entry, bps; `hfBps` its equivalent health factor.
        uint32 distanceBps;
        uint32 hfBps;
        /// The intended short size, raw (10^szDecimals).
        uint64 sz;
        /// The spot reserve the position needs, 10^6 USDC (design §6).
        uint64 reserveE6;
        uint40 at;
    }

    /// @notice What an owner lets a keeper do through `protect` (design §3: the Solana grant's shape, not the
    ///         Base one — nothing leaves the account; what is bounded is how much reserve it may move and how
    ///         much of the short it may close per period).
    struct PerpGrant {
        address keeper;
        uint40 expiry;
        uint40 period;
        uint40 periodStart;
        /// Bit i = rung i may act (1 repay, 2 derisk, 3 emergency); bit 0 (warn) is never acted on chain.
        uint8 allowedRungs;
        uint64 topUpUsdcPerPeriod;
        uint64 reduceSzPerPeriod;
        uint16 maxSlippageBps;
        uint64 topUpSpent;
        uint64 reduceSpent;
        /// The account's `grantEpoch` when set: `revokeAll` kills this grant too.
        uint256 epoch;
    }

    struct OpenParams {
        /// Raw size (10^szDecimals).
        uint64 sz;
        /// How far under the mark the IOC sell may fill, bps (≤ MAX_SLIPPAGE_BPS).
        uint16 maxSlippageBps;
        uint40 deadline;
    }

    mapping(address account => Entry) public entryOf;
    mapping(address account => PerpGrant) internal _grants;
    /// @notice The user's Base `OilskinAccount` as CCTP's `mintRecipient` (bytes32, left-padded); zero = none.
    mapping(address account => bytes32 recipient) public baseRecipient;
    /// @notice Advanced mode's reserve multiple; zero = `DEFAULT_RESERVE_MULTIPLE_BPS`.
    mapping(address account => uint256 multipleBps) public reserveMultipleBps;

    // ------------------------------------------------------------------- events

    event CoreFunded(address indexed account, uint256 toSpotE6, uint256 toPerpE6);
    event ShortOpened(address indexed account, uint64 sz, uint64 markRaw, uint32 distanceBps, uint32 hfBps, uint64 reserveE6);
    event MarginAdded(address indexed account, uint64 usdcE6);
    event ShortReduced(address indexed account, uint64 sz, uint64 intendedRemaining);
    event WithdrawnToEvm(address indexed account, uint64 perpToSpotE6, uint64 spotToEvmE6);
    event BurnedToBase(address indexed account, uint256 amount, bytes32 recipient, uint256 maxFee);
    event BaseRecipientSet(address indexed account, bytes32 recipient);
    event ReserveMultipleSet(address indexed account, uint256 multipleBps);
    event EntryRecorded(address indexed account, uint32 distanceBps, uint32 hfBps, uint64 sz, uint64 reserveE6);
    event EntryCleared(address indexed account);
    event PerpGrantSet(
        address indexed account,
        address indexed keeper,
        uint40 expiry,
        uint40 period,
        uint8 allowedRungs,
        uint64 topUpUsdcPerPeriod,
        uint64 reduceSzPerPeriod,
        uint16 maxSlippageBps
    );
    event PerpGrantCleared(address indexed account);
    event Protected(address indexed account, address indexed keeper, uint8 rung, uint32 hfBps, uint64 topUpE6, uint64 reduceSz);

    // ------------------------------------------------------------------- errors

    error ZeroAddress();
    error ZeroAmount();
    error Expired(uint256 deadline);
    error NotOwnerPath();
    error NotKeeperPath();
    error PositionOpen(int64 szi);
    error NoPosition();
    error NoEntry();
    error VenueParamsChanged(uint8 szDecimals, uint8 maxLeverage);
    error MarkOracleDeviation(uint64 mark, uint64 oracle, uint256 deviationBps);
    error AccountValueNotPositive(int64 accountValue);
    error OtherPositionsOpen(uint64 ntlPos, uint256 ntlE6);
    error EntryDistanceTooLow(uint256 distanceBps, uint256 floorBps);
    error ExitDistanceTooLow(uint256 distanceBps, uint256 floorBps);
    error NotionalOverCap(uint256 ntlE6, uint256 capE6);
    error ReserveShort(uint256 heldE6, uint256 requiredE6);
    error SlippageTooLarge(uint256 bps, uint256 cap);
    error ReduceExceedsPosition(uint64 wanted, uint64 size);
    error NoBaseRecipient(address account);
    error CrossChainDisabled();
    error MaxFeeNotBelowAmount(uint256 maxFee, uint256 amount);
    error MaxFeeTooLarge(uint256 maxFee, uint256 cap);
    error UsdcShort(uint256 asked, uint256 held);
    error InvalidGrant();
    error InvalidConfig();
    error NotGrantedKeeper(address keeper);
    error GrantExpired(uint40 expiry);
    error GrantEpochStale(uint256 grantEpoch, uint256 accountEpoch);
    error RungNotAllowed(uint8 rung);
    error RungNotCrossed(uint8 rung, uint32 hfBps, uint32 thresholdBps);
    error ReduceNotAllowedAtRung(uint8 rung);
    error TopUpBudgetExceeded(uint64 wanted, uint64 remaining);
    error ReduceBudgetExceeded(uint64 wanted, uint64 remaining);
    error NothingToDo();
    /// @notice An order the venue's engine would refuse for its value: under $10 (`HyperCoreLib.MIN_ORDER_VALUE_E6`).
    error OrderBelowMinimum(uint256 valueE6, uint256 minimumE6);

    // ------------------------------------------------------------- construction

    struct Config {
        address coreWriter;
        address usdc;
        address usdcAdapter;
        address cctpMessenger;
        uint32 perpAsset;
        uint8 szDecimals;
        uint8 maxLeverage;
        uint64 usdcTokenIndex;
        uint8 usdcWeiDecimals;
        uint8 usdcEvmDecimals;
        uint32 baseDomain;
        uint256 minEntryMarginBps;
        uint256 maxNotionalE6;
        uint256 maxMarkOracleDeviationBps;
        uint256 defaultReserveMultipleBps;
    }

    constructor(Config memory c) {
        if (c.coreWriter == address(0) || c.usdc == address(0) || c.usdcAdapter == address(0)) revert ZeroAddress();
        if (c.usdcWeiDecimals < c.usdcEvmDecimals || c.szDecimals > 6) revert InvalidConfig();
        // the maintenance margin rate must be a whole number of bps, and the floor must leave a ladder
        uint256 mmr = PerpHealthLib.maintenanceMarginRateBps(c.maxLeverage);
        if (c.minEntryMarginBps <= mmr || c.maxNotionalE6 == 0 || c.defaultReserveMultipleBps == 0) revert InvalidConfig();
        PerpHealthLib.ladderFor(PerpHealthLib.equivalentHfBps(PerpHealthLib.entryDistanceBpsForMargin(c.minEntryMarginBps, mmr)));
        CORE_WRITER = ICoreWriter(c.coreWriter);
        USDC = IERC20(c.usdc);
        USDC_ADAPTER = IHyperCoreUsdcAdapter(c.usdcAdapter);
        CCTP_MESSENGER = ITokenMessengerV2(c.cctpMessenger);
        PERP_ASSET = c.perpAsset;
        SZ_DECIMALS = c.szDecimals;
        MAX_LEVERAGE = c.maxLeverage;
        USDC_TOKEN_INDEX = c.usdcTokenIndex;
        USDC_WEI_DECIMALS = c.usdcWeiDecimals;
        USDC_EVM_DECIMALS = c.usdcEvmDecimals;
        BASE_DOMAIN = c.baseDomain;
        MIN_ENTRY_MARGIN_BPS = c.minEntryMarginBps;
        MAX_NOTIONAL_E6 = c.maxNotionalE6;
        MAX_MARK_ORACLE_DEVIATION_BPS = c.maxMarkOracleDeviationBps;
        DEFAULT_RESERVE_MULTIPLE_BPS = c.defaultReserveMultipleBps;
    }

    // ------------------------------------------------------------------- views

    /// @notice The tier-0 maintenance margin rate, bps (ZEC: 500).
    function mmrBps() public view returns (uint256) {
        return PerpHealthLib.maintenanceMarginRateBps(MAX_LEVERAGE);
    }

    /// @notice The registry floor as an up-move: the smallest entry distance `open` accepts.
    function minEntryDistanceBps() public view returns (uint256) {
        return PerpHealthLib.entryDistanceBpsForMargin(MIN_ENTRY_MARGIN_BPS, mmrBps());
    }

    function perpGrantOf(address account) external view returns (PerpGrant memory) {
        return _grants[account];
    }

    /// @notice The live health of an account's short, as `protect` will judge it, for the keeper and the dashboard.
    ///         `hasPosition` false ⇒ the other numbers are zero. Reverts (by name) on a read this code does not trust.
    function health(address account)
        external
        view
        returns (bool hasPosition, int64 szi, uint64 markRaw, int64 accountValueE6, uint256 ntlE6, uint256 distanceBps, uint256 hfBps, uint256 spotE6)
    {
        Live memory l = _live(account);
        if (l.pos.szi == 0) return (false, 0, l.mark, l.ms.accountValue, 0, 0, 0, _spotE6(account));
        (ntlE6, distanceBps, hfBps) = _short(l);
        return (true, l.pos.szi, l.mark, l.ms.accountValue, ntlE6, distanceBps, hfBps, _spotE6(account));
    }

    /// @notice The account's ladder from its recorded entry (empty entry ⇒ reverts `NoEntry`).
    function ladderOf(address account) external view returns (PerpHealthLib.Ladder memory) {
        Entry storage e = entryOf[account];
        if (e.at == 0) revert NoEntry();
        return PerpHealthLib.ladderFor(e.hfBps);
    }

    // -------------------------------------------------------------- owner path

    /// @notice Move the account's USDC (already minted here by CCTP) onto HyperCore: `toSpotE6` into the spot
    ///         balance — the reserve — and `toPerpE6` into the perp balance — the margin. One exact approval,
    ///         reset after. Called by the account with `execWithCallback`.
    /// @dev The spot leg uses the adapter's `deposit(amount, type(uint32).max)`: action 13's own convention for
    ///      spot, inferred and not yet observed live — D0b proves it (design §2 item 3–4).
    function fundCore(uint256 toSpotE6, uint256 toPerpE6) external {
        _requireOwnerPath();
        uint256 total = toSpotE6 + toPerpE6;
        if (total == 0) revert ZeroAmount();
        address account = msg.sender;
        uint256 held = USDC.balanceOf(account);
        if (held < total) revert UsdcShort(total, held);
        uint256 n = 2 + (toSpotE6 != 0 ? 1 : 0) + (toPerpE6 != 0 ? 1 : 0);
        Call[] memory calls = new Call[](n);
        uint256 i;
        calls[i++] = _approveCall(address(USDC), address(USDC_ADAPTER), total);
        if (toSpotE6 != 0) {
            calls[i++] = Call({target: address(USDC_ADAPTER), value: 0, data: abi.encodeCall(IHyperCoreUsdcAdapter.deposit, (toSpotE6, HyperCoreLib.SPOT_DEX)), callback: false});
        }
        if (toPerpE6 != 0) {
            calls[i++] = Call({target: address(USDC_ADAPTER), value: 0, data: abi.encodeCall(IHyperCoreUsdcAdapter.deposit, (toPerpE6, HyperCoreLib.PERP_DEX)), callback: false});
        }
        calls[i] = _approveCall(address(USDC), address(USDC_ADAPTER), 0);
        _execMany(calls);
        emit CoreFunded(account, toSpotE6, toPerpE6);
    }

    /// @notice Open the short: an IOC sell of `sz` at the mark less the band, with the perp balance the account
    ///         already holds as the margin. Refuses, by name: a position already open, a venue whose parameters
    ///         moved, a mark that disagrees with the oracle, a non-positive balance, an entry under the floor, a
    ///         notional over the cap, a spot reserve short of what the ladder's top-up rung needs.
    /// @dev Invariant: the entry record is written from the live reads and the intended size; the order lands
    ///      seconds later and may not fill — the keeper's next read is the judge (design §5).
    function open(OpenParams calldata p) external returns (uint32 distanceBps, uint32 hfBps) {
        _requireOwnerPath();
        if (p.deadline < block.timestamp) revert Expired(p.deadline);
        if (p.sz == 0) revert ZeroAmount();
        if (p.maxSlippageBps > MAX_SLIPPAGE_BPS) revert SlippageTooLarge(p.maxSlippageBps, MAX_SLIPPAGE_BPS);
        address account = msg.sender;
        Live memory l = _live(account);
        if (l.pos.szi != 0) revert PositionOpen(l.pos.szi);
        if (l.ms.ntlPos != 0) revert OtherPositionsOpen(l.ms.ntlPos, 0);
        if (l.ms.accountValue <= 0) revert AccountValueNotPositive(l.ms.accountValue);

        uint256 ntl = PerpHealthLib.notionalE6(-int64(p.sz), l.mark, SZ_DECIMALS);
        if (ntl < HyperCoreLib.MIN_ORDER_VALUE_E6) revert OrderBelowMinimum(ntl, HyperCoreLib.MIN_ORDER_VALUE_E6);
        if (ntl > MAX_NOTIONAL_E6) revert NotionalOverCap(ntl, MAX_NOTIONAL_E6);
        uint256 d = PerpHealthLib.distanceBps(int256(l.ms.accountValue), ntl, l.mmrBps);
        uint256 floor_ = minEntryDistanceBps();
        if (d < floor_) revert EntryDistanceTooLow(d, floor_);
        uint256 hf = PerpHealthLib.equivalentHfBps(d);
        uint256 reserve = _reserveE6(account, ntl, d, hf, l.mmrBps);
        uint256 spot = _spotE6(account);
        if (spot < reserve) revert ReserveShort(spot, reserve);

        uint64 limitPx = _toE8Px(l.mark, false, p.maxSlippageBps);
        _sendAction(HyperCoreLib.encodeLimitOrder(PERP_ASSET, false, limitPx, _toE8Sz(p.sz), false, HyperCoreLib.TIF_IOC));
        _record(account, d, hf, p.sz, reserve);
        emit ShortOpened(account, p.sz, l.mark, uint32(d), uint32(hf), uint64(reserve));
        return (uint32(d), uint32(hf));
    }

    /// @notice Move `usdcE6` of the spot reserve into the perp balance (action 7, toPerp). Refuses to leave the
    ///         reserve short. Re-records the entry with the intended balance (D9).
    function addMargin(uint64 usdcE6) external {
        _requireOwnerPath();
        if (usdcE6 == 0) revert ZeroAmount();
        address account = msg.sender;
        Live memory l = _live(account);
        (uint256 ntl,,) = _short(l);
        uint256 spot = _spotE6(account);
        if (spot < usdcE6) revert ReserveShort(spot, usdcE6);
        uint256 d = PerpHealthLib.distanceBps(int256(l.ms.accountValue) + int256(uint256(usdcE6)), ntl, l.mmrBps);
        uint256 hf = PerpHealthLib.equivalentHfBps(d);
        uint256 reserve = _reserveE6(account, ntl, d, hf, l.mmrBps);
        if (spot - usdcE6 < reserve) revert ReserveShort(spot - usdcE6, reserve);
        _sendAction(HyperCoreLib.encodeUsdClassTransfer(usdcE6, true));
        _record(account, d, hf, uint64(uint256(-int256(l.pos.szi))), reserve);
        emit MarginAdded(account, usdcE6);
    }

    /// @notice Reduce-only IOC buy of `sz` at the mark plus the band (`sz` = the whole position closes it).
    ///         Re-records the entry with the intended remaining size, or clears it (D9).
    function reduce(uint64 sz, uint16 maxSlippageBps, uint40 deadline) external {
        _requireOwnerPath();
        if (deadline < block.timestamp) revert Expired(deadline);
        if (sz == 0) revert ZeroAmount();
        if (maxSlippageBps > MAX_SLIPPAGE_BPS) revert SlippageTooLarge(maxSlippageBps, MAX_SLIPPAGE_BPS);
        address account = msg.sender;
        Live memory l = _live(account);
        _short(l);
        uint64 size = uint64(uint256(-int256(l.pos.szi)));
        if (sz > size) revert ReduceExceedsPosition(sz, size);
        _requireOrderValue(sz, l.mark);
        _sendAction(HyperCoreLib.encodeLimitOrder(PERP_ASSET, true, _toE8Px(l.mark, true, maxSlippageBps), _toE8Sz(sz), true, HyperCoreLib.TIF_IOC));
        uint64 remaining = size - sz;
        if (remaining == 0) {
            delete entryOf[account];
            emit EntryCleared(account);
        } else {
            uint256 ntl = PerpHealthLib.notionalE6(-int64(remaining), l.mark, SZ_DECIMALS);
            uint256 d = PerpHealthLib.distanceBps(int256(l.ms.accountValue), ntl, l.mmrBps);
            uint256 hf = PerpHealthLib.equivalentHfBps(d);
            _record(account, d, hf, remaining, _reserveE6(account, ntl, d, hf, l.mmrBps));
        }
        emit ShortReduced(account, sz, remaining);
    }

    /// @notice USDC home, first two steps: `perpToSpotE6` perp → spot (action 7), then `spotToEvmE6` spot →
    ///         HyperEVM (action 13 to the system address). While a short stays open the remaining balance must
    ///         keep it at or above the floor and the remaining spot must cover the reserve. The third step,
    ///         `burnToBase`, is a later transaction: the USDC lands on the EVM side seconds after this one.
    function withdrawToEvm(uint64 perpToSpotE6, uint64 spotToEvmE6) external {
        _requireOwnerPath();
        if (perpToSpotE6 == 0 && spotToEvmE6 == 0) revert ZeroAmount();
        address account = msg.sender;
        Live memory l = _live(account);
        uint256 spot = _spotE6(account);
        if (l.pos.szi != 0) {
            (uint256 ntl,,) = _short(l);
            int256 remainingA = int256(l.ms.accountValue) - int256(uint256(perpToSpotE6));
            uint256 d = PerpHealthLib.distanceBps(remainingA, ntl, l.mmrBps);
            uint256 floor_ = minEntryDistanceBps();
            if (d < floor_) revert ExitDistanceTooLow(d, floor_);
            uint256 hf = PerpHealthLib.equivalentHfBps(d);
            uint256 reserve = _reserveE6(account, ntl, d, hf, l.mmrBps);
            uint256 spotAfter = spot + perpToSpotE6;
            if (spotAfter < spotToEvmE6 || spotAfter - spotToEvmE6 < reserve) revert ReserveShort(spotAfter < spotToEvmE6 ? 0 : spotAfter - spotToEvmE6, reserve);
            if (perpToSpotE6 != 0) _record(account, d, hf, uint64(uint256(-int256(l.pos.szi))), reserve);
        } else if (spot + perpToSpotE6 < spotToEvmE6) {
            revert ReserveShort(spot + perpToSpotE6, spotToEvmE6);
        }
        if (perpToSpotE6 != 0 && l.ms.accountValue < int64(perpToSpotE6)) revert UsdcShort(perpToSpotE6, l.ms.accountValue <= 0 ? 0 : uint64(l.ms.accountValue));
        if (perpToSpotE6 != 0) _sendAction(HyperCoreLib.encodeUsdClassTransfer(perpToSpotE6, false));
        if (spotToEvmE6 != 0) {
            _sendAction(
                HyperCoreLib.encodeSendAsset(_systemAddress(), HyperCoreLib.SPOT_DEX, HyperCoreLib.SPOT_DEX, USDC_TOKEN_INDEX, _toWei(spotToEvmE6))
            );
        }
        emit WithdrawnToEvm(account, perpToSpotE6, spotToEvmE6);
    }

    /// @notice The third step home: burn `amount` (max = the whole balance) to the recorded Base account over
    ///         CCTP Standard (no Fast Transfer OUT of HyperEVM). Exact approval, reset after.
    function burnToBase(uint256 amount, uint256 maxFee) external returns (uint256 burned) {
        _requireOwnerPath();
        if (address(CCTP_MESSENGER) == address(0)) revert CrossChainDisabled();
        address account = msg.sender;
        bytes32 recipient = baseRecipient[account];
        if (recipient == bytes32(0)) revert NoBaseRecipient(account);
        uint256 held = USDC.balanceOf(account);
        burned = amount == type(uint256).max ? held : amount;
        if (burned == 0) revert ZeroAmount();
        if (held < burned) revert UsdcShort(burned, held);
        if (maxFee >= burned) revert MaxFeeNotBelowAmount(maxFee, burned);
        uint256 feeCap = (burned * MAX_CCTP_FEE_BPS) / BPS;
        if (maxFee > feeCap) revert MaxFeeTooLarge(maxFee, feeCap);
        _approveCallReset(
            address(USDC),
            address(CCTP_MESSENGER),
            burned,
            Call({
                target: address(CCTP_MESSENGER),
                value: 0,
                data: abi.encodeCall(
                    ITokenMessengerV2.depositForBurn,
                    (burned, BASE_DOMAIN, recipient, address(USDC), bytes32(0), maxFee, CCTP_STANDARD_FINALITY)
                ),
                callback: false
            })
        );
        emit BurnedToBase(account, burned, recipient, maxFee);
    }

    /// @notice Record (or clear) the account's Base `OilskinAccount` as the only burn destination.
    function setBaseRecipient(bytes32 recipient) external {
        _requireOwnerPath();
        baseRecipient[msg.sender] = recipient;
        emit BaseRecipientSet(msg.sender, recipient);
    }

    /// @notice Advanced only: the reserve multiple (0 = the default). The next owner action re-sizes the reserve.
    function setReserveMultipleBps(uint256 multipleBps) external {
        _requireOwnerPath();
        reserveMultipleBps[msg.sender] = multipleBps;
        emit ReserveMultipleSet(msg.sender, multipleBps);
    }

    /// @notice Set the keeper's grant. The account's own `Permission` on (this, `protect`) is still required for
    ///         the keeper to reach it; this bounds what it may do once it has.
    function setPerpGrant(
        address keeper,
        uint40 expiry,
        uint40 period,
        uint8 allowedRungs,
        uint64 topUpUsdcPerPeriod,
        uint64 reduceSzPerPeriod,
        uint16 maxSlippageBps
    ) external {
        _requireOwnerPath();
        if (keeper == address(0) || expiry <= block.timestamp || period == 0 || allowedRungs & ~uint8(0x0E) != 0 || allowedRungs == 0) revert InvalidGrant();
        if (maxSlippageBps > MAX_SLIPPAGE_BPS) revert SlippageTooLarge(maxSlippageBps, MAX_SLIPPAGE_BPS);
        address account = msg.sender;
        PerpGrant storage g = _grants[account];
        bool carry = g.keeper == keeper && g.expiry != 0 && block.timestamp < uint256(g.periodStart) + uint256(g.period);
        g.keeper = keeper;
        g.expiry = expiry;
        g.period = period;
        g.allowedRungs = allowedRungs;
        g.topUpUsdcPerPeriod = topUpUsdcPerPeriod;
        g.reduceSzPerPeriod = reduceSzPerPeriod;
        g.maxSlippageBps = maxSlippageBps;
        g.epoch = IOilskinAccount(account).grantEpoch();
        if (!carry) {
            g.periodStart = uint40(block.timestamp);
            g.topUpSpent = 0;
            g.reduceSpent = 0;
        }
        emit PerpGrantSet(account, keeper, expiry, period, allowedRungs, topUpUsdcPerPeriod, reduceSzPerPeriod, maxSlippageBps);
    }

    function clearPerpGrant() external {
        _requireOwnerPath();
        delete _grants[msg.sender];
        emit PerpGrantCleared(msg.sender);
    }

    // ------------------------------------------------------------- keeper path

    /// @notice The keeper's one instruction (design §3): at `rung` (1 top-up, 2 reduce, 3 close), move
    ///         `topUpE6` of the spot reserve into the position and/or buy back `reduceSz` reduce-only, inside
    ///         the grant. Refuses, by name: no grant for this keeper, an expired or revoked one, a rung the
    ///         grant does not allow, a rung the LIVE equivalent health factor has not crossed, a reduce at the
    ///         top-up rung, a budget exceeded, a top-up the reserve cannot fund, a reduce larger than the
    ///         position. Never touches the entry record (D9).
    function protect(uint8 rung, uint64 topUpE6, uint64 reduceSz) external {
        address account = msg.sender;
        address keeper = IOilskinAccount(account).keeperActor();
        if (keeper == address(0)) revert NotKeeperPath();
        PerpGrant storage g = _grants[account];
        if (g.keeper != keeper) revert NotGrantedKeeper(keeper);
        if (block.timestamp >= g.expiry) revert GrantExpired(g.expiry);
        uint256 epoch = IOilskinAccount(account).grantEpoch();
        if (g.epoch != epoch) revert GrantEpochStale(g.epoch, epoch);
        if (rung < PerpHealthLib.RUNG_REPAY || rung > PerpHealthLib.RUNG_EMERGENCY || (g.allowedRungs >> rung) & 1 == 0) revert RungNotAllowed(rung);
        if (topUpE6 == 0 && reduceSz == 0) revert NothingToDo();
        if (rung == PerpHealthLib.RUNG_REPAY && reduceSz != 0) revert ReduceNotAllowedAtRung(rung);

        Entry storage e = entryOf[account];
        if (e.at == 0) revert NoEntry();
        Live memory l = _live(account);
        (, , uint256 hf) = _short(l);
        PerpHealthLib.Ladder memory ladder = PerpHealthLib.ladderFor(e.hfBps);
        if (hf >= ladder.hf[rung]) revert RungNotCrossed(rung, uint32(hf), ladder.hf[rung]);

        _rollPeriod(g);
        if (topUpE6 != 0) {
            uint64 remaining = g.topUpUsdcPerPeriod - _min64(g.topUpSpent, g.topUpUsdcPerPeriod);
            if (topUpE6 > remaining) revert TopUpBudgetExceeded(topUpE6, remaining);
            uint256 spot = _spotE6(account);
            if (spot < topUpE6) revert ReserveShort(spot, topUpE6);
            g.topUpSpent += topUpE6;
            _sendAction(HyperCoreLib.encodeUsdClassTransfer(topUpE6, true));
        }
        if (reduceSz != 0) {
            uint64 remaining = g.reduceSzPerPeriod - _min64(g.reduceSpent, g.reduceSzPerPeriod);
            if (reduceSz > remaining) revert ReduceBudgetExceeded(reduceSz, remaining);
            uint64 size = uint64(uint256(-int256(l.pos.szi)));
            if (reduceSz > size) revert ReduceExceedsPosition(reduceSz, size);
            _requireOrderValue(reduceSz, l.mark);
            g.reduceSpent += reduceSz;
            _sendAction(HyperCoreLib.encodeLimitOrder(PERP_ASSET, true, _toE8Px(l.mark, true, g.maxSlippageBps), _toE8Sz(reduceSz), true, HyperCoreLib.TIF_IOC));
        }
        emit Protected(account, keeper, rung, uint32(hf), topUpE6, reduceSz);
    }

    // ---------------------------------------------------------------- internal

    struct Live {
        HyperCorePosition pos;
        uint64 mark;
        uint64 oracle;
        HyperCoreAccountMarginSummary ms;
        uint256 mmrBps;
    }

    /// @dev Every read the health rests on, each refused by name when it cannot be trusted: the venue's asset
    ///      parameters must be the deployed ones; the mark must agree with the oracle.
    function _live(address account) internal view returns (Live memory l) {
        HyperCorePerpAssetInfo memory info = HyperCoreLib.perpAssetInfo(PERP_ASSET);
        if (info.szDecimals != SZ_DECIMALS || info.maxLeverage != MAX_LEVERAGE) revert VenueParamsChanged(info.szDecimals, info.maxLeverage);
        l.mark = HyperCoreLib.markPx(PERP_ASSET);
        l.oracle = HyperCoreLib.oraclePx(PERP_ASSET);
        uint256 hi = l.mark > l.oracle ? l.mark : l.oracle;
        uint256 lo = l.mark > l.oracle ? l.oracle : l.mark;
        if (lo == 0) revert MarkOracleDeviation(l.mark, l.oracle, BPS);
        uint256 dev = ((hi - lo) * BPS) / lo;
        if (dev > MAX_MARK_ORACLE_DEVIATION_BPS) revert MarkOracleDeviation(l.mark, l.oracle, dev);
        l.pos = HyperCoreLib.position(account, uint16(PERP_ASSET));
        l.ms = HyperCoreLib.accountMarginSummary(HyperCoreLib.PERP_DEX, account);
        l.mmrBps = PerpHealthLib.maintenanceMarginRateBps(MAX_LEVERAGE);
    }

    /// @dev The short's notional, distance and equivalent HF; refuses a long, an empty position, and an
    ///      account carrying any OTHER position (its value would be shared and the distance a fiction).
    function _short(Live memory l) internal view returns (uint256 ntl, uint256 d, uint256 hf) {
        if (l.pos.szi == 0) revert NoPosition();
        ntl = PerpHealthLib.notionalE6(l.pos.szi, l.mark, SZ_DECIMALS);
        uint256 tol = ntl / BPS + 1;
        if (l.ms.ntlPos > ntl + tol || l.ms.ntlPos + tol < ntl) revert OtherPositionsOpen(l.ms.ntlPos, ntl);
        d = PerpHealthLib.distanceBps(int256(l.ms.accountValue), ntl, l.mmrBps);
        hf = PerpHealthLib.equivalentHfBps(d);
    }

    function _reserveE6(address account, uint256 ntl, uint256 d, uint256 hf, uint256 mmr) internal view returns (uint256) {
        PerpHealthLib.Ladder memory ladder = PerpHealthLib.ladderFor(hf);
        uint256 rungD = PerpHealthLib.distanceBpsForHf(ladder.hf[PerpHealthLib.RUNG_REPAY]);
        uint256 disarmD = PerpHealthLib.distanceBpsForHf(ladder.disarm[PerpHealthLib.RUNG_REPAY]);
        uint256 multiple = reserveMultipleBps[account];
        if (multiple == 0) multiple = DEFAULT_RESERVE_MULTIPLE_BPS;
        uint256 num = multiple * ntl * (BPS + d) * (BPS + mmr) * (disarmD - rungD);
        uint256 den = BPS * BPS * BPS * BPS;
        return (num + den - 1) / den;
    }

    function _record(address account, uint256 d, uint256 hf, uint64 sz, uint256 reserve) internal {
        entryOf[account] = Entry({distanceBps: uint32(d), hfBps: uint32(hf), sz: sz, reserveE6: uint64(reserve), at: uint40(block.timestamp)});
        emit EntryRecorded(account, uint32(d), uint32(hf), sz, uint64(reserve));
    }

    /// @dev The account's HyperCore spot USDC in 10^6 (the precompile answers in weiDecimals).
    function _spotE6(address account) internal view returns (uint256) {
        HyperCoreSpotBalance memory b = HyperCoreLib.spotBalance(account, USDC_TOKEN_INDEX);
        return uint256(b.total) / (10 ** uint256(USDC_WEI_DECIMALS - USDC_EVM_DECIMALS));
    }

    function _toWei(uint64 e6) internal view returns (uint64) {
        return uint64(uint256(e6) * (10 ** uint256(USDC_WEI_DECIMALS - USDC_EVM_DECIMALS)));
    }

    /// @dev A precompile mark (10^(6 − szDecimals)) to an order price (10^8), shaded by the band — down for a sell, up
    ///      for a buy — then rounded to the venue's price precision INSIDE the band: a sell's floor up, a buy's ceiling
    ///      down (AUDIT-2026-09-26 P-1: the unrounded price carried the mark's eight figures and HyperCore rejects a
    ///      price over five, silently). A band narrower than one price quantum leaves no room to round inside it.
    function _toE8Px(uint64 markRaw, bool up, uint256 bandBps) internal view returns (uint64) {
        uint256 scaled = uint256(markRaw) * (10 ** uint256(8 - (6 - SZ_DECIMALS)));
        uint256 px = up ? (scaled * (BPS + bandBps)) / BPS : (scaled * (BPS - bandBps)) / BPS;
        return HyperCoreLib.roundOrderPxE8(uint64(px), SZ_DECIMALS, !up);
    }

    /// @dev The venue's engine refuses an order under $10 (AUDIT-2026-09-26 P-2); refuse it here by name instead of
    ///      sending an action that would be dropped in silence.
    function _requireOrderValue(uint64 sz, uint64 markRaw) internal view {
        uint256 value = PerpHealthLib.notionalE6(-int64(sz), markRaw, SZ_DECIMALS);
        if (value < HyperCoreLib.MIN_ORDER_VALUE_E6) revert OrderBelowMinimum(value, HyperCoreLib.MIN_ORDER_VALUE_E6);
    }

    /// @dev A raw size (10^szDecimals) to an order size (10^8).
    function _toE8Sz(uint64 sz) internal view returns (uint64) {
        return uint64(uint256(sz) * (10 ** uint256(8 - SZ_DECIMALS)));
    }

    /// @dev Token 0's system address: first byte 0x20, then the token index big-endian (docs rule; 0x2000…0000 for USDC).
    function _systemAddress() internal view returns (address) {
        return address(uint160(0x2000000000000000000000000000000000000000) + uint160(USDC_TOKEN_INDEX));
    }

    function _sendAction(bytes memory action) internal {
        _exec(address(CORE_WRITER), abi.encodeCall(ICoreWriter.sendRawAction, (action)));
    }

    function _requireOwnerPath() internal view {
        if (IOilskinAccount(msg.sender).keeperActor() != address(0)) revert NotOwnerPath();
    }

    function _rollPeriod(PerpGrant storage g) internal {
        if (block.timestamp >= uint256(g.periodStart) + uint256(g.period)) {
            g.periodStart = uint40(block.timestamp);
            g.topUpSpent = 0;
            g.reduceSpent = 0;
        }
    }

    function _min64(uint64 a, uint64 b) internal pure returns (uint64) {
        return a < b ? a : b;
    }
}

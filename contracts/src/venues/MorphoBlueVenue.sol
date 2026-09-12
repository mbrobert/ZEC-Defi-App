// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Peripheral} from "../account/Peripheral.sol";
import {Call} from "../interfaces/IOilskinAccount.sol";
import {ICollateralVenue} from "../interfaces/ICollateralVenue.sol";
import {ICollateralRegistry} from "../interfaces/ICollateralRegistry.sol";
import {IIrm, IMorphoBlue, IMorphoOracle, Market, MarketParams} from "../interfaces/IMorphoBlue.sol";
import {MorphoMath} from "../libraries/MorphoMath.sol";

/// @title MorphoBlueVenue — ICollateralVenue over Morpho Blue on Base (library-style: no admin).
///
/// @notice Morpho Blue is a set of ISOLATED markets, each one (loan token, collateral token, oracle,
///         interest-rate model, LLTV = liquidation loan-to-value) fixed forever at creation. This
///         venue is built over a fixed list of market ids — on Base the cbBTC/USDC and WETH/USDC
///         markets read from the chain on 2026-09-07 (VERIFIED-BASE-FACTS, Morpho addendum) — and
///         maps each collateral token to exactly one market. Every position lives under the calling
///         ACCOUNT (`onBehalf` = account, `receiver` = account).
///
///         Where Aave has one cross-collateral position, Morpho has one position per market, so:
///         - `healthFactor(account)` is the WORST market's health factor (the one a liquidator reaches
///           first); `type(uint256).max` when the account owes nothing anywhere.
///         - `borrowAgainst(collateral, loanToken, amount)` draws from THAT collateral's market —
///           what the router uses when it has just supplied the collateral, so the debt is against
///           the asset the user chose; `borrow(loanToken, amount)` (borrow against what is already
///           here) draws from the market with the most headroom (collateral × price × LLTV − debt)
///           among those with enough idle liquidity; `repay(loanToken, amount)` pays the worst
///           market first and spills into the next; `repay(loanToken, max)` clears every market by
///           SHARES so no dust of debt is left behind.
///         - `debt` reads no oracle; a market with no debt never reads its oracle; a market with
///           debt whose oracle cannot be read has health factor 0 (fail closed), so an exit is
///           never gated by another market's feed.
///         - `liquidationThresholdBps` and `maxLtvBps` both return the market's LLTV: Morpho has one
///           threshold, not two. It is read from `idToMarketParams` at call time, never stored here.
///
/// @dev **Policy lives on the ENTRY side, as in `AaveV3Venue`.** `supply` refuses an asset the
///      registry does not offer at THIS venue; `borrow` refuses any amount that leaves the account
///      below the registry's entry health-factor floor. `withdraw` and `repay` consult nothing.
///      Debt is computed the way Morpho will compute it in this block (`MorphoMath`), so a
///      full repay approves exactly what Morpho pulls. Market ids are checked at construction:
///      each must exist, lend the one `LOAN_TOKEN`, and recompute from its own params. There is no
///      function to add or change a market afterwards — a new market means a new venue and the
///      registry's propose → timelock → accept.
contract MorphoBlueVenue is ICollateralVenue, Peripheral {
    using MorphoMath for uint256;

    /// @notice Morpho Blue (Base: 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb).
    IMorphoBlue public immutable MORPHO;
    /// @notice The registry whose offer this venue enforces (entry floor + which assets are offered).
    ICollateralRegistry public immutable REGISTRY;
    /// @notice The one token every market here lends (USDC on Base).
    address public immutable LOAN_TOKEN;

    uint256 private constant WAD = 1e18;
    /// @dev Morpho oracles quote 1 collateral unit in loan units scaled by 1e36.
    uint256 private constant ORACLE_PRICE_SCALE = 1e36;
    /// @dev LLTV is WAD-scaled; bps = lltv / 1e14.
    uint256 private constant WAD_PER_BPS = 1e14;
    uint256 private constant SECONDS_PER_YEAR = 365 days;
    uint256 private constant RAY_PER_WAD = 1e9;

    mapping(address collateralToken => bytes32) internal _marketOf;
    address[] internal _collaterals;

    error ZeroAmount();
    error ZeroAddress();
    error NothingToRepay();
    error NothingToWithdraw();
    /// @notice The registry does not offer this asset at this venue (or has it disabled).
    error AssetNotOffered(address asset, address venue);
    /// @notice The borrow would leave the account below the registry's entry floor.
    error EntryHfTooLow(uint256 healthFactor, uint256 floor);
    /// @notice No market here takes `asset` as collateral.
    error NoMarket(address asset);
    /// @notice Only `LOAN_TOKEN` can be borrowed or repaid through this venue.
    error NotLoanToken(address asset);
    /// @notice A borrow needs collateral in at least one of this venue's markets (or in the market
    ///         named by `borrowAgainst`).
    error NoCollateralPosition(address account);
    /// @notice No market where the account holds collateral has `amount` of idle loan token.
    error NoMarketCanFill(uint256 amount);
    /// @notice A constructor id that Morpho has no market for.
    error MarketNotCreated(bytes32 id);
    /// @notice A constructor id whose params do not hash to it (a Morpho that is not Morpho).
    error MarketIdMismatch(bytes32 id, bytes32 recomputed);
    /// @notice A constructor id that lends something other than `LOAN_TOKEN`.
    error WrongLoanToken(bytes32 id, address loanToken);
    /// @notice Two constructor ids for the same collateral token.
    error DuplicateCollateral(address collateralToken);

    /// @param morpho Morpho Blue.
    /// @param registry The CollateralRegistry this venue enforces.
    /// @param loanToken The token every market must lend.
    /// @param marketIds The markets this venue serves, one per collateral token. May be empty: the
    ///        venue then reports `enabled() == false` and the registry refuses to point anything at it.
    constructor(IMorphoBlue morpho, ICollateralRegistry registry, address loanToken, bytes32[] memory marketIds) {
        if (address(morpho) == address(0) || address(registry) == address(0) || loanToken == address(0)) {
            revert ZeroAddress();
        }
        MORPHO = morpho;
        REGISTRY = registry;
        LOAN_TOKEN = loanToken;
        for (uint256 i = 0; i < marketIds.length; i++) {
            bytes32 id = marketIds[i];
            MarketParams memory p = _params(id);
            // Aderyn `reentrancy-state-change` (constructor read), triaged 2026-09-12 (AUDIT-2026-09-12.md).
            // aderyn-ignore-next-line(reentrancy-state-change)
            (,,,, uint128 lastUpdate,) = morpho.market(id);
            if (lastUpdate == 0) revert MarketNotCreated(id);
            bytes32 recomputed = marketId(p);
            if (recomputed != id) revert MarketIdMismatch(id, recomputed);
            if (p.loanToken != loanToken) revert WrongLoanToken(id, p.loanToken);
            if (_marketOf[p.collateralToken] != bytes32(0)) revert DuplicateCollateral(p.collateralToken);
            _marketOf[p.collateralToken] = id;
            _collaterals.push(p.collateralToken);
        }
    }

    // ------------------------------------------------------------- mutators

    /// @inheritdoc ICollateralVenue
    /// @dev Invariant: the registry offers `asset` at THIS venue and has it enabled; a market for it
    ///      exists here; the account is `onBehalf`; the allowance is exact and reset to zero.
    function supply(address asset, uint256 amount) external override {
        if (amount == 0) revert ZeroAmount();
        if (REGISTRY.venueOf(asset) != address(this) || !REGISTRY.isEnabled(asset)) {
            revert AssetNotOffered(asset, address(this));
        }
        MarketParams memory p = _params(_marketIdOf(asset));
        _approveCallReset(
            asset,
            address(MORPHO),
            amount,
            Call({
                target: address(MORPHO),
                value: 0,
                data: abi.encodeCall(IMorphoBlue.supplyCollateral, (p, amount, msg.sender, "")),
                callback: false
            })
        );
    }

    /// @inheritdoc ICollateralVenue
    /// @dev Invariant: funds go to the calling account and nowhere else. Morpho itself refuses a
    ///      withdrawal that would leave the market position unhealthy.
    function withdraw(address asset, uint256 amount) external override returns (uint256 withdrawn) {
        if (amount == 0) revert ZeroAmount();
        bytes32 id = _marketIdOf(asset);
        if (amount == type(uint256).max) {
            (,, uint128 held) = MORPHO.position(id, msg.sender);
            if (held == 0) revert NothingToWithdraw();
            amount = held;
        }
        _exec(
            address(MORPHO),
            abi.encodeCall(IMorphoBlue.withdrawCollateral, (_params(id), amount, msg.sender, msg.sender))
        );
        withdrawn = amount;
    }

    /// @inheritdoc ICollateralVenue
    /// @dev Invariant: `onBehalf` = `receiver` = the calling account; the market is the one where the
    ///      account has the most headroom AMONG those that can fill `amount` from idle liquidity
    ///      (audit wave 2, M-LOW-1); and the account's WORST market health factor after the borrow
    ///      is at or above the registry's entry floor. This is the fallback for "borrow against
    ///      whatever is already here" (`collateralAmount == 0`); the router's opens that supply a
    ///      collateral use `borrowAgainst` so the debt lands in THAT market (M-MED-1).
    function borrow(address asset, uint256 amount) external override {
        if (amount == 0) revert ZeroAmount();
        if (asset != LOAN_TOKEN) revert NotLoanToken(asset);
        _borrowIn(_marketForBorrow(msg.sender, amount), amount);
    }

    /// @inheritdoc ICollateralVenue
    /// @dev Invariant: the debt lands in `collateralAsset`'s market, where the account must already
    ///      hold collateral; the floor check is the same worst-market check as `borrow`.
    function borrowAgainst(address collateralAsset, address loanToken, uint256 amount) external override {
        if (amount == 0) revert ZeroAmount();
        if (loanToken != LOAN_TOKEN) revert NotLoanToken(loanToken);
        bytes32 id = _marketOf[collateralAsset];
        if (id == bytes32(0)) revert NoCollateralPosition(msg.sender);
        (,, uint128 held) = MORPHO.position(id, msg.sender);
        if (held == 0) revert NoCollateralPosition(msg.sender);
        _borrowIn(id, amount);
    }

    function _borrowIn(bytes32 id, uint256 amount) internal {
        _exec(
            address(MORPHO), abi.encodeCall(IMorphoBlue.borrow, (_params(id), amount, 0, msg.sender, msg.sender))
        );
        uint256 floor = REGISTRY.entryHfFloorWad();
        uint256 hf = _healthFactor(msg.sender);
        if (hf < floor) revert EntryHfTooLow(hf, floor);
    }

    /// @inheritdoc ICollateralVenue
    /// @dev Invariant: repays the calling account's own debt only; approves exactly what each market
    ///      pulls; the worst market is paid first. `type(uint256).max` clears every market by shares.
    function repay(address asset, uint256 amount) external override returns (uint256 repaid) {
        if (amount == 0) revert ZeroAmount();
        if (asset != LOAN_TOKEN) revert NotLoanToken(asset);
        (bytes32[] memory ids, uint256[] memory owed, uint256[] memory shares, uint256 totalOwed) =
            _debtsWorstFirst(msg.sender);
        if (totalOwed == 0) revert NothingToRepay();

        uint256 remaining = amount;
        uint256 n;
        Call[] memory calls = new Call[](ids.length * 3);
        for (uint256 i = 0; i < ids.length && remaining != 0; i++) {
            if (owed[i] == 0) continue;
            bool whole = remaining >= owed[i];
            uint256 pay = whole ? owed[i] : remaining;
            // A whole-market repay goes by SHARES so Morpho's own rounding cannot leave a wei of debt.
            bytes memory data = whole
                ? abi.encodeCall(IMorphoBlue.repay, (_params(ids[i]), 0, shares[i], msg.sender, ""))
                : abi.encodeCall(IMorphoBlue.repay, (_params(ids[i]), pay, 0, msg.sender, ""));
            calls[n++] = _approveCall(LOAN_TOKEN, address(MORPHO), pay);
            calls[n++] = Call({target: address(MORPHO), value: 0, data: data, callback: false});
            calls[n++] = _approveCall(LOAN_TOKEN, address(MORPHO), 0);
            remaining = whole ? remaining - owed[i] : 0;
        }
        assembly ("memory-safe") {
            mstore(calls, n)
        }
        bytes[] memory results = _execMany(calls);
        for (uint256 i = 1; i < n; i += 3) {
            (uint256 assetsRepaid,) = abi.decode(results[i], (uint256, uint256));
            repaid += assetsRepaid;
        }
    }

    // ---------------------------------------------------------------- views

    /// @inheritdoc ICollateralVenue
    /// @dev The WORST market's health factor; max when the account owes nothing anywhere.
    function healthFactor(address account) external view override returns (uint256) {
        return _healthFactor(account);
    }

    /// @inheritdoc ICollateralVenue
    /// @dev Morpho's LLTV, read from `idToMarketParams` now; 0 for an asset with no market here.
    function liquidationThresholdBps(address asset) external view override returns (uint256) {
        return _lltvBps(asset);
    }

    /// @inheritdoc ICollateralVenue
    /// @dev Morpho has ONE threshold: a borrow is allowed right up to the LLTV. Same number.
    function maxLtvBps(address asset) external view override returns (uint256) {
        return _lltvBps(asset);
    }

    /// @inheritdoc ICollateralVenue
    /// @dev Sum over every market, in assets, including interest accrued since each market's
    ///      `lastUpdate` (what Morpho would charge in this block). 0 for any other asset. Reads
    ///      NO oracle: debt is shares against the market's totals (audit wave 2, M-MED-2).
    function debt(address account, address asset) external view override returns (uint256 total) {
        if (asset != LOAN_TOKEN) return 0;
        for (uint256 i = 0; i < _collaterals.length; i++) {
            (uint256 owed,) = _marketDebt(_marketOf[_collaterals[i]], account);
            total += owed;
        }
    }

    /// @inheritdoc ICollateralVenue
    function collateral(address account, address asset) external view override returns (uint256) {
        bytes32 id = _marketOf[asset];
        if (id == bytes32(0)) return 0;
        (,, uint128 held) = MORPHO.position(id, account);
        return held;
    }

    /// @inheritdoc ICollateralVenue
    /// @dev Per market: a collateral asset gives its market's rate. For the loan token, which has
    ///      one rate per market, the HIGHEST rate across this venue's markets is returned — the
    ///      conservative quote. Converted from Morpho's per-second WAD to an APR ray, Aave-style.
    function borrowRateRay(address asset) external view override returns (uint256 rate) {
        if (asset == LOAN_TOKEN) {
            for (uint256 i = 0; i < _collaterals.length; i++) {
                uint256 r = _rateRay(_marketOf[_collaterals[i]]);
                if (r > rate) rate = r;
            }
            return rate;
        }
        bytes32 id = _marketOf[asset];
        if (id == bytes32(0)) return 0;
        return _rateRay(id);
    }

    /// @inheritdoc ICollateralVenue
    /// @dev A venue built over no markets is off; the registry refuses to point an asset at it.
    function enabled() external view override returns (bool) {
        return _collaterals.length != 0;
    }

    // ---------------------------------------------------------------- extras

    /// @notice Morpho's market id derivation.
    function marketId(MarketParams memory params) public pure returns (bytes32) {
        return keccak256(abi.encode(params));
    }

    /// @notice The market this venue uses for `asset` as collateral (0 = none).
    function marketIdOf(address asset) external view returns (bytes32) {
        return _marketOf[asset];
    }

    /// @notice The live params of the market this venue uses for `asset`, from Morpho.
    function marketParamsOf(address asset) external view returns (MarketParams memory) {
        return _params(_marketIdOf(asset));
    }

    /// @notice Every collateral token this venue has a market for.
    function collaterals() external view returns (address[] memory) {
        return _collaterals;
    }

    /// @notice The market oracle's price: 1 unit of `asset` in loan-token units, scaled by 1e36.
    function oraclePrice(address asset) external view returns (uint256) {
        return IMorphoOracle(_params(_marketIdOf(asset)).oracle).price();
    }

    // ------------------------------------------------------------- internal

    function _marketIdOf(address asset) internal view returns (bytes32 id) {
        id = _marketOf[asset];
        if (id == bytes32(0)) revert NoMarket(asset);
    }

    function _params(bytes32 id) internal view returns (MarketParams memory p) {
        (p.loanToken, p.collateralToken, p.oracle, p.irm, p.lltv) = MORPHO.idToMarketParams(id);
    }

    function _market(bytes32 id) internal view returns (Market memory m) {
        (m.totalSupplyAssets, m.totalSupplyShares, m.totalBorrowAssets, m.totalBorrowShares, m.lastUpdate, m.fee) =
            MORPHO.market(id);
    }

    function _lltvBps(address asset) internal view returns (uint256) {
        bytes32 id = _marketOf[asset];
        if (id == bytes32(0)) return 0;
        (,,,, uint256 lltv) = MORPHO.idToMarketParams(id);
        return lltv / WAD_PER_BPS;
    }

    /// @dev Debt of ONE market position in assets (what Morpho would pull this block) and the
    ///      shares behind it. No oracle involved.
    function _marketDebt(bytes32 id, address account) internal view returns (uint256 owed, uint256 shares) {
        (, uint128 borrowShares,) = MORPHO.position(id, account);
        if (borrowShares == 0) return (0, 0);
        MarketParams memory p = _params(id);
        (uint256 totalBorrowAssets, uint256 totalBorrowShares) = MorphoMath.expectedBorrowTotals(p, _market(id));
        shares = borrowShares;
        owed = shares.toAssetsUp(totalBorrowAssets, totalBorrowShares);
    }

    /// @dev Max borrow of ONE market position (collateral × price × LLTV, loan units). `ok` is
    ///      false when the market's oracle cannot be read; the caller decides what that means.
    function _tryMaxBorrow(bytes32 id, address account) internal view returns (bool ok, uint256 maxBorrow) {
        (,, uint128 held) = MORPHO.position(id, account);
        if (held == 0) return (true, 0);
        MarketParams memory p = _params(id);
        try IMorphoOracle(p.oracle).price() returns (uint256 price) {
            return (true, uint256(held).mulDivDown(price, ORACLE_PRICE_SCALE).wMulDown(p.lltv));
        } catch {
            return (false, 0);
        }
    }

    /// @dev Health of ONE market position: max borrow over debt, WAD. A market with no debt is
    ///      `type(uint256).max` WITHOUT reading its oracle; a market with debt whose oracle cannot
    ///      be read is 0 — the worst answer, never a revert — so `repay` is never gated by an
    ///      oracle and a borrow or withdraw fails closed at the floor (audit wave 2, M-MED-2).
    function _marketHealth(bytes32 id, address account)
        internal
        view
        returns (uint256 hf, uint256 owed, uint256 shares)
    {
        (owed, shares) = _marketDebt(id, account);
        if (owed == 0) return (type(uint256).max, 0, 0);
        (bool ok, uint256 maxBorrow) = _tryMaxBorrow(id, account);
        if (!ok) return (0, owed, shares);
        hf = (maxBorrow * WAD) / owed;
    }

    function _healthFactor(address account) internal view returns (uint256 worst) {
        worst = type(uint256).max;
        for (uint256 i = 0; i < _collaterals.length; i++) {
            (uint256 hf,,) = _marketHealth(_marketOf[_collaterals[i]], account);
            if (hf < worst) worst = hf;
        }
    }

    /// @dev The market with the most room to borrow — collateral × price × LLTV − debt, in loan
    ///      units — among markets where the account holds collateral, whose oracle answers, and
    ///      which hold at least `amount` of idle loan token (Morpho would otherwise revert with its
    ///      own string while another market could have filled it — audit wave 2, M-LOW-1).
    function _marketForBorrow(address account, uint256 amount) internal view returns (bytes32 best) {
        uint256 bestHeadroom;
        bool found;
        bool anyCollateral;
        for (uint256 i = 0; i < _collaterals.length; i++) {
            bytes32 id = _marketOf[_collaterals[i]];
            (bool ok, uint256 maxBorrow) = _tryMaxBorrow(id, account);
            if (!ok || maxBorrow == 0) continue;
            anyCollateral = true;
            Market memory m = _market(id);
            uint256 idle = m.totalSupplyAssets > m.totalBorrowAssets ? m.totalSupplyAssets - m.totalBorrowAssets : 0;
            if (idle < amount) continue;
            (uint256 owed,) = _marketDebt(id, account);
            uint256 headroom = maxBorrow > owed ? maxBorrow - owed : 0;
            if (!found || headroom > bestHeadroom) {
                best = id;
                bestHeadroom = headroom;
                found = true;
            }
        }
        if (!found) {
            if (!anyCollateral) revert NoCollateralPosition(account);
            revert NoMarketCanFill(amount);
        }
    }

    /// @dev Every market's debt for `account`, ordered worst health factor first (insertion sort;
    ///      the list is the venue's handful of markets).
    function _debtsWorstFirst(address account)
        internal
        view
        returns (bytes32[] memory ids, uint256[] memory owed, uint256[] memory shares, uint256 total)
    {
        uint256 n = _collaterals.length;
        ids = new bytes32[](n);
        owed = new uint256[](n);
        shares = new uint256[](n);
        uint256[] memory hfs = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            bytes32 id = _marketOf[_collaterals[i]];
            (uint256 hf, uint256 o, uint256 s) = _marketHealth(id, account);
            uint256 j = i;
            while (j > 0 && hfs[j - 1] > hf) {
                ids[j] = ids[j - 1];
                owed[j] = owed[j - 1];
                shares[j] = shares[j - 1];
                hfs[j] = hfs[j - 1];
                j--;
            }
            ids[j] = id;
            owed[j] = o;
            shares[j] = s;
            hfs[j] = hf;
            total += o;
        }
    }

    function _rateRay(bytes32 id) internal view returns (uint256) {
        MarketParams memory p = _params(id);
        if (p.irm == address(0)) return 0;
        uint256 perSecondWad = IIrm(p.irm).borrowRateView(p, _market(id));
        return perSecondWad * SECONDS_PER_YEAR * RAY_PER_WAD;
    }
}

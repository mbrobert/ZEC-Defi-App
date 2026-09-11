// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Fixture} from "../Fixture.sol";
import {ILpVenue} from "../../src/interfaces/ILpVenue.sol";
import {ISnuggleVault} from "../../src/interfaces/ISnuggleVault.sol";
import {SnuggleLpVenue} from "../../src/venues/SnuggleLpVenue.sol";
import {MockSnuggleVault} from "../mocks/MockSnuggleVault.sol";

/// @notice An engine whose every enumeration failure mode is a switch. Only the surface
///         `SnuggleLpVenue.positionsOf` touches is implemented: `poolIdsCount`, `userPositions`,
///         `positions`.
contract AmbiguousEngine {
    enum Shape {
        Empty, // `revert()` — the live engine's measured end-of-list (Addendum 3/4)
        Panic32, // a Solidity array read past the end
        Answers, // a mapping-style getter: every index answers
        ErrorString, // `revert("...")` — neither terminal shape
        BurnGas // `invalid()` — consumes the whole stipend, the out-of-gas shape
    }

    address public holder;
    uint256[] public list;
    Shape public endShape;
    Shape public canaryShape;
    bool public canaryShapeSet;
    /// @dev An index BEFORE the end that fails with the END shape (isolated, the next index answers).
    uint256 public isolatedBadIndex = type(uint256).max - 1;
    /// @dev An index that burns all its gas, wherever it is.
    uint256 public burnIndex = type(uint256).max - 1;
    mapping(uint256 => address) public ownerOverride;
    uint256 public shortPositionsId;
    uint256 public revertPositionsId;
    uint256 public dirtyOwnerId;
    uint256 public poolCount = 1;

    function configure(address holder_, uint256[] calldata ids, Shape s) external {
        holder = holder_;
        delete list;
        for (uint256 i = 0; i < ids.length; i++) {
            list.push(ids[i]);
        }
        endShape = s;
        canaryShapeSet = false;
    }

    function setCanaryShape(Shape s) external {
        canaryShape = s;
        canaryShapeSet = true;
    }

    function setIsolatedBadIndex(uint256 i) external {
        isolatedBadIndex = i;
    }

    function setBurnIndex(uint256 i) external {
        burnIndex = i;
    }

    function setOwnerOverride(uint256 id, address o) external {
        ownerOverride[id] = o;
    }

    function setShortPositions(uint256 id) external {
        shortPositionsId = id;
    }

    function setRevertPositions(uint256 id) external {
        revertPositionsId = id;
    }

    function setDirtyOwner(uint256 id) external {
        dirtyOwnerId = id;
    }

    function poolIdsCount() external view returns (uint256) {
        return poolCount;
    }

    function _fail(Shape s, uint256 index) internal pure returns (uint256) {
        if (s == Shape.Empty) revert();
        if (s == Shape.Panic32) {
            uint256[] memory empty = new uint256[](0);
            return empty[index]; // Panic(0x32)
        }
        if (s == Shape.ErrorString) revert("engine says no");
        if (s == Shape.BurnGas) {
            assembly {
                invalid()
            }
        }
        return 0; // Answers
    }

    function userPositions(address, uint256 index) external view returns (uint256) {
        if (index == burnIndex) return _fail(Shape.BurnGas, index);
        if (index == type(uint256).max) {
            return _fail(canaryShapeSet ? canaryShape : endShape, index);
        }
        if (index == isolatedBadIndex && index < list.length) return _fail(endShape, index);
        if (index >= list.length) return _fail(endShape, index);
        return list[index];
    }

    function positions(uint256 id)
        external
        view
        returns (
            uint256,
            bytes32,
            address,
            uint24,
            int24,
            int24,
            bool,
            bool,
            uint64,
            uint64,
            uint32,
            uint32,
            uint64,
            uint128,
            uint128,
            uint128,
            uint128
        )
    {
        if (id != 0 && id == shortPositionsId) {
            assembly {
                mstore(0, id)
                return(0, 32)
            }
        }
        if (id != 0 && id == revertPositionsId) revert("positions down");
        if (id != 0 && id == dirtyOwnerId) {
            assembly {
                let p := mload(0x40)
                mstore(p, id)
                mstore(add(p, 0x40), not(0)) // owner word with every upper bit set
                return(p, 544)
            }
        }
        address o = ownerOverride[id] == address(0) ? holder : ownerOverride[id];
        return (id, bytes32(uint256(1)), o, 1500, 0, 0, false, true, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    }
}

/// @notice Slice A, 2026-09-10 (`RISKS.md` §12 "Design"): the live engine's end-of-list revert is
///         EMPTY, the shape of a bare revert, an out-of-gas and a proxy miss alike, so `positionsOf`
///         stopped pinning `Panic(0x32)` and instead requires gas, shape, consistency and ownership
///         to agree. Every fault it can name is driven here, with both terminal shapes, and the
///         residual it cannot remove is asserted AS a residual.
contract EnumerationAmbiguityRegressionTest is Fixture {
    AmbiguousEngine adv;
    SnuggleLpVenue v;
    uint256 constant CANARY = type(uint256).max;

    function setUp() public override {
        super.setUp();
        adv = new AmbiguousEngine();
        v = new SnuggleLpVenue(ISnuggleVault(address(adv)), address(aero), treasury, 1000);
    }

    function _ids(uint256 n) internal pure returns (uint256[] memory out) {
        out = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            out[i] = 100 + i;
        }
    }

    function _expectFault(SnuggleLpVenue.EnumerationFault f, uint256 index, bytes memory data)
        internal
    {
        vm.expectRevert(
            abi.encodeWithSelector(SnuggleLpVenue.EnumerationAmbiguous.selector, f, index, data)
        );
    }

    function _panic32() internal pure returns (bytes memory) {
        return abi.encodeWithSignature("Panic(uint256)", 0x32);
    }

    // ------------------------------------------------------------ the two accepted shapes

    function test_A1_theMeasuredEmptyShapeEnumerates() public {
        adv.configure(address(acct), _ids(5), AmbiguousEngine.Shape.Empty);
        uint256[] memory ids = v.positionsOf(address(acct));
        assertEq(ids.length, 5, "the live engine's shape is enumerable now");
        for (uint256 i = 0; i < 5; i++) {
            assertEq(ids[i], 100 + i);
        }
        adv.configure(address(acct), _ids(0), AmbiguousEngine.Shape.Empty);
        assertEq(v.positionsOf(address(acct)).length, 0, "and an empty list is empty, not a fault");
    }

    function test_A2_thePanicShapeStillEnumerates() public {
        adv.configure(address(acct), _ids(3), AmbiguousEngine.Shape.Panic32);
        assertEq(v.positionsOf(address(acct)).length, 3);
        adv.configure(address(acct), _ids(0), AmbiguousEngine.Shape.Panic32);
        assertEq(v.positionsOf(address(acct)).length, 0);
    }

    // ------------------------------------------------------------ consistency (k, k + 1)

    function test_A3_anIsolatedFailureBeforeTheEndFailsClosed() public {
        adv.configure(address(acct), _ids(5), AmbiguousEngine.Shape.Empty);
        adv.setIsolatedBadIndex(2);
        // index 2 fails like the canary; index 3 answers with id 103 — not an end.
        _expectFault(SnuggleLpVenue.EnumerationFault.InconsistentEnd, 3, abi.encode(uint256(103)));
        v.positionsOf(address(acct));

        adv.setIsolatedBadIndex(0);
        _expectFault(SnuggleLpVenue.EnumerationFault.InconsistentEnd, 1, abi.encode(uint256(101)));
        v.positionsOf(address(acct));
    }

    function test_A3b_theSameUnderThePanicShape() public {
        adv.configure(address(acct), _ids(3), AmbiguousEngine.Shape.Panic32);
        adv.setIsolatedBadIndex(1);
        _expectFault(SnuggleLpVenue.EnumerationFault.InconsistentEnd, 2, abi.encode(uint256(102)));
        v.positionsOf(address(acct));
    }

    /// RESIDUAL (a), `RISKS.md` §12: an isolated failure at the LAST index is a list one shorter.
    /// The k + 1 probe lands on the true end and agrees. Asserted as the residual it is, so the
    /// day it is fixed this test fails and the document is updated with it.
    function test_A4_RESIDUAL_anIsolatedFailureAtTheLastIndexIsAShorterList() public {
        adv.configure(address(acct), _ids(5), AmbiguousEngine.Shape.Empty);
        adv.setIsolatedBadIndex(4);
        assertEq(
            v.positionsOf(address(acct)).length,
            4,
            "RESIDUAL (a): a failure at the last index reads as a 4-element list; no probe can see it"
        );
    }

    // ------------------------------------------------------------ gas (EIP-150)

    function test_A5_anOutOfGasMidListIsNotAnEnd() public {
        adv.configure(address(acct), _ids(5), AmbiguousEngine.Shape.Empty);
        adv.setBurnIndex(2);
        _expectFault(SnuggleLpVenue.EnumerationFault.ProbeOutOfGas, 2, "");
        v.positionsOf(address(acct));
    }

    function test_A5b_anOutOfGasAtTheCanaryIsNotATerminalShape() public {
        adv.configure(address(acct), _ids(2), AmbiguousEngine.Shape.Empty);
        adv.setBurnIndex(CANARY);
        _expectFault(SnuggleLpVenue.EnumerationFault.ProbeOutOfGas, CANARY, "");
        v.positionsOf(address(acct));
    }

    function test_A5c_anOutOfGasAtTheProbeAfterTheEndIsNotAnEnd() public {
        adv.configure(address(acct), _ids(3), AmbiguousEngine.Shape.Empty);
        adv.setBurnIndex(4); // k = 3 is the honest end; k + 1 burns
        _expectFault(SnuggleLpVenue.EnumerationFault.InconsistentEnd, 4, "");
        v.positionsOf(address(acct));
    }

    function test_A6_theVenueRefusesToProbeWithoutTheFullStipend() public {
        adv.configure(address(acct), _ids(2), AmbiguousEngine.Shape.Empty);
        uint256 floor = v.PROBE_GAS() + v.PROBE_GAS() / 63 + 10_000;
        _expectFault(SnuggleLpVenue.EnumerationFault.InsufficientGas, CANARY, "");
        v.positionsOf{gas: floor - 1}(address(acct));
        // and with the stipend available it answers
        assertEq(v.positionsOf{gas: 2_000_000}(address(acct)).length, 2);
    }

    // ------------------------------------------------------------ shape agreement

    function test_A7_aCanaryThatAnswersFailsClosed() public {
        adv.configure(address(acct), _ids(2), AmbiguousEngine.Shape.Answers);
        _expectFault(SnuggleLpVenue.EnumerationFault.CanaryAnswered, CANARY, abi.encode(uint256(0)));
        v.positionsOf(address(acct));
    }

    function test_A8_aCanaryOfNeitherTerminalShapeFailsClosed() public {
        adv.configure(address(acct), _ids(2), AmbiguousEngine.Shape.ErrorString);
        _expectFault(
            SnuggleLpVenue.EnumerationFault.TerminalShapeUnknown,
            CANARY,
            abi.encodeWithSignature("Error(string)", "engine says no")
        );
        v.positionsOf(address(acct));
    }

    function test_A9_theEndMustFailExactlyLikeTheCanary() public {
        // canary empty, end Panic(0x32): the end is a different shape → the older EnumerationFailed
        adv.configure(address(acct), _ids(2), AmbiguousEngine.Shape.Panic32);
        adv.setCanaryShape(AmbiguousEngine.Shape.Empty);
        vm.expectRevert(
            abi.encodeWithSelector(SnuggleLpVenue.EnumerationFailed.selector, _panic32())
        );
        v.positionsOf(address(acct));
        // and the other way round
        adv.configure(address(acct), _ids(2), AmbiguousEngine.Shape.Empty);
        adv.setCanaryShape(AmbiguousEngine.Shape.Panic32);
        vm.expectRevert(
            abi.encodeWithSelector(SnuggleLpVenue.EnumerationFailed.selector, bytes(""))
        );
        v.positionsOf(address(acct));
    }

    function test_A10_aMidListRevertOfAnotherShapeIsStillEnumerationFailed() public {
        // canary empty; index 1 reverts with a string — neither the terminal shape nor an answer
        adv.configure(address(acct), _ids(3), AmbiguousEngine.Shape.ErrorString);
        adv.setCanaryShape(AmbiguousEngine.Shape.Empty);
        adv.setIsolatedBadIndex(1);
        vm.expectRevert(
            abi.encodeWithSelector(
                SnuggleLpVenue.EnumerationFailed.selector,
                abi.encodeWithSignature("Error(string)", "engine says no")
            )
        );
        v.positionsOf(address(acct));
    }

    // ------------------------------------------------------------ corroboration

    function test_A11_anIdOwnedBySomeoneElseFailsClosedInsteadOfBeingSkipped() public {
        adv.configure(address(acct), _ids(3), AmbiguousEngine.Shape.Empty);
        adv.setOwnerOverride(101, bob);
        _expectFault(
            SnuggleLpVenue.EnumerationFault.OwnerMismatch, 1, abi.encode(uint256(101), bob)
        );
        v.positionsOf(address(acct));
        // a stale slot reading address(0) is a mismatch too
        adv.setOwnerOverride(101, address(0));
        adv.setOwnerOverride(102, address(1));
        _expectFault(
            SnuggleLpVenue.EnumerationFault.OwnerMismatch, 2, abi.encode(uint256(102), address(1))
        );
        v.positionsOf(address(acct));
    }

    function test_A12_aPositionThatDoesNotReadAsTheFullStructFailsClosed() public {
        adv.configure(address(acct), _ids(3), AmbiguousEngine.Shape.Empty);
        adv.setShortPositions(102);
        _expectFault(
            SnuggleLpVenue.EnumerationFault.PositionUnreadable, 2, abi.encode(uint256(102))
        );
        v.positionsOf(address(acct));

        adv.setShortPositions(0);
        adv.setRevertPositions(100);
        _expectFault(
            SnuggleLpVenue.EnumerationFault.PositionUnreadable,
            0,
            abi.encodeWithSignature("Error(string)", "positions down")
        );
        v.positionsOf(address(acct));

        adv.setRevertPositions(0);
        adv.setDirtyOwner(101);
        vm.expectPartialRevert(SnuggleLpVenue.EnumerationAmbiguous.selector);
        v.positionsOf(address(acct));
    }

    // ------------------------------------------------------------ liveness

    function test_A13_anEngineThatChangesUnderTheEnumerationFailsClosed() public {
        adv.configure(address(acct), _ids(2), AmbiguousEngine.Shape.Empty);
        bytes[] memory answers = new bytes[](2);
        answers[0] = abi.encode(uint256(1));
        answers[1] = abi.encode(uint256(2)); // the read after the terminal probe disagrees
        vm.mockCalls(address(adv), abi.encodeCall(ISnuggleVault.poolIdsCount, ()), answers);
        _expectFault(SnuggleLpVenue.EnumerationFault.LivenessLost, 2, "");
        v.positionsOf(address(acct));
    }

    function test_A13b_anEngineWhoseLivenessReadDiesIsUnreachable() public {
        adv.configure(address(acct), _ids(2), AmbiguousEngine.Shape.Empty);
        vm.mockCallRevert(address(adv), abi.encodeCall(ISnuggleVault.poolIdsCount, ()), "");
        vm.expectRevert(SnuggleLpVenue.EngineUnreachable.selector);
        v.positionsOf(address(acct));
    }

    // ------------------------------------------------------------ the product's mock, both shapes

    function test_A14_theFixtureEngineEnumeratesUnderBothShapes() public {
        usdc.mint(address(acct), 1_000e6);
        bytes memory ret = _ownerExec(
            address(lpVenue),
            abi.encodeCall(ILpVenue.open, (_openParams(POOL_WETH_USDC, 0, 100e6, poolWethUsdc)))
        );
        uint256 id = abi.decode(ret, (uint256));
        assertTrue(
            engine.endShape() == MockSnuggleVault.EndShape.Empty,
            "the mock defaults to the measured shape"
        );
        uint256[] memory ids = lpVenue.positionsOf(address(acct));
        assertEq(ids.length, 1);
        assertEq(ids[0], id);
        engine.setEndShape(MockSnuggleVault.EndShape.Panic32);
        ids = lpVenue.positionsOf(address(acct));
        assertEq(ids.length, 1);
        assertEq(ids[0], id);
    }
}

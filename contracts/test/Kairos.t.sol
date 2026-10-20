// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {MockTBill} from "../src/MockTBill.sol";
import {KairosVault, ITBillFund} from "../src/KairosVault.sol";
import {DemoRandomSource} from "../src/DemoRandomSource.sol";
import {ChainlinkVRFSource} from "../src/ChainlinkVRFSource.sol";
import {VRFCoordinatorV2_5Mock} from "@chainlink/src/v0.8/vrf/mocks/VRFCoordinatorV2_5Mock.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract KairosTest is Test {
    MockUSDC usdc;
    MockTBill tbill;
    KairosVault vault;
    DemoRandomSource rng;

    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCA201);
    address treasury = address(0xFEE);

    function setUp() public {
        vm.warp(1_700_000_000);
        usdc = new MockUSDC();
        tbill = new MockTBill(usdc);
        usdc.setMinter(address(tbill), true);
        vault = new KairosVault(IERC20(address(usdc)), ITBillFund(address(tbill)), treasury);
        tbill.setAllowlisted(address(vault), true);
        rng = new DemoRandomSource(address(vault));
        vault.setRandomSource(rng);
        vault.setDrawPeriod(7 days);

        address[3] memory people = [alice, bob, carol];
        for (uint256 i = 0; i < 3; i++) {
            usdc.mint(people[i], 100_000e6);
            vm.prank(people[i]);
            usdc.approve(address(vault), type(uint256).max);
        }
    }

    function _deposit(address who, uint256 amt) internal {
        vm.prank(who);
        vault.deposit(amt);
    }

    function _withdraw(address who, uint256 amt) internal {
        vm.prank(who);
        vault.withdraw(amt);
    }

    function _runDraw() internal returns (uint256 id) {
        id = vault.closeDraw();
        vm.roll(block.number + 2);
        (KairosVault.Draw memory d,,,) = vault.getDraw(id);
        if (!d.awarded) rng.fulfill(id);
    }

    // ------------------------------------------------------------------ basics

    function test_DepositMintsSharesOneToOne() public {
        _deposit(alice, 10e6);
        assertEq(vault.balanceOf(alice), 10e6);
        assertEq(vault.totalSupply(), 10e6);
    }

    function test_BelowMinimumDepositReverts() public {
        vm.prank(alice);
        vm.expectRevert("kairos: below minimum deposit");
        vault.deposit(9e6);
    }

    function test_SharesCannotBeTransferred() public {
        _deposit(alice, 50e6);
        vm.prank(alice);
        vm.expectRevert("kairos: shares are non-transferable");
        vault.transfer(bob, 1e6);
    }

    function test_FaucetGivesTestDollars() public {
        address dan = address(0xDA2);
        vm.prank(dan);
        usdc.faucet();
        assertEq(usdc.balanceOf(dan), 1_000e6);
        vm.prank(dan);
        vm.expectRevert("faucet: wait an hour");
        usdc.faucet();
    }

    // ------------------------------------------------------------------ the full loop

    function test_FullLoop_DepositYieldDrawWithdraw() public {
        _deposit(alice, 10_000e6);
        _deposit(bob, 5_000e6);
        _deposit(carol, 10e6);

        vault.rebalance(); // invest cash above the band into T-bills
        assertGt(tbill.balanceOf(address(vault)), 0, "nothing invested");

        vm.warp(block.timestamp + 7 days);
        uint256 interest = vault.availableInterest();
        assertGt(interest, 0, "no interest");

        uint256 id = _runDraw();
        (KairosVault.Draw memory d, address[] memory winners, uint256[] memory amounts,) = vault.getDraw(id);
        assertTrue(d.awarded);
        assertEq(winners.length, 3);
        assertApproxEqAbs(d.prize, (interest * 8_500) / 10_000, 2);
        assertApproxEqAbs(vault.feesAccrued(), (interest * 1_500) / 10_000, 2);
        assertEq(amounts[0] + amounts[1] + amounts[2], d.prize);

        // Everyone can take out at least what they put in.
        uint256 aBal = vault.balanceOf(alice);
        uint256 bBal = vault.balanceOf(bob);
        uint256 cBal = vault.balanceOf(carol);
        assertGe(aBal, 10_000e6);
        assertGe(bBal, 5_000e6);
        assertGe(cBal, 10e6);

        tbill.setRules(0, 0, 0, false); // let redemptions settle immediately for the test
        _withdraw(carol, cBal);
        _withdraw(bob, bBal);
        _withdraw(alice, aBal);
        // anything queued gets paid after the keeper redeems T-bills and settles
        for (uint256 i = 0; i < 6 && vault.queueLength() > 0; i++) {
            vault.rebalance();
            vm.warp(block.timestamp + 1);
        }
        assertEq(vault.queueLength(), 0, "queue not cleared");
        assertGe(usdc.balanceOf(alice), 100_000e6);
        assertGe(usdc.balanceOf(bob), 100_000e6);
        assertGe(usdc.balanceOf(carol), 100_000e6);
        assertEq(vault.totalSupply(), 0);
    }

    function test_HarvestNeverTouchesPrincipal() public {
        _deposit(alice, 1_000e6);
        vault.rebalance();
        assertEq(vault.harvest(), 0, "harvested with no interest");
        assertGe(vault.totalAssets(), vault.totalLiabilities());
        vm.warp(block.timestamp + 30 days);
        vault.harvest();
        assertGe(vault.totalAssets() + 2, vault.totalLiabilities());
    }

    function test_OddsWeightedByTimeHeld() public {
        _deposit(alice, 1_000e6); // holds all week
        vm.warp(block.timestamp + 7 days - 1 hours);
        _deposit(bob, 1_000e6); // drops in an hour before the draw
        vm.warp(block.timestamp + 1 hours);
        uint256 a = vault.weightAt(alice, block.timestamp);
        uint256 b = vault.weightAt(bob, block.timestamp);
        assertEq(a, 1_000e6 * 7 days);
        assertEq(b, 1_000e6 * 1 hours);
    }

    function test_SoleSaverWinsEveryPrize() public {
        _deposit(alice, 5_000e6);
        vault.rebalance();
        vm.warp(block.timestamp + 7 days);
        uint256 id = _runDraw();
        (, address[] memory winners,,) = vault.getDraw(id);
        for (uint256 i = 0; i < winners.length; i++) {
            assertEq(winners[i], alice);
        }
        assertGt(vault.balanceOf(alice), 5_000e6);
    }

    function test_CannotCloseDrawEarly() public {
        _deposit(alice, 100e6);
        vm.expectRevert("kairos: draw period not over");
        vault.closeDraw();
    }

    function test_WithdrawWorksWhilePaused() public {
        _deposit(alice, 50e6);
        vault.pause();
        vm.prank(bob);
        vm.expectRevert();
        vault.deposit(50e6);
        _withdraw(alice, 50e6);
        assertEq(usdc.balanceOf(alice), 100_000e6);
    }

    // ------------------------------------------------------------------ the cash drawer

    function test_RebalanceKeepsCashInBand() public {
        _deposit(alice, 20_000e6);
        vault.rebalance();
        (uint256 cash,,,, uint256 r,, uint256 high,) = vault.drawerState();
        assertLe(cash, high);
        assertApproxEqAbs(cash, r, 1);
    }

    function test_WeekendWithdrawalQueuesThenPaysAfterSettlement() public {
        tbill.setRules(0, 0, 1 days, false); // T+1, no instant route (a weekend)
        _deposit(alice, 20_000e6);
        vault.rebalance(); // cash drawer ~ $1,500, rest in T-bills

        _withdraw(alice, 5_000e6); // bigger than the drawer
        assertEq(vault.queueLength(), 1, "should queue");

        vault.rebalance(); // requests a T-bill redemption
        assertGt(vault.pendingValue(), 0);
        vault.rebalance();
        assertEq(vault.queueLength(), 1, "paid before settlement");

        vm.warp(block.timestamp + 1 days);
        vault.rebalance(); // settles, pays the queue
        assertEq(vault.queueLength(), 0);
        assertEq(usdc.balanceOf(alice), 100_000e6 - 20_000e6 + 5_000e6);
    }

    function test_InstantRouteWhenFundAllowsIt() public {
        tbill.setRules(0, 0, 1 days, true);
        _deposit(alice, 20_000e6);
        vault.rebalance();
        _withdraw(alice, 5_000e6);
        assertEq(vault.queueLength(), 0);
        assertEq(usdc.balanceOf(alice), 85_000e6);
    }

    function test_SmallWithdrawalAlwaysInstantWhenCashExists() public {
        _deposit(carol, 10e6);
        _withdraw(carol, 10e6);
        assertEq(usdc.balanceOf(carol), 100_000e6);
    }

    function test_LastSaverOutIsPaidInstantly() public {
        _deposit(alice, 250e6); // not invested yet, all in the drawer
        _withdraw(alice, 250e6);
        assertEq(vault.queueLength(), 0);
        assertEq(usdc.balanceOf(alice), 100_000e6);
    }

    function test_FeesPaidToTreasury() public {
        _deposit(alice, 10_000e6);
        vault.rebalance();
        vm.warp(block.timestamp + 30 days);
        vault.harvest();
        uint256 fees = vault.feesAccrued();
        vault.payFees();
        assertEq(usdc.balanceOf(treasury), fees);
    }

    // ------------------------------------------------------------------ fuzz: never lose principal

    function testFuzz_EveryoneGetsPrincipalBack(uint96 a, uint96 b, uint32 wait) public {
        uint256 amtA = bound(uint256(a), 10e6, 90_000e6);
        uint256 amtB = bound(uint256(b), 10e6, 90_000e6);
        uint256 dt = bound(uint256(wait), 0, 60 days);
        tbill.setRules(0, 0, 0, false);
        _deposit(alice, amtA);
        _deposit(bob, amtB);
        vault.rebalance();
        vm.warp(block.timestamp + dt);
        vault.harvest();
        _withdraw(alice, vault.balanceOf(alice));
        _withdraw(bob, vault.balanceOf(bob));
        for (uint256 i = 0; i < 4 && vault.queueLength() > 0; i++) {
            vault.rebalance();
            vm.warp(block.timestamp + 1);
        }
        assertEq(vault.queueLength(), 0);
        assertEq(usdc.balanceOf(alice), 100_000e6);
        assertEq(usdc.balanceOf(bob), 100_000e6);
    }

    // ------------------------------------------------------------------ Chainlink VRF path

    function test_ChainlinkVRFDraw() public {
        VRFCoordinatorV2_5Mock coord = new VRFCoordinatorV2_5Mock(0.1 ether, 1e9, 4e15);
        uint256 subId = coord.createSubscription();
        coord.fundSubscriptionWithNative{value: 10 ether}(subId);
        ChainlinkVRFSource vrf = new ChainlinkVRFSource(address(coord), address(vault), subId, bytes32(uint256(1)));
        coord.addConsumer(subId, address(vrf));
        vault.setRandomSource(vrf);

        _deposit(alice, 3_000e6);
        _deposit(bob, 3_000e6);
        vault.rebalance();
        vm.warp(block.timestamp + 7 days);
        uint256 id = vault.closeDraw();
        coord.fulfillRandomWords(1, address(vrf));
        (KairosVault.Draw memory d, address[] memory winners,,) = vault.getDraw(id);
        assertTrue(d.awarded);
        assertEq(winners.length, 3);
    }
}

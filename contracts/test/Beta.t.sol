// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {VRFCoordinatorV2_5Mock} from "@chainlink/src/v0.8/vrf/mocks/VRFCoordinatorV2_5Mock.sol";
import {KairosBetaSetup} from "../src/KairosBetaSetup.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {KairosVault} from "../src/KairosVault.sol";

contract BetaTest is Test {
    VRFCoordinatorV2_5Mock coord;
    KairosBetaSetup setup;
    address ramy = makeAddr("ramy");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        coord = new VRFCoordinatorV2_5Mock(0.0001 ether, 1e9, 4e15);
        vm.deal(address(this), 10 ether);
        setup = new KairosBetaSetup{value: 1 ether}(address(coord), bytes32(uint256(1)), ramy, 1 days, 30, 100_000e6);
    }

    function save(address who, uint256 amount) internal {
        MockUSDC usdc = setup.usdc();
        KairosVault vault = setup.vault();
        vm.startPrank(who);
        usdc.topUp(amount);
        usdc.approve(address(vault), amount);
        vault.deposit(amount);
        vm.stopPrank();
    }

    function test_everythingBelongsToRamy() public view {
        assertEq(setup.vault().owner(), ramy);
        assertEq(setup.usdc().owner(), ramy);
        assertEq(setup.tbill().owner(), ramy);
        assertEq(address(setup.vault().randomSource()), address(setup.vrf()));
        assertEq(setup.vault().minDeposit(), 1e6);
        (uint96 bal, uint96 nativeBal,, address subOwner, address[] memory consumers) = coord.getSubscription(setup.subscriptionId());
        bal;
        assertEq(nativeBal, 1 ether);
        assertEq(subOwner, address(setup)); // ramy accepts later
        assertEq(consumers[0], address(setup.vrf()));
    }

    function test_drawWithChainlink() public {
        save(alice, 500e6);
        save(bob, 1e6); // the $1 minimum works
        setup.vault().rebalance();
        vm.warp(block.timestamp + 1 days + 1);
        uint256 drawId = setup.vault().closeDraw();
        uint256 requestId = 1;
        assertEq(setup.vrf().drawOfRequest(requestId), drawId);
        coord.fulfillRandomWords(requestId, address(setup.vrf()));
        (KairosVault.Draw memory d, address[] memory winners,,) = setup.vault().getDraw(drawId);
        assertTrue(d.awarded);
        assertEq(winners.length, setup.vault().prizeSplits().length);
        assertGt(setup.vault().balanceOf(alice) + setup.vault().balanceOf(bob), 501e6); // prizes landed in savings
    }

    function test_houseMoneyIsInForGoodAndNeverWins() public {
        KairosVault vault = setup.vault();
        assertEq(vault.totalSponsored(), 100_000e6, "house money in");
        assertEq(vault.sponsored(address(setup)), 100_000e6);
        assertEq(vault.totalSupply(), 0, "it isn't anyone's savings");
        assertGt(setup.tbill().balanceOf(address(vault)), 0, "already in T-bills");
        vm.warp(block.timestamp + 1 hours);
        // a month of interest a day: about $12.67 an hour on the $92,500 in T-bills at 4% (7.5% stays as cash)
        assertApproxEqAbs(vault.availableInterest(), 12_671_233, 50_000, "the pool grows with nobody saving");
        save(alice, 10e6);
        vm.warp(block.timestamp + 1 days);
        uint256 drawId = vault.closeDraw();
        coord.fulfillRandomWords(1, address(setup.vrf()));
        (, address[] memory winners,,) = vault.getDraw(drawId);
        for (uint256 i = 0; i < winners.length; i++) assertEq(winners[i], alice, "only savers win");
    }

    function test_topUpHasNoDailyLimit() public {
        MockUSDC usdc = setup.usdc();
        vm.startPrank(alice);
        for (uint256 i = 0; i < 5; i++) usdc.topUp(1_000_000e6);
        vm.expectRevert(bytes("topup: up to $1,000,000 at a time"));
        usdc.topUp(1_000_000e6 + 1);
        vm.stopPrank();
        assertEq(usdc.balanceOf(alice), 5_000_000e6);
    }
}

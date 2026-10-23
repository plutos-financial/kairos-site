// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {MockTBill} from "../src/MockTBill.sol";
import {KairosVault, ITBillFund} from "../src/KairosVault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ManualRandom} from "./Draws.t.sol";

/// Does random things to the vault, the way savers, the keeper and the team would, and keeps a
/// ghost ledger of what each saver put in, took out and won.
contract Handler is Test {
    MockUSDC public usdc;
    MockTBill public tbill;
    KairosVault public vault;
    ManualRandom public rng;
    address public owner;

    address[] public actors;
    mapping(address => uint256) public deposited;
    mapping(address => uint256) public withdrawn;
    mapping(address => uint256) public won;
    uint256 public totalDeposited;
    uint256 public totalWithdrawn;
    uint256 public draws;
    uint256 public awards;

    constructor(MockUSDC u, MockTBill t, KairosVault v, ManualRandom r, address o) {
        usdc = u;
        tbill = t;
        vault = v;
        rng = r;
        owner = o;
        for (uint256 i = 0; i < 5; i++) actors.push(address(uint160(0xA000 + i)));
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function deposit(uint256 seed, uint256 amount) external {
        address a = _actor(seed);
        amount = bound(amount, 1e6, 1_000_000e6);
        vm.startPrank(a);
        usdc.topUp(amount);
        usdc.approve(address(vault), amount);
        vault.deposit(amount);
        vm.stopPrank();
        deposited[a] += amount;
        totalDeposited += amount;
    }

    function withdraw(uint256 seed, uint256 amount) external {
        address a = _actor(seed);
        uint256 bal = vault.balanceOf(a);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        vm.prank(a);
        vault.withdraw(amount);
        withdrawn[a] += amount;
        totalWithdrawn += amount;
    }

    function wait(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 3 days));
    }

    function rebalance() external {
        vault.rebalance();
    }

    function payFees() external {
        try vault.payFees() {} catch {}
    }

    function weekend(bool on) external {
        vm.prank(owner);
        tbill.setRules(0, 0, 1 days, !on);
    }

    function setPrizes(uint256 n) external {
        n = bound(n, 1, 20);
        uint16[] memory s = new uint16[](n);
        uint256 each = 10_000 / n;
        for (uint256 i = 0; i < n; i++) s[i] = uint16(each);
        s[0] += uint16(10_000 - each * n);
        vm.prank(owner);
        vault.setPrizeSplits(s);
    }

    function close() external {
        if (block.timestamp < vault.nextDrawTime()) return;
        uint256 id = vault.currentDrawId();
        if (id > 1) {
            (KairosVault.Draw memory p,,,) = vault.getDraw(id - 1);
            if (!p.awarded) return;
        }
        vault.closeDraw();
        draws++;
    }

    /// The random number arrives; winners are paid in the same transaction, or (lowGas) separately.
    function answer(uint256 word, bool lowGas) external {
        uint256 id = vault.currentDrawId() - 1;
        if (id == 0) return;
        (KairosVault.Draw memory d,,,) = vault.getDraw(id);
        if (d.prize == 0 || d.awarded || d.randomReady) return;
        uint256[] memory before = new uint256[](actors.length);
        for (uint256 i = 0; i < actors.length; i++) before[i] = vault.balanceOf(actors[i]);
        if (lowGas) {
            rng.answerWithGas(id, word, 120_000);
            vault.awardDraw(id);
        } else {
            rng.answer(id, word);
        }
        for (uint256 i = 0; i < actors.length; i++) won[actors[i]] += vault.balanceOf(actors[i]) - before[i];
        awards++;
    }
}

/// The promises Plutos makes, checked after every random step of hundreds of random runs.
contract InvariantsTest is StdInvariant, Test {
    MockUSDC usdc;
    MockTBill tbill;
    KairosVault vault;
    ManualRandom rng;
    Handler handler;

    function setUp() public {
        vm.warp(1_700_000_000);
        usdc = new MockUSDC();
        tbill = new MockTBill(usdc);
        usdc.setMinter(address(tbill), true);
        vault = new KairosVault(IERC20(address(usdc)), ITBillFund(address(tbill)), address(0xFEE));
        tbill.setAllowlisted(address(vault), true);
        usdc.mint(address(vault), 1e6); // the $1 rounding reserve, as KairosBetaSetup does
        rng = new ManualRandom();
        rng.setVault(address(vault));
        vault.setRandomSource(rng);
        vault.setDrawPeriod(1 days);
        vault.setDepositRules(1e6, false);
        tbill.setSpeed(2_000); // interest piles up fast, so draws have prizes
        handler = new Handler(usdc, tbill, vault, rng, address(this));
        targetContract(address(handler));
    }

    /// The vault always holds at least what it owes: everyone's savings, queued withdrawals,
    /// prizes not yet paid and fees not yet paid.
    function invariant_alwaysSolvent() public view {
        assertGe(vault.totalAssets(), vault.totalLiabilities(), "assets cover everything owed");
    }

    /// Prizes only ever come from interest: every dollar paid out, waiting in the pool or locked in
    /// a draw was harvested interest, and savings = deposits - withdrawals + prizes, to the cent.
    function invariant_prizesOnlyFromInterest() public view {
        assertEq(
            vault.totalPrizesPaid() + vault.prizeReserve() + vault.prizesPending(),
            vault.totalHarvestedToPrizes(),
            "every prize dollar was harvested interest"
        );
        assertEq(
            vault.totalSupply(),
            handler.totalDeposited() + vault.totalPrizesPaid() - handler.totalWithdrawn(),
            "savings = deposits - withdrawals + prizes"
        );
    }

    /// Each saver's balance is exactly what they put in, minus what they took out, plus what they won.
    function invariant_everySaversLedger() public view {
        for (uint256 i = 0; i < handler.actorCount(); i++) {
            address a = handler.actors(i);
            assertEq(vault.balanceOf(a), handler.deposited(a) + handler.won(a) - handler.withdrawn(a), "saver ledger");
        }
    }

    /// The entries tree agrees with the token: its root holds total savings, and everyone's entries
    /// add up to the total the draw will use.
    function invariant_entriesAddUp() public view {
        (uint256 rootBal,,) = vault.treeTotals();
        assertEq(rootBal, vault.totalSupply(), "tree root = total savings");
        uint256 end = vault.nextDrawTime();
        if (end < block.timestamp) end = block.timestamp;
        uint256 sum;
        for (uint256 i = 0; i < handler.actorCount(); i++) sum += vault.weightAt(handler.actors(i), end);
        (, uint256 total) = vault.projectedOdds(address(0));
        assertEq(sum, total, "entries add up");
    }

    /// At the end of every run, every saver takes out everything, and gets every cent back.
    function afterInvariant() public {
        uint256 n = handler.actorCount();
        uint256[] memory owed = new uint256[](n);
        uint256[] memory cashBefore = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            address a = handler.actors(i);
            owed[i] = vault.balanceOf(a);
            cashBefore[i] = usdc.balanceOf(a);
            // plus anything they asked for earlier that's still waiting in the withdrawal queue
            for (uint256 q = vault.queueHead(); q < vault.queueHead() + vault.queueLength(); q++) {
                (address user, uint256 amount) = vault.queue(q);
                if (user == a) owed[i] += amount;
            }
            uint256 savings = vault.balanceOf(a);
            if (savings > 0) {
                vm.prank(a);
                vault.withdraw(savings);
            }
        }
        for (uint256 k = 0; k < 30 && vault.queueLength() > 0; k++) {
            vault.rebalance();
            vm.warp(block.timestamp + 1 days + 1);
            vault.processQueue(50);
        }
        assertEq(vault.queueLength(), 0, "every withdrawal paid");
        for (uint256 i = 0; i < n; i++) {
            address a = handler.actors(i);
            assertEq(usdc.balanceOf(a) - cashBefore[i], owed[i], "got every cent back");
        }
        assertEq(vault.totalSupply(), 0);
        assertGe(vault.totalAssets(), vault.totalLiabilities(), "still solvent after everyone left");
    }
}

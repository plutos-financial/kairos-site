// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {MockTBill} from "../src/MockTBill.sol";
import {KairosVault, ITBillFund} from "../src/KairosVault.sol";
import {IRandomSource, IRandomConsumer} from "../src/IRandomSource.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {KairosVaultV1, ITBillFundV1} from "./legacy/KairosVaultV1.sol";

/// A random source the test answers by hand, with a chosen number and a chosen gas budget.
contract ManualRandom is IRandomSource {
    address public vault;
    uint256 public requests;

    function setVault(address v) external {
        vault = v;
    }

    function requestRandomness(uint256) external {
        require(msg.sender == vault, "only vault");
        requests++;
    }

    function answer(uint256 drawId, uint256 word) external {
        IRandomConsumer(vault).fulfillRandomness(drawId, word);
    }

    function answerWithGas(uint256 drawId, uint256 word, uint256 gas) external {
        IRandomConsumer(vault).fulfillRandomness{gas: gas}(drawId, word);
    }
}

/// The draw, checked against a brute-force model: every saver's entries are recomputed the slow,
/// obvious way (integrate each balance over time, and keep a list of every deposit with the round it
/// arrived in for the loyalty boost, taking withdrawals from the newest), lined up, and searched one by
/// one. The vault's sum tree has to agree with that model exactly: same entries, same totals, same winners.
contract DrawsTest is Test {
    MockUSDC usdc;
    MockTBill tbill;
    KairosVault vault;
    ManualRandom rng;

    uint256 constant N = 8;
    address[N] people;

    // the brute-force model
    uint256[N] acc; // balance x seconds this round
    uint256[N] lastBal;
    uint256 lastT;
    uint256[N] frozenAcc; // the closed draw's entries (in halves, with the boost), as of its close
    bool haveFrozen;
    uint256 frozenId;
    // every saver's dollars still in, as (round it arrived, amount), oldest first
    mapping(uint256 => uint256[]) lotRound;
    mapping(uint256 => uint256[]) lotAmount;

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
        tbill.setSpeed(1_000); // interest piles up fast, so every draw has a prize
        for (uint256 i = 0; i < N; i++) {
            people[i] = address(uint160(0x1000 + i));
            usdc.mint(people[i], 10_000_000e6);
            vm.prank(people[i]);
            usdc.approve(address(vault), type(uint256).max);
        }
        lastT = block.timestamp;
    }

    // ------------------------------------------------------------------ the model

    function _advance() internal {
        uint256 dt = block.timestamp - lastT;
        for (uint256 i = 0; i < N; i++) acc[i] += lastBal[i] * dt;
        lastT = block.timestamp;
    }

    /// Balances moved: new dollars arrive this round; dollars taken out come off the newest lots.
    function _sync() internal {
        uint256 round = vault.currentDrawId();
        for (uint256 i = 0; i < N; i++) {
            uint256 b = vault.balanceOf(people[i]);
            if (b > lastBal[i]) {
                lotRound[i].push(round);
                lotAmount[i].push(b - lastBal[i]);
            } else if (b < lastBal[i]) {
                uint256 left = lastBal[i] - b;
                while (left > 0) {
                    uint256 j = lotAmount[i].length - 1;
                    uint256 a = lotAmount[i][j];
                    if (a <= left) {
                        left -= a;
                        lotAmount[i].pop();
                        lotRound[i].pop();
                    } else {
                        lotAmount[i][j] = a - left;
                        left = 0;
                    }
                }
            }
            lastBal[i] = b;
        }
    }

    function _boostHalves(uint256 age) internal pure returns (uint256) {
        return age < 3 ? 0 : age < 6 ? 1 : age < 12 ? 2 : 4;
    }

    /// The boost in `round`, in halves of a dollar, the slow way: every lot, by its age.
    function _bonus(uint256 i, uint256 round) internal view returns (uint256 b) {
        for (uint256 j = 0; j < lotAmount[i].length; j++) {
            if (lotRound[i][j] > round) continue;
            b += lotAmount[i][j] * _boostHalves(round - lotRound[i][j]);
        }
    }

    function _idx(address a) internal view returns (uint256) {
        for (uint256 i = 0; i < N; i++) if (people[i] == a) return i;
        revert("not a person");
    }

    /// The line exactly as the brute-force model sees it: savers in order of first deposit, entries > 0.
    function _modelWinners(uint256 drawId, uint256 word) internal view returns (address[] memory winners) {
        (KairosVault.Draw memory d,,,) = vault.getDraw(drawId);
        uint256 size = d.lineSize;
        uint256[] memory cum = new uint256[](size);
        address[] memory who = new address[](size);
        uint256 total;
        uint256 m;
        for (uint256 i = 0; i < size; i++) {
            address s = vault.saverAt(i);
            uint256 w = frozenAcc[_idx(s)];
            if (w == 0) continue;
            total += w;
            cum[m] = total;
            who[m] = s;
            m++;
        }
        assertEq(total, d.totalWeight, "model total = vault total");
        uint256 n = vault.prizeSplits().length;
        winners = new address[](n);
        for (uint256 k = 0; k < n; k++) {
            uint256 ticket = uint256(keccak256(abi.encode(word, k))) % total;
            uint256 j = 0;
            while (cum[j] <= ticket) j++; // linear search: slow and obviously right
            winners[k] = who[j];
        }
    }

    function _checkFrozenLine() internal view {
        if (!haveFrozen) return;
        (KairosVault.Draw memory d,,,) = vault.getDraw(frozenId);
        (address[] memory savers, uint256[] memory weights) = vault.drawLine(frozenId, 0, d.lineSize);
        uint256 total;
        for (uint256 i = 0; i < savers.length; i++) {
            assertEq(weights[i], frozenAcc[_idx(savers[i])], "frozen entries unchanged");
            total += weights[i];
        }
        assertEq(total, d.totalWeight, "frozen total unchanged");
    }

    function _checkCurrentRound() internal view {
        uint256 end = vault.nextDrawTime();
        if (end < block.timestamp) end = block.timestamp;
        uint256 sum;
        uint256 round = vault.currentDrawId();
        uint256 length = end - vault.periodStart();
        for (uint256 i = 0; i < N; i++) {
            uint256 expect = 2 * (acc[i] + lastBal[i] * (end - block.timestamp)) + length * _bonus(i, round);
            assertEq(vault.weightAt(people[i], end), expect, "current entries = model");
            sum += expect;
        }
        (, uint256 total) = vault.projectedOdds(people[0]);
        assertEq(total, sum, "projected total = sum of everyone's");
        (uint256 rootBal,,) = vault.treeTotals();
        assertEq(rootBal, vault.totalSupply(), "tree root = total savings");
    }

    // ------------------------------------------------------------------ actions

    function _deposit(uint256 i, uint256 amt) internal {
        _advance();
        vm.prank(people[i]);
        vault.deposit(amt);
        _sync();
    }

    function _withdraw(uint256 i, uint256 amt) internal {
        _advance();
        vm.prank(people[i]);
        vault.withdraw(amt);
        _sync();
    }

    function _close() internal returns (uint256 id) {
        uint256 t = vault.nextDrawTime() + 1 + (uint256(keccak256(abi.encode(block.timestamp))) % 3 hours);
        if (t > block.timestamp) vm.warp(t); // (a round can also close late)
        usdc.mint(address(vault), 500e6); // interest arrives, so there's a prize
        _advance();
        uint256 round = vault.currentDrawId();
        uint256 length = block.timestamp - vault.periodStart();
        uint256[N] memory w;
        for (uint256 i = 0; i < N; i++) w[i] = 2 * acc[i] + length * _bonus(i, round);
        id = vault.closeDraw();
        (KairosVault.Draw memory d,,,) = vault.getDraw(id);
        if (d.prize > 0) {
            frozenAcc = w;
            frozenId = id;
            haveFrozen = true;
        } else {
            haveFrozen = false;
        }
        for (uint256 i = 0; i < N; i++) acc[i] = 0;
        _sync();
    }

    function _answer(uint256 id, uint256 word) internal {
        _advance();
        rng.answer(id, word);
        _sync();
    }

    function _rand(uint256 seed, uint256 k) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(seed, k)));
    }

    // ------------------------------------------------------------------ tests

    /// Random deposits, withdrawals and waits over four rounds, including while a draw waits for its
    /// random number and savers who join during that wait. After every step the vault must agree with
    /// the brute-force model, and every draw must pick the model's winners.
    function testFuzz_DrawsMatchBruteForce(uint256 seed) public {
        uint256 k;
        for (uint256 round = 0; round < 4; round++) {
            uint256 steps = 3 + (_rand(seed, k++) % 6);
            for (uint256 s = 0; s < steps; s++) {
                vm.warp(block.timestamp + (_rand(seed, k++) % 8 hours));
                uint256 i = _rand(seed, k++) % N;
                uint256 held = vault.balanceOf(people[i]);
                if (held > 0 && _rand(seed, k++) % 3 == 0) {
                    _withdraw(i, 1 + (_rand(seed, k++) % held));
                } else {
                    _deposit(i, 1e6 + (_rand(seed, k++) % 50_000e6));
                }
                _checkCurrentRound();
                _checkFrozenLine();
            }
            vault.rebalance();
            uint256 id = _close();
            _checkCurrentRound();
            _checkFrozenLine();
            (KairosVault.Draw memory d,,,) = vault.getDraw(id);
            if (d.prize == 0) continue;

            // While waiting for the random number: more activity, including brand-new savers.
            for (uint256 s = 0; s < 3; s++) {
                vm.warp(block.timestamp + (_rand(seed, k++) % 2 hours));
                uint256 i = _rand(seed, k++) % N;
                uint256 held = vault.balanceOf(people[i]);
                if (held > 0 && _rand(seed, k++) % 2 == 0) _withdraw(i, 1 + (_rand(seed, k++) % held));
                else _deposit(i, 1e6 + (_rand(seed, k++) % 50_000e6));
                _checkFrozenLine();
                _checkCurrentRound();
            }

            uint256 word = _rand(seed, k++);
            address[] memory expected = _modelWinners(id, word);
            _answer(id, word);
            (KairosVault.Draw memory after_, address[] memory winners,,) = vault.getDraw(id);
            assertTrue(after_.awarded, "awarded");
            assertEq(winners.length, expected.length);
            for (uint256 w = 0; w < winners.length; w++) assertEq(winners[w], expected[w], "same winner as brute force");
            _checkFrozenLine(); // still frozen after the prizes were paid
            _checkCurrentRound();
        }
    }

    function test_CannotCloseWhileLastDrawIsPicking() public {
        _deposit(0, 1_000e6);
        vault.rebalance();
        uint256 id = _close();
        vm.warp(vault.nextDrawTime() + 1);
        vm.expectRevert("kairos: last draw still picking winners");
        vault.closeDraw();
        _answer(id, 42);
        vault.closeDraw(); // fine once it has paid out
    }

    function test_AwardDrawWhenTheCallbackRunsShortOfGas() public {
        for (uint256 i = 0; i < N; i++) _deposit(i, (i + 1) * 100e6);
        vault.setPrizeSplits(_splits(20));
        vault.rebalance();
        uint256 id = _close();
        // Not enough gas to pay 20 prizes inside the callback: the number is kept, winners wait.
        rng.answerWithGas(id, 7, 150_000);
        (KairosVault.Draw memory d,,,) = vault.getDraw(id);
        assertTrue(d.randomReady);
        assertFalse(d.awarded);
        address[] memory expected = _modelWinners(id, 7);
        vm.prank(address(0xBEEF)); // anyone can finish it
        vault.awardDraw(id);
        (, address[] memory winners, uint256[] memory amounts,) = vault.getDraw(id);
        uint256 paid;
        for (uint256 w = 0; w < winners.length; w++) {
            assertEq(winners[w], expected[w]);
            paid += amounts[w];
        }
        assertEq(paid, d.prize, "every cent of the prize paid");
        vm.expectRevert("kairos: not ready to award");
        vault.awardDraw(id);
    }

    function test_RetryRandomness() public {
        _deposit(0, 1_000e6);
        vault.rebalance();
        uint256 id = _close();
        assertEq(rng.requests(), 1);
        vault.retryRandomness(id);
        assertEq(rng.requests(), 2);
        vm.prank(address(0xBAD));
        vm.expectRevert();
        vault.retryRandomness(id);
        _answer(id, 9);
        vm.expectRevert("kairos: nothing waiting");
        vault.retryRandomness(id);
    }

    function test_OnlyTheLatestLineIsKept() public {
        _deposit(0, 1_000e6);
        vault.rebalance();
        uint256 first = _close();
        _answer(first, 1);
        vault.drawLine(first, 0, 10);
        vault.rebalance();
        uint256 second = _close();
        vault.drawLine(second, 0, 10);
        vm.expectRevert("kairos: only the latest draw's line is kept");
        vault.drawLine(first, 0, 10);
    }

    /// Sixteen rounds, so dollars reach every boost tier (1.5x after 3 rounds, 2x after 6, 3x after 12),
    /// with withdrawals taking the newest dollars, prizes arriving as new dollars, and draws waiting
    /// for their number while people come and go. The vault must match the model at every step.
    function testFuzz_BoostMatchesBruteForce(uint256 seed) public {
        uint256 k;
        for (uint256 round = 0; round < 16; round++) {
            uint256 steps = 1 + (_rand(seed, k++) % 3);
            for (uint256 s = 0; s < steps; s++) {
                vm.warp(block.timestamp + (_rand(seed, k++) % 6 hours));
                uint256 i = _rand(seed, k++) % N;
                uint256 held = vault.balanceOf(people[i]);
                if (held > 0 && _rand(seed, k++) % 3 == 0) _withdraw(i, 1 + (_rand(seed, k++) % held));
                else _deposit(i, 1e6 + (_rand(seed, k++) % 20_000e6));
                _checkCurrentRound();
                _checkFrozenLine();
            }
            vault.rebalance();
            uint256 id = _close();
            _checkCurrentRound();
            _checkFrozenLine();
            (KairosVault.Draw memory d,,,) = vault.getDraw(id);
            if (d.prize == 0) continue;
            // a withdrawal while the draw waits: it takes boosted dollars, and the closed draw must not move
            uint256 j = _rand(seed, k++) % N;
            uint256 h = vault.balanceOf(people[j]);
            if (h > 1) _withdraw(j, 1 + (_rand(seed, k++) % (h - 1)));
            _checkFrozenLine();
            _checkCurrentRound();
            uint256 word = _rand(seed, k++);
            address[] memory expected = _modelWinners(id, word);
            _answer(id, word);
            (, address[] memory winners,,) = vault.getDraw(id);
            for (uint256 w = 0; w < winners.length; w++) assertEq(winners[w], expected[w], "same winner as brute force");
            _checkFrozenLine();
            _checkCurrentRound();
        }
    }

    /// Round helpers for the boost tests: close the round (no prize), so the next one starts.
    function _nextRound() internal {
        vm.warp(vault.nextDrawTime() + 1);
        _advance();
        vault.closeDraw();
        for (uint256 i = 0; i < N; i++) acc[i] = 0;
        _sync();
    }

    /// Entries per dollar for someone who has been in the whole round: weight / (2 x length x balance).
    function _perDollarX100(uint256 i) internal view returns (uint256) {
        uint256 end = vault.nextDrawTime();
        uint256 length = end - vault.periodStart();
        return (vault.weightAt(people[i], end) * 100) / (2 * length * vault.balanceOf(people[i]));
    }

    function test_BoostStepsUpWithEachTier() public {
        _deposit(0, 1_000e6);
        _nextRound(); // round 2 starts; the dollars are now in for a full round
        uint256[14] memory expectX100 = [uint256(0), 0, 100, 100, 150, 150, 150, 200, 200, 200, 200, 200, 200, 300];
        for (uint256 r = 2; r <= 13; r++) {
            assertEq(vault.currentDrawId(), r);
            assertEq(_perDollarX100(0), expectX100[r], "entries per dollar for its age");
            _nextRound();
        }
        assertEq(_perDollarX100(0), 300, "3x from round 13 on");
        (uint256[4] memory tiers, uint256 nextIn,,) = vault.boostOf(people[0]);
        assertEq(tiers[3], 1_000e6, "all at 3x");
        assertEq(nextIn, 0, "nothing left to step up");
    }

    function test_WithdrawalsTakeTheNewestDollarsFirst() public {
        _deposit(0, 1_000e6); // round 1
        for (uint256 r = 0; r < 6; r++) _nextRound(); // round 7: those dollars are 2x
        _deposit(0, 500e6); // new, 1x
        (uint256[4] memory tiers, uint256 nextIn, uint256 nextAmount, uint256 nextTier) = vault.boostOf(people[0]);
        assertEq(tiers[0], 500e6);
        assertEq(tiers[2], 1_000e6);
        assertEq(nextIn, 3, "the new $500 reaches 1.5x in 3 rounds");
        assertEq(nextAmount, 500e6);
        assertEq(nextTier, 1);
        _withdraw(0, 600e6); // all $500 new, then $100 of the old
        (tiers,,,) = vault.boostOf(people[0]);
        assertEq(tiers[0], 0, "the new dollars went first");
        assertEq(tiers[2], 900e6, "the rest keeps its 2x");
        _checkCurrentRound();
    }

    function test_TopUpDoesNotResetTheBoost() public {
        _deposit(1, 2_000e6);
        for (uint256 r = 0; r < 12; r++) _nextRound(); // round 13: 3x
        _deposit(1, 2_000e6);
        _nextRound();
        // $2,000 at 3x and $2,000 at 1x: 8,000 entries for 4,000 dollars = 2x on average
        assertEq(_perDollarX100(1), 200);
    }

    function _splits(uint256 n) internal pure returns (uint16[] memory s) {
        s = new uint16[](n);
        uint256 each = 10_000 / n;
        for (uint256 i = 0; i < n; i++) s[i] = uint16(each);
        s[0] += uint16(10_000 - each * n);
    }
}

/// How the cost of a draw grows with the number of savers: the sum-tree vault vs. the original.
contract DrawGasTest is Test {
    MockUSDC usdc;
    MockTBill tbill;
    ManualRandom rng;

    function _savers(uint256 n, address vault) internal {
        vm.pauseGasMetering();
        for (uint256 i = 0; i < n; i++) {
            address a = address(uint160(0x100000 + i));
            usdc.mint(a, 100e6 + i);
            vm.startPrank(a);
            usdc.approve(vault, type(uint256).max);
            KairosVault(vault).deposit(100e6 + i);
            vm.stopPrank();
            if (i % 50 == 0) vm.warp(block.timestamp + 1 minutes);
        }
        vm.resumeGasMetering();
    }

    function _fresh() internal {
        vm.warp(1_700_000_000);
        usdc = new MockUSDC();
        tbill = new MockTBill(usdc);
        usdc.setMinter(address(tbill), true);
        tbill.setSpeed(1_000);
        rng = new ManualRandom();
    }

    function _newVault() internal returns (KairosVault v) {
        _fresh();
        v = new KairosVault(IERC20(address(usdc)), ITBillFund(address(tbill)), address(0xFEE));
        tbill.setAllowlisted(address(v), true);
        usdc.mint(address(v), 1e6); // the $1 rounding reserve, as KairosBetaSetup does
        rng.setVault(address(v));
        v.setRandomSource(rng);
        v.setDrawPeriod(1 days);
        v.setDepositRules(1e6, false);
    }

    function _oldVault() internal returns (KairosVaultV1 v) {
        _fresh();
        v = new KairosVaultV1(IERC20(address(usdc)), ITBillFundV1(address(tbill)), address(0xFEE));
        tbill.setAllowlisted(address(v), true);
        usdc.mint(address(v), 1e6); // the $1 rounding reserve, as KairosBetaSetup does
        rng.setVault(address(v));
        v.setRandomSource(rng);
        v.setDrawPeriod(1 days);
        v.setDepositRules(1e6, false);
    }

    function _measureNew(uint256 n) internal returns (uint256 dep, uint256 close, uint256 award) {
        KairosVault v = _newVault();
        _savers(n, address(v));
        vm.warp(block.timestamp + 1 days + 1);
        v.rebalance();
        usdc.mint(address(v), 500e6); // interest, so there's a prize
        // one more saver joins: what a deposit costs at this size
        address late = address(0xD0D0);
        usdc.mint(late, 50e6);
        vm.prank(late);
        usdc.approve(address(v), type(uint256).max);
        uint256 g = gasleft();
        vm.prank(late);
        v.deposit(50e6);
        dep = g - gasleft();
        g = gasleft();
        uint256 id = v.closeDraw();
        close = g - gasleft();
        rng.answerWithGas(id, 123, 100_000); // keep the number only, then pay the winners separately
        g = gasleft();
        v.awardDraw(id);
        award = g - gasleft();
    }

    function _measureOld(uint256 n) internal returns (uint256 close) {
        KairosVaultV1 v = _oldVault();
        _savers(n, address(v));
        vm.warp(block.timestamp + 1 days + 1);
        v.rebalance();
        usdc.mint(address(v), 500e6);
        uint256 g = gasleft();
        v.closeDraw();
        close = g - gasleft();
    }

    /// Run with -vv to see the table. The new vault's close and award stay flat as savers grow;
    /// the original's close grows with every saver.
    function test_DrawCostStaysFlat() public {
        uint256[5] memory sizes = [uint256(10), 100, 500, 1_000, 2_000];
        uint256 firstAward;
        uint256 lastAward;
        uint256 lastClose;
        console2.log("savers | deposit (new) | closeDraw (new) | awardDraw 3 prizes (new) | closeDraw (original)");
        for (uint256 i = 0; i < sizes.length; i++) {
            (uint256 dep, uint256 close, uint256 award) = _measureNew(sizes[i]);
            uint256 old = _measureOld(sizes[i]);
            console2.log(string.concat(vm.toString(sizes[i]), " | ", vm.toString(dep), " | ", vm.toString(close), " | ", vm.toString(award), " | ", vm.toString(old)));
            if (i == 0) firstAward = award;
            lastAward = award;
            lastClose = close;
            if (sizes[i] == 2_000) assertGt(old, 20 * close, "original close grows with savers");
        }
        assertLt(lastClose, 300_000, "close stays flat");
        assertLt(lastAward, firstAward * 3, "award grows only with log(savers)");
    }
}

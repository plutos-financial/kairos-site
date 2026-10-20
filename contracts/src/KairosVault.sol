// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IRandomSource, IRandomConsumer} from "./IRandomSource.sol";

/// @notice The parts of a tokenized T-bill fund Kairos uses (matches MockTBill).
interface ITBillFund is IERC20 {
    function nav() external view returns (uint256);
    function valueOf(uint256 tokens) external view returns (uint256);
    function subscribe(uint256 usdcAmount) external returns (uint256 tokens);
    function requestRedeem(uint256 tokens) external returns (uint256 id, uint256 usdcOwed);
    function claimRedeem(uint256 id) external returns (uint256);
    function isReady(uint256 id) external view returns (bool);
    function redeemInstant(uint256 tokens) external returns (uint256);
    function minSubscription() external view returns (uint256);
    function minRedemption() external view returns (uint256);
    function instantRedeemEnabled() external view returns (bool);
}

/// @title KairosVault
/// @notice Prize-linked savings. Savers deposit USDC and get Kairos Savings shares 1:1 (kUSD).
///         Shares never grow: every dollar of interest above total deposits is "harvested",
///         85% to the prize pool and 15% to the platform fee. Each period, winners are drawn
///         with odds weighted by balance x time held, and prizes are added to their savings.
///         A USDC "cash drawer" pays withdrawals instantly; the rest sits in T-bill fund tokens.
///
///         Golden rule: principal never enters the prize pool. Only the surplus above
///         (deposits + queued withdrawals + unpaid prizes + unpaid fees) is ever harvested.
contract KairosVault is ERC20, Ownable, Pausable, ReentrancyGuard, IRandomConsumer {
    using SafeERC20 for IERC20;

    uint256 public constant BPS = 10_000;

    IERC20 public immutable usdc;
    ITBillFund public immutable tbill;

    // ------------------------------------------------------------------ settings
    address public feeRecipient;
    uint256 public feeBps = 1_500; // 15% of interest
    uint256 public minDeposit = 10e6; // $10
    bool public requireAllowlist; // turn on once KYC is wired up
    mapping(address => bool) public allowlisted;

    // Cash drawer bands (see "Kairos Rebalancer"): target R, floor L, ceiling U, emergency E.
    uint256 public targetCashBps = 750; // R = 7.5% of deposits...
    uint256 public minTargetCash = 100e6; // ...but at least $100
    uint256 public lowBps = 8_000; // L = 0.8 R
    uint256 public highBps = 12_000; // U = 1.2 R
    uint256 public emergencyBps = 2_500; // E = 0.25 R
    uint256 public smallInstantLimit = 100e6; // withdrawals up to $100 are instant whenever cash exists

    IRandomSource public randomSource;
    uint256 public drawPeriod = 30 days;
    uint16[] public prizeSplitsBps; // e.g. [6000, 2500, 1500] = three winners per draw

    // ------------------------------------------------------------------ accounting
    uint256 public prizeReserve; // harvested, waiting for the next draw
    uint256 public prizesPending; // locked into a closed draw, waiting for randomness
    uint256 public feesAccrued; // platform's 15%, not yet paid out

    uint256[] public pendingRedemptionIds; // fund redemptions in flight (T+1)
    mapping(uint256 => uint256) public pendingRedemptionValue;
    uint256 public pendingValue;

    struct QueuedWithdrawal {
        address user;
        uint256 amount;
    }

    QueuedWithdrawal[] public queue;
    uint256 public queueHead;
    uint256 public queuedTotal;

    // ------------------------------------------------------------------ odds (time-weighted balances)
    struct Account {
        uint256 acc; // balance x seconds accumulated this period
        uint64 lastUpdate;
        uint64 period;
    }

    mapping(address => Account) public accounts;
    address[] public depositors;
    mapping(address => bool) public isDepositor;

    uint256 public currentDrawId = 1;
    uint256 public periodStart;

    struct Draw {
        uint64 closeTime;
        bool awarded;
        uint256 prize;
        uint256 totalWeight;
        uint256 randomWord;
    }

    mapping(uint256 => Draw) public draws;
    mapping(uint256 => address[]) internal drawUsers;
    mapping(uint256 => uint256[]) internal drawCumWeights;
    mapping(uint256 => address[]) internal drawWinners;
    mapping(uint256 => uint256[]) internal drawAmounts;

    // ------------------------------------------------------------------ events
    event Deposited(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount, string route);
    event WithdrawalQueued(address indexed user, uint256 amount, uint256 position);
    event QueuePaid(address indexed user, uint256 amount);
    event Harvested(uint256 interest, uint256 toPrizes, uint256 toFees);
    event Rebalanced(string action, uint256 amount);
    event RedemptionSettled(uint256 indexed id, uint256 amount);
    event DrawClosed(uint256 indexed drawId, uint256 prize, uint256 totalWeight, uint256 entrants);
    event DrawAwarded(uint256 indexed drawId, address[] winners, uint256[] amounts);
    event FeesPaid(address to, uint256 amount);

    constructor(IERC20 usdc_, ITBillFund tbill_, address feeRecipient_)
        ERC20("Kairos Savings", "kUSD")
        Ownable(msg.sender)
    {
        usdc = usdc_;
        tbill = tbill_;
        feeRecipient = feeRecipient_;
        periodStart = block.timestamp;
        prizeSplitsBps.push(6_000);
        prizeSplitsBps.push(2_500);
        prizeSplitsBps.push(1_500);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    // ================================================================== savers

    function deposit(uint256 amount) external nonReentrant whenNotPaused {
        require(amount >= minDeposit, "kairos: below minimum deposit");
        require(!requireAllowlist || allowlisted[msg.sender], "kairos: identity check required");
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        if (!isDepositor[msg.sender]) {
            isDepositor[msg.sender] = true;
            depositors.push(msg.sender);
        }
        _mint(msg.sender, amount);
        emit Deposited(msg.sender, amount);
    }

    /// @notice Always available, even when paused. Paid from the cash drawer when possible,
    ///         otherwise through the fund's instant route, otherwise queued for the next settlement.
    function withdraw(uint256 amount) external nonReentrant {
        require(amount > 0, "kairos: zero");
        _burn(msg.sender, amount); // reverts if balance too low

        uint256 cash = usdc.balanceOf(address(this));
        uint256 e = (targetCash() * emergencyBps) / BPS;
        // Never hold back more for the emergency floor than the other savers actually have deposited.
        if (e > totalSupply()) e = totalSupply();
        bool queueEmpty = queueHead == queue.length;

        if (queueEmpty && cash >= amount && (cash - amount >= e || amount <= smallInstantLimit)) {
            usdc.safeTransfer(msg.sender, amount);
            emit Withdrawn(msg.sender, amount, "drawer");
            return;
        }

        if (queueEmpty && tbill.instantRedeemEnabled() && tbill.balanceOf(address(this)) > 0) {
            uint256 shortBy = amount > cash ? amount - cash : amount;
            _redeemInstant(shortBy);
            if (usdc.balanceOf(address(this)) >= amount) {
                usdc.safeTransfer(msg.sender, amount);
                emit Withdrawn(msg.sender, amount, "fund-instant");
                return;
            }
        }

        queue.push(QueuedWithdrawal(msg.sender, amount));
        queuedTotal += amount;
        emit WithdrawalQueued(msg.sender, amount, queue.length - queueHead);
    }

    /// @notice Shares are a non-transferable savings receipt; this also keeps odds tracking exact.
    function _update(address from, address to, uint256 value) internal override {
        require(from == address(0) || to == address(0), "kairos: shares are non-transferable");
        if (from != address(0)) _accrue(from);
        if (to != address(0)) _accrue(to);
        super._update(from, to, value);
    }

    // ================================================================== interest

    function totalAssets() public view returns (uint256) {
        return usdc.balanceOf(address(this)) + tbill.valueOf(tbill.balanceOf(address(this))) + pendingValue;
    }

    /// @notice Everything the vault owes to someone. Assets above this line are new interest.
    function totalLiabilities() public view returns (uint256) {
        return totalSupply() + queuedTotal + prizeReserve + prizesPending + feesAccrued;
    }

    function availableInterest() public view returns (uint256) {
        uint256 a = totalAssets();
        uint256 l = totalLiabilities();
        return a > l ? a - l : 0;
    }

    /// @notice Anyone can call. Splits new interest 85% prizes / 15% fees. Never touches principal.
    function harvest() public returns (uint256 interest) {
        interest = availableInterest();
        if (interest == 0) return 0;
        uint256 fee = (interest * feeBps) / BPS;
        feesAccrued += fee;
        prizeReserve += interest - fee;
        emit Harvested(interest, interest - fee, fee);
    }

    function payFees() external nonReentrant {
        uint256 cash = usdc.balanceOf(address(this));
        uint256 amt = feesAccrued < cash ? feesAccrued : cash;
        require(amt > 0, "kairos: nothing to pay");
        feesAccrued -= amt;
        usdc.safeTransfer(feeRecipient, amt);
        emit FeesPaid(feeRecipient, amt);
    }

    // ================================================================== cash drawer

    function targetCash() public view returns (uint256 r) {
        r = (totalSupply() * targetCashBps) / BPS;
        if (r < minTargetCash) r = minTargetCash;
    }

    /// @notice One keeper tick (run every ~15 minutes). Anyone can call.
    ///         1) collect settled fund redemptions  2) pay the queue  3) keep cash inside the band.
    function rebalance() external nonReentrant {
        _settleRedemptions();
        _processQueue(25);

        uint256 r = targetCash();
        uint256 cash = usdc.balanceOf(address(this));
        uint256 incoming = cash + pendingValue;
        uint256 effective = incoming > queuedTotal ? incoming - queuedTotal : 0;

        if (effective < (r * lowBps) / BPS) {
            uint256 want = r + queuedTotal > incoming ? r + queuedTotal - incoming : 0;
            uint256 held = tbill.valueOf(tbill.balanceOf(address(this)));
            uint256 minRed = tbill.minRedemption();
            if (want < minRed) want = minRed;
            if (want > held) want = held;
            if (want > 0 && want >= minRed) {
                uint256 tokens = _tokensFor(want);
                (uint256 id, uint256 owed) = tbill.requestRedeem(tokens);
                pendingRedemptionIds.push(id);
                pendingRedemptionValue[id] = owed;
                pendingValue += owed;
                emit Rebalanced("redeem", owed);
                return;
            }
            emit Rebalanced("low-but-nothing-to-redeem", 0);
            return;
        }

        if (cash > (r * highBps) / BPS && queuedTotal == 0) {
            uint256 excess = cash - r;
            if (feesAccrued < excess) excess -= feesAccrued; // keep cash for the platform fee
            else excess = 0;
            if (excess > 0 && excess >= tbill.minSubscription()) {
                usdc.forceApprove(address(tbill), excess);
                tbill.subscribe(excess);
                emit Rebalanced("invest", excess);
                return;
            }
        }
        emit Rebalanced("hold", 0);
    }

    function processQueue(uint256 maxItems) external nonReentrant {
        _settleRedemptions();
        _processQueue(maxItems);
    }

    function _settleRedemptions() internal {
        uint256 i = 0;
        while (i < pendingRedemptionIds.length) {
            uint256 id = pendingRedemptionIds[i];
            if (tbill.isReady(id)) {
                tbill.claimRedeem(id);
                uint256 v = pendingRedemptionValue[id];
                pendingValue -= v;
                delete pendingRedemptionValue[id];
                pendingRedemptionIds[i] = pendingRedemptionIds[pendingRedemptionIds.length - 1];
                pendingRedemptionIds.pop();
                emit RedemptionSettled(id, v);
            } else {
                i++;
            }
        }
    }

    function _processQueue(uint256 maxItems) internal {
        uint256 n;
        while (queueHead < queue.length && n < maxItems) {
            QueuedWithdrawal memory q = queue[queueHead];
            if (usdc.balanceOf(address(this)) < q.amount) break;
            queueHead++;
            queuedTotal -= q.amount;
            usdc.safeTransfer(q.user, q.amount);
            emit QueuePaid(q.user, q.amount);
            n++;
        }
    }

    function _redeemInstant(uint256 usdcWanted) internal {
        uint256 tokens = _tokensFor(usdcWanted);
        if (tokens > 0) tbill.redeemInstant(tokens);
    }

    /// @dev Fund tokens needed for a USDC amount, rounded up and capped at what the vault holds.
    function _tokensFor(uint256 usdcAmount) internal view returns (uint256 tokens) {
        uint256 price = tbill.nav();
        tokens = (usdcAmount * 1e18 + price - 1) / price + 1;
        uint256 bal = tbill.balanceOf(address(this));
        if (tokens > bal) tokens = bal;
    }

    // ================================================================== odds

    function _accrue(address user) internal {
        Account storage a = accounts[user];
        if (a.period != currentDrawId) {
            a.acc = 0;
            a.lastUpdate = uint64(periodStart);
            a.period = uint64(currentDrawId);
        }
        a.acc += balanceOf(user) * (block.timestamp - a.lastUpdate);
        a.lastUpdate = uint64(block.timestamp);
    }

    /// @notice A saver's weight this period up to time t (balance x seconds held).
    function weightAt(address user, uint256 t) public view returns (uint256) {
        Account memory a = accounts[user];
        if (a.period != currentDrawId) return balanceOf(user) * (t - periodStart);
        return a.acc + balanceOf(user) * (t - a.lastUpdate);
    }

    /// @notice For the app: this saver's projected weight and everyone's, at the end of the period.
    function projectedOdds(address user) external view returns (uint256 userWeight, uint256 totalWeight) {
        uint256 end = periodStart + drawPeriod;
        if (end < block.timestamp) end = block.timestamp;
        for (uint256 i = 0; i < depositors.length; i++) {
            totalWeight += weightAt(depositors[i], end);
        }
        userWeight = weightAt(user, end);
    }

    // ================================================================== draws

    /// @notice Anyone can call once the period has ended. Harvests, snapshots everyone's odds,
    ///         locks the prize, asks for randomness and starts the next period.
    function closeDraw() external nonReentrant whenNotPaused returns (uint256 drawId) {
        require(address(randomSource) != address(0), "kairos: no random source");
        require(block.timestamp >= periodStart + drawPeriod, "kairos: draw period not over");
        harvest();

        drawId = currentDrawId;
        Draw storage d = draws[drawId];
        d.closeTime = uint64(block.timestamp);

        uint256 total;
        address[] storage users = drawUsers[drawId];
        uint256[] storage cum = drawCumWeights[drawId];
        for (uint256 i = 0; i < depositors.length; i++) {
            uint256 w = weightAt(depositors[i], block.timestamp);
            if (w == 0) continue;
            total += w;
            users.push(depositors[i]);
            cum.push(total);
        }
        d.totalWeight = total;

        currentDrawId = drawId + 1;
        periodStart = block.timestamp;

        if (total == 0 || prizeReserve == 0) {
            d.awarded = true; // nothing to award; prize stays in reserve for next time
            emit DrawClosed(drawId, 0, total, users.length);
            return drawId;
        }

        d.prize = prizeReserve;
        prizesPending += prizeReserve;
        prizeReserve = 0;
        emit DrawClosed(drawId, d.prize, total, users.length);
        randomSource.requestRandomness(drawId);
    }

    function fulfillRandomness(uint256 drawId, uint256 randomWord) external {
        require(msg.sender == address(randomSource), "kairos: only random source");
        Draw storage d = draws[drawId];
        require(!d.awarded && d.prize > 0, "kairos: nothing to award");
        d.awarded = true;
        d.randomWord = randomWord;

        uint256 n = prizeSplitsBps.length;
        uint256 remaining = d.prize;
        address[] storage winners = drawWinners[drawId];
        uint256[] storage amounts = drawAmounts[drawId];
        for (uint256 i = 0; i < n; i++) {
            uint256 amt = i == n - 1 ? remaining : (d.prize * prizeSplitsBps[i]) / BPS;
            remaining -= amt;
            uint256 ticket = uint256(keccak256(abi.encode(randomWord, i))) % d.totalWeight;
            address winner = _findWinner(drawId, ticket);
            winners.push(winner);
            amounts.push(amt);
            if (amt > 0) _mint(winner, amt); // prize lands in the winner's savings
        }
        prizesPending -= d.prize;
        emit DrawAwarded(drawId, winners, amounts);
    }

    function _findWinner(uint256 drawId, uint256 ticket) internal view returns (address) {
        uint256[] storage cum = drawCumWeights[drawId];
        uint256 lo = 0;
        uint256 hi = cum.length - 1;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (cum[mid] > ticket) hi = mid;
            else lo = mid + 1;
        }
        return drawUsers[drawId][lo];
    }

    // ================================================================== views for the app

    function getDraw(uint256 drawId)
        external
        view
        returns (Draw memory d, address[] memory winners, uint256[] memory amounts, uint256 entrants)
    {
        return (draws[drawId], drawWinners[drawId], drawAmounts[drawId], drawUsers[drawId].length);
    }

    function drawerState()
        external
        view
        returns (
            uint256 cash,
            uint256 fundValue,
            uint256 pending,
            uint256 queued,
            uint256 r,
            uint256 low,
            uint256 high,
            uint256 emergency
        )
    {
        cash = usdc.balanceOf(address(this));
        fundValue = tbill.valueOf(tbill.balanceOf(address(this)));
        pending = pendingValue;
        queued = queuedTotal;
        r = targetCash();
        low = (r * lowBps) / BPS;
        high = (r * highBps) / BPS;
        emergency = (r * emergencyBps) / BPS;
    }

    function nextDrawTime() external view returns (uint256) {
        return periodStart + drawPeriod;
    }

    function depositorCount() external view returns (uint256) {
        return depositors.length;
    }

    function queueLength() external view returns (uint256) {
        return queue.length - queueHead;
    }

    function prizeSplits() external view returns (uint16[] memory) {
        return prizeSplitsBps;
    }

    // ================================================================== owner (use a multisig before real money)

    function setRandomSource(IRandomSource src) external onlyOwner {
        randomSource = src;
    }

    function setDrawPeriod(uint256 seconds_) external onlyOwner {
        require(seconds_ >= 60 && seconds_ <= 90 days, "bad period");
        drawPeriod = seconds_;
    }

    function setPrizeSplits(uint16[] calldata splits) external onlyOwner {
        require(splits.length > 0 && splits.length <= 20, "bad splits");
        uint256 sum;
        for (uint256 i = 0; i < splits.length; i++) sum += splits[i];
        require(sum == BPS, "splits must add to 100%");
        prizeSplitsBps = splits;
    }

    function setFee(address recipient, uint256 bps) external onlyOwner {
        require(bps <= 2_500, "fee too high");
        feeRecipient = recipient;
        feeBps = bps;
    }

    function setCashBands(uint256 targetBps, uint256 minTarget, uint256 lo, uint256 hi, uint256 em, uint256 smallLimit)
        external
        onlyOwner
    {
        require(lo < BPS && hi > BPS && em < lo && targetBps <= 5_000, "bad bands");
        targetCashBps = targetBps;
        minTargetCash = minTarget;
        lowBps = lo;
        highBps = hi;
        emergencyBps = em;
        smallInstantLimit = smallLimit;
    }

    function setDepositRules(uint256 minDep, bool allowlistOn) external onlyOwner {
        minDeposit = minDep;
        requireAllowlist = allowlistOn;
    }

    function setAllowlisted(address who, bool ok) external onlyOwner {
        allowlisted[who] = ok;
    }

    /// @notice Emergency stop for deposits and draws. Withdrawals keep working.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}

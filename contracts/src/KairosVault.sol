// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
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

/// @title KairosVault (Plutos)
/// @notice Prize-linked savings. Savers deposit USDC and get Plutos Savings shares 1:1 (pUSD).
///         Shares never grow: every dollar of interest above total deposits is "harvested",
///         85% to the prize pool and 15% to the platform fee. Each period, winners are drawn
///         with odds weighted by balance x time held, boosted for dollars that have stayed in
///         a long time (the loyalty boost), and prizes are added to their savings.
///         Sponsors (the house) can add money that earns interest for the prizes but has no
///         entries, so it can never win. A USDC "cash drawer" pays withdrawals instantly; the
///         rest sits in T-bill fund tokens.
///
///         Golden rule: principal never enters the prize pool. Only the surplus above
///         (deposits + queued withdrawals + unpaid prizes + unpaid fees) is ever harvested.
///
///         Draws scale: entries live in a sum tree (see "entries" below), so a deposit, a
///         withdrawal, closing a draw and picking each winner all cost O(log n) for n savers.
///         Nothing ever loops over every saver.
contract KairosVault is ERC20, Ownable, Pausable, ReentrancyGuard, IRandomConsumer {
    using SafeERC20 for IERC20;

    uint256 public constant BPS = 10_000;
    /// @notice $1 that never counts as interest. Buying and selling fund tokens rounds by a few
    ///         millionths of a cent each time; this keeps that rounding from ever making the vault
    ///         owe more than it holds. It's put in once at setup (KairosBetaSetup), not by savers.
    uint256 public constant ROUNDING_RESERVE = 1e6;
    /// @notice Entries are stored in halves (so the 1.5x tier is a whole number): a saver's entries
    ///         in a round are weight / (ENTRY_SCALE x round length) dollars.
    uint256 public constant ENTRY_SCALE = 2;
    /// @dev Deposits are remembered by round for this many rounds (12 for the top tier + 1 for the closed draw).
    uint256 internal constant RING = 13;

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

    // Sponsorship: money that earns interest for the prize pool, with no entries (it can't win).
    mapping(address => uint256) public sponsored;
    uint256 public totalSponsored;

    // ------------------------------------------------------------------ entries (time-weighted balances)
    // A saver's entries in a round are their balance x seconds held during it. Over a round that
    // started at S and lasts L seconds:
    //
    //     entries = L x (balance now) - sum, over the round's changes, of (change x (time of change - S))
    //
    // Every saver owns one leaf of a binary sum tree, in order of their first deposit. Each node
    // holds the sum of its leaves for two quantities: `bal` (balances) and `pen` (the second term,
    // the round's "penalty"). So any subtree's entries are L x bal - pen, the root gives everyone's,
    // and picking a winner is one walk from the root to a leaf. A deposit or withdrawal updates one
    // path. All of it is O(log n): the cost grows by one step each time the number of savers doubles.
    //
    // There are two penalty trees, one per round parity. While the next round runs in one, the
    // round just closed keeps its own: any change after it closed is recorded there as if it had
    // happened at the close (change x L), which cancels out in L x bal - pen. That keeps the closed
    // round's entries exactly frozen until its winners are paid and the next draw closes. A tree is
    // emptied lazily: a node stamped with an older round reads as zero.
    //
    // The loyalty boost. Each dollar's entries grow with how many rounds it has stayed in:
    //     joined this round or the last 2: 1x   3-5 rounds ago: 1.5x   6-11: 2x   12 or more: 3x
    // (rounds are months at launch; on the test network they're the draw period). A withdrawal takes
    // the newest dollars first, so the boost is the same as "lowest balance over the last 3, 6 and
    // 12 rounds": E = A + 0.5 M3 + 0.5 M6 + M12. Taking money out during a round loses that money's
    // boost for the whole round; adding money never changes anyone's boost until it has aged.
    // Each node also keeps `dep`: the dollars still in below it, by the round they arrived, for the
    // last 13 rounds (older ones are simply "old": balance minus the ring). A dollar's age is read
    // from the ring, so boosts step up on their own as rounds pass, with no transaction needed.
    // All weights are in halves (ENTRY_SCALE), and pen is too.
    struct Pen {
        int192 value;
        uint64 round;
    }

    struct Dep {
        uint192 amount;
        uint64 round;
    }

    uint256 public treeDepth; // levels above the leaves; the root is node (treeDepth, 0)
    uint256 public saverCount; // leaves in use
    uint256 public activeSavers; // savers with a balance right now
    mapping(address => uint256) internal leafPlusOne; // 0 = no leaf yet
    mapping(uint256 => address) public saverAt; // leaf index -> saver
    mapping(uint256 => uint256) internal bal; // node -> sum of balances below it
    mapping(uint256 => Pen)[2] internal pen; // [round % 2] node -> that round's penalty sum (in halves)
    mapping(uint256 => Dep[13]) internal dep; // node -> [round % 13] dollars below it that arrived that round

    uint256 public currentDrawId = 1;
    uint256 public periodStart;

    struct Draw {
        uint64 closeTime;
        bool awarded;
        uint256 prize;
        uint256 totalWeight;
        uint256 randomWord;
        uint64 start; // when the round began
        bool randomReady; // the random number has arrived; winners can be paid
        uint32 entrants; // savers with a balance when it closed
        uint32 lineSize; // savers on the line (leaves) when it closed
    }

    mapping(uint256 => Draw) public draws;
    mapping(uint256 => address[]) internal drawWinners;
    mapping(uint256 => uint256[]) internal drawAmounts;

    // Running totals, so anyone can check the golden rule from the outside.
    uint256 public totalHarvestedToPrizes; // every dollar of interest that went to the prize pool
    uint256 public totalPrizesPaid; // every dollar of prizes paid into savers' balances

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
    event RandomnessReceived(uint256 indexed drawId, uint256 randomWord);
    event SaverJoined(address indexed saver, uint256 leaf);
    event FeesPaid(address indexed to, uint256 amount);
    event RandomSourceSet(address indexed source);
    event DrawPeriodSet(uint256 seconds_);
    event PrizeSplitsSet(uint16[] splits);
    event FeeSet(address indexed recipient, uint256 bps);
    event CashBandsSet(uint256 targetBps, uint256 minTarget, uint256 lowBps, uint256 highBps, uint256 emergencyBps, uint256 smallLimit);
    event DepositRulesSet(uint256 minDeposit, bool allowlistOn);
    event AllowlistSet(address indexed who, bool allowed);
    event Sponsored(address indexed sponsor, uint256 amount);
    event SponsorshipWithdrawn(address indexed sponsor, uint256 amount);

    constructor(IERC20 usdc_, ITBillFund tbill_, address feeRecipient_)
        ERC20("Plutos Savings", "pUSD")
        Ownable(msg.sender)
    {
        require(feeRecipient_ != address(0), "kairos: no fee recipient");
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
        _mint(msg.sender, amount);
        emit Deposited(msg.sender, amount);
    }

    /// @notice Always available, even when paused. Paid from the cash drawer when possible,
    ///         otherwise through the fund's instant route, otherwise queued for the next settlement.
    function withdraw(uint256 amount) external nonReentrant {
        require(amount > 0, "kairos: zero");
        _burn(msg.sender, amount); // reverts if balance too low
        _payOut(msg.sender, amount);
    }

    /// @notice Adds money that earns interest for the prize pool. It has no entries, so it can never
    ///         win, and it never shows up as anyone's savings. The sponsor can take it back any time.
    function sponsor(uint256 amount) external nonReentrant whenNotPaused {
        require(amount > 0, "kairos: zero");
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        sponsored[msg.sender] += amount;
        totalSponsored += amount;
        emit Sponsored(msg.sender, amount);
    }

    function withdrawSponsorship(uint256 amount) external nonReentrant {
        require(amount > 0 && sponsored[msg.sender] >= amount, "kairos: not that much sponsored");
        sponsored[msg.sender] -= amount;
        totalSponsored -= amount;
        emit SponsorshipWithdrawn(msg.sender, amount);
        _payOut(msg.sender, amount);
    }

    /// @dev Paid from the cash drawer when possible, otherwise through the fund's instant route,
    ///      otherwise queued for the next settlement.
    function _payOut(address to, uint256 amount) internal {
        uint256 cash = usdc.balanceOf(address(this));
        uint256 e = (targetCash() * emergencyBps) / BPS;
        // Never hold back more for the emergency floor than everyone else actually has in.
        uint256 others = totalSupply() + totalSponsored;
        if (e > others) e = others;
        bool queueEmpty = queueHead == queue.length;

        if (queueEmpty && cash >= amount && (cash - amount >= e || amount <= smallInstantLimit)) {
            usdc.safeTransfer(to, amount);
            emit Withdrawn(to, amount, "drawer");
            return;
        }

        if (queueEmpty && tbill.instantRedeemEnabled() && tbill.balanceOf(address(this)) > 0) {
            uint256 shortBy = amount > cash ? amount - cash : amount;
            _redeemInstant(shortBy);
            if (usdc.balanceOf(address(this)) >= amount) {
                usdc.safeTransfer(to, amount);
                emit Withdrawn(to, amount, "fund-instant");
                return;
            }
        }

        queue.push(QueuedWithdrawal(to, amount));
        queuedTotal += amount;
        emit WithdrawalQueued(to, amount, queue.length - queueHead);
    }

    /// @notice Shares are a non-transferable savings receipt. Every mint and burn updates the entries tree.
    function _update(address from, address to, uint256 value) internal override {
        require(from == address(0) || to == address(0), "kairos: shares are non-transferable");
        super._update(from, to, value);
        if (value == 0) return;
        int256 v = SafeCast.toInt256(value);
        if (from != address(0)) {
            _track(from, -v);
            if (balanceOf(from) == 0) activeSavers--;
        }
        if (to != address(0)) {
            if (balanceOf(to) == value) activeSavers++;
            _track(to, v);
        }
    }

    // ================================================================== interest

    function totalAssets() public view returns (uint256) {
        return usdc.balanceOf(address(this)) + tbill.valueOf(tbill.balanceOf(address(this))) + pendingValue;
    }

    /// @notice Everything the vault owes to someone. Assets above this line are new interest.
    function totalLiabilities() public view returns (uint256) {
        return totalSupply() + totalSponsored + queuedTotal + prizeReserve + prizesPending + feesAccrued;
    }

    function availableInterest() public view returns (uint256) {
        uint256 a = totalAssets();
        uint256 l = totalLiabilities() + ROUNDING_RESERVE;
        return a > l ? a - l : 0;
    }

    /// @notice Anyone can call. Splits new interest 85% prizes / 15% fees. Never touches principal.
    function harvest() public returns (uint256 interest) {
        interest = availableInterest();
        if (interest == 0) return 0;
        uint256 fee = (interest * feeBps) / BPS;
        feesAccrued += fee;
        prizeReserve += interest - fee;
        totalHarvestedToPrizes += interest - fee;
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
        r = ((totalSupply() + totalSponsored) * targetCashBps) / BPS;
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
        uint256 held = tbill.balanceOf(address(this));
        if (tokens > held) tokens = held;
    }

    // ================================================================== entries tree

    function _node(uint256 level, uint256 index) internal pure returns (uint256) {
        return (level << 128) | index;
    }

    function _root() internal view returns (uint256) {
        return _node(treeDepth, 0);
    }

    function _penOf(uint256 round, uint256 node) internal view returns (int256) {
        Pen storage p = pen[round & 1][node];
        return p.round == round ? int256(p.value) : int256(0);
    }

    function _addPen(uint256 round, uint256 node, int256 x) internal {
        Pen storage p = pen[round & 1][node];
        int256 v = (p.round == round ? int256(p.value) : int256(0)) + x;
        p.value = SafeCast.toInt192(v);
        p.round = uint64(round);
    }

    function _depOf(uint256 node, uint256 round) internal view returns (uint256) {
        Dep storage d = dep[node][round % RING];
        return d.round == round ? uint256(d.amount) : 0;
    }

    function _addDep(uint256 node, uint256 round, int256 x) internal {
        Dep storage d = dep[node][round % RING];
        int256 v = (d.round == round ? int256(uint256(d.amount)) : int256(0)) + x;
        d.amount = SafeCast.toUint192(SafeCast.toUint256(v));
        d.round = uint64(round);
    }

    /// @dev The boost on top of 1x, in halves, for a dollar that arrived `age` rounds ago.
    function _boostHalves(uint256 age) internal pure returns (uint256) {
        if (age < 3) return 0; // 1x
        if (age < 6) return 1; // 1.5x
        if (age < 12) return 2; // 2x
        return 4; // 3x
    }

    /// @dev The boost under `node` in `round`, in halves of a dollar: 0.5 for every dollar 3+ rounds
    ///      old, another 0.5 at 6+, another 1 at 12+. Dollars that arrived after the round don't count.
    function _bonusHalves(uint256 round, uint256 node) internal view returns (uint256) {
        uint256 t = bal[node];
        for (uint256 s = round + 1; s <= currentDrawId; s++) t -= _depOf(node, s);
        uint256 r3;
        uint256 r6;
        uint256 r12;
        for (uint256 k = 0; k < 12 && k < round; k++) {
            uint256 a = _depOf(node, round - k);
            if (a == 0) continue;
            if (k < 3) r3 += a;
            if (k < 6) r6 += a;
            r12 += a;
        }
        return 4 * t - r3 - r6 - 2 * r12;
    }

    /// @dev Entries under `node` for a round of `length` seconds, in halves:
    ///      2 x length x balances - penalty + length x boost.
    function _weight(uint256 round, uint256 length, uint256 node) internal view returns (uint256) {
        int256 w = SafeCast.toInt256(ENTRY_SCALE * length * bal[node] + length * _bonusHalves(round, node)) - _penOf(round, node);
        require(w >= 0, "kairos: negative entries");
        return uint256(w);
    }

    /// @dev The newest closed draw keeps its entries frozen until it has paid out and the next one closes.
    function _frozenDraw() internal view returns (uint256 id, int256 length) {
        id = currentDrawId - 1;
        if (id == 0) return (0, 0);
        Draw storage d = draws[id];
        if (d.prize == 0) return (0, 0); // nothing to pick or replay
        length = int256(uint256(d.closeTime - d.start));
    }

    function _track(address user, int256 delta) internal {
        uint256 leaf = leafPlusOne[user];
        if (leaf == 0) {
            leaf = ++saverCount;
            leafPlusOne[user] = leaf;
            saverAt[leaf - 1] = user;
            if (leaf - 1 == (uint256(1) << treeDepth)) _grow();
            emit SaverJoined(user, leaf - 1);
        }
        uint256 index = leaf - 1;
        uint256 round = currentDrawId;
        int256 nowPen = int256(ENTRY_SCALE) * delta * int256(block.timestamp - periodStart);
        (uint256 frozen, int256 frozenLength) = _frozenDraw();
        int256 frozenPen = int256(ENTRY_SCALE) * delta * frozenLength;
        for (uint256 level = 0; level <= treeDepth; level++) {
            uint256 node = _node(level, index >> level);
            bal[node] = uint256(int256(bal[node]) + delta);
            _addPen(round, node, nowPen);
            if (frozen != 0) _addPen(frozen, node, frozenPen);
        }

        if (delta > 0) {
            // New dollars arrive this round (1x for now).
            for (uint256 level = 0; level <= treeDepth; level++) _addDep(_node(level, index >> level), round, delta);
            return;
        }
        _takeNewest(index, round, uint256(-delta), frozen, frozenLength);
    }

    /// @dev A withdrawal takes the newest dollars first. The closed draw keeps its entries: whatever
    ///      boost the taken dollars had in it is put back through its penalty.
    function _takeNewest(uint256 index, uint256 round, uint256 left, uint256 frozen, int256 frozenLength) internal {
        uint256 leafNode = _node(0, index);
        for (uint256 k = 0; k < RING && k < round && left > 0; k++) {
            uint256 s = round - k;
            uint256 have = _depOf(leafNode, s);
            if (have == 0) continue;
            uint256 take = have < left ? have : left;
            left -= take;
            int256 fix = frozen != 0 && s <= frozen ? -frozenLength * int256(_boostHalves(frozen - s) * take) : int256(0);
            _takeLot(index, s, take, frozen, fix);
        }
        // The rest is older than the ring: 3x in the closed draw too.
        if (left > 0 && frozen != 0) {
            int256 fix = -frozenLength * int256(4 * left);
            for (uint256 level = 0; level <= treeDepth; level++) _addPen(frozen, _node(level, index >> level), fix);
        }
    }

    function _takeLot(uint256 index, uint256 round, uint256 take, uint256 frozen, int256 fix) internal {
        for (uint256 level = 0; level <= treeDepth; level++) {
            uint256 node = _node(level, index >> level);
            _addDep(node, round, -int256(take));
            if (fix != 0) _addPen(frozen, node, fix);
        }
    }

    /// @dev One more level on top: the old root becomes the new root's left half.
    function _grow() internal {
        uint256 oldRoot = _root();
        uint256 newRoot = _node(treeDepth + 1, 0);
        bal[newRoot] = bal[oldRoot];
        pen[0][newRoot] = pen[0][oldRoot];
        pen[1][newRoot] = pen[1][oldRoot];
        for (uint256 i = 0; i < RING; i++) dep[newRoot][i] = dep[oldRoot][i];
        treeDepth++;
    }

    /// @dev Walks from the root to the leaf whose stretch of the line holds `ticket`.
    ///      Same answer as lining everyone up in leaf order and finding the first running total above it.
    function _pick(uint256 drawId, uint256 length, uint256 ticket) internal view returns (address) {
        uint256 index = 0;
        for (uint256 level = treeDepth; level > 0; level--) {
            uint256 leftWeight = _weight(drawId, length, _node(level - 1, index << 1));
            if (ticket < leftWeight) {
                index = index << 1;
            } else {
                ticket -= leftWeight;
                index = (index << 1) | 1;
            }
        }
        return saverAt[index];
    }

    // ================================================================== odds

    /// @notice A saver's entries this round if the round ended at time t (balance x seconds held, with
    ///         the loyalty boost, in halves: divide by ENTRY_SCALE x round length for dollars).
    function weightAt(address user, uint256 t) public view returns (uint256) {
        uint256 leaf = leafPlusOne[user];
        if (leaf == 0) return 0;
        if (t < block.timestamp) t = block.timestamp;
        return _weight(currentDrawId, t - periodStart, _node(0, leaf - 1));
    }

    /// @notice For the app: this saver's projected entries and everyone's, at the end of the period. O(1).
    function projectedOdds(address user) external view returns (uint256 userWeight, uint256 totalWeight) {
        uint256 end = periodStart + drawPeriod;
        if (end < block.timestamp) end = block.timestamp;
        totalWeight = _weight(currentDrawId, end - periodStart, _root());
        userWeight = weightAt(user, end);
    }

    // ================================================================== draws

    /// @notice Anyone can call once the period has ended. Harvests, reads everyone's entries from the
    ///         root of the tree (no loop), locks the prize, asks for randomness and starts the next period.
    function closeDraw() external nonReentrant whenNotPaused returns (uint256 drawId) {
        require(address(randomSource) != address(0), "kairos: no random source");
        require(block.timestamp >= periodStart + drawPeriod, "kairos: draw period not over");
        drawId = currentDrawId;
        require(drawId == 1 || draws[drawId - 1].awarded, "kairos: last draw still picking winners");
        harvest();

        Draw storage d = draws[drawId];
        d.start = uint64(periodStart);
        d.closeTime = uint64(block.timestamp);
        d.entrants = uint32(activeSavers);
        d.lineSize = uint32(saverCount);
        uint256 total = _weight(drawId, block.timestamp - periodStart, _root());
        d.totalWeight = total;

        currentDrawId = drawId + 1;
        periodStart = block.timestamp;

        if (total == 0 || prizeReserve == 0) {
            d.awarded = true; // nothing to award; prize stays in reserve for next time
            emit DrawClosed(drawId, 0, total, d.entrants);
            return drawId;
        }

        d.prize = prizeReserve;
        prizesPending += prizeReserve;
        prizeReserve = 0;
        emit DrawClosed(drawId, d.prize, total, d.entrants);
        randomSource.requestRandomness(drawId);
    }

    /// @notice The random source delivers the number. Winners are paid in the same transaction when
    ///         it fits in the callback's gas; otherwise anyone can call awardDraw.
    function fulfillRandomness(uint256 drawId, uint256 randomWord) external {
        require(msg.sender == address(randomSource), "kairos: only random source");
        Draw storage d = draws[drawId];
        require(d.prize > 0 && !d.awarded && !d.randomReady, "kairos: nothing to award");
        d.randomWord = randomWord;
        d.randomReady = true;
        emit RandomnessReceived(drawId, randomWord);
        try this.awardDraw(drawId) {} catch {}
    }

    /// @notice Anyone can call once the random number has arrived: picks one spot on the line per prize
    ///         (one walk down the tree each) and pays the prizes into the winners' savings.
    function awardDraw(uint256 drawId) external nonReentrant {
        Draw storage d = draws[drawId];
        require(d.randomReady && !d.awarded, "kairos: not ready to award");
        d.awarded = true;

        uint256 n = prizeSplitsBps.length;
        uint256 length = d.closeTime - d.start;
        uint256 remaining = d.prize;
        address[] memory winners = new address[](n);
        uint256[] memory amounts = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            uint256 amt = i == n - 1 ? remaining : (d.prize * prizeSplitsBps[i]) / BPS;
            remaining -= amt;
            uint256 ticket = uint256(keccak256(abi.encode(d.randomWord, i))) % d.totalWeight;
            winners[i] = _pick(drawId, length, ticket);
            amounts[i] = amt;
        }
        drawWinners[drawId] = winners;
        drawAmounts[drawId] = amounts;
        prizesPending -= d.prize;
        totalPrizesPaid += d.prize;
        // Pay after picking. (Paying changes balances, but the closed draw's entries are frozen either way.)
        for (uint256 i = 0; i < n; i++) {
            if (amounts[i] > 0) _mint(winners[i], amounts[i]);
        }
        emit DrawAwarded(drawId, winners, amounts);
    }

    /// @notice If the random number never arrives (for example the subscription ran out), ask again.
    function retryRandomness(uint256 drawId) external onlyOwner {
        Draw storage d = draws[drawId];
        require(d.prize > 0 && !d.randomReady, "kairos: nothing waiting");
        randomSource.requestRandomness(drawId);
    }

    // ================================================================== views for the app

    function getDraw(uint256 drawId)
        external
        view
        returns (Draw memory d, address[] memory winners, uint256[] memory amounts, uint256 entrants)
    {
        return (draws[drawId], drawWinners[drawId], drawAmounts[drawId], draws[drawId].entrants);
    }

    /// @notice The newest closed draw's line, a page at a time: savers in leaf order and their entries,
    ///         exactly as the draw used them. Older draws' lines aren't kept (they can be rebuilt from events).
    function drawLine(uint256 drawId, uint256 start, uint256 count)
        external
        view
        returns (address[] memory savers, uint256[] memory weights)
    {
        (uint256 frozen,) = _frozenDraw();
        require(frozen != 0 && drawId == frozen, "kairos: only the latest draw's line is kept");
        Draw storage d = draws[drawId];
        return _line(drawId, d.closeTime - d.start, start, count, d.lineSize);
    }

    /// @notice This round's line so far, if it ended at time t (for pretend draws and the odds preview).
    function currentLine(uint256 t, uint256 start, uint256 count)
        external
        view
        returns (address[] memory savers, uint256[] memory weights)
    {
        if (t < block.timestamp) t = block.timestamp;
        return _line(currentDrawId, t - periodStart, start, count, saverCount);
    }

    function _line(uint256 round, uint256 length, uint256 start, uint256 count, uint256 size)
        internal
        view
        returns (address[] memory savers, uint256[] memory weights)
    {
        uint256 end = start + count > size ? size : start + count;
        uint256 n = end > start ? end - start : 0;
        savers = new address[](n);
        weights = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            savers[i] = saverAt[start + i];
            weights[i] = _weight(round, length, _node(0, start + i));
        }
    }

    /// @notice A saver's dollars by loyalty tier this round (0: 1x, 1: 1.5x, 2: 2x, 3: 3x), and the soonest
    ///         step up: in `nextIn` rounds, `nextAmount` dollars reach tier `nextTier` (all 0 if none will).
    function boostOf(address user)
        external
        view
        returns (uint256[4] memory tiers, uint256 nextIn, uint256 nextAmount, uint256 nextTier)
    {
        uint256 leaf = leafPlusOne[user];
        if (leaf == 0) return (tiers, 0, 0, 0);
        uint256 node = _node(0, leaf - 1);
        uint256 round = currentDrawId;
        uint256 ringTotal;
        for (uint256 k = 0; k < 12 && k < round; k++) {
            uint256 a = _depOf(node, round - k);
            if (a == 0) continue;
            ringTotal += a;
            uint256 tier = k < 3 ? 0 : k < 6 ? 1 : 2;
            tiers[tier] += a;
            uint256 step = k < 3 ? 3 - k : k < 6 ? 6 - k : 12 - k;
            if (nextIn == 0 || step < nextIn) {
                (nextIn, nextAmount, nextTier) = (step, a, tier + 1);
            } else if (step == nextIn && tier + 1 == nextTier) {
                nextAmount += a;
            }
        }
        tiers[3] = bal[node] - ringTotal;
    }

    /// @notice What the tree's root holds, for checking it against the token's own totals.
    function treeTotals() external view returns (uint256 balances, uint256 depth, uint256 leaves) {
        return (bal[_root()], treeDepth, saverCount);
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
        return saverCount;
    }

    /// @notice Savers in order of their first deposit (same as the tree's leaves).
    function depositors(uint256 i) external view returns (address) {
        return saverAt[i];
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
        emit RandomSourceSet(address(src));
    }

    function setDrawPeriod(uint256 seconds_) external onlyOwner {
        require(seconds_ >= 60 && seconds_ <= 90 days, "bad period");
        drawPeriod = seconds_;
        emit DrawPeriodSet(seconds_);
    }

    function setPrizeSplits(uint16[] calldata splits) external onlyOwner {
        require(splits.length > 0 && splits.length <= 20, "bad splits");
        uint256 sum = 0;
        for (uint256 i = 0; i < splits.length; i++) sum += splits[i];
        require(sum == BPS, "splits must add to 100%");
        prizeSplitsBps = splits;
        emit PrizeSplitsSet(splits);
    }

    function setFee(address recipient, uint256 bps) external onlyOwner {
        require(bps <= 2_500, "fee too high");
        require(recipient != address(0), "kairos: no fee recipient");
        feeRecipient = recipient;
        feeBps = bps;
        emit FeeSet(recipient, bps);
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
        emit CashBandsSet(targetBps, minTarget, lo, hi, em, smallLimit);
    }

    function setDepositRules(uint256 minDep, bool allowlistOn) external onlyOwner {
        minDeposit = minDep;
        requireAllowlist = allowlistOn;
        emit DepositRulesSet(minDep, allowlistOn);
    }

    function setAllowlisted(address who, bool ok) external onlyOwner {
        allowlisted[who] = ok;
        emit AllowlistSet(who, ok);
    }

    /// @notice Emergency stop for deposits and draws. Withdrawals keep working.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}

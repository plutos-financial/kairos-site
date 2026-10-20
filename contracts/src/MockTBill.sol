// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MockUSDC} from "./MockUSDC.sol";

/// @title MockTBill
/// @notice TEST ONLY. Pretends to be a tokenized U.S. Treasury bill fund (like Franklin Templeton's
///         BENJI or BlackRock's BUIDL). It copies the parts that matter for Kairos:
///         - the token price (NAV) slowly rises, which is how the fund pays interest
///         - only allowlisted wallets can buy or sell (real funds require KYC)
///         - minimum subscription and minimum redemption sizes
///         - redemptions settle later (T+1 by default), with an optional instant route
///         For demos the owner can speed up interest or fast-forward time.
contract MockTBill is ERC20, Ownable {
    using SafeERC20 for IERC20;

    uint256 public constant YEAR = 365 days;
    uint256 public constant WAD = 1e18;

    MockUSDC public immutable usdc;

    // --- price (NAV) in USDC per token, scaled by 1e18 (1e18 = $1.00) ---
    uint256 public navCheckpoint = WAD;
    uint256 public checkpointTime;
    uint256 public apyBps = 400; // 4.00% a year
    uint256 public speed = 1; // 1 = real time. 525_600 = one year of interest per minute.

    // --- issuer rules ---
    mapping(address => bool) public allowlisted;
    uint256 public minSubscription; // in USDC (6 decimals)
    uint256 public minRedemption; // in USDC value (6 decimals)
    uint256 public settlementDelay = 1 days; // T+1
    bool public instantRedeemEnabled; // like BUIDL's instant USDC facility

    struct Redemption {
        address owner;
        uint256 usdcAmount;
        uint256 readyAt;
        bool claimed;
    }

    Redemption[] public redemptions;

    event Subscribed(address indexed who, uint256 usdcIn, uint256 tokensOut, uint256 nav);
    event RedemptionRequested(uint256 indexed id, address indexed who, uint256 tokensIn, uint256 usdcOwed, uint256 readyAt);
    event RedemptionClaimed(uint256 indexed id, address indexed who, uint256 usdcOut);
    event InstantRedeemed(address indexed who, uint256 tokensIn, uint256 usdcOut);
    event FastForwarded(uint256 seconds_, uint256 newNav);

    constructor(MockUSDC usdc_) ERC20("Kairos Test Treasury Bill Fund", "tTBILL") Ownable(msg.sender) {
        usdc = usdc_;
        checkpointTime = block.timestamp;
        allowlisted[msg.sender] = true;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    // ------------------------------------------------------------------ price

    /// @notice Current price of one token in USDC, 1e18 = $1.00. Rises every second.
    function nav() public view returns (uint256) {
        uint256 elapsed = block.timestamp - checkpointTime;
        return navCheckpoint + (navCheckpoint * apyBps * elapsed * speed) / (10_000 * YEAR);
    }

    function _checkpoint() internal {
        navCheckpoint = nav();
        checkpointTime = block.timestamp;
    }

    /// @notice USDC value (6 decimals) of a token amount (6 decimals).
    function valueOf(uint256 tokens) public view returns (uint256) {
        return (tokens * nav()) / WAD;
    }

    // ------------------------------------------------------------------ issuer actions

    function subscribe(uint256 usdcAmount) external returns (uint256 tokens) {
        require(allowlisted[msg.sender], "fund: not allowlisted");
        require(usdcAmount >= minSubscription && usdcAmount > 0, "fund: below minimum subscription");
        uint256 price = nav();
        tokens = (usdcAmount * WAD) / price;
        IERC20(address(usdc)).safeTransferFrom(msg.sender, address(this), usdcAmount);
        _mint(msg.sender, tokens);
        emit Subscribed(msg.sender, usdcAmount, tokens, price);
    }

    /// @notice Sell tokens back to the fund. USDC arrives after settlementDelay (T+1).
    function requestRedeem(uint256 tokens) external returns (uint256 id, uint256 usdcOwed) {
        require(allowlisted[msg.sender], "fund: not allowlisted");
        usdcOwed = valueOf(tokens);
        require(usdcOwed >= minRedemption && usdcOwed > 0, "fund: below minimum redemption");
        _burn(msg.sender, tokens);
        id = redemptions.length;
        redemptions.push(Redemption(msg.sender, usdcOwed, block.timestamp + settlementDelay, false));
        emit RedemptionRequested(id, msg.sender, tokens, usdcOwed, block.timestamp + settlementDelay);
    }

    function claimRedeem(uint256 id) external returns (uint256) {
        Redemption storage r = redemptions[id];
        require(!r.claimed, "fund: already claimed");
        require(block.timestamp >= r.readyAt, "fund: not settled yet");
        r.claimed = true;
        _payout(r.owner, r.usdcAmount);
        emit RedemptionClaimed(id, r.owner, r.usdcAmount);
        return r.usdcAmount;
    }

    function isReady(uint256 id) external view returns (bool) {
        Redemption storage r = redemptions[id];
        return !r.claimed && block.timestamp >= r.readyAt;
    }

    /// @notice Instant route (only when enabled), like a USDC liquidity facility.
    function redeemInstant(uint256 tokens) external returns (uint256 usdcOut) {
        require(instantRedeemEnabled, "fund: instant route off");
        require(allowlisted[msg.sender], "fund: not allowlisted");
        usdcOut = valueOf(tokens);
        require(usdcOut > 0, "fund: zero");
        _burn(msg.sender, tokens);
        _payout(msg.sender, usdcOut);
        emit InstantRedeemed(msg.sender, tokens, usdcOut);
    }

    /// @dev The mock fund mints any USDC it is short, standing in for interest earned on real T-bills.
    function _payout(address to, uint256 amount) internal {
        uint256 bal = usdc.balanceOf(address(this));
        if (bal < amount) usdc.mint(address(this), amount - bal);
        IERC20(address(usdc)).safeTransfer(to, amount);
    }

    function redemptionCount() external view returns (uint256) {
        return redemptions.length;
    }

    // ------------------------------------------------------------------ token transfers stay inside the allowlist

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            require(allowlisted[from] && allowlisted[to], "fund: transfer outside allowlist");
        }
        super._update(from, to, value);
    }

    // ------------------------------------------------------------------ owner / demo controls

    function setAllowlisted(address who, bool ok) external onlyOwner {
        allowlisted[who] = ok;
    }

    function setApyBps(uint256 bps) external onlyOwner {
        require(bps <= 2_000, "apy too high");
        _checkpoint();
        apyBps = bps;
    }

    function setSpeed(uint256 newSpeed) external onlyOwner {
        require(newSpeed >= 1 && newSpeed <= 10_000_000, "bad speed");
        _checkpoint();
        speed = newSpeed;
    }

    /// @notice Demo button: add `seconds_` worth of interest right now.
    function fastForward(uint256 seconds_) external onlyOwner {
        _checkpoint();
        navCheckpoint += (navCheckpoint * apyBps * seconds_) / (10_000 * YEAR);
        emit FastForwarded(seconds_, navCheckpoint);
    }

    function setRules(uint256 minSub, uint256 minRed, uint256 delay, bool instant) external onlyOwner {
        require(delay <= 7 days, "delay too long");
        minSubscription = minSub;
        minRedemption = minRed;
        settlementDelay = delay;
        instantRedeemEnabled = instant;
    }
}

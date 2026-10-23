// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IVRFCoordinatorV2Plus} from "@chainlink/src/v0.8/vrf/dev/interfaces/IVRFCoordinatorV2Plus.sol";
import {MockUSDC} from "./MockUSDC.sol";
import {MockTBill} from "./MockTBill.sol";
import {KairosVault, ITBillFund} from "./KairosVault.sol";
import {ChainlinkVRFSource} from "./ChainlinkVRFSource.sol";

/// @title KairosBetaSetup
/// @notice Sets up the whole Plutos beta in ONE transaction: test USDC, the T-bill fund, the vault,
///         a Chainlink VRF v2.5 subscription (funded with the ETH sent along), and the VRF source
///         that the vault uses for its draws. Everything is then handed to `finalOwner`.
///         The VRF source and the subscription use Chainlink's two-step ownership, so `finalOwner`
///         accepts them later (only needed to change VRF settings or withdraw the subscription).
contract KairosBetaSetup {
    MockUSDC public immutable usdc;
    MockTBill public immutable tbill;
    KairosVault public immutable vault;
    ChainlinkVRFSource public immutable vrf;
    address public immutable coordinator;
    uint256 public immutable subscriptionId;
    address public immutable finalOwner;

    event Ready(address usdc, address tbill, address vault, address vrf, uint256 subscriptionId);

    constructor(address coordinator_, bytes32 keyHash, address finalOwner_, uint256 drawPeriod, uint256 speed) payable {
        coordinator = coordinator_;
        finalOwner = finalOwner_;

        usdc = new MockUSDC();
        tbill = new MockTBill(usdc);
        usdc.setMinter(address(tbill), true);
        vault = new KairosVault(IERC20(address(usdc)), ITBillFund(address(tbill)), finalOwner_);
        tbill.setAllowlisted(address(vault), true);
        usdc.mint(address(vault), vault.ROUNDING_RESERVE()); // the $1 rounding reserve (test dollars)

        IVRFCoordinatorV2Plus c = IVRFCoordinatorV2Plus(coordinator_);
        subscriptionId = c.createSubscription();
        if (msg.value > 0) c.fundSubscriptionWithNative{value: msg.value}(subscriptionId);
        vrf = new ChainlinkVRFSource(coordinator_, address(vault), subscriptionId, keyHash);
        // Room for up to 20 prizes in one callback; 3 confirmations; pay in native ETH.
        vrf.setConfig(subscriptionId, keyHash, 2_400_000, 3, true);
        c.addConsumer(subscriptionId, address(vrf));
        vault.setRandomSource(vrf);

        // Beta settings: change any time from the Draws page.
        vault.setDrawPeriod(drawPeriod);
        vault.setDepositRules(1e6, false); // $1 minimum, open to everyone
        tbill.setSpeed(speed);
        tbill.setRules(0, 0, 2 minutes, true);

        usdc.transferOwnership(finalOwner_);
        tbill.transferOwnership(finalOwner_);
        vault.transferOwnership(finalOwner_);
        vrf.transferOwnership(finalOwner_); // pending until accepted
        c.requestSubscriptionOwnerTransfer(subscriptionId, finalOwner_); // pending until accepted

        emit Ready(address(usdc), address(tbill), address(vault), address(vrf), subscriptionId);
    }
}

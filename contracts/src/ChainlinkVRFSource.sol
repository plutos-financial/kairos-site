// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VRFConsumerBaseV2Plus} from "@chainlink/src/v0.8/vrf/dev/VRFConsumerBaseV2Plus.sol";
import {VRFV2PlusClient} from "@chainlink/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";
import {IRandomSource, IRandomConsumer} from "./IRandomSource.sol";

/// @title ChainlinkVRFSource
/// @notice Provably fair randomness from Chainlink VRF v2.5 (subscription model).
///         Setup: create a VRF subscription at vrf.chain.link (Base Sepolia), fund it with
///         test LINK or ETH, deploy this contract, add it as a consumer, then call
///         vault.setRandomSource(address(this)).
contract ChainlinkVRFSource is VRFConsumerBaseV2Plus, IRandomSource {
    address public immutable vault;
    uint256 public subscriptionId;
    bytes32 public keyHash;
    uint32 public callbackGasLimit = 1_500_000;
    uint16 public requestConfirmations = 3;
    bool public payInNative = true;

    mapping(uint256 => uint256) public drawOfRequest; // VRF requestId => drawId

    event Requested(uint256 indexed drawId, uint256 requestId);

    constructor(address coordinator, address vault_, uint256 subId, bytes32 keyHash_)
        VRFConsumerBaseV2Plus(coordinator)
    {
        require(vault_ != address(0), "no vault");
        vault = vault_;
        subscriptionId = subId;
        keyHash = keyHash_;
    }

    function requestRandomness(uint256 drawId) external {
        require(msg.sender == vault, "only vault");
        uint256 requestId = s_vrfCoordinator.requestRandomWords(
            VRFV2PlusClient.RandomWordsRequest({
                keyHash: keyHash,
                subId: subscriptionId,
                requestConfirmations: requestConfirmations,
                callbackGasLimit: callbackGasLimit,
                numWords: 1,
                extraArgs: VRFV2PlusClient._argsToBytes(VRFV2PlusClient.ExtraArgsV1({nativePayment: payInNative}))
            })
        );
        drawOfRequest[requestId] = drawId;
        emit Requested(drawId, requestId);
    }

    function fulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) internal override {
        IRandomConsumer(vault).fulfillRandomness(drawOfRequest[requestId], randomWords[0]);
    }

    function setConfig(uint256 subId, bytes32 keyHash_, uint32 gasLimit, uint16 confirmations, bool native)
        external
        onlyOwner
    {
        subscriptionId = subId;
        keyHash = keyHash_;
        callbackGasLimit = gasLimit;
        requestConfirmations = confirmations;
        payInNative = native;
    }
}

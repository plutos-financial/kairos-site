// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IRandomSource, IRandomConsumer} from "./IRandomSource.sol";

/// @title DemoRandomSource
/// @notice TEST ONLY. Two-step randomness that mimics Chainlink VRF's request -> fulfill flow,
///         using a future block hash. Good enough for a testnet demo, NOT for real money:
///         swap in ChainlinkVRFSource (or any IRandomSource) before launch.
contract DemoRandomSource is IRandomSource {
    address public immutable vault;

    mapping(uint256 => uint256) public requestBlock; // drawId => block of the request

    event Requested(uint256 indexed drawId, uint256 blockNumber);
    event Fulfilled(uint256 indexed drawId, uint256 randomWord);

    constructor(address vault_) {
        vault = vault_;
    }

    function requestRandomness(uint256 drawId) external {
        require(msg.sender == vault, "only vault");
        requestBlock[drawId] = block.number;
        emit Requested(drawId, block.number);
    }

    /// @notice Anyone can finish the draw once at least one block has passed.
    function fulfill(uint256 drawId) external {
        uint256 b = requestBlock[drawId];
        require(b != 0, "no request");
        require(block.number > b + 1, "wait one more block");
        bytes32 h = blockhash(b + 1);
        // blockhash is only available for the last 256 blocks; fall back to prevrandao.
        uint256 word = uint256(keccak256(abi.encode(h, block.prevrandao, drawId, address(this))));
        delete requestBlock[drawId];
        emit Fulfilled(drawId, word);
        IRandomConsumer(vault).fulfillRandomness(drawId, word);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Anything that can give the vault a random number for a draw.
///         Flow (same as Chainlink VRF): vault calls requestRandomness(drawId),
///         later the source calls vault.fulfillRandomness(drawId, randomWord).
interface IRandomSource {
    function requestRandomness(uint256 drawId) external;
}

interface IRandomConsumer {
    function fulfillRandomness(uint256 drawId, uint256 randomWord) external;
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title MockUSDC
/// @notice TEST MONEY ONLY. A stand-in for USDC on Base Sepolia so anyone can try Plutos for free.
///         It has 6 decimals like real USDC. Anyone can call faucet() to get demo dollars.
contract MockUSDC is ERC20, Ownable {
    uint256 public constant FAUCET_AMOUNT = 1_000e6; // 1,000 test dollars per call
    uint256 public constant FAUCET_COOLDOWN = 1 hours;
    uint256 public constant TOP_UP_MAX = 1_000_000e6; // beta "Add money": any amount, up to $1M per tap

    mapping(address => bool) public isMinter;
    mapping(address => uint256) public lastFaucet;

    event MinterSet(address indexed minter, bool allowed);

    constructor() ERC20("Plutos Test USD Coin", "USDC") Ownable(msg.sender) {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Free test dollars, once per hour per wallet.
    function faucet() external {
        require(block.timestamp >= lastFaucet[msg.sender] + FAUCET_COOLDOWN, "faucet: wait an hour");
        lastFaucet[msg.sender] = block.timestamp;
        _mint(msg.sender, FAUCET_AMOUNT);
    }

    /// @notice Beta "Add money": free test dollars, as many as anyone wants (up to $1M per call,
    ///         so the numbers stay readable). Test money has no value, so there's no daily limit.
    function topUp(uint256 amount) external {
        require(amount > 0 && amount <= TOP_UP_MAX, "topup: up to $1,000,000 at a time");
        _mint(msg.sender, amount);
    }

    /// @notice Used by the mock T-bill fund to pay out interest, and by the owner for demo setup.
    function mint(address to, uint256 amount) external {
        require(isMinter[msg.sender] || msg.sender == owner(), "not minter");
        _mint(to, amount);
    }

    function setMinter(address minter, bool allowed) external onlyOwner {
        isMinter[minter] = allowed;
        emit MinterSet(minter, allowed);
    }
}

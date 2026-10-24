// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {VRFCoordinatorV2_5Mock} from "@chainlink/src/v0.8/vrf/mocks/VRFCoordinatorV2_5Mock.sol";
import {KairosBetaSetup} from "../src/KairosBetaSetup.sol";

/// Sets up the Kairos beta (Chainlink VRF draws) and saves deployments/<chainId>-beta.json.
///   Local test chain (uses a mock Chainlink coordinator):
///     forge script script/DeployBeta.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --private-key <anvil key>
///   Base Sepolia (real Chainlink VRF v2.5). Most people use the one-click page instead: /beta/deploy.html
///     forge script script/DeployBeta.s.sol --rpc-url base_sepolia --account kairos --broadcast
contract DeployBeta is Script {
    address constant BASE_SEPOLIA_COORDINATOR = 0x5C210eF41CD1a72de73bF76eC39637bB0d3d7BEE;
    bytes32 constant BASE_SEPOLIA_KEY_HASH = 0x9e1344a1247c8a1785d0a4681a27152bffdb43666ae5bf7d14d24a5efd44bf71;

    function run() external {
        vm.startBroadcast();
        address me = msg.sender;
        address coordinator = BASE_SEPOLIA_COORDINATOR;
        bytes32 keyHash = BASE_SEPOLIA_KEY_HASH;
        uint256 funding = 0.01 ether;
        uint256 period = 1 days;
        uint256 speed = 30; // a month of interest every day
        if (block.chainid == 31337) {
            coordinator = address(new VRFCoordinatorV2_5Mock(0.0001 ether, 1e9, 4e15));
            keyHash = bytes32(uint256(1));
            funding = 10 ether;
            period = 10 minutes;
            speed = 4_380; // a month of interest every 10 minutes
        }
        // $100,000 of house money: earns for the prizes, never in the draw
        KairosBetaSetup s = new KairosBetaSetup{value: funding}(coordinator, keyHash, me, period, speed, 100_000e6);
        vm.stopBroadcast();

        string memory o = "beta";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeAddress(o, "usdc", address(s.usdc()));
        vm.serializeAddress(o, "tbill", address(s.tbill()));
        vm.serializeAddress(o, "randomSource", address(s.vrf()));
        vm.serializeAddress(o, "vrf", address(s.vrf()));
        vm.serializeAddress(o, "coordinator", coordinator);
        vm.serializeString(o, "subscriptionId", vm.toString(s.subscriptionId()));
        vm.serializeAddress(o, "setup", address(s));
        vm.serializeAddress(o, "owner", me);
        string memory json = vm.serializeAddress(o, "vault", address(s.vault()));
        string memory path = string.concat("deployments/", vm.toString(block.chainid), "-beta.json");
        vm.writeJson(json, path);
        console2.log("Kairos beta vault", address(s.vault()));
        console2.log("Chainlink VRF source", address(s.vrf()));
        console2.log("Saved to", path);
    }
}

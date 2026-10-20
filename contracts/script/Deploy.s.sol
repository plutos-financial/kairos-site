// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {MockTBill} from "../src/MockTBill.sol";
import {KairosVault, ITBillFund} from "../src/KairosVault.sol";
import {DemoRandomSource} from "../src/DemoRandomSource.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// Deploys the whole Kairos demo and saves the addresses to deployments/<chainId>.json
///   forge script script/Deploy.s.sol --rpc-url base_sepolia --account kairos --broadcast
contract Deploy is Script {
    function run() external {
        vm.startBroadcast();
        address me = msg.sender;

        MockUSDC usdc = new MockUSDC();
        MockTBill tbill = new MockTBill(usdc);
        usdc.setMinter(address(tbill), true);

        KairosVault vault = new KairosVault(IERC20(address(usdc)), ITBillFund(address(tbill)), me);
        tbill.setAllowlisted(address(vault), true);

        DemoRandomSource rng = new DemoRandomSource(address(vault));
        vault.setRandomSource(rng);

        // ---- demo-friendly settings (change any time from the admin panel) ----
        vault.setDrawPeriod(10 minutes); // a draw every 10 minutes
        tbill.setSpeed(52_560); // one year of T-bill interest every 10 minutes
        tbill.setRules(0, 0, 2 minutes, true); // "T+1" shortened to 2 minutes; instant route on (use "Weekend" in the app to turn it off)

        vm.stopBroadcast();

        string memory o = "deploy";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeAddress(o, "usdc", address(usdc));
        vm.serializeAddress(o, "tbill", address(tbill));
        vm.serializeAddress(o, "randomSource", address(rng));
        vm.serializeAddress(o, "owner", me);
        string memory json = vm.serializeAddress(o, "vault", address(vault));
        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);

        console2.log("MockUSDC        ", address(usdc));
        console2.log("MockTBill       ", address(tbill));
        console2.log("KairosVault     ", address(vault));
        console2.log("DemoRandomSource", address(rng));
        console2.log("Saved to", path);
    }
}

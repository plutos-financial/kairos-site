// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";

interface IOwnable {
    function owner() external view returns (address);
    function transferOwnership(address newOwner) external;
}

/// Hands the owner controls from one wallet to a Safe multisig (for example 2 of 3: Ramy, Callum, a backup).
/// Run it from the wallet that owns the contracts today, after creating the Safe at app.safe.global.
///
///   SAFE=0xYourSafe forge script script/HandOverToSafe.s.sol --rpc-url base_sepolia --account kairos --broadcast
///
/// It reads the addresses from deployments/<chainId>-beta.json. Without --broadcast it only shows what it
/// would do. Afterwards, the Safe must approve one transaction calling acceptOwnership() on the Chainlink
/// source (the vrf address it prints), because that contract hands over in two steps.
///
/// The vault hands over in ONE step and can't be undone by this wallet, so the script refuses an address
/// with no contract code (a typo, or an ordinary wallet) and anything that isn't a Safe-shaped contract.
contract HandOverToSafe is Script {
    function run() external {
        address safe = vm.envAddress("SAFE");
        require(safe.code.length > 0, "SAFE has no contract code: create the Safe first, on this network");
        // Every Safe answers getThreshold(); an ordinary contract or token won't.
        (bool ok, bytes memory data) = safe.staticcall(abi.encodeWithSignature("getThreshold()"));
        require(ok && data.length == 32 && abi.decode(data, (uint256)) >= 2, "SAFE isn't a Safe that needs at least 2 signers");

        string memory file = string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), "-beta.json");
        string memory json = vm.readFile(file);
        address vault = vm.parseJsonAddress(json, ".vault");
        address vrf = vm.parseJsonAddress(json, ".vrf");
        address tbill = vm.parseJsonAddress(json, ".tbill");
        address usdc = vm.parseJsonAddress(json, ".usdc");

        console2.log("Vault owner today:", IOwnable(vault).owner());
        console2.log("Handing over to Safe:", safe);

        vm.startBroadcast();
        address me = msg.sender;
        address vaultOwner = IOwnable(vault).owner();
        require(vaultOwner == me || vaultOwner == safe, "run this from the wallet that owns the vault");
        if (vaultOwner == me) IOwnable(vault).transferOwnership(safe); // a second run skips what's already moved
        // The test tokens only exist on the test network; real USDC and BENJI have no Plutos owner.
        if (tbill.code.length > 0 && IOwnable(tbill).owner() == me) IOwnable(tbill).transferOwnership(safe);
        if (usdc.code.length > 0 && IOwnable(usdc).owner() == me) IOwnable(usdc).transferOwnership(safe);
        bool vrfMine = IOwnable(vrf).owner() == me;
        if (vrfMine) IOwnable(vrf).transferOwnership(safe); // pending until the Safe accepts
        vm.stopBroadcast();

        if (vrfMine) console2.log("Done. Now have the Safe call acceptOwnership() on the Chainlink source:", vrf);
        else
            console2.log(
                "Done, except Chainlink: its settings are still waiting for this wallet to take them over. Press 'Take over Chainlink settings' on the Draws page, then run this again."
            );
    }
}

#!/usr/bin/env bash
# Installs the contract libraries (not included in the zip to keep it small).
set -e
cd "$(dirname "$0")"
forge install foundry-rs/forge-std --no-git
forge install OpenZeppelin/openzeppelin-contracts@v5.1.0 --no-git
forge install smartcontractkit/chainlink-brownie-contracts@1.3.0 --no-git
echo "Libraries installed."

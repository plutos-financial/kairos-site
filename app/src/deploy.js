// Deploys and configures the whole Plutos demo from the browser, using the connected wallet.
import { createPublicClient, createWalletClient, custom, http, parseEther, parseEventLogs } from "viem";
import { baseSepolia, foundry } from "viem/chains";
import abis from "./abis.json";
import bytecode from "./bytecode.json";
import setup from "./setup.json"; // the one-transaction beta setup (KairosBetaSetup)
import built from "./site-config.json";
import "./fresh.js"; // stale-page reload and frame guard
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// The beta sets everything up in ONE transaction (KairosBetaSetup), including Chainlink VRF.
const isBeta = built.edition === "beta";
const VRF = {
  // Chainlink VRF v2.5 on Base Sepolia (docs.chain.link/vrf/v2-5/supported-networks)
  coordinator: "0x5C210eF41CD1a72de73bF76eC39637bB0d3d7BEE",
  keyHash: "0x9e1344a1247c8a1785d0a4681a27152bffdb43666ae5bf7d14d24a5efd44bf71",
};
const VRF_FUNDING = "0.002"; // test ETH sent to the Chainlink subscription; each draw costs a tiny fraction of this
const GAS_ALLOWANCE = "0.0004"; // the setup transaction itself costs far less than this on Base Sepolia
const DRAW_PERIOD = 86_400n; // a draw every day
const SPEED = 30n; // a month of interest every day, so the prize pool visibly grows
const HOUSE_MONEY = 100_000_000_000n; // $100,000 of test dollars that earn for the prizes and can never win

const $ = (id) => document.getElementById(id);
// ?rpc=http://127.0.0.1:8545 deploys to a local test chain instead (for developers).
const localRpc = new URLSearchParams(location.search).get("rpc");
const chain = localRpc ? { ...foundry, id: 31337 } : baseSepolia;
const explorer = "https://sepolia.basescan.org";
const pub = createPublicClient({ chain, transport: http(localRpc || "https://sepolia.base.org") });
let result;

function log(html) {
  const li = document.createElement("li");
  li.innerHTML = html;
  $("log").appendChild(li);
  return li;
}

async function connect() {
  if (!window.ethereum) throw new Error("No wallet found. Install MetaMask or Coinbase Wallet and reload.");
  const [addr] = await window.ethereum.request({ method: "eth_requestAccounts" });
  const hexId = "0x" + chain.id.toString(16);
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexId }] });
  } catch (e) {
    if (e.code !== 4902) throw e;
    await window.ethereum.request({
      method: "wallet_addEthereumChain",
      params: [{ chainId: hexId, chainName: "Base Sepolia", nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 }, rpcUrls: ["https://sepolia.base.org"], blockExplorerUrls: [explorer] }],
    });
  }
  return { addr, wallet: createWalletClient({ chain, account: addr, transport: custom(window.ethereum) }) };
}

async function deploy(wallet, addr, name, args = []) {
  const li = log(`Deploying ${name}… confirm in your wallet`);
  const hash = await wallet.deployContract({ abi: abis[name], bytecode: bytecode[name], args, account: addr });
  const r = await pub.waitForTransactionReceipt({ hash });
  li.innerHTML = `✓ ${name}: <a href="${explorer}/address/${r.contractAddress}" target="_blank" rel="noopener noreferrer">${r.contractAddress}</a>`;
  return r.contractAddress;
}

async function call(wallet, addr, label, address, abi, functionName, args) {
  const li = log(`${label}… confirm in your wallet`);
  const hash = await wallet.writeContract({ address, abi, functionName, args, account: addr });
  await pub.waitForTransactionReceipt({ hash });
  li.innerHTML = `✓ ${label}`;
}

if (isBeta) {
  $("dTitle").textContent = "Set up the Plutos beta";
  $("dIntro").innerHTML = `One transaction sets up everything: test USDC, the T-bill fund, the vault, a Chainlink VRF subscription for fair draws, and $100,000 of house money that earns for the prize pool and can never win. It sends ${VRF_FUNDING} test ETH to Chainlink to pay for random numbers. The wallet you use becomes the owner.`;
  $("dSteps").innerHTML = `<li>Use your Plutos test wallet in MetaMask (never one with real money).</li>
    <li>Make sure it has about 0.003 Base Sepolia ETH (free from a faucet).</li>
    <li>Click the button and approve the one transaction.</li>`;
  $("go").textContent = "Connect and set up the beta";
}

async function setUpBeta() {
  const { addr, wallet } = await connect();
  const bal = await pub.getBalance({ address: addr });
  log(`Connected ${addr} · ${(Number(bal) / 1e18).toFixed(4)} test ETH`);
  if (bal < parseEther(VRF_FUNDING) + parseEther(GAS_ALLOWANCE))
    throw new Error(`This wallet needs about 0.003 Base Sepolia ETH. Get some from a faucet, then try again.`);
  const li = log("Setting up everything in one transaction… confirm in your wallet");
  const hash = await wallet.deployContract({
    abi: setup.abi,
    bytecode: setup.bytecode,
    args: [VRF.coordinator, VRF.keyHash, addr, DRAW_PERIOD, SPEED, HOUSE_MONEY],
    value: parseEther(VRF_FUNDING),
    account: addr,
  });
  li.innerHTML = "Waiting for Base to confirm…";
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error("The setup transaction failed. Nothing was set up. Try again.");
  const ready = parseEventLogs({ abi: setup.abi, logs: r.logs, eventName: "Ready" })[0];
  if (!ready) throw new Error("Set up, but couldn't read the addresses. Send Claude the transaction link.");
  const a = ready.args;
  li.innerHTML = `✓ Everything is set up: <a href="${explorer}/tx/${hash}" target="_blank" rel="noopener noreferrer">see the transaction</a>`;
  return {
    chainId: chain.id,
    usdc: a.usdc,
    tbill: a.tbill,
    vault: a.vault,
    randomSource: a.vrf,
    vrf: a.vrf,
    coordinator: VRF.coordinator,
    subscriptionId: a.subscriptionId.toString(),
    setup: r.contractAddress,
    owner: addr,
  };
}

$("copy").onclick = async () => {
  try {
    await navigator.clipboard.writeText(JSON.stringify(result, null, 2));
    $("copy").textContent = "Copied";
  } catch {
    getSelection().selectAllChildren($("resultJson"));
  }
};

$("go").onclick = async () => {
  if (isBeta) {
    $("go").disabled = true;
    try {
      result = await setUpBeta();
      try {
        localStorage.setItem("kairos.deployment.beta", JSON.stringify(result));
      } catch {}
      $("resultJson").textContent = JSON.stringify(result, null, 2);
      $("resultCard").hidden = false;
      $("copy").hidden = false;
      $("open").hidden = false;
      log("<b>Done.</b> This browser now uses the new beta. Copy the details for Claude so everyone else gets it too.");
    } catch (e) {
      log(`<span style="color:var(--red)">Stopped: ${esc(e.shortMessage || e.message)}</span>`);
      $("go").disabled = false;
    }
    return;
  }
  $("go").disabled = true;
  try {
    const { addr, wallet } = await connect();
    const bal = await pub.getBalance({ address: addr });
    log(`Connected ${addr} · ${(Number(bal) / 1e18).toFixed(4)} test ETH`);
    if (bal === 0n) throw new Error("This wallet has no Base Sepolia ETH yet. Use a faucet first (see README).");

    const usdc = await deploy(wallet, addr, "MockUSDC");
    const tbill = await deploy(wallet, addr, "MockTBill", [usdc]);
    const vault = await deploy(wallet, addr, "KairosVault", [usdc, tbill, addr]);
    const rng = await deploy(wallet, addr, "DemoRandomSource", [vault]);

    await call(wallet, addr, "Let the T-bill fund pay interest in test USDC", usdc, abis.MockUSDC, "setMinter", [tbill, true]);
    await call(wallet, addr, "Allowlist the vault at the T-bill fund (like KYC)", tbill, abis.MockTBill, "setAllowlisted", [vault, true]);
    await call(wallet, addr, "Connect the randomness source", vault, abis.KairosVault, "setRandomSource", [rng]);
    await call(wallet, addr, "Draw every 10 minutes", vault, abis.KairosVault, "setDrawPeriod", [600n]);
    await call(wallet, addr, "Speed up interest: 1 year per 10 minutes", tbill, abis.MockTBill, "setSpeed", [52560n]);
    await call(wallet, addr, "Fund rules: settle in 2 minutes, instant route on", tbill, abis.MockTBill, "setRules", [0n, 0n, 120n, true]);

    result = { chainId: chain.id, usdc, tbill, vault, randomSource: rng, owner: addr };
    try {
      localStorage.setItem("kairos.deployment", JSON.stringify(result)); // the demo
    } catch {}
    log("<b>Done.</b> This browser will now use your new deployment. Download deployment.json to share it (see README).");
    $("dl").hidden = false;
    $("open").hidden = false;
  } catch (e) {
    log(`<span style="color:var(--red)">Stopped: ${esc(e.shortMessage || e.message)}</span>`);
    $("go").disabled = false;
  }
};

$("dl").onclick = () => {
  const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "deployment.json";
  a.click();
};

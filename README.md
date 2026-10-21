# Kairos

Pluto's Financial · prize-linked savings · **test money only**

Kairos is a savings account with a prize draw: savers keep every dollar they put in, and the interest is handed out as prizes. This repo holds everything: the website, the smart contracts, and a small money server.

The site is at **https://plutos-financial.github.io/kairos-site/** (Base Sepolia, Base's free test network). It has:

- **Chainlink VRF draws**: winners are picked with a verifiable random number.
- **Add money with Apple Pay** through Coinbase's onramp, in Coinbase's test mode (no card is charged; test dollars arrive instead).
- **A Kairos wallet** with send, receive and cash out (cash out is simulated: Coinbase has no test mode for it).
- **Savings as kUSD tokens**, one per dollar saved, non-transferable.

Old `/beta/` links redirect to the main site. The original demo edition (simple random source, free test dollars, contracts in `deployments/84532.json`) is still in the code and can be built with `node sync.mjs && npx vite build`.

Nothing here moves real money. Coinbase runs in sandbox mode (cards are never charged) and the dollars are test tokens.

---

## How publishing works

Push to `main` and GitHub builds and publishes the site by itself (`.github/workflows/publish.yml`, about a minute). You can watch it under the **Actions** tab. Pages reload themselves when a newer version is out, so nobody gets stuck on an old copy.

## What's in the repo

| Folder | What it is |
|---|---|
| `app/` | The website (Vite, plain JavaScript). `node build-all.mjs` builds what GitHub publishes. |
| `contracts/` | Solidity contracts and tests (Foundry). `deployments/` holds the live addresses. |
| `shared/` | Contract ABIs and bytecode, exported from `contracts/` for the app. |
| `netlify/` | The money server: one function that creates Coinbase Apple Pay orders. Runs on Netlify (https://majestic-raindrop-515139.netlify.app) because GitHub Pages can't run server code. |
| `keeper/` | Optional bot that rebalances and closes draws on a timer. |
| `waitlist/` | The Google Apps Script that saves waitlist sign-ups to the Kairos Google Sheet. |

### The contracts

| Contract | Role | Real-world equivalent |
|---|---|---|
| `MockUSDC` | Test dollars: hourly faucet, plus `topUp(amount)` up to $10,000 a day for the beta's Add money | USDC |
| `MockTBill` | Test T-bill fund: rising price, allowlist, settlement delay, optional instant route | BUIDL, BENJI, USTB |
| `KairosVault` | Deposits (minted 1:1 as non-transferable kUSD), cash drawer, 85/15 interest split, time-weighted draws, withdrawal queue | The Kairos product |
| `DemoRandomSource` | Simple two-step randomness (the demo) | |
| `ChainlinkVRFSource` | Chainlink VRF v2.5 randomness (the beta) | Chainlink VRF |
| `KairosBetaSetup` | Sets up the whole beta in one transaction: all of the above plus a funded Chainlink subscription | |

Fees: there is **no deposit or withdrawal fee**. Kairos keeps 15% of the interest; 85% becomes prizes.

---

## Working on it (Callum, or anyone with push access)

Needs Node 22 and, for contracts, Foundry.

```bash
cd app
npm install
EDITION=beta node sync.mjs && VITE_EDITION=beta npx vite   # the site at http://localhost:5173
node build-all.mjs                 # what GitHub runs

cd ../netlify && npm install && npm test     # money server tests (fake Coinbase)

cd ../contracts && ./install-deps.sh && forge build && forge test
```

Edit, commit, push to `main`, and the site updates. Text and layout live in the `.html` files; behavior in `app/src/` (`app.js` savings app, `admin.js` draws page, `beta-wallet.js` the beta's wallet, `pretend.js` pretend draws, `core.js` shared plumbing).

Local test chain: run `anvil`, deploy with `forge script script/Deploy.s.sol` (demo) and `script/DeployBeta.s.sol` (beta, uses a mock Chainlink coordinator) against `http://127.0.0.1:8545`, then `CHAIN_ID=31337 node build-all.mjs`. Add `?devkey=<anvil key>` to a page URL to sign in with a local key.

---

## Setup status

- Contracts: set up on Base Sepolia with `KairosBetaSetup` (`contracts/deployments/84532-beta.json`). To redo it, open `/deploy.html` with MetaMask (about 0.003 test ETH).
- Money server: running on Netlify with `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` (secret) and `ALLOWED_ORIGINS`. Coinbase Onramp is in trial mode (25 orders, $5 max each).
- Still to do: add your own domain to GitHub Pages, Coinbase (Embedded Wallets clients, Onramp domain allowlist) and `ALLOWED_ORIGINS`; apply for full Onramp access before launch.
- Coinbase gas sponsor: if the Paymaster has a contract allowlist, it must include the USDC, vault and T-bill addresses in `84532-beta.json` (or be empty).

## Before real money (not built yet, on purpose)

- **Legal structure first.** In the US, prize-linked savings is clearly allowed for banks and credit unions. A non-bank running one raises lottery, money-transmitter and securities questions. Nothing here should hold real funds until counsel signs off.
- **Coinbase production access**: onramp business approval, SMS verification of phone numbers, and the Apple Pay domain.
- **A real tokenized T-bill fund** behind an adapter matching `ITBillFund`, with the issuer's allowlisting.
- **Identity checks (KYC)**: the vault has an allowlist switch (`setDepositRules`).
- **Admin keys in a multisig** (Safe), a timelock on changes, and two independent audits.
- **Scale:** the draw loops over all savers. Fine for a beta, but it needs a sortition tree before thousands of users.

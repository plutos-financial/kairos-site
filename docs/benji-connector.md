# Connecting the vault to BENJI

Status: design notes, written before Franklin Templeton's approval. Nothing here is built yet. Fill in the
open questions with Franklin's answers, then build the connector and have the auditors review it.

## What the vault expects today

The vault talks to its T-bill fund through a small set of calls. On the test network they are answered by
`MockTBill`, which subscribes and redeems instantly or after a short delay and grows its price over time.
A BENJI connector has to answer the same calls:

| Call | What the vault uses it for |
| --- | --- |
| `subscribe(usdc)` | Invest spare cash above the cash band |
| `requestRedeem(tokens)` → `(id, owed)` | Start a redemption when cash runs low |
| `isReady(id)`, `claimRedeem(id)` | Collect a finished redemption |
| `redeemInstant(tokens)` | Pay a withdrawal at once when the instant route is open |
| `nav()`, `valueOf(tokens)`, `balanceOf(vault)` | Value the vault's holdings in dollars |
| `minSubscription()`, `minRedemption()` | Avoid orders below the fund's minimums |

The vault's main safety check is that it always holds at least what it owes (`totalAssets() >=
totalLiabilities()`). The keeper checks this every tick and fails its run if it ever breaks.

## How BENJI differs from the test fund

1. **Approved wallets only.** BENJI can only be held by wallets Franklin's transfer agent has approved. The
   vault contract (or the connector that holds BENJI for it) must be approved, along with the multisig.
2. **Interest arrives as new tokens.** BENJI keeps its price at $1 and pays interest daily by minting more
   tokens, instead of the price rising like `MockTBill`. So `nav()` stays at $1, and the connector's
   `valueOf` must count the extra tokens. The vault's interest maths (assets above liabilities) works either
   way, as long as the new tokens land at the address the vault counts.
3. **Orders go through Franklin's process.** Subscriptions and redemptions may settle on Franklin's
   schedule (cutoff times, business days) rather than instantly on-chain. `requestRedeem` / `isReady` /
   `claimRedeem` already model a wait; the cash band (`targetCashBps`, `lowBps`, `highBps`) should be sized to
   the real settlement time so withdrawals rarely queue.
4. **USDC in, USDC out.** If Franklin doesn't take USDC directly, a partner (for example MoonPay) swaps USDC
   for BENJI and back. That adds a fee and a second party to every order.

## Likely shape

A `BenjiConnector` contract that the vault treats as its fund:

- holds the BENJI tokens (so only the connector needs approval, not the vault),
- turns `subscribe` / `requestRedeem` into Franklin's on-chain or off-chain order flow, or a partner swap,
- reports `valueOf` as BENJI balance × $1, including the daily minted interest,
- has no way to send BENJI or USDC anywhere except back to the vault.

The vault's `tbill` address is set at construction, so moving the live vault to a connector means a new
vault deployment before launch. That's expected: mainnet is a fresh deployment anyway.

## Open questions for Franklin

These match the "Questions to ask Franklin now" list in the Plutos Launch Plan.

1. Can a smart contract be an approved BENJI holder, or only a company wallet?
2. What does business onboarding require, and how long does it take?
3. Minimum subscription and redemption sizes?
4. Redemption settlement time and daily cutoffs?
5. USDC directly, or through a partner?
6. How dividends are delivered on Base, and whether they can go to a separate address.
7. Limits on end customers or product type.
8. Fees beyond the fund's expense ratio (about 0.20% a year).

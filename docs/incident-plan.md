# Incident plan

What to do when something goes wrong with Plutos. Keep it short enough to follow under pressure.

## Who

- **Ramy** and **Callum** can both act. Once the multisig is set up, owner actions need two of the three keys
  (Ramy, Callum, backup), so agree on who signs before anything happens.
- GitHub emails whoever is set to get Actions notifications for this repo when the keeper's run fails. Warnings (low Chainlink balance, a slow draw) show
  on the run's page without an email, so check the Actions tab at least once a day.

## The pause switch

**Pause deposits** on the Draws page (Team controls, More controls) stops new deposits and new draws.
Withdrawals keep working while paused, by design: nobody can be locked out of their savings. Use it whenever you aren't sure
the vault is safe to take more money.

## What can happen

| Alert or symptom | What it means | What to do |
| --- | --- | --- |
| Keeper fails: "The vault holds … but owes …" | The vault holds less than it owes savers. Serious. | Pause deposits now. Don't touch the T-bill settings. Find the cause (fund price feed, a bug) before anything else. Tell savers within a day what happened and that withdrawals still work. |
| Warning: Chainlink's subscription is low | Chainlink won't send random numbers, so draws stall. | Press "Add 0.02 test ETH" on the Draws page (any MetaMask wallet with test ETH can do it). |
| Warning: a draw has waited many hours | Chainlink hasn't answered. | Top up Chainlink first if it's low. After a day, Chainlink drops the request: the owner presses "Ask Chainlink again". |
| Warning: the keeper wallet is low on ETH | It can't send transactions soon. | Send it test ETH from a faucet. |
| Keeper fails with an error it can't explain | Usually a bad secret or a contract change. | Open the run, read the annotation, fix, re-run the workflow by hand. |
| Withdrawals are queuing | The cash reserve ran out and T-bills are settling. | Nothing breaks: they pay out when the fund settles. If it lasts, raise the cash band. |
| A suspected bug in the contracts | Anything that could move money wrongly. | Pause deposits. Contact the auditors. Don't deploy a fix without their review. |

## Telling savers

Say what happened, whether anyone's money was affected, that withdrawals still work, and what happens next.
Plain words, no blame, sent within a day. Post it on the website and email the people affected.

## Afterwards

Write down what happened, what you did and what you'll change, in this folder, within a week.

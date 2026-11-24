# Phase 11 — Unified Path-Dependent Monte Carlo Portfolio Simulation

## Objective

Phase 11 joins the joint-scenario engine (Phase 1), contractual payoff evaluator (Phase 2), unified portfolio/cash model (Phase 9), and chronological contractual lifecycle (Phase 10). Each Monte Carlo iteration is a full portfolio path, not a collection of independent account outcomes.

## Execution model

For each iteration:

1. Initialize the configured prop-firm accounts and subtract explicit upfront cash commitments.
2. Draw one complete joint scenario for each trading period, with replacement, using the seeded Phase 1 PRNG.
3. Apply each account's non-negative hedge ratio to its signed scenario P&L and supplied intraday excursions. The scenario outcome already encodes long/short direction.
4. Convert the sampled sequence into a chronological Phase 10 lifecycle path. Phase 10 applies evaluation progression, funded transition, drawdown methodology, daily-loss session resets, payout-cycle timing, contractual payout eligibility and explicit realized withdrawals.
5. Evaluate portfolio stop conditions after every complete trading period. The path stops when cumulative portfolio trading loss reaches maxPortfolioLossUsd, or fewer than minimumActiveAccounts remain active.
6. Replay the processed periods' explicit cash flows. Upfront commitments, cash outflows and non-payout cash inflows are distinct from trading P&L. Phase 10-validated realized withdrawals are also counted as trader cash receipts.

A recurring template receives a unique chronological scenario ID in each sampled path. The original template ID remains in the retained audit path.

## Contract and path inputs

Each account requires the Phase 10 lifecycle inputs, its firm contract version, and a non-negative hedgeRatio. Each joint scenario includes:
- The Phase 1 joint outcomes map, preserving cross-account dependence within a period.
- accountPaths, including a session ID and optional intraday peak/adverse excursions and an explicit realized payout.
- Optional per-account cash-flow entries.

Use sessionIdByPeriod when a scenario template may recur across trading days. It must contain a non-empty session ID for every period in the requested horizon. The caller remains responsible for generating these identifiers from each contract's reset time and IANA timezone. The engine does not infer calendar dates or timezone boundaries.

Intraday excursions are expressed in the source scenario's P&L units and multiplied by the same hedge ratio as daily P&L. realizedPayoutUsd is an explicit withdrawal amount and is not scaled. It is accepted only if Phase 10 validates the payout cycle and contractual payout opportunity.

## Outputs

The result reports:
- Portfolio survival and portfolio-stop probabilities.
- Per-account survival and per-firm all-account survival.
- Expected cumulative trading P&L, explicit realized payout, and contractual payout opportunity.
- Probability of any realized payout and any contractual payout opportunity.
- Expected, median, 95th percentile and maximum external capital required.
- Ending cash distribution and average periods simulated.
- Account breach/restriction/termination counts and portfolio stop attribution.
- Optional retained sample paths with sampled scenario IDs, terminal account balance/equity/status, cash deficit and stopping reason.

External capital required for a path is:

\[
C_{required}=\max\left(0,-\min_t C_t\right)
\]

where cash starts at available cash less upfront commitments and is then changed only by explicit cash inflows/outflows and Phase 10-validated realized withdrawals. The model does not inject hypothetical capital during a path.

## Important modeling boundaries

- Period draws are independent and stationary with replacement. Cross-account dependence is preserved within each sampled joint scenario, but serial dependence, Markov transitions, regime changes and conditional scenario trees are not modeled.
- maxPortfolioLossUsd is based on cumulative account trading P&L and excludes realized withdrawals and cash fees. Cash fees affect the separate cash ledger only when explicitly supplied.
- Cash flows are applied to every sampled period/account, including after account failure. Supply zero future flows when contractual fees or other payments should cease after failure.
- A contractual payout opportunity is not cash. Only a Phase 10-validated realizedPayoutUsd or an explicit non-payout cash inflow is counted as received cash. Do not duplicate payouts in realizedCashInflowUsd.
- Intraday risk is only as accurate as the supplied daily P&L and intraday peak/adverse excursions. No tick-level path is reconstructed.
- Session IDs must match the firm's actual reset calendar. A wrong session schedule can materially distort daily-loss results.
- Contract rules are taken from the supplied versioned PropFirmPreset; no missing rule is inferred. Unknown critical drawdown, daily-loss or funded payout-cycle rules fail closed.
- Results are conditional on the input scenario matrix and contract records. Monte Carlo precision does not eliminate model, data or contractual uncertainty; probabilities are not forecasts or guarantees.
- This is a simulation and capital-requirement analysis, not live execution, financing advice or a guarantee of prop-firm payouts.

## Validation status

Focused tests have been added for reproducibility, cash-deficit accounting, portfolio stop conditions, breach-day loss accounting, session-calendar resets and invalid inputs. They must be executed with the repository test/lint/build scripts before this phase can be considered validated. No runtime, TypeScript, lint or build result is implied by the existence of these test cases.

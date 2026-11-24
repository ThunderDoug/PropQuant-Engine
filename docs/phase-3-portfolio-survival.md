# Phase 3 — Multi-Firm Portfolio Survival Analysis

## Objective

Estimate the probability that a cross-hedged portfolio of prop-firm accounts remains operational over a defined sequence of market events. The unit of simulation is the complete portfolio path, not an isolated account.

## Architecture

`src/utils/portfolioSurvivalEngine.ts` consumes Phase 1 joint scenario templates. At each period it samples one complete joint scenario, preserving the cross-account dependence encoded by the portfolio-level probability matrix.

The engine tracks:
- cumulative P&L and absorbing account status for every account;
- explicit account loss budgets;
- optional portfolio-wide loss budget;
- minimum active-account requirement;
- account, firm, pairwise and whole-portfolio survival;
- time to first account failure and portfolio stopping period;
- terminal P&L distribution and Monte Carlo uncertainty.

## Failure semantics

- `breached`, `restricted`, and `terminated` outcomes are absorbing account failures.
- An active account breaches when cumulative simulated P&L reaches or falls below its configured negative loss budget.
- The portfolio fails when its aggregate cumulative P&L reaches or falls below the configured portfolio loss budget, or active account count drops below the configured minimum.
- A portfolio can survive while one constituent account has failed, provided the minimum active-account condition remains satisfied.
- Once portfolio failure occurs, the path stops; no further scenario is sampled for that path.

## Dependence and cross-hedging

Correlation is not inferred from marginal win rates. It is represented by the complete joint scenarios and their probabilities. Shared-shock IDs remain in scenario data for traceability; joint failure probabilities and conditional failure probabilities are calculated from simulated paths.

## Outputs

- Portfolio survival/failure probability and 95% normal-approximation Monte Carlo interval.
- Account survival probability, mean failure period, failure cause counts and terminal P&L percentiles.
- Firm-level probability that all accounts survive and probability at least one survives.
- Pairwise joint and conditional account failure probabilities.
- Time-to-first-account-failure frequency and portfolio terminal P&L percentiles.

## Assumptions and boundaries

- Loss budgets are explicit user inputs. The engine does not silently infer them from account size or prop-firm drawdown rules.
- P&L is modeled in USD and treated as additive across accounts; broker hedge P&L, FX, fees, payouts and cash settlement are not included here.
- The configured account loss budget is a cumulative P&L threshold, not an intraday equity/drawdown engine.
- The engine does not assert that a surviving account's profit compensates for a failed account.
- Results are conditional on the supplied scenario matrix, horizon and loss budgets; they are not forecasts or guarantees.
- Monte Carlo confidence intervals quantify sampling error only, not uncertainty in scenario probabilities or contract data.

## Validation

Tests cover deterministic survival, absorbing failures, portfolio loss limits, shared-shock joint failures, seeded replay, invalid inputs and account-level loss-budget breaches.

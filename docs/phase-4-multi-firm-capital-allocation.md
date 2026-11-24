# Phase 4 — Multi-Firm Capital Allocation

## Objective

Allocate a finite external-capital budget across prop-firm account candidates. The optimizer evaluates complete joint portfolio scenarios, preserving cross-firm dependence rather than combining independently estimated account returns.

## Engine

- `src/utils/multiFirmCapitalAllocationEngine.ts`
- `tests/multiFirmCapitalAllocationEngine.test.ts`

The engine performs deterministic exhaustive enumeration of integer account units. It returns an exact optimum only if the full search completes within `maxSearchNodes`; otherwise it throws and makes no optimality claim.

## Inputs

- Candidate account/firm identity, upfront capital required per unit, and maximum units.
- Complete joint scenarios with a probability and each candidate's per-unit net P&L and survival flag.
- Capital budget and optional concentration, diversification, survival, loss-probability, CVaR, and opportunity-cost constraints.

All scenario outcomes and probabilities are supplied by the caller. The engine does not infer contract fees, probabilities, payout eligibility, or account costs.

## Objective

`expectedNetPnlUsd - riskAversion × conditionalValueAtRiskLossUsd`

Expected net P&L is expected scenario P&L less the capital opportunity cost. CVaR is the probability-weighted average loss in the worst tail, including fractional boundary probability mass. The objective is a configurable ranking criterion, not a forecast.

## Constraints

- Total committed capital cannot exceed the budget.
- Optional maximum share of capital allocated to any single firm.
- Optional minimum number of distinct firms.
- Optional minimum probability that all selected accounts survive.
- Optional maximum probability of negative net portfolio P&L.
- Optional maximum CVaR loss.

## Outputs

The result includes integer allocations, committed/unused capital, expected gross and net P&L, capital opportunity cost, return on committed capital, probability of loss, portfolio survival probability, VaR/CVaR, worst scenario, objective value, and scenario-level net P&L/survival.

## Important modeling boundaries

- A candidate unit is assumed to be identical to other units of that candidate; scenario P&L and capital scale linearly with units.
- Joint scenario outcomes must already reflect the intended cross-hedge and dependence structure.
- Scenario P&L is supplied net P&L before the explicit capital opportunity cost; it is not automatically derived from Phase 2 contractual payout eligibility.
- Account survival is a supplied scenario flag; it is not recomputed from Phase 3 loss-budget paths.
- Capital opportunity cost is a user-supplied rate over the modeled horizon, not an observed financing rate.
- The optimizer is a finite discrete search, not a continuous optimizer. It refuses to return an "optimal" result if the search-node safety limit is exceeded.
- No real-money execution, cash settlement, FX conversion, or guaranteed return is modeled.

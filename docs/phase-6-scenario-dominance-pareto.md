# Phase 6 — Scenario Dominance and Pareto Frontier

## Objective

Compare cross-hedging configurations without compressing fundamentally different objectives into one weighted score. The output identifies feasible, dominated, and non-dominated configurations.

## Engine

- `src/utils/paretoFrontierEngine.ts`
- `tests/paretoFrontierEngine.test.ts`

## Objectives

| Objective | Direction |
|---|---|
| External capital required | Minimize |
| Expected net profit | Maximize |
| Portfolio survival probability | Maximize |
| Probability of loss | Minimize |
| CVaR loss | Minimize |
| Worst-case loss | Minimize |
| Active firm count | Maximize |
| Active account count | Maximize |

A configuration A dominates B only when A is no worse than B on every objective (within the configured tolerance) and strictly better on at least one. Equal objective vectors do not dominate one another.

## Feasibility constraints

Optional hard constraints can be applied before Pareto comparisons: maximum external capital, minimum expected profit, minimum survival probability, maximum loss probability, maximum CVaR, maximum worst-case loss, and minimum active firm/account counts. Infeasible configurations are reported separately and do not affect the frontier.

## Outputs

- Non-dominated Pareto frontier.
- Dominated configurations and the identifiers of configurations that dominate each one.
- Infeasible configurations and violated constraints.
- Counts of total, feasible, infeasible, and frontier configurations.
- Number of pairwise comparisons and the objective directions used.

## Modeling rules and limitations

- No composite score, weighted ranking, or arbitrary single "best" configuration is generated.
- Inputs are already-computed metrics from upstream scenario, contractual payoff, portfolio survival, and external-capital engines. This phase does not recalculate those metrics.
- All monetary values must use a consistent currency and valuation basis.
- Survival and loss probabilities must be in [0, 1]. CVaR loss cannot exceed worst-case loss under the supplied loss definitions.
- The tolerance is a single absolute tolerance applied in native units to each objective. For mixed scales, use the default near-zero tolerance or normalize metrics upstream and document that normalization; a future extension may support per-objective tolerances.
- The frontier is conditional on the supplied configurations, assumptions, scenario probabilities, and upstream metric calculations. It is not a forecast or guarantee.
- No live trading, account modification, or movement of funds is performed.

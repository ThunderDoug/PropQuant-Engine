# Phase 8 — Contract-Aware Hedge Ratio Optimization

## Objective

Search account-level exposure multipliers while preserving the supplied cross-account dependence structure and evaluating each candidate through the canonical Phase 2 contractual payoff function.

## Engine

- `src/utils/contractAwareHedgeRatioEngine.ts`
- `tests/contractAwareHedgeRatioEngine.test.ts`

## Input model

Each account supplies:
- Its firm contract preset and account lifecycle state.
- A bounded ratio grid (`min`, `max`, `step`).
- Its account identifier.

Each scenario supplies a probability and a complete set of account P&L outcomes. Scenario probabilities must sum to one. The signed P&L already encodes direction: a positive ratio scales exposure magnitude but does not reverse long/short direction.

## Search and objectives

The engine exhaustively evaluates the Cartesian product of the discrete ratio grids. Each candidate is evaluated against every joint scenario, and every scaled account outcome is passed to Phase 2 `calculateContractualPayoff`.

Candidates are ranked lexicographically:
1. Maximize expected contractual trader payout (potential payout, not received cash).
2. Maximize expected combined gross P&L.
3. Minimize probability of negative combined gross P&L.
4. Minimize worst-case combined gross loss.
5. Stable lexical tie-break on the ratio vector.

This order makes the economic objective explicit while retaining downside metrics as tie-breakers and hard constraints. It is not a universal utility function; users should set risk constraints appropriate to their own mandate.

## Hard constraints

- Maximum probability of negative combined gross P&L.
- Maximum worst-case combined gross loss.
- Minimum expected contractual trader payout.
- Minimum probability of a positive contractual payout opportunity.
- Maximum exhaustive-search node count.

If no candidate meets the constraints, the result is `infeasible`. If the search-node limit is exceeded, the engine throws and makes no optimality claim.

## Outputs

- Selected ratio per account and associated firm.
- Expected combined gross P&L.
- Expected contractual trader payout.
- Probability of combined loss and worst-case combined loss.
- Payout-opportunity probability.
- Scenario-level combined P&L, contractual payout, and per-account Phase 2 results.
- Search-node and feasible-candidate counts.

## Modeling boundaries

- This is a discrete exhaustive grid search, not continuous optimization. The result is optimal only over the supplied grid and within the configured search limit.
- Ratios are non-negative exposure multipliers. To model opposing hedge directions, source scenario P&Ls must have the correct signs before scaling.
- All accounts in a candidate are evaluated on the same complete joint scenarios; marginal probabilities are not multiplied and dependence is not discarded.
- The Phase 2 engine remains the single source of truth for firm-specific contractual rules.
- Contractual payout is potential payout, not realized cash. Pending/approved states are not cash receipts.
- Account status is taken from the supplied scenario and is not dynamically recomputed from the ratio. Drawdown paths, intraday equity, daily-loss resets, and trailing high-water marks are not inferred from a single scenario P&L.
- No broker execution, instrument conversion, point-value calculation, fees, resets, subscriptions, FX, taxes, external capital, or cash settlement is modeled.
- No live orders are generated or executed.
- Results are conditional on the supplied contract records, account states, scenario matrix, and probability estimates; they are not forecasts or guarantees.

## Recommended integration

The next integration layer should map instrument-level hedge sizes and point values into account-level signed scenario P&L, then feed selected ratio vectors into portfolio survival, external-capital, and Pareto analysis. It should also model path-dependent equity/drawdown before claiming account-survival improvements.

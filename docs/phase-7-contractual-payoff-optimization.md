# Phase 7 — Contractual Payoff Optimization

## Objective

Select one firm/plan contract alternative for each configured account slot by evaluating the nonlinear contractual payoff of every alternative under the same complete joint portfolio scenarios. The optimizer exposes how profit buffers, payout limits, consistency, qualifying days, account lifecycle, and scenario payout status change contractual payout potential.

## Engine

- `src/utils/contractualPayoffOptimizationEngine.ts`
- `tests/contractualPayoffOptimizationEngine.test.ts`

The engine delegates every account/scenario calculation to Phase 2's `calculateContractualPayoff`. It does not recreate the underlying contractual rules or replace the canonical payout evaluator.

## Optimization process

1. Validate unique account slots, alternative identifiers, complete account-outcome coverage, scenario probabilities, and constraints.
2. Evaluate every contract alternative against each joint scenario using its supplied firm preset and account lifecycle state.
3. Calculate per-alternative diagnostics: expected contractual trader payout, positive-payout opportunity probability, evaluation pass probability, contract completeness probability, and warnings.
4. Enumerate one alternative per account slot.
5. Apply hard constraints for contract completeness, payout opportunity, minimum firm diversification, and maximum accounts per firm.
6. Select the best feasible assignment lexicographically.

## Objective priority

1. Maximize expected contractual trader payout.
2. Maximize probability of at least one positive contractual payout.
3. Maximize expected evaluation passes.
4. Maximize contract completeness probability.
5. Resolve remaining ties deterministically by selected alternative identifiers.

This is deliberately a lexicographic objective rather than an arbitrary weighted score. The output preserves the underlying metrics so later phases can apply portfolio-level risk and capital objectives without hiding trade-offs.

## Constraints

- Minimum probability of at least one positive contractual payout.
- Maximum probability of zero contractual payouts.
- Minimum probability that all selected contracts are complete for simulation.
- Minimum number of distinct firms.
- Maximum selected accounts per firm.
- Complete-contract requirement (enabled by default).
- Exhaustive-search node limit; exceeding it throws and makes no optimality claim.

## Outputs

- Selected contract alternative for every account slot.
- Expected gross scenario P&L and expected contractual trader payout.
- Payout-opportunity and zero-payout probabilities.
- Evaluation pass probabilities per account and expected evaluation pass count.
- Contract completeness probability and selected contract warnings.
- Per-scenario gross P&L, contractual payout, evaluation passes, completeness, and detailed Phase 2 account results.
- Diagnostics for every alternative, including options not selected.

## Important modeling boundaries

- The primary output is **contractual payout potential**, not realized or received cash. Pending/approved statuses remain contractual states as defined by Phase 2.
- Each account slot has one supplied account state per alternative. The optimizer does not infer or mutate account lifecycle transitions between scenarios.
- Every alternative is applied to the same caller-supplied account outcome for that slot and scenario. Scenario outcomes must already represent the intended cross-hedging and dependence structure.
- Contract fields, pricing, drawdown mechanics, and payout rules are consumed from supplied `PropFirmPreset` objects. No rule is inferred from marketing material or silently defaulted.
- Complete-contract validation is fail-closed by default. Set `requireCompleteContracts: false` only for explicitly exploratory sensitivity analysis; diagnostics continue to show incomplete scenarios and warnings.
- Evaluation-phase alternatives can be compared through evaluation pass probability even though evaluation does not produce a payout.
- The search is exhaustive over the discrete alternative set, not a continuous optimizer. It refuses an optimality claim when the configured node limit is exceeded.
- Broker hedge P&L, fees, resets, subscriptions, taxes, FX, realized cash, payout delays, external capital, and live execution are not calculated by this phase.
- The result is conditional on the supplied contractual records and joint scenario probabilities; it is not a forecast or guarantee.

## Integration path

Feed each selected allocation and its per-scenario account results into the portfolio survival, external capital, and Pareto analysis layers. The next integration step should unify the upstream scenario probabilities and shared account state so contract selection and cross-hedge portfolio risk are evaluated from one canonical scenario dataset.

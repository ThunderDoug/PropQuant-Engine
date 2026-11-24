# Phase 2 — Nonlinear Contractual Payoff Functions

## Objective

Transform Phase 1 joint gross account outcomes into firm-specific contractual economics. The same gross P&L can produce different outcomes depending on account lifecycle, profit buffer, qualifying days, consistency, withdrawal percentage, payout cap, minimum withdrawal, and profit split.

## Files

- `src/utils/contractualPayoffEngine.ts`: pure account-level and portfolio-level payoff functions.
- `tests/contractualPayoffEngine.test.ts`: automated test coverage.

## Funded payoff calculation

The engine delegates payout-rule evaluation to the existing `evaluatePayoutEligibility` function so existing contractual logic remains the single source of truth. The calculation considers:

1. Cumulative account profit after the scenario.
2. Required retained profit buffer.
3. Minimum profitable days and minimum daily profit.
4. Payout cycle length.
5. Consistency methodology and threshold.
6. Maximum withdrawal percentage.
7. Maximum payout amount.
8. Minimum withdrawal amount.
9. Profit split.
10. Post-payout retained balance and drawdown remaining.

The payout is nonlinear because contractual caps, buffers, thresholds, and eligibility gates make the trader's payout different from a constant multiple of gross P&L.

## Evaluation phases

Evaluation outcomes are not treated as withdrawals. The engine checks the applicable phase target, minimum trading days, and consistency rule, and reports whether the phase passed. The payout amount remains zero.

## Account and scenario gates

- Breached, restricted, or terminated accounts cannot produce a payout.
- Scenario payout statuses `not_eligible`, `blocked`, and `rejected` suppress the payout even if raw account economics otherwise qualify.
- `eligible`, `pending`, and `approved` statuses still require the contractual payout checks to pass.
- A pending or approved amount is a contractual amount only; it is not recorded as received cash.

## Portfolio aggregation

`evaluateJointScenarioContractualPayoffs` maps every Phase 1 account outcome to its own firm contract and account state, then aggregates gross P&L, potential trader payout, evaluation passes, and zero-payout accounts.

## Important boundaries

- This phase does not calculate broker hedge P&L, external operating expenses, FX, realized cash, or minimum external capital.
- Contract data warnings and completeness are carried into the result.
- Missing payout-rule fields continue to fail closed through the existing payout eligibility engine.
- The function is pure and does not mutate account or contract inputs.

## Validation

Tests cover capped/buffered/split payout behavior, breached-account suppression, scenario payout restrictions, pending payout treatment, evaluation progression, multi-account aggregation, and missing contract handling.

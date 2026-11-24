# Phase 10 — Path-Dependent Contractual Lifecycle Engine

## Objective

Advance from Phase 2's pure one-step payoff evaluator to a deterministic chronological replay that maintains drawdown, daily-loss, evaluation, funded, and payout-cycle state.

## Files

- `src/utils/contractualLifecycleEngine.ts`
- `tests/contractualLifecycleEngine.test.ts`

## Implemented

- Evaluation Phase 1 → Phase 2 → Funded transitions when the Phase 2 evaluator confirms targets, minimum days, and consistency.
- Static, trailing EOD, trailing intraday, and locked trailing drawdown.
- Balance/equity basis selection.
- Daily loss limits with caller-supplied session IDs and session-start baselines.
- Account breach as an absorbing state.
- Funded payout-cycle elapsed-day tracking.
- Explicit realized withdrawals, checked against the contractual payout opportunity and payout-cycle gate.
- Deterministic chronological replay and per-step audit records.

## Exact conventions

- Each scenario is one trading-day step.
- `dailyPnlUsd` is the net daily P&L. Include commissions and fees in this input if applicable.
- Intraday peak/adverse values are P&L excursions relative to that day's opening balance/equity.
- Trailing EOD uses the prior high-water mark and ratchets it at a non-breaching close.
- Trailing intraday tests the supplied adverse equity excursion against the floor derived from the larger of the stored high-water mark and supplied intraday peak.
- Locked trailing methods lock the floor at initial account balance once the high-water mark reaches initial balance + `lockOffsetUsd`.
- A new `sessionId` resets daily-loss baselines. The caller must derive IDs using the contract's `resetTime` and IANA `timezone`; this engine does not parse local session clocks.
- A realized payout is an explicit already-received amount. It reduces account balance/equity and resets the payout-cycle elapsed-day counter. Contractual payout opportunity is never automatically treated as cash.

## Fail-closed behavior and limitations

- Missing/invalid drawdown and daily-loss rules block simulation.
- Unknown daily-loss methodology is rejected.
- Scenario account-status failures are absorbing.
- Contract terms are read from the supplied versioned `PropFirmPreset`; contract changes require a separate replay segment/configuration.
- No tick-level path reconstruction, automatic timezone conversion, fee inference, subscription/reset billing, broker execution, hedge rebalancing, or stochastic scenario sampling is performed.
- Locked trailing interpretation follows the explicit lock-offset convention above; it must be verified against each firm's official contract before using that preset.
- This engine is a deterministic lifecycle component; it is not a guarantee of firm approval, withdrawal, or realized cash beyond explicitly supplied realized payout events.

## Validation status

Tests are included but must be run in the repository environment. No test, lint, typecheck, build, or CI success is claimed.

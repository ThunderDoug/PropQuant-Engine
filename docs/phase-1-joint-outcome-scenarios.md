# Phase 1 — Joint Outcome Scenario Expansion

## Goal

Generate complete portfolio-level outcomes across multiple prop firms and accounts. The engine samples a joint scenario, not separate account outcomes whose probabilities are multiplied under an unsupported independence assumption.

## Implementation

- Core engine: `src/utils/jointScenarioEngine.ts`
- Tests: `tests/jointScenarioEngine.test.ts`
- Scenario templates define the probability of a complete combination of account outcomes.
- Each account outcome records gross P&L, outcome class, account status, and payout status.
- `commonShockId` records a shared adverse or favorable event affecting multiple accounts.
- A seeded Mulberry32 generator supports deterministic simulation replay.
- Matrix validation rejects missing/unknown accounts, duplicate IDs, invalid states, non-finite P&L, negative probabilities, and probability totals that do not equal 1.

## Important modeling boundary

The probability assigned to each row is the probability of the **entire joint portfolio outcome**. Do not derive it by multiplying individual account probabilities unless independence is an explicitly justified assumption.

The engine intentionally stops before contractual payoff calculations, fees, withdrawals, and external capital. Those are downstream responsibilities.

## Example outcome matrix

| Scenario | Probability | Firm A | Firm B |
|---|---:|---|---|
| Win / Win | 25% | Win | Win |
| Win / Loss | 25% | Win | Loss |
| Loss / Win | 25% | Loss | Win |
| Common failure | 25% | Breached | Breached |

These values are illustrative test fixtures, not empirical probabilities.

## Acceptance coverage

- Complete multi-account matrix validation.
- Probability normalization.
- Shared-shock metadata.
- Deterministic replay with a fixed seed.
- Scenario and per-account outcome frequency summaries.
- Invalid input rejection.

## Remaining integration work

This phase adds a reusable simulation core. Wiring it into the React workspace and connecting actual account/firm selections should follow after reviewing the existing UI state model. No live trading or real-money execution is introduced.

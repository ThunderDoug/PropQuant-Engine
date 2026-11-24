# Phase 9 — Unified Multi-Firm Portfolio Simulation

## Objective

Provide one reproducible portfolio-level simulation that composes the Phase 1 joint scenario model, Phase 2 contractual payoff evaluator, Phase 3 survival concepts, and Phase 8 account-level hedge ratios.

## Implementation

- Engine: `src/utils/unifiedPortfolioSimulationEngine.ts`
- Tests: `tests/unifiedPortfolioSimulationEngine.test.ts`
- Each account binds a firm contract, contractual state, hedge ratio, loss limit, and explicit upfront cash commitment.
- Each path samples one complete joint portfolio scenario per period, preserving the supplied cross-account dependence.
- Account signed P&L is scaled by its non-negative hedge ratio and passed to the canonical Phase 2 contractual payoff evaluator.
- Account cumulative P&L and daily history are advanced; account loss limits and supplied breached/restricted/terminated states are absorbing.
- The cash ledger uses only explicit upfront commitments and per-scenario cash outflows / realized cash inflows.
- Seeded sample paths retain scenario IDs and terminal state for replay/audit.

## Outputs

- Portfolio, account, and firm survival probabilities.
- Expected gross P&L and peak contractual payout opportunity.
- Expected, P50, P95, and maximum external capital required.
- Ending cash balance distribution.
- Failure cause counts and optional reproducible sample paths.

## Critical accounting separation

Contractual payout eligibility is not cash. The engine reports the maximum observed contractual payout opportunity across each path and does not add it to cash. Only `realizedCashInflowUsd` counts as received money. This prevents pending, approved, or merely eligible payouts from artificially reducing capital requirements.

## Assumptions and limitations

- The result is conditional on user-supplied firm contracts, account states, scenario probabilities, hedge ratios, upfront commitments, and cash flows.
- Hedge ratios are non-negative multipliers; source scenario P&L signs encode hedge direction.
- Account loss limits use cumulative scenario P&L, not intraday equity, daily-loss resets, or trailing high-water-mark drawdown.
- Contractual phase transitions and payout-cycle resets are not inferred. The current Phase 2 evaluator is applied as a one-step evaluator while cumulative state is advanced.
- No broker order execution, instrument point-value conversion, automatic hedge rebalancing, or financing is implemented.
- Cash flows are not inferred from trading P&L or contractual payout. Missing entries are zero.
- The external-capital metric is the maximum cash deficit before hypothetical capital injections, not a recommendation or guaranteed funding amount.
- Monte Carlo intervals are not provided here; probabilities are conditional on the supplied model and are not forecasts or guarantees.

## Validation status

Tests are included but must be run in the repository environment. No test, lint, typecheck, build, or CI success is claimed by this change.

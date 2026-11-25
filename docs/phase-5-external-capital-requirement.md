# Phase 5 — Minimum External Capital Requirement

## Objective

Estimate the additional external liquidity required to keep the cross-hedged, multi-firm operation solvent throughout a modeled horizon. This is a path-dependent cash requirement, not a capital-allocation ranking and not a forecast of trading returns.

## Engine

- `src/utils/externalCapitalRequirementEngine.ts`
- `tests/externalCapitalRequirementEngine.test.ts`

The engine evaluates complete joint portfolio cash-flow paths. Each scenario carries one probability for the entire portfolio path; marginal account probabilities are not multiplied or assumed independent.

## Calculation

For scenario (s), let (F_{s,t}) be net operational cash flow in period (t), and let (C_0) be available opening cash.

- Cumulative cash flow: (S_{s,t} = \sum_{i=1}^{t} F_{s,i})
- Peak cumulative deficit: (D_s = \max(0, -\min_t S_{s,t}))
- Required starting capital: (K_s = D_s + R), where (R) is the required minimum liquidity reserve
- Additional external capital: (E_s = \max(0, K_s - C_0))

The recommended amount is the probability-weighted quantile of (E_s) at the configured confidence level. The tail mean is the probability-weighted average of the worst (1-q) funding-requirement tail, including fractional probability mass at the boundary.

## Outputs

- Expected, confidence-quantile, and worst-case external capital requirement.
- Probability opening capital is sufficient throughout the path.
- Probability of a funding shortfall.
- Optional external funding budget coverage probability and maximum funding gap.
- Per-scenario peak deficit, required starting capital, additional capital, minimum/ending cash, and period of peak deficit.

## Inputs and assumptions

- Caller supplies complete joint scenarios, normalized probabilities, and ordered period cash flows.
- Cash flows must represent cash actually available to operations. Unrealized P&L, payout eligibility, pending withdrawals, or approvals are not cash receipts unless converted into realized and available cash in the upstream model.
- All scenarios must cover the same number of strictly increasing periods.
- The reserve is an explicit policy input; the engine does not infer a firm's contractual buffer or a broker's margin rule.
- Values are nominal USD. FX, inflation, financing fees, taxes, payout delays, and intraperiod settlement timing must be modeled upstream or in later integration work.
- This is a deterministic scenario calculation, not Monte Carlo sampling. The result is conditional on supplied scenarios and probabilities.
- No live trading, money movement, or funding action is performed.

## Interpretation

A path may end with positive cash and still fail operationally if an earlier period breaches the minimum liquidity reserve. The engine therefore evaluates the minimum balance across the entire path, not only terminal cash.

A positive recommended external-capital amount means available opening capital is insufficient to meet the selected confidence level. It does not mean the amount is guaranteed to be sufficient outside the modeled scenario set.

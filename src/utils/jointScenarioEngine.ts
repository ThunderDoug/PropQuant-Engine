/**
 * Phase 1 — Joint outcome scenario engine.
 *
 * The matrix represents portfolio-level joint outcomes. Probabilities are
 * supplied for complete joint scenarios, so cross-account dependence is
 * explicit rather than incorrectly inferred by multiplying marginal odds.
 *
 * This module deliberately does not calculate contractual payoffs, fees,
 * withdrawals, or external capital requirements. Those belong to later phases.
 */

export type JointOutcomeType =
  | 'win'
  | 'loss'
  | 'partial_win'
  | 'partial_loss'
  | 'flat';

export type JointAccountStatus =
  | 'active'
  | 'breached'
  | 'restricted'
  | 'terminated';

export type JointPayoutStatus =
  | 'not_eligible'
  | 'eligible'
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'blocked';

export interface JointAccountDefinition {
  accountId: string;
  firmId: string;
}

export interface JointAccountOutcome {
  grossPnlUsd: number;
  outcomeType: JointOutcomeType;
  accountStatus: JointAccountStatus;
  payoutStatus: JointPayoutStatus;
}

export interface JointScenarioTemplate {
  scenarioId: string;
  probability: number;
  marketEvent: string;
  commonShockId?: string | null;
  outcomes: Record<string, JointAccountOutcome>;
}

export interface JointScenarioMatrixValidation {
  isValid: boolean;
  errors: string[];
  probabilityTotal: number;
}

export interface SampledJointScenario {
  scenarioId: string;
  marketEvent: string;
  commonShockId: string | null;
  outcomes: Record<string, JointAccountOutcome>;
}

export interface JointScenarioSimulationSummary {
  iterations: number;
  seedUsed: number;
  scenarioCounts: Record<string, number>;
  scenarioObservedProbability: Record<string, number>;
  accountOutcomeCounts: Record<string, Record<JointOutcomeType, number>>;
  accountStatusCounts: Record<string, Record<JointAccountStatus, number>>;
  payoutStatusCounts: Record<string, Record<JointPayoutStatus, number>>;
}

const OUTCOME_TYPES: JointOutcomeType[] = [
  'win',
  'loss',
  'partial_win',
  'partial_loss',
  'flat',
];
const ACCOUNT_STATUSES: JointAccountStatus[] = [
  'active',
  'breached',
  'restricted',
  'terminated',
];
const PAYOUT_STATUSES: JointPayoutStatus[] = [
  'not_eligible',
  'eligible',
  'pending',
  'approved',
  'rejected',
  'blocked',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateJointScenarioMatrix(
  accounts: JointAccountDefinition[],
  scenarios: JointScenarioTemplate[],
  tolerance = 1e-9
): JointScenarioMatrixValidation {
  const errors: string[] = [];
  const accountIds = new Set<string>();

  if (!Array.isArray(accounts) || accounts.length === 0) {
    errors.push('At least one account must be configured.');
  }

  for (const account of accounts ?? []) {
    if (!account.accountId?.trim()) {
      errors.push('Every account must have a non-empty accountId.');
      continue;
    }
    if (!account.firmId?.trim()) {
      errors.push(`Account "${account.accountId}" must have a non-empty firmId.`);
    }
    if (accountIds.has(account.accountId)) {
      errors.push(`Duplicate accountId: "${account.accountId}".`);
    }
    accountIds.add(account.accountId);
  }

  if (!Array.isArray(scenarios) || scenarios.length === 0) {
    errors.push('At least one joint scenario must be configured.');
  }

  const scenarioIds = new Set<string>();
  let probabilityTotal = 0;

  for (const scenario of scenarios ?? []) {
    if (!scenario.scenarioId?.trim()) {
      errors.push('Every scenario must have a non-empty scenarioId.');
    } else if (scenarioIds.has(scenario.scenarioId)) {
      errors.push(`Duplicate scenarioId: "${scenario.scenarioId}".`);
    }
    scenarioIds.add(scenario.scenarioId);

    if (!Number.isFinite(scenario.probability) || scenario.probability < 0) {
      errors.push(`Scenario "${scenario.scenarioId}" has an invalid probability.`);
    } else {
      probabilityTotal += scenario.probability;
    }

    if (!scenario.marketEvent?.trim()) {
      errors.push(`Scenario "${scenario.scenarioId}" must identify its marketEvent.`);
    }
    if (!isRecord(scenario.outcomes)) {
      errors.push(`Scenario "${scenario.scenarioId}" has invalid outcomes.`);
      continue;
    }

    for (const accountId of accountIds) {
      if (!(accountId in scenario.outcomes)) {
        errors.push(
          `Scenario "${scenario.scenarioId}" is missing account "${accountId}".`
        );
      }
    }

    for (const outcomeAccountId of Object.keys(scenario.outcomes)) {
      if (!accountIds.has(outcomeAccountId)) {
        errors.push(
          `Scenario "${scenario.scenarioId}" contains unknown account "${outcomeAccountId}".`
        );
        continue;
      }

      const outcome = scenario.outcomes[outcomeAccountId] as JointAccountOutcome;
      if (!isRecord(outcome)) {
        errors.push(
          `Scenario "${scenario.scenarioId}" has an invalid outcome for "${outcomeAccountId}".`
        );
        continue;
      }
      if (!Number.isFinite(outcome.grossPnlUsd)) {
        errors.push(
          `Scenario "${scenario.scenarioId}" has non-finite grossPnlUsd for "${outcomeAccountId}".`
        );
      }
      if (!OUTCOME_TYPES.includes(outcome.outcomeType)) {
        errors.push(
          `Scenario "${scenario.scenarioId}" has an invalid outcomeType for "${outcomeAccountId}".`
        );
      }
      if (!ACCOUNT_STATUSES.includes(outcome.accountStatus)) {
        errors.push(
          `Scenario "${scenario.scenarioId}" has an invalid accountStatus for "${outcomeAccountId}".`
        );
      }
      if (!PAYOUT_STATUSES.includes(outcome.payoutStatus)) {
        errors.push(
          `Scenario "${scenario.scenarioId}" has an invalid payoutStatus for "${outcomeAccountId}".`
        );
      }
    }
  }

  if (Math.abs(probabilityTotal - 1) > tolerance) {
    errors.push(
      `Joint scenario probabilities must sum to 1 (received ${probabilityTotal}).`
    );
  }

  return {
    isValid: errors.length === 0,
    errors,
    probabilityTotal,
  };
}

/** Samples one complete joint scenario using its portfolio-level probability. */
export function sampleJointScenario(
  scenarios: JointScenarioTemplate[],
  random: () => number = Math.random
): SampledJointScenario {
  if (!Array.isArray(scenarios) || scenarios.length === 0) {
    throw new Error('Cannot sample an empty joint scenario matrix.');
  }

  const draw = random();
  if (!Number.isFinite(draw) || draw < 0 || draw >= 1) {
    throw new Error('Random source must return a finite value in [0, 1).');
  }

  let cumulative = 0;
  for (const scenario of scenarios) {
    cumulative += scenario.probability;
    if (draw < cumulative) {
      return {
        scenarioId: scenario.scenarioId,
        marketEvent: scenario.marketEvent,
        commonShockId: scenario.commonShockId ?? null,
        outcomes: Object.fromEntries(
          Object.entries(scenario.outcomes).map(([id, outcome]) => [
            id,
            { ...outcome },
          ])
        ),
      };
    }
  }

  // Protects against floating-point accumulation at the upper boundary.
  const lastPositive = [...scenarios].reverse().find((item) => item.probability > 0);
  if (!lastPositive) {
    throw new Error('Joint scenario matrix has no positive-probability scenario.');
  }
  return {
    scenarioId: lastPositive.scenarioId,
    marketEvent: lastPositive.marketEvent,
    commonShockId: lastPositive.commonShockId ?? null,
    outcomes: Object.fromEntries(
      Object.entries(lastPositive.outcomes).map(([id, outcome]) => [
        id,
        { ...outcome },
      ])
    ),
  };
}

/** Mulberry32 PRNG; the returned seed is recorded for deterministic replay. */
export function createJointScenarioPrng(seedInput: number): {
  next: () => number;
  seed: number;
} {
  const seed = (Math.trunc(seedInput) >>> 0) || 1;
  let state = seed;
  const next = (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  return { next, seed };
}

export function runJointScenarioSimulation(
  accounts: JointAccountDefinition[],
  scenarios: JointScenarioTemplate[],
  iterations: number,
  seedInput: number
): JointScenarioSimulationSummary {
  if (!Number.isInteger(iterations) || iterations <= 0) {
    throw new Error('iterations must be a positive integer.');
  }

  const validation = validateJointScenarioMatrix(accounts, scenarios);
  if (!validation.isValid) {
    throw new Error(
      `Invalid joint scenario matrix: ${validation.errors.join(' ')}`
    );
  }

  const prng = createJointScenarioPrng(seedInput);
  const scenarioCounts: Record<string, number> = {};
  const accountOutcomeCounts: JointScenarioSimulationSummary['accountOutcomeCounts'] = {};
  const accountStatusCounts: JointScenarioSimulationSummary['accountStatusCounts'] = {};
  const payoutStatusCounts: JointScenarioSimulationSummary['payoutStatusCounts'] = {};

  for (const scenario of scenarios) scenarioCounts[scenario.scenarioId] = 0;
  for (const account of accounts) {
    accountOutcomeCounts[account.accountId] = Object.fromEntries(
      OUTCOME_TYPES.map((type) => [type, 0])
    ) as Record<JointOutcomeType, number>;
    accountStatusCounts[account.accountId] = Object.fromEntries(
      ACCOUNT_STATUSES.map((status) => [status, 0])
    ) as Record<JointAccountStatus, number>;
    payoutStatusCounts[account.accountId] = Object.fromEntries(
      PAYOUT_STATUSES.map((status) => [status, 0])
    ) as Record<JointPayoutStatus, number>;
  }

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const sampled = sampleJointScenario(scenarios, prng.next);
    scenarioCounts[sampled.scenarioId] += 1;

    for (const [accountId, outcome] of Object.entries(sampled.outcomes)) {
      accountOutcomeCounts[accountId][outcome.outcomeType] += 1;
      accountStatusCounts[accountId][outcome.accountStatus] += 1;
      payoutStatusCounts[accountId][outcome.payoutStatus] += 1;
    }
  }

  const scenarioObservedProbability = Object.fromEntries(
    Object.entries(scenarioCounts).map(([id, count]) => [id, count / iterations])
  );

  return {
    iterations,
    seedUsed: prng.seed,
    scenarioCounts,
    scenarioObservedProbability,
    accountOutcomeCounts,
    accountStatusCounts,
    payoutStatusCounts,
  };
}

/**
 * Phase 6 — Scenario dominance and Pareto frontier.
 *
 * Compares cross-hedging configurations across explicit, non-composite
 * objectives. Higher expected profit/survival/active capacity is better;
 * lower external capital/loss probability/CVaR/worst loss is better.
 */

export interface ParetoConfiguration {
  configurationId: string;
  externalCapitalRequiredUsd: number;
  expectedNetProfitUsd: number;
  portfolioSurvivalProbability: number;
  probabilityOfLoss: number;
  cvarLossUsd: number;
  worstCaseLossUsd: number;
  activeFirmCount: number;
  activeAccountCount: number;
}

export interface ParetoConstraints {
  maxExternalCapitalUsd?: number;
  minExpectedNetProfitUsd?: number;
  minPortfolioSurvivalProbability?: number;
  maxProbabilityOfLoss?: number;
  maxCvarLossUsd?: number;
  maxWorstCaseLossUsd?: number;
  minActiveFirmCount?: number;
  minActiveAccountCount?: number;
}

export interface ParetoOptions {
  /** Absolute tolerance in native objective units. Defaults to 1e-9. */
  tolerance?: number;
  constraints?: ParetoConstraints;
}

export interface ParetoConfigurationResult {
  configuration: ParetoConfiguration;
  feasible: boolean;
  violatedConstraints: string[];
  dominated: boolean;
  dominatedBy: string[];
}

export interface ParetoFrontierResult {
  configurationCount: number;
  feasibleConfigurationCount: number;
  infeasibleConfigurationCount: number;
  frontierCount: number;
  frontier: ParetoConfigurationResult[];
  dominated: ParetoConfigurationResult[];
  infeasible: ParetoConfigurationResult[];
  comparisons: number;
  objectives: Array<{
    name: keyof ParetoConfiguration;
    direction: 'minimize' | 'maximize';
  }>;
}

const OBJECTIVES: Array<{
  name: keyof ParetoConfiguration;
  direction: 'minimize' | 'maximize';
}> = [
  { name: 'externalCapitalRequiredUsd', direction: 'minimize' },
  { name: 'expectedNetProfitUsd', direction: 'maximize' },
  { name: 'portfolioSurvivalProbability', direction: 'maximize' },
  { name: 'probabilityOfLoss', direction: 'minimize' },
  { name: 'cvarLossUsd', direction: 'minimize' },
  { name: 'worstCaseLossUsd', direction: 'minimize' },
  { name: 'activeFirmCount', direction: 'maximize' },
  { name: 'activeAccountCount', direction: 'maximize' },
];

function validateConfiguration(config: ParetoConfiguration): string[] {
  const errors: string[] = [];
  if (!config.configurationId?.trim()) errors.push('configurationId is required.');
  const nonNegative = [
    'externalCapitalRequiredUsd', 'cvarLossUsd', 'worstCaseLossUsd',
  ] as const;
  for (const key of nonNegative) {
    if (!Number.isFinite(config[key]) || config[key] < 0) {
      errors.push(`${key} must be finite and non-negative.`);
    }
  }
  if (!Number.isFinite(config.expectedNetProfitUsd)) {
    errors.push('expectedNetProfitUsd must be finite.');
  }
  for (const key of ['portfolioSurvivalProbability', 'probabilityOfLoss'] as const) {
    if (!Number.isFinite(config[key]) || config[key] < 0 || config[key] > 1) {
      errors.push(`${key} must be between 0 and 1.`);
    }
  }
  for (const key of ['activeFirmCount', 'activeAccountCount'] as const) {
    if (!Number.isInteger(config[key]) || config[key] < 0) {
      errors.push(`${key} must be a non-negative integer.`);
    }
  }
  if (config.cvarLossUsd > config.worstCaseLossUsd + 1e-9) {
    errors.push('cvarLossUsd cannot exceed worstCaseLossUsd.');
  }
  return errors;
}

function violatedConstraints(
  config: ParetoConfiguration,
  constraints: ParetoConstraints
): string[] {
  const violations: string[] = [];
  if (constraints.maxExternalCapitalUsd !== undefined &&
      config.externalCapitalRequiredUsd > constraints.maxExternalCapitalUsd) {
    violations.push('maxExternalCapitalUsd');
  }
  if (constraints.minExpectedNetProfitUsd !== undefined &&
      config.expectedNetProfitUsd < constraints.minExpectedNetProfitUsd) {
    violations.push('minExpectedNetProfitUsd');
  }
  if (constraints.minPortfolioSurvivalProbability !== undefined &&
      config.portfolioSurvivalProbability < constraints.minPortfolioSurvivalProbability) {
    violations.push('minPortfolioSurvivalProbability');
  }
  if (constraints.maxProbabilityOfLoss !== undefined &&
      config.probabilityOfLoss > constraints.maxProbabilityOfLoss) {
    violations.push('maxProbabilityOfLoss');
  }
  if (constraints.maxCvarLossUsd !== undefined &&
      config.cvarLossUsd > constraints.maxCvarLossUsd) {
    violations.push('maxCvarLossUsd');
  }
  if (constraints.maxWorstCaseLossUsd !== undefined &&
      config.worstCaseLossUsd > constraints.maxWorstCaseLossUsd) {
    violations.push('maxWorstCaseLossUsd');
  }
  if (constraints.minActiveFirmCount !== undefined &&
      config.activeFirmCount < constraints.minActiveFirmCount) {
    violations.push('minActiveFirmCount');
  }
  if (constraints.minActiveAccountCount !== undefined &&
      config.activeAccountCount < constraints.minActiveAccountCount) {
    violations.push('minActiveAccountCount');
  }
  return violations;
}

function dominates(
  candidate: ParetoConfiguration,
  other: ParetoConfiguration,
  tolerance: number
): boolean {
  let strictlyBetter = false;
  for (const objective of OBJECTIVES) {
    const a = candidate[objective.name] as number;
    const b = other[objective.name] as number;
    if (objective.direction === 'minimize') {
      if (a > b + tolerance) return false;
      if (a < b - tolerance) strictlyBetter = true;
    } else {
      if (a < b - tolerance) return false;
      if (a > b + tolerance) strictlyBetter = true;
    }
  }
  return strictlyBetter;
}

/**
 * Returns the non-dominated feasible configurations.
 * No weighted score is calculated: trade-offs remain visible to the caller.
 */
export function calculateParetoFrontier(
  configurations: ParetoConfiguration[],
  options: ParetoOptions = {}
): ParetoFrontierResult {
  const tolerance = options.tolerance ?? 1e-9;
  if (!Array.isArray(configurations) || configurations.length === 0) {
    throw new Error('At least one configuration is required.');
  }
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new Error('tolerance must be finite and non-negative.');
  }

  const ids = new Set<string>();
  const errors: string[] = [];
  configurations.forEach((config) => {
    errors.push(...validateConfiguration(config).map((error) =>
      `Configuration "${config.configurationId}": ${error}`
    ));
    if (ids.has(config.configurationId)) {
      errors.push(`Duplicate configurationId "${config.configurationId}".`);
    }
    ids.add(config.configurationId);
  });
  if (errors.length) throw new Error(`Invalid Pareto input: ${errors.join(' ')}`);

  const constraints = options.constraints ?? {};
  const evaluated = configurations.map((configuration) => ({
    configuration,
    feasible: violatedConstraints(configuration, constraints).length === 0,
    violatedConstraints: violatedConstraints(configuration, constraints),
    dominated: false,
    dominatedBy: [] as string[],
  }));
  const feasible = evaluated.filter((item) => item.feasible);
  let comparisons = 0;

  for (const item of feasible) {
    for (const challenger of feasible) {
      if (item === challenger) continue;
      comparisons += 1;
      if (dominates(challenger.configuration, item.configuration, tolerance)) {
        item.dominatedBy.push(challenger.configuration.configurationId);
      }
    }
    item.dominated = item.dominatedBy.length > 0;
  }

  const toResult = (item: typeof evaluated[number]): ParetoConfigurationResult => ({
    configuration: item.configuration,
    feasible: item.feasible,
    violatedConstraints: item.violatedConstraints,
    dominated: item.dominated,
    dominatedBy: [...item.dominatedBy].sort(),
  });
  const frontier = feasible.filter((item) => !item.dominated).map(toResult);
  const dominated = feasible.filter((item) => item.dominated).map(toResult);
  const infeasible = evaluated.filter((item) => !item.feasible).map(toResult);

  return {
    configurationCount: configurations.length,
    feasibleConfigurationCount: feasible.length,
    infeasibleConfigurationCount: infeasible.length,
    frontierCount: frontier.length,
    frontier,
    dominated,
    infeasible,
    comparisons,
    objectives: OBJECTIVES,
  };
}

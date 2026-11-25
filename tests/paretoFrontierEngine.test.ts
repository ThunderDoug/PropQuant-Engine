import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateParetoFrontier,
  type ParetoConfiguration,
} from '../src/utils/paretoFrontierEngine.ts';

const configs: ParetoConfiguration[] = [
  { configurationId: 'balanced', externalCapitalRequiredUsd: 1000, expectedNetProfitUsd: 500, portfolioSurvivalProbability: 0.98, probabilityOfLoss: 0.08, cvarLossUsd: 400, worstCaseLossUsd: 900, activeFirmCount: 3, activeAccountCount: 6 },
  { configurationId: 'high-return', externalCapitalRequiredUsd: 1500, expectedNetProfitUsd: 800, portfolioSurvivalProbability: 0.96, probabilityOfLoss: 0.12, cvarLossUsd: 550, worstCaseLossUsd: 1200, activeFirmCount: 3, activeAccountCount: 6 },
  { configurationId: 'dominated', externalCapitalRequiredUsd: 1200, expectedNetProfitUsd: 400, portfolioSurvivalProbability: 0.94, probabilityOfLoss: 0.16, cvarLossUsd: 650, worstCaseLossUsd: 1400, activeFirmCount: 2, activeAccountCount: 4 },
  { configurationId: 'strictly-best', externalCapitalRequiredUsd: 800, expectedNetProfitUsd: 700, portfolioSurvivalProbability: 0.99, probabilityOfLoss: 0.04, cvarLossUsd: 300, worstCaseLossUsd: 700, activeFirmCount: 4, activeAccountCount: 8 },
];

test('identifies non-dominated configurations across all objectives', () => {
  const result = calculateParetoFrontier(configs);
  assert.deepEqual(result.frontier.map((item) => item.configuration.configurationId).sort(), ['high-return', 'strictly-best']);
  assert.deepEqual(result.dominated.map((item) => item.configuration.configurationId), ['balanced', 'dominated']);
  assert.deepEqual(result.dominated[0].dominatedBy, ['strictly-best']);
  assert.deepEqual(result.dominated[1].dominatedBy, ['balanced', 'strictly-best']);
  assert.equal(result.comparisons, 12);
});

test('keeps real trade-offs on the frontier instead of collapsing them to a score', () => {
  const result = calculateParetoFrontier(configs.slice(0, 2));
  assert.equal(result.frontierCount, 2);
  assert.equal(result.dominated.length, 0);
});

test('applies hard feasibility constraints before calculating the frontier', () => {
  const result = calculateParetoFrontier(configs, {
    constraints: { maxExternalCapitalUsd: 1200, minPortfolioSurvivalProbability: 0.95, maxProbabilityOfLoss: 0.1 },
  });
  assert.equal(result.feasibleConfigurationCount, 2);
  assert.equal(result.infeasibleConfigurationCount, 2);
  assert.deepEqual(result.frontier.map((item) => item.configuration.configurationId), ['strictly-best']);
  assert.deepEqual(result.infeasible[0].violatedConstraints, ['maxExternalCapitalUsd', 'maxProbabilityOfLoss']);
});

test('treats equivalent objective vectors as non-dominating', () => {
  const copy = { ...configs[0], configurationId: 'same-vector' };
  const result = calculateParetoFrontier([configs[0], copy]);
  assert.equal(result.frontierCount, 2);
  assert.equal(result.dominated.length, 0);
});

test('respects objective tolerance', () => {
  const near = { ...configs[0], configurationId: 'near', expectedNetProfitUsd: configs[0].expectedNetProfitUsd + 0.0001 };
  const result = calculateParetoFrontier([configs[0], near], { tolerance: 0.001 });
  assert.equal(result.frontierCount, 2);
});

test('rejects duplicate identifiers, invalid probabilities, and inconsistent loss metrics', () => {
  assert.throws(() => calculateParetoFrontier([configs[0], configs[0]]), /Duplicate configurationId/);
  assert.throws(() => calculateParetoFrontier([{ ...configs[0], probabilityOfLoss: 1.2 }]), /probabilityOfLoss must be between 0 and 1/);
  assert.throws(() => calculateParetoFrontier([{ ...configs[0], cvarLossUsd: 1000 }]), /cvarLossUsd cannot exceed worstCaseLossUsd/);
});

test('rejects empty input and invalid tolerance', () => {
  assert.throws(() => calculateParetoFrontier([]), /At least one configuration/);
  assert.throws(() => calculateParetoFrontier(configs, { tolerance: -1 }), /tolerance/);
});

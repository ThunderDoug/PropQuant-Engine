import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_PROP_FIRMS_2026 } from '../src/data/propFirms2026.ts';
import {
  normalizePropFirmPreset,
  validateFirmContract,
} from '../src/utils/contractual.ts';

describe('Contractual Architecture & Dataset Integrity', () => {
  it('ensures every catalog preset has unique IDs and structured Eval/Funded rules', () => {
    assert.ok(DEFAULT_PROP_FIRMS_2026.length >= 30);
    const ids = new Set<string>();
    for (const firm of DEFAULT_PROP_FIRMS_2026) {
      assert.equal(ids.has(firm.id), false, `Duplicate preset ID: ${firm.id}`);
      ids.add(firm.id);
      assert.ok(firm.pricing);
      assert.ok(firm.evaluationRules);
      assert.ok(firm.fundedRules);
      assert.equal(firm.pricing.currency, 'USD');
      assert.ok(firm.contractVersion.length > 0);
    }
  });

  it('preserves explicit missing contractual data instead of silently zeroing it out', () => {
    const missingFeeFirms = DEFAULT_PROP_FIRMS_2026.filter(
      (f) => f.pricing.evaluationFee.status === 'missing'
    );
    assert.ok(missingFeeFirms.length > 0);

    for (const firm of missingFeeFirms) {
      assert.equal(firm.pricing.evaluationFee.value, null);
      const validation = validateFirmContract(firm);
      assert.equal(validation.isCompleteForSimulation, false);
      assert.ok(
        validation.missingCriticalFields.some((msg) => msg.includes('Taxa de Avaliação'))
      );
    }
  });

  it('validates complete verified firms as ready for simulation', () => {
    const lucid = DEFAULT_PROP_FIRMS_2026.find((f) => f.id === 'lucid-50k-flex');
    assert.ok(lucid);
    const validation = validateFirmContract(lucid);
    assert.equal(validation.isCompleteForSimulation, true);
    assert.equal(validation.missingCriticalFields.length, 0);
  });

  it('safely migrates legacy flat v1 localStorage presets without losing custom user parameters', () => {
    const legacy = {
      id: 'custom-legacy-1',
      name: 'Mesa Legada Custom',
      model: '$25K Static',
      category: 'CFD / Forex' as const,
      accountSize: 25000,
      phase1TargetUsd: 2000,
      phase2TargetUsd: 1250,
      dailyLossLimitUsd: 1000,
      maxDrawdownUsd: 2500,
      drawdownType: 'Estático' as const,
      minTradingDays: 3,
      profitSplitPct: 85,
      consistencyRulePct: 30,
      evaluationFeeUsd: 179,
      refundOnFirstPayout: true,
      viability: 'Ideal' as const,
      rulesSummary: 'Preset legado criado pelo usuário',
      isCustom: true,
    };

    const migrated = normalizePropFirmPreset(legacy);
    assert.equal(migrated.id, 'custom-legacy-1');
    assert.equal(migrated.evaluationType, '2-Step');
    assert.equal(migrated.verificationStatus, 'user_assumed');
    assert.equal(migrated.pricing.evaluationFee.value, 179);
    assert.equal(migrated.evaluationRules.phase1TargetUsd.value, 2000);
    assert.equal(migrated.evaluationRules.phase2TargetUsd.value, 1250);
    assert.equal(migrated.evaluationRules.consistency.pct.value, 30);
    assert.equal(migrated.fundedRules.profitSplitPct.value, 85);
    assert.equal(migrated.fundedRules.refundOnFirstPayout.value, true);
    // Missing legacy fields like reset fee or max payout remain explicitly marked 'missing'
    assert.equal(migrated.pricing.resetFee.status, 'missing');
    assert.equal(migrated.fundedRules.maxPayoutUsd.status, 'missing');
  });
});

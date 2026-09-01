import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createFeatureFlagService,
} from '../dist/feature-flags.js';

test('creates and enables feature flags', () => {
  const flags = createFeatureFlagService();

  flags.createFlag('sma-strategy', true);
  const enabled = flags.isEnabled('sma-strategy');

  assert.ok(enabled);
});

test('disables feature flags', () => {
  const flags = createFeatureFlagService();

  flags.createFlag('rsi-strategy', true);
  flags.disable('rsi-strategy');

  const enabled = flags.isEnabled('rsi-strategy');
  assert.ok(!enabled);
});

test('supports account-level feature control', () => {
  const flags = createFeatureFlagService();

  flags.createFlag('live-trading', true);
  flags.disableForAccount('acct-1', 'live-trading');

  const globalEnabled = flags.isEnabled('live-trading');
  const accountEnabled = flags.isEnabledForAccount('acct-1', 'live-trading');

  assert.ok(globalEnabled);
  assert.ok(!accountEnabled);
});

test('supports account-type-based feature control', () => {
  const flags = createFeatureFlagService();

  flags.createFlag('premium-indicators', true);
  flags.restrictByAccountType('premium-indicators', ['premium', 'vip']);

  const free = flags.isEnabledForAccountType('free', 'premium-indicators');
  const premium = flags.isEnabledForAccountType('premium', 'premium-indicators');

  assert.ok(!free);
  assert.ok(premium);
});

test('enables gradual rollout with percentage control', () => {
  const flags = createFeatureFlagService();

  flags.createFlag('macd-strategy', true);
  flags.setRolloutPercentage('macd-strategy', 50);

  let enabledCount = 0;
  for (let i = 0; i < 100; i++) {
    if (flags.isEnabledForUser(`user-${i}`, 'macd-strategy')) {
      enabledCount++;
    }
  }

  // Roughly 50% should be enabled (allow some variance)
  assert.ok(enabledCount >= 30 && enabledCount <= 70);
});

test('audits feature flag changes', () => {
  const flags = createFeatureFlagService();

  flags.createFlag('test-feature', true);
  flags.disable('test-feature');
  flags.enable('test-feature');

  const audit = flags.getAuditLog('test-feature');
  assert.ok(audit.length >= 2);
});

test('retrieves all flags with their current state', () => {
  const flags = createFeatureFlagService();

  flags.createFlag('feature-1', true);
  flags.createFlag('feature-2', false);

  const allFlags = flags.getAllFlags();
  assert.equal(allFlags.length, 2);
});

test('provides feature flag statistics for decision making', () => {
  const flags = createFeatureFlagService();

  flags.createFlag('new-feature', true);
  flags.setRolloutPercentage('new-feature', 25);

  const stats = flags.getFeatureStats('new-feature');
  assert.equal(stats.targetRolloutPercent, 25);
  assert.ok(stats.enabled);
});

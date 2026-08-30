import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createCapitalProtectionEngine,
  evaluateCapitalProtection,
} from '../dist/capital-protection.js';

test('locks profit when protected-profit threshold is reached', () => {
  const engine = createCapitalProtectionEngine({
    initialBalance: 1000,
    maxExposure: 250,
    protectedProfitThreshold: 80,
    maxDrawdown: 150,
  });

  const next = engine.applyTrade({
    realizedProfit: 90,
    unrealizedProfit: 0,
    exposure: 120,
    balance: 1090,
    equity: 1090,
  });

  assert.equal(next.mode, 'CONTINUE_LOCK');
  assert.equal(next.protectedProfit, 80);
  assert.equal(next.blocked, false);
});

test('blocks further exposure when loss exceeds drawdown limit', () => {
  const engine = createCapitalProtectionEngine({
    initialBalance: 1000,
    maxExposure: 250,
    protectedProfitThreshold: 80,
    maxDrawdown: 150,
  });

  const next = engine.applyTrade({
    realizedProfit: -200,
    unrealizedProfit: -40,
    exposure: 120,
    balance: 760,
    equity: 600,
  });

  assert.equal(next.blocked, true);
  assert.match(next.reason || '', /drawdown/i);
});

test('central engine exposes the same decision logic used by the risk gate', () => {
  const decision = evaluateCapitalProtection({
    realizedProfit: 50,
    unrealizedProfit: 30,
    exposure: 180,
    balance: 1050,
    equity: 1080,
    protectedProfit: 0,
    maxExposure: 250,
    protectedProfitThreshold: 80,
    maxDrawdown: 150,
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.mode, 'STOP_RESET');
});

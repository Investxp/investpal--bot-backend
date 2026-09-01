import assert from 'node:assert/strict';
import test from 'node:test';
import { createStrategyConfigDSL } from '../dist/strategy-config.js';

test('creates and validates a declarative strategy config', () => {
  const dsl = createStrategyConfigDSL();

  const cfg = dsl.compile({
    strategyId: 'strat-1',
    name: 'Breakout',
    market: 'R_100',
    entry: {
      type: 'sma_cross',
      params: { period1: 5, period2: 20 },
      action: 'BUY',
    },
    exit: {
      type: 'rsi',
      params: { threshold: 70 },
      action: 'SELL',
    },
    risk: {
      maxStake: 10,
      maxLossPerTrade: 5,
      stopLoss: 2,
    },
  });

  assert.equal(cfg.strategyId, 'strat-1');
  assert.equal(cfg.validation.valid, true);
  assert.equal(cfg.risk.maxStake, 10);
});

test('rejects invalid configuration with missing required fields', () => {
  const dsl = createStrategyConfigDSL();

  const result = dsl.compile({
    name: 'Broken',
    market: 'R_100',
  });

  assert.equal(result.validation.valid, false);
  assert.ok(Array.isArray(result.validation.errors));
  assert.ok(result.validation.errors.length > 0);
});

test('supports config revision history and rollback metadata', () => {
  const dsl = createStrategyConfigDSL();

  const v1 = dsl.compile({
    strategyId: 'strat-2',
    name: 'Mean Revert',
    market: 'EURUSD',
    entry: { type: 'rsi', params: { threshold: 70 }, action: 'BUY' },
    exit: { type: 'rsi', params: { threshold: 30 }, action: 'SELL' },
    risk: { maxStake: 8, maxLossPerTrade: 4, stopLoss: 2 },
  });

  const v2 = dsl.compile({
    strategyId: 'strat-2',
    name: 'Mean Revert',
    market: 'EURUSD',
    entry: { type: 'rsi', params: { threshold: 65 }, action: 'BUY' },
    exit: { type: 'rsi', params: { threshold: 35 }, action: 'SELL' },
    risk: { maxStake: 9, maxLossPerTrade: 4, stopLoss: 2 },
  });

  const history = dsl.getVersionHistory('strat-2');
  assert.equal(history.length, 2);
  assert.equal(v2.version, '2');
  assert.equal(v1.strategyId, 'strat-2');
});

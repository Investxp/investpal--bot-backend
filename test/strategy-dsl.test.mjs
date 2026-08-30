import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createStrategyDSL,
} from '../dist/strategy-dsl.js';

test('creates a strategy from DSL configuration', () => {
  const dsl = createStrategyDSL();

  const config = {
    strategyId: 'strat-123',
    name: 'SMA Crossover',
    description: 'Buy when fast SMA crosses above slow SMA',
    symbol: 'R_100',
    timeframe: '5m',
    rules: [
      {
        ruleId: 'rule-1',
        type: 'sma_cross',
        params: { period1: 5, period2: 20 },
        action: 'BUY',
      },
    ],
    stake: 10,
    maxExposure: 250,
    maxDrawdown: 150,
  };

  const strategy = dsl.createStrategy(config);
  assert.equal(strategy.strategyId, 'strat-123');
  assert.equal(strategy.name, 'SMA Crossover');
  assert.equal(strategy.rules.length, 1);
});

test('validates strategy configuration for logical consistency', () => {
  const dsl = createStrategyDSL();

  const validConfig = {
    strategyId: 'strat-valid',
    name: 'Valid Strategy',
    symbol: 'R_100',
    rules: [],
    stake: 10,
  };

  const valid = dsl.validate(validConfig);
  assert.ok(valid.isValid);
  assert.equal(valid.errors.length, 0);
});

test('rejects invalid strategy configurations', () => {
  const dsl = createStrategyDSL();

  const invalidConfig = {
    strategyId: '',
    name: 'Invalid Strategy',
    symbol: 'INVALID_SYMBOL',
    rules: [],
    stake: -10, // negative stake
  };

  const result = dsl.validate(invalidConfig);
  assert.ok(!result.isValid);
  assert.ok(result.errors.length > 0);
});

test('deploys a strategy without code changes', () => {
  const dsl = createStrategyDSL();

  const config = {
    strategyId: 'strat-deploy-1',
    name: 'Deploy Test',
    symbol: 'EURUSD',
    rules: [
      {
        ruleId: 'rule-buy',
        type: 'rsi',
        params: { period: 14, threshold: 30 },
        action: 'BUY',
      },
    ],
    stake: 5,
  };

  const deployed = dsl.deployStrategy(config);
  assert.equal(deployed.strategyId, 'strat-deploy-1');
  assert.ok(deployed.deployedAt);
  assert.equal(deployed.status, 'active');
});

test('updates strategy configuration and preserves version history', () => {
  const dsl = createStrategyDSL();

  const config1 = {
    strategyId: 'strat-versioned',
    name: 'Versioned Strategy',
    symbol: 'R_50',
    rules: [],
    stake: 5,
  };

  dsl.deployStrategy(config1);

  const config2 = {
    strategyId: 'strat-versioned',
    name: 'Versioned Strategy Updated',
    symbol: 'R_50',
    rules: [
      {
        ruleId: 'rule-1',
        type: 'sma_cross',
        params: { period1: 3, period2: 10 },
        action: 'BUY',
      },
    ],
    stake: 15,
  };

  dsl.deployStrategy(config2);

  const versions = dsl.getVersionHistory('strat-versioned');
  assert.ok(versions.length >= 2);
});

test('retrieves deployed strategies and their current configuration', () => {
  const dsl = createStrategyDSL();

  const config = {
    strategyId: 'strat-retrieve',
    name: 'Retrieve Test',
    symbol: 'EURUSD',
    rules: [],
    stake: 10,
  };

  dsl.deployStrategy(config);

  const strategy = dsl.getStrategy('strat-retrieve');
  assert.ok(strategy);
  assert.equal(strategy.name, 'Retrieve Test');
  assert.equal(strategy.stake, 10);
});

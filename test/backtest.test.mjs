import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBacktestEngine,
} from '../dist/backtest.js';

test('runs backtest on historical price data with proper output', () => {
  const backtest = createBacktestEngine();

  const candles = [
    { symbol: 'R_100', open: 100, high: 105, low: 99, close: 103, volume: 1000 },
    { symbol: 'R_100', open: 103, high: 108, low: 102, close: 107, volume: 1200 },
    { symbol: 'R_100', open: 107, high: 110, low: 105, close: 106, volume: 900 },
  ];

  const result = backtest.run({
    symbol: 'R_100',
    candles,
    strategyId: 'strat-123',
    stake: 10,
  });

  assert.ok(result.backtestId);
  assert.equal(result.symbol, 'R_100');
  assert.equal(result.trades.length, 0);
  assert.equal(result.totalStake, 10);
});

test('tracks model versions with semantic versioning', () => {
  const backtest = createBacktestEngine();

  const v1 = backtest.registerModel({
    modelId: 'model-1',
    version: '1.0.0',
    type: 'lstm',
    hyperparameters: { layers: 2, epochs: 10 },
  });

  assert.equal(v1.version, '1.0.0');
  assert.ok(v1.registeredAt);

  const v2 = backtest.registerModel({
    modelId: 'model-1',
    version: '1.1.0',
    type: 'lstm',
    hyperparameters: { layers: 2, epochs: 15 },
  });

  assert.equal(v2.version, '1.1.0');
  assert.ok(v1.registeredAt <= v2.registeredAt);
});

test('validates prediction accuracy and tracks drift metrics', () => {
  const backtest = createBacktestEngine();

  const predictions = [
    { predicted: 'up', actual: 'up', confidence: 0.92 },
    { predicted: 'up', actual: 'down', confidence: 0.88 },
    { predicted: 'down', actual: 'down', confidence: 0.85 },
    { predicted: 'up', actual: 'up', confidence: 0.91 },
  ];

  const accuracy = backtest.validatePredictions({
    modelId: 'model-1',
    version: '1.0.0',
    predictions,
  });

  assert.equal(accuracy.totalPredictions, 4);
  assert.equal(accuracy.correct, 3);
  assert.equal(accuracy.accuracy, 0.75);
  assert.ok(accuracy.avgConfidence >= 0.8 && accuracy.avgConfidence <= 1);
});

test('detects model prediction drift and alerts', () => {
  const backtest = createBacktestEngine({ driftThreshold: 0.1 });

  const baseline = backtest.validatePredictions({
    modelId: 'model-1',
    version: '1.0.0',
    predictions: [
      { predicted: 'up', actual: 'up', confidence: 0.95 },
      { predicted: 'up', actual: 'up', confidence: 0.94 },
      { predicted: 'down', actual: 'down', confidence: 0.93 },
    ],
  });

  const driftedResult = backtest.validatePredictions({
    modelId: 'model-1',
    version: '1.0.1',
    predictions: [
      { predicted: 'up', actual: 'down', confidence: 0.80 },
      { predicted: 'down', actual: 'up', confidence: 0.75 },
      { predicted: 'up', actual: 'down', confidence: 0.78 },
    ],
  });

  assert.ok(!baseline.hasDrift);
  assert.ok(driftedResult.hasDrift);
  assert.ok(driftedResult.driftReason?.includes('accuracy'));
});

test('ensures backtest reproducibility with seeded candles', () => {
  const backtest1 = createBacktestEngine();
  const backtest2 = createBacktestEngine();

  const candles = [
    { symbol: 'EURUSD', open: 1.08, high: 1.10, low: 1.07, close: 1.09, volume: 500 },
    { symbol: 'EURUSD', open: 1.09, high: 1.11, low: 1.08, close: 1.10, volume: 600 },
  ];

  const result1 = backtest1.run({ symbol: 'EURUSD', candles, strategyId: 'strat-1', stake: 20 });
  const result2 = backtest2.run({ symbol: 'EURUSD', candles, strategyId: 'strat-1', stake: 20 });

  assert.equal(result1.symbol, result2.symbol);
  assert.equal(result1.totalStake, result2.totalStake);
  assert.deepEqual(result1.trades, result2.trades);
});

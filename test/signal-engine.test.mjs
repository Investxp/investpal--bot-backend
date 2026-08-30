import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateSMA,
  calculateEMA,
  calculateRSI,
  calculateMACD,
  calculateBollingerBands,
  createSignalEngine,
} from '../dist/signal-engine.js';

test('calculates simple moving average (SMA) correctly', () => {
  const prices = [100, 102, 101, 103, 105, 104, 106, 108];
  const sma5 = calculateSMA(prices, 5);

  assert.ok(sma5 > 0);
  assert.ok(Math.abs(sma5 - 105.2) < 0.01); // (103 + 105 + 104 + 106 + 108) / 5 = 105.2
});

test('calculates exponential moving average (EMA) correctly', () => {
  const prices = [100, 102, 101, 103, 105, 104, 106, 108];
  const ema5 = calculateEMA(prices, 5);

  assert.ok(ema5 > 0);
  assert.ok(ema5 !== calculateSMA(prices, 5)); // EMA should differ from SMA
});

test('calculates RSI within 0-100 range', () => {
  const prices = [100, 102, 101, 103, 105, 104, 106, 108, 107, 109, 111, 110];
  const rsi = calculateRSI(prices, 14);

  assert.ok(rsi >= 0 && rsi <= 100);
});

test('calculates MACD line and signal line correctly', () => {
  const prices = [100, 102, 101, 103, 105, 104, 106, 108, 107, 109, 111, 110, 112, 114];
  const macd = calculateMACD(prices);

  assert.ok(macd.macdLine !== undefined);
  assert.ok(macd.signalLine !== undefined);
  assert.ok(macd.histogram !== undefined);
});

test('calculates Bollinger Bands with correct structure', () => {
  const prices = [100, 102, 101, 103, 105, 104, 106, 108, 107, 109];
  const bb = calculateBollingerBands(prices, 5, 2);

  assert.ok(bb.upperBand > 0);
  assert.ok(bb.middleBand > 0);
  assert.ok(bb.lowerBand > 0);
  assert.ok(bb.upperBand > bb.middleBand);
  assert.ok(bb.middleBand > bb.lowerBand);
});

test('generates buy/sell signals from indicator rules', () => {
  const engine = createSignalEngine();

  const ticks = [
    { price: 100, epoch: 1000 },
    { price: 101, epoch: 1001 },
    { price: 102, epoch: 1002 },
    { price: 103, epoch: 1003 },
    { price: 104, epoch: 1004 },
    { price: 105, epoch: 1005 },
  ];

  const rule = {
    ruleId: 'rule-1',
    type: 'sma_cross',
    params: { period1: 2, period2: 4 },
    action: 'BUY',
  };

  engine.addRule(rule);
  const signals = engine.evaluateSignals(ticks);

  assert.ok(Array.isArray(signals));
});

test('handles insufficient data gracefully', () => {
  const engine = createSignalEngine();

  const shortTicks = [
    { price: 100, epoch: 1000 },
    { price: 101, epoch: 1001 },
  ];

  const rule = {
    ruleId: 'rule-1',
    type: 'sma_cross',
    params: { period1: 5, period2: 10 },
    action: 'BUY',
  };

  engine.addRule(rule);
  const signals = engine.evaluateSignals(shortTicks);

  assert.deepEqual(signals, []);
});

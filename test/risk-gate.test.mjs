import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateTradeConfig } from '../dist/risk-gate.js';
import { PaperExecutionAdapter } from '../dist/paper-execution.js';
import { validateSignal } from '../dist/strategy-contract.js';

const validConfig = {
  platform: 'deriv',
  mode: 'rise-fall',
  symbol: 'R_100',
  baseStake: 1,
  duration: 5,
  durationUnit: 't',
  martingaleMultiplier: 2,
  takeProfit: 0,
  stopLoss: 0,
  selectedDigit: [],
  growthRate: 0,
  isHedgeMode: false,
  isAlternateMode: false,
  alternateFrequency: 0,
};

test('approves and normalizes a valid configuration', () => {
  const decision = evaluateTradeConfig(validConfig);
  assert.equal(decision.approved, true);
  assert.equal(decision.normalizedConfig.symbol, 'R_100');
  assert.equal(decision.normalizedConfig.maxStake, 25);
});

test('blocks unsafe stake and duration values', () => {
  const decision = evaluateTradeConfig({ ...validConfig, baseStake: 0, duration: 0 });
  assert.equal(decision.approved, false);
  assert.match(decision.reasons.join(' '), /Base stake|Duration/);
});

test('blocks an over-sized recovery sequence', () => {
  const decision = evaluateTradeConfig({ ...validConfig, martingaleMultiplier: 30 });
  assert.equal(decision.approved, false);
  assert.match(decision.reasons.join(' '), /multiplier/);
});

test('blocks an unknown execution mode', () => {
  const decision = evaluateTradeConfig({ ...validConfig, executionMode: 'shadow' });
  assert.equal(decision.approved, false);
  assert.match(decision.reasons.join(' '), /execution mode/i);
});

test('validates strategy signal confidence and risk bounds', () => {
  assert.doesNotThrow(() => validateSignal({ direction: 'RISE', confidence: 0.82, riskScore: 42, generatedAt: new Date().toISOString() }));
  assert.throws(() => validateSignal({ direction: 'RISE', confidence: 1.2, riskScore: 42, generatedAt: new Date().toISOString() }), /confidence/);
});

test('paper adapter creates and settles simulated contracts only in memory', () => {
  const adapter = new PaperExecutionAdapter();
  const created = adapter.place('execution-1', 'R_100', 'CALL', 2);
  assert.equal(created.status, 'open');
  const settled = adapter.settle(created.contractId, true, 3.5);
  assert.equal(settled.status, 'won');
  assert.equal(settled.profit, 1.5);
  assert.equal(adapter.get(created.contractId).profit, 1.5);
});

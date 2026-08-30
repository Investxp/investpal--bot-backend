import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createAnalyticsEngine,
} from '../dist/analytics.js';

test('computes KPI metrics from trade journal records', () => {
  const analytics = createAnalyticsEngine();

  analytics.recordTrade({
    accountId: 'acct-1',
    symbol: 'R_100',
    stake: 10,
    profit: 5,
    result: 'win',
    duration: 60,
  });

  analytics.recordTrade({
    accountId: 'acct-1',
    symbol: 'R_100',
    stake: 10,
    profit: -10,
    result: 'loss',
    duration: 120,
  });

  const kpis = analytics.getKPIs('acct-1');
  assert.equal(kpis.totalTrades, 2);
  assert.equal(kpis.wins, 1);
  assert.equal(kpis.losses, 1);
  assert.equal(kpis.winRate, 0.5);
  assert.equal(kpis.totalProfit, -5);
  assert.equal(kpis.avgStake, 10);
});

test('tracks drawdown and max drawdown metrics', () => {
  const analytics = createAnalyticsEngine({ initialBalance: 1000 });

  analytics.recordTrade({
    accountId: 'acct-2',
    symbol: 'EURUSD',
    stake: 50,
    profit: 100,
    result: 'win',
    duration: 60,
  });

  analytics.recordTrade({
    accountId: 'acct-2',
    symbol: 'EURUSD',
    stake: 50,
    profit: -300,
    result: 'loss',
    duration: 60,
  });

  const kpis = analytics.getKPIs('acct-2');
  assert.ok(kpis.drawdown !== undefined);
  assert.ok(kpis.maxDrawdown !== undefined);
});

test('isolates analytics per account and prevents cross-account leakage', () => {
  const analytics = createAnalyticsEngine();

  analytics.recordTrade({ accountId: 'acct-a', symbol: 'R_100', stake: 5, profit: 10, result: 'win', duration: 60 });
  analytics.recordTrade({ accountId: 'acct-b', symbol: 'R_100', stake: 10, profit: -20, result: 'loss', duration: 60 });

  const kpisA = analytics.getKPIs('acct-a');
  const kpisB = analytics.getKPIs('acct-b');

  assert.equal(kpisA.totalTrades, 1);
  assert.equal(kpisB.totalTrades, 1);
  assert.equal(kpisA.totalProfit, 10);
  assert.equal(kpisB.totalProfit, -20);
});

test('exports CSV reports with proper formatting', () => {
  const analytics = createAnalyticsEngine();

  analytics.recordTrade({ accountId: 'acct-1', symbol: 'R_100', stake: 10, profit: 5, result: 'win', duration: 60 });
  analytics.recordTrade({ accountId: 'acct-1', symbol: 'R_50', stake: 5, profit: -2, result: 'loss', duration: 120 });

  const csv = analytics.exportTradeHistoryCSV('acct-1');
  assert.ok(csv.includes('R_100'));
  assert.ok(csv.includes('R_50'));
  assert.ok(csv.includes('10'));
  assert.ok(csv.includes('5'));
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createReconciliationEngine,
} from '../dist/reconciliation.js';

test('reconciles account balance with broker records', () => {
  const reconciler = createReconciliationEngine();

  const localState = { balance: 1050, equity: 1050, exposure: 100 };
  const brokerState = { balance: 1050, equity: 1050, positions: [] };

  const result = reconciler.reconcile('acct-1', localState, brokerState);
  assert.ok(result.isMatched);
  assert.equal(result.discrepancies.length, 0);
});

test('detects balance mismatches between local and broker', () => {
  const reconciler = createReconciliationEngine();

  const localState = { balance: 1050, equity: 1050, exposure: 100 };
  const brokerState = { balance: 1100, equity: 1100, positions: [] };

  const result = reconciler.reconcile('acct-2', localState, brokerState);
  assert.ok(!result.isMatched);
  assert.ok(result.discrepancies.length > 0);
});

test('flags untracked broker positions', () => {
  const reconciler = createReconciliationEngine();

  const localState = { balance: 1000, equity: 1000, exposure: 0, positions: [] };
  const brokerState = {
    balance: 1000,
    equity: 950,
    positions: [{ symbol: 'R_100', stake: 50, side: 'BUY' }],
  };

  const result = reconciler.reconcile('acct-3', localState, brokerState);
  assert.ok(!result.isMatched);
  assert.ok(result.untracked && result.untracked.length > 0);
});

test('verifies settlement after trade completion', () => {
  const reconciler = createReconciliationEngine();

  const settlement = reconciler.verifySettlement({
    accountId: 'acct-4',
    tradeId: 'trade-123',
    expectedProfit: 50,
    actualProfit: 50,
  });

  assert.ok(settlement.verified);
  assert.equal(settlement.status, 'settled');
});

test('detects settlement failures and profit mismatches', () => {
  const reconciler = createReconciliationEngine();

  const settlement = reconciler.verifySettlement({
    accountId: 'acct-5',
    tradeId: 'trade-456',
    expectedProfit: 50,
    actualProfit: 30,
  });

  assert.ok(!settlement.verified);
  assert.equal(settlement.status, 'mismatch');
});

test('schedules periodic reconciliation checks', () => {
  const reconciler = createReconciliationEngine({ reconcilationInterval: 5000 });

  const scheduled = reconciler.scheduleReconciliation('acct-6', () => {
    return { isMatched: true, discrepancies: [] };
  });

  assert.ok(scheduled);
});

test('maintains reconciliation audit trail', () => {
  const reconciler = createReconciliationEngine();

  reconciler.reconcile('acct-7', { balance: 1000 }, { balance: 1000 });
  reconciler.reconcile('acct-7', { balance: 1050 }, { balance: 1050 });
  reconciler.reconcile('acct-7', { balance: 1100 }, { balance: 1100 });

  const audit = reconciler.getAuditTrail('acct-7');
  assert.equal(audit.length, 3);
});

test('calculates reconciliation statistics for monitoring', () => {
  const reconciler = createReconciliationEngine();

  reconciler.reconcile('acct-8', { balance: 1000 }, { balance: 1000 });
  reconciler.reconcile('acct-8', { balance: 1050 }, { balance: 1050 });
  reconciler.reconcile('acct-8', { balance: 1100 }, { balance: 1050 }); // mismatch

  const stats = reconciler.getReconciliationStats('acct-8');
  assert.equal(stats.totalReconciliations, 3);
  assert.equal(stats.failedReconciliations, 1);
  assert.ok(stats.successRate < 1);
});

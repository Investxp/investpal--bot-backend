import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createAdminDashboard,
} from '../dist/admin-dashboard.js';

test('aggregates live trade state and health metrics', () => {
  const dashboard = createAdminDashboard();

  dashboard.recordTrade({
    executionId: 'exec-1',
    symbol: 'R_100',
    stake: 10,
    result: 'win',
    profit: 5,
    duration: 60,
  });

  dashboard.recordRiskEvent({
    executionId: 'exec-1',
    decision: 'approved',
    riskScore: 35,
  });

  const state = dashboard.getState();
  assert.equal(state.totalTrades, 1);
  assert.equal(state.totalProfit, 5);
  assert.equal(state.lastRiskScore, 35);
});

test('logs audit events for all control-plane actions', () => {
  const dashboard = createAdminDashboard();

  dashboard.logEvent('emergency_stop', { reason: 'User triggered' });
  dashboard.logEvent('live_auth_granted', { accountId: 'acct-123', duration: '30min' });
  dashboard.logEvent('config_change', { field: 'maxStake', oldValue: 100, newValue: 200 });

  const logs = dashboard.getRecentEvents(10);
  assert.equal(logs.length, 3);
  assert.equal(logs[2].type, 'emergency_stop');
  assert.equal(logs[1].type, 'live_auth_granted');
  assert.equal(logs[0].type, 'config_change');
});

test('provides operational health checks and rollback instructions', () => {
  const dashboard = createAdminDashboard();

  const health = dashboard.getHealth();
  assert.ok(health.status);
  assert.equal(health.checks.database, 'unknown');
  assert.equal(health.checks.queue, 'unknown');

  const rollback = dashboard.getRollbackInstructions();
  assert.ok(Array.isArray(rollback.steps));
  assert.ok(rollback.steps.length > 0);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createRecoveryPlanner,
} from '../dist/recovery-plan.js';

test('evaluates recovery eligibility based on account balance', () => {
  const planner = createRecoveryPlanner({ recoveryThreshold: 800, recoveryStake: 50 });

  const eligible = planner.isEligibleForRecovery({
    accountId: 'acct-1',
    balance: 750,
    initialBalance: 1000,
  });

  assert.ok(eligible);
});

test('rejects recovery when balance is above threshold', () => {
  const planner = createRecoveryPlanner({ recoveryThreshold: 800 });

  const eligible = planner.isEligibleForRecovery({
    accountId: 'acct-2',
    balance: 900,
    initialBalance: 1000,
  });

  assert.ok(!eligible);
});

test('generates recovery trade plan with calculated stake', () => {
  const planner = createRecoveryPlanner({ recoveryThreshold: 800, recoveryStake: 50 });

  const plan = planner.generateRecoveryPlan({
    accountId: 'acct-3',
    balance: 750,
    initialBalance: 1000,
    symbol: 'R_100',
  });

  assert.ok(plan.recoveryId);
  assert.equal(plan.stake, 50);
  assert.equal(plan.action, 'RECOVERY');
  assert.ok(plan.targetProfit > 0);
});

test('tracks recovery trades separately for audit', () => {
  const planner = createRecoveryPlanner();

  const plan = planner.generateRecoveryPlan({
    accountId: 'acct-4',
    balance: 750,
    initialBalance: 1000,
    symbol: 'R_50',
  });

  planner.recordRecoveryTrade({
    recoveryId: plan.recoveryId,
    profit: 100,
    result: 'win',
  });

  const recovery = planner.getRecoveryStatus(plan.recoveryId);
  assert.ok(recovery);
  assert.equal(recovery.status, 'completed');
  assert.equal(recovery.totalProfit, 100);
});

test('maintains recovery state for audit trail', () => {
  const planner = createRecoveryPlanner();

  const plan = planner.generateRecoveryPlan({
    accountId: 'acct-5',
    balance: 700,
    initialBalance: 1000,
    symbol: 'EURUSD',
  });

  const status = planner.getRecoveryStatus(plan.recoveryId);
  assert.ok(status.createdAt);
  assert.equal(status.status, 'pending');
});

test('prevents excessive recovery attempts', () => {
  const planner = createRecoveryPlanner({ maxRecoveriesPerDay: 2 });

  planner.generateRecoveryPlan({
    accountId: 'acct-6',
    balance: 700,
    initialBalance: 1000,
    symbol: 'R_100',
  });

  planner.generateRecoveryPlan({
    accountId: 'acct-6',
    balance: 700,
    initialBalance: 1000,
    symbol: 'R_50',
  });

  const canRecover = planner.isRecoveryAvailable('acct-6');
  assert.ok(!canRecover);
});

test('calculates recovery success rate', () => {
  const planner = createRecoveryPlanner();

  const plan1 = planner.generateRecoveryPlan({
    accountId: 'acct-7',
    balance: 700,
    initialBalance: 1000,
    symbol: 'R_100',
  });

  planner.recordRecoveryTrade({ recoveryId: plan1.recoveryId, profit: 50, result: 'win' });

  const plan2 = planner.generateRecoveryPlan({
    accountId: 'acct-7',
    balance: 750,
    initialBalance: 1000,
    symbol: 'R_100',
  });

  planner.recordRecoveryTrade({ recoveryId: plan2.recoveryId, profit: -50, result: 'loss' });

  const stats = planner.getRecoveryStats('acct-7');
  assert.equal(stats.totalRecoveries, 2);
  assert.equal(stats.successRate, 0.5);
});

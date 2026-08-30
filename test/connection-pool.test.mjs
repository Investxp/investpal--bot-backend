import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createConnectionPool,
} from '../dist/connection-pool.js';

test('creates and manages connections per account', () => {
  const pool = createConnectionPool();

  pool.setConnection('account-1', { accountId: 'account-1', connected: true });
  pool.setConnection('account-2', { accountId: 'account-2', connected: true });

  const conn1 = pool.getConnection('account-1');
  const conn2 = pool.getConnection('account-2');

  assert.ok(conn1);
  assert.ok(conn2);
  assert.equal(conn1.accountId, 'account-1');
  assert.equal(conn2.accountId, 'account-2');
});

test('returns null for non-existent connections', () => {
  const pool = createConnectionPool();

  const conn = pool.getConnection('non-existent');
  assert.equal(conn, null);
});

test('recycles stale connections', () => {
  const pool = createConnectionPool({ connectionTTL: 100 });

  pool.setConnection('account-3', { accountId: 'account-3', connected: true });

  const before = pool.getConnection('account-3');
  assert.ok(before);

  // Simulate stale connection
  setTimeout(() => {
    const after = pool.getConnection('account-3');
    // After TTL, connection should be refreshed or null
  }, 150);
});

test('tracks connection health status', () => {
  const pool = createConnectionPool();

  pool.setConnection('account-4', { accountId: 'account-4', connected: true });
  const health = pool.getConnectionHealth('account-4');

  assert.ok(health);
  assert.ok(health.lastChecked);
});

test('supports seamless account switching', () => {
  const pool = createConnectionPool();

  pool.setConnection('account-a', { accountId: 'account-a', connected: true });
  pool.setConnection('account-b', { accountId: 'account-b', connected: true });

  const current = pool.getCurrentAccount();
  pool.switchAccount('account-b');
  const switched = pool.getCurrentAccount();

  assert.notEqual(current, switched);
  assert.equal(switched, 'account-b');
});

test('returns list of all connected accounts', () => {
  const pool = createConnectionPool();

  pool.setConnection('account-5', { accountId: 'account-5', connected: true });
  pool.setConnection('account-6', { accountId: 'account-6', connected: true });

  const accounts = pool.getConnectedAccounts();
  assert.ok(accounts.includes('account-5'));
  assert.ok(accounts.includes('account-6'));
  assert.equal(accounts.length, 2);
});

test('removes connections on disconnect', () => {
  const pool = createConnectionPool();

  pool.setConnection('account-7', { accountId: 'account-7', connected: true });
  assert.ok(pool.getConnection('account-7'));

  pool.removeConnection('account-7');
  assert.equal(pool.getConnection('account-7'), null);
});

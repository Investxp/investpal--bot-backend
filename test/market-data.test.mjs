import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMarketDataManager,
} from '../dist/market-data.js';

test('subscribes to market data and buffers quotes', () => {
  const manager = createMarketDataManager();

  manager.subscribe('R_100');
  manager.onTick({ symbol: 'R_100', quote: 100.5, epoch: Math.floor(Date.now() / 1000) });
  manager.onTick({ symbol: 'R_100', quote: 100.6, epoch: Math.floor(Date.now() / 1000) + 1 });

  const latest = manager.getLatestQuote('R_100');
  assert.equal(latest?.quote, 100.6);
  assert.equal(latest?.symbol, 'R_100');
});

test('detects stale data and flags it for warnings', () => {
  const manager = createMarketDataManager({ maxAgeMs: 5000 });

  manager.subscribe('EURUSD');
  const staleEpoch = Math.floor(Date.now() / 1000) - 60;
  manager.onTick({ symbol: 'EURUSD', quote: 1.09, epoch: staleEpoch });

  const latest = manager.getLatestQuote('EURUSD');
  assert.ok(latest?.isStale);
});

test('implements exponential backoff for reconnection', () => {
  const manager = createMarketDataManager({ maxRetries: 3 });

  manager.recordDisconnect();
  let delay = manager.getNextReconnectDelay();
  assert.equal(delay, 1000);

  manager.recordDisconnect();
  delay = manager.getNextReconnectDelay();
  assert.equal(delay, 2000);

  manager.recordDisconnect();
  delay = manager.getNextReconnectDelay();
  assert.equal(delay, 4000);

  manager.recordSuccess();
  delay = manager.getNextReconnectDelay();
  assert.equal(delay, 1000);
});

test('tracks subscription state for clean restoration', () => {
  const manager = createMarketDataManager();

  manager.subscribe('R_50');
  manager.subscribe('R_100');
  manager.subscribe('EURUSD');

  const subs = manager.getSubscriptions();
  assert.ok(subs.includes('R_50'));
  assert.ok(subs.includes('R_100'));
  assert.ok(subs.includes('EURUSD'));
  assert.equal(subs.length, 3);
});

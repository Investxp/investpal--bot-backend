import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createStrategyVersion,
  findLatestVersion,
  rollbackStrategyToVersion,
  validateVersionChain,
} from '../dist/strategy-versioning.js';

test('creates a strategy version record and marks the latest version', () => {
  const versions = [
    createStrategyVersion({ strategyId: 'strategy-1', version: '1.0.0', config: { risk: 10, mode: 'paper' }, status: 'active' }),
    createStrategyVersion({ strategyId: 'strategy-1', version: '1.1.0', config: { risk: 20, mode: 'demo' }, status: 'draft' }),
  ];

  assert.equal(versions[0].version, '1.0.0');
  assert.equal(findLatestVersion(versions)?.version, '1.1.0');
  assert.equal(validateVersionChain(versions).valid, true);
});

test('rolls a strategy back to a known version and keeps the previous config intact', () => {
  const versions = [
    createStrategyVersion({ strategyId: 'strategy-2', version: '1.0.0', config: { risk: 10, mode: 'paper' }, status: 'active' }),
    createStrategyVersion({ strategyId: 'strategy-2', version: '1.1.0', config: { risk: 25, mode: 'live' }, status: 'active' }),
  ];

  const rolled = rollbackStrategyToVersion({
    strategyId: 'strategy-2',
    currentVersion: '1.1.0',
    currentConfig: versions[1].config,
    versions,
    targetVersion: '1.0.0',
  });

  assert.equal(rolled.version, '1.0.0');
  assert.deepEqual(rolled.config, { risk: 10, mode: 'paper' });
  assert.equal(rolled.status, 'active');
});

test('rejects an invalid version sequence', () => {
  const versions = [
    createStrategyVersion({ strategyId: 'strategy-3', version: '1.2.0', config: { risk: 15 }, status: 'active' }),
    createStrategyVersion({ strategyId: 'strategy-3', version: '1.0.0', config: { risk: 12 }, status: 'draft' }),
  ];

  const result = validateVersionChain(versions);
  assert.equal(result.valid, false);
  assert.match(result.error || '', /version order/i);
});

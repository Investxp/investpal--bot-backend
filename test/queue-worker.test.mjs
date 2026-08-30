import assert from 'node:assert/strict';
import test from 'node:test';
import { JobQueue, createJobQueue } from '../dist/queue-worker.js';

test('enqueues and executes jobs in order with isolation', async () => {
  const queue = createJobQueue({ maxRetries: 2 });
  const seen = [];

  await queue.enqueue({ id: 'job-1', type: 'demo', payload: { value: 1 }, handler: async () => { seen.push('job-1'); } });
  await queue.enqueue({ id: 'job-2', type: 'demo', payload: { value: 2 }, handler: async () => { seen.push('job-2'); } });

  await queue.drain();
  assert.deepEqual(seen, ['job-1', 'job-2']);
  assert.equal(queue.getStats().queued, 0);
});

test('retries failed jobs without duplicating the same work item', async () => {
  const queue = createJobQueue({ maxRetries: 2 });
  let attempts = 0;

  await queue.enqueue({
    id: 'retry-1',
    type: 'demo',
    payload: { value: 1 },
    handler: async () => {
      attempts += 1;
      if (attempts < 2) {
        throw new Error('temporary fail');
      }
    },
  });

  await queue.drain();
  assert.equal(attempts, 2);
  assert.equal(queue.getStats().failed, 0);
});

test('prevents duplicate job IDs from being enqueued twice', async () => {
  const queue = createJobQueue({ maxRetries: 1 });
  let executed = 0;

  const first = await queue.enqueue({ id: 'dedupe-1', type: 'demo', payload: {}, handler: async () => { executed += 1; } });
  const second = await queue.enqueue({ id: 'dedupe-1', type: 'demo', payload: {}, handler: async () => { executed += 1; } });

  assert.equal(first.accepted, true);
  assert.equal(second.accepted, false);
  assert.equal(executed, 0);
  await queue.drain();
  assert.equal(executed, 1);
});

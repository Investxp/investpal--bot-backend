import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createJobQueue,
  createExecutionJob,
} from '../dist/job-queue.js';

test('enqueues an execution job and marks it as pending', () => {
  const queue = createJobQueue();
  const job = createExecutionJob({
    executionId: 'exec-1',
    accountId: 'acct-123',
    symbol: 'R_100',
    stake: 10,
    config: { platform: 'deriv', mode: 'rise-fall' },
  });

  queue.enqueue(job);
  const fetched = queue.getJob(job.id);

  assert.ok(fetched);
  assert.equal(fetched.status, 'PENDING');
  assert.equal(fetched.executionId, 'exec-1');
  assert.equal(fetched.attempts, 0);
});

test('dequeues a pending job for worker processing', () => {
  const queue = createJobQueue();
  const job = createExecutionJob({
    executionId: 'exec-2',
    accountId: 'acct-456',
    symbol: 'R_50',
    stake: 5,
    config: { platform: 'deriv', mode: 'digits' },
  });

  queue.enqueue(job);
  const dequeued = queue.dequeue();

  assert.ok(dequeued);
  assert.equal(dequeued.status, 'PROCESSING');
  assert.equal(dequeued.attempts, 1);
});

test('marks a job as completed after successful execution', () => {
  const queue = createJobQueue();
  const job = createExecutionJob({
    executionId: 'exec-3',
    accountId: 'acct-789',
    symbol: 'EURUSD',
    stake: 50,
    config: { platform: 'deriv', mode: 'rise-fall' },
  });

  queue.enqueue(job);
  queue.complete(job.id, { result: 'won', profit: 25 });
  const completed = queue.getJob(job.id);

  assert.equal(completed?.status, 'COMPLETED');
  assert.ok(completed?.completedAt);
});

test('requeues a failed job up to max attempts', () => {
  const queue = createJobQueue({ maxAttempts: 3 });
  const job = createExecutionJob({
    executionId: 'exec-4',
    accountId: 'acct-999',
    symbol: 'R_100',
    stake: 10,
    config: { platform: 'deriv', mode: 'rise-fall' },
  });

  queue.enqueue(job);
  queue.dequeue();
  queue.fail(job.id, 'Network timeout');

  const requeued = queue.getJob(job.id);
  assert.equal(requeued?.status, 'PENDING');
  assert.equal(requeued?.attempts, 1);

  queue.dequeue();
  queue.fail(job.id, 'Network timeout');

  queue.dequeue();
  queue.fail(job.id, 'Network timeout');

  const maxedOut = queue.getJob(job.id);
  assert.equal(maxedOut?.status, 'FAILED');
});

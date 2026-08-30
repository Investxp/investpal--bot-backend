import { randomUUID } from 'crypto';

export type JobStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';

export interface ExecutionJobPayload {
  executionId: string;
  accountId: string;
  symbol: string;
  stake: number;
  config: Record<string, unknown>;
}

export interface ExecutionJob {
  id: string;
  status: JobStatus;
  payload: ExecutionJobPayload;
  executionId: string;
  accountId: string;
  attempts: number;
  maxAttempts: number;
  error?: string;
  result?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export function createExecutionJob(payload: ExecutionJobPayload): ExecutionJob {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    status: 'PENDING',
    payload,
    executionId: payload.executionId,
    accountId: payload.accountId,
    attempts: 0,
    maxAttempts: 3,
    createdAt: now,
    updatedAt: now,
  };
}

export interface JobQueueOptions {
  maxAttempts?: number;
}

export function createJobQueue(options: JobQueueOptions = {}) {
  const maxAttempts = options.maxAttempts ?? 3;
  const jobs = new Map<string, ExecutionJob>();
  const pendingQueue: string[] = [];

  return {
    enqueue(job: ExecutionJob): void {
      const stored = { ...job, status: 'PENDING' as const, maxAttempts };
      jobs.set(job.id, stored);
      pendingQueue.push(job.id);
    },

    dequeue(): ExecutionJob | null {
      const jobId = pendingQueue.shift();
      if (!jobId) return null;

      const job = jobs.get(jobId);
      if (!job) return null;

      const updated = {
        ...job,
        status: 'PROCESSING' as const,
        attempts: (job.attempts ?? 0) + 1,
        updatedAt: new Date().toISOString(),
      };

      jobs.set(jobId, updated);
      return updated;
    },

    getJob(jobId: string): ExecutionJob | null {
      return jobs.get(jobId) ?? null;
    },

    complete(jobId: string, result: Record<string, unknown>): void {
      const job = jobs.get(jobId);
      if (!job) return;

      const updated = {
        ...job,
        status: 'COMPLETED' as const,
        result,
        completedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      jobs.set(jobId, updated);
    },

    fail(jobId: string, error: string): void {
      const job = jobs.get(jobId);
      if (!job) return;

      if ((job.attempts ?? 0) < maxAttempts) {
        const updated = {
          ...job,
          status: 'PENDING' as const,
          error,
          updatedAt: new Date().toISOString(),
        };
        jobs.set(jobId, updated);
        pendingQueue.push(jobId);
      } else {
        const updated = {
          ...job,
          status: 'FAILED' as const,
          error,
          updatedAt: new Date().toISOString(),
        };
        jobs.set(jobId, updated);
      }
    },

    getPending(): ExecutionJob[] {
      return Array.from(jobs.values()).filter((job) => job.status === 'PENDING');
    },

    getProcessing(): ExecutionJob[] {
      return Array.from(jobs.values()).filter((job) => job.status === 'PROCESSING');
    },

    getAll(): ExecutionJob[] {
      return Array.from(jobs.values());
    },

    clear(): void {
      jobs.clear();
      pendingQueue.length = 0;
    },
  };
}

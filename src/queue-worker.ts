export type QueueJob<TPayload = Record<string, unknown>> = {
  id: string;
  type: string;
  payload: TPayload;
  handler: () => Promise<void> | void;
  retries?: number;
};

export type QueueAcceptResult = {
  accepted: boolean;
  job?: QueueJob;
  reason?: string;
};

export type JobQueueStats = {
  queued: number;
  active: number;
  failed: number;
};

export type JobQueueOptions = {
  maxRetries?: number;
};

export function createJobQueue(options: JobQueueOptions = {}) {
  const maxRetries = options.maxRetries ?? 3;
  const queue: QueueJob[] = [];
  const activeIds = new Set<string>();
  const completedIds = new Set<string>();
  const failedIds = new Set<string>();
  const inFlight = new Map<string, number>();

  const enqueue = async (job: QueueJob): Promise<QueueAcceptResult> => {
    if (!job?.id) {
      return { accepted: false, reason: 'job.id is required' };
    }
    if (activeIds.has(job.id) || completedIds.has(job.id) || failedIds.has(job.id) || queue.some((queued) => queued.id === job.id)) {
      return { accepted: false, reason: `duplicate job id: ${job.id}` };
    }

    activeIds.add(job.id);
    queue.push(job);
    return { accepted: true, job };
  };

  const drain = async (): Promise<void> => {
    while (queue.length > 0) {
      const job = queue.shift()!;
      if (!job) continue;

      let attempts = inFlight.get(job.id) ?? 0;
      try {
        await job.handler();
        completedIds.add(job.id);
        activeIds.delete(job.id);
        failedIds.delete(job.id);
        inFlight.delete(job.id);
      } catch (error) {
        attempts += 1;
        inFlight.set(job.id, attempts);
        activeIds.delete(job.id);

        if (attempts <= maxRetries) {
          queue.push({ ...job, retries: attempts });
          continue;
        }

        failedIds.add(job.id);
        completedIds.add(job.id);
        inFlight.delete(job.id);
      }
    }
  };

  const getStats = (): JobQueueStats => ({
    queued: queue.length,
    active: activeIds.size,
    failed: failedIds.size,
  });

  return {
    enqueue,
    drain,
    getStats,
  };
}

export class JobQueue {
  private readonly queue: QueueJob[] = [];
  private readonly activeIds = new Set<string>();
  private readonly completedIds = new Set<string>();
  private readonly failedIds = new Set<string>();
  private readonly inFlight = new Map<string, number>();
  private readonly maxRetries: number;

  constructor(options: JobQueueOptions = {}) {
    this.maxRetries = options.maxRetries ?? 3;
  }

  async enqueue(job: QueueJob): Promise<QueueAcceptResult> {
    if (!job?.id) {
      return { accepted: false, reason: 'job.id is required' };
    }
    if (this.activeIds.has(job.id) || this.completedIds.has(job.id) || this.failedIds.has(job.id) || this.queue.some((queued) => queued.id === job.id)) {
      return { accepted: false, reason: `duplicate job id: ${job.id}` };
    }

    this.activeIds.add(job.id);
    this.queue.push(job);
    return { accepted: true, job };
  }

  async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const job = this.queue.shift()!;
      let attempts = this.inFlight.get(job.id) ?? 0;
      try {
        await job.handler();
        this.completedIds.add(job.id);
        this.activeIds.delete(job.id);
        this.failedIds.delete(job.id);
        this.inFlight.delete(job.id);
      } catch (error) {
        attempts += 1;
        this.inFlight.set(job.id, attempts);
        this.activeIds.delete(job.id);

        if (attempts <= this.maxRetries) {
          this.queue.push({ ...job, retries: attempts });
          continue;
        }

        this.failedIds.add(job.id);
        this.completedIds.add(job.id);
        this.inFlight.delete(job.id);
      }
    }
  }

  getStats(): JobQueueStats {
    return {
      queued: this.queue.length,
      active: this.activeIds.size,
      failed: this.failedIds.size,
    };
  }
}

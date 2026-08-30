import { randomUUID } from 'crypto';

export interface RecoveryPlanInput {
  accountId: string;
  balance: number;
  initialBalance: number;
  symbol: string;
}

export interface RecoveryPlan {
  recoveryId: string;
  accountId: string;
  balance: number;
  stake: number;
  symbol: string;
  action: string;
  targetProfit: number;
  createdAt: string;
  status: string;
}

export interface RecoveryTrade {
  recoveryId: string;
  profit: number;
  result: 'win' | 'loss';
  recordedAt?: string;
}

export interface RecoveryStatus {
  recoveryId: string;
  accountId: string;
  status: 'pending' | 'completed' | 'failed';
  totalProfit: number;
  createdAt: string;
  completedAt?: string;
}

export interface PlannerOptions {
  recoveryThreshold?: number;
  recoveryStake?: number;
  maxRecoveriesPerDay?: number;
}

export function createRecoveryPlanner(options: PlannerOptions = {}) {
  const recoveryThreshold = options.recoveryThreshold ?? 800;
  const recoveryStake = options.recoveryStake ?? 100;
  const maxRecoveriesPerDay = options.maxRecoveriesPerDay ?? 5;

  const plans = new Map<string, RecoveryPlan>();
  const status = new Map<string, RecoveryStatus>();
  const dailyCount = new Map<string, number>();

  return {
    isEligibleForRecovery(input: { accountId: string; balance: number; initialBalance: number }): boolean {
      return input.balance < recoveryThreshold && input.balance > 0;
    },

    generateRecoveryPlan(input: RecoveryPlanInput): RecoveryPlan {
      const recoveryId = randomUUID();
      const lossAmount = input.initialBalance - input.balance;
      const targetProfit = Math.ceil(lossAmount * 1.1); // 110% to recover + buffer

      const plan: RecoveryPlan = {
        recoveryId,
        accountId: input.accountId,
        balance: input.balance,
        stake: recoveryStake,
        symbol: input.symbol,
        action: 'RECOVERY',
        targetProfit,
        createdAt: new Date().toISOString(),
        status: 'pending',
      };

      plans.set(recoveryId, plan);

      status.set(recoveryId, {
        recoveryId,
        accountId: input.accountId,
        status: 'pending',
        totalProfit: 0,
        createdAt: new Date().toISOString(),
      });

      // Track daily recovery count
      const today = new Date().toDateString();
      const key = `${input.accountId}-${today}`;
      dailyCount.set(key, (dailyCount.get(key) ?? 0) + 1);

      return plan;
    },

    recordRecoveryTrade(trade: RecoveryTrade): void {
      const plan = plans.get(trade.recoveryId);
      if (!plan) return;

      const s = status.get(trade.recoveryId);
      if (!s) return;

      s.totalProfit += trade.profit;
      s.completedAt = new Date().toISOString();
      s.status = trade.result === 'win' ? 'completed' : 'failed';
    },

    getRecoveryStatus(recoveryId: string): RecoveryStatus | null {
      return status.get(recoveryId) ?? null;
    },

    isRecoveryAvailable(accountId: string): boolean {
      const today = new Date().toDateString();
      const key = `${accountId}-${today}`;
      const count = dailyCount.get(key) ?? 0;
      return count < maxRecoveriesPerDay;
    },

    getRecoveryStats(accountId: string) {
      const accountRecoveries = Array.from(status.values()).filter((s) => s.accountId === accountId);

      const wins = accountRecoveries.filter((s) => s.status === 'completed').length;
      const losses = accountRecoveries.filter((s) => s.status === 'failed').length;
      const successRate = accountRecoveries.length > 0 ? wins / accountRecoveries.length : 0;

      return {
        totalRecoveries: accountRecoveries.length,
        wins,
        losses,
        successRate,
        totalProfit: accountRecoveries.reduce((sum, s) => sum + s.totalProfit, 0),
      };
    },

    getAllRecoveries(accountId: string): RecoveryStatus[] {
      return Array.from(status.values()).filter((s) => s.accountId === accountId);
    },

    clear(): void {
      plans.clear();
      status.clear();
      dailyCount.clear();
    },
  };
}

import { randomUUID } from 'crypto';

export interface LocalState {
  balance?: number;
  equity?: number;
  exposure?: number;
  positions?: Array<{ symbol: string; stake: number; side: string }>;
}

export interface BrokerState {
  balance?: number;
  equity?: number;
  positions?: Array<{ symbol: string; stake: number; side: string }>;
}

export interface ReconciliationResult {
  isMatched: boolean;
  discrepancies: string[];
  untracked?: Array<any>;
  timestamp: string;
}

export interface SettlementVerification {
  verified: boolean;
  status: 'settled' | 'pending' | 'mismatch';
  difference: number;
  timestamp: string;
}

export interface ReconciliationAudit {
  timestamp: string;
  result: ReconciliationResult;
}

export interface EngineOptions {
  reconcilationInterval?: number;
  tolerancePercent?: number;
}

export function createReconciliationEngine(options: EngineOptions = {}) {
  const reconcilationInterval = options.reconcilationInterval ?? 300000; // 5 minutes default
  const tolerancePercent = options.tolerancePercent ?? 0.01; // 1% tolerance

  const audit = new Map<string, ReconciliationAudit[]>();
  const schedules = new Map<string, NodeJS.Timeout>();

  return {
    reconcile(accountId: string, local: LocalState, broker: BrokerState): ReconciliationResult {
      const discrepancies: string[] = [];
      const untracked: Array<any> = [];

      // Check balance
      if (local.balance !== undefined && broker.balance !== undefined) {
        const diff = Math.abs(local.balance - broker.balance);
        const tolerance = (broker.balance * tolerancePercent) / 100;
        if (diff > tolerance) {
          discrepancies.push(`Balance mismatch: local=${local.balance}, broker=${broker.balance}`);
        }
      }

      // Check equity
      if (local.equity !== undefined && broker.equity !== undefined) {
        const diff = Math.abs(local.equity - broker.equity);
        const tolerance = (broker.equity * tolerancePercent) / 100;
        if (diff > tolerance) {
          discrepancies.push(`Equity mismatch: local=${local.equity}, broker=${broker.equity}`);
        }
      }

      // Check positions
      if (broker.positions && broker.positions.length > 0) {
        for (const position of broker.positions) {
          const localPos = local.positions?.find((p) => p.symbol === position.symbol);
          if (!localPos) {
            untracked.push(position);
          }
        }
      }

      const result: ReconciliationResult = {
        isMatched: discrepancies.length === 0 && untracked.length === 0,
        discrepancies,
        untracked: untracked.length > 0 ? untracked : undefined,
        timestamp: new Date().toISOString(),
      };

      // Store in audit trail
      if (!audit.has(accountId)) {
        audit.set(accountId, []);
      }
      audit.get(accountId)!.push({ timestamp: new Date().toISOString(), result });

      return result;
    },

    verifySettlement(input: { accountId: string; tradeId: string; expectedProfit: number; actualProfit: number }): SettlementVerification {
      const difference = input.actualProfit - input.expectedProfit;
      const verified = Math.abs(difference) < 0.01; // Within $0.01

      return {
        verified,
        status: verified ? 'settled' : 'mismatch',
        difference,
        timestamp: new Date().toISOString(),
      };
    },

    scheduleReconciliation(accountId: string, reconcileFn: () => ReconciliationResult): boolean {
      if (schedules.has(accountId)) {
        return false; // Already scheduled
      }

      const timeout = setInterval(() => {
        const result = reconcileFn();
        if (!audit.has(accountId)) {
          audit.set(accountId, []);
        }
        audit.get(accountId)!.push({ timestamp: new Date().toISOString(), result });
      }, reconcilationInterval);

      schedules.set(accountId, timeout);
      return true;
    },

    cancelSchedule(accountId: string): boolean {
      const timeout = schedules.get(accountId);
      if (!timeout) return false;

      clearInterval(timeout);
      schedules.delete(accountId);
      return true;
    },

    getAuditTrail(accountId: string): ReconciliationAudit[] {
      return [...(audit.get(accountId) ?? [])];
    },

    getReconciliationStats(accountId: string) {
      const trail = audit.get(accountId) ?? [];
      const failed = trail.filter((a) => !a.result.isMatched).length;

      return {
        totalReconciliations: trail.length,
        failedReconciliations: failed,
        successRate: trail.length > 0 ? (trail.length - failed) / trail.length : 0,
        lastReconciliation: trail[trail.length - 1]?.timestamp ?? null,
      };
    },

    clear(): void {
      audit.clear();
      for (const timeout of schedules.values()) {
        clearInterval(timeout);
      }
      schedules.clear();
    },
  };
}

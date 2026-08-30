import { randomUUID } from 'crypto';

export type DashboardEventType = 
  | 'emergency_stop'
  | 'live_auth_granted'
  | 'live_auth_revoked'
  | 'config_change'
  | 'risk_block'
  | 'strategy_deployed'
  | 'worker_restart'
  | 'database_connection_lost'
  | 'database_connection_restored';

export interface DashboardEvent {
  id: string;
  type: DashboardEventType;
  timestamp: string;
  metadata: Record<string, unknown>;
}

export interface RiskCheckRecord {
  executionId: string;
  decision: 'approved' | 'reduced' | 'deferred' | 'blocked';
  riskScore: number;
  timestamp: string;
}

export interface TradeRecord {
  executionId: string;
  symbol: string;
  stake: number;
  result?: 'win' | 'loss';
  profit?: number;
  duration: number;
  timestamp: string;
}

export interface DashboardState {
  totalTrades: number;
  wins: number;
  losses: number;
  totalProfit: number;
  lastRiskScore: number;
  emergencyStopActive: boolean;
  updatedAt: string;
}

export interface HealthCheck {
  status: 'healthy' | 'degraded' | 'unhealthy';
  checks: {
    database: 'ok' | 'error' | 'unknown';
    queue: 'ok' | 'error' | 'unknown';
    api: 'ok' | 'error' | 'unknown';
    broker: 'ok' | 'error' | 'unknown';
  };
  timestamp: string;
}

export interface RollbackPlan {
  version: string;
  steps: Array<{
    step: number;
    action: string;
    description: string;
    critical: boolean;
  }>;
}

export function createAdminDashboard() {
  const events: DashboardEvent[] = [];
  const trades: TradeRecord[] = [];
  const riskChecks: RiskCheckRecord[] = [];

  const state: DashboardState = {
    totalTrades: 0,
    wins: 0,
    losses: 0,
    totalProfit: 0,
    lastRiskScore: 0,
    emergencyStopActive: false,
    updatedAt: new Date().toISOString(),
  };

  return {
    getState(): DashboardState {
      return { ...state };
    },

    recordTrade(record: Omit<TradeRecord, 'timestamp'>): void {
      const trade: TradeRecord = {
        ...record,
        timestamp: new Date().toISOString(),
      };

      trades.push(trade);
      state.totalTrades += 1;

      if (record.result === 'win') {
        state.wins += 1;
      } else if (record.result === 'loss') {
        state.losses += 1;
      }

      if (record.profit) {
        state.totalProfit += record.profit;
      }

      state.updatedAt = new Date().toISOString();
    },

    recordRiskEvent(record: Omit<RiskCheckRecord, 'timestamp'>): void {
      const riskCheck: RiskCheckRecord = {
        ...record,
        timestamp: new Date().toISOString(),
      };

      riskChecks.push(riskCheck);
      state.lastRiskScore = record.riskScore;
      state.updatedAt = new Date().toISOString();
    },

    logEvent(type: DashboardEventType, metadata: Record<string, unknown> = {}): void {
      const event: DashboardEvent = {
        id: randomUUID(),
        type,
        timestamp: new Date().toISOString(),
        metadata,
      };

      events.push(event);
      state.updatedAt = new Date().toISOString();
    },

    getRecentEvents(limit = 100): DashboardEvent[] {
      return events.slice(-limit).reverse();
    },

    getRecentTrades(limit = 100): TradeRecord[] {
      return trades.slice(-limit).reverse();
    },

    getRecentRiskChecks(limit = 100): RiskCheckRecord[] {
      return riskChecks.slice(-limit).reverse();
    },

    getHealth(): HealthCheck {
      return {
        status: 'unknown' as 'healthy' | 'degraded' | 'unhealthy' | 'unknown' as any,
        checks: {
          database: 'unknown',
          queue: 'unknown',
          api: 'unknown',
          broker: 'unknown',
        },
        timestamp: new Date().toISOString(),
      };
    },

    getRollbackInstructions(): RollbackPlan {
      return {
        version: '1.0.0',
        steps: [
          {
            step: 1,
            action: 'stop_trading',
            description: 'Trigger emergency stop to halt all active trades',
            critical: true,
          },
          {
            step: 2,
            action: 'disconnect_workers',
            description: 'Gracefully disconnect all worker processes',
            critical: true,
          },
          {
            step: 3,
            action: 'database_checkpoint',
            description: 'Create database checkpoint before rollback',
            critical: true,
          },
          {
            step: 4,
            action: 'restore_previous_version',
            description: 'Deploy previous version from git tag',
            critical: false,
          },
          {
            step: 5,
            action: 'verify_broker_state',
            description: 'Reconcile broker state with local records',
            critical: true,
          },
        ],
      };
    },
  };
}

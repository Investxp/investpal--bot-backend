import type { Pool } from 'pg';
import { randomUUID } from 'crypto';

export interface AuditEvent {
  id: string;
  userId?: string;
  actorId?: string;
  action: string;
  accountId?: string | null;
  executionId?: string;
  correlationId: string;
  metadata: Record<string, any>;
  createdAt: string;
}

/**
 * Audit logging service for compliance and forensics.
 * All sensitive actions are logged to database with correlation IDs.
 */
export class AuditLogger {
  private readonly pool: Pool | null;
  private readonly inMemoryLogs: AuditEvent[] = [];

  constructor(pool: Pool | null) {
    this.pool = pool;
  }

  /**
   * Log an audit event (trading action, auth, config change, etc.)
   */
  async log(event: Omit<AuditEvent, 'id' | 'createdAt'>): Promise<void> {
    const auditEvent: AuditEvent = {
      ...event,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };

    // In-memory fallback (always)
    this.inMemoryLogs.unshift(auditEvent);
    if (this.inMemoryLogs.length > 1000) this.inMemoryLogs.pop();

    // Database persistence (if available)
    if (this.pool) {
      try {
        await this.pool.query(
          `INSERT INTO audit_logs (id, user_id, actor_id, action, metadata, correlation_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            auditEvent.id,
            auditEvent.userId || null,
            auditEvent.actorId || null,
            auditEvent.action,
            JSON.stringify(auditEvent.metadata),
            auditEvent.correlationId,
            auditEvent.createdAt,
          ]
        );
      } catch (error) {
        console.error('[AuditLogger] Database write failed:', error);
        // Fail open: log to memory only, don't block operations
      }
    }
  }

  /**
   * Query audit logs (memory-only, for recent logs)
   */
  getRecentLogs(limit = 100): AuditEvent[] {
    return this.inMemoryLogs.slice(0, Math.min(limit, 1000));
  }

  /**
   * Security-sensitive actions that must be audited
   */
  async logTradeStart(
    correlationId: string,
    accountId: string | null,
    executionId: string,
    mode: string,
    stake: number
  ): Promise<void> {
    await this.log({
      action: 'TRADE_START',
      correlationId,
      accountId,
      executionId,
      metadata: { mode, stake },
    });
  }

  async logTradeEnd(
    correlationId: string,
    accountId: string | null,
    executionId: string,
    result: 'win' | 'loss' | 'cancelled',
    profit: number | null
  ): Promise<void> {
    await this.log({
      action: 'TRADE_END',
      correlationId,
      accountId,
      executionId,
      metadata: { result, profit },
    });
  }

  async logLiveAuthorizationAttempt(
    correlationId: string,
    accountId: string | null,
    approved: boolean,
    reason?: string
  ): Promise<void> {
    await this.log({
      action: 'LIVE_AUTH_' + (approved ? 'APPROVED' : 'DENIED'),
      correlationId,
      accountId,
      metadata: { reason },
    });
  }

  async logEmergencyStop(correlationId: string, reason: string): Promise<void> {
    await this.log({
      action: 'EMERGENCY_STOP',
      correlationId,
      metadata: { reason },
    });
  }

  async logRiskBlockage(
    correlationId: string,
    accountId: string | null,
    executionId: string,
    reasons: string[]
  ): Promise<void> {
    await this.log({
      action: 'RISK_BLOCKED',
      correlationId,
      accountId,
      executionId,
      metadata: { reasons },
    });
  }

  async logConfigChange(
    correlationId: string,
    accountId: string | null,
    setting: string,
    oldValue: any,
    newValue: any
  ): Promise<void> {
    await this.log({
      action: 'CONFIG_CHANGE',
      correlationId,
      accountId,
      metadata: { setting, oldValue, newValue },
    });
  }
}

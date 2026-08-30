import { randomUUID } from 'crypto';
import type { Pool } from 'pg';

/**
 * Idempotency service prevents duplicate execution submissions.
 * 
 * Generates unique keys that persist across retries, ensuring that a request
 * with the same idempotency key always returns the same result without
 * duplicate broker submissions.
 */
export class IdempotencyService {
  private readonly pool: Pool | null;

  constructor(pool: Pool | null) {
    this.pool = pool;
  }

  /**
   * Generate a new idempotency key for an execution request.
   * In production with a database, this key is checked against prior executions.
   */
  generateKey(): string {
    return randomUUID();
  }

  /**
   * Check if an idempotency key has already been used for an account.
   * If it has, return the cached execution ID; otherwise return null.
   * 
   * @param accountId The broker account ID
   * @param idempotencyKey The idempotency key to check
   * @returns executionId if already executed, null if new
   */
  async checkKey(accountId: string | null, idempotencyKey: string): Promise<string | null> {
    if (!this.pool || !accountId) return null; // dev mode or no account context
    
    try {
      const result = await this.pool.query(
        'SELECT id FROM executions WHERE account_id = $1 AND idempotency_key = $2 LIMIT 1',
        [accountId, idempotencyKey]
      );
      return result.rows.length > 0 ? result.rows[0].id : null;
    } catch (error) {
      // In case of database error, allow the request to proceed
      // (fail open to prevent blocking legitimate retries)
      console.error('[Idempotency] Database check failed:', error);
      return null;
    }
  }

  /**
   * Reserve an idempotency key for a new execution (prevents race conditions).
   * This should be called before submitting to the broker.
   * 
   * @returns true if key was reserved, false if it already exists
   */
  async reserveKey(accountId: string | null, idempotencyKey: string): Promise<boolean> {
    if (!this.pool || !accountId) return true; // dev mode
    
    try {
      const result = await this.pool.query(
        `INSERT INTO executions (id, account_id, idempotency_key, broker_id, state, symbol, contract_type, stake, created_at, updated_at)
         VALUES ($1, $2, $3, 'deriv', 'CREATED', 'UNKNOWN', 'UNKNOWN', 0, now(), now())
         ON CONFLICT (account_id, idempotency_key) DO NOTHING
         RETURNING id`,
        [randomUUID(), accountId, idempotencyKey]
      );
      return result.rows.length > 0; // true if inserted (key was reserved)
    } catch (error) {
      console.error('[Idempotency] Reserve failed:', error);
      return true; // fail open
    }
  }
}

import { Pool } from 'pg';
import type { ExecutionRecord, ExecutionState } from './types.js';

export class PostgresExecutionPersistence {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 5, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined });
  }

  async check(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async load(limit = 500): Promise<ExecutionRecord[]> {
    const result = await this.pool.query(
      `SELECT id, broker_account_id, idempotency_key, state, symbol, contract_type, stake, broker_contract_id, result, profit, error, created_at, updated_at
       FROM executions ORDER BY created_at DESC LIMIT $1`, [limit],
    );
    return result.rows.map((row) => ({
      executionId: row.id,
      accountId: row.broker_account_id,
      idempotencyKey: row.idempotency_key,
      state: row.state as ExecutionState,
      leg: 'leg1',
      symbol: row.symbol,
      contractType: row.contract_type,
      stake: Number(row.stake),
      contractId: row.broker_contract_id ? Number(row.broker_contract_id) : null,
      result: row.result,
      profit: row.profit === null ? null : Number(row.profit),
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
      error: row.error,
    }));
  }

  async upsert(record: ExecutionRecord): Promise<void> {
    const idempotencyKey = record.idempotencyKey || record.executionId;
    await this.pool.query(
      `INSERT INTO executions (id, broker_id, broker_account_id, idempotency_key, state, symbol, contract_type, stake, broker_contract_id, result, profit, error, created_at, updated_at)
       VALUES ($1, 'deriv', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, broker_contract_id = EXCLUDED.broker_contract_id,
         result = EXCLUDED.result, profit = EXCLUDED.profit, error = EXCLUDED.error, updated_at = EXCLUDED.updated_at`,
      [record.executionId, record.accountId, idempotencyKey, record.state, record.symbol, record.contractType, record.stake, record.contractId?.toString() ?? null,
        record.result, record.profit, record.error, record.createdAt, record.updatedAt],
    );
  }

  async close(): Promise<void> { await this.pool.end(); }

  async checkIdempotencyKey(accountId: string | null, idempotencyKey: string): Promise<string | null> {
    if (!accountId) return null;
    try {
      const result = await this.pool.query(
        'SELECT id FROM executions WHERE broker_account_id = $1 AND idempotency_key = $2 LIMIT 1',
        [accountId, idempotencyKey]
      );
      return result.rows.length > 0 ? result.rows[0].id : null;
    } catch (error) {
      return null; // fail open on database error
    }
  }
}

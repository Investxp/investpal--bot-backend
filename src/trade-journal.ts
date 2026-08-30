import type { Pool } from 'pg';
import type { ExecutionRecord } from './types.js';

export interface TradeJournalEntry {
  id: string;
  accountId: string | null;
  executionId: string;
  symbol: string;
  mode: string;
  stake: number;
  profit: number | null;
  result: 'win' | 'loss' | null;
  duration: number; // seconds
  contractType: string;
  contractId: number | null;
  notes?: string;
  tags?: string[];
  createdAt: string;
  settledAt?: string;
}

/**
 * Trade journal persistence layer.
 * 
 * Stores immutable trade records for analysis, reporting, and compliance.
 * Each trade entry is associated with an execution record.
 */
export class TradeJournal {
  private readonly pool: Pool | null;

  constructor(pool: Pool | null) {
    this.pool = pool;
  }

  /**
   * Record a new trade in the journal
   */
  async recordTrade(entry: Omit<TradeJournalEntry, 'id' | 'createdAt'>): Promise<string> {
    const id = entry.executionId; // Use execution ID as journal ID for correlation

    if (!this.pool) {
      console.warn('[TradeJournal] Database not configured; trade not persisted');
      return id;
    }

    try {
      await this.pool.query(
        `INSERT INTO trade_journal (id, account_id, execution_id, symbol, mode, stake, profit, result, duration, contract_type, contract_id, notes, tags, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (id) DO UPDATE SET
           profit = EXCLUDED.profit,
           result = EXCLUDED.result,
           settled_at = now()`,
        [
          id,
          entry.accountId || null,
          entry.executionId,
          entry.symbol,
          entry.mode,
          entry.stake,
          entry.profit ?? null,
          entry.result ?? null,
          entry.duration,
          entry.contractType,
          entry.contractId ?? null,
          entry.notes || null,
          entry.tags ? JSON.stringify(entry.tags) : null,
          new Date().toISOString(),
        ]
      );
    } catch (error) {
      console.error('[TradeJournal] Insert failed:', error);
      // Fail open: don't block trading if journal write fails
    }

    return id;
  }

  /**
   * Get trade journal entries for an account
   */
  async getAccountTrades(
    accountId: string | null,
    limit = 100,
    offset = 0
  ): Promise<TradeJournalEntry[]> {
    if (!this.pool || !accountId) return [];

    try {
      const result = await this.pool.query(
        `SELECT id, account_id, execution_id, symbol, mode, stake, profit, result, duration, 
                contract_type, contract_id, notes, tags, created_at, settled_at
         FROM trade_journal
         WHERE account_id = $1
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [accountId, limit, offset]
      );

      return result.rows.map((row) => ({
        id: row.id,
        accountId: row.account_id,
        executionId: row.execution_id,
        symbol: row.symbol,
        mode: row.mode,
        stake: Number(row.stake),
        profit: row.profit === null ? null : Number(row.profit),
        result: row.result,
        duration: row.duration,
        contractType: row.contract_type,
        contractId: row.contract_id ? Number(row.contract_id) : null,
        notes: row.notes,
        tags: row.tags ? JSON.parse(row.tags) : [],
        createdAt: row.created_at,
        settledAt: row.settled_at,
      }));
    } catch (error) {
      console.error('[TradeJournal] Query failed:', error);
      return [];
    }
  }

  /**
   * Get trade statistics for an account
   */
  async getAccountStats(accountId: string | null): Promise<{
    totalTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    totalProfit: number;
    averageStake: number;
    largestWin: number;
    largestLoss: number;
  } | null> {
    if (!this.pool || !accountId) return null;

    try {
      const result = await this.pool.query(
        `SELECT
           COUNT(*) as total_trades,
           COUNT(CASE WHEN result = 'win' THEN 1 END) as wins,
           COUNT(CASE WHEN result = 'loss' THEN 1 END) as losses,
           COALESCE(SUM(profit), 0) as total_profit,
           COALESCE(AVG(stake), 0) as avg_stake,
           COALESCE(MAX(CASE WHEN profit > 0 THEN profit END), 0) as largest_win,
           COALESCE(MIN(CASE WHEN profit < 0 THEN profit END), 0) as largest_loss
         FROM trade_journal
         WHERE account_id = $1`,
        [accountId]
      );

      const row = result.rows[0];
      const totalTrades = Number(row.total_trades);

      return {
        totalTrades,
        wins: Number(row.wins),
        losses: Number(row.losses),
        winRate: totalTrades > 0 ? (Number(row.wins) / totalTrades) * 100 : 0,
        totalProfit: Number(row.total_profit),
        averageStake: Number(row.avg_stake),
        largestWin: Number(row.largest_win),
        largestLoss: Number(row.largest_loss),
      };
    } catch (error) {
      console.error('[TradeJournal] Stats query failed:', error);
      return null;
    }
  }

  /**
   * Export trades as CSV
   */
  async exportTradesCSV(accountId: string | null, limit = 10000): Promise<string> {
    if (!this.pool || !accountId) return '';

    try {
      const result = await this.pool.query(
        `SELECT symbol, mode, stake, profit, result, duration, created_at
         FROM trade_journal
         WHERE account_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [accountId, limit]
      );

      const lines = ['symbol,mode,stake,profit,result,duration_seconds,created_at'];
      for (const row of result.rows) {
        lines.push(
          `${row.symbol},${row.mode},${row.stake},${row.profit ?? ''},${row.result ?? ''},${row.duration},${row.created_at}`
        );
      }
      return lines.join('\n');
    } catch (error) {
      console.error('[TradeJournal] Export failed:', error);
      return '';
    }
  }
}

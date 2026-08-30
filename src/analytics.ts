export interface TradeRecord {
  accountId: string;
  symbol: string;
  stake: number;
  profit: number;
  result: 'win' | 'loss';
  duration: number;
  timestamp?: string;
}

export interface KPIMetrics {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalProfit: number;
  avgStake: number;
  largestWin: number;
  largestLoss: number;
  drawdown: number;
  maxDrawdown: number;
  avgDuration: number;
}

export interface AnalyticsOptions {
  initialBalance?: number;
}

export function createAnalyticsEngine(options: AnalyticsOptions = {}) {
  const initialBalance = options.initialBalance ?? 10000;
  const trades = new Map<string, TradeRecord[]>();

  return {
    recordTrade(trade: TradeRecord): void {
      const accountId = trade.accountId;
      if (!trades.has(accountId)) {
        trades.set(accountId, []);
      }

      const accountTrades = trades.get(accountId)!;
      accountTrades.push({
        ...trade,
        timestamp: trade.timestamp ?? new Date().toISOString(),
      });
    },

    getKPIs(accountId: string): KPIMetrics {
      const accountTrades = trades.get(accountId) ?? [];

      if (accountTrades.length === 0) {
        return {
          totalTrades: 0,
          wins: 0,
          losses: 0,
          winRate: 0,
          totalProfit: 0,
          avgStake: 0,
          largestWin: 0,
          largestLoss: 0,
          drawdown: 0,
          maxDrawdown: 0,
          avgDuration: 0,
        };
      }

      let balance = initialBalance;
      let maxBalance = initialBalance;
      let maxDrawdown = 0;

      const wins = accountTrades.filter((t) => t.result === 'win').length;
      const losses = accountTrades.filter((t) => t.result === 'loss').length;
      const totalProfit = accountTrades.reduce((sum, t) => sum + t.profit, 0);
      const avgStake = accountTrades.reduce((sum, t) => sum + t.stake, 0) / accountTrades.length;
      const largestWin = Math.max(...accountTrades.map((t) => (t.result === 'win' ? t.profit : 0)), 0);
      const largestLoss = Math.min(...accountTrades.map((t) => (t.result === 'loss' ? t.profit : 0)), 0);
      const avgDuration = accountTrades.reduce((sum, t) => sum + t.duration, 0) / accountTrades.length;

      for (const trade of accountTrades) {
        balance += trade.profit;
        if (balance > maxBalance) {
          maxBalance = balance;
        }
        const dd = maxBalance - balance;
        if (dd > maxDrawdown) {
          maxDrawdown = dd;
        }
      }

      return {
        totalTrades: accountTrades.length,
        wins,
        losses,
        winRate: wins / accountTrades.length,
        totalProfit,
        avgStake,
        largestWin,
        largestLoss,
        drawdown: maxBalance - balance,
        maxDrawdown,
        avgDuration,
      };
    },

    exportTradeHistoryCSV(accountId: string): string {
      const accountTrades = trades.get(accountId) ?? [];

      if (accountTrades.length === 0) {
        return 'symbol,stake,profit,result,duration,timestamp\n';
      }

      const header = 'symbol,stake,profit,result,duration,timestamp\n';
      const rows = accountTrades
        .map((trade) => `${trade.symbol},${trade.stake},${trade.profit},${trade.result},${trade.duration},${trade.timestamp}`)
        .join('\n');

      return header + rows;
    },

    getAllTrades(accountId: string): TradeRecord[] {
      return [...(trades.get(accountId) ?? [])];
    },

    clear(accountId?: string): void {
      if (accountId) {
        trades.delete(accountId);
      } else {
        trades.clear();
      }
    },
  };
}

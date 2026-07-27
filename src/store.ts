import { v4 as uuid } from 'uuid';
import type { TradeLog, TradeStats, RunnerState, TradeStatus, TradeConfig } from './types.js';

interface CopyFollower {
  id: number;
  name: string;
  token: string;
  connection_type: 'pat' | 'oauth2';
  oauth_account_id: string | null;
  copy_ratio: number;
  max_stake: number;
  active: number;
  created_at: string;
  total_trades: number;
  total_pnl: number;
}

interface CopyTradeLog {
  id: number;
  timestamp: string;
  master_signal_id: number;
  master_contract_id: number;
  follower_id: number;
  follower_name: string;
  follower_contract_id: number | null;
  stake: number;
  status: string;
  error_msg: string | null;
  payout: number;
  profit: number;
  closed_at: string | null;
}

export class Store {
  isRunning = false;
  config: TradeConfig | null = null;
  stats: TradeStats = { totalTrades: 0, wins: 0, losses: 0, totalProfit: 0, status: 'idle' };
  logs: TradeLog[] = [];
  leg1: RunnerState = { label: 'Leg 1', contractType: 'CALL', currentStake: 0, isTrading: false, activeContractId: null, lastResult: null, profit: 0 };
  leg2: RunnerState = { label: 'Leg 2', contractType: 'PUT', currentStake: 0, isTrading: false, activeContractId: null, lastResult: null, profit: 0 };
  leg3: RunnerState = { label: 'Leg 3', contractType: 'DIGITMATCH', currentStake: 0, isTrading: false, activeContractId: null, lastResult: null, profit: 0 };

  private wsClients: Set<(data: TradeStatus) => void> = new Set();
  private logWsClients: Set<(log: TradeLog) => void> = new Set();

  // ── Copy Trading data ──
  private followers: Map<number, CopyFollower> = new Map();
  private tradeLogs: CopyTradeLog[] = [];
  private fIdCounter = 1;

  // Copy pool reference (set from index.ts)
  copyPoolRef: { replicationTrade: (...args: any[]) => Promise<void>; resolveOutcomes: (...args: any[]) => Promise<void>; } | null = null;

  addLog(message: string, type: TradeLog['type'] = 'info') {
    const log: TradeLog = {
      id: uuid().slice(0, 8),
      timestamp: new Date().toLocaleTimeString(),
      type,
      message,
    };
    this.logs.unshift(log);
    if (this.logs.length > 500) this.logs.pop();
    this.logWsClients.forEach(fn => fn(log));
    return log;
  }

  getStatus(): TradeStatus {
    return {
      isRunning: this.isRunning,
      stats: this.stats,
      logs: this.logs.slice(0, 100),
      leg1: this.leg1,
      leg2: this.leg2,
      leg3: this.leg3,
    };
  }

  subscribe(cb: (data: TradeStatus) => void) { this.wsClients.add(cb); }
  unsubscribe(cb: (data: TradeStatus) => void) { this.wsClients.delete(cb); }
  subscribeLogs(cb: (log: TradeLog) => void) { this.logWsClients.add(cb); }
  unsubscribeLogs(cb: (log: TradeLog) => void) { this.logWsClients.delete(cb); }

  broadcast() { this.wsClients.forEach(fn => fn(this.getStatus())); }

  reset(config: TradeConfig) {
    this.config = config;
    this.isRunning = true;
    this.stats = { totalTrades: 0, wins: 0, losses: 0, totalProfit: 0, status: 'running' };
    this.logs = [];
    this.leg1 = { label: 'Leg 1', contractType: 'CALL', currentStake: config.baseStake, isTrading: false, activeContractId: null, lastResult: null, profit: 0 };
    this.leg2 = { label: 'Leg 2', contractType: 'PUT', currentStake: config.baseStake2 ?? config.baseStake, isTrading: false, activeContractId: null, lastResult: null, profit: 0 };
    this.leg3 = { label: 'Leg 3', contractType: 'DIGITMATCH', currentStake: config.baseStake, isTrading: false, activeContractId: null, lastResult: null, profit: 0 };
  }

  stop(reason?: string) {
    this.isRunning = false;
    this.stats.status = reason ? 'stopped' : 'completed';
    if (reason) this.addLog(`[System] Stopped: ${reason}`, 'warn');
    this.broadcast();
  }

  // ── Copy Trading Follower methods ──
  addFollower(name: string, token: string, connectionType: 'pat' | 'oauth2', copyRatio: number, maxStake: number, oauthAccountId?: string): number {
    const id = this.fIdCounter++;
    const follower: CopyFollower = {
      id, name, token, connection_type: connectionType,
      oauth_account_id: oauthAccountId || null,
      copy_ratio: copyRatio, max_stake: maxStake,
      active: 1, created_at: new Date().toISOString(),
      total_trades: 0, total_pnl: 0,
    };
    this.followers.set(id, follower);
    return id;
  }

  getFollowers(): CopyFollower[] {
    return Array.from(this.followers.values()).sort((a, b) => b.id - a.id);
  }

  getFollower(id: number): CopyFollower | undefined {
    return this.followers.get(id);
  }

  toggleFollower(id: number, active: boolean) {
    const f = this.followers.get(id);
    if (f) { f.active = active ? 1 : 0; }
  }

  deleteFollower(id: number) {
    this.followers.delete(id);
  }

  logCopyTrade(entry: Omit<CopyTradeLog, 'id'>): number {
    const id = this.tradeLogs.length + 1;
    this.tradeLogs.unshift({ id, ...entry });
    if (this.tradeLogs.length > 500) this.tradeLogs.pop();
    return id;
  }

  updateCopyTradeOutcome(followerContractId: number, status: string, payout: number, profit: number, closedAt: string) {
    const log = this.tradeLogs.find(l => l.follower_contract_id === followerContractId);
    if (log) {
      log.status = status;
      log.payout = payout;
      log.profit = profit;
      log.closed_at = closedAt;
    }
  }

  getCopyTradeLogs(limit = 50): CopyTradeLog[] {
    return this.tradeLogs.slice(0, limit);
  }
}

export const store = new Store();
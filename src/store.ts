import { v4 as uuid } from 'uuid';
import type { TradeLog, TradeStats, RunnerState, TradeStatus, TradeConfig } from './types.js';

class Store {
  isRunning = false;
  config: TradeConfig | null = null;
  stats: TradeStats = { totalTrades: 0, wins: 0, losses: 0, totalProfit: 0, status: 'idle' };
  logs: TradeLog[] = [];
  leg1: RunnerState = { label: 'Leg 1', contractType: 'CALL', currentStake: 0, isTrading: false, activeContractId: null, lastResult: null, profit: 0 };
  leg2: RunnerState = { label: 'Leg 2', contractType: 'PUT', currentStake: 0, isTrading: false, activeContractId: null, lastResult: null, profit: 0 };
  leg3: RunnerState = { label: 'Leg 3', contractType: 'DIGITMATCH', currentStake: 0, isTrading: false, activeContractId: null, lastResult: null, profit: 0 };

  private wsClients: Set<(data: TradeStatus) => void> = new Set();
  private logWsClients: Set<(log: TradeLog) => void> = new Set();

  addLog(message: string, type: TradeLog['type'] = 'info') {
    const log: TradeLog = {
      id: uuid().slice(0, 8),
      timestamp: new Date().toLocaleTimeString(),
      type,
      message,
    };
    this.logs.push(log);
    if (this.logs.length > 500) this.logs.shift();
    this.logWsClients.forEach(fn => fn(log));
    return log;
  }

  getStatus(): TradeStatus {
    return {
      isRunning: this.isRunning,
      stats: this.stats,
      logs: this.logs.slice(-100),
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
}

export const store = new Store();

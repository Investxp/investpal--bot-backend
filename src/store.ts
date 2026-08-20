import { v4 as uuid } from 'uuid';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { TradeLog, TradeStats, RunnerState, TradeStatus, TradeConfig } from './types.js';

type CopyType = 'demo_to_demo' | 'demo_to_live' | 'live_to_live' | 'live_to_demo';
export type { CopyType };

interface CopyFollower {
  id: number;
  name: string;
  token: string;
  connection_type: 'pat' | 'oauth2';
  oauth_account_id: string | null;
  copy_type: CopyType;
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
  addFollower(name: string, token: string, connectionType: 'pat' | 'oauth2', copyType: CopyType, copyRatio: number, maxStake: number, oauthAccountId?: string): number {
    const id = this.fIdCounter++;
    const follower: CopyFollower = {
      id, name, token, connection_type: connectionType,
      oauth_account_id: oauthAccountId || null,
      copy_type: copyType, copy_ratio: copyRatio, max_stake: maxStake,
      active: 1, created_at: new Date().toISOString(),
      total_trades: 0, total_pnl: 0,
    };
    this.followers.set(id, follower);
    this.saveFollowers();
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
    if (f) { f.active = active ? 1 : 0; this.saveFollowers(); }
  }

  updateFollower(id: number, patch: Partial<Pick<CopyFollower, 'copy_type' | 'copy_ratio' | 'max_stake' | 'active'>>) {
    const f = this.followers.get(id);
    if (!f) return false;
    Object.assign(f, patch);
    this.saveFollowers();
    return true;
  }

  deleteFollower(id: number) {
    this.followers.delete(id);
    this.saveFollowers();
  }

  private readonly FOLLOWER_FILE = path.resolve('followers.json');

  /**
   * Credential encryption (AES-256-GCM).
   * Secret comes from STORE_SECRET (fallback: API_AUTH_TOKEN).
   * Without a secret, follower credentials are NEVER written to disk —
   * they stay in memory only. This prevents Deriv API tokens / OAuth
   * tokens from sitting in plaintext on disk.
   */
  private getSecret(): string {
    return process.env.STORE_SECRET || process.env.API_AUTH_TOKEN || '';
  }

  private encryptText(plain: string): string | null {
    const secret = this.getSecret();
    if (!secret) return null;
    const key = crypto.createHash('sha256').update(secret).digest();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `enc:v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
  }

  private decryptText(payload: string): string | null {
    const secret = this.getSecret();
    if (!secret) return null;
    try {
      const parts = payload.split(':');
      if (parts[0] !== 'enc' || parts[1] !== 'v1') return null;
      const key = crypto.createHash('sha256').update(secret).digest();
      const iv = Buffer.from(parts[2], 'base64');
      const tag = Buffer.from(parts[3], 'base64');
      const data = Buffer.from(parts[4], 'base64');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    } catch {
      return null;
    }
  }

  private saveFollowers() {
    try {
      const data = JSON.stringify(Array.from(this.followers.values()), null, 2);
      const encrypted = this.encryptText(data);
      if (!encrypted) {
        this.addLog('[Security] STORE_SECRET not set — follower credentials kept in memory only, NOT persisted to disk', 'warn');
        return;
      }
      fs.writeFileSync(this.FOLLOWER_FILE, encrypted, 'utf-8');
    } catch { /* silent */ }
  }

  loadFollowers() {
    try {
      if (!fs.existsSync(this.FOLLOWER_FILE)) return;
      const raw = fs.readFileSync(this.FOLLOWER_FILE, 'utf-8');

      let json = raw;
      const decrypted = this.decryptText(raw);
      if (decrypted) {
        json = decrypted;
      } else if (raw.trimStart().startsWith('{') || raw.trimStart().startsWith('[')) {
        // Legacy plaintext file — migrate in-place on next save
        this.addLog('[Security] followers.json contains PLAINTEXT credentials — re-encrypting on next follower change (set STORE_SECRET)', 'warn');
      } else {
        this.addLog('[Security] followers.json could not be decrypted (wrong STORE_SECRET?) — ignoring file', 'error');
        return;
      }

      const arr: CopyFollower[] = JSON.parse(json);
      for (const f of arr) {
        this.followers.set(f.id, f);
        if (f.id >= this.fIdCounter) this.fIdCounter = f.id + 1;
      }
    } catch { /* silent */ }
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
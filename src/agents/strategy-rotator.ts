import { AgentEngine, AgentDecision } from '../agent-engine.js';
import type { AutoTradeMode } from '../types.js';

interface StrategyRecord {
  mode: AutoTradeMode;
  wins: number;
  losses: number;
  consecutiveWins: number;
  consecutiveLosses: number;
  totalTrades: number;
  lastUsed: number;
}

export class StrategyRotatorAgent extends AgentEngine {
  readonly agentType = 'strategy-rotator';
  private strategies: Map<string, StrategyRecord> = new Map();
  private currentStrategyIndex = 0;
  private cooldownStrategies: Set<string> = new Set();
  private noTradeCooldown = 0;

  constructor() {
    super('strategy-rotator');
  }

  protected async gatherMarketContext(): Promise<string> {
    const pool = this.config.strategyPool || [
      'rise-fall', 'digits-even-odd', 'digits-match-differ',
      'accumulators', 'rise-only', 'fall-only', 'even-only', 'odd-only',
    ] as AutoTradeMode[];
    return `Available strategies: ${pool.length}. Current: ${this.status.currentStrategy}`;
  }

  protected async decide(): Promise<AgentDecision> {
    const pool = this.config.strategyPool || [
      'rise-fall', 'digits-even-odd', 'digits-match-differ',
      'accumulators', 'rise-only', 'fall-only', 'even-only', 'odd-only',
    ] as AutoTradeMode[];

    if (this.noTradeCooldown > 0) {
      this.noTradeCooldown--;
      return { action: 'wait', reasoning: `Cooling down (${this.noTradeCooldown} rounds remaining)` };
    }

    // Initialize records for new strategies
    for (const s of pool) {
      if (!this.strategies.has(s)) {
        this.strategies.set(s, { mode: s, wins: 0, losses: 0, consecutiveWins: 0, consecutiveLosses: 0, totalTrades: 0, lastUsed: 0 });
      }
    }

    const now = Date.now();
    const recentHistory = this.status.decisionHistory.slice(-20);
    const recentLosses = recentHistory.filter(d => d.action === 'trade').length > 3
      && this.status.losses > this.status.wins;

    // Score strategies
    let scored = pool.map(s => {
      const rec = this.strategies.get(s)!;
      const winRate = rec.totalTrades > 0 ? rec.wins / rec.totalTrades : 0.5;
      const recency = rec.lastUsed > 0 ? (now - rec.lastUsed) / 1000 : 999;
      const cooldownPenalty = this.cooldownStrategies.has(s) ? -50 : 0;
      const score = winRate * 40 + Math.min(recency, 300) / 300 * 30 + Math.random() * 20 + cooldownPenalty;
      return { mode: s, score, rec };
    });

    scored.sort((a, b) => b.score - a.score);

    // If recent losses, switch to a different strategy
    if (recentLosses) {
      scored = scored.filter(s => s.mode !== this.status.currentStrategy);
      this.log(`Recent losses detected — avoiding ${this.status.currentStrategy}`);
    }

    const best = scored[0];
    if (!best) return { action: 'wait', reasoning: 'No strategy available' };

    const stake = this.calculateStake(best.rec);

    this.currentStrategyIndex = pool.indexOf(best.mode);
    best.rec.lastUsed = now;

    return {
      action: 'trade',
      strategy: best.mode,
      stake,
      duration: best.mode.includes('digit') ? 3 : 5,
      reasoning: `Picked ${best.mode} (win rate: ${best.rec.totalTrades > 0 ? Math.round(best.rec.wins / best.rec.totalTrades * 100) : 50}%, score: ${best.score.toFixed(0)})`,
    };
  }

  private calculateStake(rec: StrategyRecord): number {
    const base = this.config.baseStake;
    if (rec.totalTrades < 3) return base;
    const winRate = rec.wins / rec.totalTrades;
    if (winRate > 0.6) return base * 1.5;
    if (winRate < 0.4) return base * 0.5;
    return base;
  }
}

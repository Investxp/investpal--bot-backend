import { BaseEngine } from './engine-base.js';
import { store } from './store.js';
import type { TradeConfig } from './types.js';

const SX_API = 'https://api.sx.bet';

interface SXConfig extends TradeConfig {
  sxPrivateKey?: string;
  sxWalletAddress?: string;
  sxConditionId?: string;
  sxOutcomeId?: string;
  sxSide?: 'HOME' | 'AWAY' | 'DRAW';
  sxStake?: number;
  sxOdds?: number;
  sxBetfairSessionToken?: string;
}

export class SXEngine extends BaseEngine {
  get platform() { return 'sx'; }
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  async start(config: SXConfig) {
    this.config = config;
    this._isRunning = true;
    store.reset(config);
    store.addLog('[SX Bet] Engine starting', 'info');
    store.broadcast();

    this.pollLoop();
  }

  private async pollLoop() {
    while (this._isRunning) {
      try {
        await this.executeRound();
      } catch (err: any) {
        store.addLog(`[SX Bet] Round error: ${err.message}`, 'error');
        store.broadcast();
      }
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  private async executeRound() {
    const cfg = this.config as SXConfig;
    if (this.limitsHit()) return;

    store.leg1.isTrading = true;
    store.broadcast();

    try {
      store.addLog(`[SX Bet] Fetching markets...`, 'info');
      const markets = await this.fetchMarkets(cfg);
      if (markets.length === 0) { store.addLog('[SX Bet] No markets available', 'warn'); store.leg1.isTrading = false; store.broadcast(); return; }

      const market = markets[0];
      store.addLog(`[SX Bet] Market: ${market.homeTeam} vs ${market.awayTeam}`, 'info');
      store.leg1.label = `${market.homeTeam} vs ${market.awayTeam}`;

      const outcome = cfg.sxOutcomeId || market.outcomes?.[0]?.id;
      const side = cfg.sxSide || 'HOME';
      const odds = cfg.sxOdds || market.outcomes?.find((o: any) => o.name === side)?.odds || 2.0;
      const stake = cfg.sxStake || cfg.baseStake;

      store.addLog(`[SX Bet] Placing bet on ${side} @ ${odds} x $${stake}`, 'info');

      const result = await this.placeBet(cfg, market.id, outcome, side, stake, odds);
      if (result) {
        store.stats.totalTrades++;
        store.leg1.currentStake = stake;
        store.addLog(`[SX Bet] Bet placed successfully`, 'success');
      }
    } catch (err: any) {
      store.addLog(`[SX Bet] Error: ${err.message}`, 'error');
    }

    store.leg1.isTrading = false;
    store.broadcast();
  }

  private async fetchMarkets(cfg: SXConfig): Promise<any[]> {
    const resp = await fetch(`${SX_API}/v1/markets`, {
      headers: { 'Accept': 'application/json' },
    });
    if (!resp.ok) throw new Error(`SX API error: ${resp.status}`);
    return resp.json() as Promise<any[]>;
  }

  private async placeBet(cfg: SXConfig, marketId: string, outcomeId: string, side: string, stake: number, odds: number) {
    // SX Bet uses EIP-712 typed data signing
    // Simplified: send to the SX API with wallet signature
    const order = {
      marketId,
      outcomeId,
      side: side.toLowerCase(),
      stake: String(stake),
      odds: String(odds),
      walletAddress: cfg.sxWalletAddress,
    };

    const resp = await fetch(`${SX_API}/v1/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(order),
    });
    if (!resp.ok) throw new Error(`SX order failed: ${resp.status} ${await resp.text()}`);
    return resp.json();
  }

  private limitsHit(): boolean {
    const cfg = this.config as SXConfig;
    if (!this._isRunning) return true;
    if (cfg.takeProfit > 0 && store.stats.totalProfit >= cfg.takeProfit) { this.stop('Take profit reached'); return true; }
    if (cfg.stopLoss > 0 && store.stats.totalProfit <= -cfg.stopLoss) { this.stop('Stop loss hit'); return true; }
    if (cfg.maxTradesLimit && store.stats.totalTrades >= cfg.maxTradesLimit) { this.stop('Max trades reached'); return true; }
    return false;
  }

  async stop(reason?: string) {
    this._isRunning = false;
    store.stop(reason);
  }
}

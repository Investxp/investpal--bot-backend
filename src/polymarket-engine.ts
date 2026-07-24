import { BaseEngine } from './engine-base.js';
import { store } from './store.js';
import type { TradeConfig } from './types.js';

const GAMMA_API = 'https://gamma-api.polymarket.com';
const CLOB_API = 'https://clob.polymarket.com';

interface PolymarketConfig extends TradeConfig {
  polymarketPrivateKey?: string;
  polymarketApiKey?: string;
  polymarketApiSecret?: string;
  polymarketPassphrase?: string;
  polymarketConditionId?: string;
  polymarketTokenId?: string;
  polymarketSide?: 'BUY' | 'SELL';
  polymarketPrice?: number;
  polymarketSize?: number;
}

export class PolymarketEngine extends BaseEngine {
  get platform() { return 'polymarket'; }
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastOrderIds: string[] = [];

  async start(config: PolymarketConfig) {
    this.config = config;
    this._isRunning = true;
    store.reset(config);
    store.addLog('[Polymarket] Engine starting', 'info');
    store.broadcast();

    this.pollLoop();
  }

  private async pollLoop() {
    while (this._isRunning) {
      try {
        await this.executeRound();
      } catch (err: any) {
        store.addLog(`[Polymarket] Round error: ${err.message}`, 'error');
        store.broadcast();
      }
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  private async executeRound() {
    const cfg = this.config as PolymarketConfig;
    const size = cfg.polymarketSize ?? 10;
    const price = cfg.polymarketPrice ?? 0.5;
    const side = cfg.polymarketSide ?? 'BUY';

    // Check limits
    if (this.limitsHit()) return;

    store.leg1.isTrading = true;
    store.broadcast();
    store.addLog(`[Polymarket] Placing ${side} order at $${price} x ${size}`, 'info');

    try {
      const result = await this.placeOrder(cfg, side, price, size);
      if (result?.id) {
        this.lastOrderIds.push(result.id);
        store.leg1.lastResult = 'win';
        store.leg1.currentStake = size;
        store.stats.totalTrades++;
        store.stats.totalProfit += (side === 'BUY' ? (1 - price) * size : price * size);
        store.addLog(`[Polymarket] Order ${result.id} placed`, 'success');
      }
    } catch (err: any) {
      store.addLog(`[Polymarket] Order failed: ${err.message}`, 'error');
    }

    store.leg1.isTrading = false;
    store.broadcast();
  }

  private async placeOrder(cfg: PolymarketConfig, side: string, price: number, size: number) {
    const tokenId = cfg.polymarketTokenId;
    if (!tokenId) throw new Error('Missing polymarketTokenId');

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (cfg.polymarketApiKey) {
      headers['POLY-API-KEY'] = cfg.polymarketApiKey;
      headers['POLY-API-SECRET'] = cfg.polymarketApiSecret ?? '';
      headers['POLY-API-PASSPHRASE'] = cfg.polymarketPassphrase ?? '';
    }

    const resp = await fetch(`${CLOB_API}/orders`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        token_id: tokenId,
        side,
        price: String(price),
        size: String(size),
        owner: cfg.polymarketPrivateKey ? '0x' + cfg.polymarketPrivateKey.slice(-40) : undefined,
      }),
    });
    if (!resp.ok) throw new Error(`CLOB order failed: ${resp.status} ${await resp.text()}`);
    return resp.json() as any;
  }

  private limitsHit(): boolean {
    const cfg = this.config as PolymarketConfig;
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

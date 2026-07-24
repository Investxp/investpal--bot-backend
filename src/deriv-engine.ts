import { BaseEngine } from './engine-base.js';
import { DerivClient } from './deriv-ws.js';
import { TradeEngine } from './trade-engine.js';
import type { TradeConfig } from './types.js';

export class DerivEngine extends BaseEngine {
  get platform() { return 'deriv'; }
  private engine: TradeEngine;

  constructor(deriv: DerivClient) {
    super();
    this.engine = new TradeEngine(deriv);
  }

  async start(config: TradeConfig) {
    this.config = config;
    this._isRunning = true;
    this.engine.start(config);
  }

  async stop(reason?: string) {
    this._isRunning = false;
    this.engine.stop(reason);
  }
}

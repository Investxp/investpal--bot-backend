import type { TradeConfig } from './types.js';

export abstract class BaseEngine {
  abstract get platform(): string;
  protected config!: TradeConfig;
  protected _isRunning = false;

  get isRunning() { return this._isRunning; }

  abstract start(config: TradeConfig): Promise<void>;
  abstract stop(reason?: string): Promise<void>;
}

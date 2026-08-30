import type { TradeConfig } from './types.js';

export interface MarketEvent {
  symbol: string;
  quote: number;
  epoch: number;
}

export interface StrategySignal {
  direction: string;
  confidence: number | null;
  riskScore: number | null;
  generatedAt: string;
  modelVersion?: string;
}

export interface StrategyContext {
  config: TradeConfig;
  accountId: string | null;
  emitSignal(signal: StrategySignal): void;
  requestExecution(input: { symbol: string; contractType: string; stake: number }): Promise<void>;
}

export interface Strategy {
  readonly id: string;
  readonly version: string;
  initialize(context: StrategyContext): Promise<void> | void;
  onMarketData(event: MarketEvent): Promise<StrategySignal | null> | StrategySignal | null;
  onResult(result: { won: boolean; profit: number }): Promise<void> | void;
  reset(): Promise<void> | void;
  shutdown(): Promise<void> | void;
}

export function validateSignal(signal: StrategySignal): void {
  if (!signal.direction.trim()) throw new Error('Strategy signal direction is required');
  if (signal.confidence !== null && (!Number.isFinite(signal.confidence) || signal.confidence < 0 || signal.confidence > 1)) {
    throw new Error('Strategy signal confidence must be between 0 and 1');
  }
  if (signal.riskScore !== null && (!Number.isInteger(signal.riskScore) || signal.riskScore < 0 || signal.riskScore > 100)) {
    throw new Error('Strategy signal risk score must be between 0 and 100');
  }
}

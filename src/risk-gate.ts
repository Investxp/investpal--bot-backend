import type { TradeConfig, RunnerState, TradeStats } from './types.js';

export type RiskDecision =
  | { approved: true; normalizedConfig: TradeConfig; warnings: string[] }
  | { approved: false; reasons: string[] };

export type TradeRiskDecision =
  | { approved: true; warnings: string[] }
  | { approved: false; reason: string };

const MAX_RECOVERY_MULTIPLIER = 25;
const MAX_DURATION = 365;

export function evaluateTradeConfig(config: TradeConfig): RiskDecision {
  const reasons: string[] = [];
  const warnings: string[] = [];

  if (!config || typeof config !== 'object') {
    return { approved: false, reasons: ['Trade configuration is required'] };
  }

  if (!config.platform) reasons.push('Trading platform is required');
  if (config.executionMode !== undefined && !['backtest', 'paper', 'demo', 'live'].includes(config.executionMode)) {
    reasons.push('Invalid execution mode');
  }
  if (!config.mode) reasons.push('Trading mode is required');
  if (!config.symbol?.trim()) reasons.push('Market symbol is required');
  if (!Number.isFinite(config.baseStake) || config.baseStake <= 0) reasons.push('Base stake must be greater than zero');
  if (config.baseStake2 !== undefined && (!Number.isFinite(config.baseStake2) || config.baseStake2 <= 0)) {
    reasons.push('Second-leg stake must be greater than zero');
  }
  if (!Number.isInteger(config.duration) || config.duration <= 0 || config.duration > MAX_DURATION) {
    reasons.push(`Duration must be an integer from 1 to ${MAX_DURATION}`);
  }
  if (!['t', 's', 'm', 'h', 'd'].includes(config.durationUnit)) reasons.push('Invalid duration unit');
  if (!Number.isFinite(config.martingaleMultiplier) || config.martingaleMultiplier <= 0) {
    reasons.push('Recovery multiplier must be greater than zero');
  }
  if (config.martingaleMultiplier > MAX_RECOVERY_MULTIPLIER) {
    reasons.push(`Recovery multiplier cannot exceed ${MAX_RECOVERY_MULTIPLIER}x`);
  }
  if (config.maxStake !== undefined && (!Number.isFinite(config.maxStake) || config.maxStake <= 0)) {
    reasons.push('Maximum stake must be greater than zero');
  }
  if (config.maxStake !== undefined && config.maxStake < config.baseStake) {
    reasons.push('Maximum stake cannot be below the base stake');
  }
  if (!Number.isFinite(config.takeProfit) || config.takeProfit < 0) reasons.push('Take-profit must be zero or greater');
  if (!Number.isFinite(config.stopLoss) || config.stopLoss < 0) reasons.push('Stop-loss must be zero or greater');
  if (config.maxTradesLimit !== undefined && (!Number.isInteger(config.maxTradesLimit) || config.maxTradesLimit < 0)) {
    reasons.push('Maximum trades must be zero or a positive integer');
  }

  const digits = [...(config.selectedDigit || []), ...(config.selectedDigit2 || [])];
  if (digits.some((digit) => !Number.isInteger(digit) || digit < 0 || digit > 9)) {
    reasons.push('Selected digits must be integers from 0 to 9');
  }

  if (config.isHedgeMode && config.baseStake2 === undefined) {
    warnings.push('Hedge mode has no second-leg stake; base stake will be reused');
  }
  if (config.martingaleMultiplier > 5) {
    warnings.push('Recovery multiplier above 5x creates high capital escalation risk');
  }

  if (reasons.length > 0) return { approved: false, reasons };

  const normalizedConfig: TradeConfig = {
    ...config,
    symbol: config.symbol.trim(),
    baseStake: roundMoney(config.baseStake),
    baseStake2: config.baseStake2 === undefined ? undefined : roundMoney(config.baseStake2),
    maxStake: config.maxStake === undefined
      ? roundMoney(config.baseStake * MAX_RECOVERY_MULTIPLIER)
      : roundMoney(config.maxStake),
  };

  return { approved: true, normalizedConfig, warnings };
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Validate a trade at execution time (per-trade risk gate).
 * This runs AFTER the start-time risk gate and checks conditions that change during trading.
 */
export function evaluateTradeRisk(
  config: TradeConfig,
  currentStake: number,
  stats: TradeStats,
  legState: RunnerState
): TradeRiskDecision {
  if (currentStake > (config.maxStake || config.baseStake * MAX_RECOVERY_MULTIPLIER)) {
    return { approved: false, reason: `Trade stake (${currentStake}) exceeds configured maximum (${config.maxStake || config.baseStake * MAX_RECOVERY_MULTIPLIER})` };
  }

  if (config.stopLoss > 0 && stats.totalProfit < -config.stopLoss) {
    return { approved: false, reason: `Stop-loss triggered: current loss (${Math.abs(stats.totalProfit)}) exceeds limit (${config.stopLoss})` };
  }

  if (config.takeProfit > 0 && stats.totalProfit >= config.takeProfit) {
    return { approved: false, reason: `Take-profit target reached: profit (${stats.totalProfit}) meets or exceeds target (${config.takeProfit})` };
  }

  if (config.maxTradesLimit && config.maxTradesLimit > 0 && stats.totalTrades >= config.maxTradesLimit) {
    return { approved: false, reason: `Maximum trades limit reached: ${stats.totalTrades} of ${config.maxTradesLimit}` };
  }

  if (legState && legState.profit < 0 && Math.abs(legState.profit) > currentStake * 3) {
    return { approved: false, reason: `Excessive leg loss detected: ${legState.profit}` };
  }

  return { approved: true, warnings: [] };
}

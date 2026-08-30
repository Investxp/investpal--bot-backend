import { randomUUID } from 'crypto';

export interface StrategyRule {
  ruleId: string;
  type: string;
  params: Record<string, number>;
  action: 'BUY' | 'SELL';
}

export interface StrategyConfig {
  strategyId: string;
  name?: string;
  description?: string;
  symbol: string;
  timeframe?: string;
  rules: StrategyRule[];
  stake?: number;
  maxExposure?: number;
  maxDrawdown?: number;
}

export interface Strategy extends StrategyConfig {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface DeployedStrategy extends Strategy {
  deployedAt: string;
  status: 'active' | 'archived' | 'suspended';
}

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
}

const VALID_SYMBOLS = ['R_100', 'R_50', 'EURUSD', 'GBPUSD', 'USDJPY'];
const VALID_RULE_TYPES = ['sma_cross', 'ema_cross', 'rsi', 'macd', 'bollinger'];

export function createStrategyDSL() {
  const strategies = new Map<string, DeployedStrategy>();
  const history = new Map<string, Strategy[]>();

  return {
    createStrategy(config: StrategyConfig): Strategy {
      const strategy: Strategy = {
        ...config,
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      return strategy;
    },

    validate(config: StrategyConfig): ValidationResult {
      const errors: string[] = [];

      if (!config.strategyId || config.strategyId.trim().length === 0) {
        errors.push('strategyId is required and cannot be empty');
      }

      if (!config.symbol || !VALID_SYMBOLS.includes(config.symbol)) {
        errors.push(`symbol must be one of: ${VALID_SYMBOLS.join(', ')}`);
      }

      if (config.stake && config.stake <= 0) {
        errors.push('stake must be greater than 0');
      }

      if (config.rules && Array.isArray(config.rules)) {
        for (const rule of config.rules) {
          if (!VALID_RULE_TYPES.includes(rule.type)) {
            errors.push(`rule type must be one of: ${VALID_RULE_TYPES.join(', ')}`);
          }
          if (!rule.action || !['BUY', 'SELL'].includes(rule.action)) {
            errors.push('rule action must be BUY or SELL');
          }
        }
      }

      return {
        isValid: errors.length === 0,
        errors,
      };
    },

    deployStrategy(config: StrategyConfig): DeployedStrategy {
      const validation = this.validate(config);
      if (!validation.isValid) {
        throw new Error(`Invalid strategy configuration: ${validation.errors.join('; ')}`);
      }

      const strategy: Strategy = this.createStrategy(config);
      const deployed: DeployedStrategy = {
        ...strategy,
        deployedAt: new Date().toISOString(),
        status: 'active',
      };

      strategies.set(config.strategyId, deployed);

      if (!history.has(config.strategyId)) {
        history.set(config.strategyId, []);
      }
      history.get(config.strategyId)!.push(strategy);

      return deployed;
    },

    getStrategy(strategyId: string): DeployedStrategy | null {
      return strategies.get(strategyId) ?? null;
    },

    getVersionHistory(strategyId: string): Strategy[] {
      return [...(history.get(strategyId) ?? [])];
    },

    getAllStrategies(): DeployedStrategy[] {
      return Array.from(strategies.values());
    },

    updateStatus(strategyId: string, status: 'active' | 'archived' | 'suspended'): DeployedStrategy | null {
      const strategy = strategies.get(strategyId);
      if (!strategy) return null;

      const updated: DeployedStrategy = {
        ...strategy,
        status,
        updatedAt: new Date().toISOString(),
      };

      strategies.set(strategyId, updated);
      return updated;
    },

    clear(): void {
      strategies.clear();
      history.clear();
    },
  };
}

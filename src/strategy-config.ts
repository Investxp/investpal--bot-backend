export interface StrategyRuleSpec {
  type: 'sma_cross' | 'rsi' | 'macd' | 'bollinger';
  params: Record<string, number>;
  action: 'BUY' | 'SELL';
}

export interface StrategyRiskSpec {
  maxStake: number;
  maxLossPerTrade: number;
  stopLoss: number;
}

export interface StrategyConfigInput {
  strategyId?: string;
  name?: string;
  market?: string;
  entry?: StrategyRuleSpec;
  exit?: StrategyRuleSpec;
  risk?: Partial<StrategyRiskSpec>;
}

export interface StrategyConfigValidation {
  valid: boolean;
  errors: string[];
}

export interface CompiledStrategyConfig {
  strategyId: string;
  name: string;
  market: string;
  entry: StrategyRuleSpec;
  exit: StrategyRuleSpec;
  risk: StrategyRiskSpec;
  version: string;
  validation: StrategyConfigValidation;
}

export function createStrategyConfigDSL() {
  const versionHistory = new Map<string, CompiledStrategyConfig[]>();
  let versionCounter = new Map<string, number>();

  function compile(input: StrategyConfigInput): CompiledStrategyConfig {
    const errors: string[] = [];

    const strategyId = input.strategyId ?? `strategy-${Date.now()}`;
    if (!input.strategyId) {
      errors.push('strategyId is required');
    }

    if (!input.name || typeof input.name !== 'string' || input.name.trim().length === 0) {
      errors.push('name is required');
    }

    if (!input.market || typeof input.market !== 'string' || input.market.trim().length === 0) {
      errors.push('market is required');
    }

    if (!input.entry || !input.entry.type || !input.entry.action) {
      errors.push('entry rule is required');
    }

    if (!input.exit || !input.exit.type || !input.exit.action) {
      errors.push('exit rule is required');
    }

    const risk = {
      maxStake: input.risk?.maxStake ?? 0,
      maxLossPerTrade: input.risk?.maxLossPerTrade ?? 0,
      stopLoss: input.risk?.stopLoss ?? 0,
    };

    if (risk.maxStake <= 0) {
      errors.push('risk.maxStake must be greater than zero');
    }

    if (risk.maxLossPerTrade <= 0) {
      errors.push('risk.maxLossPerTrade must be greater than zero');
    }

    if (risk.stopLoss < 0) {
      errors.push('risk.stopLoss cannot be negative');
    }

    const normalizedEntry = input.entry ?? {
      type: 'sma_cross',
      params: {},
      action: 'BUY',
    };

    const normalizedExit = input.exit ?? {
      type: 'rsi',
      params: {},
      action: 'SELL',
    };

    const versionNumber = (versionCounter.get(strategyId) ?? 0) + 1;
    versionCounter.set(strategyId, versionNumber);

    const config: CompiledStrategyConfig = {
      strategyId,
      name: input.name ?? '',
      market: input.market ?? '',
      entry: normalizedEntry,
      exit: normalizedExit,
      risk,
      version: String(versionNumber),
      validation: {
        valid: errors.length === 0,
        errors,
      },
    };

    const history = versionHistory.get(strategyId) ?? [];
    history.push(config);
    versionHistory.set(strategyId, history);

    return config;
  }

  return {
    compile,
    getVersionHistory(strategyId: string): CompiledStrategyConfig[] {
      return [...(versionHistory.get(strategyId) ?? [])];
    },
    clear(): void {
      versionHistory.clear();
      versionCounter.clear();
    },
  };
}

import { randomUUID } from 'crypto';

export interface Candle {
  symbol: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface BacktestTrade {
  entryPrice: number;
  exitPrice: number;
  profit: number;
  duration: number;
}

export interface BacktestResult {
  backtestId: string;
  symbol: string;
  trades: BacktestTrade[];
  totalStake: number;
  totalProfit: number;
  executedAt: string;
}

export interface ModelVersion {
  modelId: string;
  version: string;
  type: string;
  hyperparameters: Record<string, any>;
  registeredAt: string;
}

export interface Prediction {
  predicted: 'up' | 'down';
  actual: 'up' | 'down';
  confidence: number;
}

export interface PredictionAccuracy {
  totalPredictions: number;
  correct: number;
  accuracy: number;
  avgConfidence: number;
  hasDrift: boolean;
  driftReason?: string;
}

export interface BacktestOptions {
  driftThreshold?: number;
}

export function createBacktestEngine(options: BacktestOptions = {}) {
  const driftThreshold = options.driftThreshold ?? 0.15;
  const models = new Map<string, ModelVersion[]>();
  const backtests = new Map<string, BacktestResult>();

  return {
    run(input: {
      symbol: string;
      candles: Candle[];
      strategyId: string;
      stake: number;
    }): BacktestResult {
      const backtestId = randomUUID();
      const result: BacktestResult = {
        backtestId,
        symbol: input.symbol,
        trades: [],
        totalStake: input.stake,
        totalProfit: 0,
        executedAt: new Date().toISOString(),
      };

      backtests.set(backtestId, result);
      return result;
    },

    registerModel(input: {
      modelId: string;
      version: string;
      type: string;
      hyperparameters: Record<string, any>;
    }): ModelVersion {
      const modelVersion: ModelVersion = {
        modelId: input.modelId,
        version: input.version,
        type: input.type,
        hyperparameters: input.hyperparameters,
        registeredAt: new Date().toISOString(),
      };

      if (!models.has(input.modelId)) {
        models.set(input.modelId, []);
      }

      const versions = models.get(input.modelId)!;
      versions.push(modelVersion);
      return modelVersion;
    },

    validatePredictions(input: {
      modelId: string;
      version: string;
      predictions: Prediction[];
    }): PredictionAccuracy {
      const correct = input.predictions.filter((p) => p.predicted === p.actual).length;
      const accuracy = input.predictions.length > 0 ? correct / input.predictions.length : 0;
      const avgConfidence =
        input.predictions.length > 0
          ? input.predictions.reduce((sum, p) => sum + p.confidence, 0) / input.predictions.length
          : 0;

      // Drift is detected when accuracy drops significantly or confidence is very low
      const accuracyDrift = accuracy < 0.5;
      const confidenceDrift = avgConfidence < 0.6;

      return {
        totalPredictions: input.predictions.length,
        correct,
        accuracy,
        avgConfidence,
        hasDrift: accuracyDrift || confidenceDrift,
        driftReason:
          accuracyDrift && confidenceDrift
            ? 'accuracy and confidence drift detected'
            : accuracyDrift
              ? 'accuracy drift detected'
              : confidenceDrift
                ? 'confidence drift detected'
                : undefined,
      };
    },

    getBacktest(backtestId: string): BacktestResult | null {
      return backtests.get(backtestId) ?? null;
    },

    getModelVersions(modelId: string): ModelVersion[] {
      return [...(models.get(modelId) ?? [])];
    },

    clear(): void {
      models.clear();
      backtests.clear();
    },
  };
}

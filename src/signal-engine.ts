export interface Tick {
  price: number;
  epoch: number;
}

export interface BollingerBands {
  upperBand: number;
  middleBand: number;
  lowerBand: number;
}

export interface MACD {
  macdLine: number;
  signalLine: number;
  histogram: number;
}

export interface SignalRule {
  ruleId: string;
  type: 'sma_cross' | 'ema_cross' | 'rsi' | 'macd' | 'bollinger';
  params: Record<string, number>;
  action: 'BUY' | 'SELL';
}

export interface Signal {
  ruleId: string;
  action: 'BUY' | 'SELL';
  confidence: number;
  timestamp: string;
}

export function calculateSMA(prices: number[], period: number): number {
  if (prices.length < period) return 0;
  const slice = prices.slice(-period);
  return slice.reduce((sum, p) => sum + p, 0) / period;
}

export function calculateEMA(prices: number[], period: number): number {
  if (prices.length < period) return 0;

  const k = 2 / (period + 1);
  let ema = calculateSMA(prices.slice(0, period), period);

  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }

  return ema;
}

export function calculateRSI(prices: number[], period: number = 14): number {
  if (prices.length < period + 1) return 50;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = prices[i] - prices[i - 1];
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < prices.length; i++) {
    const change = prices[i] - prices[i - 1];
    if (change > 0) {
      avgGain = (avgGain * (period - 1) + change) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.abs(change)) / period;
    }
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function calculateMACD(prices: number[], fast: number = 12, slow: number = 26, signal: number = 9): MACD {
  const fastEMA = calculateEMA(prices, fast);
  const slowEMA = calculateEMA(prices, slow);
  const macdLine = fastEMA - slowEMA;

  const macdValues = [];
  const tempPrices = prices.slice();
  for (let i = 0; i < tempPrices.length; i++) {
    if (i >= slow - 1) {
      const fEMA = calculateEMA(tempPrices.slice(0, i + 1), fast);
      const sEMA = calculateEMA(tempPrices.slice(0, i + 1), slow);
      macdValues.push(fEMA - sEMA);
    }
  }

  const signalLine = calculateEMA(macdValues, signal);
  const histogram = macdLine - signalLine;

  return { macdLine, signalLine, histogram };
}

export function calculateBollingerBands(prices: number[], period: number = 20, stdDev: number = 2): BollingerBands {
  const sma = calculateSMA(prices, period);
  const slice = prices.slice(-period);

  const variance = slice.reduce((sum, price) => sum + Math.pow(price - sma, 2), 0) / period;
  const std = Math.sqrt(variance);

  return {
    upperBand: sma + std * stdDev,
    middleBand: sma,
    lowerBand: sma - std * stdDev,
  };
}

export function createSignalEngine() {
  const rules: SignalRule[] = [];

  return {
    addRule(rule: SignalRule): void {
      rules.push(rule);
    },

    removeRule(ruleId: string): void {
      const index = rules.findIndex((r) => r.ruleId === ruleId);
      if (index !== -1) rules.splice(index, 1);
    },

    getRules(): SignalRule[] {
      return [...rules];
    },

    evaluateSignals(ticks: Tick[]): Signal[] {
      if (ticks.length < 2) return [];

      const prices = ticks.map((t) => t.price);
      const signals: Signal[] = [];

      for (const rule of rules) {
        let signal: Signal | null = null;

        if (rule.type === 'sma_cross') {
          const { period1 = 5, period2 = 20 } = rule.params;
          if (prices.length >= Math.max(period1, period2)) {
            const sma1 = calculateSMA(prices, period1);
            const sma2 = calculateSMA(prices, period2);

            if (rule.action === 'BUY' && sma1 > sma2) {
              signal = {
                ruleId: rule.ruleId,
                action: 'BUY',
                confidence: Math.min(1, (sma1 - sma2) / sma2),
                timestamp: new Date().toISOString(),
              };
            } else if (rule.action === 'SELL' && sma1 < sma2) {
              signal = {
                ruleId: rule.ruleId,
                action: 'SELL',
                confidence: Math.min(1, (sma2 - sma1) / sma2),
                timestamp: new Date().toISOString(),
              };
            }
          }
        }

        if (rule.type === 'rsi') {
          const { period = 14, threshold = 70 } = rule.params;
          if (prices.length >= period + 1) {
            const rsi = calculateRSI(prices, period);

            if (rule.action === 'BUY' && rsi < 30) {
              signal = {
                ruleId: rule.ruleId,
                action: 'BUY',
                confidence: (30 - rsi) / 30,
                timestamp: new Date().toISOString(),
              };
            } else if (rule.action === 'SELL' && rsi > threshold) {
              signal = {
                ruleId: rule.ruleId,
                action: 'SELL',
                confidence: (rsi - threshold) / (100 - threshold),
                timestamp: new Date().toISOString(),
              };
            }
          }
        }

        if (signal) {
          signals.push(signal);
        }
      }

      return signals;
    },

    clear(): void {
      rules.length = 0;
    },
  };
}

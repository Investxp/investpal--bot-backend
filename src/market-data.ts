export interface Tick {
  symbol: string;
  quote: number;
  epoch: number;
}

export interface QuoteSnapshot {
  symbol: string;
  quote: number;
  epoch: number;
  isStale: boolean;
  age: number;
}

export interface MarketDataOptions {
  maxAgeMs?: number;
  maxRetries?: number;
  baseDelayMs?: number;
}

export function createMarketDataManager(options: MarketDataOptions = {}) {
  const maxAgeMs = options.maxAgeMs ?? 10000;
  const maxRetries = options.maxRetries ?? 5;
  const baseDelayMs = options.baseDelayMs ?? 1000;

  const subscriptions = new Set<string>();
  const quotes = new Map<string, QuoteSnapshot>();
  let disconnectCount = 0;

  return {
    subscribe(symbol: string): void {
      subscriptions.add(symbol);
    },

    unsubscribe(symbol: string): void {
      subscriptions.delete(symbol);
      quotes.delete(symbol);
    },

    getSubscriptions(): string[] {
      return Array.from(subscriptions);
    },

    onTick(tick: Tick): void {
      const now = Math.floor(Date.now() / 1000);
      const age = (now - tick.epoch) * 1000;
      const isStale = age > maxAgeMs;

      quotes.set(tick.symbol, {
        symbol: tick.symbol,
        quote: tick.quote,
        epoch: tick.epoch,
        isStale,
        age,
      });
    },

    getLatestQuote(symbol: string): QuoteSnapshot | null {
      return quotes.get(symbol) ?? null;
    },

    getAllQuotes(): QuoteSnapshot[] {
      return Array.from(quotes.values());
    },

    recordDisconnect(): void {
      disconnectCount = Math.min(disconnectCount + 1, maxRetries);
    },

    recordSuccess(): void {
      disconnectCount = 0;
    },

    getNextReconnectDelay(): number {
      return baseDelayMs * Math.pow(2, Math.max(0, disconnectCount - 1));
    },

    getDisconnectCount(): number {
      return disconnectCount;
    },

    clear(): void {
      subscriptions.clear();
      quotes.clear();
      disconnectCount = 0;
    },
  };
}

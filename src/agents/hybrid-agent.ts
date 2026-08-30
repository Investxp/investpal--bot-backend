import { AgentEngine, AgentDecision } from '../agent-engine.js';
import type { AutoTradeMode } from '../types.js';

interface MarketSnapshot {
  digitFrequencies: Record<number, number>;
  recentDigits: number[];
  volatility: 'low' | 'medium' | 'high';
  trend: 'up' | 'down' | 'sideways';
  lastPrice: number;
  tickCount: number;
  /** true = snapshot derived from real market ticks */
  real: boolean;
  source: string;
}

const STRATEGY_RULES: Record<string, { idealVolatility: string; idealTrend: string; description: string }> = {
  'rise-fall': { idealVolatility: 'high', idealTrend: 'any', description: 'Volatile moves' },
  'digits-even-odd': { idealVolatility: 'low', idealTrend: 'sideways', description: 'Ranging digits' },
  'digits-match-differ': { idealVolatility: 'low', idealTrend: 'sideways', description: 'Tight digit range' },
  'accumulators': { idealVolatility: 'medium', idealTrend: 'up', description: 'Trending growth' },
  'rise-only': { idealVolatility: 'high', idealTrend: 'up', description: 'Strong uptrend' },
  'fall-only': { idealVolatility: 'high', idealTrend: 'down', description: 'Strong downtrend' },
  'even-only': { idealVolatility: 'low', idealTrend: 'sideways', description: 'Even digit bias' },
  'odd-only': { idealVolatility: 'low', idealTrend: 'sideways', description: 'Odd digit bias' },
};

const MAX_TICKS = 100;
const MIN_TICKS_FOR_ANALYSIS = 5;
const MIN_TICKS_FOR_TREND = 12;

/** Extract the last digit of a price quote (Deriv pip convention). */
function lastDigitOf(quote: number): number {
  const s = quote.toString();
  const dot = s.indexOf('.');
  const pip = dot === -1 ? 0 : s.length - dot - 1;
  const d = pip > 0 ? parseInt(s.slice(-1), 10) : Math.floor(Math.abs(quote) % 10);
  return isNaN(d) ? 0 : d;
}

export class HybridAgent extends AgentEngine {
  readonly agentType = 'hybrid-agent';
  private lastSnapshot: MarketSnapshot | null = null;

  /** Rolling buffer of REAL ticks from the live Deriv feed. */
  private ticks: { quote: number; epoch: number }[] = [];
  private tickUnsub: (() => void) | null = null;
  private ticksSubscribed = false;

  constructor() {
    super('hybrid-agent');
  }

  async stop(reason?: string) {
    if (this.tickUnsub) {
      try { this.tickUnsub(); } catch { /* noop */ }
      this.tickUnsub = null;
    }
    this.ticksSubscribed = false;
    await super.stop(reason);
  }

  protected async gatherMarketContext(): Promise<string> {
    return JSON.stringify(this.lastSnapshot || {});
  }

  private async ensureTickSubscription(): Promise<void> {
    if (this.ticksSubscribed || !this.derivClient) return;
    const symbol = this.config.symbol || 'R_100';
    try {
      this.tickUnsub = await this.derivClient.subscribeTicks(symbol, (tick) => {
        if (!tick || typeof tick.quote !== 'number' || !isFinite(tick.quote)) return;
        this.ticks.push({ quote: tick.quote, epoch: tick.epoch });
        if (this.ticks.length > MAX_TICKS) this.ticks.shift();
      });
      this.ticksSubscribed = true;
      this.log(`Subscribed to real tick feed on ${symbol}`);
    } catch (err: any) {
      this.log(`Tick subscription failed: ${err.message}`);
    }
  }

  /**
   * Builds a market snapshot from REAL tick data (last N ticks from the
   * live Deriv feed): digit frequencies, tick-to-tick volatility and a
   * simple trend estimate. No randomness — deterministic analysis only.
   */
  private scanMarket(): MarketSnapshot {
    const ticks = this.ticks;
    if (ticks.length < MIN_TICKS_FOR_ANALYSIS) {
      return {
        digitFrequencies: {},
        recentDigits: [],
        volatility: 'low',
        trend: 'sideways',
        lastPrice: ticks.length ? ticks[ticks.length - 1].quote : NaN,
        tickCount: ticks.length,
        real: false,
        source: `warming up — only ${ticks.length}/${MIN_TICKS_FOR_ANALYSIS} ticks received`,
      };
    }

    const quotes = ticks.map(t => t.quote);
    const lastPrice = quotes[quotes.length - 1];
    const recent = quotes.slice(-20);
    const digits = recent.map(lastDigitOf);

    const freq: Record<number, number> = {};
    for (const d of digits) freq[d] = (freq[d] || 0) + 1;

    // Volatility: mean absolute tick-to-tick change, relative to price
    const changes: number[] = [];
    for (let i = 1; i < quotes.length; i++) {
      const prev = quotes[i - 1];
      if (prev === 0) continue;
      changes.push(Math.abs(quotes[i] - prev) / prev);
    }
    const meanAbs = changes.length ? changes.reduce((a, b) => a + b, 0) / changes.length : 0;
    const volatility: 'low' | 'medium' | 'high' =
      meanAbs > 0.0002 ? 'high' : meanAbs > 0.00005 ? 'medium' : 'low';

    // Trend: compare mean of last 10 ticks vs the 10 before
    let trend: 'up' | 'down' | 'sideways' = 'sideways';
    if (quotes.length >= MIN_TICKS_FOR_TREND) {
      const recentWindow = quotes.slice(-10);
      const priorWindow = quotes.slice(-20, -10);
      const avgR = recentWindow.reduce((a, b) => a + b, 0) / recentWindow.length;
      const avgP = priorWindow.reduce((a, b) => a + b, 0) / priorWindow.length;
      const rel = avgP !== 0 ? (avgR - avgP) / avgP : 0;
      trend = rel > 0.0002 ? 'up' : rel < -0.0002 ? 'down' : 'sideways';
    }

    return {
      digitFrequencies: freq,
      recentDigits: digits,
      volatility,
      trend,
      lastPrice,
      tickCount: ticks.length,
      real: true,
      source: `real ticks (${ticks.length} received, ${quotes.length} analyzed)`,
    };
  }

  protected async decide(): Promise<AgentDecision> {
    await this.ensureTickSubscription();

    const pool = this.config.strategyPool || Object.keys(STRATEGY_RULES) as AutoTradeMode[];
    this.lastSnapshot = this.scanMarket();
    const market = this.lastSnapshot;

    // Honest behaviour: never fabricate a trade on no data
    if (!market.real) {
      return {
        action: 'wait',
        reasoning: `No market data yet (${market.source}). Waiting for live ticks before trading.`,
        marketContext: market.source,
      };
    }

    const marketDesc = `${market.volatility} vol, ${market.trend} trend, ${market.tickCount} ticks`;

    // Score each strategy against real market conditions (deterministic)
    const scored = pool.map(s => {
      const rules = STRATEGY_RULES[s];
      if (!rules) return { mode: s, score: 0 };
      let score = 50;
      if (rules.idealVolatility === market.volatility) score += 25;
      if (rules.idealTrend === market.trend) score += 15;
      // Digit-bias bonus for digit strategies: strongest digit frequency
      if (s.includes('even') || s.includes('odd')) {
        const even = (market.digitFrequencies[0] || 0) + (market.digitFrequencies[2] || 0) + (market.digitFrequencies[4] || 0)
          + (market.digitFrequencies[6] || 0) + (market.digitFrequencies[8] || 0);
        const total = market.recentDigits.length || 1;
        const evenBias = even / total;
        if ((s.includes('even') && evenBias > 0.55) || (s.includes('odd') && evenBias < 0.45)) score += 10;
      }
      return { mode: s, score };
    });
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (!best) return { action: 'wait', reasoning: 'No suitable strategy for current market' };

    const stake = this.calculateAdaptiveStake(best.score, market);

    // Build LLM prompt with real market data for final decision
    let llmDecision: string | null = null;
    try {
      llmDecision = await this.consultLLM(best.mode, stake, marketDesc);
    } catch {
      // Fall through to scanner-only decision
    }

    if (llmDecision === 'wait') {
      return { action: 'wait', reasoning: `Market: ${marketDesc}. LLM advised to wait.` };
    }
    if (llmDecision === 'stop') {
      return { action: 'stop', reasoning: `LLM decided to stop. Market: ${marketDesc}.` };
    }

    return {
      action: 'trade',
      strategy: best.mode,
      stake,
      duration: market.volatility === 'high' ? 3 : 5,
      reasoning: `Scanner: ${best.mode} best for ${marketDesc} (score: ${best.score.toFixed(0)})${llmDecision ? ' | LLM confirmed' : ''}`,
      marketContext: marketDesc,
    };
  }

  private async consultLLM(strategy: string, stake: number, market: string): Promise<string | null> {
    if (!this.config.llmEndpoint) return null;
    const endpoint = this.config.llmEndpoint;
    const model = this.config.llmModel || 'gpt-4o-mini';
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.llmApiKey) headers['Authorization'] = `Bearer ${this.config.llmApiKey}`;

    const prompt = `Live market data: ${market}. Scanner recommends ${strategy} at $${stake}. Profit target: $${this.config.profitTarget}, current: $${this.status.currentProfit.toFixed(2)}. Reply: "trade", "wait", or "stop". ONLY one word.`;
    const resp = await fetch(endpoint, {
      method: 'POST', headers,
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: 10 }),
    });
    if (!resp.ok) return null;
    const json = await resp.json() as any;
    const text = (json.choices?.[0]?.message?.content || '').toLowerCase().trim();
    if (text === 'wait' || text === 'stop') return text;
    return 'trade';
  }

  private calculateAdaptiveStake(score: number, market: MarketSnapshot): number {
    const base = this.config.baseStake;
    let multiplier = 1;
    if (score > 80) multiplier = 1.5;
    else if (score < 50) multiplier = 0.5;
    if (market.volatility === 'high') multiplier *= 0.8;
    if (this.status.losses > this.status.wins + 2) multiplier *= 0.6;
    const stake = Math.max(base * multiplier, base * 0.25);
    // Never exceed 3x base stake on a single agent trade
    return Math.min(stake, base * 3);
  }
}
